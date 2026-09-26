/**
 * The Claude Code harness: runs agent turns through the Claude Agent SDK on
 * the user's own Claude subscription login. Server-only.
 *
 * Import `@anthropic-ai/claude-agent-sdk/core` only: the root entry bundles
 * its own zod/MCP copies, and with those any `z.record` in a tool schema
 * silently empties the whole tool list.
 *
 * Every turn:
 *   1. spawns Claude Code with the stripped environment (env.ts), no user
 *      settings, no built-in tools, only our in-process MCP tools;
 *   2. waits for the CLI's account report and refuses anything that isn't a
 *      subscription login *before the prompt is sent* (streaming input keeps
 *      the prompt back until then), and refuses unless the plan's usage report
 *      shows the turn can't reach extra usage: the plan has room and extra
 *      usage is off, or it is on and the plan is well short of its limit. No
 *      report (a failed or slow read, a login without the profile scope) means
 *      no turn;
 *   3. streams SDK messages through ClaudeEventMapper, stopping the turn if
 *      Claude Code switches to extra usage mid-turn;
 *   4. retries once without `resume` (seeding the chat history) when the
 *      session no longer exists.
 *
 * Status reads the account the same way (a Claude Code started like a turn
 * but never given a prompt), so the panel's verdict matches what a turn
 * would use. `claude auth status` is only the fallback.
 */

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  AbortError,
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type Options,
  type SDKControlGetUsageResponse,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk/core";
import type {
  AgentHarness,
  AgentHarnessStatus,
  AgentSignInOptions,
  AgentSignInStart,
  AgentToolRuntime,
  HarnessEvent,
  HarnessTurnParams,
} from "../types";
import { resolveClaudeBinary, runCommand, type BinaryLookup } from "./binaries";
import { isHarnessReady, type BillingVerdict } from "./billing";
import {
  classifyClaudeAccount,
  classifyClaudeAuthStatus,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_MODELS,
  claudeModelOptions,
  type ClaudeModelInfo,
  CLAUDE_SIGN_IN_COMMAND,
  type ClaudeAccountInfo,
} from "./claudeStatus";
import {
  ClaudeEventMapper,
  CLAUDE_MCP_SERVER_NAME,
  claudeToolName,
  extraUsageMessage,
  formatResetTime,
  isErrorResultThrow,
  isMissingSessionError,
} from "./claudeEvents";
import { ClaudeSignIn } from "./claudeSignIn";
import { buildClaudeEnv, NODE_BANANA_VERSION } from "./env";
import { withConversationHistory } from "./history";
import { executeTool } from "./toolExecution";

const LABEL = "Claude Code";

/** Agent chats live in their own Claude Code project, away from the user's repos and `claude --resume` lists. */
export const CLAUDE_AGENT_CWD = path.join(os.homedir(), ".node-banana", "agent");

/** Upper bound on model round-trips in one turn. */
const MAX_TURNS = 40;

/**
 * `claude auth status`, reading the same settings as a turn. The SDK passes
 * `settingSources: []` to the CLI as `--setting-sources=` (before the
 * subcommand, or the CLI rejects it), so a user-settings apiKeyHelper or
 * `env` key that turns never load can't make status refuse a subscription.
 * Keep in step with `settingSources` in {@link buildClaudeOptions}.
 */
export const CLAUDE_AUTH_STATUS_ARGS = ["--setting-sources=", "auth", "status"];

/** When Claude Code reports a plan limit without a reset time, wait this long. */
const DEFAULT_USAGE_BLOCK_MS = 15 * 60_000;

/** After a usage report showed extra usage is off, turns skip the pre-turn usage check for this long. */
const EXTRA_USAGE_OFF_TRUST_MS = 5 * 60_000;

/**
 * With extra usage on, a turn doesn't start once any plan window is this full
 * (percent): a turn is many requests, and the first one past the limit would
 * already be billed as extra usage before Claude Code reports the switch.
 */
const NEAR_LIMIT_PERCENT = 90;

export interface ClaudeHarnessDeps {
  lookupBinary: () => BinaryLookup;
  buildEnv: () => Record<string, string>;
  runCommand: typeof runCommand;
  query: typeof sdkQuery;
  signIn: ClaudeSignIn;
  state: ClaudeHarnessState;
  agentCwd: string;
  statusTtlMs: number;
  /** How long to wait for Claude Code to start and report its account. */
  initTimeoutMs: number;
  /** How long status waits for the account probe before falling back to `auth status`. */
  probeTimeoutMs: number;
  /** How long the pre-turn plan-usage check may take; a slower answer refuses the turn. */
  usageCheckTimeoutMs: number;
  /** How long a rejected sign-in keeps the harness reported as signed out (see ClaudeHarnessState). */
  rejectionTtlMs: number;
  now: () => number;
}

/* ── shared state (survives Next dev reloads) ─────────────────── */

/** What turns learned that `auth status` / the account report can't show. */
export interface ClaudeHarnessState {
  /**
   * The plan's included usage ran out (Claude Code reported extra usage, or
   * the pre-turn usage check saw a full window). Turns are refused without
   * starting Claude Code until `until` (ms), since the first request of a
   * turn is already billed before Claude Code reports the switch.
   */
  usageBlock: { until: number; message: string } | null;
  /**
   * Claude Code rejected its saved sign-in during a turn (expired or
   * revoked) although its local account report still says signed in. Until
   * a sign-in from the panel finishes, a turn succeeds, or `rejectionTtlMs`
   * passes, status reports signed out so the panel offers sign-in again.
   */
  rejection: { at: number; signInSettled: number } | null;
  /**
   * When a usage report last showed extra usage turned off
   * (`extra_usage.is_enabled === false`): past the plan, Claude Code then
   * stops instead of billing. The pre-turn usage check is skipped for a few
   * minutes after that, and dropped as soon as a turn shows extra usage is on.
   */
  extraUsageOffAt: number | null;
}

export function createClaudeHarnessState(): ClaudeHarnessState {
  return { usageBlock: null, rejection: null, extraUsageOffAt: null };
}

const globalState = globalThis as typeof globalThis & {
  __nodeBananaClaudeSignIn?: ClaudeSignIn;
  __nodeBananaClaudeHarness?: ClaudeHarnessState;
};

function sharedState(): ClaudeHarnessState {
  const state = (globalState.__nodeBananaClaudeHarness ??= createClaudeHarnessState());
  // After a dev reload the object may come from an older version of this module.
  const defaults = createClaudeHarnessState();
  for (const key of Object.keys(defaults) as Array<keyof ClaudeHarnessState>) {
    if (state[key] === undefined) Object.assign(state, { [key]: defaults[key] });
  }
  return state;
}

function sharedSignIn(): ClaudeSignIn {
  globalState.__nodeBananaClaudeSignIn ??= new ClaudeSignIn({
    spawn: (bin, args, options) =>
      spawn(bin, args, {
        env: options.env as NodeJS.ProcessEnv,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
  });
  return globalState.__nodeBananaClaudeSignIn;
}

/* ── tools ─────────────────────────────────────────────────────── */

/** Our tool runtime as in-process MCP tools for the SDK. */
export function buildClaudeTools(runtime: AgentToolRuntime) {
  return runtime.definitions.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.inputShape,
      async (args) => {
        const result = await executeTool(runtime, definition.name, args);
        return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok };
      },
      {
        annotations: {
          title: definition.title,
          readOnlyHint: definition.readOnly,
          destructiveHint: !definition.readOnly,
          openWorldHint: false,
        },
      },
    ),
  );
}

/** SDK options for one agent turn: locked down to our tools, our prompt, the user's subscription. */
export function buildClaudeOptions(input: {
  bin: string;
  env: Record<string, string>;
  cwd: string;
  params: HarnessTurnParams;
  resume: string | undefined;
  abortController: AbortController;
  onStderr: (data: string) => void;
}): Options {
  const { params } = input;
  // "default" lets Claude Code pick the plan's default model.
  const model = params.model === "default" ? undefined : params.model || CLAUDE_DEFAULT_MODEL;
  return {
    pathToClaudeCodeExecutable: input.bin,
    cwd: input.cwd,
    env: input.env,
    // No user/project settings: no CLAUDE.md, hooks, plugins, or apiKeyHelper.
    settingSources: [],
    // No MCP servers but ours (.mcp.json, user and plugin servers are ignored).
    strictMcpConfig: true,
    // No built-in tools at all: no shell, files, web, sub-agents or skills.
    tools: [],
    mcpServers: {
      [CLAUDE_MCP_SERVER_NAME]: createSdkMcpServer({
        name: CLAUDE_MCP_SERVER_NAME,
        version: NODE_BANANA_VERSION,
        tools: buildClaudeTools(params.tools),
      }),
    },
    allowedTools: params.tools.definitions.map((definition) => claudeToolName(definition.name)),
    // Our tools run without asking; anything else is denied.
    permissionMode: "dontAsk",
    systemPrompt: params.systemPrompt,
    model,
    thinking: { type: "adaptive", display: "summarized" },
    // Checked against the model's own levels before the turn (pickTurnEffort).
    ...(params.effort ? { effort: params.effort as NonNullable<Options["effort"]> } : {}),
    includePartialMessages: true,
    maxTurns: MAX_TURNS,
    resume: input.resume,
    abortController: input.abortController,
    stderr: input.onStderr,
  };
}

/**
 * SDK options for the account probe: a Claude Code started exactly as a turn
 * would start it (same binary, environment, cwd and setting sources), with
 * no tools and no prompt. It reports its account and never calls the model.
 */
export function buildClaudeProbeOptions(input: {
  bin: string;
  env: Record<string, string>;
  cwd: string;
  abortController: AbortController;
}): Options {
  return {
    pathToClaudeCodeExecutable: input.bin,
    cwd: input.cwd,
    env: input.env,
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    mcpServers: {},
    permissionMode: "dontAsk",
    abortController: input.abortController,
  };
}

/** Plan windows (0-100) that block a turn when full, from the SDK's /usage data. */
type UsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

function planWindows(rateLimits: Record<string, unknown>, model: string | undefined): UsageWindow[] {
  const names = ["five_hour", "seven_day"];
  if (model === "opus" || model === "sonnet") names.push(`seven_day_${model}`);
  return names.map((name) => rateLimits[name] as UsageWindow);
}

/**
 * Whether the plan's included usage is used up, from Claude Code's `/usage`
 * data: a full five-hour or weekly window (or the weekly window of the
 * chosen model family). A turn then either fails or runs on extra usage.
 * Returns the latest reset among the full windows (ms), or null when usage remains.
 */
export function fullPlanWindow(
  rateLimits: Record<string, unknown> | null | undefined,
  model: string | undefined,
): { resetsAt: number | undefined } | null {
  if (!rateLimits) return null;
  let full = false;
  let resetsAt: number | undefined;
  for (const window of planWindows(rateLimits, model)) {
    if (!window || typeof window.utilization !== "number" || window.utilization < 100) continue;
    full = true;
    const at = window.resets_at ? Date.parse(window.resets_at) : NaN;
    if (Number.isFinite(at)) resetsAt = Math.max(resetsAt ?? 0, at);
  }
  return full ? { resetsAt } : null;
}

/** The fullest plan window at or above `percent`, or null when every window is below it. */
export function nearPlanWindow(
  rateLimits: Record<string, unknown> | null | undefined,
  model: string | undefined,
  percent = NEAR_LIMIT_PERCENT,
): { utilization: number; resetsAt: number | undefined } | null {
  if (!rateLimits) return null;
  let near: { utilization: number; resetsAt: number | undefined } | null = null;
  for (const window of planWindows(rateLimits, model)) {
    if (!window || typeof window.utilization !== "number" || window.utilization < percent) continue;
    if (near && near.utilization >= window.utilization) continue;
    const at = window.resets_at ? Date.parse(window.resets_at) : NaN;
    near = { utilization: window.utilization, resetsAt: Number.isFinite(at) ? at : undefined };
  }
  return near;
}

/** What the usage report says about extra usage: off, on, or not reported. */
function extraUsageEnabled(rateLimits: Record<string, unknown>): boolean | undefined {
  const extra = rateLimits.extra_usage as { is_enabled?: unknown } | null | undefined;
  return typeof extra?.is_enabled === "boolean" ? extra.is_enabled : undefined;
}

/** Whether a rate-limit report says extra usage can pay for requests past the plan (in use or available). */
function overageAvailable(info: SDKRateLimitInfo | undefined): boolean {
  if (!info) return false;
  return (
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning"
  );
}

/** The pre-turn usage verdict: go ahead, or refuse with a message (and block turns until a reset when the plan is full). */
type PlanUsageVerdict =
  | { allowed: true }
  | { allowed: false; code: "usage_limit" | "wrong_billing"; message: string; block?: { resetsAt: number | undefined } };

const NO_EXTRA_USAGE =
  "The agent only runs on your plan's included usage, so it won't start a turn Claude Code could bill as extra usage.";

const USAGE_UNCONFIRMED =
  "Couldn't confirm that your Claude plan has included usage left, so the agent didn't start the turn: it never " +
  "lets Claude Code bill extra usage. Try again in a moment.";

const OAUTH_TOKEN_NO_USAGE =
  "Claude Code can't report your plan's usage limits with the CLAUDE_CODE_OAUTH_TOKEN in Node Banana's " +
  "environment (a `claude setup-token` token), so the agent can't make sure a turn stays within your plan's " +
  "included usage. Remove the variable, restart Node Banana and sign in with `claude auth login` to use the agent.";

const OAUTH_TOKEN_REJECTED =
  "Claude rejected the CLAUDE_CODE_OAUTH_TOKEN in Node Banana's environment (it may have expired or been " +
  "revoked). Create a new one with `claude setup-token` in a terminal and update the variable, or remove it " +
  "and restart Node Banana to use your saved Claude sign-in.";

function rejectedProblem(oauthTokenInEnv: boolean): string {
  return oauthTokenInEnv
    ? OAUTH_TOKEN_REJECTED
    : "Claude Code rejected its saved sign-in (it may have expired or been revoked). Sign in again, or run " +
        `\`${CLAUDE_SIGN_IN_COMMAND}\` in a terminal.`;
}

/* ── small async helpers ───────────────────────────────────────── */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first `x.y.z` in `claude --version` output ("2.1.282 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
}

/** The JSON object in `claude auth status` output, tolerating stray lines around it. */
export function parseAuthStatusOutput(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ── the harness ───────────────────────────────────────────────── */

type QueryOutcome = "done" | "missing-session";

export function createClaudeHarness(overrides: Partial<ClaudeHarnessDeps> = {}): AgentHarness {
  const deps: ClaudeHarnessDeps = {
    lookupBinary: () => resolveClaudeBinary(),
    buildEnv: () => buildClaudeEnv(),
    runCommand,
    query: sdkQuery,
    signIn: overrides.signIn ?? sharedSignIn(),
    state: overrides.state ?? sharedState(),
    agentCwd: CLAUDE_AGENT_CWD,
    statusTtlMs: 5_000,
    initTimeoutMs: 60_000,
    probeTimeoutMs: 20_000,
    usageCheckTimeoutMs: 8_000,
    rejectionTtlMs: 2 * 60_000,
    now: Date.now,
    ...overrides,
  };
  const { state } = deps;

  /** The last CLI answer, dropped when a sign-in attempt ends (see ClaudeSignIn.settled). */
  let cached: { at: number; signInSettled: number; status: AgentHarnessStatus } | null = null;
  let inflight: Promise<AgentHarnessStatus> | null = null;
  const versions = new Map<string, string | undefined>();

  function baseStatus(): AgentHarnessStatus {
    return {
      id: "claude",
      label: LABEL,
      installed: false,
      signedIn: false,
      billing: "unknown",
      models: CLAUDE_MODELS,
      signIn: deps.signIn.state(),
      signInCommand: CLAUDE_SIGN_IN_COMMAND,
    };
  }

  async function ensureCwd(): Promise<void> {
    await mkdir(deps.agentCwd, { recursive: true });
  }

  async function versionOf(bin: string, env: Record<string, string>): Promise<string | undefined> {
    if (versions.has(bin)) return versions.get(bin);
    const result = await deps.runCommand(bin, ["--version"], { env, timeoutMs: 15_000 });
    const version = result.code === 0 ? parseClaudeVersion(result.stdout) : undefined;
    if (version) versions.set(bin, version);
    return version;
  }

  /* ── what turns learned ─────────────────────────────────────── */

  function currentUsageBlock(): ClaudeHarnessState["usageBlock"] {
    const block = state.usageBlock;
    if (block && deps.now() >= block.until) state.usageBlock = null;
    return state.usageBlock;
  }

  function blockUsage(resetsAtMs: number | undefined, message: string): void {
    const until = resetsAtMs && resetsAtMs > deps.now() ? resetsAtMs : deps.now() + DEFAULT_USAGE_BLOCK_MS;
    state.usageBlock = { until, message };
  }

  function currentRejection(): ClaudeHarnessState["rejection"] {
    const rejection = state.rejection;
    if (!rejection) return null;
    const signedInSince = deps.signIn.settled !== rejection.signInSettled && deps.signIn.state().state === "idle";
    if (signedInSince || deps.now() - rejection.at >= deps.rejectionTtlMs) state.rejection = null;
    return state.rejection;
  }

  /** The CLI's verdict, corrected by what the last turns found out. */
  function withTurnFindings(status: AgentHarnessStatus): AgentHarnessStatus {
    if (!isHarnessReady(status)) return status;
    if (currentRejection()) {
      return {
        ...status,
        signedIn: false,
        billing: "none",
        signIn: deps.signIn.state(),
        problem: rejectedProblem(Boolean(deps.buildEnv().CLAUDE_CODE_OAUTH_TOKEN)),
      };
    }
    const block = currentUsageBlock();
    // Still signed in on a subscription; the turn itself is refused with this message.
    if (block) return { ...status, problem: block.message, usageLimit: { message: block.message, until: block.until } };
    return status;
  }

  /* ── status ─────────────────────────────────────────────────── */

  /**
   * The account a turn would use: Claude Code started like a turn (same
   * binary, env, cwd, `settingSources: []`), never given a prompt.
   */
  async function probeAccount(
    bin: string,
    env: Record<string, string>,
  ): Promise<{ account: ClaudeAccountInfo | undefined; models: ClaudeModelInfo[] | undefined }> {
    const release = deferred<void>();
    async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
      await release.promise;
    }
    const q = deps.query({
      prompt: noPrompt(),
      options: buildClaudeProbeOptions({ bin, env, cwd: deps.agentCwd, abortController: new AbortController() }),
    });
    try {
      const init = await withTimeout(q.initializationResult(), deps.probeTimeoutMs, "Claude Code didn't report its account in time.");
      return { account: init.account ?? undefined, models: init.models as ClaudeModelInfo[] | undefined };
    } finally {
      release.resolve();
      try {
        q.close();
      } catch {
        // Already closed.
      }
    }
  }

  async function readStatus(): Promise<AgentHarnessStatus> {
    const lookup = deps.lookupBinary();
    if (lookup.path === null) return { ...baseStatus(), problem: lookup.problem };
    const bin = lookup.path;
    const env = deps.buildEnv();
    await ensureCwd();

    const [probe, version] = await Promise.all([
      probeAccount(bin, env).catch(() => undefined),
      versionOf(bin, env),
    ]);
    const account = probe?.account;
    const models = claudeModelOptions(probe?.models);

    let verdict: BillingVerdict;
    if (account) {
      verdict = classifyClaudeAccount(account);
    } else {
      // Fallback (e.g. a CLI that can't report its account this way).
      const auth = await deps.runCommand(bin, CLAUDE_AUTH_STATUS_ARGS, { env, cwd: deps.agentCwd, timeoutMs: 20_000 });
      if (auth.code === null && !auth.stdout.trim()) {
        const startFailed = !auth.error?.includes("timed out");
        return {
          ...baseStatus(),
          installed: !startFailed,
          version,
          problem: startFailed
            ? `Claude Code (${bin}) couldn't be started: ${auth.error ?? "unknown error"}.`
            : "Claude Code didn't report its sign-in status in time. Try again.",
        };
      }
      verdict = classifyClaudeAuthStatus(parseAuthStatusOutput(auth.stdout), {
        oauthTokenInEnv: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
      });
    }

    const ready = isHarnessReady({ installed: true, ...verdict });
    return {
      ...baseStatus(),
      installed: true,
      version,
      signedIn: verdict.signedIn,
      billing: verdict.billing,
      account: verdict.account,
      models,
      signIn: ready ? { state: "idle" } : deps.signIn.state(),
      problem: ready ? undefined : verdict.problem,
    };
  }

  async function getStatus(options: { fresh?: boolean } = {}): Promise<AgentHarnessStatus> {
    if (
      !options.fresh &&
      cached &&
      cached.signInSettled === deps.signIn.settled &&
      deps.now() - cached.at < deps.statusTtlMs
    ) {
      // The sign-in state moves independently of the (cached) CLI answer.
      return withTurnFindings(cached.status.problem ? { ...cached.status, signIn: deps.signIn.state() } : cached.status);
    }
    const signInSettled = deps.signIn.settled;
    inflight ??= readStatus()
      .then((status) => {
        cached = { at: deps.now(), signInSettled, status };
        return status;
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
    const rejected = currentRejection() !== null;
    if (isHarnessReady(status) && !options.force) {
      return { state: "already_signed_in", message: "Claude Code is already signed in with your Claude plan." };
    }
    const env = deps.buildEnv();
    if ((rejected || options.force) && env.CLAUDE_CODE_OAUTH_TOKEN) {
      // `claude auth login` can't replace a token in the environment: it takes precedence.
      return { state: "failed", message: OAUTH_TOKEN_REJECTED };
    }
    const lookup = deps.lookupBinary();
    if (lookup.path === null) return { state: "failed", message: lookup.problem };
    await ensureCwd();
    const started = await deps.signIn.start(lookup.path, env, deps.agentCwd);
    cached = null;
    return started;
  }

  /* ── turns ──────────────────────────────────────────────────── */

  /**
   * Refuse a turn that could reach extra usage. Fails closed: the turn goes
   * ahead only on Claude Code's own `/usage` report (experimental in the SDK)
   * showing either extra usage turned off and room in the plan, or extra
   * usage on (or not reported) and every plan window below
   * NEAR_LIMIT_PERCENT. No report — the call missing, failing, slow, or
   * `rate_limits_available: false` — means no turn. The event mapper's
   * extra-usage stop stays as the backstop for a turn that crosses the limit.
   */
  async function checkPlanUsage(
    q: ReturnType<ClaudeHarnessDeps["query"]>,
    model: string | undefined,
  ): Promise<PlanUsageVerdict> {
    // A recent report said extra usage is off: past the plan Claude Code stops, it can't bill.
    const offAt = state.extraUsageOffAt;
    if (typeof offAt === "number" && deps.now() - offAt < EXTRA_USAGE_OFF_TRUST_MS) return { allowed: true };

    const read = (q as Partial<Pick<typeof q, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">>)
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") return { allowed: false, code: "usage_limit", message: USAGE_UNCONFIRMED };
    let usage: SDKControlGetUsageResponse | undefined;
    try {
      usage = await withTimeout(
        read.call(q, { skipBehaviors: true }),
        deps.usageCheckTimeoutMs,
        "Claude Code didn't report its plan usage in time.",
      );
    } catch {
      return { allowed: false, code: "usage_limit", message: USAGE_UNCONFIRMED };
    }
    const rateLimits = usage?.rate_limits_available ? (usage.rate_limits as Record<string, unknown> | null) : null;
    if (!rateLimits) {
      // A setup-token login lacks the profile scope the report needs; that never changes by retrying.
      return deps.buildEnv().CLAUDE_CODE_OAUTH_TOKEN
        ? { allowed: false, code: "wrong_billing", message: OAUTH_TOKEN_NO_USAGE }
        : { allowed: false, code: "usage_limit", message: USAGE_UNCONFIRMED };
    }

    const full = fullPlanWindow(rateLimits, model);
    if (full) {
      const message =
        "Your Claude plan's included usage is used up" +
        (full.resetsAt ? ` until ${formatResetTime(full.resetsAt / 1000, deps.now())}` : "") +
        `. ${NO_EXTRA_USAGE}`;
      return { allowed: false, code: "usage_limit", message, block: { resetsAt: full.resetsAt } };
    }
    if (extraUsageEnabled(rateLimits) === false) {
      state.extraUsageOffAt = deps.now();
      return { allowed: true };
    }
    state.extraUsageOffAt = null;
    // Extra usage is on (or not reported): stop well short of the limit.
    const near = nearPlanWindow(rateLimits, model);
    if (near) {
      const message =
        `Your Claude plan's included usage is ${Math.floor(near.utilization)}% used` +
        (near.resetsAt ? ` until ${formatResetTime(near.resetsAt / 1000, deps.now())}` : "") +
        ` and extra usage is on. ${NO_EXTRA_USAGE} Try again after the reset, or turn extra usage off in Claude's settings.`;
      return { allowed: false, code: "usage_limit", message };
    }
    return { allowed: true };
  }

  async function* runQuery(
    bin: string,
    params: HarnessTurnParams,
    prompt: string,
    resume: string | undefined,
  ): AsyncGenerator<HarnessEvent, QueryOutcome> {
    if (params.signal.aborted) return "done";
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    params.signal.addEventListener("abort", onAbort, { once: true });

    // The prompt stays back until the account check passes, and the input
    // stays open until the turn's result so the CLI doesn't exit early.
    const gate = deferred<boolean>();
    const turnOver = deferred<void>();
    async function* input(): AsyncGenerator<SDKUserMessage> {
      if (!(await gate.promise)) return;
      yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
      await turnOver.promise;
    }

    let stderrTail = "";
    /** A rate-limit report this turn said extra usage could pay (whether or not it did yet). */
    let extraUsageSeen = false;
    const mapper = new ClaudeEventMapper({ expectedTools: params.tools.definitions.map((d) => d.name) });
    const q = deps.query({
      prompt: input(),
      options: buildClaudeOptions({
        bin,
        env: deps.buildEnv(),
        cwd: deps.agentCwd,
        params,
        resume,
        abortController,
        onStderr: (data) => {
          stderrTail = (stderrTail + data).slice(-2_000);
        },
      }),
    });

    const failure = (error: unknown): HarnessEvent => {
      const detail = stderrTail.trim().split("\n").at(-1);
      const message = errorMessage(error);
      return {
        type: "error",
        code: "harness_error",
        message: `Claude Code stopped unexpectedly: ${message}${detail && !message.includes(detail) ? ` (${detail})` : ""}`,
      };
    };

    /** Remember what the turn found out about the login and the plan. */
    const noteOutcome = (event: HarnessEvent) => {
      if (event.type !== "error") return;
      if (event.code === "not_signed_in") {
        // The account report said signed in (the gate passed), yet Claude rejected the login.
        state.rejection = { at: deps.now(), signInSettled: deps.signIn.settled };
      }
    };

    try {
      // 1. Billing gate, before anything reaches the model.
      let account;
      try {
        const init = await withTimeout(
          q.initializationResult(),
          deps.initTimeoutMs,
          "Claude Code didn't start in time.",
        );
        account = init.account;
      } catch (error) {
        if (params.signal.aborted || error instanceof AbortError) return "done";
        if (resume && isMissingSessionError(error)) return "missing-session";
        yield failure(error);
        return "done";
      }
      const verdict = classifyClaudeAccount(account);
      if (verdict.billing !== "subscription") {
        yield {
          type: "error",
          code: verdict.billing === "none" ? "not_signed_in" : "wrong_billing",
          message: verdict.problem ?? "Claude Code isn't signed in with a Claude subscription.",
        };
        return "done";
      }
      // 2. Can the turn reach extra usage? Only a usage report that says no lets it start.
      const usage = await checkPlanUsage(q, params.model || CLAUDE_DEFAULT_MODEL);
      if (!usage.allowed) {
        if (usage.block) blockUsage(usage.block.resetsAt, usage.message);
        yield { type: "error", code: usage.code, message: usage.message };
        return "done";
      }
      if (params.signal.aborted) return "done";
      gate.resolve(true);

      // 3. The turn.
      for await (const message of q) {
        if (message.type === "rate_limit_event" && overageAvailable(message.rate_limit_info)) extraUsageSeen = true;
        for (const event of mapper.map(message)) {
          noteOutcome(event);
          yield event;
        }
        if (mapper.fatal) {
          abortController.abort();
          break;
        }
        if (mapper.resultSeen) turnOver.resolve();
      }
      if (mapper.resultSeen && !mapper.errorReported) state.rejection = null;
      return resume && mapper.sessionMissing ? "missing-session" : "done";
    } catch (error) {
      if (params.signal.aborted || error instanceof AbortError || mapper.fatal) return "done";
      if (resume && (mapper.sessionMissing || isMissingSessionError(error))) return "missing-session";
      if (isErrorResultThrow(error) && mapper.errorReported) return "done";
      yield failure(error);
      return "done";
    } finally {
      // Extra usage turned out to be on: the next turn checks the plan again.
      if (extraUsageSeen || mapper.limit) state.extraUsageOffAt = null;
      if (mapper.limit) {
        const resetsAt = mapper.limit.resetsAt ? mapper.limit.resetsAt * 1000 : undefined;
        blockUsage(resetsAt, extraUsageMessage(mapper.limit.resetsAt, deps.now()));
      }
      gate.resolve(false);
      turnOver.resolve();
      params.signal.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // Already closed.
      }
    }
  }

  async function* runTurn(params: HarnessTurnParams): AsyncGenerator<HarnessEvent> {
    const lookup = deps.lookupBinary();
    if (lookup.path === null) {
      yield { type: "error", code: "not_installed", message: lookup.problem };
      return;
    }
    const block = currentUsageBlock();
    if (block) {
      // Claude Code would serve this turn from extra usage: don't start it at all.
      yield { type: "error", code: "usage_limit", message: block.message };
      return;
    }
    await ensureCwd();

    let resume = params.sessionId || undefined;
    let prompt = resume ? params.prompt : withConversationHistory(params.history, params.prompt);
    for (;;) {
      const outcome = yield* runQuery(lookup.path, params, prompt, resume);
      if (outcome !== "missing-session" || !resume) return;
      // The session is gone (cleared, or another machine): start over with the chat so far.
      resume = undefined;
      prompt = withConversationHistory(params.history, params.prompt);
    }
  }

  return {
    id: "claude",
    label: LABEL,
    getStatus: () => getStatus(),
    startSignIn: (options?: AgentSignInOptions) => startSignIn(options),
    runTurn,
  };
}
