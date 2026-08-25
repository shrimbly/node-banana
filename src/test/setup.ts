import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Node 22+ ships an experimental Web Storage implementation, and Node 25 enables
// it by default. That puts a `localStorage` getter on the Node global *before*
// Vitest sets up jsdom. Vitest only copies window properties that are absent
// from the global (and `localStorage` is not in its forced-override list), so
// jsdom's real Storage never lands on the global and every `localStorage.getItem`
// call hits Node's stub, which is unusable without `--localstorage-file`.
// Re-point the global at the jsdom window's Storage so tests see a spec-shaped API.
function useJsdomWebStorage(): void {
  const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window;
  if (!jsdomWindow) return;

  for (const key of ["localStorage", "sessionStorage"] as const) {
    if (typeof globalThis[key]?.getItem === "function") continue;
    Object.defineProperty(globalThis, key, {
      value: jsdomWindow[key],
      configurable: true,
      writable: true,
    });
  }
}

useJsdomWebStorage();

// Mock ResizeObserver for React Flow tests
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

global.ResizeObserver = ResizeObserverMock;

// Mock DOMMatrixReadOnly for React Flow
class DOMMatrixReadOnlyMock {
  m22: number = 1;
  constructor() {
    this.m22 = 1;
  }
}

global.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as unknown as typeof DOMMatrixReadOnly;

// Cleanup after each test to ensure DOM is reset
afterEach(() => {
  cleanup();
});
