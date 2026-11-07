/**
 * One edit.
 *
 * GET                     → { document }
 * PUT SaveEditRequest     → { document }; 409 { error, code: "conflict", current } when it changed since baseUpdatedAt
 * PATCH PatchEditRequest  → { document, previousUpdatedAt }: rename (409 name_taken), or add a render
 * DELETE                  → { ok: true }: the file goes to the OS Trash
 */

import { handle, json, ok, pathParam, readJson } from "@/app/api/assets/_lib/http";
import { deleteEdit, editConflictOf, patchEdit, readEdit, saveEdit } from "@/lib/edits/server";
import { EDIT_BODY_LIMIT, EDIT_ID_PATTERN, type EditConflictBody } from "@/lib/edits/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const editId = async (params: RouteContext["params"]) => pathParam((await params).id, EDIT_ID_PATTERN, "edit id");

export async function GET(request: Request, { params }: RouteContext) {
  return handle(request, "edits.get", async () => json({ document: await readEdit(await editId(params)) }));
}

export async function PUT(request: Request, { params }: RouteContext) {
  return handle(request, "edits.save", async () => {
    const id = await editId(params);
    const body = await readJson(request, EDIT_BODY_LIMIT);
    try {
      return json({ document: await saveEdit(id, body) });
    } catch (error) {
      const current = editConflictOf(error);
      if (!current) throw error;
      const conflict: EditConflictBody = { error: (error as Error).message, code: "conflict", current };
      return json(conflict, 409);
    }
  });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  return handle(request, "edits.patch", async () => {
    const id = await editId(params);
    return json(await patchEdit(id, await readJson(request, EDIT_BODY_LIMIT)));
  });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  return handle(request, "edits.delete", async () => {
    await deleteEdit(await editId(params));
    return ok();
  });
}
