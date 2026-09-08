# Mac preview verification — 8 September 2026

Verified on macOS 26.2 / Apple Silicon with Electron 44.2.0 and Next.js 16.1.6. The release runtime is `1.9.0-ad4975c6-fd7c-4f3b-851b-aa96ad086824`.

## Review-fix verification

The review fixes preserve decrypted keys for session-only use after a write failure, keep imported ComfyUI endpoints and explicit provider draft clears, and keep Mac controls available while startup decisions are pending. Tab closure now persists its discard marker within the same renderer turn as the busy check and graph change, covering both the tab strip and menu. A post-rename disk-sync failure completes closure with a warning rather than leaving an open tab excluded from recovery.

Recovery collects media outside both valid checkpoints while protecting unfinished encodes, and reuses verification of unchanged files with metadata-based invalidation. Reserved runtime directory names are rejected, and diagnostic stream errors are contained and redacted.

| Latest check | Result |
| --- | --- |
| Full Vitest suite | 158 files, 2,982 tests passed |
| Electron persistence/lifecycle suite | 16 tests passed, including post-rename fsync failure, interrupted commit, asset collection and cache invalidation |
| Isolated production build and unsigned arm64 app/DMG/ZIP | Passed; packaged desktop modules match current source |
| Copied installation with clean profile and system-only PATH | Passed |
| Native input while recovery and credential prompts remain open | Passed: controls are hit-testable, minimise/fullscreen work, and startup dragging moves the window |
| Recovery, credentials and installed bundle acceptance | Passed: provider authentication rejection, migration/update/delete/failure, backend/renderer crashes, media/tab recovery, explicit discards, no resubmission and unchanged bundle digest |
| Current `Cars.json` regression | 68 nodes, 106,131,310 bytes across 12 recovery assets, 193,469-byte checkpoint; responsive edits and crash recovery passed without submissions or source changes |
| Older `Cars_new.json` inspection | All 63 nodes in the 265,175,984-byte file loaded without crashing; checkpoint failed with `Failed to fetch`. The saved file contains three expired `blob:` references, which require reattaching their media before recovery can checkpoint the graph. This is not a passing recovery result. |
| Review loop | Original findings and additional confirmed findings fixed; all three specialist reviewers clear; final incremental CodeRabbit review returned zero findings |
| Repository-wide TypeScript comparison | Same 203 pre-existing test-fixture diagnostics as pre-fix commit `592e3a6`; no new diagnostics |

The native startup drag test initially ran before macOS finished its fullscreen transition. An isolated probe confirmed the drag region and native movement worked after that transition; the harness now waits before issuing a fixed-coordinate drag. The complete installed-app acceptance run passed afterward. An earlier native minimise check timed out; the dedicated smoke run and final acceptance both passed it.

The large-workflow harness now supplies a file by path through the editor's drop handler, avoiding Chromium's 100 MB automation message limit for embedded media. The current `Cars.json` regression passed again through this path. Existing expired blob URLs in legacy workflow JSON cannot reconstruct the original media; this is separate from capturing live blob-backed media into durable recovery assets, which passed installed-app acceptance.

## Earlier milestone checks

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
ec98e2492668d0fa543817ea41cf6971f3731bb47d648484fcbf151b5bc0e644  Node Banana-1.9.0-arm64.dmg
309fb12b0ca2c7338f3389dd6dcacfb8e8de6ce73ba058bd1560a59a0c7d8884  Node Banana-1.9.0-arm64.zip
```

The app remains unsigned and unnotarised. Installation and tester steps are in [desktop-preview.md](desktop-preview.md).
