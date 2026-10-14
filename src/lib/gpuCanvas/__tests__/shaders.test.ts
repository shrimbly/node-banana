import { describe, expect, it } from "vitest";
import { pixelSnap, SCENE_SHADERS } from "../scene";

// GLSL ES 3.00 keywords and reserved words (spec §3.6) that read like ordinary
// names. Using one as an identifier fails the shader's compile, and the scene
// then draws nothing of what it shades.
const RESERVED = [
  "active", "input", "output", "filter", "sample", "common", "partition", "attribute", "varying",
  "coherent", "volatile", "restrict", "readonly", "writeonly", "resource", "patch", "subroutine",
  "asm", "class", "union", "enum", "typedef", "template", "this", "goto", "inline", "noinline",
  "public", "static", "extern", "external", "interface", "long", "short", "double", "half", "fixed",
  "unsigned", "superp", "sizeof", "cast", "namespace", "using",
];

describe("scene shaders", () => {
  it("use no GLSL ES 3.00 reserved word as a name", () => {
    for (const [name, source] of Object.entries(SCENE_SHADERS)) {
      const code = source.replace(/\/\/.*$/gm, "");
      const used = RESERVED.filter((word) => new RegExp(`\\b${word}\\b`).test(code));
      expect(used, name).toEqual([]);
    }
  });
});

describe("pixelSnap", () => {
  it("moves a node onto the nearest whole css pixel, in flow units", () => {
    // 10.3 * 2 + 0.25 = 20.85 css px: up 0.15 px, 0.075 flow units.
    expect(pixelSnap(10.3, 2, 0.25)).toBeCloseTo(0.075);
    // 10.1 * 1 + 0.2 = 10.3 css px: down 0.3 px.
    expect(pixelSnap(10.1, 1, 0.2)).toBeCloseTo(-0.3);
    expect(pixelSnap(12, 1, 3)).toBe(0);
  });
});
