/**
 * An asset's display name: the name the user gave it, kept in its record
 * beside the file's own name, which never changes. Shared by the routes, the
 * library and the browser.
 */

import type { AssetRecord } from "./types";

/** The longest display name. */
export const ASSET_NAME_MAX = 120;

const LINE_BREAK = /[\r\n\u2028\u2029]/;
const LINE_BREAKS = new RegExp(`${LINE_BREAK.source}+`, "g");

/** What a list, a tooltip or an edit's snapshot calls an asset: its display name, else its file's name. */
export function assetName(asset: Pick<AssetRecord, "name" | "filename">): string {
  return asset.name || asset.filename;
}

/**
 * Why a display name can't be kept, or null when it can. The name is judged
 * trimmed, and an empty one is fine: it clears the display name.
 */
export function assetNameProblem(value: string, field = "name"): string | null {
  const name = value.trim();
  if (name.length > ASSET_NAME_MAX) return `${field} is longer than ${ASSET_NAME_MAX} characters.`;
  if (LINE_BREAK.test(name)) return `${field} must be one line.`;
  return null;
}

/** The value on one line: each run of line breaks becomes a space. */
export function oneLineName(value: string): string {
  return value.replace(LINE_BREAKS, " ");
}

/** A stored display name, trimmed, when it is one a rename could have set; else undefined. */
export function cleanAssetName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && assetNameProblem(name) === null ? name : undefined;
}
