/**
 * One asset.
 *
 * GET               → AssetView (404 when the library has no such asset)
 * PATCH AssetPatch  → AssetView: tags, favorite, trashed, name (the display name; "" clears it)
 */

import { getAsset, patchAsset } from "@/lib/assets/server";
import { ASSET_ID_PATTERN } from "@/lib/assets/types";
import { handle, json, notFound, pathParam, readJson } from "../_lib/http";
import { parsePatch } from "../_lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  return handle(request, "assets.get", async () => {
    const id = pathParam((await params).id, ASSET_ID_PATTERN, "asset id");
    const asset = await getAsset(id);
    if (!asset) throw notFound("No such asset in the library.");
    return json(asset);
  });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  return handle(request, "assets.patch", async () => {
    const id = pathParam((await params).id, ASSET_ID_PATTERN, "asset id");
    const patch = parsePatch(await readJson(request));
    const asset = await patchAsset(id, patch);
    if (!asset) throw notFound("No such asset in the library.");
    return json(asset);
  });
}
