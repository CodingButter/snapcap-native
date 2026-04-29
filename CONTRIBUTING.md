# Contributing

Thanks for your interest. This project is in active development; the v1 API surface is still landing.

## Setup

```bash
git clone https://github.com/codingbutter/snapcap-native.git
cd snapcap-native
pnpm install
pnpm download:bundle
```

Requires Bun ≥ 1.3 or Node ≥ 22.

## Repo layout

```
src/
  client.ts            ← SnapcapClient class (public entry point)
  api/                 ← high-level methods (listFriends, sendMessage, …)
  auth/                ← kameleon, login, sso
  transport/           ← gRPC-Web framing, cookie jar, native fetch
  shims/               ← happy-dom + webpack capture
scripts/               ← bundle downloader, examples, smoke test
docs/                  ← VitePress site (deploys to GitHub Pages)
vendor/                ← downloaded Snap bundle (gitignored)
```

## Adding an API method

The pattern is consistent. To add e.g. `searchUsers(query)`:

1. **Find the gRPC descriptor in the bundle.** Most likely in module 74052 (chat bundle). Grep for `methodName:"<MethodName>"`.
2. **Add `src/api/search.ts`** that takes an `rpc.unary`-shaped object, calls the method, returns a typed result.
3. **Add a method on `SnapcapClient`** in `src/client.ts` that calls into your new module via `this.makeRpc()`.
4. **Document it** in `docs/api/`.

Keep methods narrow and predictable. The protobuf shapes are messy; the public API should not be.

## Testing

The smoke test (`scripts/smoke.ts`) runs the full login → listFriends → save blob → reload blob → listFriends flow against a real account. Set `SNAP_STATE_FILE` to a JSON file containing `{ username, password }`. Don't commit that file.

There are no mocks. Snap rotates the bundle and changes responses; integration testing against real endpoints is the only meaningful signal.

## Submitting changes

- Match the existing style (no comments unless the *why* is non-obvious).
- Don't add abstractions beyond what the change requires.
- For non-trivial changes, open an issue first.

## License

MIT — see [LICENSE](./LICENSE).
