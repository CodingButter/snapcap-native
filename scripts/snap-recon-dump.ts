/**
 * Read state from main page + every active worker via CDP. Dumps
 * captured network calls, embind calls, crypto-shaped function calls,
 * and WS events. Also provides a "clear" mode and a "watch" mode.
 *
 * Usage:
 *   bun run scripts/snap-recon-dump.ts          # dump current state
 *   bun run scripts/snap-recon-dump.ts clear    # clear all capture buffers
 */
import CDP from "chrome-remote-interface";

const action = process.argv[2] || "dump";

async function main() {
  const tabs = await CDP.List({ port: 9222 });
  const tab = tabs.find((t) => t.type === "page" && t.url.includes("snapchat.com"));
  if (!tab) { console.error("no snapchat tab"); process.exit(1); }
  const client = await CDP({ port: 9222, target: tab });
  const { Runtime, Target } = client;
  await Runtime.enable();
  await Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const targets = await Target.getTargets();
  const wantedTargets = targets.targetInfos.filter((t) =>
    t.type === "worker" || t.type === "page" && t.url.includes("snapchat"));

  const expr = action === "clear"
    ? `(() => {
        globalThis.__snapcap_anyFetch = [];
        globalThis.__snapcap_fetches = [];
        globalThis.__snapcap_wsEvents = [];
        globalThis.__snapcap_xhrEvents = [];
        globalThis.__snapcap_embindCalls = [];
        globalThis.__snapcap_cryptoCalls = [];
        return JSON.stringify({ cleared: true, ts: Date.now(), where: typeof window !== "undefined" ? "page" : "worker" });
      })()`
    : `(() => {
        const where = typeof window !== "undefined" ? "page" : "worker";
        return JSON.stringify({
          where,
          chatWasmExports: globalThis.__snapcap_chatWasm ? Object.keys(globalThis.__snapcap_chatWasm.exports).length : 0,
          embindCount: (globalThis.__snapcap_embindCalls || []).length,
          embindFns: [...new Set((globalThis.__snapcap_embindCalls || []).map(c => c.fn))],
          fetchCount: (globalThis.__snapcap_anyFetch || globalThis.__snapcap_fetches || []).length,
          fetches: (globalThis.__snapcap_anyFetch || globalThis.__snapcap_fetches || []).slice(-30).map(f => ({
            method: f.method, url: (f.url || "").replace(/^https:\\/\\/[^/]+/, ""), status: f.status, respLen: f.respLen,
            // include response hex for snap-related URLs
            respHex: (f.url || "").match(/snap|api/i) ? (f.respHex || f.hex || "").slice(0, 4000) : undefined,
            reqHex: f.reqBody ? f.reqBody.slice(0, 800) : undefined,
          })),
          wsCount: (globalThis.__snapcap_wsEvents || []).length,
          // Only return DISTINCT WS recv frames bigger than 350B (Fidelius envelopes ≈ 400-600B; presence msgs are 289B)
          wsBigRecvs: (() => {
            const seen = new Set();
            return (globalThis.__snapcap_wsEvents || []).filter(e => e.kind === "recv" && e.len > 350).filter(e => {
              if (seen.has(e.hex)) return false; seen.add(e.hex); return true;
            }).map(e => ({ len: e.len, hex: e.hex }));
          })(),
          wsEventsSummary: (globalThis.__snapcap_wsEvents || []).map(e => ({ kind: e.kind, len: e.len })),
          cryptoCallCount: (globalThis.__snapcap_cryptoCalls || []).length,
          cryptoCalls: (globalThis.__snapcap_cryptoCalls || []).slice(-30),
          wasmCallCount: (globalThis.__snapcap_wasmCalls || []).length,
          wasmCallsByExport: (globalThis.__snapcap_wasmCalls || []).reduce((acc, c) => { acc[c.export] = (acc[c.export] || 0) + 1; return acc; }, {}),
          wasmCalls: (globalThis.__snapcap_wasmCalls || []).slice(-15),
          exportHooksInstalled: !!globalThis.__snapcap_exportHooksInstalled,
          subtleCount: (globalThis.__snapcap_subtleCalls || []).length,
          subtleByMethod: (globalThis.__snapcap_subtleCalls || []).reduce((acc, c) => { acc[c.method] = (acc[c.method] || 0) + 1; return acc; }, {}),
          subtleCalls: (globalThis.__snapcap_subtleCalls || []).slice(-30),
        });
      })()`;

  // Attach to each worker target as a flattened sub-session and eval on it.
  for (const t of wantedTargets) {
    let sessionId: string | undefined;
    try {
      if (t.type === "page") {
        // Already attached via the main client.
        const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
        console.log(`\n=== ${t.type} ${t.url.slice(0, 80)} ===`);
        printJson(r.result.value || r.result);
      } else {
        const att = await client.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }) as { sessionId: string };
        sessionId = att.sessionId;
        await client.send("Runtime.enable", {}, sessionId);
        const r = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId) as { result: { value?: string } };
        console.log(`\n=== ${t.type} ${t.url.slice(0, 80)} ===`);
        printJson(r.result.value);
      }
    } catch (e) {
      console.error(`error on ${t.type} ${t.url.slice(0, 60)}: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }
  await client.close();
}

function printJson(v: unknown) {
  if (typeof v === "string") {
    try { console.log(JSON.stringify(JSON.parse(v), null, 2)); return; } catch {}
  }
  console.log(v);
}

main().catch((e) => { console.error(e); process.exit(1); });
