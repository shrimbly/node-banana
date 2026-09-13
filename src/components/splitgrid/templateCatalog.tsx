"use client";

/**
 * Catalog of node types available inside the split-grid cell template editor.
 * Every node type on the canvas is offered, apart from the few that cannot
 * live inside a cell. Handles and titles come from the canvas's own registry
 * (`@/lib/nodes/handles`), so template edges instantiate cleanly onto the
 * main canvas and the editor looks native.
 */

import type { ReactNode } from "react";
import type { HandleType, ModelInputDef, NodeType } from "@/types";
import { NODE_TITLES, getNodeHandles } from "@/lib/nodes/handles";
import { schemaSockets } from "../nodes/ui/schemaSockets";
import { ALL_NODE_OPTIONS } from "../ConnectionDropMenu";

export type TemplateHandleKind = HandleType | "reference";

export function templateHandleKind(id: string): TemplateHandleKind {
  return id.split("-")[0] as TemplateHandleKind;
}

export interface TemplateHandleDef {
  id: string;
  hidden?: boolean;
  placeholder?: boolean;
  schemaName?: string;
  label: string;
}

export interface TemplateCatalogEntry {
  type: NodeType;
  /** Menu label (matches ConnectionDropMenu) */
  label: string;
  /** Floating header title (matches the canvas's NODE_TITLES) */
  title: string;
  description: string;
  inputs: TemplateHandleDef[];
  outputs: TemplateHandleDef[];
}

const IMAGE_OUT: TemplateHandleDef = { id: "image", label: "Image" };

/** The base image node present in every template (not user-addable) */
export const TEMPLATE_BASE_ENTRY: TemplateCatalogEntry = {
  type: "imageInput",
  label: "Cell Image",
  title: "Image Input",
  description: "Receives one split image per cell",
  inputs: [],
  outputs: [IMAGE_OUT],
};

/**
 * Types a cell cannot hold: the cell image is the template's base node, a
 * grid inside a grid has no meaning, and a Comfy app needs its import dialog.
 */
const NOT_IN_CELLS: ReadonlySet<NodeType> = new Set<NodeType>(["imageInput", "splitGrid", "comfyApp"]);

/** The original hand-picked entries keep their place at the top of the menus. */
const FIRST: NodeType[] = [
  "prompt",
  "nanoBanana",
  "generateVideo",
  "llmGenerate",
  "annotation",
  "removeBackground",
  "imageResize",
  "output",
  "outputGallery",
];

const HANDLE_LABEL: Record<TemplateHandleKind, string> = {
  image: "Image",
  text: "Text",
  video: "Video",
  audio: "Audio",
  "3d": "3D",
  easeCurve: "Ease curve",
  reference: "Reference",
};

/** Copy that says more than the title, and handle labels that differ from the kind. */
const CURATED: Partial<Record<NodeType, { description?: string; inputLabels?: Record<string, string> }>> = {
  prompt: { description: "Text prompt for this cell" },
  nanoBanana: { description: "AI image generation", inputLabels: { text: "Prompt" } },
  generateVideo: { description: "AI video generation for this cell", inputLabels: { text: "Prompt" } },
  generate3d: { description: "AI 3D generation", inputLabels: { text: "Prompt" } },
  generateAudio: { description: "AI audio generation", inputLabels: { text: "Prompt" } },
  llmGenerate: { description: "AI text generation" },
  annotation: { description: "Draw on the cell image" },
  removeBackground: { description: "Strip the cell image background" },
  imageResize: { description: "Resize / re-encode the cell image" },
  output: { description: "Display the cell result" },
  outputGallery: { description: "Collect cell results" },
  easeCurve: { description: "Ease the cell's video with a curve" },
};

/** Static handle ids as template handles; the untyped router/switch stubs are not offered. */
function toHandleDefs(ids: string[], labels?: Record<string, string>): TemplateHandleDef[] {
  return ids
    .filter((id) => !id.startsWith("generic"))
    .map((id) => ({ id, label: labels?.[id] ?? HANDLE_LABEL[templateHandleKind(id)] ?? id }));
}

/** Menu labels that differ from the node title (the canvas menus say the same). */
const MENU_LABEL: Partial<Record<NodeType, string>> = {
  annotation: "Annotate",
  imageResize: "Resize Image",
};

/** Node types users can add to a cell template */
export const TEMPLATE_NODE_CATALOG: TemplateCatalogEntry[] = (Object.keys(NODE_TITLES) as NodeType[])
  .filter((type) => !NOT_IN_CELLS.has(type))
  .map((type): TemplateCatalogEntry => {
    const { inputs, outputs } = getNodeHandles(type);
    const curated = CURATED[type];
    const title = NODE_TITLES[type];
    return {
      type,
      label: MENU_LABEL[type] ?? title,
      title,
      description: curated?.description ?? title,
      inputs: toHandleDefs(inputs, curated?.inputLabels),
      outputs: toHandleDefs(outputs),
    };
  })
  .sort((a, b) => {
    const ai = FIRST.indexOf(a.type);
    const bi = FIRST.indexOf(b.type);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? FIRST.length : ai) - (bi === -1 ? FIRST.length : bi);
    return a.label.localeCompare(b.label);
  });

export function getTemplateEntry(type: NodeType, overrides?: Record<string, unknown>): TemplateCatalogEntry {
  if (type === TEMPLATE_BASE_ENTRY.type) return TEMPLATE_BASE_ENTRY;
  if (type === "generateVideo") {
    return {
      ...TEMPLATE_NODE_CATALOG.find((entry) => entry.type === type)!,
      inputs: schemaSockets(overrides?.inputSchema as ModelInputDef[] | undefined, { videoPlaceholder: true })
        .map((socket) => ({ ...socket, label: socket.label ?? socket.type })),
    };
  }
  return (
    TEMPLATE_NODE_CATALOG.find((entry) => entry.type === type) ?? {
      type,
      label: type,
      title: type,
      description: "",
      inputs: [],
      outputs: [],
    }
  );
}

/** Reuse the canvas menus' icons so the editor matches the rest of the app */
export function getTemplateNodeIcon(type: NodeType): ReactNode {
  return ALL_NODE_OPTIONS.find((option) => option.type === type)?.icon ?? null;
}
