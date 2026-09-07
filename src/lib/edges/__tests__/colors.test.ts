import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  HANDLE_TYPES,
  HANDLE_TYPE_COLORS,
  EDGE_COLORS,
  normalizeHandleType,
  edgeColorKeyForHandles,
  edgeColorForHandles,
} from "../colors";

describe("edge colour tokens", () => {
  it("gives every handle type a colour", () => {
    for (const type of HANDLE_TYPES) {
      expect(HANDLE_TYPE_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/);
      expect(EDGE_COLORS[type]).toBe(HANDLE_TYPE_COLORS[type]);
    }
  });

  it("keeps the edge-only states", () => {
    expect(EDGE_COLORS.pause).toBeDefined();
    expect(EDGE_COLORS.loop).toBeDefined();
    expect(EDGE_COLORS.reference).toBeDefined();
    expect(EDGE_COLORS.default).toBeDefined();
  });

  it("keeps the handle CSS variables in globals.css in step with the tokens", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const type of ["image", "text", "video", "audio", "3d"] as const) {
      const match = css.match(new RegExp(`--color-handle-${type}:\\s*(#[0-9a-fA-F]{6})`));
      expect(match, `--color-handle-${type} missing from globals.css`).not.toBeNull();
      expect(match![1].toLowerCase()).toBe(HANDLE_TYPE_COLORS[type]);
    }
  });
});

describe("normalizeHandleType", () => {
  it("strips numeric suffixes", () => {
    expect(normalizeHandleType("image-0")).toBe("image");
    expect(normalizeHandleType("image-12")).toBe("image");
    expect(normalizeHandleType("video")).toBe("video");
  });

  it("maps prompt handles to text", () => {
    expect(normalizeHandleType("prompt")).toBe("text");
  });

  it("returns an empty string for missing ids", () => {
    expect(normalizeHandleType(null)).toBe("");
    expect(normalizeHandleType(undefined)).toBe("");
  });
});

describe("edgeColorKeyForHandles", () => {
  it("prefers the source handle", () => {
    expect(edgeColorKeyForHandles("image-1", "text")).toBe("image");
  });

  it("falls back to the target handle", () => {
    expect(edgeColorKeyForHandles(null, "audio")).toBe("audio");
    expect(edgeColorKeyForHandles(undefined, "prompt")).toBe("text");
  });

  it("uses default for unknown handles", () => {
    expect(edgeColorKeyForHandles("mystery", null)).toBe("default");
    expect(edgeColorKeyForHandles(null, null)).toBe("default");
  });

  it("resolves to the hex colour", () => {
    expect(edgeColorForHandles("3d", null)).toBe(HANDLE_TYPE_COLORS["3d"]);
    expect(edgeColorForHandles(null, null)).toBe(EDGE_COLORS.default);
  });
});
