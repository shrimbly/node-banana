/**
 * Time formats for the Stitch node and editor: m:ss.cc
 * timecodes, "4.20 s" lengths and the card's "5s". The minus sign is U+2212.
 */

const MINUS = "−";

/** m:ss with `digits` decimals. Round once on the total, then split, so 59.999 gives "1:00.00", never "0:60.00". Negative values clamp to 0. */
export function formatTimecode(sec: number, digits: 0 | 1 | 2 = 2): string {
  const scale = 10 ** digits;
  const units = Math.round((Number.isFinite(sec) ? Math.max(0, sec) : 0) * scale);
  const minutes = Math.floor(units / (60 * scale));
  const rest = units - minutes * 60 * scale;
  const seconds = String(Math.floor(rest / scale)).padStart(2, "0");
  const fraction = digits > 0 ? `.${String(rest % scale).padStart(digits, "0")}` : "";
  return `${minutes}:${seconds}${fraction}`;
}

const SECONDS = /^(\d+(?:\.\d*)?|\.\d+)$/;
const MINUTES_SECONDS = /^(\d+):(\d{1,2}(?:\.\d*)?)$/;

/** Accepts "4.6", "4,6", "04.60", "0:04.6", "1:02.30" and surrounding spaces. Returns null for negatives, NaN, or m:ss with ss >= 60. */
export function parseTimecode(text: string): number | null {
  const value = text.trim().replace(",", ".");
  const plain = SECONDS.exec(value);
  if (plain) return Number(plain[1]);
  const timed = MINUTES_SECONDS.exec(value);
  if (!timed) return null;
  const seconds = Number(timed[2]);
  if (seconds >= 60) return null;
  return Number(timed[1]) * 60 + seconds;
}

const SECONDS_UNIT = /\s*(s|sec|secs|seconds)\.?$/i;

/** parseTimecode after one trailing unit: "1", "1.5", "1,5", "1.0 s", "2s", "0:01.5". */
export function parseSeconds(text: string): number | null {
  return parseTimecode(text.trim().replace(SECONDS_UNIT, ""));
}

/** "4.20 s", "5.0 s"; signed "−0.80 s" / "+0.80 s" (a value that rounds to zero has no sign). */
export function formatSeconds(sec: number, digits: 1 | 2 = 2, opts: { signed?: boolean } = {}): string {
  const value = Number.isFinite(sec) ? sec : 0;
  const text = Math.abs(value).toFixed(digits);
  const isZero = Number(text) === 0;
  const sign = isZero ? "" : value < 0 ? MINUS : opts.signed ? "+" : "";
  return `${sign}${text} s`;
}

/** The node card's tile: whole seconds, rounded, no space ("5s"). */
export function formatTileSeconds(sec: number): string {
  return `${Math.round(Number.isFinite(sec) ? Math.max(0, sec) : 0)}s`;
}
