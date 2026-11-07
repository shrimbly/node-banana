import type { StoreApi } from "zustand";

/**
 * Puts a zustand store's own actions back after a test that spied on one. set() copies the spied action into every
 * later state object, and vi.restoreAllMocks restores only the object it patched, so the next test's vi.spyOn would
 * get the old spy, with its calls.
 */
export function restoreStoreActions<T extends object>(store: Pick<StoreApi<T>, "getInitialState" | "setState">): void {
  const initial = store.getInitialState();
  const actions = Object.entries(initial).filter(([, value]) => typeof value === "function");
  store.setState(Object.fromEntries(actions) as Partial<T>);
}
