import { describe, expect, it } from "vitest";
import { editViewKeyAction } from "../editViewKeys";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("editViewKeyAction", () => {
  it("E goes back to the canvas, A to Assets, C to the chat, ? to the shortcuts", () => {
    expect(editViewKeyAction(key("e"))).toBe("canvas");
    expect(editViewKeyAction(key("E"))).toBe("canvas");
    expect(editViewKeyAction(key("a"))).toBe("assets");
    expect(editViewKeyAction(key("c"))).toBe("chat");
    expect(editViewKeyAction(key("?", { shiftKey: true }))).toBe("shortcuts");
  });

  it("is never a modified letter, nor any other key", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(editViewKeyAction(key("e", { [mod]: true }))).toBeNull();
    }
    expect(editViewKeyAction(key("?", { metaKey: true }))).toBeNull();
    expect(editViewKeyAction(key("s"))).toBeNull();
    expect(editViewKeyAction(key("Escape"))).toBeNull();
  });
});
