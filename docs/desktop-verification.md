# Mac preview verification — 8 September 2026

Verified on macOS 26.2 / Apple Silicon with Electron 44.2.0 and Next.js 16.1.6. The release runtime is `1.9.0-d89ec8f1-36cb-41d9-8edb-e4dbe7669f1c`.

| Check | Result |
| --- | --- |
| Isolated production build and electron-builder app/DMG/ZIP | Passed |
| Source Electron development and authenticated HMR | Passed |
| Foundation full Vitest suite | 155 files, 2,961 tests passed |
| Main-process persistence/lifecycle tests | 10 tests passed |
| Focused desktop and workflow-tab tests after large-workflow fix | 29 tests passed |
| Large workflow loading and crash recovery | 471 nodes, 103,932,547 bytes of media; 503,622-byte checkpoint; edited prompt restored |
| Copied installation outside the repository | Passed with a clean profile and system-only PATH (no Node/npm) |
| Public assets and native sharp image processing | Passed |
| Workflow save/load and authenticated localhost API | Passed |
| Credential migration, update, deletion and restart persistence | Passed using synthetic test keys and real macOS safeStorage |
| Unavailable encryption | Returned an actionable error; previous ciphertext remained unchanged |
| Unrelated-window credential access | Rejected |
| Port conflict and retry on the same origin | Passed; Retry / Open Logs / Quit shown |
| Backend crash and restart | Editor retained its graph; one replacement backend started |
| App and renderer crashes | Multiple tabs and checkpointed edits restored |
| Media, connections, costs and interrupted generation | Restored; no generation requests were resubmitted |
| Corruption, incomplete writes and missing media | Covered by filesystem tests; previous checkpoint preserved and missing references reported |
| Cancelled close and immediate explicit discard | Passed; discarded work did not return |
| Installed bundle immutability | Full tree digest unchanged after acceptance |
| Secret and artifact scan | No test keys in bundle/logs/active localStorage; no `.env*` or test directories in bundle |
| DMG installation and native Mac controls | Passed: hover, keyboard focus, minimise, fullscreen, dragging, close, restart |

Native controls were tested with `cliclick` against an app copied from the final read-only DMG into a temporary Applications directory, after ejecting the image. The app ran with only system tools on PATH and no developer provider environment variables. Test profiles were isolated from the normal Node Banana profile.

The packaged provider check made a real Google LLM request with a synthetic key and received the expected authentication error. **A successful request with a valid tester-entered credential is still pending:** no test credential was supplied. No successful generation or provider billing has been claimed.

A repository-wide `tsc --noEmit` run reported test-fixture typing errors. The isolated release build excludes tests and passes Next's production TypeScript check. Vitest passes the source tests listed above.

## Large workflow crash regression

The first preview crashed in the main process when loading a 471-node workflow with embedded hydrated media. Captured stderr reproduced `OOM error in V8: Zone Allocation failed - process out of memory` followed by SIGTRAP. Recovery previously sent full data URLs through IPC; blob-only externalisation did not cover media loaded from workflow files.

Recovery now externalises both data URLs and blobs, deduplicates media across references/checkpoints, transfers bytes in 1 MiB chunks, and hydrates assets in the renderer. Checkpoint metadata is limited before IPC. The packaged regression loaded the original workflow read-only, checkpointed its media and a prompt edit, killed/restarted the app, restored all 471 nodes and the edit, and verified no generation submissions or changes to the input file. This tests the reported `Cars.json`; the older 253 MiB `Cars_new.json` is a separate file and was not used for acceptance.

## Release checksums (SHA-256)

```text
f26a933c2df6e56e00c6da94e9ecdac21d88c4f3843995056bdddeefb8c29b94  Node Banana-1.9.0-arm64.dmg
2af7b1fbd51ef671115678a330a481a215539198a9b84448a9ff388ead299ac9  Node Banana-1.9.0-arm64.zip
```

The app remains unsigned and unnotarised. Installation and tester steps are in [desktop-preview.md](desktop-preview.md).
