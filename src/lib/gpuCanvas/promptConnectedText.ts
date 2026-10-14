/**
 * A Prompt node with a text connection copies the connected text into its
 * prompt when it mounts and when the connection arrives (PromptNode's own
 * effect does this on today's canvas, where every node stays mounted); after
 * that the prompt is the user's to edit until a run copies it again. On the
 * GPU canvas a node mounts as a live component only while it is worked in,
 * and its painted copies write nothing, so that effect would copy on every
 * hover and miss connections made while the node is a picture. The canvas
 * watches the store instead: each Prompt node's text connection is tracked,
 * and the text is copied when the canvas is opened or replaced, when a
 * connected Prompt node appears, and when a connection arrives.
 */
import type { WorkflowEdge, WorkflowNode } from "@/types";

interface PromptTextState {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  canvasGeneration: number;
  getConnectedInputs: (nodeId: string) => { text: string | null };
  updateNodeData: (nodeId: string, data: { prompt: string }) => void;
}

interface PromptTextStore {
  getState: () => PromptTextState;
  subscribe: (listener: (state: PromptTextState, previous: PromptTextState) => void) => () => void;
}

/** Each Prompt node, and whether it has a connection into its text socket. */
function connected(state: PromptTextState): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const node of state.nodes) if (node.type === "prompt") map.set(node.id, false);
  for (const edge of state.edges) {
    if (edge.targetHandle === "text" && map.has(edge.target)) map.set(edge.target, true);
  }
  return map;
}

function copy(state: PromptTextState, id: string) {
  const { text } = state.getConnectedInputs(id);
  if (text === null) return;
  const node = state.nodes.find((n) => n.id === id);
  if ((node?.data as { prompt?: string } | undefined)?.prompt === text) return;
  state.updateNodeData(id, { prompt: text });
}

/** Copies connected text into Prompt nodes as classic's mounted nodes do; returns the unsubscribe. */
export function watchPromptConnectedText(store: PromptTextStore): () => void {
  let known = connected(store.getState());
  // The canvas opening counts as every node mounting.
  for (const [id, isConnected] of known) if (isConnected) copy(store.getState(), id);
  return store.subscribe((state, previous) => {
    // Nodes matter only as they come and go (typing must not walk the graph).
    const nodesChanged = state.nodes !== previous.nodes && state.nodes.length !== previous.nodes.length;
    const replaced = state.canvasGeneration !== previous.canvasGeneration;
    if (state.edges === previous.edges && !nodesChanged && !replaced) return;
    const before = known;
    known = connected(state);
    for (const [id, isConnected] of known) {
      if (isConnected && (replaced || !before.get(id))) copy(store.getState(), id);
    }
  });
}
