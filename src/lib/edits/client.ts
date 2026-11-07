/**
 * Typed client for the /api/edits routes.
 *
 * Every function rejects with `EditApiError` on a non-2xx answer (message =
 * the route's `{ error }`, `code` its code, `current` the stored edit on a
 * 409 conflict, `retryAfterMs` while the library is moving). A request that
 * never got an answer rejects with status 0; an aborted one with the
 * AbortError itself.
 */

import { parseRetryAfter } from "@/lib/assets/client/api";
import {
  EDIT_ROUTES,
  type CreateEditRequest,
  type EditDocument,
  type EditDocumentResponse,
  type EditList,
  type PatchEditRequest,
  type PatchEditResponse,
  type SaveEditRequest,
} from "./types";

export class EditApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    public readonly status: number,
    /** The route's `code`: "conflict", "not_found", "paused", "name_taken", … */
    public readonly code?: string,
    /** On a 409 conflict: the edit as it is stored now. */
    public readonly current?: EditDocument,
    /** From `Retry-After` (503 "paused" while the library is moving). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EditApiError";
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function toApiError(response: Response): Promise<EditApiError> {
  let message = "";
  let code: string | undefined;
  let current: EditDocument | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown; current?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string" && body.code) code = body.code;
    if (body.current && typeof body.current === "object") current = body.current as EditDocument;
  } catch {
    // Not JSON: the status line is all there is.
  }
  return new EditApiError(
    message || `${response.status} ${response.statusText ?? ""}`.trim(),
    response.status,
    code,
    current,
    parseRetryAfter(response.headers?.get?.("Retry-After") ?? null),
  );
}

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init });
  } catch (error) {
    if (isAbort(error) || init.signal?.aborted) throw error;
    throw new EditApiError("Couldn't reach Node Banana's server.", 0);
  }
  if (!response.ok) throw await toApiError(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new EditApiError("The server sent an unreadable answer.", response.status);
  }
}

function sendJson<T>(url: string, method: "POST" | "PUT" | "PATCH", body: unknown): Promise<T> {
  return send<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function fetchEditList(signal?: AbortSignal): Promise<EditList> {
  return send<EditList>(EDIT_ROUTES.list, { signal });
}

export async function fetchEdit(id: string, signal?: AbortSignal): Promise<EditDocument> {
  return (await send<EditDocumentResponse>(EDIT_ROUTES.edit(id), { signal })).document;
}

export async function createEdit(request: CreateEditRequest): Promise<EditDocument> {
  return (await sendJson<EditDocumentResponse>(EDIT_ROUTES.list, "POST", request)).document;
}

export async function saveEdit(id: string, request: SaveEditRequest): Promise<EditDocument> {
  return (await sendJson<EditDocumentResponse>(EDIT_ROUTES.edit(id), "PUT", request)).document;
}

export function patchEdit(id: string, request: PatchEditRequest): Promise<PatchEditResponse> {
  return sendJson<PatchEditResponse>(EDIT_ROUTES.edit(id), "PATCH", request);
}

export async function deleteEdit(id: string): Promise<void> {
  await send<unknown>(EDIT_ROUTES.edit(id), { method: "DELETE" });
}

export async function revealEdit(id: string): Promise<void> {
  await send<unknown>(EDIT_ROUTES.reveal(id), { method: "POST" });
}

export async function revealEditsFolder(): Promise<void> {
  await send<unknown>(EDIT_ROUTES.folderReveal, { method: "POST" });
}
