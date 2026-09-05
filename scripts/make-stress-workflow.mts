/**
 * Builds examples/stress-workflow.json: a canvas big enough to show frame
 * drops. About 300 nodes and 400 edges of mixed types, laid out as a grid of
 * five-node cells with image links between neighbouring cells, a few of them
 * hidden, a few bundled at their output, a few cells grouped, and a couple
 * of reference links. No images, so the file stays small and the cost is
 * the graph itself, not media decoding.
 *
 *   npx tsx scripts/make-stress-workflow.mts
 *
 * Deterministic: the same input always writes the same file.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// nodeDefaults reads sticky settings from localStorage; there is none here.
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { createDefaultNodeData, defaultNodeDimensions } = await import("../src/store/utils/nodeDefaults");
type NodeType = keyof typeof defaultNodeDimensions;

type N = {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  width: number;
  style: { width: number };
  groupId?: string;
};
type E = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  type?: "reference";
  data: Record<string, unknown>;
};
const nodes: N[] = [];
const edges: E[] = [];

const COL = 440;
const ROW = 520;
/** Each cell is four columns by two rows of node slots. */
const CELL_COLS = 4;
const CELL_ROWS = 2;
const GRID_COLS = 10;
const CELLS = 60;
let counter = 0;
let clock = 1_756_000_000_000;

function add(type: NodeType, col: number, row: number, data: Record<string, unknown> = {}): string {
  const id = `${type}-${++counter}`;
  const w = defaultNodeDimensions[type].width;
  nodes.push({
    id,
    type,
    position: { x: col * COL, y: row * ROW },
    data: { ...(createDefaultNodeData(type) as Record<string, unknown>), ...data },
    width: w,
    style: { width: w },
  });
  return id;
}

function wire(source: string, sourceHandle: string, target: string, targetHandle: string, extra: Partial<E> = {}): E {
  const edge: E = {
    id: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    ...extra,
    data: { createdAt: (clock += 1000), ...(extra.data ?? {}) },
  };
  edges.push(edge);
  return edge;
}

/** A cell: an image and a prompt feeding a text step, a generate step and a sink. */
interface Cell {
  image: string;
  generate: string;
}

// Five variants keep the node mix wide without any one of them dominating;
// the media-heavy nodes (video, 3D, GIF) appear once per ten cells at most.
function buildCell(index: number): Cell {
  const col = (index % GRID_COLS) * CELL_COLS;
  const row = Math.floor(index / GRID_COLS) * CELL_ROWS;
  const variant = index % 10;

  const image = add("imageInput", col, row, { isOptional: variant === 3 });
  const promptText = `Cell ${index + 1}: a lakeside house at golden hour, variation ${variant}`;

  if (variant === 4) {
    // Video pipeline
    const prompt = add("prompt", col, row + 1, { prompt: promptText });
    const llm = add("llmGenerate", col + 1, row, { outputText: "A weathered cabin, warm windows.", status: "idle", parametersExpanded: false });
    const generate = add("generateVideo", col + 2, row, { parametersExpanded: false });
    const sink = add("outputGallery", col + 3, row);
    wire(image, "image", llm, "image");
    wire(prompt, "text", llm, "text");
    wire(llm, "text", generate, "text");
    wire(image, "image", generate, "image");
    wire(generate, "video", sink, "video");
    return { image, generate };
  }

  if (variant === 7) {
    // Prompt construction and an array fan
    const constructor_ = add("promptConstructor", col, row + 1, { template: "Portrait of @scene in @style", outputText: "Portrait of @scene in @style" });
    const array = add("array", col + 1, row, { inputText: "red, green, blue", outputItems: ["red", "green", "blue"] });
    const generate = add("nanoBanana", col + 2, row, { aspectRatio: "1:1", parametersExpanded: false });
    const sink = add("output", col + 3, row);
    wire(image, "image", generate, "image");
    wire(constructor_, "text", array, "text");
    wire(array, "text", generate, "text");
    wire(generate, "image", sink, "image");
    wire(image, "image", sink, "image", { data: { hidden: true } });
    return { image, generate };
  }

  if (variant === 9) {
    // Logic: a switch and a router in the path
    const prompt = add("prompt", col, row + 1, { prompt: promptText });
    const sw = add("switch", col + 1, row, {
      inputType: "text",
      switches: [
        { id: "sw-a", name: "Warm", enabled: true },
        { id: "sw-b", name: "Cool", enabled: false },
      ],
    });
    const router = add("router", col + 1, row + 1);
    const generate = add("nanoBanana", col + 2, row, { aspectRatio: "16:9", parametersExpanded: false });
    wire(prompt, "text", sw, "generic-input");
    wire(sw, "sw-a", generate, "text");
    wire(image, "image", router, "generic-input");
    wire(router, "image", generate, "image");
    return { image, generate };
  }

  if (variant === 2) {
    // Image tools, one of them compared against the source
    const prompt = add("prompt", col, row + 1, { prompt: promptText });
    const generate = add("nanoBanana", col + 1, row, { aspectRatio: "4:3", parametersExpanded: false });
    const resize = add("imageResize", col + 2, row);
    const compare = add("imageCompare", col + 3, row);
    wire(prompt, "text", generate, "text");
    wire(image, "image", generate, "image");
    wire(generate, "image", resize, "image");
    wire(resize, "image", compare, "image");
    wire(image, "image", compare, "image-1");
    return { image, generate };
  }

  // The common case: image + prompt -> LLM -> generate -> output
  const prompt = add("prompt", col, row + 1, { prompt: promptText, variableName: variant === 1 ? "scene" : undefined });
  const llm = add("llmGenerate", col + 1, row, {
    outputText: "A weathered lakeside cabin, warm windows, mist over still water.",
    status: variant === 5 ? "error" : "idle",
    error: variant === 5 ? "Rate limit exceeded" : undefined,
    parametersExpanded: false,
  });
  const generate = add("nanoBanana", col + 2, row, {
    aspectRatio: variant === 6 ? "9:16" : "16:9",
    parametersExpanded: variant === 8,
  });
  const sink = add("output", col + 3, row);
  wire(image, "image", llm, "image");
  wire(prompt, "text", llm, "text");
  wire(llm, "text", generate, "text");
  wire(image, "image", generate, "image");
  wire(generate, "image", sink, "image");
  return { image, generate };
}

const cells: Cell[] = Array.from({ length: CELLS }, (_, i) => buildCell(i));

// ---- links between cells: every image also feeds the next cell's generate
// step; every third generate feeds the one two cells on; every tenth image
// also fans out to the three cells after that as a bundle. One in five of
// the neighbour links is hidden.
cells.forEach((cell, i) => {
  const next = cells[(i + 1) % CELLS];
  wire(cell.image, "image", next.generate, "image", i % 5 === 0 ? { data: { hidden: true } } : {});
  if (i % 3 === 0 && i + 2 < CELLS) {
    wire(cell.generate, "image", cells[i + 2].generate, "image");
  }
  if (i % 10 === 0 && i + 4 < CELLS) {
    const bundleId = `bundle-${i}`;
    for (let k = 2; k <= 4; k++) {
      wire(cell.image, "image", cells[i + k].generate, "image", { data: { sourceBundleId: bundleId } });
    }
  }
});

// ---- a few split grids, wired to a neighbouring cell's image as reference links
for (const i of [11, 33, 55]) {
  const col = (i % GRID_COLS) * CELL_COLS + 2;
  const row = Math.floor(i / GRID_COLS) * CELL_ROWS + 1;
  const split = add("splitGrid", col, row);
  wire(cells[i].generate, "image", split, "image");
  wire(split, "reference", cells[i + 1].image, "reference", { type: "reference" });
}

// ---- groups around a few cells
const groups: Record<string, { id: string; name: string; color: string; position: { x: number; y: number }; size: { width: number; height: number } }> = {};
const colors = ["blue", "green", "purple", "orange"] as const;
[5, 18, 27, 44].forEach((cellIndex, g) => {
  const id = `group-${g + 1}`;
  const col = (cellIndex % GRID_COLS) * CELL_COLS;
  const row = Math.floor(cellIndex / GRID_COLS) * CELL_ROWS;
  const members = nodes.filter(
    (n) => n.position.x >= col * COL && n.position.x < (col + CELL_COLS) * COL && n.position.y >= row * ROW && n.position.y < (row + CELL_ROWS) * ROW,
  );
  const padding = 40;
  const minX = Math.min(...members.map((n) => n.position.x)) - padding;
  const minY = Math.min(...members.map((n) => n.position.y)) - padding;
  const maxX = Math.max(...members.map((n) => n.position.x + n.width)) + padding;
  const maxY = Math.max(...members.map((n) => n.position.y + defaultNodeDimensions[n.type].height)) + padding;
  for (const n of members) n.groupId = id;
  groups[id] = { id, name: `Group ${g + 1}`, color: colors[g], position: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } };
});

const workflow = {
  version: 1,
  id: "wf_stress",
  name: "Stress workflow",
  directoryPath: "",
  nodes,
  edges,
  edgeStyle: "angular",
  groups,
};

const out = resolve(process.cwd(), "examples/stress-workflow.json");
writeFileSync(out, JSON.stringify(workflow, null, 2) + "\n");
const hidden = edges.filter((e) => e.data.hidden).length;
const bundled = new Set(edges.map((e) => e.data.sourceBundleId).filter(Boolean)).size;
console.log(
  `wrote ${out}: ${nodes.length} nodes (${new Set(nodes.map((n) => n.type)).size} types), ${edges.length} edges ` +
    `(${hidden} hidden, ${bundled} bundles, ${edges.filter((e) => e.type === "reference").length} reference), ${Object.keys(groups).length} groups`,
);
