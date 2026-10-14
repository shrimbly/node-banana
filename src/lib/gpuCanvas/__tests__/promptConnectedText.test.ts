import { describe, expect, it } from "vitest";
import { create } from "zustand";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { watchPromptConnectedText } from "../promptConnectedText";

const node = (id: string, type = "prompt", prompt = "") => ({ id, type, position: { x: 0, y: 0 }, data: { prompt } }) as unknown as WorkflowNode;
const textEdge = (id: string, source: string, target: string) => ({ id, source, target, targetHandle: "text" }) as WorkflowEdge;

interface S {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  canvasGeneration: number;
  upstream: Record<string, string>;
  getConnectedInputs: (id: string) => { text: string | null };
  updateNodeData: (id: string, data: { prompt: string }) => void;
}

function setup(nodes: WorkflowNode[], edges: WorkflowEdge[], upstream: Record<string, string> = { llm: "from llm" }) {
  const store = create<S>((set, get) => ({
    nodes,
    edges,
    canvasGeneration: 0,
    upstream,
    getConnectedInputs: (id) => {
      const edge = get().edges.find((e) => e.target === id && e.targetHandle === "text");
      return { text: edge ? get().upstream[edge.source] ?? null : null };
    },
    updateNodeData: (id, data) => set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) as WorkflowNode[] }),
  }));
  const stop = watchPromptConnectedText(store);
  const prompt = (id: string) => (store.getState().nodes.find((n) => n.id === id)?.data as { prompt: string }).prompt;
  return { store, stop, prompt };
}

describe("watchPromptConnectedText", () => {
  it("copies on start, and keeps a hand edit through later changes", () => {
    const { store, prompt } = setup([node("llm", "llmGenerate"), node("p", "prompt", "old")], [textEdge("e", "llm", "p")]);
    expect(prompt("p")).toBe("from llm");
    store.getState().updateNodeData("p", { prompt: "edited" });
    store.setState({ upstream: { llm: "newer" } });
    store.setState({ edges: [...store.getState().edges] });
    expect(prompt("p")).toBe("edited");
  });

  it("copies when a connection arrives at an unmounted node", () => {
    const { store, prompt } = setup([node("llm", "llmGenerate"), node("p", "prompt", "old")], []);
    expect(prompt("p")).toBe("old");
    store.setState({ edges: [textEdge("e", "llm", "p")] });
    expect(prompt("p")).toBe("from llm");
  });

  it("copies again when the canvas is replaced, and stops when unsubscribed", () => {
    const { store, stop, prompt } = setup([node("llm", "llmGenerate"), node("p", "prompt")], [textEdge("e", "llm", "p")]);
    store.getState().updateNodeData("p", { prompt: "edited" });
    store.setState({ canvasGeneration: 1, nodes: [node("llm", "llmGenerate"), node("p", "prompt", "saved")] });
    expect(prompt("p")).toBe("from llm");
    stop();
    store.setState({ edges: [], nodes: [...store.getState().nodes] });
    store.setState({ edges: [textEdge("e2", "llm", "p")] });
    store.getState().updateNodeData("p", { prompt: "edited" });
    store.setState({ canvasGeneration: 2 });
    expect(prompt("p")).toBe("edited");
  });

  it("leaves the prompt when the connected text is empty", () => {
    const { prompt } = setup([node("llm", "llmGenerate"), node("p", "prompt", "mine")], [textEdge("e", "llm", "p")], {});
    expect(prompt("p")).toBe("mine");
  });
});
