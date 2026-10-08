/**
 * The full-page chat view in jsdom: the empty state, a turn, the sidebar of
 * past conversations, the workflow switcher, the way back to the canvas and
 * the view's keys.
 *
 * Runs on the real workflow and asset stores and the page's agent session;
 * the routes are faked at fetch, the chat route with a real UI message stream
 * (as AgentPanel.test does).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
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

import { AgentChatView } from "@/components/agent/AgentChatView";
import {
  CHAT_SIDEBAR_KEY,
  filterConversations,
  groupConversations,
} from "@/components/agent/AgentChatSidebar";
import { AgentSessionProvider } from "@/components/agent/AgentSession";
import { describeSwitcherTab } from "@/components/agent/AgentWorkflowSwitcher";
import { useToast } from "@/components/Toast";
import { AGENT_HISTORY_KEY, type AgentConversation } from "@/lib/agent/client/history";
import { AGENT_SETTINGS_KEY } from "@/lib/agent/client/settings";
import { useAssetStore } from "@/store/assetStore";
import { useSaveRequestStore } from "@/store/saveRequestStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";

// ---------------------------------------------------------------------------
// Fake routes
// ---------------------------------------------------------------------------

function harnessStatus(id: "claude" | "codex", overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    installed: true,
    signedIn: true,
    billing: "subscription",
    account: { email: "me@example.com", plan: id === "claude" ? "max" : "plus" },
    models:
      id === "claude"
        ? [
            { id: "sonnet", label: "Sonnet", isDefault: true },
            { id: "opus", label: "Opus" },
          ]
        : [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: true }],
    signIn: { state: "idle" },
    signInCommand: id === "claude" ? "claude auth login" : "codex login",
    ...overrides,
  };
}

let statuses: Record<"claude" | "codex", AgentHarnessStatus>;
let chatBodies: Array<Record<string, unknown>>;
let chatChunks: Array<Array<Record<string, unknown>>>;
/** When set, the chat route answers only once it settles (the turn stays running). */
let chatGate: Promise<void> | undefined;

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
    const only = new URL(url, "http://localhost").searchParams.get("harness") as "claude" | "codex" | null;
    const harnesses = only ? [statuses[only]] : [statuses.claude, statuses.codex];
    return new Response(JSON.stringify({ harnesses }), { status: 200 });
  }
  if (url.startsWith("/api/agent/prompt-notes")) return new Response(JSON.stringify({ notes: null }), { status: 200 });
  if (url === "/api/agent/chat") {
    chatBodies.push(JSON.parse(String(init?.body)));
    const gate = chatGate;
    chatGate = undefined;
    if (gate) await gate;
    return sse(chatChunks.shift() ?? []);
  }
  throw new Error(`unexpected fetch ${url}`);
});

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

function savedConversation(overrides: Partial<AgentConversation> & { text?: string } = {}): AgentConversation {
  const { text = "Built the hero film.", ...rest } = overrides;
  const messages: AgentUIMessage[] = [
    { id: `u-${rest.id ?? "saved"}`, role: "user", parts: [{ type: "text", text: "Build a hero film" }] },
    { id: `a-${rest.id ?? "saved"}`, role: "assistant", parts: [{ type: "text", text }] },
  ];
  return { id: "chat-saved", createdAt: 1, updatedAt: Date.now(), summary: "Hero film", messages, ...rest };
}

function promptNode(id: string): WorkflowNode {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "" } } as unknown as WorkflowNode;
}

// ---------------------------------------------------------------------------

/** The view as the page mounts it: inside React Flow and the agent session, while the chat is shown. */
function Harness({ children }: { children?: ReactNode }) {
  return (
    <ReactFlowProvider>
      <AgentSessionProvider>{children ?? <AgentChatView />}</AgentSessionProvider>
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

async function waitForComposer() {
  return (await screen.findByRole("textbox", { name: "Message the agent" })) as HTMLTextAreaElement;
}

function send(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

const view = () => screen.getByRole("region", { name: "Chat" });
const sidebar = () => screen.getByRole("navigation", { name: "Chats" });

/** Opens a header menu (Radix opens it from the keyboard in jsdom). */
function openMenu(name: RegExp) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
  return screen.getByRole("menu");
}

describe("AgentChatView", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ harness: "claude", harnessChosen: true, models: {} }));
    statuses = { claude: harnessStatus("claude"), codex: harnessStatus("codex") };
    chatBodies = [];
    chatChunks = [];
    chatGate = undefined;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    resetTabs();
    useAssetStore.setState({ appView: "chat" });
    useSaveRequestStore.setState({ request: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTabs();
    useAssetStore.setState({ appView: "canvas" });
    useToast.getState().hide();
  });

  it("is a page surface with the agent's scoped theme, and puts the cursor in the message box", async () => {
    render(<Harness />);
    expect(view()).toHaveAttribute("data-agent-surface", "page");
    expect(view().className).toContain("nb-agent");
    const textarea = await waitForComposer();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  describe("empty conversation", () => {
    it("asks what to make, says it builds from scratch on an empty canvas, and offers suggestions", async () => {
      render(<Harness />);
      await waitForComposer();
      expect(screen.getByRole("heading", { name: "What should we make?" })).toBeInTheDocument();
      expect(screen.getByText("Describe a workflow and the agent builds it")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Build a text-to-image workflow" })).toBeInTheDocument();
      expect(view().querySelectorAll("[data-agent-suggestion]")).toHaveLength(4);
      expect(screen.getByText(/Runs on your paid Claude subscription's usage limits/)).toBeInTheDocument();
    });

    it("names the live workflow it will work in", async () => {
      useWorkflowStore.setState({ workflowName: "Product shots", nodes: [promptNode("p1"), promptNode("p2")] });
      render(<Harness />);
      await waitForComposer();
      const lead = screen.getByText(/^Working in/);
      expect(lead).toHaveTextContent("Working in Product shots · 2 nodes");
      expect(screen.getByRole("button", { name: "Explain what this workflow does" })).toBeInTheDocument();
    });

    it("sends a suggestion card, keeping the cursor in the message box as it docks", async () => {
      chatChunks.push(reply("Here is your workflow."));
      render(<Harness />);
      const textarea = await waitForComposer();
      fireEvent.click(screen.getByRole("button", { name: "Build a text-to-image workflow" }));
      expect(await screen.findByText("Here is your workflow.")).toBeInTheDocument();
      expect(JSON.stringify(chatBodies[0])).toContain("Build a text-to-image workflow");
      // The same box, now under the transcript.
      expect(await waitForComposer()).toBe(textarea);
      await waitFor(() => expect(document.activeElement).toBe(textarea));
      expect(screen.queryByRole("heading", { name: "What should we make?" })).not.toBeInTheDocument();
    });
  });

  it("shows the user's message as a bubble and the reply under it", async () => {
    chatChunks.push(reply("All set."));
    render(<Harness />);
    const textarea = await waitForComposer();
    send(textarea, "Make me a moodboard");

    const transcript = await screen.findByRole("log");
    const bubble = await within(transcript).findByText("Make me a moodboard");
    expect(bubble.closest(".is-user")).not.toBeNull();
    expect(bubble.className).toContain("rounded-[20px]");
    expect(await within(transcript).findByText("All set.")).toBeInTheDocument();
    // The billing line stays under the docked box.
    expect(screen.getByText(/Runs on your paid Claude subscription's usage limits/)).toBeInTheDocument();
  });

  it("shows the sign-in card in the main column while the harness is signed out", async () => {
    statuses.claude = harnessStatus("claude", { signedIn: false, billing: "none" });
    render(<Harness />);
    expect(await screen.findByRole("button", { name: "Open Claude Code sign-in" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message the agent" })).not.toBeInTheDocument();
    // Nothing to send yet: the view holds the focus, so its keys still work.
    expect(document.activeElement).toBe(view());
  });

  describe("sidebar", () => {
    it("lists past conversations by day, with the workflow and when", async () => {
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const lastWeek = new Date(now);
      lastWeek.setDate(now.getDate() - 4);
      localStorage.setItem(
        AGENT_HISTORY_KEY,
        JSON.stringify([
          savedConversation({ id: "c-today", summary: "Hero film", workflowName: "Espresso", updatedAt: now.getTime() }),
          savedConversation({ id: "c-yesterday", summary: "Moodboard", updatedAt: yesterday.getTime() }),
          savedConversation({ id: "c-week", summary: "Logo pass", updatedAt: lastWeek.getTime() }),
          savedConversation({ id: "c-old", summary: "Old one", updatedAt: new Date(2020, 0, 5).getTime() }),
        ]),
      );
      render(<Harness />);
      await waitForComposer();

      const groups = within(sidebar()).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
      expect(groups).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
      const today = within(sidebar()).getByRole("group", { name: "Today" });
      expect(within(today).getByRole("button", { name: /^Hero film/ })).toHaveTextContent("Espresso · Just now");
      expect(within(within(sidebar()).getByRole("group", { name: "Older" })).getByText("Old one")).toBeInTheDocument();
    });

    it("says when there are no chats yet", async () => {
      render(<Harness />);
      await waitForComposer();
      expect(within(sidebar()).getByText("No chats yet")).toBeInTheDocument();
    });

    it("filters by label and by workflow name, and Escape clears the search without leaving", async () => {
      localStorage.setItem(
        AGENT_HISTORY_KEY,
        JSON.stringify([
          savedConversation({ id: "c-1", summary: "Hero film", workflowName: "Espresso" }),
          savedConversation({ id: "c-2", summary: "Moodboard", workflowName: "Autumn" }),
        ]),
      );
      render(<Harness />);
      await waitForComposer();
      const search = within(sidebar()).getByRole("textbox", { name: "Search chats" });

      fireEvent.change(search, { target: { value: "mood" } });
      expect(within(sidebar()).queryByText("Hero film")).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Moodboard")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "espresso" } });
      expect(within(sidebar()).getByText("Hero film")).toBeInTheDocument();
      expect(within(sidebar()).queryByText("Moodboard")).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: "nothing like it" } });
      expect(within(sidebar()).getByText("No matches")).toBeInTheDocument();

      fireEvent.keyDown(search, { key: "Escape" });
      expect(search).toHaveValue("");
      expect(within(sidebar()).getByText("Moodboard")).toBeInTheDocument();
      expect(useAssetStore.getState().appView).toBe("chat");
    });

    it("opens a past conversation and marks it current", async () => {
      localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify([savedConversation()]));
      render(<Harness />);
      await waitForComposer();

      fireEvent.click(within(sidebar()).getByRole("button", { name: /^Hero film/ }));
      expect(await screen.findByText("Built the hero film.")).toBeInTheDocument();
      expect(within(sidebar()).getByRole("button", { name: /^Hero film/ })).toHaveAttribute("aria-current", "true");
    });

    it("deletes a conversation only once confirmed", async () => {
      localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify([savedConversation()]));
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<Harness />);
      await waitForComposer();

      fireEvent.click(within(sidebar()).getByRole("button", { name: "Delete “Hero film”" }));
      expect(confirm).toHaveBeenCalledWith("Delete “Hero film”? This can't be undone.");
      expect(within(sidebar()).getByText("Hero film")).toBeInTheDocument();

      confirm.mockReturnValue(true);
      fireEvent.click(within(sidebar()).getByRole("button", { name: "Delete “Hero film”" }));
      expect(within(sidebar()).queryByText("Hero film")).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(AGENT_HISTORY_KEY) ?? "[]")).toEqual([]);
    });

    it("locks the other conversations while a turn runs", async () => {
      localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify([savedConversation()]));
      let answer!: () => void;
      chatGate = new Promise((resolve) => (answer = resolve));
      chatChunks.push(reply("Working on it."));
      render(<Harness />);
      send(await waitForComposer(), "Start something");
      await screen.findByRole("button", { name: "Stop" });

      const row = within(sidebar()).getByRole("button", { name: /^Hero film/ });
      expect(row).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(row);
      expect(screen.queryByText("Built the hero film.")).not.toBeInTheDocument();

      answer();
      expect(await screen.findByText("Working on it.")).toBeInTheDocument();
      await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /^Hero film/ })).not.toHaveAttribute("aria-disabled"));
    });

    it("starts a new chat once the current one has messages", async () => {
      chatChunks.push(reply("First reply."));
      render(<Harness />);
      const textarea = await waitForComposer();
      const newChat = within(sidebar()).getByRole("button", { name: "New chat" });
      expect(newChat).toBeDisabled();

      send(textarea, "hi");
      await screen.findByText("First reply.");
      fireEvent.click(within(sidebar()).getByRole("button", { name: "New chat" }));
      expect(screen.queryByText("First reply.")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "What should we make?" })).toBeInTheDocument();
      // The finished chat is in the list now.
      expect(within(sidebar()).getByRole("button", { name: /^hi/ })).toBeInTheDocument();
    });

    it("collapses to a rail and remembers it", async () => {
      const { unmount } = render(<Harness />);
      await waitForComposer();
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(screen.queryByRole("textbox", { name: "Search chats" })).not.toBeInTheDocument();
      expect(within(sidebar()).getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
      expect(within(sidebar()).getByRole("button", { name: "New chat" })).toBeDisabled();
      expect(localStorage.getItem(CHAT_SIDEBAR_KEY)).toBe("collapsed");

      unmount();
      render(<Harness />);
      await waitForComposer();
      expect(within(sidebar()).getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
      fireEvent.click(within(sidebar()).getByRole("button", { name: "Expand sidebar" }));
      expect(screen.getByRole("textbox", { name: "Search chats" })).toBeInTheDocument();
      expect(localStorage.getItem(CHAT_SIDEBAR_KEY)).toBe("open");
    });

    it("shows who answers at its foot", async () => {
      render(<Harness />);
      await waitForComposer();
      expect(within(sidebar()).getByText("Max · Sonnet")).toBeInTheDocument();
    });
  });

  describe("header", () => {
    /** Two tabs: the first ("First", two nodes) parked, the second (untitled, empty) live. */
    function openSecondTab(): string {
      const first = store().activeTabId;
      useWorkflowStore.setState({ workflowName: "First", nodes: [promptNode("p1"), promptNode("p2")], hasUnsavedChanges: true });
      expect(store().newTab()).not.toBeNull();
      return first;
    }

    it("lists the open workflows and switches to one, staying in the chat", async () => {
      const first = openSecondTab();
      render(<Harness />);
      await waitForComposer();
      expect(screen.getByRole("button", { name: /Switch workflow/ })).toHaveAccessibleName("Untitled. Switch workflow");

      const menu = openMenu(/Switch workflow/);
      const rows = within(menu).getAllByRole("menuitem");
      expect(rows.map((row) => row.textContent)).toEqual(["First2 nodes · Unsaved", "UntitledEmpty", "New workflow"]);
      expect(rows[1]).toHaveAttribute("aria-current", "true");

      fireEvent.click(rows[0]!);
      expect(store().activeTabId).toBe(first);
      expect(store().workflowName).toBe("First");
      expect(useAssetStore.getState().appView).toBe("chat");
      expect(screen.getByRole("button", { name: /Switch workflow/ })).toHaveAccessibleName("First (unsaved). Switch workflow");
    });

    it("opens a new workflow from the switcher", async () => {
      render(<Harness />);
      await waitForComposer();
      fireEvent.click(within(openMenu(/Switch workflow/)).getByRole("menuitem", { name: "New workflow" }));
      expect(store().tabs).toHaveLength(2);
      expect(useAssetStore.getState().appView).toBe("chat");
    });

    it("refuses to change workflow while a turn runs, saying why", async () => {
      openSecondTab();
      const live = store().activeTabId;
      chatGate = new Promise(() => {});
      render(<Harness />);
      send(await waitForComposer(), "Keep going");
      await screen.findByRole("button", { name: "Stop" });

      const menu = openMenu(/Switch workflow/);
      expect(within(menu).getByText("Wait for the agent to finish")).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: /^First/ })).toHaveAttribute("aria-disabled", "true");
      expect(within(menu).getByRole("menuitem", { name: "New workflow" })).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(within(menu).getByRole("menuitem", { name: /^First/ }));
      expect(store().activeTabId).toBe(live);
    });

    it("refuses while a run holds the tabs", async () => {
      openSecondTab();
      render(<Harness />);
      await waitForComposer();
      act(() => useWorkflowStore.setState({ isRunning: true }));
      const menu = openMenu(/Switch workflow/);
      expect(within(menu).getByText("Wait for the run to finish")).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: /^First/ })).toHaveAttribute("aria-disabled", "true");
    });

    it("carries the window's harness and model picker", async () => {
      render(<Harness />);
      await waitForComposer();
      expect(screen.getByRole("button", { name: /Change agent or model/ })).toHaveAccessibleName(
        "Claude Code, Sonnet. Change agent or model",
      );
      const menu = openMenu(/Change agent or model/);
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Opus/ }));
      expect(screen.getByRole("button", { name: /Change agent or model/ })).toHaveAccessibleName(
        "Claude Code, Opus. Change agent or model",
      );
    });

    it("goes to the canvas from Canvas", async () => {
      render(<Harness />);
      await waitForComposer();
      fireEvent.click(screen.getByRole("button", { name: "Open canvas" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });
  });

  describe("keys", () => {
    it("goes back to the canvas on a bare C outside a text field", async () => {
      render(<Harness />);
      const textarea = await waitForComposer();

      fireEvent.keyDown(textarea, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("chat");
      fireEvent.keyDown(view(), { key: "c", metaKey: true });
      expect(useAssetStore.getState().appView).toBe("chat");
      fireEvent.keyDown(view(), { key: "C", shiftKey: true });
      expect(useAssetStore.getState().appView).toBe("chat");

      fireEvent.keyDown(view(), { key: "c" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    it("hears a bare C when the focus has dropped out of the view", async () => {
      render(<Harness />);
      await waitForComposer();
      fireEvent.keyDown(document.body, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    it("leaves a C typed into an open menu to the menu", async () => {
      render(<Harness />);
      await waitForComposer();
      const menu = openMenu(/Change agent or model/);
      fireEvent.keyDown(within(menu).getAllByRole("menuitemradio")[0]!, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("chat");
    });

    it("never leaves on Escape", async () => {
      render(<Harness />);
      const textarea = await waitForComposer();
      fireEvent.keyDown(textarea, { key: "Escape" });
      fireEvent.keyDown(view(), { key: "Escape" });
      expect(useAssetStore.getState().appView).toBe("chat");
      expect(view()).toBeInTheDocument();
    });

    it("keeps its keys from canvas shortcuts on window, and saves the live workflow on ⌘S", async () => {
      const windowKeys = vi.fn();
      window.addEventListener("keydown", windowKeys);
      try {
        render(<Harness />);
        const textarea = await waitForComposer();
        fireEvent.keyDown(textarea, { key: "P", shiftKey: true });
        fireEvent.keyDown(textarea, { key: "s", metaKey: true });
        expect(windowKeys).not.toHaveBeenCalled();
        expect(useSaveRequestStore.getState().request?.reason).toBe("shortcut");
      } finally {
        window.removeEventListener("keydown", windowKeys);
      }
    });

    it("opens the shortcuts on ?", async () => {
      render(<Harness />);
      await waitForComposer();
      fireEvent.keyDown(view(), { key: "?" });
      expect(store().shortcutsDialogOpen).toBe(true);
      act(() => store().setShortcutsDialogOpen(false));
    });
  });
});

describe("groupConversations", () => {
  const at = (date: Date) => savedConversation({ id: date.toISOString(), updatedAt: date.getTime() });
  const now = new Date(2026, 9, 8, 9, 30).getTime();

  it("files conversations under local days, leaving empty groups out", () => {
    const groups = groupConversations(
      [
        at(new Date(2026, 9, 8, 0, 5)),
        at(new Date(2026, 9, 7, 23, 59)),
        at(new Date(2026, 9, 1, 12)),
        at(new Date(2026, 8, 30, 23)),
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.conversations.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Previous 7 days", 1],
      ["Older", 1],
    ]);
    expect(groupConversations([at(new Date(2026, 9, 8, 8))], now).map((group) => group.label)).toEqual(["Today"]);
  });
});

describe("filterConversations", () => {
  it("matches the label or the workflow, ignoring case and outer spaces", () => {
    const list = [
      savedConversation({ id: "a", summary: "Night market", workflowName: "Espresso" }),
      savedConversation({ id: "b", summary: undefined, workflowName: undefined }),
    ];
    expect(filterConversations(list, "  NIGHT ").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterConversations(list, "espresso").map((entry) => entry.id)).toEqual(["a"]);
    // No summary: the first message is the label.
    expect(filterConversations(list, "build a hero").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterConversations(list, "")).toHaveLength(2);
  });
});

describe("describeSwitcherTab", () => {
  it("says how big a workflow is and whether it is saved", () => {
    expect(describeSwitcherTab({ nodeCount: 0, unsaved: false, saved: false })).toBe("Empty");
    expect(describeSwitcherTab({ nodeCount: 1, unsaved: false, saved: true })).toBe("1 node · Saved");
    expect(describeSwitcherTab({ nodeCount: 3, unsaved: true, saved: true })).toBe("3 nodes · Unsaved");
    expect(describeSwitcherTab({ nodeCount: 3, unsaved: false, saved: false })).toBe("3 nodes · Not saved");
    expect(describeSwitcherTab({ nodeCount: 0, unsaved: false, saved: true })).toBe("0 nodes · Saved");
  });
});
