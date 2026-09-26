/**
 * AgentPanel end to end in jsdom: status → sign-in card → ready, the chat
 * request body, streamed canvas edits reaching the store, notices, keyboard
 * containment and Escape.
 *
 * The routes are faked at fetch; the chat route answers with a real UI
 * message stream (SSE), so useChat, the transport and onData all run for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { AgentHarnessStatus, AgentGraphOpBatch } from "@/lib/agent/types";

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
import { useWorkflowStore } from "@/store/workflowStore";
import { AGENT_SETTINGS_KEY } from "@/lib/agent/client/settings";
import { AGENT_STATUS_POLL_MS } from "@/lib/agent/client/useAgentStatus";

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
let signInResponse: Record<string, unknown>;
/** Bodies the panel posted to /api/agent/sign-in, in order. */
let signInBodies: Array<Record<string, unknown>>;
/** Lets a test mirror the server: a started flow shows up as `signIn: pending` on later statuses. */
let onSignInStarted: ((response: Record<string, unknown>) => void) | undefined;

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
  if (url === "/api/agent/sign-in") {
    signInBodies.push(JSON.parse(String(init?.body)));
    onSignInStarted?.(signInResponse);
    return new Response(JSON.stringify(signInResponse), { status: 200 });
  }
  if (url === "/api/agent/chat") {
    chatBodies.push(JSON.parse(String(init?.body)));
    return sse(chatChunks.shift() ?? []);
  }
  throw new Error(`unexpected fetch ${url}`);
});

function replyChunks({
  text = "Done.",
  sessionId = "session-1",
  harness = "claude",
  batch,
}: {
  text?: string;
  sessionId?: string;
  harness?: "claude" | "codex";
  batch?: AgentGraphOpBatch;
} = {}) {
  return [
    { type: "start", messageMetadata: { harness } },
    { type: "start-step" },
    { type: "data-agent-session", id: "session", data: { harness, sessionId } },
    ...(batch
      ? [
          { type: "tool-input-available", toolCallId: batch.toolCallId, toolName: "edit_workflow", title: "Edit workflow", dynamic: true, input: { operations: [] } },
          { type: "data-graph-ops", data: batch, transient: true },
          { type: "tool-output-available", toolCallId: batch.toolCallId, dynamic: true, output: { ok: true, summary: batch.summary } },
        ]
      : []),
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
}

// ---------------------------------------------------------------------------

function renderPanel(props: Partial<Parameters<typeof AgentPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ReactFlowProvider>
      <AgentPanel open onClose={onClose} buttonRight={15} buttonBottom={173} {...props} />
    </ReactFlowProvider>,
  );
  return { ...utils, onClose };
}

/** Opens the header's harness and model menu (Radix opens it from the keyboard in jsdom). */
function openHarnessMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /Change agent or model/ }), { key: "Enter" });
  return screen.getByRole("menu");
}

async function waitForComposer() {
  return (await screen.findByRole("textbox", { name: "Message the agent" })) as HTMLTextAreaElement;
}

describe("AgentPanel", () => {
  const applyAgentGraphOps = vi.fn(() => ({ applied: 1, skipped: [] as string[] }));
  const originalApply = useWorkflowStore.getState().applyAgentGraphOps;

  beforeEach(() => {
    localStorage.clear();
    statuses = { claude: harnessStatus("claude"), codex: harnessStatus("codex") };
    chatBodies = [];
    chatChunks = [];
    signInResponse = { state: "pending" };
    signInBodies = [];
    onSignInStarted = undefined;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("open", vi.fn());
    applyAgentGraphOps.mockClear();
    useWorkflowStore.setState({ nodes: [], edges: [], groups: {}, applyAgentGraphOps });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useWorkflowStore.setState({ applyAgentGraphOps: originalApply });
  });

  it("renders into document.body with the scoped theme and wheel/key guards", async () => {
    renderPanel();
    const panel = screen.getByTestId("agent-panel");
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain("nb-agent");
    expect(panel.className).toContain("nowheel");
    expect(panel.className).toContain("nokey");
    // The window takes the button's place (the button hides while it is open).
    // Gap to the navigator (173 - 8) equals the right margin.
    expect(panel).toHaveStyle({ right: "15px", bottom: "180px", width: "400px" });
    await waitForComposer();
  });

  it("shows the empty state with suggestions once the harness is ready", async () => {
    renderPanel();
    await waitForComposer();
    expect(screen.getByText("What should we build?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build a text-to-image workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Change agent or model/ })).toHaveAccessibleName(
      "Claude Code, Sonnet. Change agent or model",
    );
    const menu = openHarnessMenu();
    expect(within(menu).getByRole("menuitemradio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /Sonnet/ })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the billing line in a fixed row, never inside the scrolling empty state (UX audit)", async () => {
    renderPanel();
    await waitForComposer();
    const note = screen.getByText(/Runs on your Claude plan's usage limits[^]*never an API key/);
    // A direct row of the window, like the composer: it can't be scrolled out of view or cut off.
    expect(note.parentElement).toBe(screen.getByTestId("agent-panel"));
    expect(note.className).toContain("shrink-0");
    expect(note.closest(".overflow-y-auto")).toBeNull();
  });

  it("walks a signed-out user through the vendor sign-in", async () => {
    statuses.claude = harnessStatus("claude", { signedIn: false, billing: "none" });
    renderPanel();

    const signIn = await screen.findByRole("button", { name: "Open Claude Code sign-in" });
    expect(screen.queryByRole("textbox", { name: "Message the agent" })).not.toBeInTheDocument();

    fireEvent.click(signIn);
    expect(await screen.findByText("Finish signing in")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/agent/sign-in", expect.objectContaining({ method: "POST" }));
    // Claude Code opens its page itself: no second tab, and no link to its manual
    // (paste-a-code) URL. The fallback is the terminal.
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /open the sign-in page/i })).not.toBeInTheDocument();
    expect(screen.getByText("No browser tab opened? Sign in from a terminal instead:")).toBeInTheDocument();

    // The user finishes in the browser; the next check sees the subscription login.
    statuses.claude = harnessStatus("claude");
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    await waitForComposer();
  });

  it("opens Codex's sign-in page and shows its device code", async () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ harness: "codex", models: {} }));
    statuses.codex = harnessStatus("codex", { signedIn: false, billing: "none" });
    signInResponse = { state: "pending", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" };
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");
  });

  it("refuses a login that would bill API credits", async () => {
    statuses.claude = harnessStatus("claude", {
      billing: "api",
      problem: "Claude Code is signed in with a Console API key.",
    });
    renderPanel();
    expect(await screen.findByText("This login would use API credits")).toBeInTheDocument();
    expect(screen.getByText("Claude Code is signed in with a Console API key.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message the agent" })).not.toBeInTheDocument();
  });

  it("follows the sign-in that replaces an API login: device code, link, polling, then the composer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ harness: "codex", models: {} }));
      statuses.codex = harnessStatus("codex", { billing: "api", problem: "Codex is signed in with an API key." });
      signInResponse = { state: "pending", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" };
      onSignInStarted = () => {
        statuses.codex = { ...statuses.codex, signIn: { state: "pending", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } };
      };
      renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: "Switch Codex to your ChatGPT account" }));
      expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
      // A blocked popup leaves this link as the way to the page.
      expect(screen.getByRole("link", { name: /open the sign-in page/i })).toHaveAttribute(
        "href",
        "https://auth.openai.com/codex/device",
      );
      expect(screen.getByText("Codex is signed in with an API key.")).toBeInTheDocument();

      const codexChecks = () =>
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/agent/status?harness=codex").length;
      // The poll is armed by an effect that can land after the code renders (or a
      // check can still be in flight), so on a loaded machine the manual advance may
      // miss it. Allow one more interval: shouldAdvanceTime keeps the clock moving.
      const pollWait = { timeout: AGENT_STATUS_POLL_MS * 2 };
      const before = codexChecks();
      await act(async () => {
        vi.advanceTimersByTime(AGENT_STATUS_POLL_MS + 50);
      });
      await waitFor(() => expect(codexChecks()).toBeGreaterThan(before), pollWait);
      // The server's own pending state keeps the code on screen.
      expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();

      // The user finishes with their ChatGPT account: the next poll reaches the composer on its own.
      statuses.codex = harnessStatus("codex");
      await act(async () => {
        vi.advanceTimersByTime(AGENT_STATUS_POLL_MS + 50);
      });
      await screen.findByRole("textbox", { name: "Message the agent" }, pollWait);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("doesn't call a login without a readable plan an API login", async () => {
    statuses.claude = harnessStatus("claude", {
      billing: "unknown",
      problem: "Claude Code is signed in, but no Claude Pro or Max plan was found on the account.",
    });
    renderPanel();
    expect(await screen.findByText("No Claude Pro or Max plan found on this login")).toBeInTheDocument();
    expect(screen.queryByText(/API credits/)).not.toBeInTheDocument();

    const menu = openHarnessMenu();
    expect(within(menu).getByRole("menuitemradio", { name: /Claude Code/ })).toHaveTextContent("Unconfirmed");
    expect(screen.queryByText(/API account/)).not.toBeInTheDocument();
  });

  it("switches harness, remembers the choice and shows that harness's models", async () => {
    statuses.codex = harnessStatus("codex");
    renderPanel();
    await waitForComposer();

    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Codex/ }));
    const menu = openHarnessMenu();
    expect(within(menu).getByRole("menuitemradio", { name: /Codex/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /GPT-5.6 Luna/ })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!).harness).toBe("codex"));
  });

  it("keeps each harness's model pick across switches and turns", async () => {
    statuses.codex = harnessStatus("codex");
    renderPanel();
    await waitForComposer();

    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Opus/ }));
    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Codex/ }));
    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Claude Code/ }));

    expect(screen.getByRole("button", { name: /Change agent or model/ })).toHaveAccessibleName(
      "Claude Code, Opus. Change agent or model",
    );
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!).models).toEqual({ claude: "opus" }),
    );
  });

  it("sends the live canvas, applies streamed edits and resumes the session next turn", async () => {
    const batch: AgentGraphOpBatch = {
      batchId: "b1",
      toolCallId: "call-1",
      ops: [{ op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} }],
      summary: "Added 1 node",
      focusNodeIds: ["prompt-ag1"],
    };
    chatChunks.push(replyChunks({ text: "Added a prompt node.", batch }));
    chatChunks.push(replyChunks({ text: "Changed it." }));

    renderPanel();
    const textarea = await waitForComposer();
    fireEvent.change(textarea, { target: { value: "Add a prompt node" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(await screen.findByText("Added a prompt node.")).toBeInTheDocument();
    expect(screen.getByText("Edit workflow")).toBeInTheDocument();
    expect(screen.getByText("Added 1 node")).toBeInTheDocument();

    expect(chatBodies[0]).toMatchObject({ harness: "claude", model: "sonnet", workflow: snapshot });
    expect(chatBodies[0].sessionId).toBeUndefined();
    expect(applyAgentGraphOps).toHaveBeenCalledWith(batch);

    fireEvent.change(textarea, { target: { value: "Make it a cat" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(await screen.findByText("Changed it.")).toBeInTheDocument();
    expect(chatBodies[1].sessionId).toBe("session-1");
  });

  it("keeps finished chats in the history, labelled by the agent's summary, and reopens them", async () => {
    const first = replyChunks({ text: "Built the hero film." });
    first.splice(3, 0, { type: "data-agent-summary", id: "summary", data: { summary: "Espresso hero film" } });
    chatChunks.push(first);
    chatChunks.push(replyChunks({ text: "Changed the ratio." }));

    renderPanel();
    const textarea = await waitForComposer();
    fireEvent.change(textarea, { target: { value: "Build a hero film" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(await screen.findByText("Built the hero film.")).toBeInTheDocument();

    // A new chat, then back to the first one from the history.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const row = await screen.findByRole("button", { name: /^Espresso hero film/ });
    fireEvent.click(row);
    expect(await screen.findByText("Built the hero film.")).toBeInTheDocument();

    // It carries on the same chat and harness session.
    fireEvent.change(await waitForComposer(), { target: { value: "Make it 9:16" } });
    fireEvent.keyDown(await waitForComposer(), { key: "Enter" });
    expect(await screen.findByText("Changed the ratio.")).toBeInTheDocument();
    expect(chatBodies[1].id).toBe(chatBodies[0].id);
    expect(chatBodies[1].sessionId).toBe("session-1");
  });

  it("renders a notice inline with a sign-in action", async () => {
    chatChunks.push([
      { type: "start", messageMetadata: { harness: "claude" } },
      {
        type: "data-agent-notice",
        id: "notice",
        data: { code: "not_signed_in", message: "Claude Code is not signed in.", harness: "claude" },
      },
      { type: "finish" },
    ]);
    renderPanel();
    const textarea = await waitForComposer();
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Claude Code is not signed in.");
    expect(within(alert).getByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
    // The notice made the panel re-check that harness.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/agent/status?harness=claude")).toBe(true),
    );
  });

  it("forces the vendor's sign-in after a turn it rejected, from the card and from the notice", async () => {
    const rejectedNotice = {
      type: "data-agent-notice",
      id: "notice",
      data: { code: "not_signed_in", message: "Claude Code rejected its saved sign-in.", harness: "claude" },
    };
    chatChunks.push([{ type: "start", messageMetadata: { harness: "claude" } }, rejectedNotice, { type: "finish" }]);
    renderPanel();
    const textarea = await waitForComposer();
    // The turn is rejected; the harness now reports signed out (its local status would still say fine).
    statuses.claude = harnessStatus("claude", {
      signedIn: false,
      billing: "none",
      problem: "Claude Code rejected its saved sign-in (it may have expired or been revoked).",
    });
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The card under the conversation: the flow couldn't start this time.
    signInResponse = { state: "failed", message: "Login failed: no browser" };
    fireEvent.click(await screen.findByRole("button", { name: "Open Claude Code sign-in" }));
    await waitFor(() => expect(signInBodies).toHaveLength(1));
    expect(signInBodies[0]).toEqual({ harness: "claude", force: true });

    // The notice's own button.
    signInResponse = { state: "pending", message: "Finish signing in in your browser." };
    const notice = screen.getAllByRole("alert").find((element) => element.textContent?.includes("rejected its saved sign-in"))!;
    fireEvent.click(within(notice).getByRole("button", { name: "Sign in to Claude Code" }));
    await waitFor(() => expect(signInBodies).toHaveLength(2));
    expect(signInBodies[1]).toEqual({ harness: "claude", force: true });
  });

  it("says what to do when sign-in answers already signed in, instead of doing nothing", async () => {
    chatChunks.push([
      { type: "start", messageMetadata: { harness: "claude" } },
      {
        type: "data-agent-notice",
        id: "notice",
        data: { code: "not_signed_in", message: "Claude Code is not signed in.", harness: "claude" },
      },
      { type: "finish" },
    ]);
    chatChunks.push(replyChunks({ text: "All good now." }));
    signInResponse = { state: "already_signed_in", message: "Claude Code is already signed in with your Claude plan." };
    renderPanel();
    const textarea = await waitForComposer();
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    const notice = await screen.findByRole("alert");
    fireEvent.change(textarea, { target: { value: "again" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText("All good now.");

    // An older notice, followed by a turn that ran: no force, and the harness says it's fine.
    fireEvent.click(within(notice).getByRole("button", { name: "Sign in to Claude Code" }));
    const hint = await screen.findByTestId("agent-already-signed-in");
    expect(signInBodies).toEqual([{ harness: "claude" }]);
    expect(hint).toHaveTextContent("Claude Code is already signed in with your Claude plan.");
    expect(hint).toHaveTextContent("if turns still fail, sign in again from a terminal");
    expect(within(hint).getByText("claude auth login")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("agent-already-signed-in")).not.toBeInTheDocument();
  });

  it("starts a new chat", async () => {
    chatChunks.push(replyChunks({ text: "First reply." }));
    renderPanel();
    const textarea = await waitForComposer();
    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText("First reply.");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("First reply.")).not.toBeInTheDocument();
    expect(screen.getByText("What should we build?")).toBeInTheDocument();
  });

  it("keeps typing away from canvas shortcuts on window", async () => {
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      renderPanel();
      const textarea = await waitForComposer();
      fireEvent.keyDown(textarea, { key: "P", shiftKey: true });
      fireEvent.keyDown(screen.getByRole("button", { name: "New chat" }), { key: "?" });
      expect(windowKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  // Clicking a suggestion unmounts it; focus used to fall to <body>, where keys hit canvas shortcuts.
  it("puts the cursor back in the message box after a suggestion is sent", async () => {
    chatChunks.push(replyChunks());
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      const { onClose } = renderPanel();
      const textarea = await waitForComposer();
      const suggestion = screen.getByRole("button", { name: "Build a text-to-image workflow" });
      suggestion.focus(); // Chrome focuses a clicked button
      fireEvent.click(suggestion);
      await screen.findByText("Done.");
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });

      expect(document.activeElement).toBe(textarea);
      fireEvent.keyDown(document.activeElement!, { key: "G", shiftKey: true });
      expect(windowKeys).not.toHaveBeenCalled();
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("keeps an unsent message across a switch to a harness that isn't ready", async () => {
    statuses.codex = harnessStatus("codex", { signedIn: false, billing: "none" });
    renderPanel();
    fireEvent.change(await waitForComposer(), { target: { value: "keep me" } });

    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Codex/ }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Message the agent" })).not.toBeInTheDocument());

    fireEvent.click(within(openHarnessMenu()).getByRole("menuitemradio", { name: /Claude Code/ }));
    expect((await waitForComposer()).value).toBe("keep me");
  });

  // Safari ends a cancelled IME composition before the Escape keydown arrives (keyCode 229).
  it("doesn't close on the Escape that cancels an IME composition", async () => {
    const { onClose } = renderPanel();
    const textarea = await waitForComposer();
    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea);
    fireEvent(
      textarea,
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: false, bubbles: true, cancelable: true }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape only when focus is inside the window", async () => {
    const { onClose } = renderPanel();
    const textarea = await waitForComposer();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays mounted but hidden while closed", async () => {
    const { rerender } = renderPanel();
    await waitForComposer();
    rerender(
      <ReactFlowProvider>
        <AgentPanel open={false} onClose={vi.fn()} buttonRight={15} buttonBottom={173} />
      </ReactFlowProvider>,
    );
    const panel = screen.getByTestId("agent-panel");
    expect(panel.className).toContain("hidden");
    expect(panel.className).not.toMatch(/(^|\s)flex(\s|$)/);
  });
});
