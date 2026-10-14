import { describe, expect, it } from "vitest";
import { dimClassName, dimOpacities, SKIPPED_OPACITY, SWITCH_DIMMED_OPACITY } from "../dimming";

describe("dimming", () => {
  const dimmed = new Set(["a", "both", "sw"]), skipped = new Set(["b", "both"]);
  const types: Record<string, string> = { a: "prompt", b: "nanoBanana", both: "output", sw: "switch" };

  it("gives a node classic's classes, never a switch", () => {
    expect(dimClassName("a", "prompt", dimmed, skipped)).toBe("switch-dimmed");
    expect(dimClassName("b", "nanoBanana", dimmed, skipped)).toBe("node-skipped");
    expect(dimClassName("both", "output", dimmed, skipped)).toBe("switch-dimmed node-skipped");
    expect(dimClassName("sw", "switch", dimmed, skipped)).toBeUndefined();
    expect(dimClassName("c", "prompt", dimmed, skipped)).toBeUndefined();
  });

  it("gives the scene the opacity those classes show, skipped winning", () => {
    expect(dimOpacities((id) => types[id], dimmed, skipped)).toEqual(new Map([["a", SWITCH_DIMMED_OPACITY], ["b", SKIPPED_OPACITY], ["both", SKIPPED_OPACITY]]));
  });
});
