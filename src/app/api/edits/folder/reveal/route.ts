/**
 * Open the Edits folder in Finder/Explorer, creating it first when needed.
 * POST → { ok: true }
 *
 * The static `folder` segment is matched before `[id]`, and "folder" is never an edit id.
 */

import { handle, ok } from "@/app/api/assets/_lib/http";
import { revealEditsFolder } from "@/lib/edits/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(request, "edits.folderReveal", async () => {
    await revealEditsFolder();
    return ok();
  });
}
