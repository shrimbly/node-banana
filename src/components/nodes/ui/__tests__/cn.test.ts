import { describe, it, expect } from "vitest";
import { cn } from "../cn";

describe("cn", () => {
  it("keeps the node font size next to a text colour", () => {
    expect(cn("text-node text-neutral-200")).toBe("text-node text-neutral-200");
    expect(cn("text-neutral-400", "text-node")).toBe("text-neutral-400 text-node");
  });

  it("lets a later font size replace text-node", () => {
    expect(cn("text-node text-xs")).toBe("text-xs");
  });

  it("treats the radius and shadow tokens as radius and shadow", () => {
    expect(cn("rounded-well rounded-md")).toBe("rounded-md");
    expect(cn("shadow-well shadow-lg")).toBe("shadow-lg");
    expect(cn("shadow-well shadow-selection/25")).toBe("shadow-well shadow-selection/25");
  });

  it("still lets later colours win", () => {
    expect(cn("border-card-border border-error")).toBe("border-error");
  });
});
