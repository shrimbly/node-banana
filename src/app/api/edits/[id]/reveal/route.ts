/**
 * Show an edit's file in Finder/Explorer.
 * POST → { ok: true }
 */

import { handle, ok, pathParam } from "@/app/api/assets/_lib/http";
import { revealEdit } from "@/lib/edits/server";
import { EDIT_ID_PATTERN } from "@/lib/edits/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  return handle(request, "edits.reveal", async () => {
    await revealEdit(pathParam((await params).id, EDIT_ID_PATTERN, "edit id"));
    return ok();
  });
}
