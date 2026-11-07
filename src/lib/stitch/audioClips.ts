import { ASSET_ID_PATTERN } from "@/lib/assets/types";
import type { StitchAudioClip, StitchAudioSource, VideoStitchNodeData, VolumePoint } from "@/types";
import type { ClipboardAudioItem } from "./clipboard";
import { fadeInRange, fadeOutRange, followEndFade, gainAt, sameCurve, sortCurve } from "./curve";
import { counted } from "./labels";
import { END_EPSILON_SEC, MAX_START_SEC } from "./timeline";

/**
 * The Edit Video node's audio clips: the music on the `audio` socket and
 * library audio, each a clip on an audio row. Every edit is a pure recipe
 * over the clips, which the editor's actions wrap and apply once.
 *
 * Rows are numbered from 0 and the list is kept sorted by row, then start,
 * then id. A move never removes a row (an emptied row stays until a removal,
 * a read or a write compacts the rows), so nothing jumps after a release.
 * A clip's curve is in its source seconds, the clock of its In and Out.
 */

export type AudioSourceKey = "music" | `asset:${string}`;
export type AudioDurations = ReadonlyMap<AudioSourceKey, number>;
/** A clip's trimmed length for drawing and overlap checks: decoded, else from the record, else Infinity. */
export type AudioLengthOf = (clip: StitchAudioClip) => number;
/** Row map of a recipe that renumbers rows: rowMap[oldRow] = newRow, or null for a row that is gone. */
export type AudioRowMap = (number | null)[];

export const MUSIC_CLIP_ID = "audio:music";
/** Splits are refused this close to a clip's ends, and trims keep a clip at least this long. */
export const MIN_AUDIO_CLIP_SEC = 0.1;
/** Overlaps shorter than this are float noise, not overlaps. */
const OVERLAP_EPS = 1e-9;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function audioSourceKey(source: StitchAudioSource): AudioSourceKey {
  return source.kind === "music" ? "music" : `asset:${source.assetId}`;
}

export function newAudioClipId(): string {
  return `aclip_${crypto.randomUUID().slice(0, 8)}`;
}

export function createAudioClip(
  source: StitchAudioSource,
  init: Partial<Omit<StitchAudioClip, "source">> = {},
): StitchAudioClip {
  return {
    id: init.id ?? newAudioClipId(),
    source,
    row: init.row ?? 0,
    startSec: init.startSec ?? 0,
    inSec: init.inSec ?? 0,
    outSec: init.outSec ?? null,
    muted: init.muted ?? false,
    curve: init.curve ?? [],
  };
}

function readAudioSource(raw: unknown, allowMusic: boolean): StitchAudioSource | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (source.kind === "music") return allowMusic ? { kind: "music" } : null;
  // Asset ids become /api/assets/<id> URLs: a crafted id must not reach another route
  if (source.kind === "asset" && typeof source.assetId === "string" && ASSET_ID_PATTERN.test(source.assetId)) {
    return { kind: "asset", assetId: source.assetId };
  }
  return null;
}

/**
 * Drops entries without a string id or a valid source (music only when opts.allowMusic !== false). row: integer >= 0,
 * else 0. startSec: finite, clamped 0..MAX_START_SEC, else 0. inSec: finite >= 0, else 0. outSec: finite > inSec, else
 * null. muted: === true. curve: sortCurve. A repeated id gets `${id}~2`… Sorted, rows compacted.
 */
export function sanitizeAudioClips(raw: unknown, opts: { allowMusic?: boolean } = {}): StitchAudioClip[] {
  if (!Array.isArray(raw)) return [];
  const allowMusic = opts.allowMusic !== false;
  const clips: StitchAudioClip[] = [];
  const ids = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const clip = entry as Record<string, unknown>;
    const source = readAudioSource(clip.source, allowMusic);
    if (typeof clip.id !== "string" || !clip.id || !source) continue;
    let id = clip.id;
    for (let n = 2; ids.has(id); n++) id = `${clip.id}~${n}`;
    ids.add(id);
    const inSec = finite(clip.inSec) && clip.inSec >= 0 ? clip.inSec : 0;
    clips.push({
      id,
      source,
      row: Number.isInteger(clip.row) && (clip.row as number) >= 0 ? (clip.row as number) : 0,
      startSec: finite(clip.startSec) ? clamp(clip.startSec, 0, MAX_START_SEC) : 0,
      inSec,
      outSec: finite(clip.outSec) && clip.outSec > inSec ? clip.outSec : null,
      muted: clip.muted === true,
      curve: sortCurve(clip.curve as VolumePoint[] | undefined),
    });
  }
  return compactAudioRows(normalizeAudioClips(clips)).clips;
}

function audioOrder(a: StitchAudioClip, b: StitchAudioClip): number {
  return a.row - b.row || a.startSec - b.startSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Sorted by row, start, id. Rows are not renumbered. The same array when already sorted. */
export function normalizeAudioClips(clips: readonly StitchAudioClip[]): StitchAudioClip[] {
  const sorted = clips.every((clip, i) => i === 0 || audioOrder(clips[i - 1], clip) <= 0);
  return sorted ? (clips as StitchAudioClip[]) : [...clips].sort(audioOrder);
}

/** Rows renumbered 0..R−1 in their order, empty ones dropped. The same array when no row changes. */
export function compactAudioRows(clips: readonly StitchAudioClip[]): { clips: StitchAudioClip[]; rowMap: AudioRowMap } {
  const used = [...new Set(clips.map((clip) => clip.row))].sort((a, b) => a - b);
  const rowMap: AudioRowMap = Array.from({ length: audioRowCount(clips) }, () => null);
  used.forEach((row, i) => (rowMap[row] = i));
  if (used.every((row, i) => row === i)) return { clips: clips as StitchAudioClip[], rowMap };
  return { clips: clips.map((clip) => ({ ...clip, row: rowMap[clip.row]! })), rowMap };
}

/** Highest row + 1 (empty rows included), 0 for no clips. */
export function audioRowCount(clips: readonly StitchAudioClip[]): number {
  return clips.reduce((count, clip) => Math.max(count, clip.row + 1), 0);
}

const identityRows = (count: number): AudioRowMap => Array.from({ length: count }, (_, row) => row);

/** Rows after `after` move down by `count` (rows inserted under it). */
const insertedRows = (rowCount: number, after: number, count: number): AudioRowMap =>
  Array.from({ length: rowCount }, (_, row) => (row <= after ? row : row + count));

/** A node read as legacy audio: no audioClips array. Read time only; whether it encodes as legacy is the shape's. */
export function isLegacyAudio(data: Pick<VideoStitchNodeData, "audioClips">): boolean {
  return !Array.isArray(data.audioClips);
}

/** The music as a node without audioClips plays it: whole, from 0:00, on row 0. */
export function legacyMusicClip(curve: VolumePoint[], muted: boolean): StitchAudioClip {
  return createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, curve, muted });
}

/** Music, start 0, In 0, Out null (any row): how the music plays when the node keeps no audioClips. */
export function isUntouchedMusic(clip: StitchAudioClip): boolean {
  return clip.source.kind === "music" && clip.startSec === 0 && clip.inSec === 0 && clip.outSec === null;
}

/**
 * Audio that a node without audioClips can hold: none, or one untouched music clip (its curve and mute may be
 * anything). Rows are compacted first, so a lone clip on row 1 counts.
 */
export function isLegacyAudioShape(clips: readonly StitchAudioClip[]): boolean {
  return clips.length === 0 || (clips.length === 1 && isUntouchedMusic(clips[0]));
}

/**
 * What Done writes to audioCurve and audioMuted beside audioClips, for builds from before audio clips (they ignore
 * audioClips): an untouched music clip's curve and mute, else muted.
 */
export function legacyCopy(clips: readonly StitchAudioClip[]): { audioCurve: VolumePoint[]; audioMuted: boolean } {
  const music = clips.find(isUntouchedMusic);
  return music ? { audioCurve: music.curve, audioMuted: music.muted } : { audioCurve: [], audioMuted: true };
}

export function hasMusicClip(clips: readonly StitchAudioClip[]): boolean {
  return clips.some((clip) => clip.source.kind === "music");
}

/**
 * Music connected and no music clip: one is added on row 0 (whole, flat, unmuted; id MUSIC_CLIP_ID unless taken) and
 * every other clip moves down a row. Never drops anything. The same array when nothing changes.
 */
export function reconcileMusicClip(clips: StitchAudioClip[], hasMusic: boolean): StitchAudioClip[] {
  if (!hasMusic || hasMusicClip(clips)) return clips;
  const ids = new Set(clips.map((clip) => clip.id));
  let id = MUSIC_CLIP_ID;
  while (ids.has(id)) id = newAudioClipId();
  return [createAudioClip({ kind: "music" }, { id }), ...clips.map((clip) => ({ ...clip, row: clip.row + 1 }))];
}

/** Every music clip removed, rows compacted. The same array when there was none. */
export function dropMusicClips(clips: StitchAudioClip[]): StitchAudioClip[] {
  if (!hasMusicClip(clips)) return clips;
  return compactAudioRows(clips.filter((clip) => clip.source.kind !== "music")).clips;
}

/** The trimmed length: min(out ?? D, D) − min(in, D); 0 when D is unknown. Not rounded to frames: audio is per sample. */
export function audioClipLength(clip: StitchAudioClip, duration: number | undefined): number {
  if (duration === undefined || !Number.isFinite(duration)) return 0;
  return Math.max(0, Math.min(clip.outSec ?? duration, duration) - Math.min(clip.inSec, duration));
}

/** The lengthOf overlap checks use: the decoded length, else the record's, else Infinity (never placed over). */
export function audioLengthOf(
  durations: AudioDurations,
  recordSec: (clip: StitchAudioClip) => number | null,
): AudioLengthOf {
  return (clip) => {
    const decoded = durations.get(audioSourceKey(clip.source));
    if (decoded !== undefined && Number.isFinite(decoded)) return audioClipLength(clip, decoded);
    const record = recordSec(clip);
    return record !== null && Number.isFinite(record) ? audioClipLength(clip, record) : Infinity;
  };
}

export interface AudioSpan {
  clip: StitchAudioClip;
  start: number;
  end: number;
  length: number;
  row: number;
}

/** For drawing: an unknown length is 0 here. */
export function audioSpans(clips: readonly StitchAudioClip[], durations: AudioDurations): AudioSpan[] {
  return clips.map((clip) => {
    const length = audioClipLength(clip, durations.get(audioSourceKey(clip.source)));
    return { clip, start: clip.startSec, end: clip.startSec + length, length, row: clip.row };
  });
}

/** The part one loop plays, in source seconds: [in, in + min(length, loopSec − start)); null when nothing is heard. */
export function heardRange(span: AudioSpan, loopSec: number): { fromSrc: number; toSrc: number } | null {
  const length = Math.min(span.length, loopSec - span.start);
  if (!(length > 0)) return null;
  return { fromSrc: span.clip.inSec, toSrc: span.clip.inSec + length };
}

/** Whether [start, start + length) overlaps a clip on `row`, the clips in `ignore` aside. An Infinity length overlaps all after it. */
export function overlapsOnRow(
  clips: readonly StitchAudioClip[],
  lengthOf: AudioLengthOf,
  row: number,
  start: number,
  length: number,
  ignore: ReadonlySet<string>,
): boolean {
  return clips.some(
    (clip) =>
      clip.row === row &&
      !ignore.has(clip.id) &&
      clip.startSec < start + length - OVERLAP_EPS &&
      start < clip.startSec + lengthOf(clip) - OVERLAP_EPS,
  );
}

/**
 * A move of one or several clips: each id gets start + deltaSec and row + deltaRow, clamped so the group keeps its
 * spacing (the earliest start >= 0, the latest <= MAX_START_SEC, the top row >= 0, the bottom row at most one past
 * the last: a new row appended through the strip). When any moved clip would overlap an unmoved one on its target
 * row, the whole group goes onto new rows inserted under the lowest target row (insertedAfter), keeping its row
 * spacing. Rows are never compacted. The same array when nothing changes.
 */
export function moveAudioClips(
  clips: StitchAudioClip[],
  lengthOf: AudioLengthOf,
  ids: readonly string[],
  deltaSec: number,
  deltaRow: number,
): { clips: StitchAudioClip[]; rowMap: AudioRowMap; newRow: boolean; insertedAfter: number | null } {
  const rowCount = audioRowCount(clips);
  const moving = new Set(ids);
  const moved = clips.filter((clip) => moving.has(clip.id));
  const unchanged = { clips, rowMap: identityRows(rowCount), newRow: false, insertedAfter: null };
  if (moved.length === 0) return unchanged;
  const starts = moved.map((clip) => clip.startSec);
  const rows = moved.map((clip) => clip.row);
  const dt = clamp(finite(deltaSec) ? deltaSec : 0, -Math.min(...starts), MAX_START_SEC - Math.max(...starts));
  const dr = clamp(finite(deltaRow) ? Math.round(deltaRow) : 0, -Math.min(...rows), rowCount - Math.max(...rows));
  if (dt === 0 && dr === 0) return unchanged;

  const target = (clip: StitchAudioClip) => ({ row: clip.row + dr, start: clip.startSec + dt });
  const blocked = moved.some((clip) => {
    const to = target(clip);
    return overlapsOnRow(clips, lengthOf, to.row, to.start, lengthOf(clip), moving);
  });
  if (!blocked) {
    const next = clips.map((clip) => (moving.has(clip.id) ? { ...clip, ...rowAndStart(target(clip)) } : clip));
    return {
      clips: normalizeAudioClips(next),
      rowMap: identityRows(rowCount),
      newRow: moved.some((clip) => target(clip).row >= rowCount),
      insertedAfter: null,
    };
  }
  const top = Math.min(...rows) + dr;
  // A group reaching the append slot goes in under the last row, leaving no empty row that never existed
  const after = Math.min(Math.max(...rows) + dr, rowCount - 1);
  const span = Math.max(...rows) - Math.min(...rows) + 1;
  const next = clips.map((clip) => {
    if (moving.has(clip.id)) return { ...clip, row: after + 1 + (clip.row + dr - top), startSec: clip.startSec + dt };
    return clip.row > after ? { ...clip, row: clip.row + span } : clip;
  });
  return {
    clips: normalizeAudioClips(next),
    rowMap: insertedRows(rowCount, after, span),
    newRow: true,
    insertedAfter: after,
  };
}

const rowAndStart = (to: { row: number; start: number }) => ({ row: to.row, startSec: to.start });

/** The clip before and after `clip` on its row (by start), its own id aside. */
function rowNeighbours(clips: readonly StitchAudioClip[], clip: StitchAudioClip) {
  const others = clips.filter((c) => c.row === clip.row && c.id !== clip.id);
  const before = others.filter((c) => c.startSec <= clip.startSec);
  const after = others.filter((c) => c.startSec > clip.startSec);
  return {
    previous: before.length > 0 ? before[before.length - 1] : undefined,
    next: after.length > 0 ? after[0] : undefined,
  };
}

/**
 * Trims one clip with its sound fixed in time: an In edge moves the start by the change (never before 0:00, so In is
 * raised to at least in − start), an Out edge keeps it. Length kept >= MIN_AUDIO_CLIP_SEC; Out <= the source's length;
 * neither edge passes a neighbour on its row. An Out at the source's end (within END_EPSILON_SEC) is stored as null.
 * Needs the decoded length: unchanged while it is unknown.
 */
export function trimAudioClip(
  clips: StitchAudioClip[],
  durations: AudioDurations,
  id: string,
  patch: { inSec?: number; outSec?: number | null },
): StitchAudioClip[] {
  const clip = clips.find((c) => c.id === id);
  const d = clip ? durations.get(audioSourceKey(clip.source)) : undefined;
  if (!clip || d === undefined || !Number.isFinite(d)) return clips;
  const { previous, next } = rowNeighbours(clips, clip);
  let { inSec, outSec, startSec } = clip;
  const effOut = () => Math.min(outSec ?? d, d);

  if (patch.inSec !== undefined && finite(patch.inSec)) {
    const previousEnd = previous ? previous.startSec + audioClipLength(previous, durations.get(audioSourceKey(previous.source))) : 0;
    // The start moves with the In, so the start's floor (0:00, the previous clip's end) is a floor on the In
    const min = Math.max(0, inSec - (startSec - previousEnd));
    const max = effOut() - MIN_AUDIO_CLIP_SEC;
    if (max >= min) {
      const nextIn = clamp(patch.inSec, min, max);
      startSec = clamp(startSec + (nextIn - inSec), 0, MAX_START_SEC);
      inSec = nextIn;
    }
  }
  if (patch.outSec !== undefined && (patch.outSec === null || finite(patch.outSec))) {
    const max = Math.min(d, next ? inSec + (next.startSec - startSec) : Infinity);
    const min = inSec + MIN_AUDIO_CLIP_SEC;
    if (max >= min) {
      const nextOut = clamp(patch.outSec ?? d, min, max);
      outSec = Math.abs(nextOut - d) <= END_EPSILON_SEC ? null : nextOut;
    }
  }
  if (inSec === clip.inSec && outSec === clip.outSec && startSec === clip.startSec) return clips;
  return normalizeAudioClips(clips.map((c) => (c.id === id ? { ...c, inSec, outSec, startSec } : c)));
}

/** The whole file again: In 0 and Out to the end, the sound kept in place, each edge stopped by 0:00 and its row's neighbours. */
export function resetAudioTrim(clips: StitchAudioClip[], durations: AudioDurations, id: string): StitchAudioClip[] {
  return trimAudioClip(clips, durations, id, { inSec: 0, outSec: null });
}

/**
 * Splits clip `id` at sequence time t (at least MIN_AUDIO_CLIP_SEC from both ends). The left piece keeps the id and
 * gets Out = the cut; the right one gets rightId, In = the cut and start t, on the same row. Both keep the whole curve:
 * each plays its own window of it, so the gain at every source second is what it was. null when refused.
 */
export function splitAudioClipAt(
  clips: StitchAudioClip[],
  durations: AudioDurations,
  id: string,
  t: number,
  rightId: string = newAudioClipId(),
): { clips: StitchAudioClip[]; rightId: string } | null {
  const clip = clips.find((c) => c.id === id);
  if (!clip || !finite(t)) return null;
  const d = durations.get(audioSourceKey(clip.source));
  const known = d !== undefined && Number.isFinite(d);
  const end = clip.outSec !== null ? (known ? Math.min(clip.outSec, d) : clip.outSec) : known ? d : undefined;
  if (end === undefined) return null;
  const offset = t - clip.startSec;
  if (offset < MIN_AUDIO_CLIP_SEC || offset > end - clip.inSec - MIN_AUDIO_CLIP_SEC) return null;
  const cut = clip.inSec + offset;
  const left: StitchAudioClip = { ...clip, outSec: cut };
  const right: StitchAudioClip = { ...clip, id: rightId, inSec: cut, startSec: t, curve: clip.curve.slice() };
  return { clips: normalizeAudioClips(clips.flatMap((c) => (c.id === id ? [left, right] : [c]))), rightId };
}

/** Removes them and compacts the rows. */
export function removeAudioClips(
  clips: StitchAudioClip[],
  ids: ReadonlySet<string>,
): { clips: StitchAudioClip[]; rowMap: AudioRowMap } {
  const kept = clips.filter((clip) => !ids.has(clip.id));
  if (kept.length === clips.length) return { clips, rowMap: identityRows(audioRowCount(clips)) };
  const compacted = compactAudioRows(kept);
  // Rows past the last kept clip are gone too
  const rowMap = Array.from({ length: audioRowCount(clips) }, (_, row) => compacted.rowMap[row] ?? null);
  return { clips: compacted.clips, rowMap };
}

export function setAudioClipsMuted(clips: StitchAudioClip[], ids: ReadonlySet<string>, muted: boolean): StitchAudioClip[] {
  if (!clips.some((clip) => ids.has(clip.id) && clip.muted !== muted)) return clips;
  return clips.map((clip) => (ids.has(clip.id) ? { ...clip, muted } : clip));
}

export function setAudioClipCurve(clips: StitchAudioClip[], id: string, curve: VolumePoint[]): StitchAudioClip[] {
  const clip = clips.find((c) => c.id === id);
  if (!clip || sameCurve(clip.curve, curve)) return clips;
  const sorted = sortCurve(curve);
  return clips.map((c) => (c.id === id ? { ...c, curve: sorted } : c));
}

const clampStart = (sec: number) => clamp(finite(sec) ? sec : 0, 0, MAX_START_SEC);

/**
 * One clip per source, all starting at clamp(at, 0, 10:00): by default each on its own new row appended at the bottom,
 * in order; with opts.row, every one on that row (the caller checked overlapsOnRow).
 */
export function addAudioAt(
  clips: StitchAudioClip[],
  sources: readonly StitchAudioSource[],
  at: number,
  opts: { row?: number } = {},
): { clips: StitchAudioClip[]; ids: string[] } {
  if (sources.length === 0) return { clips, ids: [] };
  const first = audioRowCount(clips);
  const added = sources.map((source, i) =>
    createAudioClip({ ...source }, { row: opts.row ?? first + i, startSec: clampStart(at) }),
  );
  return { clips: normalizeAudioClips([...clips, ...added]), ids: added.map((clip) => clip.id) };
}

/** The listed clips (audio order) as clipboard items: offsetSec from the earliest start, rowOffset from the top row. */
export function copyAudioItems(clips: readonly StitchAudioClip[], ids: readonly string[]): ClipboardAudioItem[] {
  const wanted = new Set(ids);
  const selected = clips.filter((clip) => wanted.has(clip.id));
  if (selected.length === 0) return [];
  const earliest = Math.min(...selected.map((clip) => clip.startSec));
  const top = Math.min(...selected.map((clip) => clip.row));
  return selected.map((clip) => ({
    track: "audio",
    source: { ...clip.source },
    inSec: clip.inSec,
    outSec: clip.outSec,
    muted: clip.muted,
    curve: clip.curve.slice(),
    offsetSec: clip.startSec - earliest,
    rowOffset: clip.row - top,
  }));
}

/** New clips from items on new rows appended under the last: the first at `at`, time and row spacing kept. */
export function pasteAudioClips(
  clips: StitchAudioClip[],
  items: readonly ClipboardAudioItem[],
  at: number,
): { clips: StitchAudioClip[]; ids: string[] } {
  if (items.length === 0) return { clips, ids: [] };
  const first = audioRowCount(clips);
  const start = clampStart(at);
  const added = items.map((item) =>
    createAudioClip(
      { ...item.source },
      {
        row: first + item.rowOffset,
        startSec: clampStart(start + item.offsetSec),
        inSec: item.inSec,
        outSec: item.outSec,
        muted: item.muted,
        curve: item.curve.slice(),
      },
    ),
  );
  return { clips: normalizeAudioClips([...clips, ...added]), ids: added.map((clip) => clip.id) };
}

/**
 * Copies of `ids` (new ids) never at the originals' time, which would sum the same sound with itself: the earliest
 * starts at the latest end of the selection, the spacing kept (a clip whose length is unknown ends at its start
 * here). On their own rows when every copy fits there (an Infinity length never fits); otherwise all on new rows
 * inserted under the lowest selected row, row spacing kept.
 */
export function duplicateAudioClips(
  clips: StitchAudioClip[],
  lengthOf: AudioLengthOf,
  ids: readonly string[],
): { clips: StitchAudioClip[]; ids: string[]; rowMap: AudioRowMap } {
  const rowCount = audioRowCount(clips);
  const wanted = new Set(ids);
  const selected = clips.filter((clip) => wanted.has(clip.id));
  if (selected.length === 0) return { clips, ids: [], rowMap: identityRows(rowCount) };
  const ends = selected.map((clip) => {
    const length = lengthOf(clip);
    return clip.startSec + (Number.isFinite(length) ? length : 0);
  });
  const earliest = Math.min(...selected.map((clip) => clip.startSec));
  const latest = Math.max(...selected.map((clip) => clip.startSec));
  const shift = Math.min(Math.max(...ends) - earliest, MAX_START_SEC - latest);
  const copies = selected.map((clip) => ({ ...clip, id: newAudioClipId(), curve: clip.curve.slice(), startSec: clip.startSec + shift }));
  const fits = copies.every((copy) => {
    const length = lengthOf(copy);
    return Number.isFinite(length) && !overlapsOnRow(clips, lengthOf, copy.row, copy.startSec, length, new Set());
  });
  const newIds = copies.map((copy) => copy.id);
  if (fits) return { clips: normalizeAudioClips([...clips, ...copies]), ids: newIds, rowMap: identityRows(rowCount) };
  const top = Math.min(...selected.map((clip) => clip.row));
  const bottom = Math.max(...selected.map((clip) => clip.row));
  const span = bottom - top + 1;
  const shifted = clips.map((clip) => (clip.row > bottom ? { ...clip, row: clip.row + span } : clip));
  const placed = copies.map((copy) => ({ ...copy, row: bottom + 1 + (copy.row - top) }));
  return {
    clips: normalizeAudioClips([...shifted, ...placed]),
    ids: newIds,
    rowMap: insertedRows(rowCount, bottom, span),
  };
}

/**
 * The part a fade covers, in source seconds: the heard range, or with the length unknown, from In to the earlier of
 * the Out and the loop's end (a fade in never waits for the file's length).
 */
function fadeInWindow(clip: StitchAudioClip, span: AudioSpan, loopSec: number): { from: number; to: number } | null {
  const heard = heardRange(span, loopSec);
  if (heard) return { from: heard.fromSrc, to: heard.toSrc };
  if (span.length > 0) return null;
  const length = Math.min((clip.outSec ?? Infinity) - clip.inSec, loopSec - clip.startSec);
  return length > 0 && Number.isFinite(length) ? { from: clip.inSec, to: clip.inSec + length } : null;
}

/** A 1 s ramp (at most half the heard part) from silence at the clip's In. */
export function audioFadeIn(clip: StitchAudioClip, span: AudioSpan, loopSec: number): VolumePoint[] {
  const window = fadeInWindow(clip, span, loopSec);
  return window ? fadeInRange(clip.curve, window.from, window.to) : clip.curve.slice();
}

/** A 1 s ramp to silence where the clip stops being heard: its Out, or the loop's end. Unchanged while the length is unknown. */
export function audioFadeOut(clip: StitchAudioClip, span: AudioSpan, loopSec: number): VolumePoint[] {
  const heard = heardRange(span, loopSec);
  return heard ? fadeOutRange(clip.curve, heard.fromSrc, heard.toSrc) : clip.curve.slice();
}

/** Below −120 dB a curve is silent, whatever float error a shifted fade's last point picked up. */
const SILENT_GAIN = 1e-6;

/**
 * Which of the rail's quick shapes the clip's curve has over the part one loop hears: Flat with no points; Fade in when
 * it is silent where the clip starts being heard (its In); Fade out when it is silent where the clip stops being heard
 * (its Out, or the loop's end). So a fade a trim or a split has cut away, which is no longer heard, does not count,
 * and a drawn curve can read as a fade. Both fades at once after Fade in and Fade out. Fade in is judged from In while
 * the length is unknown, as Fade in itself works; Fade out needs the length.
 */
export function audioCurveShape(
  clip: StitchAudioClip,
  span: AudioSpan,
  loopSec: number,
): { flat: boolean; fadeIn: boolean; fadeOut: boolean } {
  if (clip.curve.length === 0) return { flat: true, fadeIn: false, fadeOut: false };
  const window = fadeInWindow(clip, span, loopSec);
  const heard = heardRange(span, loopSec);
  return {
    flat: false,
    fadeIn: window !== null && gainAt(clip.curve, window.from) <= SILENT_GAIN,
    fadeOut: heard !== null && gainAt(clip.curve, heard.toSrc) <= SILENT_GAIN,
  };
}

/**
 * followEndFade on each clip that starts before oldTotal, in its source clock (a fade out ending at the sequence's end
 * follows the end when the length changes without a trim). The same array when nothing changes.
 */
export function followEndFades(clips: StitchAudioClip[], oldTotal: number, newTotal: number): StitchAudioClip[] {
  let changed = false;
  const next = clips.map((clip) => {
    if (!(clip.startSec < oldTotal)) return clip;
    const shift = clip.inSec - clip.startSec;
    const curve = followEndFade(clip.curve, oldTotal + shift, newTotal + shift);
    if (sameCurve(curve, clip.curve)) return clip;
    changed = true;
    return { ...clip, curve };
  });
  return changed ? next : clips;
}

function sameAudioSource(a: StitchAudioSource, b: StitchAudioSource): boolean {
  return a.kind === "music" ? b.kind === "music" : b.kind === "asset" && a.assetId === b.assetId;
}

/** By value on the compacted forms (an empty row a move left is not a change), curves by sameCurve. */
export function sameAudioClips(a: readonly StitchAudioClip[], b: readonly StitchAudioClip[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const left = compactAudioRows(normalizeAudioClips(a)).clips;
  const right = compactAudioRows(normalizeAudioClips(b)).clips;
  return left.every((clip, i) => {
    const other = right[i];
    return (
      clip.id === other.id &&
      sameAudioSource(clip.source, other.source) &&
      clip.row === other.row &&
      clip.startSec === other.startSec &&
      clip.inSec === other.inSec &&
      clip.outSec === other.outSec &&
      clip.muted === other.muted &&
      sameCurve(clip.curve, other.curve)
    );
  });
}

/** Whether a clip's only Out change is the cut its split pieces start at (pieces of its source chained to the old Out). */
function onlyAudioSplit(was: StitchAudioClip, clip: StitchAudioClip, pieces: readonly StitchAudioClip[]): boolean {
  if (was.inSec !== clip.inSec || clip.outSec === was.outSec || clip.outSec === null) return false;
  const key = audioSourceKey(clip.source);
  const left = pieces.filter((p) => audioSourceKey(p.source) === key);
  let cursor: number | null = clip.outSec;
  while (cursor !== was.outSec) {
    const at = cursor;
    const index = left.findIndex((p) => p.inSec === at);
    if (index === -1) return false;
    cursor = left[index].outSec;
    left.splice(index, 1);
    if (cursor === null && was.outSec !== null) return false;
  }
  return true;
}

/** Each clip's row as a rank among the rows the listed clips use, so a row closed up by a removal is no move. */
function rowRanks(clips: readonly StitchAudioClip[], ids: ReadonlySet<string>): Map<string, number> {
  const kept = clips.filter((clip) => ids.has(clip.id));
  const rows = [...new Set(kept.map((clip) => clip.row))].sort((a, b) => a - b);
  return new Map(kept.map((clip) => [clip.id, rows.indexOf(clip.row)]));
}

/**
 * The discard sheet's audio parts, matching clips by id: added, pasted, duplicated, removed, cut, moved (in time, or
 * to another row), trimmed, split, muted and unmuted clips, and changed curves. A new clip of a source already there
 * is a split piece unless `origins` says it was pasted or duplicated.
 */
export function describeAudioChanges(
  initial: readonly StitchAudioClip[],
  draft: readonly StitchAudioClip[],
  origins: ReadonlyMap<string, "pasted" | "duplicated" | "cut"> = new Map(),
): string[] {
  const before = new Map(initial.map((clip) => [clip.id, clip]));
  const after = new Map(draft.map((clip) => [clip.id, clip]));
  const sourcesBefore = new Set(initial.map((clip) => audioSourceKey(clip.source)));
  const fresh = draft.filter((clip) => !before.has(clip.id));
  const pasted = fresh.filter((clip) => origins.get(clip.id) === "pasted").length;
  const duplicated = fresh.filter((clip) => origins.get(clip.id) === "duplicated").length;
  const added = fresh.filter((clip) => origins.get(clip.id) !== "pasted" && origins.get(clip.id) !== "duplicated");
  const pieces = added.filter((clip) => sourcesBefore.has(audioSourceKey(clip.source)));
  const gone = initial.filter((clip) => !after.has(clip.id));
  const cut = gone.filter((clip) => origins.get(clip.id) === "cut").length;

  const common = new Set(draft.filter((clip) => before.has(clip.id)).map((clip) => clip.id));
  const ranksBefore = rowRanks(initial, common);
  const ranksAfter = rowRanks(draft, common);
  let moved = 0;
  let trimmed = 0;
  let muted = 0;
  let unmuted = 0;
  let curves = 0;
  for (const clip of draft) {
    const was = before.get(clip.id);
    if (!was) continue;
    const anchorMoved = Math.abs(clip.startSec - clip.inSec - (was.startSec - was.inSec)) > 1e-9;
    if (anchorMoved || ranksBefore.get(clip.id) !== ranksAfter.get(clip.id)) moved++;
    if ((was.inSec !== clip.inSec || was.outSec !== clip.outSec) && !onlyAudioSplit(was, clip, pieces)) trimmed++;
    if (!was.muted && clip.muted) muted++;
    if (was.muted && !clip.muted) unmuted++;
    if (!sameCurve(was.curve, clip.curve)) curves++;
  }

  return [
    counted(added.length - pieces.length, "an added audio clip", "added audio clips"),
    counted(pasted, "a pasted audio clip", "pasted audio clips"),
    counted(duplicated, "a duplicated audio clip", "duplicated audio clips"),
    counted(gone.length - cut, "a removed audio clip", "removed audio clips"),
    counted(cut, "a cut audio clip", "cut audio clips"),
    counted(moved, "a moved audio clip", "moved audio clips"),
    counted(trimmed, "a trimmed audio clip", "trimmed audio clips"),
    counted(pieces.length, "an audio split", "audio splits"),
    counted(muted, "a muted audio clip", "muted audio clips"),
    counted(unmuted, "an unmuted audio clip", "unmuted audio clips"),
    counted(curves, "the volume curve", "volume curves"),
  ].filter((part): part is string => part !== null);
}
