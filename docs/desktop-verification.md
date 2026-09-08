# Mac preview verification — 8 September 2026

Verified on macOS 26.2 / Apple Silicon with Electron 44.2.0 and Next.js 16.1.6. The release runtime is `1.9.0-ebfaa7f8-2137-4570-924a-60a761577aed`.

| Check | Result |
| --- | --- |
| Isolated production build and electron-builder app/DMG/ZIP | Passed |
| Packaged icon and import layout | Passed: ten ICNS representations have dark opaque edges; onboarding and Project Settings place import action to the right; cancelled picker re-enables the action |
| Reve 2.1 regression | 81 targeted tests passed; packaged schema endpoint verified against live Replicate metadata; packaged desktop smoke checks passed |
| Source Electron development and authenticated HMR | Passed |
| Foundation full Vitest suite | 155 files, 2,961 tests passed |
| Main-process persistence/lifecycle/import tests | 12 tests passed |
| Environment import in packaged app | Passed: native picker, immediate renderer update, encrypted persistence across restart, preserved existing keys/source, repeat import, cancellation and encryption failure |
| Renderer credential tests after environment import | 4 tests passed |
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

The final icon/layout rebuild passed the isolated production TypeScript build and packaged visual checks in a clean profile. The broader functional results below were obtained during the foundation, recovery and environment-import work; they were not repeated for these visual changes.

Native controls were tested with `cliclick` against an app copied from the final read-only DMG into a temporary Applications directory, after ejecting the image. The app ran with only system tools on PATH and no developer provider environment variables. Test profiles were isolated from the normal Node Banana profile.

The packaged provider check made a real Google LLM request with a synthetic key and received the expected authentication error. **A successful request with a valid tester-entered credential is still pending:** no test credential was supplied. No successful generation or provider billing has been claimed.

A repository-wide `tsc --noEmit` run reported test-fixture typing errors. The isolated release build excludes tests and passes Next's production TypeScript check. Vitest passes the source tests listed above.

## Large workflow crash regression

The first preview crashed in the main process when loading a 471-node workflow with embedded hydrated media. Captured stderr reproduced `OOM error in V8: Zone Allocation failed - process out of memory` followed by SIGTRAP. Recovery previously sent full data URLs through IPC; blob-only externalisation did not cover media loaded from workflow files.

Recovery now externalises both data URLs and blobs, deduplicates media across references/checkpoints, transfers bytes in 1 MiB chunks, and hydrates assets in the renderer. Checkpoint metadata is limited before IPC. The packaged regression loaded the original workflow read-only, checkpointed its media and a prompt edit, killed/restarted the app, restored all 471 nodes and the edit, and verified no generation submissions or changes to the input file. This tests the reported `Cars.json`; the older 253 MiB `Cars_new.json` is a separate file and was not used for acceptance.

## Reve 2.1 reference-image regression

Replicate's live model version `b80beec96b7c28035d1ed3e169ebf3e9a47cf50cd88296665f852ed9b18ec139` declares `reference_images` as an optional array of URI strings, with `default: null` and `nullable: true`. Its prediction API nevertheless rejected the user's null value. The [model documentation](https://replicate.com/reve/reve-2.1/readme) describes an ordered list of up to eight reference images.

The app misclassified the plural field as a setting and persisted its null default. In the user's saved workflow, that setting overwrote the connected image during fallback request construction. The fix recognises the image-array handle, applies saved settings before connected inputs, and omits null array settings from Replicate requests. It covers existing workflows without editing their saved files.

Five regression cases failed before the fix. All 81 targeted provider, schema and image-executor tests passed afterward, covering connected images, order, stale defaults, dynamic inputs, and prompt-only requests. The isolated production build and packaged smoke tests passed, including a read-only check against Replicate's live schema. The automated checks did not submit a paid Reve prediction.

A subsequent user run passed input validation and created a Replicate prediction, then failed upstream with `PARTNER_API_CLOSED`. [Reve's official notice](https://help.reve.com/hc/en-us/articles/46837930295316-Reve-API) confirms its API was retired on 14 August 2026. Successful Reve generation through this Replicate integration is therefore blocked by upstream availability; the request-format fix does not restore the retired service. No paid predictions were submitted by the automated checks.

## Release checksums (SHA-256)

```text
67019d7a7445d248bb4f1c0a990638d13e3f3d5d80ebfeb3f4a4f4347fea3ec4  Node Banana-1.9.0-arm64.dmg
fa1672dc7939f03516a053cb3078aa51eb76d691dd1ba897e7c8135d1a3e8cf9  Node Banana-1.9.0-arm64.zip
```

The app remains unsigned and unnotarised. Installation and tester steps are in [desktop-preview.md](desktop-preview.md).
