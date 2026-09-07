import type { WorkflowNode, WorkflowEdge, NodeGroup, EdgeStyle, EdgeAppearance } from "@/types";

export interface UndoSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  edgeStyle: EdgeStyle;
  edgeAppearance: EdgeAppearance;
}

const MAX_HISTORY = 50;

export class UndoManager {
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Read-only media ownership view; undo and redo both keep these nodes alive. */
  get retainedNodes(): readonly WorkflowNode[] {
    return [...this.undoStack, ...this.redoStack].flatMap((snapshot) => snapshot.nodes);
  }

  push(snapshot: UndoSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(currentState: UndoSnapshot): UndoSnapshot | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(currentState);
    return previous;
  }

  redo(currentState: UndoSnapshot): UndoSnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(currentState);
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * Deep-clone that preserves string references.
 *
 * Objects and arrays get new containers so mutations don't leak between
 * snapshots, but strings (immutable in JS) are returned by reference.
 * This avoids duplicating multi-MB base64 blobs across undo history.
 *
 * Matches JSON.parse(JSON.stringify()) semantics for plain JSON-like
 * objects/arrays:
 *  - `undefined` values are dropped from objects, become `null` in arrays
 *  - functions are dropped from objects, become `null` in arrays
 *
 * Does NOT call toJSON() on objects. Objects with custom toJSON methods
 * are treated as plain objects (their enumerable own properties are cloned).
 */
export function clonePreservingStrings<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    // Primitives (string, number, boolean, null) returned directly.
    // Strings share the reference — this is the whole point.
    return value;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const elem = value[i];
      // Match JSON behavior: undefined & functions become null in arrays
      if (elem === undefined || typeof elem === "function") {
        result[i] = null;
      } else {
        result[i] = clonePreservingStrings(elem);
      }
    }
    return result as T;
  }

  // Plain object
  const result: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const val = (value as Record<string, unknown>)[key];
    // Match JSON behavior: skip undefined & functions in objects
    if (val === undefined || typeof val === "function") continue;
    result[key] = clonePreservingStrings(val);
  }
  return result as T;
}
