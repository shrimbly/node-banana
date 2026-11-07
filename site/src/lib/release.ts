/**
 * What the page says about the current release, read at build time so the
 * site never carries a hand-edited version.
 *
 * The version is the app's own, from the repository's package.json (the site
 * is a folder of the app's repo and Vercel builds it with the whole checkout
 * present). The OS floors are the packaged app's: Electron's supported
 * macOS line and the NSIS installer's Windows line (docs/desktop-preview.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

// `astro build` runs with the site folder as its working directory (Vercel's
// Root Directory is `site`), and the app's package.json is its parent's. The
// module's own URL is no use here: Astro bundles it elsewhere before it runs.
const rootPackagePath = path.resolve(process.cwd(), "..", "package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as { name?: string; version?: string };

if (rootPackage.name !== "node-banana" || !rootPackage.version) {
  throw new Error(
    `${rootPackagePath} is not the app's package.json, so the site has no version to show. Build from the site folder of a full checkout (on Vercel, keep "Include source files outside of the Root Directory" on).`,
  );
}

/** "2.2.0" */
export const version: string = rootPackage.version;
/** "v2.2.0", as shown beside the download buttons. */
export const versionLabel = `v${version}`;
export const minMac = "macOS 13";
export const minWindows = "Windows 10";
