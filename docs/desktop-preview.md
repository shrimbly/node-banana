# Node Banana desktop

The desktop app is an Apple Silicon application (macOS 13 or later), signed and notarised when built with `--sign` (see [Releases and updates](#releases-and-updates)) and unsigned otherwise, and a Windows x64 installer (Windows 10 or later; see [Windows](#windows-x64)). Testers need macOS, an internet connection for providers, and their own provider keys. They do not need the repository, Node, npm, or an environment file. Intel Macs, Linux artifacts and native file associations are outside this preview.

## Install and try it

1. Open `Node-Banana-<version>-arm64.dmg`, drag **Node Banana** to **Applications**, eject the disk image, then open the installed application. Alternatively, extract the ZIP and move the app into Applications.
2. If the build is unsigned, macOS may block the first launch. For a preview you trust, attempt to open it, then use **System Settings → Privacy & Security → Open Anyway**. Follow [Apple's instructions](https://support.apple.com/102445); do not disable Gatekeeper globally. A signed and notarised build opens without this step.
3. Enter a provider key in Settings. On macOS, allow the application's login-keychain access if prompted. Keys are encrypted on disk. If secure storage is unavailable, retry after unlocking the keychain or choose **Use for this session only**. Session-only changes disappear when the application closes.
4. Add a prompt and generation node, connect their matching handles, and run a small generation. Save the workflow into a folder you choose. Quit, reopen, and load that workflow to check the saved output and settings.
5. Try two unsaved tabs with different prompts and media. Force Quit the app, reopen it, and choose **Restore Session**. Check tab order, connections, viewport and costs. Interrupted nodes show a stopped explanation; recovery does not resubmit requests or resume remote jobs.

Recovery checkpoints follow edits after one second of inactivity, or every five seconds while edits continue. Slow storage or large media can delay completion; an error is shown if checkpointing fails. Save important work normally. Closing a tab and confirming discard, or choosing **Discard and close**, prevents those edits from returning. Cancelling a close keeps recovery active. Closing an unanswered recovery prompt preserves the offered session.

## Where data goes

| Data | macOS location |
| --- | --- |
| Preferences, encrypted keys, recovery, window state and the skipped update version | `~/Library/Application Support/Node Banana/` |
| Downloaded updates, until they are installed | `~/Library/Caches/node-banana-updater/` |
| Versioned writable server copies and Next caches | `~/Library/Application Support/Node Banana/runtimes/` |
| Main/backend diagnostics and workflow diagnostic sessions | Electron's logs directory; use **Help → Open Logs** |
| Workflow files and generated outputs | Folders selected in the application |

The default origin remains `http://127.0.0.1:47831`. If another process occupies that port, the app offers **Retry**, **Open Logs** and **Quit**. It does not terminate the other process or change the address. The authenticated server rejects requests outside the desktop session.

A stopped backend leaves the editor open and disables new runs. Choose **Restart Server** to reconnect. A renderer crash offers **Recover Editor**, which opens checkpoint recovery. Remote providers may still be processing jobs after either failure; check the provider before manually running them again.

Provider keys and all ComfyUI authentication fields (including endpoint URLs that may embed credentials) are encrypted using Electron `safeStorage`. Legacy desktop localStorage credentials are removed only after an encrypted write succeeds. Decrypted values remain in renderer memory and accompany provider requests in this milestone. Normal browser mode retains its existing credential behaviour.

The application bundle remains unchanged at runtime. A fresh build is copied atomically into user data before launch. The previous successful runtime is kept until the new server starts. Recovery keeps a current and previous checksummed checkpoint, plus durable media assets. Assets no longer referenced by either checkpoint are collected; unfinished media transfers remain protected while their checkpoint is prepared. Unchanged assets reuse verification until their file metadata changes or a new renderer session starts. Missing external files are reported; their references are preserved. Recovery data contains editor content and is private to the user account, but is not encrypted.

## Import existing environment settings

In the desktop app, open **Project settings → Providers → Import from .env**, or use the same button during API-key onboarding. Choose your existing `.env` or `.env.local` file; hidden files are shown in the native picker. Imported credentials are encrypted immediately and available without restarting. Existing non-empty credentials are kept. This explicit import can refill a key deleted in previously saved settings. Edits and clears still pending in the open settings dialog are preserved when imported values are shown. Cancelling the settings dialog does not undo the import.

Supported provider variables are `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `REPLICATE_API_KEY`, `FAL_API_KEY`, `KIE_API_KEY`, `WAVESPEED_API_KEY`, and `MAGNIFIC_API_KEY`. ComfyUI imports support `COMFY_CLOUD_API_KEY`, `COMFY_API_KEY` (remote authentication), `COMFY_ORG_API_KEY`, `COMFY_CLOUD_URL`, `COMFY_LOCAL_URL`, and `COMFY_REMOTE_URL`. `COMFY_MODE` and `COMFY_API_V2` fill missing non-secret preferences.

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

`electron:package` produces the `.app`, drag-to-Applications DMG and ZIP in `dist-electron/`, plus the updater's `latest-mac.yml` and blockmaps. Use `npm run electron:package -- --dir` for an app-only packaging iteration. Builds use `npm ci` and the checked-in lockfile in a fresh temporary directory. Only source/configuration/public assets are copied into that build. The child build environment is allowlisted; `.env*`, developer keys, workflows, logs, Git history, caches, tests and fixtures do not enter the release inputs. Runtime production dependencies, `.next`, public assets and the custom server are packaged explicitly; [Next standalone output does not trace custom servers](https://nextjs.org/docs/app/guides/custom-server).

`electron:acceptance` copies the app outside the repository, uses a clean profile and environment, and tests port conflict/retry, assets/native image processing, credential migration/update/delete/failure, backend and renderer crashes, tab recovery, interrupted generation, discards and bundle immutability. It uses a synthetic key for the provider error path. A successful provider request with a valid tester credential remains a separate manual check unless explicitly configured for the acceptance run.

`electron-large-workflow.cjs` loads an existing media-heavy workflow in a disposable profile, blocks workflow writes and provider submissions, and checks checkpointing and crash restoration. It leaves the original workflow file unchanged. Recovery keeps media outside checkpoint JSON and transfers it in 1 MiB chunks.

Native input checks use `cliclick` and require macOS Accessibility permission. They exercise OS hit testing for hover, minimise, fullscreen, close, and window dragging. Browser development remains `npm run dev`; unpackaged desktop development remains `npm run electron:dev`.

For isolated manual testing, set `NODE_BANANA_ELECTRON_USER_DATA` to a temporary directory before launching the executable. `NODE_BANANA_ELECTRON_PORT` is an explicit developer/test override; each port has separate Chromium origin storage. Avoid overriding either value for ordinary testers.

Diagnostics rotate at 2 MiB across four desktop log files; workflow session logs retain ten bounded files. Known credential values and credential-shaped fields are redacted. When reporting a problem, include app version, macOS version, the failed step and relevant diagnostics. Do not attach credential files or recovery content without inspecting what they contain.

## Releases and updates

A release is the GitHub release tagged `v<version>` on `shrimbly/node-banana`, carrying the installers, their blockmaps and the updater manifests (`latest-mac.yml`, `latest.yml`). The packaged app checks that release. Each release also carries versionless copies of the installers (`Node-Banana-mac-arm64.dmg`, `Node-Banana-windows-x64.exe`) for the landing page's `/download/mac` and `/download/windows` (see [site-hosting.md](site-hosting.md)); the updater never reads them.

To cut a release, set the version in `package.json` (and the lockfile), commit, and push the tag `v<version>`. The **Release** workflow (`.github/workflows/release.yml`) runs the tests, creates the draft release, then builds on GitHub's runners: the Mac build on an Apple Silicon runner, signed and notarised, with its signature, Gatekeeper assessment and stapled ticket verified; the Windows build on a Windows runner, unsigned, with one retry for the Turbopack crash. Both upload into the draft, each with its versionless copy. The Windows job runs only while the repository variable `RELEASE_WINDOWS` is `true` (Settings → Secrets and variables → Actions → Variables; set for 2.1.0), so a Mac-only release can be cut by unsetting it. Add the notes, check the assets, publish. Running the workflow by hand builds without publishing and keeps the installers as workflow artifacts; ticking **publish** uploads to the draft instead.

The workflow needs five repository secrets: `MAC_CERTIFICATE_P12_BASE64` (the Developer ID Application certificate, exported from Keychain Access as a `.p12`, then `base64 -i cert.p12 | pbcopy`), `MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8` (the App Store Connect key file's contents), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. electron-builder imports the certificate into a temporary keychain for the build. Windows needs nothing.

The same build runs by hand, which is the fallback when the runners are unavailable:

1. Set the version in `package.json` (and the lockfile) and commit.
2. On the Mac, sign, notarise and upload:

   ```sh
   export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8 APPLE_API_KEY_ID=XXXXXXXXXX APPLE_API_ISSUER=<issuer uuid>
   export GH_TOKEN=<token that can write releases>
   npm run electron:package -- --sign --publish
   ```

   `--sign` finds the **Developer ID Application** identity in the login keychain (set `CSC_NAME` to choose between several), signs the app and every nested binary with the hardened runtime and `electron/entitlements.mac.plist`, then notarises and staples it. It refuses to run without notarisation credentials: an App Store Connect API key as above, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The Squirrel.Mac updater only installs signed builds, so a release for existing users must be signed.
3. On the Windows machine, build and upload the same version: `npm run electron:package -- --publish` with `GH_TOKEN` set. Windows builds are unsigned.
4. Both uploads land in one **draft** release named after the tag. Add the release notes, check the assets (`Node-Banana-<version>-arm64.dmg`, `.zip`, `latest-mac.yml`; `Node-Banana-<version>-x64.exe`, `.zip`, `latest.yml`, and the `.blockmap` files), then publish it. A release built by hand has no versionless copies; upload them as in [site-hosting.md](site-hosting.md#a-release-built-by-hand), or the website's download links reach a missing file. Nothing is offered to users until the draft is published.

`--publish` without `--sign` uploads an unsigned Mac build, which is fine for a preview that testers install by hand but will not update in place. Every build, published or not, carries `app-update.yml` naming the repository, so a locally packaged app also checks the published releases.

Installed apps check for a newer release 15 seconds after launch and every six hours (every 30 minutes after a failed check), and on **Help → Check for Updates…**. A background check that fails, for want of a network or otherwise, is logged and nothing is shown. When a newer release exists, a one-row notice in the notification stack (the shape of the server banner) offers **Update** and **Skip**; the download runs in the background with its progress shown (differential against the installed version, where the blockmaps allow), then the notice offers **Restart to update**. Closing the notice puts it away until the next check; a downloaded update installs when the app next quits. A skipped version is kept in `updates-v1.json` in the user-data folder and is offered again only by a manual check. If the update cannot be installed (an unsigned Mac build, a broken download), the notice says so and links to the release so the installer can be fetched by hand. Profiles started with `NODE_BANANA_ELECTRON_USER_DATA` never check by themselves. Development runs (`electron:dev`) do not update; to see the notice there, start with `NODE_BANANA_ELECTRON_PREVIEW_UPDATES=1` (or `=fail` for a broken download): a pretend updater always finds the next minor version, downloads it over a few seconds, and "installs" it with a dialog.

## Windows (x64)

`npm run electron:package` on a Windows 11 x64 machine (Node 23, ImageMagick 7) produces, in `dist-electron/`, a per-user **NSIS installer** `Node-Banana-<version>-x64.exe` and a **zip** `Node-Banana-<version>-x64.zip`, plus their blockmaps, the updater's `latest.yml` and an unpacked `win-unpacked/` tree. The installer is not signed; Windows SmartScreen may warn on first run. Updates download the new installer (differential where possible) and run it silently on **Restart to update**, so SmartScreen is only met on the first, manual install. Downloaded updates wait in `%LOCALAPPDATA%\node-banana-updater\`. The app icon is a multi-resolution `.ico` generated from the shared artwork with ImageMagick (macOS uses `iconutil`); the macOS packaging path is unchanged. Data lives under `%APPDATA%\Node Banana\` (preferences, encrypted keys, recovery, window state, and versioned `runtimes\`); logs are in `%APPDATA%\Node Banana\logs\`, also opened by the disconnected banner's **Open logs** button. The server origin is the same `http://127.0.0.1:47831`.

The window is frameless on Windows: no native title bar and no menu bar. The workflow tab strip is the drag region (double-click maximises) and the app draws minimise, maximise/restore and close at the top right, dim at rest and lit on hover like the macOS controls. The application menu stays installed but hidden, so its accelerators (reload, DevTools, F11 fullscreen) still work; the Help items have no Windows home yet.

Keys are encrypted with Electron's `safeStorage`, whose AES key on Windows is DPAPI-wrapped in `%APPDATA%\Node Banana\Local State`. If Chromium regenerates that key the saved file can no longer be decrypted, and retrying never helps. For that failure only, the credential dialog offers **Reset stored keys**, which moves the file aside as `credentials-v1.unreadable-<timestamp>.json` and starts an empty store; keys are re-entered in Settings. Other credential failures (an unwritable file, an unavailable keychain) keep the existing file and do not offer a reset.

The release build and the packaged backend both receive an allowlisted environment (`electron/lib/env.cjs`): the OS variables Windows children need, never the developer's shell as a whole, so no provider key reaches `next build` or the bundled server by any name.

Verified on Windows 11 x64 for this build:

- `npm run electron:package` produces the x64 installer and zip; `win-unpacked\Node Banana.exe` starts and the desktop server listens on `127.0.0.1:47831`. Bundled runtime files are present (`resources\runtime\.next\BUILD_ID`, `resources\runtime\node_modules\sharp\package.json`, `resources\runtime\server.cjs`, `resources\runtime\runtime.json` with `arch: "x64"`).
- The installer installs silently (`/S`) per-user to `%LOCALAPPDATA%\Programs\Node Banana\` without elevation; the installed app starts and listens on 47831; `Uninstall Node Banana.exe /S` removes it.
- `npm run electron:test` and `node scripts/electron-smoke.cjs --production` pass (the `npm run electron:smoke -- --production` form runs in dev because npm consumes `--production`). One recovery test is skipped on Windows: it simulates a directory fsync failure, and `atomicWrite` never fsyncs directories there.

Not covered on Windows in this milestone: signing, SmartScreen handling, and installer branding. Auto-update is implemented but has not yet been exercised on Windows hardware. The production `next build` (Turbopack) can crash intermittently with an access violation on Windows and succeeds on retry.
