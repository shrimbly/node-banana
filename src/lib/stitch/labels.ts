import { NODE_TITLES } from "@/lib/nodes/handles";

/**
 * Names the Stitch editor shows for clips and their sources: "Clip 3",
 * "Generate video", "Veo 3.1", and the header's frame rate.
 */

/** 1-based: the first clip is "Clip 1". */
export function clipName(index: number): string {
  return `Clip ${index + 1}`;
}

const COUNT_WORDS = ["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "a trim" / "two trims" / "12 trims" for the discard sheet: `one` is the singular with its article. */
export function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  if (n === 1) return one;
  return `${n < COUNT_WORDS.length ? COUNT_WORDS[n] : n} ${many}`;
}

/** Title-cased words become lower case after the first; acronyms and "3D" keep theirs ("LLM generate", "Generate 3D"). */
function sentenceCase(title: string): string {
  return title
    .split(" ")
    .map((word, i) => (i > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

function readString(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The node's own title if it has one, else its kind in sentence case: "Generate video". */
export function nodeKindLabel(node: { type?: string; data: unknown }): string {
  const custom = readString(node.data, "customTitle");
  if (custom) return custom;
  const title = node.type ? NODE_TITLES[node.type] : undefined;
  return title ? sentenceCase(title) : "Node";
}

/** The model a generator ran with ("Veo 3.1"), or null for a node without one. */
export function nodeModelLabel(node: { type?: string; data: unknown }): string | null {
  const model =
    node.data && typeof node.data === "object" ? (node.data as Record<string, unknown>).selectedModel : undefined;
  return readString(model, "displayName") ?? readString(model, "modelId");
}

/** NTSC rates, shown with two decimals. */
const FRACTIONAL_RATES = [24000 / 1001, 30000 / 1001, 60000 / 1001];

/**
 * The header's frame rate: null unless every rate is known and all agree
 * within 0.5 fps. Whole numbers ("24 fps"), or two decimals near
 * 23.976 / 29.97 / 59.94 ("29.97 fps").
 */
export function formatFps(rates: ReadonlyArray<number | null>): string | null {
  if (rates.length === 0) return null;
  const known: number[] = [];
  for (const rate of rates) {
    if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
    known.push(rate);
  }
  if (Math.max(...known) - Math.min(...known) > 0.5) return null;
  const rate = known.reduce((sum, r) => sum + r, 0) / known.length;
  const fractional = FRACTIONAL_RATES.some((r) => Math.abs(rate - r) <= 0.01);
  return `${fractional ? rate.toFixed(2) : Math.round(rate)} fps`;
}
