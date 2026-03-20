import { useSyncExternalStore, useCallback } from "react";

const INLINE_PARAMS_KEY = "node-banana-inline-parameters";

// Subscribers for reactive updates
const subscribers = new Set<() => void>();

// Get current value from localStorage
function getSnapshot(): boolean {
  try {
    const value = localStorage.getItem(INLINE_PARAMS_KEY);
    // Default to true (inline) when not explicitly set
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

// Server-side snapshot (default to true to match client)
function getServerSnapshot(): boolean {
  return true;
}

// Subscribe to changes
function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

// Notify all subscribers of changes
function notifySubscribers() {
  subscribers.forEach((callback) => callback());
}

export function useInlineParameters() {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setInlineParameters = useCallback((value: boolean) => {
    try {
      localStorage.setItem(INLINE_PARAMS_KEY, String(value));
    } catch {
      // localStorage not available
    }
    notifySubscribers();
  }, []);

  return { inlineParametersEnabled: enabled, setInlineParameters };
}
