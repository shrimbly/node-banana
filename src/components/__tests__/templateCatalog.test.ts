import { describe, it, expect } from "vitest";
import {
  TEMPLATE_BASE_ENTRY,
  TEMPLATE_NODE_CATALOG,
  getTemplateEntry,
  templateHandleKind,
} from "@/components/splitgrid/templateCatalog";
import { NODE_TITLES, getNodeHandles } from "@/lib/nodes/handles";
import type { NodeType } from "@/types";

const ALL_TYPES = Object.keys(NODE_TITLES) as NodeType[];

describe("split grid cell catalogue", () => {
  it("offers every node type except the cell image, the grid itself and Comfy apps", () => {
    const offered = new Set(TEMPLATE_NODE_CATALOG.map((entry) => entry.type));
    for (const type of ALL_TYPES) {
      const excluded = type === "imageInput" || type === "splitGrid" || type === "comfyApp";
      expect(offered.has(type), `${type} ${excluded ? "should not be" : "should be"} offered`).toBe(!excluded);
    }
    expect(TEMPLATE_BASE_ENTRY.type).toBe("imageInput");
  });

  it("gives every entry the canvas's handles, minus the untyped router and switch stubs", () => {
    for (const entry of TEMPLATE_NODE_CATALOG) {
      const real = getNodeHandles(entry.type);
      const typed = (ids: string[]) => ids.filter((id) => !id.startsWith("generic"));
      expect(entry.inputs.map((h) => h.id)).toEqual(typed(real.inputs));
      expect(entry.outputs.map((h) => h.id)).toEqual(typed(real.outputs));
      expect(entry.title).toBe(NODE_TITLES[entry.type]);
      for (const handle of [...entry.inputs, ...entry.outputs]) {
        expect(handle.label.length).toBeGreaterThan(0);
        expect(["image", "text", "video", "audio", "3d", "easeCurve", "reference"]).toContain(templateHandleKind(handle.id));
      }
    }
  });

  it("offers the ease curve node with its video and curve sockets on both sides", () => {
    const ease = getTemplateEntry("easeCurve");
    expect(ease.label).toBe("Ease Curve");
    expect(ease.inputs.map((h) => h.id)).toEqual(["video", "easeCurve"]);
    expect(ease.outputs.map((h) => h.id)).toEqual(["video", "easeCurve"]);
    expect(ease.inputs[1].label).toBe("Ease curve");
  });

  it("keeps the original entries first, then the rest by label", () => {
    const types = TEMPLATE_NODE_CATALOG.map((entry) => entry.type);
    expect(types.slice(0, 4)).toEqual(["prompt", "nanoBanana", "generateVideo", "llmGenerate"]);
    const rest = TEMPLATE_NODE_CATALOG.slice(9).map((entry) => entry.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  it("has unique labels so the menus stay unambiguous", () => {
    const labels = TEMPLATE_NODE_CATALOG.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
