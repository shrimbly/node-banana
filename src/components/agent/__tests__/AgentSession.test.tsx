/**
 * The page's agent session: one conversation for every surface that shows it,
 * harness checks only while one does, and the trips back to the canvas.
 *
 * Runs against the real workflow and asset stores; the routes are faked at
 * fetch, the chat route with a real UI message stream (as AgentPanel.test does).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { AgentHarnessStatus, AgentUIMessage } from "@/lib/agent/types";

const snapshot = vi.hoisted(() => ({ nodes: [], edges: [], groups: [], selectedNodeIds: [] }));
vi.mock("@/lib/agent/graph/snapshot", () => ({ buildAgentSnapshot: vi.fn(() => snapshot) }));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));

import { AgentPanel } from "@/components/agent/AgentPanel";
import { AgentSessionProvider, useAgentSession, type AgentSessionValue } from "@/components/agent/AgentSession";
import { useToast } from "@/components/Toast";
import { AGENT_HISTORY_KEY, type AgentConversation } from "@/lib/agent/client/history";
import { AGENT_SETTINGS_KEY } from "@/lib/agent/client/settings";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";

function harnessStatus(id: "claude" | "codex"): AgentHarnessStatus {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    installed: true,
    signedIn: true,
    billing: "subscription",
    account: { email: "me@example.com", plan: "max" },
    models: [{ id: id === "claude" ? "sonnet" : "gpt-5.6-luna", label: id === "claude" ? "Sonnet" : "GPT-5.6 Luna", isDefault: true }],
    signIn: { state: "idle" },
  };
}

let chatChunks: Array<Array<Record<string, unknown>>>;
/** When set, the chat route answers only once it settles (the turn stays running). */
let chatGate: Promise<void> | undefined;
let chatSignals: AbortSignal[];

function sse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/agent/status")) {
    return new Response(JSON.stringify({ harnesses: [harnessStatus("claude"), harnessStatus("codex")] }), { status: 200 });
  }
  if (url.startsWith("/api/agent/prompt-notes")) return new Response(JSON.stringify({ notes: null }), { status: 200 });
  if (url === "/api/agent/chat") {
    if (init?.signal) chatSignals.push(init.signal);
    const gate = chatGate;
    chatGate = undefined;
    if (gate) await gate;
    return sse(chatChunks.shift() ?? []);
  }
  throw new Error(`unexpected fetch ${url}`);
});

const statusChecks = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/agent/status")).length;

function reply(text: string) {
  return [
    { type: "start", messageMetadata: { harness: "claude" } },
    { type: "start-step" },
    { type: "data-agent-session", id: "session", data: { harness: "claude", sessionId: "session-1" } },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
}

function savedConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const messages: AgentUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Build a hero film" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Built the hero film." }] },
  ];
  return { id: "chat-saved", createdAt: 1, updatedAt: 2, summary: "Hero film", messages, ...overrides };
}

/** The latest session value a consumer saw, for driving it from the test. */
let session: AgentSessionValue;

/** A second surface: the conversation as another consumer of the session sees it. */
function Probe() {
  const current = useAgentSession();
  useEffect(() => {
    session = current;
  });
  const text = current.chat.messages
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join(" | ");
  return (
    <div data-testid="probe" data-chat-id={current.chat.chatId} data-draft={current.draft}>
      {text}
      <button type="button" onClick={current.newChat}>
        Probe new chat
      </button>
    </div>
  );
}

function Harness({ children }: { children?: ReactNode }) {
  return (
    <ReactFlowProvider>
      <AgentSessionProvider>
        {children}
        <Probe />
      </AgentSessionProvider>
    </ReactFlowProvider>
  );
}

const store = () => useWorkflowStore.getState();

/** Back to a single, empty, idle tab. */
function resetTabs() {
  useWorkflowStore.setState({
    isRunning: false,
    isSaving: false,
    pendingMediaSaves: 0,
    canvasViewport: null,
    tabs: [{ id: store().activeTabId, snapshot: null }],
  });
  store().clearWorkflow();
}

/** Two tabs: returns the parked one's id (the second, new tab is live). */
function openSecondTab(): string {
  const first = store().activeTabId;
  useWorkflowStore.setState({ workflowName: "First" });
  expect(store().newTab()).not.toBeNull();
  return first;
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("AgentSessionProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ harness: "claude", harnessChosen: true, models: {} }));
    chatChunks = [];
    chatGate = undefined;
    chatSignals = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    resetTabs();
    useAssetStore.setState({ appView: "canvas" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTabs();
    useAssetStore.setState({ appView: "canvas" });
    useToast.getState().hide();
  });

  it("shows one conversation to every surface: the window's draft, turns and new chat reach the other", async () => {
    chatChunks.push(reply("Added a prompt node."));
    render(
      <Harness>
        <AgentPanel open onClose={vi.fn()} buttonRight={15} buttonBottom={173} />
      </Harness>,
    );
    const textarea = (await screen.findByRole("textbox", { name: "Message the agent" })) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Add a prompt node" } });
    expect(screen.getByTestId("probe")).toHaveAttribute("data-draft", "Add a prompt node");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Add a prompt node | Added a prompt node."));
    expect(within(screen.getByTestId("agent-panel")).getByText("Added a prompt node.")).toBeInTheDocument();

    // The finished turn is saved with the workflow it ended on.
    const saved = JSON.parse(localStorage.getItem(AGENT_HISTORY_KEY) ?? "[]") as AgentConversation[];
    expect(saved[0]).toMatchObject({ id: screen.getByTestId("probe").dataset.chatId, tabId: store().activeTabId });

    // A new chat from the other surface empties the window too.
    fireEvent.click(screen.getByRole("button", { name: "Probe new chat" }));
    expect(await screen.findByText("What should we build?")).toBeInTheDocument();
    expect(screen.queryByText("Added a prompt node.")).not.toBeInTheDocument();
  });

  it("saves a turn the user stopped by opening another tab against the tab it worked on", async () => {
    const first = openSecondTab();
    useWorkflowStore.setState({ workflowName: "Second" });
    const second = store().activeTabId;
    let refuse!: (error: unknown) => void;
    chatGate = new Promise((_, reject) => (refuse = reject));
    render(<Harness />);
    act(() => {
      session.chat.send("Make it a cat");
    });
    await waitFor(() => expect(chatSignals).toHaveLength(1));
    chatSignals[0].addEventListener("abort", () => refuse(new DOMException("The operation was aborted.", "AbortError")));

    act(() => {
      store().switchTab(first);
    });
    await waitFor(() => expect(session.busy).toBe(false));
    await flushEffects();

    const saved = JSON.parse(localStorage.getItem(AGENT_HISTORY_KEY) ?? "[]") as AgentConversation[];
    expect(saved[0]).toMatchObject({ tabId: second, workflowName: "Second" });
  });

  it("saves a turn whose tab step lands after its reply with the tab that step opened", async () => {
    const live = store().activeTabId;
    const opened = `tab-ag${Date.now().toString(36)}`;
    const newTab = {
      batchId: "b-new",
      toolCallId: "call-new",
      summary: "Opened Fox",
      ops: [],
      workspace: { op: "newTab", tabId: opened, name: "Fox" },
      tabId: opened,
    };
    chatChunks.push([...reply("Opened a new workflow.").slice(0, 3), { type: "data-graph-ops", data: newTab, transient: true }, ...reply("Opened a new workflow.").slice(3)]);
    // An autosave holds the tabs: the new tab opens only after the reply has ended.
    useWorkflowStore.setState({ isSaving: true });
    render(<Harness />);
    act(() => {
      session.chat.send("Start a fox workflow");
    });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Opened a new workflow."));
    await waitFor(() => expect(session.busy).toBe(false));
    await flushEffects();
    expect(store().activeTabId).toBe(live);

    await act(async () => {
      useWorkflowStore.setState({ isSaving: false });
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(store().activeTabId).toBe(opened);
    const saved = JSON.parse(localStorage.getItem(AGENT_HISTORY_KEY) ?? "[]") as AgentConversation[];
    expect(saved[0]).toMatchObject({ tabId: opened, workflowName: "Fox" });
  });

  it("checks the harnesses only once a surface shows the agent", async () => {
    const { rerender } = render(
      <Harness>
        <AgentPanel open={false} onClose={vi.fn()} buttonRight={15} buttonBottom={173} />
      </Harness>,
    );
    await flushEffects();
    expect(statusChecks()).toBe(0);
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) ?? "{}").opened).toBeUndefined();
    expect(session.presence).toEqual({ harness: "claude", harnessChosen: true, attention: false });

    // The chat view shows the agent: the session checks, and records the open.
    act(() => useAssetStore.getState().setAppView("chat"));
    await waitFor(() => expect(statusChecks()).toBe(1));
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) ?? "{}").opened).toBe(true);
    await waitFor(() => expect(session.ready).toBe(true));

    // Back on the canvas with the window closed: no more checks. Opening the window checks again.
    act(() => useAssetStore.getState().setAppView("canvas"));
    await flushEffects();
    expect(statusChecks()).toBe(1);
    rerender(
      <Harness>
        <AgentPanel open onClose={vi.fn()} buttonRight={15} buttonBottom={173} />
      </Harness>,
    );
    await waitFor(() => expect(statusChecks()).toBe(2));
  });

  it("shows a node on the canvas: leaves the chat view and switches to its tab", async () => {
    const first = openSecondTab();
    render(<Harness />);
    act(() => useAssetStore.getState().setAppView("chat"));

    let shown = false;
    act(() => {
      shown = session.showOnCanvas({ tabId: first, nodeIds: ["prompt-1"] });
    });
    expect(shown).toBe(true);
    expect(store().activeTabId).toBe(first);
    expect(store().workflowName).toBe("First");
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("stays put, saying why, when the tab can't be shown", async () => {
    const first = openSecondTab();
    const live = store().activeTabId;
    render(<Harness />);
    act(() => useAssetStore.getState().setAppView("chat"));

    useWorkflowStore.setState({ isRunning: true });
    act(() => {
      expect(session.showOnCanvas({ tabId: first })).toBe(false);
    });
    expect(useToast.getState().message).toBe("Wait for the run to finish");
    expect(store().activeTabId).toBe(live);
    expect(useAssetStore.getState().appView).toBe("chat");

    useWorkflowStore.setState({ isRunning: false });
    act(() => {
      expect(session.showOnCanvas({ tabId: "tab-closed" })).toBe(false);
    });
    expect(useToast.getState().message).toBe("That workflow is no longer open");

    // The live tab needs no switch.
    act(() => {
      expect(session.showOnCanvas({ tabId: live })).toBe(true);
    });
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("brings back a past conversation's workflow when its tab is still open", async () => {
    const first = openSecondTab();
    localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify([savedConversation({ tabId: first })]));
    render(<Harness />);

    act(() => session.openConversation(session.conversations[0]));
    expect(store().activeTabId).toBe(first);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-chat-id", "chat-saved");
    expect(screen.getByTestId("probe")).toHaveTextContent("Built the hero film.");
  });

  it("opens a past conversation in place while the tabs are busy or its tab is gone", async () => {
    const first = openSecondTab();
    const live = store().activeTabId;
    localStorage.setItem(
      AGENT_HISTORY_KEY,
      JSON.stringify([savedConversation({ tabId: first }), savedConversation({ id: "chat-gone", updatedAt: 1, tabId: "tab-gone" })]),
    );
    render(<Harness />);

    useWorkflowStore.setState({ isSaving: true });
    act(() => session.openConversation(session.conversations.find((entry) => entry.id === "chat-saved")!));
    expect(store().activeTabId).toBe(live);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-chat-id", "chat-saved");

    useWorkflowStore.setState({ isSaving: false });
    act(() => session.openConversation(session.conversations.find((entry) => entry.id === "chat-gone")!));
    expect(store().activeTabId).toBe(live);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-chat-id", "chat-gone");
  });

  it("deleting the open conversation starts a new chat", async () => {
    localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify([savedConversation()]));
    render(<Harness />);
    act(() => session.openConversation(session.conversations[0]));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-chat-id", "chat-saved");

    act(() => session.deleteConversation("chat-saved"));
    expect(session.conversations).toEqual([]);
    expect(screen.getByTestId("probe")).not.toHaveAttribute("data-chat-id", "chat-saved");
    expect(session.chat.messages).toEqual([]);
  });

  it("stops a running turn when the page's session goes away", async () => {
    chatGate = new Promise(() => {});
    const { unmount } = render(<Harness />);
    act(() => {
      session.chat.send("hello");
    });
    await waitFor(() => expect(chatSignals).toHaveLength(1));
    expect(session.busy).toBe(true);

    unmount();
    expect(chatSignals[0].aborted).toBe(true);
  });

  it("refuses to be read outside its provider", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Probe />)).toThrow(/AgentSessionProvider/);
    } finally {
      quiet.mockRestore();
    }
  });
});
