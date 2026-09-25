// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AbortError, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentHarness, AgentSignInStart, AgentToolRuntime, HarnessEvent, HarnessTurnParams } from "../../types";
import type { CommandResult } from "../binaries";
import {
  buildClaudeTools,
  CLAUDE_AUTH_STATUS_ARGS,
  createClaudeHarness,
  createClaudeHarnessState,
  fullPlanWindow,
  parseAuthStatusOutput,
  parseClaudeVersion,
  type ClaudeHarnessDeps,
} from "../claudeHarness";
import { ClaudeSignIn, type SignInProcess } from "../claudeSignIn";
import { buildClaudeEnv } from "../env";

const recorded = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "claude-turn.json"), "utf8")) as SDKMessage[];

const BIN = "/opt/claude/bin/claude";
const AGENT_CWD = mkdtempSync(path.join(os.tmpdir(), "nb-claude-harness-"));
afterAll(() => rmSync(AGENT_CWD, { recursive: true, force: true }));
const SUBSCRIPTION = { email: "person@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" };

/* ── fakes ─────────────────────────────────────────────────────── */

interface FakeScript {
  account?: Record<string, unknown>;
  initError?: Error;
  /**
   * Claude Code's /usage answer (experimental control request). Absent: a plan
   * with room and extra usage off. null: the request is unsupported (throws).
   */
  usage?: Record<string, unknown> | null;
  /** The /usage answer never comes. */
  usageHangs?: boolean;
  messages?: unknown[];
  /** Thrown by the iterator after the messages. */
  throwAfter?: Error;
  /** Wait for an abort after the messages instead of ending. */
  hangUntilAbort?: boolean;
}

/** A /usage answer: the plan has room, extra usage is off. */
const ROOMY_PLAN = usageReport({ five_hour: 12, seven_day: 30 }, false);

/** A /usage answer with the given window percentages; `extraUsage` undefined leaves extra_usage out. */
function usageReport(windows: Record<string, number>, extraUsage?: boolean): Record<string, unknown> {
  const rateLimits: Record<string, unknown> = Object.fromEntries(
    Object.entries(windows).map(([name, utilization]) => [name, { utilization, resets_at: "2026-09-26T20:30:00Z" }]),
  );
  if (extraUsage !== undefined) {
    rateLimits.extra_usage = { is_enabled: extraUsage, monthly_limit: 5000, used_credits: 0, utilization: 0 };
  }
  return { rate_limits_available: true, rate_limits: rateLimits };
}

class FakeQuery {
  sent: SDKUserMessage[] = [];
  closed = false;
  usageCalls = 0;

  constructor(
    readonly prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
    private readonly script: FakeScript,
  ) {}

  async initializationResult() {
    if (this.script.initError) throw this.script.initError;
    return { account: this.script.account ?? SUBSCRIPTION, models: [], commands: [], agents: [] };
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    this.usageCalls += 1;
    if (this.script.usageHangs) return new Promise<never>(() => {});
    if (this.script.usage === null) throw new Error("Unsupported control request: get_usage");
    return this.script.usage ?? ROOMY_PLAN;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    // Like the CLI: wait for the first user message; none means no turn.
    const input = this.prompt[Symbol.asyncIterator]();
    const first = await input.next();
    if (first.done) return;
    this.sent.push(first.value);
    const signal = this.options.abortController?.signal;
    for (const message of this.script.messages ?? []) {
      if (signal?.aborted) throw new AbortError("Operation aborted");
      yield message as SDKMessage;
    }
    if (this.script.hangUntilAbort) {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw new AbortError("Operation aborted");
    }
    if (this.script.throwAfter) throw this.script.throwAfter;
    await input.next();
  }

  close() {
    this.closed = true;
  }
}

function fakeQueries(...scripts: FakeScript[]) {
  const made: FakeQuery[] = [];
  const query = vi.fn(({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const fake = new FakeQuery(prompt as AsyncIterable<SDKUserMessage>, options ?? {}, scripts[made.length] ?? {});
    made.push(fake);
    return fake as unknown as ReturnType<ClaudeHarnessDeps["query"]>;
  });
  return { query, made };
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
    history: [],
    prompt: "<canvas/>\n<user>add 2 and 3</user>",
    systemPrompt: "You are Node Banana's workflow agent.",
    tools: runtime(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function stubSignIn() {
  return new ClaudeSignIn({ spawn: () => { throw new Error("no spawning in tests"); } });
}

function harness(overrides: Partial<ClaudeHarnessDeps> = {}) {
  return createClaudeHarness({
    lookupBinary: () => ({ path: BIN, source: "bundled" }),
    buildEnv: () => buildClaudeEnv({ HOME: "/Users/someone", PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api", CLAUDECODE: "1" }),
    agentCwd: AGENT_CWD,
    signIn: stubSignIn(),
    state: createClaudeHarnessState(),
    // Status probes a Claude Code that reports the subscription login, unless a test says otherwise.
    query: fakeQueries().query,
    runCommand: commands({ code: 0, stdout: SIGNED_IN_JSON, stderr: "" }),
    ...overrides,
  });
}

/** A rate_limit_event as Claude Code sends it once the plan's included usage is gone and extra usage pays. */
function overageEvent(info: Record<string, unknown> = {}) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      rateLimitType: "five_hour",
      overageStatus: "allowed",
      isUsingOverage: true,
      overageInUse: true,
      resetsAt: 1790368200,
      overageResetsAt: 1792000000,
      ...info,
    },
    uuid: "u-rate",
    session_id: "42aeca93-6672-48dd-897c-3b62f633dd55",
  };
}

/** `startSignIn({ force: true })`: the harness takes the option; AgentHarness in types.ts doesn't list it yet. */
function forceSignIn(harness: AgentHarness): Promise<AgentSignInStart> {
  return harness.startSignIn({ force: true });
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/* ── runTurn ───────────────────────────────────────────────────── */

describe("Claude harness runTurn", () => {
  it("runs the recorded turn and yields the mapped events", async () => {
    const { query, made } = fakeQueries({ messages: recorded });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "tool-pending",
      "text-delta",
      "text-delta",
      "text-delta",
      "text-delta",
      "text-delta",
      "text-end",
      "usage",
    ]);
    expect(made).toHaveLength(1);
    expect(made[0].closed).toBe(true);
  });

  it.each([
    ["an API key", { tokenSource: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, "wrong_billing"],
    ["a Console login", { apiKeySource: "/login managed key", apiProvider: "firstParty" }, "wrong_billing"],
    ["a bearer token", { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" }, "wrong_billing"],
    ["Bedrock", { apiProvider: "bedrock" }, "wrong_billing"],
    ["no login", { tokenSource: "none", apiProvider: "firstParty" }, "not_signed_in"],
  ])("never sends the prompt when Claude Code would use %s", async (_label, account, code) => {
    const { query, made } = fakeQueries({ account, messages: recorded });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events).toEqual([{ type: "error", code, message: expect.any(String) }]);
    expect(made[0].sent).toEqual([]);
    // The prompt stream ends without ever yielding the message.
    expect(await made[0].prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
  });

  it("locks the CLI down to our tools, our prompt and the stripped environment", async () => {
    const { query, made } = fakeQueries({ messages: recorded });
    await collect(harness({ query }).runTurn(params({ model: "haiku", sessionId: "s-9" })));
    const options = made[0].options;
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: BIN,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      allowedTools: ["mcp__node_banana__add_numbers"],
      permissionMode: "dontAsk",
      systemPrompt: "You are Node Banana's workflow agent.",
      model: "haiku",
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      maxTurns: 40,
      resume: "s-9",
    });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["node_banana"]);
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("CLAUDECODE");
    expect(options.env).toMatchObject({ HOME: "/Users/someone", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });

  it("defaults to Sonnet and lets 'default' pick the plan's model", async () => {
    const first = fakeQueries({ messages: recorded });
    await collect(harness({ query: first.query }).runTurn(params()));
    expect(first.made[0].options.model).toBe("sonnet");
    const second = fakeQueries({ messages: recorded });
    await collect(harness({ query: second.query }).runTurn(params({ model: "default" })));
    expect(second.made[0].options.model).toBeUndefined();
  });

  it("seeds a new session with the chat history", async () => {
    const { query, made } = fakeQueries({ messages: recorded });
    await collect(
      harness({ query }).runTurn(
        params({ history: [{ role: "user", text: "make a portrait workflow" }, { role: "assistant", text: "Done." }] }),
      ),
    );
    const content = made[0].sent[0].message.content as string;
    expect(content).toContain("<conversation_history>");
    expect(content).toContain("User: make a portrait workflow");
    expect(content.endsWith("<canvas/>\n<user>add 2 and 3</user>")).toBe(true);
    expect(made[0].options.resume).toBeUndefined();
  });

  it("sends a resumed session only the new prompt", async () => {
    const { query, made } = fakeQueries({ messages: recorded });
    await collect(harness({ query }).runTurn(params({ sessionId: "s-1", history: [{ role: "user", text: "old" }] })));
    expect(made[0].sent[0].message.content).toBe("<canvas/>\n<user>add 2 and 3</user>");
  });

  it("starts over with the history when the session is gone", async () => {
    const { query, made } = fakeQueries(
      { initError: new Error("Claude Code returned an error result: No conversation found with session ID: s-gone") },
      { messages: recorded },
    );
    const events = await collect(
      harness({ query }).runTurn(params({ sessionId: "s-gone", history: [{ role: "user", text: "earlier" }] })),
    );
    expect(made).toHaveLength(2);
    expect(made[0].options.resume).toBe("s-gone");
    expect(made[1].options.resume).toBeUndefined();
    expect(made[1].sent[0].message.content).toContain("User: earlier");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events[0]).toEqual({ type: "session", sessionId: "42aeca93-6672-48dd-897c-3b62f633dd55" });
  });

  it("does not repeat the error the SDK throws after an error result", async () => {
    const { query } = fakeQueries({
      messages: [
        {
          type: "assistant",
          parent_tool_use_id: null,
          error: "authentication_failed",
          uuid: "u",
          session_id: "s",
          message: { id: "x", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        },
        { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: {}, session_id: "s", uuid: "u" },
      ],
      throwAfter: new Error("Claude Code returned an error result: Not logged in · Please run /login"),
    });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "not_signed_in", message: expect.any(String) }]);
  });

  it("stops the query when our tools failed to load", async () => {
    const { query, made } = fakeQueries({
      messages: [{ type: "system", subtype: "init", session_id: "s", tools: [], apiKeySource: "none" }, ...recorded.slice(1)],
    });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events).toEqual([
      { type: "session", sessionId: "s" },
      { type: "error", code: "harness_error", message: expect.stringMatching(/tools failed to load/) },
    ]);
    expect(made[0].options.abortController?.signal.aborted).toBe(true);
  });

  it("reports an unexpected crash with the CLI's last stderr line", async () => {
    const { query } = fakeQueries({ messages: [recorded[0]], throwAfter: new Error("Claude Code process exited with code 1") });
    const wrapped = vi.fn((input: Parameters<typeof query>[0]) => {
      input.options?.stderr?.("fatal: something broke\n");
      return query(input);
    });
    const events = await collect(harness({ query: wrapped as unknown as typeof query }).runTurn(params()));
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "harness_error",
      message: "Claude Code stopped unexpectedly: Claude Code process exited with code 1 (fatal: something broke)",
    });
  });

  it("ends quietly when the request is aborted mid-turn", async () => {
    const controller = new AbortController();
    const { query, made } = fakeQueries({ messages: recorded.slice(0, 3), hangUntilAbort: true });
    const events: HarnessEvent[] = [];
    for await (const event of harness({ query }).runTurn(params({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === "session") controller.abort();
    }
    expect(events.map((event) => event.type)).toEqual(["session"]);
    expect(made[0].options.abortController?.signal.aborted).toBe(true);
  });

  it("doesn't start when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { query, made } = fakeQueries({ messages: recorded });
    const events = await collect(harness({ query }).runTurn(params({ signal: controller.signal })));
    expect(events).toEqual([]);
    expect(made).toHaveLength(0);
  });

  it("reports a missing binary as not_installed", async () => {
    const { query } = fakeQueries();
    const events = await collect(
      harness({ query, lookupBinary: () => ({ path: null, problem: "Claude Code wasn't found." }) }).runTurn(params()),
    );
    expect(events).toEqual([{ type: "error", code: "not_installed", message: "Claude Code wasn't found." }]);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports a CLI that never finishes starting", async () => {
    const { query } = fakeQueries({ initError: new Error("spawn EACCES") });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "harness_error", message: expect.stringMatching(/EACCES/) }]);
  });
});

/* ── extra usage (the plan's included usage is used up) ────────── */

describe("Claude harness and extra usage", () => {
  it("stops a turn the moment Claude Code switches to extra usage, and refuses the next until the reset", async () => {
    let now = 1790360000_000;
    const calls: unknown[] = [];
    const { query, made } = fakeQueries({
      messages: [recorded[0], overageEvent(), ...recorded.slice(5, 12)],
      hangUntilAbort: true,
    });
    const claude = harness({ query, now: () => now, runCommand: commands({ code: 0, stdout: SIGNED_IN_JSON, stderr: "" }) });

    const events = await collect(claude.runTurn(params({ tools: runtime(calls) })));
    expect(events.at(-1)).toEqual({ type: "error", code: "usage_limit", message: expect.stringMatching(/extra usage/) });
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(made[0].options.abortController?.signal.aborted).toBe(true);
    expect(calls).toEqual([]);

    // Before the plan window resets: no Claude Code at all.
    now += 60_000;
    const again = await collect(claude.runTurn(params()));
    expect(again).toEqual([{ type: "error", code: "usage_limit", message: expect.stringMatching(/extra usage/) }]);
    expect(query).toHaveBeenCalledTimes(1);
    const status = await claude.getStatus();
    expect(status).toMatchObject({ signedIn: true, billing: "subscription" });
    expect(status.problem).toMatch(/extra usage/);
    // The same block as a field, with the plan's reset time.
    expect(status.usageLimit).toEqual({ message: status.problem, until: 1790368200_000 });

    // After it resets, turns run again.
    now = 1790368200_000 + 1;
    const reset = await claude.getStatus();
    expect(reset.problem).toBeUndefined();
    expect(reset.usageLimit).toBeUndefined();
  });

  it("keeps a turn on included usage running (the recorded plan still had room)", async () => {
    const { query, made } = fakeQueries({ messages: recorded });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(made[0].options.abortController?.signal.aborted).toBe(false);
  });

  it("never sends the prompt when the plan's five-hour window is already full", async () => {
    const { query, made } = fakeQueries({
      messages: recorded,
      usage: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 100, resets_at: "2026-09-26T20:30:00Z" },
          seven_day: { utilization: 61, resets_at: "2026-09-29T02:00:00Z" },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0, utilization: 0 },
        },
      },
    });
    const claude = harness({ query });
    const events = await collect(claude.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: expect.stringMatching(/included usage is used up/) }]);
    expect(made[0].sent).toEqual([]);
    // Remembered: the next turn doesn't even start Claude Code.
    await collect(claude.runTurn(params()));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("skips the usage check for a while after a report showed extra usage off", async () => {
    let now = 1_000;
    const { query, made } = fakeQueries({ messages: recorded }, { messages: recorded }, { messages: recorded });
    const claude = harness({ query, now: () => now });
    await collect(claude.runTurn(params())); // no report yet: checks, and learns extra usage is off
    await collect(claude.runTurn(params())); // skipped: past the plan Claude Code would stop, not bill
    now += 6 * 60_000;
    await collect(claude.runTurn(params())); // stale: checks again
    expect(made.map((fake) => fake.usageCalls)).toEqual([1, 0, 1]);
    expect(made.every((fake) => fake.sent.length === 1)).toBe(true);
  });

  it("checks before every turn while extra usage is on, even when the turn reports the plan allowed", async () => {
    const extraOn = usageReport({ five_hour: 20, seven_day: 40 }, true);
    const { query, made } = fakeQueries({ messages: recorded, usage: extraOn }, { messages: recorded, usage: extraOn });
    const claude = harness({ query });
    await collect(claude.runTurn(params()));
    await collect(claude.runTurn(params()));
    expect(made.map((fake) => fake.usageCalls)).toEqual([1, 1]);
    expect(made.map((fake) => fake.sent.length)).toEqual([1, 1]);
  });

  it("stops trusting 'extra usage off' once a turn shows extra usage is on", async () => {
    const { query, made } = fakeQueries(
      { messages: [recorded[0], overageEvent({ status: "allowed_warning", overageStatus: "allowed", isUsingOverage: false, overageInUse: false }), ...recorded.slice(5)] },
      { messages: recorded },
    );
    const claude = harness({ query });
    await collect(claude.runTurn(params())); // the report said off; the turn's own event says overage is allowed
    await collect(claude.runTurn(params()));
    expect(made.map((fake) => fake.usageCalls)).toEqual([1, 1]);
  });

  it("goes ahead when the plan has room, with extra usage on or not reported", async () => {
    for (const usage of [usageReport({ five_hour: 47, seven_day: 60 }, true), usageReport({ five_hour: 47 })]) {
      const roomy = fakeQueries({ messages: recorded, usage });
      const events = await collect(harness({ query: roomy.query }).runTurn(params()));
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(roomy.made[0].sent).toHaveLength(1);
    }
  });

  it("goes ahead close to the limit when extra usage is off (Claude Code would stop, not bill)", async () => {
    const { query, made } = fakeQueries({ messages: recorded, usage: usageReport({ five_hour: 99, seven_day: 97 }, false) });
    const events = await collect(harness({ query }).runTurn(params()));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(made[0].sent).toHaveLength(1);
  });

  it.each([
    ["on", true],
    ["not reported", undefined],
  ])("never sends the prompt close to the limit when extra usage is %s", async (_label, extraUsage) => {
    const { query, made } = fakeQueries({ messages: recorded, usage: usageReport({ five_hour: 92, seven_day: 50 }, extraUsage) });
    const claude = harness({ query });
    const events = await collect(claude.runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: expect.stringMatching(/92% used/) }]);
    expect(made[0].sent).toEqual([]);
    // Not remembered as a block: turning extra usage off lets the next turn run.
    const status = await claude.getStatus();
    expect(status.usageLimit).toBeUndefined();
  });

  it("uses the chosen model family's weekly window too", async () => {
    const usage = usageReport({ five_hour: 10, seven_day: 20, seven_day_opus: 93 }, true);
    const opus = fakeQueries({ messages: recorded, usage });
    expect(await collect(harness({ query: opus.query }).runTurn(params({ model: "opus" })))).toEqual([
      { type: "error", code: "usage_limit", message: expect.stringMatching(/93% used/) },
    ]);
    const sonnet = fakeQueries({ messages: recorded, usage });
    expect((await collect(harness({ query: sonnet.query }).runTurn(params({ model: "sonnet" })))).some((e) => e.type === "error")).toBe(false);
  });

  it.each([
    ["the usage request is unsupported", { usage: null }],
    ["the usage request never answers", { usageHangs: true }],
    ["the report has no plan limits", { usage: { rate_limits_available: false, rate_limits: null } }],
    ["the report claims limits but carries none", { usage: { rate_limits_available: true, rate_limits: null } }],
  ])("fails closed when %s: the prompt is never sent", async (_label, script: Partial<FakeScript>) => {
    const { query, made } = fakeQueries({ messages: recorded, ...script });
    const events = await collect(harness({ query, usageCheckTimeoutMs: 20 }).runTurn(params()));
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: expect.stringMatching(/Couldn't confirm/) }]);
    expect(made[0].sent).toEqual([]);
    expect(made[0].closed).toBe(true);
  });

  it("explains that a setup-token login can't be checked, instead of retrying forever", async () => {
    const { query, made } = fakeQueries({ messages: recorded, usage: { rate_limits_available: false, rate_limits: null } });
    const claude = harness({
      query,
      buildEnv: () => buildClaudeEnv({ HOME: "/Users/someone", PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }),
    });
    const events = await collect(claude.runTurn(params()));
    expect(events).toEqual([
      { type: "error", code: "wrong_billing", message: expect.stringMatching(/CLAUDE_CODE_OAUTH_TOKEN[^]*claude auth login/) },
    ]);
    expect(made[0].sent).toEqual([]);
  });
});

describe("fullPlanWindow", () => {
  it("is set only for a full five-hour or weekly window (or the chosen family's weekly window)", () => {
    const at = "2026-09-29T02:00:00Z";
    expect(fullPlanWindow({ five_hour: { utilization: 99.9, resets_at: at } }, "sonnet")).toBeNull();
    expect(fullPlanWindow({ seven_day: { utilization: 100, resets_at: at } }, "sonnet")).toEqual({ resetsAt: Date.parse(at) });
    expect(fullPlanWindow({ seven_day_opus: { utilization: 100, resets_at: at } }, "sonnet")).toBeNull();
    expect(fullPlanWindow({ seven_day_opus: { utilization: 100, resets_at: at } }, "opus")).not.toBeNull();
    expect(fullPlanWindow(null, "sonnet")).toBeNull();
  });
});

/* ── a sign-in the vendor rejected ─────────────────────────────── */

describe("Claude harness after Claude rejects its saved sign-in", () => {
  const revoked: FakeScript = {
    messages: [
      recorded[0],
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "authentication_failed",
        uuid: "u",
        session_id: "s",
        message: { id: "x", content: [{ type: "text", text: "OAuth token revoked · Please run /login" }] },
      },
      { type: "result", subtype: "success", is_error: true, result: "OAuth token revoked · Please run /login", usage: {}, session_id: "s", uuid: "u" },
    ],
    throwAfter: new Error("Claude Code returned an error result: OAuth token revoked · Please run /login"),
  };

  it("reports signed out and lets the panel start the vendor's sign-in again", async () => {
    const child = new FakeLoginChild();
    const spawn = vi.fn(() => child);
    // Status probes (always the stored login) and the one failing turn.
    const turns = fakeQueries({}, revoked, {}, {});
    const claude = harness({ query: turns.query, signIn: new ClaudeSignIn({ spawn, urlWaitMs: 5 }) });
    expect(await claude.getStatus()).toMatchObject({ signedIn: true, billing: "subscription" });

    const events = await collect(claude.runTurn(params()));
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", code: "not_signed_in", message: expect.stringMatching(/claude auth login/) },
    ]);

    const status = await claude.getStatus();
    expect(status).toMatchObject({ signedIn: false, billing: "none" });
    expect(status.problem).toMatch(/rejected its saved sign-in/);
    expect(status.problem).toMatch(/claude auth login/);

    const started = await claude.startSignIn();
    expect(started.state).toBe("pending");
    expect(spawn).toHaveBeenCalledWith(BIN, ["auth", "login", "--claudeai"], expect.any(Object));
    child.emit("exit", 0, null);
    // A finished sign-in clears it.
    expect(await claude.getStatus()).toMatchObject({ signedIn: true, billing: "subscription" });
  });

  it("won't run `auth login` over a rejected CLAUDE_CODE_OAUTH_TOKEN; it explains instead", async () => {
    const spawn = vi.fn();
    const turns = fakeQueries({ ...revoked, account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }, {
      account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
    });
    const claude = harness({
      query: turns.query,
      buildEnv: () => buildClaudeEnv({ HOME: "/Users/someone", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" }),
      signIn: new ClaudeSignIn({ spawn }),
    });
    await collect(claude.runTurn(params()));
    const started = await claude.startSignIn();
    expect(started).toEqual({ state: "failed", message: expect.stringMatching(/claude setup-token/) });
    expect(spawn).not.toHaveBeenCalled();
    // `force` from a not_signed_in notice gets the same answer.
    expect((await forceSignIn(claude)).state).toBe("failed");
  });

  it("forgets the rejection after a successful turn, or after a while", async () => {
    let now = 1_000;
    // In order: turn (rejected), status probe, turn (fine), turn (rejected), status probe.
    const turns = fakeQueries(revoked, {}, { messages: recorded }, revoked, {});
    const claude = harness({ query: turns.query, now: () => now });
    await collect(claude.runTurn(params()));
    expect((await claude.getStatus()).signedIn).toBe(false);
    await collect(claude.runTurn(params()));
    expect((await claude.getStatus()).signedIn).toBe(true);

    await collect(claude.runTurn(params()));
    expect((await claude.getStatus()).signedIn).toBe(false);
    now += 2 * 60_000;
    expect((await claude.getStatus()).signedIn).toBe(true);
  });

  it("starts the sign-in on force even when Claude Code still looks signed in", async () => {
    const child = new FakeLoginChild();
    const spawn = vi.fn(() => child);
    const claude = harness({ signIn: new ClaudeSignIn({ spawn, urlWaitMs: 5 }) });
    expect((await claude.startSignIn()).state).toBe("already_signed_in");
    expect((await forceSignIn(claude)).state).toBe("pending");
    expect(spawn).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
  });
});

/* ── tools ─────────────────────────────────────────────────────── */

describe("buildClaudeTools", () => {
  it("wraps each tool so the handler calls the runtime and returns its text", async () => {
    const calls: unknown[] = [];
    const [addNumbers] = buildClaudeTools(runtime(calls));
    expect(addNumbers.name).toBe("add_numbers");
    expect(addNumbers.annotations).toMatchObject({ title: "Add numbers", readOnlyHint: true });
    const result = await addNumbers.handler({ a: 2, b: 3 } as never, {});
    expect(calls).toEqual([{ name: "add_numbers", args: { a: 2, b: 3 } }]);
    expect(result).toEqual({ content: [{ type: "text", text: "5" }], isError: false });
  });

  it("marks failed tool results as errors and survives a throwing runtime", async () => {
    const failing: AgentToolRuntime = {
      definitions: runtime().definitions,
      execute: async () => ({ ok: false, text: "Node p1 doesn't exist. Call get_workflow.", summary: "Failed", ops: [] }),
    };
    expect(await buildClaudeTools(failing)[0].handler({ a: 1, b: 1 } as never, {})).toEqual({
      content: [{ type: "text", text: "Node p1 doesn't exist. Call get_workflow." }],
      isError: true,
    });
    const throwing: AgentToolRuntime = {
      definitions: runtime().definitions,
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const result = await buildClaudeTools(throwing)[0].handler({ a: 1, b: 1 } as never, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "The add_numbers tool failed: kaboom" });
  });
});

/* ── getStatus / startSignIn ───────────────────────────────────── */

function commands(auth: CommandResult, version: CommandResult = { code: 0, stdout: "2.1.282 (Claude Code)\n", stderr: "" }) {
  return vi.fn(async (_bin: string, args: string[], _options: { env: Record<string, string>; cwd?: string }) =>
    args[0] === "--version" ? version : auth,
  );
}

const SIGNED_IN_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "person@example.com",
  subscriptionType: "max",
});

describe("Claude harness getStatus", () => {
  it("is ready on a subscription login, read from a Claude Code started like a turn (no prompt)", async () => {
    const probe = fakeQueries();
    const runCommand = commands({ code: 0, stdout: SIGNED_IN_JSON, stderr: "" });
    const status = await harness({ query: probe.query, runCommand }).getStatus();
    expect(status).toEqual({
      id: "claude",
      label: "Claude Code",
      installed: true,
      version: "2.1.282",
      signedIn: true,
      billing: "subscription",
      account: { email: "person@example.com", plan: "Max" },
      models: expect.arrayContaining([expect.objectContaining({ id: "sonnet", isDefault: true })]),
      signIn: { state: "idle" },
      signInCommand: "claude auth login",
    });
    // Same binary, env and setting sources as a turn; never a prompt, and closed afterwards.
    expect(probe.made).toHaveLength(1);
    expect(probe.made[0].options).toMatchObject({ pathToClaudeCodeExecutable: BIN, settingSources: [], tools: [], strictMcpConfig: true });
    expect(probe.made[0].options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(probe.made[0].sent).toEqual([]);
    expect(probe.made[0].closed).toBe(true);
    expect(runCommand.mock.calls.filter(([, args]) => args.includes("auth"))).toHaveLength(0);
  });

  it("ignores user settings a turn wouldn't load (an apiKeyHelper in settings.json)", async () => {
    // `claude auth status` without --setting-sources would report the helper; the turn's account doesn't.
    const helper = JSON.stringify({ loggedIn: true, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper", apiProvider: "firstParty" });
    const status = await harness({ runCommand: commands({ code: 0, stdout: helper, stderr: "" }) }).getStatus();
    expect(status).toMatchObject({ signedIn: true, billing: "subscription" });
  });

  it("explains a signed-out Claude Code", async () => {
    const probe = fakeQueries({ account: { tokenSource: "none", apiProvider: "firstParty" } });
    const status = await harness({ query: probe.query }).getStatus();
    expect(status).toMatchObject({ installed: true, signedIn: false, billing: "none", signIn: { state: "idle" } });
    expect(status.problem).toMatch(/isn't signed in/);
  });

  it("refuses what a turn would refuse (an API key the CLI would use)", async () => {
    const probe = fakeQueries({ account: { tokenSource: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } });
    const status = await harness({ query: probe.query }).getStatus();
    expect(status).toMatchObject({ signedIn: true, billing: "api" });
  });

  describe("when the account probe fails", () => {
    const noProbe = () => fakeQueries({ initError: new Error("unknown option") }).query;

    it("falls back to `auth status` with the turn's setting sources", async () => {
      const runCommand = commands({ code: 0, stdout: SIGNED_IN_JSON, stderr: "" });
      const status = await harness({ query: noProbe(), runCommand }).getStatus();
      expect(status).toMatchObject({ installed: true, signedIn: true, billing: "subscription" });
      expect(runCommand).toHaveBeenCalledWith(BIN, CLAUDE_AUTH_STATUS_ARGS, expect.objectContaining({ env: expect.any(Object) }));
      expect(CLAUDE_AUTH_STATUS_ARGS).toEqual(["--setting-sources=", "auth", "status"]);
      expect(runCommand.mock.calls.find(([, args]) => args.includes("auth"))?.[2].env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("explains a signed-out CLI (exit 1 with JSON)", async () => {
      const runCommand = commands({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }), stderr: "" });
      const status = await harness({ query: noProbe(), runCommand }).getStatus();
      expect(status).toMatchObject({ installed: true, signedIn: false, billing: "none", signIn: { state: "idle" } });
      expect(status.problem).toMatch(/isn't signed in/);
    });

    it("reports a binary that can't start as not installed", async () => {
      const runCommand = commands({ code: null, stdout: "", stderr: "", error: "claude auth status: spawn EACCES" });
      const status = await harness({ query: noProbe(), runCommand }).getStatus();
      expect(status.installed).toBe(false);
      expect(status.problem).toMatch(/couldn't be started/);
    });

    it("accepts oauth_token only with CLAUDE_CODE_OAUTH_TOKEN in the agent's env", async () => {
      const oauth = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" });
      const withToken = await harness({
        query: noProbe(),
        runCommand: commands({ code: 0, stdout: oauth, stderr: "" }),
        buildEnv: () => buildClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat" }),
      }).getStatus();
      expect(withToken.billing).toBe("subscription");
      const without = await harness({ query: noProbe(), runCommand: commands({ code: 0, stdout: oauth, stderr: "" }) }).getStatus();
      expect(without.billing).toBe("api");
    });
  });

  it("reports a missing binary", async () => {
    const status = await harness({ lookupBinary: () => ({ path: null, problem: "Claude Code wasn't found." }) }).getStatus();
    expect(status).toMatchObject({ installed: false, problem: "Claude Code wasn't found.", billing: "unknown" });
  });

  it("caches for a few seconds", async () => {
    let now = 1_000;
    const probe = fakeQueries();
    const claude = harness({ query: probe.query, now: () => now });
    await claude.getStatus();
    await claude.getStatus();
    expect(probe.query).toHaveBeenCalledTimes(1);
    now += 6_000;
    await claude.getStatus();
    expect(probe.query).toHaveBeenCalledTimes(2);
  });
});

class FakeLoginChild extends EventEmitter implements SignInProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

describe("Claude harness startSignIn", () => {
  it("doesn't start a flow when already signed in", async () => {
    const spawn = vi.fn();
    const status = await harness({
      runCommand: commands({ code: 0, stdout: SIGNED_IN_JSON, stderr: "" }),
      signIn: new ClaudeSignIn({ spawn }),
    }).startSignIn();
    expect(status.state).toBe("already_signed_in");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs `auth login --claudeai` with the agent env and never relays the manual-flow URL (review C20)", async () => {
    const manualUrl =
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code" +
      "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=STATE";
    const child = new FakeLoginChild();
    const spawn = vi.fn(() => {
      setTimeout(() => child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${manualUrl}\nPaste code here if prompted > `), 5);
      return child;
    });
    const signedOut = { account: { tokenSource: "none", apiProvider: "firstParty" } };
    const claude = harness({
      query: fakeQueries(signedOut, signedOut).query,
      signIn: new ClaudeSignIn({ spawn }),
    });
    const started = await claude.startSignIn();
    expect(started).toEqual({ state: "pending", message: expect.stringMatching(/run `claude auth login` in a terminal/) });
    expect(spawn).toHaveBeenCalledWith(BIN, ["auth", "login", "--claudeai"], expect.objectContaining({ cwd: expect.any(String) }));
    const env = (spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.FORCE_HYPERLINK).toBe("0");
    const status = await claude.getStatus();
    expect(status.signIn).toEqual({ state: "pending" });
    expect(JSON.stringify([started, status])).not.toMatch(/oauth\/authorize|platform\.claude\.com/);
    child.emit("exit", 0, null);
  });
});

describe("output parsing", () => {
  it("reads the version and tolerates noise around the status JSON", () => {
    expect(parseClaudeVersion("2.1.282 (Claude Code)\n")).toBe("2.1.282");
    expect(parseClaudeVersion("nope")).toBeUndefined();
    expect(parseAuthStatusOutput(`warning: x\n${SIGNED_IN_JSON}\n`)).toMatchObject({ loggedIn: true });
    expect(parseAuthStatusOutput("Not logged in.")).toBeNull();
  });
});
