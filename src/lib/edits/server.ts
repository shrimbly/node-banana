/**
 * Edit files on disk: `<library root>/Edits/<name>.nbedit`, one JSON
 * document per edit (see ./types.ts). The /api/edits routes call only this
 * module.
 *
 * Reads find the active root with `libraryRootForRead`; every write runs
 * inside `writeInLibraryRoot`, so it is refused while a library move copies
 * and a move waits for it. A listing never writes: two servers (the desktop
 * app and a dev server) can share one library, and both would rewrite the
 * same file. A file copied in Finder carries its original's id; the list
 * shows it as a "duplicate" problem until `createEdit({ separate })` gives
 * it an id of its own.
 *
 * Writes are serialised per process: one lock per edit id, and one ("names")
 * held by everything that picks or changes a file name. The `updatedAt`
 * check stops a save from another window of this server overwriting newer
 * work; two servers saving one edit at the same moment are not serialised,
 * and the later write wins.
 */

import { randomInt } from "crypto";
import type { Dirent } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { getAsset, LibraryError, libraryRootForRead, writeInLibraryRoot } from "@/lib/assets/server";
import { openFolder, revealFile, trashFiles, type TrashOptions } from "@/lib/assets/server/desktop";
import { errnoCode } from "@/lib/assets/server/errors";
import { atomicWriteFile, KeyedMutex, mapConcurrent, renameWithRetry } from "@/lib/assets/server/fsutil";
import { sanitiseFolderName } from "@/lib/assets/server/known";
import { EDITS_DIR } from "@/lib/assets/server/layout";
import {
  containsMediaString,
  copyName,
  emptyEditSequence,
  firstFreeName,
  mergeEditRenders,
  normalizeEditName,
  parseEditDocument,
  readRender,
  sanitizeEditAssets,
  sanitizeEditMedia,
  sanitizeEditSequence,
  sanitizeEditSummary,
  type ParsedEdit,
} from "./document";
import {
  EDIT_BODY_LIMIT,
  EDIT_FILE_EXT,
  EDIT_ID_PATTERN,
  EDIT_KIND,
  EDIT_VERSION,
  type CreateEditRequest,
  type EditDocument,
  type EditList,
  type EditListProblem,
  type EditRender,
  type EditSequence,
  type EditSummary,
  type PatchEditRequest,
  type PatchEditResponse,
  type SaveEditRequest,
} from "./types";

export interface EditsDeps {
  now?: () => number;
  trash?: (file: string) => Promise<unknown>;
  reveal?: (file: string) => Promise<void>;
  openFolder?: (dir: string) => Promise<void>;
}

/** A save whose base is not the stored edit's `updatedAt`; the route answers 409 with `current`. */
export class EditConflictError extends LibraryError {
  constructor(public readonly current: EditDocument) {
    super("This edit was changed in another window.", 409, "conflict");
  }
}

/** The stored edit a conflict carries, by shape (the class can be loaded twice in dev). */
export function editConflictOf(error: unknown): EditDocument | null {
  if (!(error instanceof Error) || (error as Partial<LibraryError>).code !== "conflict") return null;
  const current = (error as Partial<EditConflictError>).current;
  return current && typeof current === "object" ? current : null;
}

const MEDIA_REFUSED = "Edits hold media by library id only.";
const NAMES_LOCK = "names";
const READ_CONCURRENCY = 8;
const POSTER_CONCURRENCY = 8;

/* Runtime ------------------------------------------------------------- */

interface CachedFile {
  stamp: string;
  parsed: ParsedEdit;
}

interface EditsRuntime {
  locks: KeyedMutex;
  /** Parsed files by absolute path, reused while the file's inode, mtime and size are unchanged. */
  files: Map<string, CachedFile>;
}

const globalState = globalThis as typeof globalThis & { __nodeBananaEdits?: EditsRuntime };

/** On globalThis, so Next's per-route module copies share one set of locks. */
function runtime(): EditsRuntime {
  globalState.__nodeBananaEdits ??= { locks: new KeyedMutex(), files: new Map() };
  return globalState.__nodeBananaEdits;
}

async function withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of keys) releases.push(await runtime().locks.acquire(key));
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

const idLock = (id: string) => `id:${id}`;

/* Files --------------------------------------------------------------- */

interface EditFile {
  fileName: string;
  file: string;
  mtimeMs: number;
  parsed: ParsedEdit;
}

interface StoredEdit extends EditFile {
  document: EditDocument;
}

interface EditsFolder {
  dir: string;
  /** Every edit file in the folder, readable or not. */
  files: EditFile[];
  edits: Map<string, StoredEdit>;
  problems: EditListProblem[];
}

function editsDir(root: string): string {
  return path.join(root, EDITS_DIR);
}

/** The file an edit called `name` lives in. */
export function editFileName(name: string): string {
  return `${sanitiseFolderName(name)}${EDIT_FILE_EXT}`;
}

/** File names compare case-insensitively, so a library can move to any disk. */
function fileKey(fileName: string): string {
  return fileName.normalize("NFC").toLowerCase();
}

function isEditFileName(name: string): boolean {
  return !name.startsWith(".") && name.toLowerCase().endsWith(EDIT_FILE_EXT);
}

async function readEditFile(dir: string, fileName: string): Promise<EditFile | null> {
  const file = path.join(dir, fileName);
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  // Every write is a new file renamed into place, so a new inode marks a rewrite even within one mtime tick.
  const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  const cache = runtime().files;
  let cached = cache.get(file);
  if (cached?.stamp !== stamp) {
    let parsed: ParsedEdit = { ok: false, problem: "unreadable", name: null, id: null };
    if (stat.size <= EDIT_BODY_LIMIT) {
      try {
        parsed = parseEditDocument(JSON.parse(await fs.readFile(file, "utf8")));
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return null;
      }
    }
    cached = { stamp, parsed };
    cache.set(file, cached);
  }
  return { fileName, file, mtimeMs: stat.mtimeMs, parsed: cached.parsed };
}

/**
 * The folder's edits by id, and its problems. Of the files sharing an id, the edit is the one whose file name its
 * name gives, else the earliest modified (ties: file name order); the others are duplicates.
 */
async function readFolder(dir: string): Promise<EditsFolder> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  const names = entries.filter((entry) => entry.isFile() && isEditFileName(entry.name)).map((entry) => entry.name);
  const files = (await mapConcurrent(names, READ_CONCURRENCY, (name) => readEditFile(dir, name))).filter(
    (file): file is EditFile => file !== null,
  );
  const seen = new Set(files.map((file) => file.file));
  const cache = runtime().files;
  for (const key of cache.keys()) if (path.dirname(key) === dir && !seen.has(key)) cache.delete(key);

  const problems: EditListProblem[] = [];
  const byId = new Map<string, StoredEdit[]>();
  for (const file of files) {
    if (!file.parsed.ok) {
      problems.push({ fileName: file.fileName, problem: file.parsed.problem, name: file.parsed.name });
      continue;
    }
    const stored = { ...file, document: file.parsed.document };
    byId.set(stored.document.id, [...(byId.get(stored.document.id) ?? []), stored]);
  }
  const edits = new Map<string, StoredEdit>();
  for (const [id, group] of byId) {
    const named = (f: StoredEdit) => (fileKey(f.fileName) === fileKey(editFileName(f.document.name)) ? 0 : 1);
    group.sort((a, b) => named(a) - named(b) || a.mtimeMs - b.mtimeMs || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
    edits.set(id, group[0]);
    for (const copy of group.slice(1)) problems.push({ fileName: copy.fileName, problem: "duplicate", name: copy.document.name });
  }
  problems.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { dir, files, edits, problems };
}

/** The edit's stored file, or why there is none to use: 404, or 422 for a file of that id this build can't read. */
function requireEdit(folder: EditsFolder, id: string): StoredEdit {
  const edit = folder.edits.get(id);
  if (edit) return edit;
  const other = folder.files.find((file) => !file.parsed.ok && file.parsed.id === id);
  if (other && !other.parsed.ok) {
    throw other.parsed.problem === "newer"
      ? new LibraryError("This edit was saved by a newer version of Node Banana.", 422, "newer_version")
      : new LibraryError("This edit's file can't be read.", 422, "unreadable");
  }
  throw new LibraryError("This edit is no longer in the Edits folder.", 404, "not_found");
}

async function writeDocument(file: string, document: EditDocument): Promise<void> {
  if (containsMediaString(document)) throw new LibraryError(MEDIA_REFUSED, 400, "bad_request");
  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(json) > EDIT_BODY_LIMIT) throw new LibraryError("This edit is too large to save.", 413, "too_large");
  await fs.mkdir(path.dirname(file), { recursive: true });
  // An 80-character name in CJK is 240 bytes: the usual "<file>.<uuid>.tmp" would pass ext4's 255
  await atomicWriteFile(file, json, { fsync: true, shortTemp: true });
}

/**
 * Renames the edit's file to the one its name gives, when that is free (or differs only in case, which goes through
 * an intermediate name: some case-folding disks take a case-only rename as a no-op). Returns the file name it has now.
 */
async function followName(folder: EditsFolder, edit: StoredEdit, name: string): Promise<string> {
  const target = editFileName(name);
  if (target === edit.fileName) return edit.fileName;
  const caseOnly = fileKey(target) === fileKey(edit.fileName);
  if (!caseOnly) {
    if (folder.files.some((file) => file.file !== edit.file && fileKey(file.fileName) === fileKey(target))) return edit.fileName;
    try {
      await fs.lstat(path.join(folder.dir, target));
      return edit.fileName;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") return edit.fileName;
    }
    await renameWithRetry(edit.file, path.join(folder.dir, target));
    return target;
  }
  // Still an edit file in between, so a stop part-way leaves it listed (and the next save names it again).
  const between = path.join(folder.dir, `${edit.document.id}.renaming${EDIT_FILE_EXT}`);
  await renameWithRetry(edit.file, between);
  await renameWithRetry(between, path.join(folder.dir, target));
  return target;
}

function newEditId(now: number): string {
  let random = "";
  for (let i = 0; i < 10; i++) random += randomInt(36).toString(36);
  return `ed${now.toString(36)}${random}`;
}

/** Strictly increasing per file, even when the clock steps back. */
function nextUpdatedAt(now: number, previous: number): number {
  return Math.max(now, previous + 1);
}

function clock(deps: EditsDeps): number {
  return (deps.now ?? Date.now)();
}

/* Requests ------------------------------------------------------------ */

const badRequest = (message: string) => new LibraryError(message, 400, "bad_request");

function fieldsOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("The request must be a JSON object.");
  if (containsMediaString(raw)) throw badRequest(MEDIA_REFUSED);
  return raw as Record<string, unknown>;
}

function optionalObject(value: unknown, label: string): void {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw badRequest(`Invalid ${label}.`);
}

/** Strings that are not asset ids are dropped when the document is built (sanitizeEditMedia). */
function optionalMedia(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== "string"))) throw badRequest("Invalid media.");
}

export function checkEditId(id: unknown): string {
  if (typeof id !== "string" || !EDIT_ID_PATTERN.test(id)) throw badRequest("Invalid edit id.");
  return id;
}

export function parseCreateRequest(raw: unknown): CreateEditRequest {
  const fields = fieldsOf(raw);
  const { name, from, sequence, media, assets, summary, separate } = fields;
  if (separate !== undefined) {
    if (
      typeof separate !== "string" ||
      path.basename(separate) !== separate ||
      separate.includes("\\") ||
      !isEditFileName(separate) ||
      Object.keys(fields).length !== 1
    ) {
      throw badRequest("Name one edit file to make separate, and nothing else.");
    }
    return { separate };
  }
  if (name !== undefined && typeof name !== "string") throw badRequest("Invalid name.");
  if (from !== undefined) checkEditId(from);
  optionalObject(sequence, "sequence");
  optionalMedia(media);
  optionalObject(assets, "assets");
  optionalObject(summary, "summary");
  if (from !== undefined && sequence !== undefined) throw badRequest("Send from or sequence, not both.");
  if (from !== undefined && media !== undefined) throw badRequest("Send from or media, not both.");
  return fields as CreateEditRequest;
}

export function parseSaveRequest(raw: unknown): SaveEditRequest {
  const fields = fieldsOf(raw);
  if (typeof fields.baseUpdatedAt !== "number" || !Number.isFinite(fields.baseUpdatedAt)) throw badRequest("Invalid baseUpdatedAt.");
  if (fields.force !== undefined && typeof fields.force !== "boolean") throw badRequest("Invalid force.");
  if (!fields.sequence || typeof fields.sequence !== "object" || Array.isArray(fields.sequence)) throw badRequest("Invalid sequence.");
  optionalMedia(fields.media);
  optionalObject(fields.assets, "assets");
  optionalObject(fields.summary, "summary");
  if (fields.renders !== undefined && !Array.isArray(fields.renders)) throw badRequest("Invalid renders.");
  return fields as unknown as SaveEditRequest;
}

export function parsePatchRequest(raw: unknown): PatchEditRequest {
  const fields = fieldsOf(raw);
  if (fields.op === "rename" && typeof fields.name === "string") return { op: "rename", name: fields.name };
  if (fields.op === "addRender") {
    const render = readRender(fields.render);
    if (render) return { op: "addRender", render };
  }
  throw badRequest("Invalid edit change.");
}

/* Reads --------------------------------------------------------------- */

async function posterOf(assetId: string | null): Promise<EditSummary["poster"]> {
  if (!assetId) return null;
  try {
    const asset = await getAsset(assetId);
    return asset ? { sha256: asset.sha256, hasPoster: asset.hasPoster === true } : null;
  } catch {
    return null;
  }
}

/** Every edit, newest first, with the files that could not be listed as edits. Reads only. */
export async function listEdits(): Promise<EditList> {
  const dir = editsDir(await libraryRootForRead());
  const folder = await readFolder(dir);
  const stored = [...folder.edits.values()].sort(
    (a, b) => b.document.updatedAt - a.document.updatedAt || a.document.name.localeCompare(b.document.name),
  );
  const posters = await mapConcurrent(stored, POSTER_CONCURRENCY, (edit) => posterOf(edit.document.summary.posterAssetId));
  const edits = stored.map(({ document, fileName }, index): EditSummary => ({
    ...document.summary,
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    renderCount: document.renders.length,
    fileName,
    poster: posters[index],
  }));
  return { edits, problems: folder.problems, folder: dir };
}

export async function readEdit(id: string): Promise<EditDocument> {
  const editId = checkEditId(id);
  const folder = await readFolder(editsDir(await libraryRootForRead()));
  return requireEdit(folder, editId).document;
}

/* Writes -------------------------------------------------------------- */

/** A new edit; a duplicate (`from`); "Save as a new edit" (`sequence`); or a fresh id for a copied file (`separate`). */
export async function createEdit(raw: unknown, deps: EditsDeps = {}): Promise<EditDocument> {
  const request = parseCreateRequest(raw);
  if (request.separate !== undefined) return separateEdit(request.separate, deps);
  return withLocks([NAMES_LOCK], () =>
    writeInLibraryRoot(async (root) => {
      const now = clock(deps);
      const folder = await readFolder(editsDir(root));
      let base: { name: string; sequence: EditSequence; media: unknown; assets: unknown; summary: unknown };
      if (request.from !== undefined) {
        const source = requireEdit(folder, request.from).document;
        base = {
          name: copyName(source.name),
          sequence: source.sequence,
          media: source.media,
          assets: source.assets,
          summary: source.summary,
        };
      } else {
        const sequence = request.sequence ? sanitizeEditSequence(request.sequence) : emptyEditSequence();
        base = {
          name: normalizeEditName(request.name ?? ""),
          sequence,
          media: request.media,
          assets: request.assets,
          summary: request.summary,
        };
      }
      const media = sanitizeEditMedia(base.media, base.sequence);
      const taken = new Set(folder.files.map((file) => fileKey(file.fileName)));
      const name = firstFreeName(base.name, taken, (candidate) => fileKey(editFileName(candidate)));
      const ids = new Set(folder.files.map((file) => (file.parsed.ok ? file.parsed.document.id : file.parsed.id)));
      let id = newEditId(now);
      while (ids.has(id)) id = newEditId(now);
      const document: EditDocument = {
        kind: EDIT_KIND,
        version: EDIT_VERSION,
        id,
        name,
        createdAt: now,
        updatedAt: now,
        sequence: base.sequence,
        media,
        assets: sanitizeEditAssets(base.assets, media),
        renders: [],
        summary: sanitizeEditSummary(base.summary, base.sequence),
      };
      await writeDocument(path.join(folder.dir, editFileName(name)), document);
      return document;
    }),
  );
}

/**
 * "Make it a separate edit": a file listed as a duplicate gets a fresh id, and the name its file has, so the list can
 * tell it from the edit it was copied from. 409 `not_duplicate` once it is no longer a duplicate.
 */
async function separateEdit(fileName: string, deps: EditsDeps): Promise<EditDocument> {
  return withLocks([NAMES_LOCK], () =>
    writeInLibraryRoot(async (root) => {
      const folder = await readFolder(editsDir(root));
      const file = folder.files.find((candidate) => candidate.fileName === fileName);
      if (!file) throw new LibraryError("That file is no longer in the Edits folder.", 404, "not_found");
      const duplicate = folder.problems.some((problem) => problem.problem === "duplicate" && problem.fileName === fileName);
      if (!duplicate || !file.parsed.ok) {
        throw new LibraryError("That file is no longer a copy of another edit.", 409, "not_duplicate");
      }
      const previous = file.parsed.document;
      const taken = new Set(folder.files.filter((other) => other !== file).map((other) => fileKey(other.fileName)));
      const name = firstFreeName(normalizeEditName(fileName.slice(0, -EDIT_FILE_EXT.length)), taken, (candidate) =>
        fileKey(editFileName(candidate)),
      );
      const ids = new Set([...folder.edits.keys()]);
      let id = newEditId(clock(deps));
      while (ids.has(id)) id = newEditId(clock(deps));
      const document: EditDocument = { ...previous, id, name, updatedAt: nextUpdatedAt(clock(deps), previous.updatedAt) };
      await writeDocument(file.file, document);
      await followName(folder, { ...file, document }, name);
      return document;
    }),
  );
}

/**
 * Saves the sequence and the media (a save without media keeps the stored media). 409 (with `current`) when the
 * stored edit is not the one the save is based on, unless `force`.
 */
export async function saveEdit(id: string, raw: unknown, deps: EditsDeps = {}): Promise<EditDocument> {
  const editId = checkEditId(id);
  const request = parseSaveRequest(raw);
  return withLocks([idLock(editId), NAMES_LOCK], () =>
    writeInLibraryRoot(async (root) => {
      const folder = await readFolder(editsDir(root));
      const edit = requireEdit(folder, editId);
      const current = edit.document;
      if (request.force !== true && current.updatedAt !== request.baseUpdatedAt) throw new EditConflictError(current);
      const sequence = sanitizeEditSequence(request.sequence);
      const media = sanitizeEditMedia(request.media ?? current.media, sequence);
      const document: EditDocument = {
        ...current,
        sequence,
        media,
        assets: sanitizeEditAssets(request.assets, media),
        summary: sanitizeEditSummary(request.summary, sequence),
        renders: mergeEditRenders(current.renders, request.renders ?? []),
        updatedAt: nextUpdatedAt(clock(deps), current.updatedAt),
      };
      await writeDocument(edit.file, document);
      // Repairs a rename that stopped between writing the name and renaming the file.
      await followName(folder, edit, document.name);
      return document;
    }),
  );
}

export async function patchEdit(id: string, raw: unknown, deps: EditsDeps = {}): Promise<PatchEditResponse> {
  const editId = checkEditId(id);
  const request = parsePatchRequest(raw);
  if (request.op === "addRender") return addRender(editId, request.render);
  return withLocks([idLock(editId), NAMES_LOCK], () =>
    writeInLibraryRoot(async (root) => {
      const folder = await readFolder(editsDir(root));
      const edit = requireEdit(folder, editId);
      const current = edit.document;
      const name = normalizeEditName(request.name);
      const target = fileKey(editFileName(name));
      if (folder.files.some((file) => file.file !== edit.file && fileKey(file.fileName) === target)) {
        throw new LibraryError(`Another edit is already called “${name}”.`, 409, "name_taken");
      }
      if (name === current.name && edit.fileName === editFileName(name)) return { document: current, previousUpdatedAt: current.updatedAt };
      const document: EditDocument = { ...current, name, updatedAt: nextUpdatedAt(clock(deps), current.updatedAt) };
      await writeDocument(edit.file, document);
      await followName(folder, edit, name);
      return { document, previousUpdatedAt: current.updatedAt };
    }),
  );
}

/** Adds a render. Never a conflict, and never changes updatedAt, so it can't make the next save look like one. */
async function addRender(id: string, render: EditRender): Promise<PatchEditResponse> {
  return withLocks([idLock(id)], () =>
    writeInLibraryRoot(async (root) => {
      const edit = requireEdit(await readFolder(editsDir(root)), id);
      const current = edit.document;
      if (current.renders.some((stored) => stored.assetId === render.assetId)) {
        return { document: current, previousUpdatedAt: current.updatedAt };
      }
      const document: EditDocument = { ...current, renders: mergeEditRenders(current.renders, [render]) };
      await writeDocument(edit.file, document);
      return { document, previousUpdatedAt: current.updatedAt };
    }),
  );
}

/**
 * Sends an edit's file to the OS Trash, never unlinking it: an edit has no trash in the app, so the OS Trash is its
 * only way back. Throws trash_failed, the file kept, when no route moved it.
 */
export async function trashEditFile(file: string, options: TrashOptions = {}): Promise<void> {
  if ((await trashFiles([file], { ...options, unlinkFallback: false })).has(file)) return;
  throw new LibraryError("Couldn't move the edit to the Trash.", 500, "trash_failed");
}

/** Sends the edit's file to the OS Trash. Its renders stay in the library. */
export async function deleteEdit(id: string, deps: EditsDeps = {}): Promise<void> {
  const editId = checkEditId(id);
  await withLocks([idLock(editId)], () =>
    writeInLibraryRoot(async (root) => {
      const edit = requireEdit(await readFolder(editsDir(root)), editId);
      await (deps.trash ?? trashEditFile)(edit.file);
      runtime().files.delete(edit.file);
    }),
  );
}

/** Shows the edit's file in Finder or Explorer. */
export async function revealEdit(id: string, deps: EditsDeps = {}): Promise<void> {
  const editId = checkEditId(id);
  const edit = requireEdit(await readFolder(editsDir(await libraryRootForRead())), editId);
  await (deps.reveal ?? revealFile)(edit.file);
}

/** Opens the Edits folder, creating it first (a library write, so refused while a move copies). */
export async function revealEditsFolder(deps: EditsDeps = {}): Promise<void> {
  const dir = await writeInLibraryRoot(async (root) => {
    const folder = editsDir(root);
    await fs.mkdir(folder, { recursive: true });
    return folder;
  });
  await (deps.openFolder ?? openFolder)(dir);
}

/** Forgets the parsed-file cache (tests). */
export function __resetEditsForTests(): void {
  delete globalState.__nodeBananaEdits;
}
