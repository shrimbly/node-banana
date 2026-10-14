"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowEdge } from "@/types";

/**
 * Which sockets have a connection, for a React Flow that does not hold every
 * edge: the GPU canvas's painter sheet holds none and its live layer only the
 * connections it decorates, so React Flow's own connection lookup would show
 * most connected sockets hollow. Keys are React Flow's own
 * (`node-type-handle`, and `node-type` for any handle). Absent on the classic
 * canvas, where React Flow's lookup holds every edge.
 */
const SocketConnectionsContext = createContext<ReadonlySet<string> | null>(null);

const keysByEdges = new WeakMap<readonly WorkflowEdge[], ReadonlySet<string>>();

/** The connection keys of every socket the edges end at, as React Flow's connection lookup keys them. */
export function socketConnectionKeys(edges: readonly WorkflowEdge[]): ReadonlySet<string> {
  let keys = keysByEdges.get(edges);
  if (!keys) {
    const set = new Set<string>();
    for (const edge of edges) {
      set.add(`${edge.source}-source`);
      if (edge.sourceHandle) set.add(`${edge.source}-source-${edge.sourceHandle}`);
      set.add(`${edge.target}-target`);
      if (edge.targetHandle) set.add(`${edge.target}-target-${edge.targetHandle}`);
    }
    keys = set;
    keysByEdges.set(edges, keys);
  }
  return keys;
}

/** Sockets inside show the workflow store's connections, whatever edges their React Flow holds. */
export function StoreSocketConnections({ children }: { children: ReactNode }) {
  const edges = useWorkflowStore((state) => state.edges);
  const keys = useMemo(() => socketConnectionKeys(edges), [edges]);
  return <SocketConnectionsContext.Provider value={keys}>{children}</SocketConnectionsContext.Provider>;
}

/** The provided socket connections, or null to read React Flow's lookup. */
export function useSocketConnections(): ReadonlySet<string> | null {
  return useContext(SocketConnectionsContext);
}
