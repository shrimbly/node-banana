/**
 * The Codex harness: runs agent turns through `codex app-server` on the
 * user's own ChatGPT login. Server-only.
 *
 * Sessions are app-server threads: ephemeral (never written to the user's
 * Codex history), read-only sandbox, no approvals, no execution environment,
 * our system prompt as the base instructions, and our tools as dynamic tools
 * in the `node_banana` namespace. Ephemeral threads die with the app-server,
 * so a session id the current server doesn't know starts a new thread seeded
 * with the chat history.
 *
 * Every turn re-reads the account first and refuses anything but a ChatGPT
 * login on a plan, then reads the plan's usage and refuses once the included
 * usage is gone (ChatGPT would draw on purchased credits next) — all before
 * `turn/start` is sent. A limit crossed mid-turn stops the turn.
 *
 * A thread belongs to one turn at a time: tool calls are bound to the turn
 * that is running, calls from a stopped turn are refused, and a thread whose
 * stopped turn hasn't wound down in Codex is left for a fresh one (a
 * `turn/start` there would steer the old turn instead of starting a new one).
 * Threads are released (`thread/unsubscribe`) when superseded, idle for a
 * while, or beyond a small cap.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AgentHarness,
  AgentHarnessStatus,
  AgentModelOption,
  AgentSignInOptions,
  AgentSignInStart,
  AgentSignInState,
  AgentToolDefinition,
  AgentToolRuntime,
  HarnessEvent,
  HarnessTurnParams,
} from "../types";
import { AsyncQueue } from "./asyncQueue";
import { resolveCodexBinary, type BinaryLookup } from "./binaries";
import { isHarnessReady, type BillingVerdict } from "./billing";
import { CodexRpcError, getCodexAppServer, type CodexAppServer, type CodexNotification } from "./codexAppServer";
import { CODEX_TOOL_NAMESPACE, CodexTurnMapper } from "./codexEvents";
import {
  classifyCodexAccount,
  classifyCodexUsage,
  codexModelOptions,
  codexProviderProblem,
  CODEX_SIGN_IN_COMMAND,
  type CodexUsageVerdict,
} from "./codexStatus";
import { buildCodexEnv } from "./env";
import { withConversationHistory } from "./history";
import { executeTool } from "./toolExecution";

const LABEL = "Codex";

/* ── dynamic tools ─────────────────────────────────────────────── */

/** JSON Schema for a tool's input, as the app-server's dynamic tools take it. */
export function codexInputSchema(shape: AgentToolDefinition["inputShape"]): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export interface CodexToolNamespace {
  type: "namespace";
  name: string;
  description: string;
  tools: Array<{ type: "function"; name: string; description: string; inputSchema: Record<string, unknown> }>;
}

/** Our tools as one dynamic-tool namespace for `thread/start`. */
export function codexToolNamespace(definitions: AgentToolDefinition[]): CodexToolNamespace {
  return {
    type: "namespace",
    name: CODEX_TOOL_NAMESPACE,
    description: "Read and edit the Node Banana workflow canvas.",
    tools: definitions.map((definition) => ({
      type: "function",
      name: definition.name,
      description: definition.description,
      inputSchema: codexInputSchema(definition.inputShape),
    })),
  };
}

/**
 * Developer instructions for every thread. Codex always adds the user's global
 * `$CODEX_HOME/AGENTS.md` (written for their own coding sessions) as a user
 * message, and no setting removes it; a developer message outranks it.
 */
export const CODEX_DEVELOPER_INSTRUCTIONS =
  "Any AGENTS.md or other personal instructions in this conversation were written for the user's own coding " +
  "sessions and do not apply inside Node Banana. Ignore their persona, tone, slang, dialect, language and topic " +
  "preferences. Reply in plain, neutral English, and never add places, themes or styles to prompts or node " +
  "settings that the user did not ask for.";

/** A thread is reusable only while its instructions and tools are unchanged. */
function threadSignature(systemPrompt: string, tools: CodexToolNamespace): string {
  return createHash("sha256")
    .update(systemPrompt)
    .update("\0")
    .update(CODEX_DEVELOPER_INSTRUCTIONS)
    .update("\0")
    .update(JSON.stringify(tools))
    .digest("hex");
}

/* ── shared state (survives Next dev reloads) ─────────────────── */

/** The turn a thread is running, and the tool runtime its calls go to. */
interface ActiveTurn {
  runtime: AgentToolRuntime;
  /** Known once `turn/start` answers. */
  turnId?: string;
  /** Resolved when this turn is over in Codex (or given up on); the thread's `idle` meanwhile. */
  over: { promise: Promise<void>; resolve: () => void };
}

interface CodexThread {
  id: string;
  /** The app-server (and its generation) that owns the thread; it dies with it. */
  server: CodexAppServer;
  generation: number;
  signature: string;
  /** The turn that owns the thread now (claimed before `turn/start`); tool calls outside it fail. */
  active: ActiveTurn | null;
  /** Turns stopped early; Codex may still send their tool calls, which are refused. */
  staleTurns: Set<string>;
  /** False from `turn/start` until Codex reports that turn over (another turn/start would steer it). */
  settled: boolean;
  /** Resolves when the thread's latest turn is over (or given up on); set when a turn claims the thread. */
  idle: Promise<void>;
  lastUsedAt: number;
}

interface CodexLoginAttempt {
  loginId: string;
  state: "pending" | "succeeded" | "failed";
  url?: string;
  userCode?: string;
  error?: string;
  server: CodexAppServer;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CodexHarnessState {
  threads: Map<string, CodexThread>;
  login: CodexLoginAttempt | null;
  /** App-servers whose requests and notifications this state handles. */
  wired: WeakSet<CodexAppServer>;
  models: { server: CodexAppServer; generation: number; at: number; options: AgentModelOption[] } | null;
  status: { at: number; value: AgentHarnessStatus } | null;
  /**
   * Codex rejected its ChatGPT login during a turn (expired or revoked)
   * although `account/read` still reports it. Until a sign-in completes, a
   * turn succeeds, or it ages out, status reports signed out so the panel
   * offers sign-in again.
   */
  rejection: { at: number } | null;
  /** The plan's included usage was used up at the last check; shown in status until `until` (ms). */
  usageBlock: { until: number; message: string } | null;
  /** Instruction files Codex adds to every thread whatever we ask (the global AGENTS.md). */
  instructionSources: string[];
}

export function createCodexHarnessState(): CodexHarnessState {
  return {
    threads: new Map(),
    login: null,
    wired: new WeakSet(),
    models: null,
    status: null,
    rejection: null,
    usageBlock: null,
    instructionSources: [],
  };
}

const globalState = globalThis as typeof globalThis & { __nodeBananaCodexHarness?: CodexHarnessState };

function sharedState(): CodexHarnessState {
  const state = (globalState.__nodeBananaCodexHarness ??= createCodexHarnessState());
  // After a dev reload the object may come from an older version of this module:
  // add missing fields in place, so every listener keeps sharing the one object.
  const defaults = createCodexHarnessState();
  for (const key of Object.keys(defaults) as Array<keyof CodexHarnessState>) {
    if (state[key] === undefined) Object.assign(state, { [key]: defaults[key] });
  }
  return state;
}

/* ── the harness ───────────────────────────────────────────────── */

export interface CodexHarnessDeps {
  lookupBinary: () => BinaryLookup;
  buildEnv: () => Record<string, string>;
  getServer: (bin: string, env: Record<string, string>) => CodexAppServer;
  state: CodexHarnessState;
  /**
   * Reasoning effort for turns. "medium": in the recorded evals "low" once
   * ended a reply with stray text, while "medium" passed every check at ~12%
   * more latency. `NB_CODEX_EFFORT` overrides it.
   */
  effort: string;
  statusTtlMs: number;
  modelsTtlMs: number;
  loginTimeoutMs: number;
  /** How long a new turn waits for the thread's previous (interrupted) turn to wind down. */
  idleWaitMs: number;
  /** How long after `thread/start` to watch for MCP servers starting on the new thread. */
  mcpStartupWaitMs: number;
  /** Threads idle this long are released. */
  threadIdleTtlMs: number;
  /** At most this many threads are kept; the least recently used idle ones go first. */
  maxThreads: number;
  /** How long a rejected login keeps the harness reported as signed out. */
  rejectionTtlMs: number;
  /** A silent stretch this long (the model writing a tool call Codex doesn't stream) shows "Planning edits…". */
  planningHintMs: number;
  now: () => number;
}

const EXITED = "node_banana/app-server-exited";
const PLANNING = "node_banana/planning-hint";
const MCP_STARTUP = "mcpServer/startupStatus/updated";
const RATE_LIMITS_UPDATED = "account/rateLimits/updated";

/** How long a stopped turn is waited on (in the background) before its thread is given up. */
const SETTLE_CAP_MS = 60_000;
/** A usage block with no reset time is shown for this long. */
const DEFAULT_USAGE_BLOCK_MS = 15 * 60_000;

const REJECTED_PROBLEM =
  "Codex rejected its saved ChatGPT sign-in (it may have expired or been revoked). Sign in again, or run " +
  `\`${CODEX_SIGN_IN_COMMAND}\` in a terminal.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingThreadError(error: unknown): boolean {
  return error instanceof CodexRpcError && /thread.*not (found|loaded)|unknown thread|no such thread/i.test(error.message);
}

function isAuthRequiredError(error: unknown): boolean {
  return error instanceof CodexRpcError && /auth(entication)? required|not (signed|logged) in|unauthori[sz]ed/i.test(error.message);
}

/** An MCP server status that means it is (being) connected to the thread. */
function isLaunching(status: unknown): boolean {
  return status === "starting" || status === "ready";
}

/** Foreign MCP servers started on a thread we created (Codex gets our tools as dynamic tools, never MCP). */
class ForeignMcpError extends Error {
  constructor(readonly names: string[]) {
    super(
      `Codex started MCP servers from your Codex config in the agent's conversation (${names.join(", ")}), ` +
        "so the agent stopped before the model could use them.",
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function toolReply(text: string, success: boolean) {
  return { contentItems: [{ type: "inputText", text }], success };
}

/** Whether a sparse `account/rateLimits/updated` snapshot says a limit may have been reached. */
function limitMayBeReached(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const value = snapshot as {
    rateLimitReachedType?: unknown;
    spendControlReached?: unknown;
    primary?: { usedPercent?: unknown } | null;
    secondary?: { usedPercent?: unknown } | null;
  };
  const full = (window: { usedPercent?: unknown } | null | undefined) =>
    typeof window?.usedPercent === "number" && window.usedPercent >= 100;
  return Boolean(value.rateLimitReachedType) || value.spendControlReached === true || full(value.primary) || full(value.secondary);
}

export function createCodexHarness(overrides: Partial<CodexHarnessDeps> = {}): AgentHarness {
  const deps: CodexHarnessDeps = {
    lookupBinary: () => resolveCodexBinary(),
    buildEnv: () => buildCodexEnv(),
    getServer: getCodexAppServer,
    state: overrides.state ?? sharedState(),
    effort: process.env.NB_CODEX_EFFORT?.trim() || "medium",
    statusTtlMs: 5_000,
    modelsTtlMs: 10 * 60_000,
    loginTimeoutMs: 10 * 60_000,
    idleWaitMs: 10_000,
    mcpStartupWaitMs: 100,
    threadIdleTtlMs: 30 * 60_000,
    maxThreads: 8,
    rejectionTtlMs: 2 * 60_000,
    planningHintMs: 1_500,
    now: Date.now,
    ...overrides,
  };
  const { state } = deps;

  /** `item/tool/call`: run the tool on the runtime of the turn that owns the thread, and only for that turn. */
  async function answerToolCall(raw: unknown) {
    const params = (raw ?? {}) as {
      threadId?: string;
      turnId?: string;
      tool?: string;
      namespace?: string | null;
      arguments?: unknown;
    };
    if (params.namespace && params.namespace !== CODEX_TOOL_NAMESPACE) {
      return toolReply(`Unknown tool namespace "${params.namespace}".`, false);
    }
    const thread = params.threadId ? state.threads.get(params.threadId) : undefined;
    const active = thread?.active;
    if (!thread || !active || !params.tool) {
      return toolReply("No Node Banana turn is running for this conversation, so the tool can't run.", false);
    }
    // Bound to its turn: a stopped turn's late call must not edit the canvas through the next turn.
    if (params.turnId && (thread.staleTurns.has(params.turnId) || (active.turnId && active.turnId !== params.turnId))) {
      return toolReply("That request was stopped, so the tool didn't run.", false);
    }
    const result = await executeTool(active.runtime, params.tool, params.arguments ?? {});
    return toolReply(result.text, result.ok);
  }

  /** The app-server for this binary, with our handlers attached. */
  function connect(bin: string): CodexAppServer {
    const server = deps.getServer(bin, deps.buildEnv());
    // Replaced on every connect (it is one map entry), so after a dev reload
    // tool calls go through this module's turn binding, not an older one.
    server.setRequestHandler("item/tool/call", (raw) => answerToolCall(raw));
    if (state.wired.has(server)) return server;
    state.wired.add(server);

    server.onNotification((notification) => {
      switch (notification.method) {
        case "account/updated":
          state.status = null;
          state.rejection = null;
          return;
        case "thread/closed": {
          const threadId = (notification.params as { threadId?: string } | undefined)?.threadId;
          const thread = threadId ? state.threads.get(threadId) : undefined;
          if (thread?.server === server) state.threads.delete(thread.id);
          return;
        }
        case "account/login/completed": {
          const params = (notification.params ?? {}) as { loginId?: string | null; success?: boolean; error?: string | null };
          const login = state.login;
          if (!login || login.state !== "pending" || (params.loginId && params.loginId !== login.loginId)) return;
          finishLogin(login, params.success ? "succeeded" : "failed", params.error ?? "Sign-in didn't complete.");
          return;
        }
      }
    });

    server.onExit(() => {
      for (const [id, thread] of state.threads) {
        if (thread.server === server) state.threads.delete(id);
      }
      const login = state.login;
      if (login?.state === "pending" && login.server === server) {
        finishLogin(login, "failed", "Codex restarted during sign-in. Start signing in again.");
      }
      state.status = null;
    });
    return server;
  }

  function finishLogin(login: CodexLoginAttempt, outcome: "succeeded" | "failed", error?: string): void {
    if (login.state !== "pending") return;
    login.state = outcome;
    login.error = outcome === "failed" ? error : undefined;
    if (login.timer) clearTimeout(login.timer);
    if (outcome === "succeeded") state.rejection = null;
    state.status = null;
  }

  function signInState(): AgentSignInState {
    const login = state.login;
    if (!login || login.state === "succeeded") return { state: "idle" };
    if (login.state === "failed") return { state: "failed", error: login.error };
    return { state: "pending", url: login.url, userCode: login.userCode };
  }

  function baseStatus(): AgentHarnessStatus {
    return {
      id: "codex",
      label: LABEL,
      installed: false,
      signedIn: false,
      billing: "unknown",
      models: [],
      signIn: signInState(),
      signInCommand: CODEX_SIGN_IN_COMMAND,
    };
  }

  /* ── what turns learned ─────────────────────────────────────── */

  function currentRejection(): CodexHarnessState["rejection"] {
    const rejection = state.rejection;
    if (rejection && deps.now() - rejection.at >= deps.rejectionTtlMs) state.rejection = null;
    return state.rejection;
  }

  function currentUsageBlock(): CodexHarnessState["usageBlock"] {
    const block = state.usageBlock;
    if (block && deps.now() >= block.until) state.usageBlock = null;
    return state.usageBlock;
  }

  function blockUsage(verdict: CodexUsageVerdict): string {
    const message = verdict.problem ?? "Your ChatGPT plan's included Codex usage is used up.";
    const resetsAt = verdict.resetsAt ? verdict.resetsAt * 1000 : 0;
    state.usageBlock = { until: resetsAt > deps.now() ? resetsAt : deps.now() + DEFAULT_USAGE_BLOCK_MS, message };
    return message;
  }

  /** The account verdict, corrected by what the last turns found out. */
  function withTurnFindings(status: AgentHarnessStatus): AgentHarnessStatus {
    if (!isHarnessReady(status)) return status;
    if (currentRejection()) {
      return { ...status, signedIn: false, billing: "none", signIn: signInState(), problem: REJECTED_PROBLEM };
    }
    const block = currentUsageBlock();
    // Still signed in on a plan; the next turn re-checks and is refused with this message.
    if (block) return { ...status, problem: block.message, usageLimit: { message: block.message, until: block.until } };
    return status;
  }

  /* ── status ─────────────────────────────────────────────────── */

  async function listModels(server: CodexAppServer): Promise<AgentModelOption[]> {
    const cached = state.models;
    if (
      cached &&
      cached.server === server &&
      cached.generation === server.generation &&
      deps.now() - cached.at < deps.modelsTtlMs
    ) {
      return cached.options;
    }
    const listed: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const response: { data?: unknown[]; nextCursor?: string | null } = await server.request(
        "model/list",
        cursor ? { cursor, limit: 100 } : { limit: 100 },
        20_000,
      );
      listed.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
      if (!cursor) break;
    }
    const options = codexModelOptions(listed, deps.effort);
    state.models = { server, generation: server.generation, at: deps.now(), options };
    return options;
  }

  /** The account verdict, including a config.toml provider that would bypass the plan. */
  async function readVerdict(server: CodexAppServer): Promise<BillingVerdict> {
    const response = await server.request("account/read", { refreshToken: false }, 20_000);
    const verdict = classifyCodexAccount(response);
    const providerProblem = codexProviderProblem(server.modelProvider);
    if (providerProblem && verdict.billing === "subscription") {
      return { ...verdict, billing: "api", problem: providerProblem };
    }
    return verdict;
  }

  async function readStatus(): Promise<AgentHarnessStatus> {
    const lookup = deps.lookupBinary();
    if (lookup.path === null) return { ...baseStatus(), problem: lookup.problem };
    const server = connect(lookup.path);
    try {
      await server.start();
    } catch (error) {
      return { ...baseStatus(), problem: `Codex (${lookup.path}) couldn't be started: ${errorMessage(error)}` };
    }
    const version = server.info?.version;

    let verdict: BillingVerdict;
    try {
      verdict = await readVerdict(server);
    } catch (error) {
      return {
        ...baseStatus(),
        installed: true,
        version,
        problem: `Couldn't read Codex's sign-in status: ${errorMessage(error)}`,
      };
    }
    const models = await listModels(server).catch(() => []);
    const ready = isHarnessReady({ installed: true, ...verdict });
    return {
      ...baseStatus(),
      installed: true,
      version,
      signedIn: verdict.signedIn,
      billing: verdict.billing,
      account: verdict.account,
      models,
      signIn: ready ? { state: "idle" } : signInState(),
      problem: ready ? undefined : verdict.problem,
    };
  }

  let inflight: Promise<AgentHarnessStatus> | null = null;

  async function getStatus(options: { fresh?: boolean } = {}): Promise<AgentHarnessStatus> {
    const cached = state.status;
    if (!options.fresh && cached && deps.now() - cached.at < deps.statusTtlMs) {
      return withTurnFindings(cached.value.problem ? { ...cached.value, signIn: signInState() } : cached.value);
    }
    inflight ??= readStatus()
      .then((value) => {
        state.status = { at: deps.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return withTurnFindings(await inflight);
  }

  /* ── sign-in ────────────────────────────────────────────────── */

  async function startSignIn(options: AgentSignInOptions = {}): Promise<AgentSignInStart> {
    const status = await getStatus({ fresh: true });
    if (!status.installed) return { state: "failed", message: status.problem };
    // A login Codex rejected still reads as signed in; the status above already says otherwise then.
    if (isHarnessReady(status) && !options.force) {
      return { state: "already_signed_in", message: "Codex is already signed in with your ChatGPT account." };
    }
    const pending = state.login;
    if (pending?.state === "pending") {
      return { state: "pending", url: pending.url, userCode: pending.userCode, message: "Finish signing in in your browser." };
    }
    const lookup = deps.lookupBinary();
    if (lookup.path === null) return { state: "failed", message: lookup.problem };
    const server = connect(lookup.path);

    // ChatGPT sign-in only — never the "apiKey" login type. It replaces the stored login when it completes.
    type LoginStart =
      | { type: "chatgpt"; loginId: string; authUrl: string }
      | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string };
    let started: LoginStart;
    try {
      started = await server.request<LoginStart>("account/login/start", { type: "chatgpt" }, 30_000);
    } catch (browserError) {
      try {
        // The browser flow's localhost callback can fail (e.g. its port is taken).
        started = await server.request<LoginStart>("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
      } catch {
        return { state: "failed", message: `Codex couldn't start its sign-in: ${errorMessage(browserError)}` };
      }
    }

    const login: CodexLoginAttempt =
      started.type === "chatgptDeviceCode"
        ? { loginId: started.loginId, state: "pending", url: started.verificationUrl, userCode: started.userCode, server }
        : { loginId: started.loginId, state: "pending", url: started.authUrl, server };
    const generation = server.generation;
    login.timer = setTimeout(() => {
      if (login.state !== "pending") return;
      void server.requestIfRunning("account/login/cancel", { loginId: login.loginId }, 10_000, generation).catch(() => {});
      finishLogin(login, "failed", "Sign-in wasn't completed within 10 minutes. Start it again when you're ready.");
    }, deps.loginTimeoutMs);
    login.timer.unref?.();
    state.login = login;
    state.status = null;

    return {
      state: "pending",
      url: login.url,
      userCode: login.userCode,
      message: login.userCode
        ? "Open the link and enter the code to sign in with ChatGPT."
        : "Open the link to sign in with ChatGPT.",
    };
  }

  /* ── threads ────────────────────────────────────────────────── */

  async function resolveModel(server: CodexAppServer, requested: string | undefined): Promise<string | undefined> {
    if (requested) return requested;
    const models = await listModels(server).catch(() => [] as AgentModelOption[]);
    return models.find((model) => model.isDefault)?.id;
  }

  function unsubscribe(thread: CodexThread): void {
    void thread.server
      .requestIfRunning("thread/unsubscribe", { threadId: thread.id }, 10_000, thread.generation)
      .catch(() => {});
  }

  /** Forget a thread and let Codex unload it — once its last turn is over. */
  function releaseThread(thread: CodexThread): void {
    if (state.threads.get(thread.id) === thread) state.threads.delete(thread.id);
    if (thread.active || !thread.settled) void thread.idle.then(() => unsubscribe(thread));
    else unsubscribe(thread);
  }

  /**
   * Release threads idle past the TTL, then the least recently used idle
   * ones until `room` more fit under the cap. Threads with a turn claimed or
   * still winding down are never touched.
   */
  function sweepThreads(room: number): void {
    const now = deps.now();
    const idle = () => [...state.threads.values()].filter((thread) => !thread.active && thread.settled);
    for (const thread of idle()) {
      if (now - thread.lastUsedAt >= deps.threadIdleTtlMs) releaseThread(thread);
    }
    const oldestFirst = idle().sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const thread of oldestFirst) {
      if (state.threads.size + room <= deps.maxThreads) break;
      releaseThread(thread);
    }
  }

  function newClaim(runtime: AgentToolRuntime): ActiveTurn {
    return { runtime, over: deferred<void>() };
  }

  /** Claim a known thread for a turn, after its previous turn has wound down. False: leave it for a new one. */
  async function acquire(thread: CodexThread, claim: ActiveTurn): Promise<boolean> {
    if (thread.active || !thread.settled) await Promise.race([thread.idle, delay(deps.idleWaitMs)]);
    if (thread.active || !thread.settled) return false;
    thread.active = claim;
    thread.idle = claim.over.promise;
    return true;
  }

  /** Give a claim back when its turn never reached `turn/start`. */
  function unclaim(thread: CodexThread | undefined, claim: ActiveTurn): void {
    if (thread?.active !== claim) return;
    thread.active = null;
    claim.over.resolve();
  }

  async function startThread(
    server: CodexAppServer,
    params: HarnessTurnParams,
    tools: CodexToolNamespace,
    signature: string,
    claim: ActiveTurn,
    alsoDisable: string[] = [],
  ): Promise<CodexThread> {
    const model = await resolveModel(server, params.model);
    // The user can add MCP servers while the app-server runs: read the list for every thread.
    const mcpServers = [...new Set([...(await server.refreshUserMcpServers()), ...alsoDisable])];
    // Any MCP server starting on our thread is foreign: our tools are dynamic tools, never MCP.
    const startups: Array<{ threadId?: string; name?: string; status?: string }> = [];
    const offStartup = server.onNotification((notification) => {
      if (notification.method === MCP_STARTUP) startups.push((notification.params ?? {}) as (typeof startups)[number]);
    });
    let response: { thread: { id: string }; instructionSources?: unknown };
    try {
      response = await server.request<{ thread: { id: string }; instructionSources?: unknown }>(
        "thread/start",
        {
          model,
          cwd: server.workDir,
          approvalPolicy: "never",
          sandbox: "read-only",
          // Not written to disk, so agent chats stay out of the user's Codex history.
          ephemeral: true,
          baseInstructions: params.systemPrompt,
          developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
          // The user's own MCP servers can't be removed by config overrides; switch them off here.
          config: Object.fromEntries(mcpServers.map((name) => [`mcp_servers.${name}.enabled`, false])),
          // No execution environment: removes apply_patch and the other workspace tools.
          environments: [],
          dynamicTools: [tools],
        },
        60_000,
      );
      // Startup notifications follow the response within milliseconds.
      await delay(deps.mcpStartupWaitMs);
    } finally {
      offStartup();
    }
    const threadId = response.thread.id;
    const foreign = [
      ...new Set(
        startups
          .filter((startup) => startup.threadId === threadId && isLaunching(startup.status) && startup.name)
          .map((startup) => startup.name as string),
      ),
    ];
    if (foreign.length > 0) {
      void server.requestIfRunning("thread/unsubscribe", { threadId }, 10_000, server.generation).catch(() => {});
      throw new ForeignMcpError(foreign);
    }
    if (Array.isArray(response.instructionSources)) {
      state.instructionSources = response.instructionSources.filter((source): source is string => typeof source === "string");
    }
    const thread: CodexThread = {
      id: threadId,
      server,
      generation: server.generation,
      signature,
      active: claim,
      staleTurns: new Set(),
      settled: true,
      idle: claim.over.promise,
      lastUsedAt: deps.now(),
    };
    state.threads.set(thread.id, thread);
    return thread;
  }

  /** Resolves true when `turnId` completes on the thread or the server exits; false after the cap. */
  function whenTurnSettles(server: CodexAppServer, threadId: string, turnId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (completed: boolean) => {
        offNotification();
        offExit();
        clearTimeout(timer);
        resolve(completed);
      };
      const offNotification = server.onNotification((notification) => {
        const params = (notification.params ?? {}) as { threadId?: string; turn?: { id?: string } };
        if (notification.method === "turn/completed" && params.threadId === threadId && params.turn?.id === turnId) {
          done(true);
        }
      });
      const offExit = server.onExit(() => done(true));
      const timer = setTimeout(() => done(false), Math.max(SETTLE_CAP_MS, deps.idleWaitMs));
      timer.unref?.();
    });
  }

  /* ── usage ──────────────────────────────────────────────────── */

  /** Background-style read: no reset-credit details, and never opting into a paid fallback. */
  const USAGE_PARAMS = { excludeResetCreditDetails: true };

  async function readUsage(server: CodexAppServer, model: string | undefined): Promise<CodexUsageVerdict> {
    const response = await server.request("account/rateLimits/read", USAGE_PARAMS, 20_000);
    return classifyCodexUsage(response, model);
  }

  /**
   * The same read mid-turn, from the thread's own app-server only (never a
   * restart). A failed read counts as reached: the update already said so.
   * Undefined when that app-server is gone (the turn is ending anyway).
   */
  async function rereadUsage(thread: CodexThread, model: string | undefined): Promise<CodexUsageVerdict | undefined> {
    try {
      const response = await thread.server.requestIfRunning("account/rateLimits/read", USAGE_PARAMS, 20_000, thread.generation);
      return response === undefined ? undefined : classifyCodexUsage(response, model);
    } catch {
      return { allowed: false, problem: "Your ChatGPT plan's Codex usage limit was reached." };
    }
  }

  /* ── turns ──────────────────────────────────────────────────── */

  type TurnOutcome = "done" | "thread-missing";

  async function* runOnThread(
    server: CodexAppServer,
    thread: CodexThread,
    claim: ActiveTurn,
    prompt: string,
    params: HarnessTurnParams,
    model: string | undefined,
  ): AsyncGenerator<HarnessEvent, TurnOutcome> {
    const { over } = claim;
    const mapper = new CodexTurnMapper(thread.id);
    const queue = new AsyncQueue<CodexNotification>();
    const offNotification = server.onNotification((notification) => {
      const params = (notification.params ?? {}) as { threadId?: string };
      // Rate-limit updates are account-wide (no threadId).
      if (params.threadId === thread.id || notification.method === RATE_LIMITS_UPDATED) queue.push(notification);
    });
    let exited = false;
    const offExit = server.onExit((reason) => {
      exited = true;
      queue.push({ method: EXITED, params: { reason } });
      queue.end();
    });
    let turnId: string | undefined;
    let interrupted = false;
    /** turn/start was sent; with no answer (a timeout) a turn may exist. */
    let startSent = false;
    /** Codex refused turn/start outright, so no turn exists. */
    let refused = false;
    const interrupt = () => {
      if (!turnId || mapper.done || interrupted) return;
      interrupted = true;
      // Only the app-server that owns the thread; never (re)start one for this.
      void server
        .requestIfRunning("turn/interrupt", { threadId: thread.id, turnId }, 10_000, thread.generation)
        .catch(() => {});
    };
    const onAbort = () => {
      interrupt();
      queue.end();
    };
    params.signal.addEventListener("abort", onAbort, { once: true });

    // "Planning edits…" while the model writes a tool call Codex doesn't stream.
    const planningTool = params.tools.definitions.find((definition) => !definition.readOnly)?.name;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let hinted = false;
    const syncPlanningHint = () => {
      if (!mapper.awaitingModel) {
        clearTimeout(hintTimer);
        hintTimer = undefined;
        hinted = false;
      } else if (planningTool && !hintTimer && !hinted) {
        hintTimer = setTimeout(() => {
          hintTimer = undefined;
          queue.push({ method: PLANNING });
        }, deps.planningHintMs);
        hintTimer.unref?.();
      }
    };

    try {
      if (params.signal.aborted) return "done";
      thread.settled = false;
      startSent = true;
      try {
        const started = await server.request<{ turn: { id: string } }>(
          "turn/start",
          {
            threadId: thread.id,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            ...(params.model ? { model: params.model } : {}),
            effort: params.effort ?? deps.effort,
            summary: "auto",
          },
          60_000,
        );
        turnId = started.turn.id;
        mapper.turnId = turnId;
        claim.turnId = turnId;
      } catch (error) {
        refused = error instanceof CodexRpcError;
        if (params.signal.aborted) return "done";
        if (isMissingThreadError(error)) return "thread-missing";
        yield { type: "error", code: "harness_error", message: `Codex couldn't start the turn: ${errorMessage(error)}` };
        return "done";
      }
      if (params.signal.aborted) {
        interrupt();
        return "done";
      }

      for await (const notification of queue) {
        if (notification.method === EXITED) {
          const reason = (notification.params as { reason?: string } | undefined)?.reason;
          yield { type: "error", code: "harness_error", message: `Codex stopped unexpectedly: ${reason ?? "the app-server exited"}.` };
          return "done";
        }
        if (notification.method === PLANNING) {
          if (mapper.awaitingModel && !hinted && planningTool) {
            hinted = true;
            yield { type: "tool-pending", toolName: planningTool };
          }
          continue;
        }
        if (notification.method === RATE_LIMITS_UPDATED) {
          if (!limitMayBeReached((notification.params as { rateLimits?: unknown } | undefined)?.rateLimits)) continue;
          // The update is sparse: ask for the whole picture before stopping anything.
          const verdict = await rereadUsage(thread, model);
          if (!verdict || verdict.allowed) continue;
          interrupt();
          yield { type: "error", code: "usage_limit", message: blockUsage(verdict) };
          return "done";
        }
        if (notification.method === MCP_STARTUP) {
          const startup = (notification.params ?? {}) as { name?: string; status?: string };
          if (!isLaunching(startup.status)) continue;
          interrupt();
          releaseThread(thread);
          yield { type: "error", code: "harness_error", message: new ForeignMcpError([startup.name ?? "unknown"]).message };
          return "done";
        }
        for (const event of mapper.map(notification)) {
          if (event.type === "error" && event.code === "not_signed_in") state.rejection = { at: deps.now() };
          yield event;
        }
        if (mapper.done) {
          if (mapper.status === "completed" && !mapper.errorReported) state.rejection = null;
          return "done";
        }
        syncPlanningHint();
      }
      return "done";
    } finally {
      clearTimeout(hintTimer);
      offNotification();
      offExit();
      params.signal.removeEventListener("abort", onAbort);
      if (thread.active === claim) thread.active = null;
      thread.lastUsedAt = deps.now();

      const stillRunning = turnId !== undefined && !mapper.done;
      const alive = !exited && server.running && server.generation === thread.generation;
      if (stillRunning && alive) {
        // Stopped early (abort, or the consumer went away): end the turn in Codex too,
        // and refuse whatever it still sends.
        thread.staleTurns.add(turnId!);
        interrupt();
        void whenTurnSettles(server, thread.id, turnId!).then((completed) => {
          if (completed) thread.settled = true;
          over.resolve();
        });
      } else {
        if (stillRunning) thread.staleTurns.add(turnId!);
        // Over — unless turn/start went unanswered (a timeout): a turn may be running, so the
        // thread isn't used again.
        thread.settled = !startSent || turnId !== undefined || refused || exited;
        over.resolve();
      }
    }
  }

  async function* runTurn(params: HarnessTurnParams): AsyncGenerator<HarnessEvent> {
    const lookup = deps.lookupBinary();
    if (lookup.path === null) {
      yield { type: "error", code: "not_installed", message: lookup.problem };
      return;
    }
    const server = connect(lookup.path);
    try {
      await server.start();
    } catch (error) {
      yield { type: "error", code: "not_installed", message: `Codex couldn't be started: ${errorMessage(error)}` };
      return;
    }
    sweepThreads(0);

    // Billing gate: the account must be a ChatGPT login on a plan before anything is sent.
    let verdict: BillingVerdict;
    try {
      verdict = await readVerdict(server);
    } catch (error) {
      yield { type: "error", code: "harness_error", message: `Couldn't read Codex's sign-in status: ${errorMessage(error)}` };
      return;
    }
    if (!verdict.signedIn || verdict.billing !== "subscription") {
      yield {
        type: "error",
        code: verdict.billing === "none" ? "not_signed_in" : "wrong_billing",
        message: verdict.problem ?? "Codex isn't signed in with a ChatGPT account.",
      };
      return;
    }

    // Usage gate: the plan's included usage must have room (past it, purchased credits would pay).
    const model = await resolveModel(server, params.model);
    let usage: CodexUsageVerdict;
    try {
      usage = await readUsage(server, model);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        state.rejection = { at: deps.now() };
        yield { type: "error", code: "not_signed_in", message: REJECTED_PROBLEM };
      } else {
        yield { type: "error", code: "harness_error", message: `Couldn't read your ChatGPT plan's Codex usage: ${errorMessage(error)}` };
      }
      return;
    }
    if (!usage.allowed) {
      yield { type: "error", code: "usage_limit", message: blockUsage(usage) };
      return;
    }
    state.usageBlock = null;

    let tools: CodexToolNamespace;
    try {
      tools = codexToolNamespace(params.tools.definitions);
    } catch (error) {
      yield { type: "error", code: "harness_error", message: `Node Banana's tools couldn't be described to Codex: ${errorMessage(error)}` };
      return;
    }
    const signature = threadSignature(params.systemPrompt, tools);

    let thread = params.sessionId ? state.threads.get(params.sessionId) : undefined;
    if (thread && (thread.server !== server || thread.generation !== server.generation)) {
      state.threads.delete(thread.id);
      thread = undefined;
    } else if (thread && thread.signature !== signature) {
      // New instructions or tools: this conversation continues on a new thread.
      releaseThread(thread);
      thread = undefined;
    }
    let claim = newClaim(params.tools);
    try {
      if (thread && !(await acquire(thread, claim))) {
        // Its stopped turn is still running in Codex; a turn/start there would steer it.
        releaseThread(thread);
        thread = undefined;
      }
      if (params.signal.aborted) return;

      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = !thread;
        if (!thread) {
          sweepThreads(1);
          try {
            thread = await startThread(server, params, tools, signature, claim);
          } catch (error) {
            if (!(error instanceof ForeignMcpError)) {
              yield { type: "error", code: "harness_error", message: `Codex couldn't start a conversation: ${errorMessage(error)}` };
              return;
            }
            // A server added to config.toml between our read and thread/start: once more, disabling it too.
            try {
              thread = await startThread(server, params, tools, signature, claim, error.names);
            } catch (retryError) {
              yield { type: "error", code: "harness_error", message: errorMessage(retryError) };
              return;
            }
          }
        }
        yield { type: "session", sessionId: thread.id };
        const prompt = fresh ? withConversationHistory(params.history, params.prompt) : params.prompt;
        const outcome = yield* runOnThread(server, thread, claim, prompt, params, model);
        if (outcome !== "thread-missing" || fresh) return;
        // Codex no longer has the thread (unloaded): continue on a new one.
        state.threads.delete(thread.id);
        thread = undefined;
        claim = newClaim(params.tools);
      }
    } finally {
      // Stopped between claiming the thread and starting the turn.
      unclaim(thread, claim);
    }
  }

  return {
    id: "codex",
    label: LABEL,
    getStatus: () => getStatus(),
    startSignIn: (options?: AgentSignInOptions) => startSignIn(options),
    runTurn,
  };
}
