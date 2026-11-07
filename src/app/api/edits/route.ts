/**
 * Edit projects (the Edit video view's documents).
 *
 * GET                     → EditList: every edit, newest first, and the files that could not be listed as edits
 * POST CreateEditRequest  → 201 { document }: a new edit, a duplicate, "Save as a new edit", or a separate copy
 */

import { handle, json, readJson } from "@/app/api/assets/_lib/http";
import { createEdit, listEdits } from "@/lib/edits/server";
import { EDIT_BODY_LIMIT } from "@/lib/edits/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request, "edits.list", async () => json(await listEdits()));
}

export async function POST(request: Request) {
  return handle(request, "edits.create", async () => {
    const document = await createEdit(await readJson(request, EDIT_BODY_LIMIT));
    return json({ document }, 201);
  });
}
