import { describe, it, expect } from "vitest";
import { isImeKeyEvent } from "../keyboard";

describe("isImeKeyEvent", () => {
  it("is true mid-composition (Chrome, Firefox)", () => {
    expect(isImeKeyEvent({ nativeEvent: { isComposing: true, keyCode: 229 } })).toBe(true);
  });

  it("is true for the keydown Safari sends after ending the composition", () => {
    expect(isImeKeyEvent({ keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("is false for an ordinary key", () => {
    expect(isImeKeyEvent({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeKeyEvent({ keyCode: 27 })).toBe(false);
  });
});
