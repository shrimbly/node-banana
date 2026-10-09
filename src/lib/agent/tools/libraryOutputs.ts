/**
 * The asset library as view_outputs' reader: a result's record, and its
 * picture downsized for a model. Images come from their own file; a video
 * from the frame the browser captured for its thumbnail. Server-only.
 */

import { promises as fs } from "fs";
import type { AgentOutputReader, ViewableOutput } from "./outputs";

/** Long edge of an image shown to a model: past ~1,500px the models scale it down anyway, and tokens grow with area. */
const MAX_EDGE = 1024;
/** Without sharp, an original this small and in a format both models read goes as it is. */
const RAW_MAX_BYTES = 4 * 1024 * 1024;
const RAW_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type Library = typeof import("@/lib/assets/server");

export function libraryOutputReader(): AgentOutputReader {
  return {
    async read(assetId) {
      // Loaded on first use: the tool runtime is also built where no library runs (tests, the research turn).
      const library = await import("@/lib/assets/server");
      const asset = await library.getAsset(assetId);
      if (!asset || asset.missing) return null;
      const output: ViewableOutput = {
        kind: asset.kind,
        ...(asset.prompt ? { prompt: asset.prompt } : {}),
        ...(asset.model ? { model: asset.model.displayName ?? asset.model.modelId } : {}),
        createdAt: asset.createdAt,
        ...(asset.batch && asset.batch.count > 1 ? { batch: { index: asset.batch.index, count: asset.batch.count } } : {}),
      };
      const image =
        asset.kind === "image"
          ? await imageOf(library, asset.id, asset.sha256)
          : asset.kind === "video" && asset.hasPoster
            ? await thumbnailOf(library, asset.sha256)
            : null;
      return image ? { ...output, image } : output;
    },
  };
}

async function imageOf(library: Library, id: string, sha256: string): Promise<ViewableOutput["image"] | null> {
  const file = await library.openAssetFile(id);
  if (!file) return null;
  const { loadSharp } = await import("@/lib/assets/server/thumbs");
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const bytes = await sharp(file.path)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      return { mime: "image/webp", data: bytes.toString("base64") };
    } catch {
      // Unreadable by sharp: the thumbnail, or the file itself, below.
    }
  }
  if (RAW_MIMES.has(file.mime) && file.bytes <= RAW_MAX_BYTES) {
    return { mime: file.mime, data: (await fs.readFile(file.path)).toString("base64") };
  }
  return thumbnailOf(library, sha256);
}

async function thumbnailOf(library: Library, sha256: string): Promise<ViewableOutput["image"] | null> {
  const thumb = await library.getThumbnail(sha256, 640);
  if (!thumb) return null;
  return { mime: thumb.mime, data: (await fs.readFile(thumb.path)).toString("base64") };
}
