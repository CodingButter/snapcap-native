import Link from 'next/link';

const features = [
  {
    title: 'Pure Node, no browser',
    body:
      "Loads Snap's web JavaScript bundle and 814 KB of WASM directly in Node, with happy-dom shimming the Chrome APIs the bundle expects. No Playwright. No headless Chromium. No emulator.",
  },
  {
    title: 'Native attestation',
    body:
      "Runs Snap's kameleon Emscripten module in Node and generates the same attestation token a real browser would. Snap's anti-fraud accepts it because it's the actual code path, not a forgery.",
  },
  {
    title: 'Browser-shaped persistence',
    body:
      'Hand the client a DataStore — file, memory, Redis, KMS, whatever — and cookies plus the bundle\'s sandboxed local/session/IndexedDB writes (including its own wrapped E2E identity) all land under stable keys. Cold start ~5 s; warm start ~100 ms.',
  },
  {
    title: 'gRPC-Web for free',
    body:
      'Every Snap RPC client and protobuf encoder/decoder is shipped in the bundle. snapcap reuses them in-place — no .proto files, no codegen, no schema drift.',
  },
  {
    title: 'One-line API',
    body:
      'await client.authenticate() then client.friends.list(). Login, bearer rotation, cookie jar, and gRPC framing all live under the surface.',
  },
  {
    title: 'Multi-account ready',
    body:
      'Each SnapcapClient owns its own per-instance Sandbox — vm.Context, happy-dom Window, shimmed I/O, bundle bring-up caches. One Node process drives many accounts simultaneously, each with its own DataStore and browser fingerprint, at a fraction of the memory Playwright would burn.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-col items-center px-6 py-16 sm:py-24 flex-1">
      <section className="text-center max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-widest text-[#FFFC00] mb-4">
          @snapcap/native
        </p>
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight mb-6">
          A browser-free Snapchat client.
        </h1>
        <p className="text-lg sm:text-xl text-fd-muted-foreground mb-10">
          Native Node bridge to web.snapchat.com. No Playwright, no Frida, no rooted phone.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs/guide/getting-started"
            className="rounded-md bg-[#FFFC00] px-5 py-2.5 text-sm font-semibold text-black hover:brightness-95 transition"
          >
            Get started
          </Link>
          <Link
            href="/docs/api"
            className="rounded-md border border-fd-border px-5 py-2.5 text-sm font-semibold hover:bg-fd-accent transition"
          >
            API reference
          </Link>
          <Link
            href="/docs/internals/architecture"
            className="rounded-md border border-fd-border px-5 py-2.5 text-sm font-semibold hover:bg-fd-accent transition"
          >
            How it works
          </Link>
        </div>
      </section>

      <section className="mt-20 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 max-w-5xl w-full">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-lg border border-fd-border bg-fd-card p-5 text-sm"
          >
            <h2 className="font-semibold mb-2">{f.title}</h2>
            <p className="text-fd-muted-foreground leading-relaxed">{f.body}</p>
          </div>
        ))}
      </section>

      <p className="mt-16 text-xs text-fd-muted-foreground">
        Released under the MIT license.
      </p>
    </main>
  );
}
