/**
 * Hook the Snap web client BEFORE it boots. Connect to a Chrome
 * instance running at localhost:9222 (started with --remote-debugging-port),
 * find the active web.snapchat.com tab, and use CDP's
 * Page.addScriptToEvaluateOnNewDocument to inject patches that fire
 * before any page JS runs.
 *
 * Hooks:
 *   1. WebAssembly.instantiate / instantiateStreaming → capture the WASM
 *      Module object (Emscripten Module). Stash on globalThis.__snapcap_M.
 *   2. After Embind registers its classes, intercept selected class
 *      methods (e.g. messaging_StatelessSession.extractMessage) to log
 *      every byte that crosses JS↔WASM.
 *
 * Usage:
 *   bun run scripts/snap-recon.ts
 */
import CDP from "chrome-remote-interface";

const TARGET_URL_PREFIX = "https://www.snapchat.com/web/"; // logged-in chat

const HOOK_SCRIPT = `
(() => {
  if (window.__snapcap_hookInstalled) return;
  window.__snapcap_hookInstalled = true;

  window.__snapcap_logs = [];
  const log = (...args) => {
    window.__snapcap_logs.push({ t: Date.now(), args: args.map(a => {
      if (a instanceof Uint8Array) return { __bytes: Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('') };
      if (a instanceof ArrayBuffer) return { __bytes: Array.from(new Uint8Array(a)).map(b => b.toString(16).padStart(2, '0')).join('') };
      if (typeof a === 'object' && a !== null) {
        try { return JSON.parse(JSON.stringify(a, (k, v) => v instanceof Uint8Array ? '<Uint8Array ' + v.byteLength + 'B>' : v)); } catch { return String(a); }
      }
      return a;
    })});
    if (window.__snapcap_logs.length > 5000) window.__snapcap_logs.shift();
  };

  // 1. Hook WebAssembly.instantiate / instantiateStreaming.
  // We do NOT wrap exports (broke Snap). Instead we wrap specific
  // IMPORT functions — each call into JS from WASM gets logged.
  globalThis.__snapcap_wasmCalls = [];
  function wrapImports(imports, label) {
    if (!imports) return imports;
    const env = imports.env || imports.a;
    if (!env) return imports;
    let memory = null;
    // Peek into WASM heap requires post-instantiation memory ref
    const peek = (ptr, len = 80) => {
      try {
        if (!memory) return null;
        const h = new Uint8Array(memory.buffer);
        if (ptr < 0 || ptr >= h.length) return null;
        const end = Math.min(ptr + len, h.length);
        return Array.from(h.subarray(ptr, end)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch { return null; }
    };
    globalThis.__snapcap_setWasmMemory = (m) => { memory = m; };
    for (const k of Object.keys(env)) {
      const fn = env[k];
      if (typeof fn !== 'function') continue;
      env[k] = function(...args) {
        // Skip very common ones to reduce noise
        const hasInterestingArg = args.some(a => typeof a === 'number' && a > 0x10000 && a < 0x10000000);
        if (hasInterestingArg && globalThis.__snapcap_wasmCalls.length < 5000) {
          globalThis.__snapcap_wasmCalls.push({
            t: Date.now(),
            wasm: label,
            import: k,
            args: args.slice(0, 8),
            peeks: args.slice(0, 6).filter(a => typeof a === 'number' && a > 0x10000 && a < 0x10000000)
              .map(a => ({ ptr: a, hex: peek(a, 80) })),
          });
        }
        return fn.apply(this, args);
      };
    }
    return imports;
  }

  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function(buffer, imports) {
    const wrapped = wrapImports(imports, 'inst');
    const result = await origInstantiate.call(this, buffer, wrapped);
    const inst = result.instance || result;
    if (inst && inst.exports) {
      const exportNames = Object.keys(inst.exports);
      if (exportNames.length >= 25) {
        window.__snapcap_chatWasm = inst;
        window.__snapcap_chatImports = wrapped;
        if (inst.exports.memory || inst.exports.a) {
          globalThis.__snapcap_setWasmMemory?.(inst.exports.memory || inst.exports.a);
        }
      }
      log('WASM instantiate, exports:', exportNames.length, 'import groups:', Object.keys(imports || {}));
    }
    return result;
  };
  const origInstStream = WebAssembly.instantiateStreaming;
  if (origInstStream) {
    WebAssembly.instantiateStreaming = async function(source, imports) {
      const wrapped = wrapImports(imports, 'instStream');
      const result = await origInstStream.call(this, source, wrapped);
      const inst = result.instance || result;
      if (inst && inst.exports) {
        const exportNames = Object.keys(inst.exports);
        if (exportNames.length >= 25) {
          window.__snapcap_chatWasm = inst;
          window.__snapcap_chatImports = wrapped;
          if (inst.exports.memory || inst.exports.a) {
            globalThis.__snapcap_setWasmMemory?.(inst.exports.memory || inst.exports.a);
          }
        }
        log('WASM instantiateStreaming, exports:', exportNames.length, 'import groups:', Object.keys(imports || {}));
        const env = imports?.env || imports?.a;
        if (env) {
          log('env imports count:', Object.keys(env).length);
        }

        // CRITICAL: hook Embind registration. The keys are minified
        // (e.g. 'Ub', 'Q', 'Sa') so we identify by SOURCE — functions
        // whose body uses readLatin1String / registerType are Embind
        // register handlers.
        if (env) {
          for (const k of Object.keys(env)) {
            const fn = env[k];
            if (typeof fn !== 'function') continue;
            const src = fn.toString();
            if (src.includes('readLatin1String') || src.includes('registerType') ||
                src.includes('whenDependentTypesAreResolved') || src.includes('throwBindingError')) {
              const orig = fn;
              env[k] = function(...a) {
                window.__snapcap_embindCalls ||= [];
                if (window.__snapcap_embindCalls.length < 5000) {
                  // Decode any pointer args to strings via heap.
                  const decoded = a.map((x) => {
                    if (typeof x === 'number' && x > 0x10000 && x < 0x10000000) {
                      // Could be a heap pointer — decode as null-terminated string
                      try {
                        const s = window.__snapcap_decodeStringFromHeap?.(x);
                        if (s && s.length > 0 && s.length < 200 && /^[\\x20-\\x7e]+$/.test(s)) return { ptr: x, str: s };
                      } catch {}
                    }
                    return x;
                  });
                  window.__snapcap_embindCalls.push({ fn: k, srcLen: src.length, args: decoded });
                }
                return orig.apply(this, a);
              };
            }
          }
          log('hooked embind register functions');
        }
      }
      return result;
    };
  }

  // 1b. Resolve embind type-name strings via WASM memory.
  // Many embind register calls take a (rawType, namePtr) pair where namePtr
  // is a UTF-8 string in the WASM heap. We can decode after instance ready.
  window.__snapcap_decodeStringFromHeap = function(ptr) {
    if (!window.__snapcap_chatWasm) return null;
    const memory = window.__snapcap_chatWasm.exports.memory || window.__snapcap_chatWasm.exports.a;
    if (!memory) return null;
    const heap = new Uint8Array(memory.buffer);
    let end = ptr;
    while (end < heap.length && heap[end] !== 0) end++;
    return new TextDecoder().decode(heap.subarray(ptr, end));
  };

  // 5. Hook fetch to capture every messaging gRPC call.
  window.__snapcap_fetches = [];
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(url, options) {
    const u = (typeof url === 'string') ? url : url.url;
    let reqBody = null;
    if (options?.body instanceof Uint8Array || options?.body instanceof ArrayBuffer) {
      const buf = options.body instanceof Uint8Array ? options.body : new Uint8Array(options.body);
      reqBody = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (typeof options?.body === 'string') {
      reqBody = options.body.slice(0, 6000);
    }
    const start = Date.now();
    const result = await origFetch(url, options);
    const interesting = u.match(/snapchat\\.com\\/com|messagingcoreservice|atlas\\.gw|api\\.snap|aws\\..*snap|duplex\\.snap/i);
    if (interesting) {
      const cloned = result.clone();
      let respHex = null;
      try {
        const ab = await cloned.arrayBuffer();
        const buf = new Uint8Array(ab);
        respHex = buf.byteLength <= 50000 ? Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('') : '<' + buf.byteLength + 'B>';
      } catch {}
      window.__snapcap_fetches.push({
        t: start, dur: Date.now() - start,
        url: u, status: result.status,
        method: options?.method || 'GET',
        reqBodyLen: options?.body ? (options.body.byteLength || options.body.length) : 0,
        reqBody, respHex,
        respLen: respHex && (respHex.startsWith('<') ? null : respHex.length / 2),
      });
      if (window.__snapcap_fetches.length > 200) window.__snapcap_fetches.shift();
    }
    return result;
  };

  // 6. Hook WebSocket for real-time messages.
  window.__snapcap_wsEvents = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const ws = new target(...args);
      const url = args[0];
      window.__snapcap_wsEvents.push({ t: Date.now(), kind: 'open', url });
      const origSend = ws.send.bind(ws);
      ws.send = function(data) {
        const len = data?.byteLength || data?.length || 0;
        let hex = null;
        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
          const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
          if (buf.byteLength < 8000) hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        window.__snapcap_wsEvents.push({ t: Date.now(), kind: 'send', url, len, hex });
        return origSend(data);
      };
      ws.addEventListener('message', (evt) => {
        const data = evt.data;
        let hex = null;
        let len = 0;
        if (data instanceof ArrayBuffer) {
          const buf = new Uint8Array(data);
          len = buf.byteLength;
          if (len < 8000) hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
        } else if (data instanceof Blob) {
          len = data.size;
        } else if (typeof data === 'string') {
          len = data.length;
          hex = data.slice(0, 1000);
        }
        window.__snapcap_wsEvents.push({ t: Date.now(), kind: 'recv', url, len, hex });
        if (window.__snapcap_wsEvents.length > 500) window.__snapcap_wsEvents.shift();
      });
      return ws;
    }
  });

  // 7. Hook XHR (some grpc-web libs use XHR).
  window.__snapcap_xhrEvents = [];
  const origOpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__snapcap_url = url;
    this.__snapcap_method = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const url = this.__snapcap_url;
    let reqHex = null;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
      if (buf.byteLength < 8000) reqHex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    this.addEventListener('load', () => {
      if (url && url.match(/snapchat|api\\.snap|grpc/i)) {
        let respHex = null;
        if (this.responseType === '' || this.responseType === 'text') {
          respHex = (this.responseText || '').slice(0, 6000);
        } else if (this.response instanceof ArrayBuffer) {
          const buf = new Uint8Array(this.response);
          if (buf.byteLength < 50000) respHex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
          else respHex = '<' + buf.byteLength + 'B>';
        }
        window.__snapcap_xhrEvents.push({ t: Date.now(), method: this.__snapcap_method, url, status: this.status, reqHex, respHex, respLen: respHex && respHex.length / 2 });
        if (window.__snapcap_xhrEvents.length > 200) window.__snapcap_xhrEvents.shift();
      }
    });
    return origXHRSend.apply(this, arguments);
  };

  log('all hooks (fetch, ws, xhr, embind) armed');

  // 8. Hook WASM exports directly. JS calls Embind methods which
  // dispatch to specific WASM exports with pointer args. We wrap
  // each export to log args + peek into WASM memory.
  globalThis.__snapcap_wasmCalls = [];
  globalThis.__snapcap_installExportHooks = () => {
    const wasm = globalThis.__snapcap_chatWasm;
    if (!wasm || globalThis.__snapcap_exportHooksInstalled) return false;
    globalThis.__snapcap_exportHooksInstalled = true;
    const exports = wasm.exports;
    const memory = exports.memory || exports.a;
    if (!memory) return false;
    const peek = (ptr, len = 64) => {
      try {
        const heap = new Uint8Array(memory.buffer);
        if (ptr < 0 || ptr >= heap.length) return null;
        const end = Math.min(ptr + len, heap.length);
        return Array.from(heap.subarray(ptr, end)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch { return null; }
    };
    // Replace each export with a wrapper. Skip ones that aren't functions.
    const wrapped = {};
    for (const k of Object.keys(exports)) {
      const fn = exports[k];
      if (typeof fn !== 'function') { wrapped[k] = fn; continue; }
      wrapped[k] = function(...args) {
        // Only log if any arg is a number that looks like a heap pointer.
        const hasPtr = args.some(a => typeof a === 'number' && a > 0x10000 && a < 0x10000000);
        if (hasPtr && globalThis.__snapcap_wasmCalls.length < 1000) {
          globalThis.__snapcap_wasmCalls.push({
            t: Date.now(),
            export: k,
            args,
            // Peek every pointer arg
            peeks: args.filter(a => typeof a === 'number' && a > 0x10000 && a < 0x10000000)
              .map(a => ({ ptr: a, hex: peek(a, 80) })),
          });
        }
        return fn.apply(this, args);
      };
    }
    // Replace .exports — but it's read-only on real Instance. Try anyway.
    try {
      Object.defineProperty(wasm, 'exports', { value: wrapped, configurable: true });
    } catch (e) {
      // Can't replace. Try patching globalThis.__snapcap_chatWasm.exports.
      globalThis.__snapcap_chatWasm.exports = wrapped;
    }
    log('WASM export hooks installed,', Object.keys(wrapped).length, 'exports wrapped');
    return true;
  };
  // Try to install export hooks now (if wasm is already there) and
  // also after a short delay (in case wasm loads after our hook setup).
  setTimeout(() => globalThis.__snapcap_installExportHooks?.(), 1000);
  setTimeout(() => globalThis.__snapcap_installExportHooks?.(), 3000);

  // 9. Hook crypto.subtle — Web Crypto API for ECDH, HKDF, AES-GCM.
  globalThis.__snapcap_subtleCalls = [];
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const subtle = globalThis.crypto.subtle;
    const methods = ['encrypt','decrypt','sign','verify','digest','deriveBits','deriveKey','generateKey','importKey','exportKey','wrapKey','unwrapKey'];
    for (const m of methods) {
      const orig = subtle[m].bind(subtle);
      subtle[m] = async function(...args) {
        const start = Date.now();
        let result, error;
        try { result = await orig(...args); } catch (e) { error = e; }
        const argSummary = args.map((a) => {
          if (a instanceof Uint8Array || a instanceof ArrayBuffer) {
            const buf = a instanceof Uint8Array ? a : new Uint8Array(a);
            return { kind: 'bytes', len: buf.byteLength, hex: Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 600) };
          }
          if (a && typeof a === 'object') {
            if (a.usages !== undefined && a.algorithm) {
              return { kind: 'CryptoKey', algorithm: a.algorithm?.name || JSON.stringify(a.algorithm)?.slice(0,80), usages: a.usages, extractable: a.extractable };
            }
            if (a.name) {
              const out = { kind: 'algo', name: a.name };
              if (a.iv) {
                const ivBuf = a.iv instanceof Uint8Array ? a.iv : new Uint8Array(a.iv);
                out.iv = { len: ivBuf.byteLength, hex: Array.from(ivBuf).map(b => b.toString(16).padStart(2,'0')).join('') };
              }
              if (a.additionalData) {
                const ad = a.additionalData instanceof Uint8Array ? a.additionalData : new Uint8Array(a.additionalData);
                out.additionalData = { len: ad.byteLength, hex: Array.from(ad).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 200) };
              }
              if (a.length !== undefined) out.length = a.length;
              if (a.hash) out.hash = a.hash;
              if (a.namedCurve) out.namedCurve = a.namedCurve;
              if (a.salt) {
                const s = a.salt instanceof Uint8Array ? a.salt : new Uint8Array(a.salt);
                out.salt = { len: s.byteLength, hex: Array.from(s).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 200) };
              }
              if (a.info) {
                const i = a.info instanceof Uint8Array ? a.info : new Uint8Array(a.info);
                out.info = { len: i.byteLength, hex: Array.from(i).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 200) };
              }
              if (a.public) out.public = { kind: 'CryptoKey', algorithm: a.public?.algorithm?.name };
              return out;
            }
            return { keys: Object.keys(a).slice(0, 8) };
          }
          return a;
        });
        let resSummary = null;
        if (result) {
          if (result instanceof ArrayBuffer) {
            const buf = new Uint8Array(result);
            resSummary = { kind: 'bytes', len: buf.byteLength, hex: Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 400) };
          } else if (result.algorithm) {
            resSummary = { kind: 'CryptoKey', algorithm: result.algorithm?.name, usages: result.usages };
          } else if (typeof result === 'object') {
            resSummary = { keys: Object.keys(result).slice(0, 8) };
          }
        }
        globalThis.__snapcap_subtleCalls.push({ t: Date.now(), method: m, dur: Date.now() - start, args: argSummary, result: resSummary, error: error?.message });
        if (globalThis.__snapcap_subtleCalls.length > 500) globalThis.__snapcap_subtleCalls.shift();
        if (error) throw error;
        return result;
      };
    }
    log('crypto.subtle methods hooked:', methods.length);
  }

  // 2. Hook Function.prototype.apply / call to detect Embind-style invocations.
  // Specifically, when a JS function with property .argCount or .className
  // is called, log it (these are Embind-generated method shims).
  // Many Embind methods are defined via specific Emscripten internal APIs.
  // We monkey-patch Object.create to intercept the prototype creation step.

  // 3. Hook all Function.prototype.bind on functions whose names look like
  // Embind class methods (this is where Module.{class}.{method} get bound).
  // Easier: hook Reflect.apply or Function.prototype.apply for any function
  // with our known method name.
  const targetMethods = new Set([
    'extractMessage', 'consumeMessagingPayloadOrSyncConversation',
    'sendMessageWithContent', 'getCurrentUserKeyAsync',
    'unwrapKey', 'wrapKey', 'decryptFriendKeys', 'encryptFriendKeys',
  ]);

  // Hook every property GET on objects to detect when Embind methods
  // are accessed. Use Proxy on globalThis is too broad. Instead, watch
  // for specific patterns: when ANY object property named one of our
  // targets is assigned, capture the parent.
  const origDefine = Object.defineProperty;
  Object.defineProperty = function(target, prop, descriptor) {
    if (typeof prop === 'string') {
      if (targetMethods.has(prop) || /^(messaging_|e2ee_|grpc_|shims_|config_|blizzard_|fidelius_)/.test(prop)) {
        log('defineProperty:', prop, 'on', target?.constructor?.name || typeof target);
        window.__snapcap_M ||= {};
        window.__snapcap_M[prop] = descriptor.value;
        window.__snapcap_M_parent ||= target;
      }
    }
    return origDefine.apply(this, arguments);
  };

  // 4. The Embind framework registers classes via a mechanism that
  // calls into Module to set up wrappers. Rather than patch globally,
  // periodically scan the window/document for an object that has the
  // Snap Embind class-name patterns. We schedule a scan.
  function scanForModule() {
    const queue = [globalThis];
    const seen = new WeakSet();
    let found = null;
    let depth = 0;
    while (queue.length && depth++ < 1500) {
      const obj = queue.shift();
      if (!obj || typeof obj !== 'object') continue;
      if (seen.has(obj)) continue;
      seen.add(obj);
      try {
        const keys = Object.keys(obj);
        if (keys.includes('messaging_StatelessSession') ||
            keys.includes('e2ee_E2EEKeyManager') ||
            keys.includes('shims_Platform')) {
          found = obj;
          log('found Module-like object via scan', { keys: keys.filter(k => /^(messaging_|e2ee_|grpc_|shims_|config_|blizzard_|fidelius_)/.test(k)).slice(0, 25) });
          window.__snapcap_M = obj;
          break;
        }
        if (depth > 10) continue;  // shallow
        for (const k of keys.slice(0, 50)) {
          try {
            const v = obj[k];
            if (v && typeof v === 'object' && !seen.has(v)) queue.push(v);
          } catch {}
        }
      } catch {}
    }
    return found;
  }
  // Try scan periodically until we find Module
  let attempts = 0;
  const scanI = setInterval(() => {
    attempts++;
    if (window.__snapcap_M && Object.keys(window.__snapcap_M).length > 0) {
      log('Module found, stop scanning. attempts=', attempts);
      clearInterval(scanI);
      return;
    }
    scanForModule();
    if (attempts > 60) { clearInterval(scanI); log('scan timeout'); }
  }, 1000);

})();
`;

// The hook is written for `window` in the main page. For workers
// the global is `self`. Replace window references with globalThis so
// it works in either context.
const WORKER_HOOK_SCRIPT = HOOK_SCRIPT.replace(/window\./g, "globalThis.").replace(/window\b/g, "globalThis");

async function main() {
  const tabs = await CDP.List({ port: 9222 });
  const tab = tabs.find((t) => t.type === "page" && t.url.startsWith(TARGET_URL_PREFIX))
    || tabs.find((t) => t.type === "page" && t.url.includes("snapchat.com"))
    || tabs.find((t) => t.type === "page");
  if (!tab) {
    console.error("no Chrome tab matching snapchat.com — open it first");
    process.exit(1);
  }
  console.log(`attaching to: ${tab.url} (${tab.id})`);
  const client = await CDP({ port: 9222, target: tab });
  const { Page, Runtime, Network, Target } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);

  // Set up auto-attach for workers — every new worker triggers
  // attachedToTarget with its own sessionId.
  await Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  client.on("Target.attachedToTarget", async (params) => {
    const t = params.targetInfo;
    if (t.type === "worker" || t.type === "shared_worker" || t.type === "service_worker") {
      console.log(`worker target attached: ${t.type} ${t.url.slice(0, 100)}`);
      try {
        // Send commands scoped to this session
        await client.send("Runtime.enable", {}, params.sessionId);
        // Install the same hook in the worker context
        await client.send("Runtime.evaluate", { expression: WORKER_HOOK_SCRIPT }, params.sessionId);
        console.log(`  hook installed in worker (${t.type})`);
        // Resume — workers were paused waitingForDebuggerOnStart
        await client.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
      } catch (e) {
        console.error(`  failed to hook worker: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  });

  // Add our hook to run before any page JS on next page load.
  await Page.addScriptToEvaluateOnNewDocument({ source: HOOK_SCRIPT });
  console.log("hook installed via Page.addScriptToEvaluateOnNewDocument (main page)");

  // Listen for console log events
  Runtime.consoleAPICalled((evt) => {
    const args = evt.args.map((a) => a.value ?? a.description ?? a.objectId).slice(0, 8);
    if (args.some((a) => typeof a === "string" && a.includes("snapcap"))) {
      console.log(`[page console]`, ...args);
    }
  });

  // Reload the page so the hook fires from the start. workers will
  // be re-created and our auto-attach will catch them.
  await Page.reload({ ignoreCache: false });
  console.log("page reloaded — hooks will fire on next bundle + worker load");

  // Wait 15 seconds for things to load.
  await new Promise((r) => setTimeout(r, 15_000));

  // Dump the hook state from the page.
  const state = await Runtime.evaluate({
    expression: `JSON.stringify({
      pageHookInstalled: !!window.__snapcap_hookInstalled,
      pageChatWasm: !!window.__snapcap_chatWasm,
      pageEmbindCount: (window.__snapcap_embindCalls || []).length,
      pageFetchCount: (window.__snapcap_fetches || []).length,
      pageLogs: (window.__snapcap_logs || []).slice(0, 12),
    })`,
    returnByValue: true,
  });
  console.log("\n=== main-page state ===");
  console.log(state.result.value);

  // Also list current targets including workers
  const targets = await Target.getTargets();
  console.log("\n=== current targets ===");
  for (const t of targets.targetInfos) {
    console.log(`  ${t.type.padEnd(15)} ${t.url.slice(0, 100)}`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
