import { describe, expect, it } from "vitest";

/**
 * Guards the jsdom Web Storage repair in src/test/setup.ts. Without it, Node's
 * own experimental `localStorage` global (on by default from Node 25) shadows
 * jsdom's, and every production module that reads storage at import time dies
 * with "localStorage.getItem is not a function".
 */
describe("test environment web storage", () => {
  it("exposes a spec-shaped Storage on the global", () => {
    for (const storage of [localStorage, sessionStorage]) {
      expect(typeof storage.getItem).toBe("function");
      expect(typeof storage.setItem).toBe("function");
      expect(typeof storage.removeItem).toBe("function");
      expect(typeof storage.clear).toBe("function");
      expect(typeof storage.key).toBe("function");
      expect(typeof storage.length).toBe("number");
    }
  });

  it("round-trips values through the global localStorage", () => {
    localStorage.setItem("node-banana-storage-probe", "stored");
    expect(localStorage.getItem("node-banana-storage-probe")).toBe("stored");

    localStorage.removeItem("node-banana-storage-probe");
    expect(localStorage.getItem("node-banana-storage-probe")).toBeNull();
  });

  it("keeps window and global storage pointing at the same object", () => {
    expect(window.localStorage).toBe(globalThis.localStorage);
  });
});
