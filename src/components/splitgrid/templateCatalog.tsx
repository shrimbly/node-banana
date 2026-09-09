"use client";

/**
 * Catalog of node types available inside the split-grid cell template editor.
 * Handle definitions mirror getNodeHandles() in WorkflowCanvas — same ids and
 * the same vertical positions as the real node components — so template edges
 * instantiate cleanly onto the main canvas and the editor looks native.
 */

import type { ReactNode } from "react";
import type { ModelInputDef, NodeType } from "@/types";
import { schemaSockets } from "../nodes/ui/schemaSockets";
import { ALL_NODE_OPTIONS } from "../ConnectionDropMenu";

export type TemplateHandleKind = "image" | "text" | "video" | "audio";

export function templateHandleKind(id: string): TemplateHandleKind {
  return id.split("-")[0] as TemplateHandleKind;
}

export interface TemplateHandleDef {
  id: string;
  hidden?: boolean;
  placeholder?: boolean;
  schemaName?: string;
  label: string;
  /** Vertical position matching the real node component (default 50%) */
  top?: string;
}

export interface TemplateCatalogEntry {
  type: NodeType;
  /** Menu label (matches ConnectionDropMenu) */
  label: string;
  /** Floating header title (matches WorkflowCanvas NODE_TITLES) */
  title: string;
  description: string;
  inputs: TemplateHandleDef[];
  outputs: TemplateHandleDef[];
}

const IMAGE_IN: TemplateHandleDef = { id: "image", label: "Image" };
const IMAGE_OUT: TemplateHandleDef = { id: "image", label: "Image" };
const TEXT_OUT: TemplateHandleDef = { id: "text", label: "Text" };

/** The base image node present in every template (not user-addable) */
export const TEMPLATE_BASE_ENTRY: TemplateCatalogEntry = {
  type: "imageInput",
  label: "Cell Image",
  title: "Image Input",
  description: "Receives one split image per cell",
  inputs: [],
  outputs: [IMAGE_OUT],
};

/** Node types users can add to a cell template */
export const TEMPLATE_NODE_CATALOG: TemplateCatalogEntry[] = [
  {
    type: "prompt",
    label: "Prompt",
    title: "Prompt",
    description: "Text prompt for this cell",
    inputs: [{ id: "text", label: "Text" }],
    outputs: [TEXT_OUT],
  },
  {
    type: "nanoBanana",
    label: "Generate Image",
    title: "Generate Image",
    description: "AI image generation",
    // Same handle layout as GenerateImageNode: image 35%, text 65%
    inputs: [
      { id: "image", label: "Image", top: "35%" },
      { id: "text", label: "Prompt", top: "65%" },
    ],
    outputs: [IMAGE_OUT],
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    title: "Generate Video",
    description: "AI video generation for this cell",
    inputs: [IMAGE_IN, { id: "video", label: "Video" }, { id: "text", label: "Prompt" }],
    outputs: [{ id: "video", label: "Video" }],
  },
  {
    type: "llmGenerate",
    label: "LLM Generate",
    title: "LLM Generate",
    description: "AI text generation",
    inputs: [
      { id: "text", label: "Text", top: "35%" },
      { id: "image", label: "Image", top: "65%" },
    ],
    outputs: [TEXT_OUT],
  },
  {
    type: "annotation",
    label: "Annotate",
    title: "Annotation",
    description: "Draw on the cell image",
    inputs: [IMAGE_IN],
    outputs: [IMAGE_OUT],
  },
  {
    type: "removeBackground",
    label: "Remove Background",
    title: "Remove Background",
    description: "Strip the cell image background",
    inputs: [IMAGE_IN],
    outputs: [IMAGE_OUT],
  },
  {
    type: "imageResize",
    label: "Resize Image",
    title: "Image Resize",
    description: "Resize / re-encode the cell image",
    inputs: [IMAGE_IN],
    outputs: [IMAGE_OUT],
  },
  {
    type: "output",
    label: "Output",
    title: "Output",
    description: "Display the cell result",
    inputs: [IMAGE_IN],
    outputs: [],
  },
  {
    type: "outputGallery",
    label: "Output Gallery",
    title: "Output Gallery",
    description: "Collect cell results",
    inputs: [IMAGE_IN],
    outputs: [],
  },
];

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
