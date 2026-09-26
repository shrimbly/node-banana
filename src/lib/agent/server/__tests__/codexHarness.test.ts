// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentHarness, AgentSignInStart, AgentToolRuntime, HarnessEvent, HarnessTurnParams } from "../../types";
import { CodexAppServer } from "../codexAppServer";
import {
  CODEX_DEVELOPER_INSTRUCTIONS,
  codexInputSchema,
  codexToolNamespace,
  createCodexHarness,
  createCodexHarnessState,
  type CodexHarnessDeps,
} from "../codexHarness";
import {
  DEFAULT_HANDLERS,
  FakeAppServer,
  loadRecordedCodexTurn,
  RECORDED_THREAD,
  RECORDED_TURN,
  type FakeHandler,
  type RpcLine,
} from "./fakeAppServer";

const recorded = loadRecordedCodexTurn();

/* ── fakes ─────────────────────────────────────────────────────── */

/**
 * turn/start answers with the recorded turn id, then replays the recorded
 * notifications. At the dynamic tool call it sends the real server request
 * (`item/tool/call`) and waits for the harness's answer, as Codex does.
 */
function replayRecordedTurn(toolAnswers: RpcLine[], options: { stopAfterTool?: boolean } = {}): FakeHandler {
  return (_params, server) => {
    setTimeout(async () => {
      for (const notification of recorded) {
        if (server.exited) return;
        server.notify(notification.method, notification.params);
        const item = (notification.params as { item?: { type?: string; id?: string } }).item;
        if (notification.method === "item/started" && item?.type === "dynamicToolCall") {
          toolAnswers.push(
            await server.request("item/tool/call", {
              threadId: RECORDED_THREAD,
              turnId: RECORDED_TURN,
              callId: item.id,
              namespace: "node_banana",
              tool: "add_numbers",
              arguments: { a: 2, b: 3 },
            }),
          );
          if (options.stopAfterTool) return;
        }
      }
    }, 1);
    return { turn: { id: RECORDED_TURN, items: [], status: "inProgress", error: null } };
  };
}

function setup(handlers: Record<string, FakeHandler> = {}, overrides: Partial<CodexHarnessDeps> = {}) {
  const children: FakeAppServer[] = [];
  const toolAnswers: RpcLine[] = [];
  const server = new CodexAppServer({
    bin: "/opt/codex",
    env: {},
    spawn: () => {
      const child = new FakeAppServer({
        "thread/start": () => ({ thread: { id: RECORDED_THREAD }, model: "gpt-5.6-luna" }),
        "turn/start": replayRecordedTurn(toolAnswers),
        "turn/interrupt": () => ({}),
        ...handlers,
      });
      children.push(child);
      return child;
    },
    makeWorkDir: async () => "/tmp/nb-codex",
    requestTimeoutMs: 2_000,
  });
  const state = createCodexHarnessState();
  const harness = createCodexHarness({
    lookupBinary: () => ({ path: "/opt/codex", source: "bundled" }),
    getServer: () => server,
    state,
    idleWaitMs: 200,
    mcpStartupWaitMs: 5,
    ...overrides,
  });
  const child = () => children.at(-1)!;
  return { harness, server, state, children, child, toolAnswers };
}

function runtime(calls: unknown[] = []): AgentToolRuntime {
  return {
    definitions: [
      {
        name: "add_numbers",
        title: "Add numbers",
        description: "Add two numbers.",
        inputShape: { a: z.number(), b: z.number(), tags: z.record(z.string(), z.unknown()).optional() },
        readOnly: true,
      },
    ],
    async execute(name, args) {
      calls.push({ name, args });
      return { ok: true, text: "5", summary: "Added", ops: [] };
    },
  };
}

function params(overrides: Partial<HarnessTurnParams> = {}): HarnessTurnParams {
  return {
    history: [{ role: "user", text: "The secret word is banana." }, { role: "assistant", text: "Got it." }],
    prompt: "<canvas/>\n<user>add 2 and 3</user>",
    systemPrompt: "You are Node Banana's workflow agent.",
    tools: runtime(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A runtime with a canvas-editing tool too, for the "Planning edits…" hint. */
function writeRuntime(calls: unknown[] = []): AgentToolRuntime {
  const base = runtime(calls);
  return {
    definitions: [
      ...base.definitions,
      { name: "edit_workflow", title: "Edit workflow", description: "Edit.", inputShape: { op: z.string() }, readOnly: false },
    ],
    execute: base.execute,
  };
}

/** thread/start handing out thread-1, thread-2, … */
function numberedThreads(): FakeHandler {
  let count = 0;
  return () => ({ thread: { id: `thread-${++count}` }, model: "gpt-5.6-luna" });
}

/** turn/start whose turn completes at once on whichever thread it was started. */
function completingTurn(turnId = "T", extra: Record<string, unknown> = {}): FakeHandler {
  return (params, server) => {
    setTimeout(() => server.notify("turn/completed", { threadId: params.threadId, turn: { id: turnId, status: "completed", ...extra } }), 1);
    return { turn: { id: turnId } };
  };
}

function usageResponse(overrides: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) {
  const base = DEFAULT_HANDLERS["account/rateLimits/read"](undefined, undefined as never) as {
    rateLimits: Record<string, unknown>;
  };
  return { ...base, ...overrides, rateLimits: { ...base.rateLimits, ...limits } };
}

function forceSignIn(harness: AgentHarness): Promise<AgentSignInStart> {
  return harness.startSignIn({ force: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function turnText(line: RpcLine): string {
  return ((line.params as { input: Array<{ text: string }> }).input)[0].text;
}

/* ── runTurn ───────────────────────────────────────────────────── */

describe("Codex harness runTurn", () => {
  it("runs the recorded turn: new thread, tool call answered, streamed reply", async () => {
    const calls: unknown[] = [];
    const { harness, child, toolAnswers } = setup();
    const events = await collect(harness.runTurn(params({ tools: runtime(calls) })));

    expect(events).toEqual([
      { type: "session", sessionId: RECORDED_THREAD },
      { type: "tool-pending", toolName: "add_numbers" },
      { type: "text-delta", id: expect.any(String), delta: "5" },
      { type: "text-delta", id: expect.any(String), delta: "," },
      { type: "text-delta", id: expect.any(String), delta: " banana" },
      { type: "text-end", id: expect.any(String) },
      { type: "usage", inputTokens: 3198, outputTokens: 39 },
    ]);
    expect(calls).toEqual([{ name: "add_numbers", args: { a: 2, b: 3 } }]);
    expect(toolAnswers[0].result).toEqual({ contentItems: [{ type: "inputText", text: "5" }], success: true });
    expect(child().requests("account/read")).toHaveLength(1);
  });

  it("starts an ephemeral, locked-down thread with our instructions and tools", async () => {
    const { harness, child } = setup();
    await collect(harness.runTurn(params()));
    const [start] = child().requests("thread/start");
    expect(start.params).toEqual({
      model: "gpt-5.6-luna",
      cwd: "/tmp/nb-codex",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "You are Node Banana's workflow agent.",
      developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
      config: { "mcp_servers.node_repl.enabled": false, "mcp_servers.computer-use.enabled": false },
      environments: [],
      dynamicTools: [codexToolNamespace(runtime().definitions)],
    });
    // The user's global AGENTS.md is always sent; the developer message tells the model to ignore it.
    expect(CODEX_DEVELOPER_INSTRUCTIONS).toMatch(/AGENTS\.md/);
    expect(CODEX_DEVELOPER_INSTRUCTIONS).toMatch(/never add places, themes or styles/);
  });

  it("remembers the instruction files Codex adds anyway (the global AGENTS.md)", async () => {
    const { harness, state } = setup({
      "thread/start": () => ({ thread: { id: RECORDED_THREAD }, instructionSources: ["/home/u/.codex/AGENTS.md"] }),
    });
    await collect(harness.runTurn(params()));
    expect(state.instructionSources).toEqual(["/home/u/.codex/AGENTS.md"]);
  });

  it("starts the turn at medium effort with the history-seeded prompt", async () => {
    const { harness, child } = setup();
    await collect(harness.runTurn(params({ model: "gpt-6-luna" })));
    const [turn] = child().requests("turn/start");
    // Medium: "low" produced stray text in the recorded evals (build/integrate.md).
    expect(turn.params).toMatchObject({ threadId: RECORDED_THREAD, model: "gpt-6-luna", effort: "medium", summary: "auto" });
    expect(turnText(turn)).toContain("User: The secret word is banana.");
    expect(turnText(turn).endsWith("<canvas/>\n<user>add 2 and 3</user>")).toBe(true);
  });

  it("continues a known thread without re-sending the history", async () => {
    const { harness, child } = setup();
    await collect(harness.runTurn(params()));
    const events = await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD })));
    expect(events[0]).toEqual({ type: "session", sessionId: RECORDED_THREAD });
    expect(child().requests("thread/start")).toHaveLength(1);
    const turns = child().requests("turn/start");
    expect(turns).toHaveLength(2);
    expect(turnText(turns[1])).toBe("<canvas/>\n<user>add 2 and 3</user>");
  });

  it("starts a new thread for a session id this app-server doesn't know", async () => {
    const { harness, child } = setup();
    await collect(harness.runTurn(params({ sessionId: "thread-from-before-a-restart" })));
    expect(child().requests("thread/start")).toHaveLength(1);
    expect(turnText(child().requests("turn/start")[0])).toContain("<conversation_history>");
  });

  it("starts a new thread when the instructions change", async () => {
    const { harness, child } = setup();
    await collect(harness.runTurn(params()));
    await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD, systemPrompt: "New instructions." })));
    expect(child().requests("thread/start")).toHaveLength(2);
  });

  it.each([
    ["an API key", { account: { type: "apiKey" }, requiresOpenaiAuth: true }, "wrong_billing"],
    ["Amazon Bedrock", { account: { type: "amazonBedrock", usesCodexManagedCredentials: true } }, "wrong_billing"],
    ["no login", { account: null, requiresOpenaiAuth: true }, "not_signed_in"],
  ])("never starts a thread or turn on %s", async (_label, account, code) => {
    const { harness, child } = setup({ "account/read": () => account });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code, message: expect.any(String) }]);
    expect(child().requests("thread/start")).toHaveLength(0);
    expect(child().requests("turn/start")).toHaveLength(0);
  });

  it("refuses when config.toml would route turns to another provider", async () => {
    const { harness, child } = setup({ "config/read": () => ({ config: { mcp_servers: {}, model_provider: "azure" } }) });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "wrong_billing", message: expect.stringMatching(/"azure"/) }]);
    expect(child().requests("turn/start")).toHaveLength(0);
  });

  it("interrupts the Codex turn when the request is aborted", async () => {
    const controller = new AbortController();
    const toolAnswers: RpcLine[] = [];
    const { harness, child } = setup({ "turn/start": replayRecordedTurn(toolAnswers, { stopAfterTool: true }) });
    const events: HarnessEvent[] = [];
    for await (const event of harness.runTurn(params({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === "tool-pending") setTimeout(() => controller.abort(), 20);
    }
    expect(events.map((event) => event.type)).toEqual(["session", "tool-pending"]);
    await vi.waitFor(() => expect(child().requests("turn/interrupt")).toHaveLength(1));
    expect(child().requests("turn/interrupt")[0].params).toEqual({ threadId: RECORDED_THREAD, turnId: RECORDED_TURN });
  });

  it("reports an app-server crash mid-turn", async () => {
    const { harness, child } = setup({ "turn/start": () => ({ turn: { id: RECORDED_TURN } }) });
    const events: HarnessEvent[] = [];
    for await (const event of harness.runTurn(params())) {
      events.push(event);
      if (event.type === "session") setTimeout(() => child().exit(1), 20);
    }
    expect(events.at(-1)).toEqual({ type: "error", code: "harness_error", message: expect.stringMatching(/stopped unexpectedly/) });
  });

  it("reports a turn/start failure", async () => {
    const { harness } = setup({ "turn/start": () => { throw new Error("model not supported"); } });
    const events = await collect(harness.runTurn(params()));
    expect(events.at(-1)).toEqual({ type: "error", code: "harness_error", message: expect.stringMatching(/model not supported/) });
  });

  it("retries on a new thread when Codex unloaded the old one", async () => {
    let turnStarts = 0;
    const toolAnswers: RpcLine[] = [];
    const replay = replayRecordedTurn(toolAnswers);
    const { harness, child } = setup({
      "turn/start": (params, server) => {
        turnStarts += 1;
        if (turnStarts === 2) throw new Error("thread not found: " + RECORDED_THREAD);
        return replay(params, server);
      },
    });
    await collect(harness.runTurn(params()));
    const events = await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD })));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(child().requests("thread/start")).toHaveLength(2);
    expect(turnText(child().requests("turn/start")[2])).toContain("<conversation_history>");
  });

  it("refuses tool calls for threads with no turn running", async () => {
    const { harness, server, child } = setup();
    await harness.getStatus();
    await server.start();
    const answer = await child().request("item/tool/call", {
      threadId: "nope",
      turnId: "t",
      callId: "c",
      namespace: "node_banana",
      tool: "add_numbers",
      arguments: {},
    });
    expect(answer.result).toEqual({
      contentItems: [{ type: "inputText", text: expect.stringMatching(/No Node Banana turn/) }],
      success: false,
    });
  });

  it("reports a missing binary as not_installed", async () => {
    const harness = createCodexHarness({
      lookupBinary: () => ({ path: null, problem: "Codex wasn't found." }),
      state: createCodexHarnessState(),
    });
    expect(await collect(harness.runTurn(params()))).toEqual([{ type: "error", code: "not_installed", message: "Codex wasn't found." }]);
  });
});

/* ── plan usage (C3) ───────────────────────────────────────────── */

describe("Codex harness and the plan's included usage", () => {
  it.each([
    ["ordinary usage is blocked, even with purchased credits", usageResponse({ ordinaryUsageAllowed: false }, { credits: { hasCredits: true, unlimited: false, balance: "480" } })],
    ["the workspace member is out of credits", usageResponse({ ordinaryUsageAllowed: null }, { rateLimitReachedType: "workspace_member_credits_depleted" })],
    ["the workspace's spend control is reached", usageResponse({}, { spendControlReached: true })],
    ["a window is full and the backend doesn't say", usageResponse({ ordinaryUsageAllowed: null }, { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790368200 } })],
  ])("refuses before any thread or turn when %s", async (_label, response) => {
    const { harness, child } = setup({ "account/rateLimits/read": () => response });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: expect.any(String) }]);
    expect(child().requests("thread/start")).toHaveLength(0);
    expect(child().requests("turn/start")).toHaveLength(0);
    expect(child().requests("account/rateLimits/read")[0].params).toEqual({ excludeResetCreditDetails: true });
    // Status says why, until the reset, also as the usageLimit field.
    const status = await harness.getStatus();
    const message = (events[0] as { message: string }).message;
    expect(status.problem).toEqual(message);
    expect(status.usageLimit).toEqual({ message, until: expect.any(Number) });
    expect(status.usageLimit!.until).toBeGreaterThan(Date.now());
  });

  it("says the agent won't spend purchased credits", async () => {
    const { harness } = setup({ "account/rateLimits/read": () => usageResponse({ ordinaryUsageAllowed: false }) });
    const [event] = await collect(harness.runTurn(params()));
    expect((event as { message: string }).message).toMatch(/included Codex usage is used up.*won't spend purchased credits/);
  });

  it("refuses a flexible-pricing workspace (credits per token) as wrong billing", async () => {
    const { harness, child } = setup({
      "account/read": () => ({ account: { type: "chatgpt", email: "x@example.com", planType: "self_serve_business_usage_based" } }),
    });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "wrong_billing", message: expect.stringMatching(/flexible pricing/) }]);
    expect(child().requests("turn/start")).toHaveLength(0);
  });

  it("reads a rate-limit refusal for lack of auth as a sign-in problem", async () => {
    const { harness, child } = setup({
      "account/rateLimits/read": () => {
        throw new Error("codex account authentication required to read rate limits");
      },
    });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "not_signed_in", message: expect.stringMatching(/codex login/) }]);
    expect(child().requests("turn/start")).toHaveLength(0);
  });

  it("fails closed when the usage can't be read", async () => {
    const { harness, child } = setup({
      "account/rateLimits/read": () => {
        throw new Error("backend unavailable");
      },
    });
    expect(await collect(harness.runTurn(params()))).toEqual([
      { type: "error", code: "harness_error", message: expect.stringMatching(/backend unavailable/) },
    ]);
    expect(child().requests("turn/start")).toHaveLength(0);
  });

  it("stops a turn when a rate-limit update says the plan ran out mid-turn", async () => {
    let reads = 0;
    const { harness, child } = setup({
      "account/rateLimits/read": () => (++reads === 1 ? usageResponse() : usageResponse({ ordinaryUsageAllowed: false })),
      "turn/start": (params, server) => {
        setTimeout(
          () =>
            server.notify("account/rateLimits/updated", {
              rateLimits: { limitId: "codex", primary: null, secondary: null, credits: null, spendControlReached: null, rateLimitReachedType: "rate_limit_reached" },
            }),
          5,
        );
        return { turn: { id: "T" } };
      },
    });
    const events = await collect(harness.runTurn(params()));
    expect(events.at(-1)).toEqual({ type: "error", code: "usage_limit", message: expect.stringMatching(/used up/) });
    await vi.waitFor(() => expect(child().requests("turn/interrupt")).toHaveLength(1));
  });

  it("ignores rate-limit updates that don't reach a limit", async () => {
    const { harness, child } = setup({
      "turn/start": (params, server) => {
        setTimeout(() => server.notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 40 } } }), 1);
        setTimeout(() => server.notify("turn/completed", { threadId: params.threadId, turn: { id: "T", status: "completed" } }), 10);
        return { turn: { id: "T" } };
      },
    });
    const events = await collect(harness.runTurn(params()));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(child().requests("account/rateLimits/read")).toHaveLength(1);
  });
});

/* ── the user's MCP servers (C4) ───────────────────────────────── */

describe("Codex harness and the user's MCP servers", () => {
  it("re-reads config.toml before every thread and disables what it lists now", async () => {
    let reads = 0;
    const { harness, child } = setup({
      "config/read": () => ({ config: { mcp_servers: ++reads === 1 ? { node_repl: {} } : { node_repl: {}, late: {} }, model_provider: null } }),
    });
    await collect(harness.runTurn(params()));
    const methods = child().received.filter((line) => line.method && line.id !== undefined).map((line) => line.method);
    expect(methods.filter((method) => method === "config/read")).toHaveLength(2);
    expect(methods.lastIndexOf("config/read")).toBeLessThan(methods.indexOf("thread/start"));
    expect(child().requests("thread/start")[0].params).toMatchObject({
      config: { "mcp_servers.node_repl.enabled": false, "mcp_servers.late.enabled": false },
    });
  });

  it("doesn't disable a server that was removed from config.toml (thread/start would reject it)", async () => {
    let reads = 0;
    const { harness, child } = setup({
      "config/read": () => ({ config: { mcp_servers: ++reads === 1 ? { gone: {} } : {}, model_provider: null } }),
    });
    await collect(harness.runTurn(params()));
    expect((child().requests("thread/start")[0].params as { config: unknown }).config).toEqual({});
  });

  it("retries once, disabling a server that started on the new thread anyway", async () => {
    let starts = 0;
    const { harness, child } = setup({
      "thread/start": (_params, server) => {
        const id = `thread-${++starts}`;
        if (starts === 1) setTimeout(() => server.notify("mcpServer/startupStatus/updated", { threadId: id, name: "late", status: "starting" }), 1);
        return { thread: { id } };
      },
      "turn/start": completingTurn(),
    });
    const events = await collect(harness.runTurn(params()));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events[0]).toEqual({ type: "session", sessionId: "thread-2" });
    expect(child().requests("thread/start")[1].params).toMatchObject({ config: { "mcp_servers.late.enabled": false } });
    expect(child().requests("thread/unsubscribe").map((line) => line.params)).toEqual([{ threadId: "thread-1" }]);
  });

  it("refuses the turn when a foreign server keeps starting", async () => {
    let starts = 0;
    const { harness, child } = setup({
      "thread/start": (_params, server) => {
        const id = `thread-${++starts}`;
        setTimeout(() => server.notify("mcpServer/startupStatus/updated", { threadId: id, name: "filesystem", status: "ready" }), 1);
        return { thread: { id } };
      },
    });
    const events = await collect(harness.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "harness_error", message: expect.stringMatching(/filesystem/) }]);
    expect(child().requests("turn/start")).toHaveLength(0);
    // Not kept: the next turn for that session starts a new thread.
    await collect(harness.runTurn(params({ sessionId: "thread-2" })));
    expect(child().requests("thread/start")).toHaveLength(4);
  });

  it("stops a running turn when an MCP server starts on its thread", async () => {
    const { harness, child, state } = setup({
      "turn/start": (params, server) => {
        setTimeout(() => server.notify("mcpServer/startupStatus/updated", { threadId: params.threadId, name: "late", status: "starting" }), 5);
        return { turn: { id: "T" } };
      },
    });
    const events = await collect(harness.runTurn(params()));
    expect(events.at(-1)).toEqual({ type: "error", code: "harness_error", message: expect.stringMatching(/late/) });
    await vi.waitFor(() => expect(child().requests("turn/interrupt")).toHaveLength(1));
    expect(state.threads.has(RECORDED_THREAD)).toBe(false);
  });
});

/* ── a login Codex rejected (C13) ──────────────────────────────── */

describe("Codex harness after Codex rejects its login", () => {
  const unauthorized: FakeHandler = (params, server) => {
    setTimeout(
      () =>
        server.notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: "T", status: "failed", error: { message: "Your access token could not be refreshed.", codexErrorInfo: "unauthorized" } },
        }),
      1,
    );
    return { turn: { id: "T" } };
  };

  it("reports signed out and starts the ChatGPT sign-in again", async () => {
    const { harness, child } = setup({
      "turn/start": unauthorized,
      "account/login/start": () => ({ type: "chatgpt", loginId: "login-9", authUrl: "https://auth.openai.com/x" }),
    });
    const events = await collect(harness.runTurn(params()));
    expect(events.at(-1)).toEqual({ type: "error", code: "not_signed_in", message: expect.stringMatching(/`codex login`/) });

    const status = await harness.getStatus();
    expect(status).toMatchObject({ signedIn: false, billing: "none" });
    expect(status.problem).toMatch(/rejected its saved ChatGPT sign-in/);

    expect(await harness.startSignIn()).toMatchObject({ state: "pending", url: "https://auth.openai.com/x" });
    expect(child().requests("account/login/start")).toHaveLength(1);
    expect(child().requests("account/logout")).toHaveLength(0);

    child().notify("account/login/completed", { loginId: "login-9", success: true, error: null });
    await sleep(5);
    expect(await harness.getStatus()).toMatchObject({ signedIn: true, billing: "subscription" });
  });

  it("forgets the rejection after a successful turn, or after a while", async () => {
    let now = 1_000;
    let turns = 0;
    const { harness } = setup(
      { "turn/start": (params, server) => (++turns === 2 ? completingTurn()(params, server) : unauthorized(params, server)) },
      { now: () => now },
    );
    await collect(harness.runTurn(params()));
    expect((await harness.getStatus()).signedIn).toBe(false);
    await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD })));
    expect((await harness.getStatus()).signedIn).toBe(true);
    await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD })));
    expect((await harness.getStatus()).signedIn).toBe(false);
    now += 2 * 60_000;
    expect((await harness.getStatus()).signedIn).toBe(true);
  });

  it("starts the sign-in on force even when Codex still looks signed in", async () => {
    const { harness, child } = setup({
      "account/login/start": () => ({ type: "chatgpt", loginId: "login-f", authUrl: "https://auth.openai.com/f" }),
    });
    expect(await harness.startSignIn()).toMatchObject({ state: "already_signed_in" });
    expect(await forceSignIn(harness)).toMatchObject({ state: "pending" });
    expect(child().requests("account/login/start").map((line) => line.params)).toEqual([{ type: "chatgpt" }]);
  });
});

/* ── tool calls belong to their turn (C14) ─────────────────────── */

describe("Codex harness: one turn per thread", () => {
  function toolCall(server: FakeAppServer, threadId: string, turnId: string) {
    return server.request("item/tool/call", {
      threadId,
      turnId,
      callId: `call-${turnId}`,
      namespace: "node_banana",
      tool: "add_numbers",
      arguments: { a: 2, b: 3 },
    });
  }

  it("gives the next turn its own runtime when a stopped turn's turn/start answers late", async () => {
    const answers: RpcLine[] = [];
    let starts = 0;
    const { harness } = setup(
      {
        "thread/start": numberedThreads(),
        "turn/start": async (params, server) => {
          starts += 1;
          if (starts === 1) return completingTurn("T0")(params, server);
          if (starts === 2) {
            await sleep(300); // Turn A: Codex is slow to answer.
            return { turn: { id: "A" } };
          }
          setTimeout(async () => {
            answers.push(await toolCall(server, params.threadId, "B"));
            server.notify("turn/completed", { threadId: params.threadId, turn: { id: "B", status: "completed" } });
          }, 20);
          return { turn: { id: "B" } };
        },
      },
      { idleWaitMs: 60 },
    );
    await collect(harness.runTurn(params()));

    const stopA = new AbortController();
    const aDone = collect(harness.runTurn(params({ sessionId: "thread-1", signal: stopA.signal })));
    await sleep(40);
    stopA.abort();

    const bCalls: unknown[] = [];
    const bEvents = await collect(harness.runTurn(params({ sessionId: "thread-1", tools: runtime(bCalls) })));
    await aDone;
    expect(answers[0].result).toMatchObject({ success: true });
    expect(bCalls).toHaveLength(1);
    // A turn/start there would have steered A: B continued on a new thread.
    expect(bEvents[0]).toEqual({ type: "session", sessionId: "thread-2" });
  });

  it("refuses a stopped turn's late tool call; the next turn moves to a new thread seeded with the history", async () => {
    const answers: RpcLine[] = [];
    let starts = 0;
    const { harness, child } = setup(
      {
        "thread/start": numberedThreads(),
        "turn/start": (params, server) => {
          starts += 1;
          if (starts === 1) return { turn: { id: "A" } }; // never completes
          setTimeout(async () => {
            answers.push(await toolCall(server, "thread-1", "A"));
            server.notify("turn/completed", { threadId: params.threadId, turn: { id: "B", status: "completed" } });
          }, 20);
          return { turn: { id: "B" } };
        },
      },
      { idleWaitMs: 50 },
    );
    const aCalls: unknown[] = [];
    const stopA = new AbortController();
    for await (const event of harness.runTurn(params({ signal: stopA.signal, tools: runtime(aCalls) }))) {
      if (event.type === "session") setTimeout(() => stopA.abort(), 5);
    }
    const bCalls: unknown[] = [];
    await collect(harness.runTurn(params({ sessionId: "thread-1", tools: runtime(bCalls) })));

    expect(answers[0].result).toMatchObject({ success: false });
    expect(aCalls).toEqual([]);
    expect(bCalls).toEqual([]);
    expect(child().requests("thread/start")).toHaveLength(2);
    expect(turnText(child().requests("turn/start")[1])).toContain("<conversation_history>");
  });

  it("refuses a stopped turn's tool call even when the next turn reuses the thread", async () => {
    const answers: RpcLine[] = [];
    let starts = 0;
    const { harness, child } = setup({
      "turn/start": (params, server) => {
        starts += 1;
        if (starts === 1) return { turn: { id: "A" } };
        setTimeout(async () => {
          answers.push(await toolCall(server, RECORDED_THREAD, "A"));
          answers.push(await toolCall(server, RECORDED_THREAD, "B"));
          server.notify("turn/completed", { threadId: params.threadId, turn: { id: "B", status: "completed" } });
        }, 5);
        return { turn: { id: "B" } };
      },
      // A winds down promptly once interrupted.
      "turn/interrupt": (params, server) => {
        setTimeout(() => server.notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } }), 1);
        return {};
      },
    });
    const stopA = new AbortController();
    for await (const event of harness.runTurn(params({ signal: stopA.signal }))) {
      if (event.type === "session") setTimeout(() => stopA.abort(), 5);
    }
    const bCalls: unknown[] = [];
    await collect(harness.runTurn(params({ sessionId: RECORDED_THREAD, tools: runtime(bCalls) })));
    expect(child().requests("thread/start")).toHaveLength(1);
    expect(answers.map((answer) => (answer.result as { success: boolean }).success)).toEqual([false, true]);
    expect(bCalls).toHaveLength(1);
  });
});

/* ── a dead app-server stays dead (C15) ────────────────────────── */

describe("Codex harness after the app-server goes away", () => {
  it("doesn't relaunch Codex to interrupt a turn whose app-server crashed", async () => {
    const { harness, server, children } = setup({ "turn/start": () => ({ turn: { id: RECORDED_TURN } }) });
    for await (const event of harness.runTurn(params())) {
      if (event.type === "session") setTimeout(() => children.at(-1)!.exit(1), 20);
    }
    await sleep(50);
    expect(children).toHaveLength(1);
    expect(server.running).toBe(false);
  });

  it("doesn't revive a replaced app-server", async () => {
    const make = () => {
      const spawned: FakeAppServer[] = [];
      const instance = new CodexAppServer({
        bin: "/opt/codex",
        env: {},
        spawn: () => {
          const child = new FakeAppServer({
            "thread/start": () => ({ thread: { id: RECORDED_THREAD } }),
            "turn/start": () => ({ turn: { id: RECORDED_TURN } }),
            "turn/interrupt": () => ({}),
          });
          spawned.push(child);
          return child;
        },
        makeWorkDir: async () => "/tmp/nb-codex",
        requestTimeoutMs: 2_000,
      });
      return { instance, spawned };
    };
    const a = make();
    const b = make();
    let current = a.instance;
    const harness = createCodexHarness({
      lookupBinary: () => ({ path: "/opt/codex", source: "bundled" }),
      getServer: () => current,
      state: createCodexHarnessState(),
      idleWaitMs: 200,
      mcpStartupWaitMs: 5,
    });
    const events: HarnessEvent[] = [];
    for await (const event of harness.runTurn(params())) {
      events.push(event);
      if (event.type === "session") {
        setTimeout(() => {
          current = b.instance; // e.g. NB_CODEX_BIN changed
          a.instance.stop();
        }, 20);
      }
    }
    await sleep(50);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "harness_error" });
    expect(a.spawned).toHaveLength(1);
    expect(a.instance.running).toBe(false);
    expect(b.spawned).toHaveLength(0);
  });
});

/* ── releasing threads (C18) ───────────────────────────────────── */

describe("Codex harness thread housekeeping", () => {
  it("keeps at most maxThreads, releasing the least recently used", async () => {
    let now = 1_000;
    const { harness, child, state } = setup(
      { "thread/start": numberedThreads(), "turn/start": completingTurn() },
      { maxThreads: 2, now: () => now },
    );
    for (let i = 0; i < 3; i++) {
      await collect(harness.runTurn(params()));
      now += 1_000;
    }
    expect(child().requests("thread/unsubscribe").map((line) => line.params)).toEqual([{ threadId: "thread-1" }]);
    expect([...state.threads.keys()]).toEqual(["thread-2", "thread-3"]);
  });

  it("releases threads idle past the TTL; their session continues on a new thread with the history", async () => {
    let now = 1_000;
    const { harness, child, state } = setup(
      { "thread/start": numberedThreads(), "turn/start": completingTurn() },
      { threadIdleTtlMs: 60_000, now: () => now },
    );
    await collect(harness.runTurn(params()));
    now += 61_000;
    const events = await collect(harness.runTurn(params({ sessionId: "thread-1" })));
    expect(child().requests("thread/unsubscribe").map((line) => line.params)).toEqual([{ threadId: "thread-1" }]);
    expect(state.threads.has("thread-1")).toBe(false);
    expect(events[0]).toEqual({ type: "session", sessionId: "thread-2" });
    expect(turnText(child().requests("turn/start")[1])).toContain("<conversation_history>");
  });

  it("releases a thread superseded by new instructions", async () => {
    const { harness, child } = setup({ "thread/start": numberedThreads(), "turn/start": completingTurn() });
    await collect(harness.runTurn(params()));
    await collect(harness.runTurn(params({ sessionId: "thread-1", systemPrompt: "New instructions." })));
    expect(child().requests("thread/unsubscribe").map((line) => line.params)).toEqual([{ threadId: "thread-1" }]);
  });

  it("forgets a thread Codex closed", async () => {
    const { harness, child, state } = setup({ "turn/start": completingTurn() });
    await collect(harness.runTurn(params()));
    child().notify("thread/closed", { threadId: RECORDED_THREAD });
    await sleep(5);
    expect(state.threads.has(RECORDED_THREAD)).toBe(false);
  });

  it("never releases a thread whose turn is running", async () => {
    let starts = 0;
    const { harness, child, state } = setup(
      {
        "thread/start": numberedThreads(),
        "turn/start": (params, server) => (++starts === 1 ? { turn: { id: "long" } } : completingTurn()(params, server)),
      },
      { maxThreads: 1 },
    );
    const stop = new AbortController();
    const running = collect(harness.runTurn(params({ signal: stop.signal })));
    await sleep(30);
    await collect(harness.runTurn(params()));
    expect(state.threads.has("thread-1")).toBe(true);
    expect(child().requests("thread/unsubscribe").map((line) => line.params)).not.toContainEqual({ threadId: "thread-1" });
    stop.abort();
    await running;
  });
});

/* ── "Planning edits…" while Codex is silent (C42) ─────────────── */

describe("Codex harness planning hint", () => {
  const quietThenReply =
    (replyAfterMs: number): FakeHandler =>
    (params, server) => {
      const threadId = params.threadId;
      setTimeout(() => server.notify("item/completed", { threadId, turnId: "T", item: { type: "reasoning", id: "r1", summary: ["Planning the graph"] } }), 1);
      setTimeout(() => {
        server.notify("item/agentMessage/delta", { threadId, turnId: "T", itemId: "m1", delta: "Done." });
        server.notify("item/completed", { threadId, turnId: "T", item: { type: "agentMessage", id: "m1", text: "Done." } });
        server.notify("turn/completed", { threadId, turn: { id: "T", status: "completed" } });
      }, replyAfterMs);
      return { turn: { id: "T" } };
    };

  it("reports a pending edit when the model goes quiet after thinking (Codex doesn't stream tool input)", async () => {
    const { harness } = setup({ "turn/start": quietThenReply(80) }, { planningHintMs: 20 });
    const events = await collect(harness.runTurn(params({ tools: writeRuntime() })));
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "reasoning-delta",
      "reasoning-end",
      "tool-pending",
      "text-delta",
      "text-end",
    ]);
    expect(events[3]).toEqual({ type: "tool-pending", toolName: "edit_workflow" });
  });

  it("says nothing when the reply comes quickly", async () => {
    const { harness } = setup({ "turn/start": quietThenReply(5) }, { planningHintMs: 40 });
    const events = await collect(harness.runTurn(params({ tools: writeRuntime() })));
    expect(events.some((event) => event.type === "tool-pending")).toBe(false);
  });
});

/* ── status and sign-in ────────────────────────────────────────── */

describe("Codex harness getStatus", () => {
  it("is ready on a ChatGPT login, with models and version", async () => {
    const { harness } = setup();
    expect(await harness.getStatus()).toEqual({
      id: "codex",
      label: "Codex",
      installed: true,
      version: "0.157.0",
      signedIn: true,
      billing: "subscription",
      account: { email: "person@example.com", plan: "Pro" },
      models: [
        { id: "gpt-6-astra", label: "GPT-6-Astra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", isDefault: true },
      ],
      signIn: { state: "idle" },
      signInCommand: "codex login",
    });
  });

  it("explains an API-key login", async () => {
    const { harness } = setup({ "account/read": () => ({ account: { type: "apiKey" } }) });
    const status = await harness.getStatus();
    expect(status).toMatchObject({ installed: true, signedIn: true, billing: "api" });
    expect(status.problem).toMatch(/API key/);
  });

  it("reports an app-server that won't start", async () => {
    const { harness } = setup({ initialize: () => { throw new Error("unsupported"); } });
    const status = await harness.getStatus();
    expect(status.installed).toBe(false);
    expect(status.problem).toMatch(/couldn't be started/);
  });

  it("caches, and drops the cache when the account changes", async () => {
    const { harness, child } = setup();
    await harness.getStatus();
    await harness.getStatus();
    expect(child().requests("account/read")).toHaveLength(1);
    child().notify("account/updated", { authMode: "chatgpt", planType: "pro" });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.getStatus();
    expect(child().requests("account/read")).toHaveLength(2);
  });
});

describe("Codex harness startSignIn", () => {
  const signedOut: Record<string, FakeHandler> = { "account/read": () => ({ account: null, requiresOpenaiAuth: true }) };

  it("starts the ChatGPT browser flow and clears it on completion", async () => {
    const { harness, child } = setup({
      ...signedOut,
      "account/login/start": () => ({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" }),
    });
    const started = await harness.startSignIn();
    expect(started).toMatchObject({ state: "pending", url: "https://auth.openai.com/oauth/authorize?x=1" });
    expect(child().requests("account/login/start").map((line) => line.params)).toEqual([{ type: "chatgpt" }]);
    expect((await harness.getStatus()).signIn).toEqual({ state: "pending", url: "https://auth.openai.com/oauth/authorize?x=1" });

    child().notify("account/login/completed", { loginId: "login-1", success: true, error: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await harness.getStatus()).signIn).toEqual({ state: "idle" });
  });

  it("falls back to the device-code flow, never to an API key", async () => {
    const { harness, child } = setup({
      ...signedOut,
      "account/login/start": (params: { type: string }) => {
        if (params.type === "chatgpt") throw new Error("port 1455 in use");
        return { type: "chatgptDeviceCode", loginId: "login-2", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
      },
    });
    const started = await harness.startSignIn();
    expect(started).toMatchObject({ state: "pending", url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
    expect(child().requests("account/login/start").map((line) => (line.params as { type: string }).type)).toEqual([
      "chatgpt",
      "chatgptDeviceCode",
    ]);
  });

  it("reports a failed login", async () => {
    const { harness, child } = setup({
      ...signedOut,
      "account/login/start": () => ({ type: "chatgpt", loginId: "login-3", authUrl: "https://auth.openai.com/x" }),
    });
    await harness.startSignIn();
    child().notify("account/login/completed", { loginId: "login-3", success: false, error: "access denied" });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await harness.getStatus()).signIn).toEqual({ state: "failed", error: "access denied" });
  });

  it("doesn't start a flow when already signed in", async () => {
    const { harness, child } = setup();
    expect(await harness.startSignIn()).toMatchObject({ state: "already_signed_in" });
    expect(child().requests("account/login/start")).toHaveLength(0);
  });
});

/* ── tool schemas ──────────────────────────────────────────────── */

describe("codexInputSchema", () => {
  it("converts zod shapes (records included) to plain JSON Schema", () => {
    const schema = codexInputSchema({
      nodeId: z.string().describe("Node id"),
      settings: z.record(z.string(), z.unknown()).optional(),
      op: z.enum(["add_node", "remove_node"]),
    });
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node id" },
        settings: { type: "object" },
        op: { type: "string", enum: ["add_node", "remove_node"] },
      },
      required: ["nodeId", "op"],
    });
  });
});
