# API reference

Every public surface of `@snapcap/native`. Everything not listed here is an internal — relying on it will break.

| Page | What's there |
|---|---|
| [SnapcapClient](/api/snapcap-client) | The main class. Login, friends, conversations, story posting, low-level RPC. |
| [Conversation](/api/conversation) | Domain object for a single chat. `sendText`, `sendImage`, presence. |
| [User](/api/user) | The `User` data class + factory methods. |
| [Storage](/api/storage) | `DataStore` interface, built-in stores, `StorageShim`, `CookieJarStore`, IDB helpers. |
| [Sandbox](/api/sandbox) | `installShims`, `getSandbox`, the `Sandbox` class. Advanced bundle-interop. |

## Imports at a glance

```ts
import {
  // Client + types
  SnapcapClient,
  type SnapcapClientOpts,
  type FideliusIdentityBlob,

  // Domain objects
  Conversation,
  TypingActivity,
  ConversationViewState,
  type ConversationKind,
  User,
  FriendAction,

  // Storage
  type DataStore,
  FileDataStore,
  MemoryDataStore,
  StorageShim,
  CookieJarStore,
  idbGet,
  idbPut,
  idbDelete,

  // Sandbox / bundle interop
  installShims,
  getSandbox,
  isShimInstalled,
  Sandbox,
  type SandboxOpts,
  type InstallShimOpts,

  // Low-level helpers
  uuidToBytes,
  bytesToUuid,
  uuidToHighLow,
} from "@snapcap/native";
```

If you're building a typical app you'll only touch `SnapcapClient`, `FileDataStore`, `Conversation`, and `User`. The rest is escape hatches for advanced use.
