import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import {
  parseAspectRatio,
  clampNodeWidth,
  getNodeSize,
  computeShellLayout,
  computeShellHeight,
  CARD_EDGE,
} from "../nodeDimensions";
import { CONTROLS_GAP, GAP_ROW_H, socketMinHeight } from "@/components/nodes/ui/tokens";

describe("parseAspectRatio", () => {
  it("parses ratio strings and numbers", () => {
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("9/16")).toBeCloseTo(9 / 16);
    expect(parseAspectRatio("4x3")).toBeCloseTo(4 / 3);
    expect(parseAspectRatio(" 1 : 1 ")).toBe(1);
    expect(parseAspectRatio(1.5)).toBe(1.5);
    expect(parseAspectRatio("2")).toBe(2);
  });
  it("falls back for junk", () => {
    expect(parseAspectRatio("auto")).toBe(1);
    expect(parseAspectRatio("")).toBe(1);
    expect(parseAspectRatio(null, 1.25)).toBe(1.25);
    expect(parseAspectRatio("0:9")).toBe(1);
    expect(parseAspectRatio(-2)).toBe(1);
  });
});

describe("clampNodeWidth", () => {
  it("clamps into the node width range and rounds", () => {
    expect(clampNodeWidth(50)).toBe(200);
    expect(clampNodeWidth(999)).toBe(500);
    expect(clampNodeWidth(300.4)).toBe(300);
    expect(clampNodeWidth(NaN)).toBe(200);
    expect(clampNodeWidth(150, 100, 160)).toBe(150);
  });
});

describe("getNodeSize", () => {
  const base = { id: "n", position: { x: 0, y: 0 }, data: {} } as Node;
  it("prefers explicit width and measured height", () => {
    const node = { ...base, type: "prompt", width: 320, style: { width: 300, height: 200 }, measured: { width: 300, height: 250 } } as Node;
    expect(getNodeSize(node)).toEqual({ width: 320, height: 250 });
  });
  it("falls through style then measured then type defaults", () => {
    expect(getNodeSize({ ...base, type: "prompt", style: { width: 280 } } as Node)).toEqual({ width: 280, height: 220 });
    expect(getNodeSize({ ...base, type: "prompt", measured: { width: 250, height: 100 } } as Node)).toEqual({ width: 250, height: 100 });
    expect(getNodeSize({ ...base, type: "nanoBanana" } as Node)).toEqual({ width: 300, height: 300 });
    expect(getNodeSize({ ...base, type: "mystery" } as Node)).toEqual({ width: 300, height: 280 });
  });
});

describe("computeShellLayout", () => {
  it("derives the media height from width and aspect", () => {
    const l = computeShellLayout({ width: 300, media: { kind: "aspect", aspect: 16 / 9 } });
    expect(l.mediaH).toBe(Math.round((300 - 2 * CARD_EDGE) / (16 / 9)));
    expect(l.cardH).toBe(l.mediaH + 2 * CARD_EDGE);
    expect(l.gapH).toBe(0);
    expect(l.height).toBe(l.cardH);
  });
  it("portrait media makes a tall node", () => {
    const l = computeShellLayout({ width: 300, media: { kind: "aspect", aspect: 9 / 16 } });
    expect(l.mediaH).toBe(Math.round(290 * 16 / 9));
  });
  it("fixed media uses its height", () => {
    const l = computeShellLayout({ width: 300, media: { kind: "fixed", height: 160 } });
    expect(l.mediaH).toBe(160);
    expect(l.cardH).toBe(160 + 2 * CARD_EDGE);
  });
  it("never lets the card get shorter than its sockets", () => {
    const l = computeShellLayout({ width: 300, media: { kind: "fixed", height: 40 }, inputs: 5, outputs: 1 });
    expect(l.cardH).toBe(socketMinHeight(5));
    expect(socketMinHeight(5)).toBe(168);
  });
  it("adds the gap row for a carousel and a small spacer for controls alone", () => {
    const withGap = computeShellLayout({ width: 300, media: { kind: "fixed", height: 100 }, gap: true });
    expect(withGap.gapH).toBe(GAP_ROW_H);
    const withControls = computeShellLayout({ width: 300, media: { kind: "fixed", height: 100 }, controlsH: 28 });
    expect(withControls.gapH).toBe(CONTROLS_GAP);
    expect(withControls.height).toBe(100 + 2 * CARD_EDGE + CONTROLS_GAP + 28);
    expect(computeShellHeight({ width: 300, media: { kind: "fixed", height: 100 }, controlsH: 28 })).toBe(withControls.height);
  });
  it("treats a bad aspect as square", () => {
    const l = computeShellLayout({ width: 300, media: { kind: "aspect", aspect: 0 } });
    expect(l.mediaH).toBe(300 - 2 * CARD_EDGE);
  });
});
