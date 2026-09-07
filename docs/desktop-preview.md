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

The application bundle remains unchanged at runtime. A fresh build is copied atomically into user data before launch. The previous successful runtime is kept until the new server starts. Recovery keeps a current and previous checksummed checkpoint, plus durable media assets. Missing external files are reported; their references are preserved. Recovery data contains editor content and is private to the user account, but is not encrypted.

## Build and verify

On an Apple Silicon Mac with Node and npm:

```sh
npm ci
npm run electron:package
npm run electron:test
npm run electron:smoke -- --executable "dist-electron/mac-arm64/Node Banana.app/Contents/MacOS/Node Banana"
npm run electron:acceptance
npm run electron:smoke -- --executable "/Applications/Node Banana.app/Contents/MacOS/Node Banana" --native-input
```

`electron:package` produces the `.app`, drag-to-Applications DMG and ZIP in `dist-electron/`. Use `npm run electron:package -- --dir` for an app-only packaging iteration. Builds use `npm ci` and the checked-in lockfile in a fresh temporary directory. Only source/configuration/public assets are copied into that build. The child build environment is allowlisted; `.env*`, developer keys, workflows, logs, Git history, caches, tests and fixtures do not enter the release inputs. Runtime production dependencies, `.next`, public assets and the custom server are packaged explicitly; [Next standalone output does not trace custom servers](https://nextjs.org/docs/app/guides/custom-server).

`electron:acceptance` copies the app outside the repository, uses a clean profile and environment, and tests port conflict/retry, assets/native image processing, credential migration/update/delete/failure, backend and renderer crashes, tab recovery, interrupted generation, discards and bundle immutability. It uses a synthetic key for the provider error path. A successful provider request with a valid tester credential remains a separate manual check unless explicitly configured for the acceptance run.

Native input checks use `cliclick` and require macOS Accessibility permission. They exercise OS hit testing for hover, minimise, fullscreen, close, and window dragging. Browser development remains `npm run dev`; unpackaged desktop development remains `npm run electron:dev`.

For isolated manual testing, set `NODE_BANANA_ELECTRON_USER_DATA` to a temporary directory before launching the executable. `NODE_BANANA_ELECTRON_PORT` is an explicit developer/test override; each port has separate Chromium origin storage. Avoid overriding either value for ordinary testers.

Diagnostics rotate at 2 MiB across four desktop log files; workflow session logs retain ten bounded files. Known credential values and credential-shaped fields are redacted. When reporting a problem, include app version, macOS version, the failed step and relevant diagnostics. Do not attach credential files or recovery content without inspecting what they contain.
