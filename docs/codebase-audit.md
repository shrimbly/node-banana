# Focused codebase audit

Baseline: `30146c3` (`develop`). Scope: independently reviewed execution and input routing; workflow persistence, tabs, clipboard and media ownership; server/API security and file operations; asynchronous chat and media uploads. Reviewers cross-checked fixes outside their original areas. Only confirmed high-impact correctness/security issues were promoted for fixes; this is not a claim of exhaustive coverage.

## Confirmed issues fixed

| Area | Failure and correction | Regression evidence |
| --- | --- | --- |
| Local API boundary | A foreign website could invoke privileged local APIs. Reject foreign browser origins/cross-site requests, bind loopback by default, and validate Host to resist DNS rebinding. Apply the same boundary in production. | Origin/Host unit tests and real production HTTP smoke tests. |
| Unused image optimizer | Internal image-optimizer requests could dispatch local API routes without browser-origin headers, bypassing the API boundary before image validation. Disable the unused optimizer endpoint entirely; ordinary application image URLs remain supported. | Configuration regression and production optimizer rejection smoke test. |
| Comfy credentials | An arbitrary request-selected engine could receive server environment credentials. Restrict environment fallback to the configured engine URL. | Configured/custom engine and explicit credential tests. |
| Workflow file replacement | A failed direct write could truncate an existing workflow. Write to an exclusive sibling temporary file, then rename atomically. | Real filesystem partial-write/disk-full and failed-rename tests preserve original bytes. |
| Save As media | Clearing saved refs also revoked live video/GLB URLs before externalization. Preserve live blobs while resetting storage references. | `executionUtils` blob preservation tests. |
| Save during media replacement | An asynchronous save attached stale file references to newly edited media. Merge saved refs only when their source media is unchanged. | Deferred save/media replacement tests. |
| Hydration and save ownership | Slow loads/saves could overwrite a different workflow or tab; saves could overlap. Guard commits by workflow lifecycle and serialize saves. | Deferred replacement/tab-switch and overlapping-save tests. |
| Cancel/restart execution | A cancelled run's completion or cleanup could overwrite a newer run's state/results. Scope all execution entry points, context writes and cleanup to their owning controller/lifecycle. | Deferred scheduler, immediate-node, downstream and stale-result tests. |
| Run during hydration | A new run on the outgoing graph could survive a pending load. Abort it and advance lifecycle again when the loaded graph commits. | Same-node-ID deferred hydration/run regression. |
| Copied media | Cross-project copies trusted refs from another folder, and closing the source could revoke shared blobs. Re-externalize into the destination and preserve other live owners. | Cross-tab file refs, clipboard and blob ownership regressions. |
| Replaced video output | Regenerating one video revoked URLs still owned by copies or undo history. Release replaced blobs through ownership-aware cleanup after successful replacement. | Stitch/trim/ease replacement tests and store ownership tests. |
| Converging router inputs | Shared cycle tracking discarded valid sibling input paths. Track visited nodes per recursion path. | Shared router/switch branch tests. |
| Named prompt inputs | A negative prompt could overwrite the primary generation prompt. Give explicit primary prompt sockets precedence. | Named-input routing tests. |
| Chat workflow ownership | Delayed AI callbacks could edit or replace another tab's graph. Scope requests/tools by workflow lifecycle and stop chat streams on replacement. | Stale tool/build response tests and committed-load feedback tests. |
| Upload ownership | Deferred file/metadata callbacks could overwrite reused node IDs after switching workflows, removal or a later upload. Guard each upload by request and workflow lifecycle. | Image, audio, video and annotation deferred-callback tests. |
| Audio replacement/removal | An old external file ref survived new or removed audio, restoring stale content on save/reopen. Clear the ref on every replacement/removal path. | Metadata success, metadata failure and removal tests. |
| Framework dependencies | Upgrade Next.js to 16.2.11 to remove direct framework advisories, including WebSocket-upgrade SSRF relevant to custom Node servers. | API, server and proxy regression tests; production build. |
| Development test tooling | Upgrade Vitest and its coverage integration to 4.1.0, removing the critical UI/API server advisory. The affected UI server was not enabled in this project. | Full suite on the patched runner and coverage smoke test. |

## Validation and boundaries

Integrated checks: `npm run test:run` passed **3,061 tests across 160 files** on Vitest 4.1.0. `npm run build` passed on Next.js 16.2.11, including production TypeScript validation. The build reports a file-tracing warning for filesystem access in `workflow-images`; tests retain existing jsdom media/canvas and mock warnings.

Final production smoke with explicit `HOST=127.0.0.1`: application page and same-origin API returned 200; hostile Host and foreign-origin workflow POST returned 403; both asset and internal-API optimizer requests returned 404; the ordinary image URL still returned 200 with `image/png`. The temporary server was stopped after verification.

CodeRabbit reviewed the audit diff against `origin/develop`. Its explicit-loopback Host-protection finding was verified and fixed with regression tests. A follow-up review of the final nine changed files returned zero findings; independently assigned reviewers also checked the async ownership and server fixes.

Dependency changes address the primary [Next.js advisory](https://github.com/vercel/next.js/security/advisories/GHSA-c4j6-fc7j-m34r) and [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp). The full dependency audit now reports zero critical advisories. The runtime-only audit still reports nine high package entries and two moderate entries. Remaining high entries are assessed by reachable behavior, not assumed to be safe solely because they are transitive:

- Next.js has no remaining direct advisories; its audit entry inherits dependency findings.
- PostCSS, browserslist and nanoid process repository CSS/configuration and fixed-size identifiers, not request-provided CSS, queries or sizes.
- jws is used for Google JWT signing, not the affected HMAC verification interface.
- ws belongs to the unused Gemini Live transport.
- minimatch and brace-expansion have no observed request-controlled glob evaluation path.
- Sharp is not called by application code. The unused Next.js image-optimizer endpoint is disabled, removing its indirect decoder entry point as well as the internal API-dispatch bypass.

Standalone `tsc --noEmit` still reports legacy test-fixture typing errors throughout the repository. The production build's type validation is checked separately; this audit does not claim a clean repository-wide standalone typecheck.

No paid model generation requests were made. Production smoke tests used a temporary loopback port and were stopped afterwards. Explicit network hosting remains unauthenticated: only enable it on a trusted network; it is not a multi-user deployment boundary. Download limits and comprehensive remote-URL/DNS/redirect policies remain follow-up hardening outside the confirmed high findings.

The requested PR targets `master`. The audit branch starts from `develop`, which already contains changes not yet in `master`; the PR consequently includes that existing development baseline in addition to the fixes described here.
