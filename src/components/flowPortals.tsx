"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore, type ReactFlowState } from "@xyflow/react";

/**
 * React Flow's <ViewportPortal> and <EdgeLabelRenderer>, rendering into the
 * same containers. React Flow's own find their container with
 * domNode.querySelector inside a store selector, so every instance searches
 * the canvas on every store update, which is every frame of a pan or drag.
 * The viewport portal is the viewport's last child, so each search visits
 * every node and edge first; with an edge label per edge, the searches cost
 * more than the edges. Here the container is looked up once per canvas and
 * looked up again only if it has left the document.
 */
const containers = new WeakMap<HTMLElement, Map<string, Element>>();

function container(domNode: HTMLElement | null, selector: string): Element | null {
  if (!domNode) return null;
  let found = containers.get(domNode);
  if (!found) containers.set(domNode, (found = new Map()));
  let element = found.get(selector);
  if (!element?.isConnected) {
    element = domNode.querySelector(selector) ?? undefined;
    if (element) found.set(selector, element);
    else found.delete(selector);
  }
  return element ?? null;
}

const selectViewportPortal = (state: ReactFlowState) => container(state.domNode, ".react-flow__viewport-portal");
const selectEdgeLabelRenderer = (state: ReactFlowState) => container(state.domNode, ".react-flow__edgelabel-renderer");

export function ViewportPortal({ children }: { children: ReactNode }) {
  const target = useStore(selectViewportPortal);
  return target ? createPortal(children, target) : null;
}

export function EdgeLabelRenderer({ children }: { children: ReactNode }) {
  const target = useStore(selectEdgeLabelRenderer);
  return target ? createPortal(children, target) : null;
}
