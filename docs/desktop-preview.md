# Node Banana Mac preview

This preview is an unsigned Apple Silicon application. Testers need macOS, an internet connection for providers, and their own provider keys. They do not need the repository, Node, npm, or an environment file. Intel Macs, Windows/Linux artifacts, signing/notarisation, updates and native file associations are outside this preview.

## Install and try it

1. Open `Node Banana-1.9.0-arm64.dmg`, drag **Node Banana** to **Applications**, eject the disk image, then open the installed application. Alternatively, extract the ZIP and move the app into Applications.
2. Because this build is unsigned, macOS may block the first launch. For a preview you trust, attempt to open it, then use **System Settings → Privacy & Security → Open Anyway**. Follow [Apple's instructions](https://support.apple.com/102445); do not disable Gatekeeper globally.
3. Enter a provider key in Settings. On macOS, allow the application's login-keychain access if prompted. Keys are encrypted on disk. If secure storage is unavailable, retry after unlocking the keychain or choose **Use for this session only**. Session-only changes disappear when the application closes.
4. Add a prompt and generation node, connect their matching handles, and run a small generation. Save the workflow into a folder you choose. Quit, reopen, and load that workflow to check the saved output and settings.
5. Try two unsaved tabs with different prompts and media. Force Quit the app, reopen it, and choose **Restore Session**. Check tab order, connections, viewport and costs. Interrupted nodes show a stopped explanation; recovery does not resubmit requests or resume remote jobs.

Recovery checkpoints follow edits after one second of inactivity, or every five seconds while edits continue. Slow storage or large media can delay completion; an error is shown if checkpointing fails. Save important work normally. Closing a tab and confirming discard, or choosing **Discard and close**, prevents those edits from returning. Cancelling a close keeps recovery active. Closing an unanswered recovery prompt preserves the offered session.

## Where data goes

| Data | macOS location |
| --- | --- |
| Preferences, encrypted keys, recovery and window state | `~/Library/Application Support/Node Banana/` |
| Versioned writable server copies and Next caches | `~/Library/Application Support/Node Banana/runtimes/` |
| Main/backend diagnostics and workflow diagnostic sessions | Electron's logs directory; use **Help → Open Logs** |
| Workflow files and generated outputs | Folders selected in the application |

The default origin remains `http://127.0.0.1:47831`. If another process occupies that port, the app offers **Retry**, **Open Logs** and **Quit**. It does not terminate the other process or change the address. The authenticated server rejects requests outside the desktop session.

A stopped backend leaves the editor open and disables new runs. Choose **Restart Server** to reconnect. A renderer crash offers **Recover Editor**, which opens checkpoint recovery. Remote providers may still be processing jobs after either failure; check the provider before manually running them again.

Provider keys and all ComfyUI authentication fields (including endpoint URLs that may embed credentials) are encrypted using Electron `safeStorage`. Legacy desktop localStorage credentials are removed only after an encrypted write succeeds. Decrypted values remain in renderer memory and accompany provider requests in this milestone. Normal browser mode retains its existing credential behaviour.

The application bundle remains unchanged at runtime. A fresh build is copied atomically into user data before launch. The previous successful runtime is kept until the new server starts. Recovery keeps a current and previous checksummed checkpoint, plus durable media assets. Assets no longer referenced by either checkpoint are collected; unfinished media transfers remain protected while their checkpoint is prepared. Unchanged assets reuse verification until their file metadata changes or a new renderer session starts. Missing external files are reported; their references are preserved. Recovery data contains editor content and is private to the user account, but is not encrypted.

## Import existing environment settings

In the desktop app, open **Project settings → Providers → Import from .env**, or use the same button during API-key onboarding. Choose your existing `.env` or `.env.local` file; hidden files are shown in the native picker. Imported credentials are encrypted immediately and available without restarting. Existing non-empty credentials are kept. This explicit import can refill a key deleted in previously saved settings. Edits and clears still pending in the open settings dialog are preserved when imported values are shown. Cancelling the settings dialog does not undo the import.

Supported provider variables are `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `REPLICATE_API_KEY`, `FAL_API_KEY`, `KIE_API_KEY`, and `WAVESPEED_API_KEY`. ComfyUI imports support `COMFY_CLOUD_API_KEY`, `COMFY_API_KEY` (remote authentication), `COMFY_ORG_API_KEY`, `COMFY_CLOUD_URL`, `COMFY_LOCAL_URL`, and `COMFY_REMOTE_URL`. `COMFY_MODE` and `COMFY_API_V2` fill missing non-secret preferences.

The source file is read locally and left unchanged. Unrelated variables are ignored. Files are parsed as data with Node's [environment-file parser](https://nodejs.org/api/util.html#utilparseenvcontent); shell commands and variable substitutions are not executed. Source `.env` files remain excluded from release packages. Browser-mode settings are unchanged.

## Build and verify

On an Apple Silicon Mac with Node and npm:

```sh
npm ci
npm run electron:package
npm run electron:test
npm run electron:smoke -- --executable "dist-electron/mac-arm64/Node Banana.app/Contents/MacOS/Node Banana"
npm run electron:acceptance
node scripts/electron-env-import.cjs
node scripts/electron-large-workflow.cjs --workflow "/path/to/large-workflow.json"
npm run electron:smoke -- --executable "/Applications/Node Banana.app/Contents/MacOS/Node Banana" --native-input
```

`electron:package` produces the `.app`, drag-to-Applications DMG and ZIP in `dist-electron/`. Use `npm run electron:package -- --dir` for an app-only packaging iteration. Builds use `npm ci` and the checked-in lockfile in a fresh temporary directory. Only source/configuration/public assets are copied into that build. The child build environment is allowlisted; `.env*`, developer keys, workflows, logs, Git history, caches, tests and fixtures do not enter the release inputs. Runtime production dependencies, `.next`, public assets and the custom server are packaged explicitly; [Next standalone output does not trace custom servers](https://nextjs.org/docs/app/guides/custom-server).

`electron:acceptance` copies the app outside the repository, uses a clean profile and environment, and tests port conflict/retry, assets/native image processing, credential migration/update/delete/failure, backend and renderer crashes, tab recovery, interrupted generation, discards and bundle immutability. It uses a synthetic key for the provider error path. A successful provider request with a valid tester credential remains a separate manual check unless explicitly configured for the acceptance run.

`electron-large-workflow.cjs` loads an existing media-heavy workflow in a disposable profile, blocks workflow writes and provider submissions, and checks checkpointing and crash restoration. It leaves the original workflow file unchanged. Recovery keeps media outside checkpoint JSON and transfers it in 1 MiB chunks.

Native input checks use `cliclick` and require macOS Accessibility permission. They exercise OS hit testing for hover, minimise, fullscreen, close, and window dragging. Browser development remains `npm run dev`; unpackaged desktop development remains `npm run electron:dev`.

For isolated manual testing, set `NODE_BANANA_ELECTRON_USER_DATA` to a temporary directory before launching the executable. `NODE_BANANA_ELECTRON_PORT` is an explicit developer/test override; each port has separate Chromium origin storage. Avoid overriding either value for ordinary testers.

Diagnostics rotate at 2 MiB across four desktop log files; workflow session logs retain ten bounded files. Known credential values and credential-shaped fields are redacted. When reporting a problem, include app version, macOS version, the failed step and relevant diagnostics. Do not attach credential files or recovery content without inspecting what they contain.

## Windows (x64)

`npm run electron:package` on a Windows 11 x64 machine (Node 23, ImageMagick 7) produces, in `dist-electron/`, a per-user **NSIS installer** `Node Banana-1.9.0-x64.exe` and a **zip** `Node Banana-1.9.0-x64.zip`, plus an unpacked `win-unpacked/` tree. The installer is not signed; Windows SmartScreen may warn on first run. The app icon is a multi-resolution `.ico` generated from the shared artwork with ImageMagick (macOS uses `iconutil`); the macOS packaging path is unchanged. Data lives under `%APPDATA%\Node Banana\` (preferences, encrypted keys, recovery, window state, and versioned `runtimes\`); logs are in `%APPDATA%\Node Banana\logs\`, also opened by the disconnected banner's **Open logs** button. The server origin is the same `http://127.0.0.1:47831`.

The window is frameless on Windows: no native title bar and no menu bar. The workflow tab strip is the drag region (double-click maximises) and the app draws minimise, maximise/restore and close at the top right, dim at rest and lit on hover like the macOS controls. The application menu stays installed but hidden, so its accelerators (reload, DevTools, F11 fullscreen) still work; the Help items have no Windows home yet.

Keys are encrypted with Electron's `safeStorage`, whose AES key on Windows is DPAPI-wrapped in `%APPDATA%\Node Banana\Local State`. If Chromium regenerates that key the saved file can no longer be decrypted, and retrying never helps. For that failure only, the credential dialog offers **Reset stored keys**, which moves the file aside as `credentials-v1.unreadable-<timestamp>.json` and starts an empty store; keys are re-entered in Settings. Other credential failures (an unwritable file, an unavailable keychain) keep the existing file and do not offer a reset.

The release build and the packaged backend both receive an allowlisted environment (`electron/lib/env.cjs`): the OS variables Windows children need, never the developer's shell as a whole, so no provider key reaches `next build` or the bundled server by any name.

Verified on Windows 11 x64 for this build:

- `npm run electron:package` produces the x64 installer and zip; `win-unpacked\Node Banana.exe` starts and the desktop server listens on `127.0.0.1:47831`. Bundled runtime files are present (`resources\runtime\.next\BUILD_ID`, `resources\runtime\node_modules\sharp\package.json`, `resources\runtime\server.cjs`, `resources\runtime\runtime.json` with `arch: "x64"`).
- The installer installs silently (`/S`) per-user to `%LOCALAPPDATA%\Programs\Node Banana\` without elevation; the installed app starts and listens on 47831; `Uninstall Node Banana.exe /S` removes it.
- `npm run electron:test` and `node scripts/electron-smoke.cjs --production` pass (the `npm run electron:smoke -- --production` form runs in dev because npm consumes `--production`). One recovery test is skipped on Windows: it simulates a directory fsync failure, and `atomicWrite` never fsyncs directories there.

Not covered on Windows in this milestone: signing, SmartScreen handling, auto-update, and installer branding. The production `next build` (Turbopack) can crash intermittently with an access violation on Windows and succeeds on retry.
