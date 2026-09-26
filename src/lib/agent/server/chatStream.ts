/**
 * One agent turn as an AI SDK UI message stream.
 *
 * The chat route hands this the parsed request and the chosen harness; what
 * comes back is the `ReadableStream<UIMessageChunk>` that `useChat` reads.
 * Along the way it:
 *
 * - refuses to start a turn the harness cannot run on a subscription, and says
 *   why in a persisted `data-agent-notice` part instead;
 * - lets one turn per chat run at a time, and a few across all chats
 *   (`session_busy` for the rest);
 * - runs the model the panel picked only when the harness offers it;
 * - maps the harness's events to text, reasoning, session and notice parts;
 * - wraps the tool runtime so every tool call becomes a `dynamic-tool` part
 *   (the same code path for both harnesses; harnesses never write tool UI),
 *   and every tool that changed the draft sends its ops to the browser as a
 *   transient `data-graph-ops` chunk tied to that part's `toolCallId`.
 *
 * Every dependency the turn needs beyond the harness (tool runtime, prompt
 * builders) can be injected, so the bridge is tested with fakes.
 */

import { createUIMessageStream, generateId, type InferUIMessageChunk, type UIMessageStreamWriter } from "ai";
import { z } from "zod";

import { logger } from "@/utils/logger";
import { buildAgentSystemPrompt, buildTurnPrompt } from "../prompt";
import type { ProviderKeys } from "@/lib/providers/keys";
import { createAgentToolRuntime, type AgentToolRuntimeOptions } from "../tools/runtime";
import type {
  AgentChatRequestBody,
  AgentErrorCode,
  AgentGraphOpBatch,
  AgentHarness,
  AgentHarnessId,
  AgentHarnessStatus,
  AgentMessageMetadata,
  AgentModelOption,
  AgentToolDefinition,
  AgentToolResult,
  AgentToolRuntime,
  AgentToolUIOutput,
  AgentUIMessage,
  AgentWorkflowSnapshot,
  HarnessEvent,
  HarnessTurnParams,
} from "../types";

export type AgentUIMessageChunk = InferUIMessageChunk<AgentUIMessage>;

type Writer = UIMessageStreamWriter<AgentUIMessage>;

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Missing, null and "" all mean "not given". */
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value || undefined);

const point = z.object({ x: z.number(), y: z.number() });

/**
 * The snapshot is checked for the fields the tool runtime and the prompt rely
 * on. Objects are loose so a field the snapshot builder adds later still
 * reaches them instead of being stripped here.
 */
const snapshotNodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  position: point,
  width: z.number(),
  height: z.number(),
  title: z.string().optional(),
  groupId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  content: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  error: z.string().nullish(),
});

/** React Flow writes a missing handle as null or leaves it out; both mean "default". */
const handleId = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const snapshotEdgeSchema = z.looseObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: handleId,
  target: z.string().min(1),
  targetHandle: handleId,
  data: z.record(z.string(), z.unknown()).optional(),
});

const workflowSchema = z.looseObject({
  nodes: z.array(snapshotNodeSchema),
  edges: z.array(snapshotEdgeSchema),
  groups: z.array(z.looseObject({ id: z.string(), name: z.string(), color: z.string().optional() })).default([]),
  selectedNodeIds: z.array(z.string()).default([]),
  viewport: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), zoom: z.number() })
    .optional(),
  workflowName: z.string().optional(),
  // The user's saved defaults for new nodes; malformed entries are dropped, never a reason to refuse the turn.
  nodeDefaults: z.record(z.string(), z.record(z.string(), z.unknown())).optional().catch(undefined),
});

const messageSchema = z.looseObject({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
});

const harnessIdSchema: z.ZodType<AgentHarnessId> = z.enum(["claude", "codex"]);

/**
 * A Claude session or Codex thread id (a UUID either way). Anything else is
 * dropped rather than refused: the turn then starts a new session seeded with
 * the chat's history, and the string never reaches the CLI.
 */
const sessionIdSchema = optionalText.transform((value) =>
  value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
);

const chatRequestSchema = z.object({
  // Used as the key for "one turn per chat"; bounded so it stays a key.
  id: z.string().min(1).max(200),
  messages: z.array(messageSchema).min(1),
  harness: harnessIdSchema,
  // Checked against the harness's own list before the turn (pickTurnModel).
  model: optionalText.refine((value) => value === undefined || value.length <= 200, "too long"),
  sessionId: sessionIdSchema,
  workflow: workflowSchema,
});

export type ParseAgentChatRequestResult =
  | { ok: true; body: AgentChatRequestBody }
  | { ok: false; message: string };

/**
 * Validate a chat request body. The message names the offending fields
 * (`workflow.nodes[2].position: …`), since the only sender is our own panel
 * and a failure here is a bug to find, not a user mistake to soften.
 */
export function parseAgentChatRequest(raw: unknown): ParseAgentChatRequestResult {
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: `Invalid agent request: ${describeIssues(parsed.error)}` };
  }
  const { id, messages, harness, model, sessionId, workflow } = parsed.data;
  const body: AgentChatRequestBody = {
    id,
    // Checked for what this module reads (role, text parts); the rest of each
    // part is the panel's own UIMessage, passed through untouched.
    messages: messages as unknown as AgentUIMessage[],
    harness,
    workflow: workflow as unknown as AgentWorkflowSnapshot,
    ...(model ? { model } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  if (!readConversation(body.messages)) {
    return { ok: false, message: `Invalid agent request: ${LAST_MESSAGE_PROBLEM}` };
  }
  return { ok: true, body };
}

function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const path = formatPath(issue.path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - shown.length;
  return shown.join("; ") + (more > 0 ? ` (and ${more} more)` : "");
}

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === "number") return `${out}[${key}]`;
    return out ? `${out}.${String(key)}` : String(key);
  }, "");
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface AgentConversation {
  /** Earlier user and assistant turns as plain text, oldest first. */
  history: HarnessTurnParams["history"];
  /** This turn's words: the text of the last (user) message. */
  userText: string;
}

const LAST_MESSAGE_PROBLEM = "the last message must be the user's, with text in it.";

/**
 * Split the chat into this turn's text and the history before it. Only text
 * parts count: tool cards, notices and reasoning are the panel's record of a
 * turn, not something to replay to a new session.
 */
export function readConversation(messages: readonly AgentUIMessage[]): AgentConversation | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  const userText = messageText(last);
  if (!userText) return null;

  const history: AgentConversation["history"] = [];
  for (const message of messages.slice(0, -1)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) history.push({ role: message.role, text });
  }
  return { history, userText };
}

function messageText(message: AgentUIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Why this harness cannot run a turn right now, or null when it can. Only a
 * subscription login may run; "unknown" billing is refused like "api", since
 * the promise to the user is that a turn never lands on an API bill.
 */
export function harnessNotReady(status: AgentHarnessStatus): { code: AgentErrorCode; message: string } | null {
  if (!status.installed) {
    return {
      code: "not_installed",
      message: status.problem ?? `${status.label} was not found on this machine. Install it, then check again.`,
    };
  }
  if (!status.signedIn) {
    return {
      code: "not_signed_in",
      message:
        status.problem ??
        `Sign in to ${status.label} with your subscription to use the agent (\`${status.signInCommand}\`).`,
    };
  }
  if (status.billing !== "subscription") {
    return {
      code: "wrong_billing",
      message:
        status.problem ??
        (status.billing === "api"
          ? `${status.label} is signed in with a credential that bills an API account. ` +
            `Sign in with your subscription instead (\`${status.signInCommand}\`).`
          : `Could not confirm that ${status.label} runs on a subscription, so the agent will not start. ` +
            `Sign in with your subscription (\`${status.signInCommand}\`).`),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The model to hand the harness: the panel's pick when the harness lists it,
 * otherwise none, so the CLI runs its own default. An id the harness did not
 * list (a stale saved pick, or any string a caller sends) never reaches the
 * CLI's command line or JSON-RPC.
 */
/**
 * Tells the model which model it is. Our system prompt replaces the CLI's own,
 * which is where Claude Code normally says so; without it a model asked
 * "which model are you?" guesses, and often names the wrong one.
 */
export function modelIdentity(option: AgentModelOption | undefined, harnessLabel: string): string {
  if (!option) return "";
  const exact = option.resolvedModel ?? option.id;
  const name = option.id === "default" ? exact : option.label;
  const exactNote = name === exact ? "" : ` (${exact})`;
  return `\n\nYou are running on ${name}${exactNote}, through the user's ${harnessLabel}. Say so if asked which model you are.`;
}

export function pickTurnModel(requested: string | undefined, options: readonly AgentModelOption[]): string | undefined {
  if (!requested) return undefined;
  return options.some((option) => option.id === requested) ? requested : undefined;
}

// ---------------------------------------------------------------------------
// One turn per chat, a few in all
// ---------------------------------------------------------------------------

interface ActiveTurn {
  signal: AbortSignal;
  /** Resolves once the harness has fully stopped, not just once the stream closed. */
  settled: Promise<void>;
}

/**
 * On globalThis so a dev-server reload of this module does not forget a turn
 * whose CLI is still running.
 */
const ACTIVE_TURNS = Symbol.for("node-banana.agent.activeTurns");

function activeTurns(): Map<string, ActiveTurn> {
  const store = globalThis as unknown as Record<symbol, Map<string, ActiveTurn> | undefined>;
  return (store[ACTIVE_TURNS] ??= new Map());
}

/**
 * How long a new turn waits for a stopped one on the same chat to wind down.
 * Stop, then send again straight away, is the normal way to redirect the agent;
 * the CLI takes a second or two to exit after an abort, and that should not
 * read as "busy". Past this, an aborted turn no longer holds the chat.
 */
const ABORTED_TURN_GRACE_MS = 10_000;

/**
 * How many turns may run at once across every chat. Each one is a CLI process
 * (about 250 MB) on the user's own plan and rate limits; one person in a few
 * tabs never needs more, and a flood of chat ids must not start a CLI apiece.
 */
export const MAX_ACTIVE_TURNS = 3;

type ClaimResult = { release: () => void } | { busy: "chat" | "all" };

/**
 * Claim `chatId` for a turn. Refused (`busy`) when another turn on this chat
 * is still running and was not stopped, or when `maxActive` turns are already
 * running. A stopped turn still winding down counts toward neither: its CLI
 * has been told to exit.
 */
async function claimChat(
  chatId: string,
  signal: AbortSignal,
  limits: { graceMs: number; maxActive: number }
): Promise<ClaimResult> {
  const turns = activeTurns();
  const previous = turns.get(chatId);
  if (previous?.signal.aborted) await waitAtMost(previous.settled, limits.graceMs);

  // Re-read: another request may have claimed the chat while this one waited.
  const current = turns.get(chatId);
  if (current && !current.signal.aborted) return { busy: "chat" };
  if (runningTurnCount(turns) >= limits.maxActive) return { busy: "all" };

  let resolveSettled!: () => void;
  const entry: ActiveTurn = { signal, settled: new Promise<void>((resolve) => (resolveSettled = resolve)) };
  turns.set(chatId, entry);
  return {
    release: () => {
      if (turns.get(chatId) === entry) turns.delete(chatId);
      resolveSettled();
    },
  };
}

function runningTurnCount(turns: Map<string, ActiveTurn>): number {
  let count = 0;
  for (const turn of turns.values()) if (!turn.signal.aborted) count++;
  return count;
}

async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// Chunk writing
// ---------------------------------------------------------------------------

type StreamedPartKind = "text" | "reasoning";

/**
 * Writes one assistant message. Owns the bookkeeping the UI stream protocol
 * needs: a text or reasoning part must be started before its first delta and
 * ended exactly once, and a harness may not end what it started.
 */
class TurnWriter {
  /** `${kind}:${harness part id}` → the UI part currently open for it. */
  private readonly openParts = new Map<string, { kind: StreamedPartKind; id: string }>();
  private partCount = 0;
  private statusShown = false;
  private sessionId: string | undefined;
  private model: string | undefined;
  private modelLabel: string | undefined;
  noticeCount = 0;
  toolCallCount = 0;

  constructor(
    private readonly writer: Writer,
    private readonly harnessId: AgentHarnessId
  ) {}

  start(model: string | undefined): void {
    this.model = model;
    this.writer.write({ type: "start", messageMetadata: this.metadata() });
  }

  setModel(model: string | undefined, label?: string): void {
    this.model = model;
    this.modelLabel = label;
  }

  delta(kind: StreamedPartKind, sourceId: string, delta: string): void {
    // Empty deltas would open empty parts (Claude streams hidden thinking as
    // empty reasoning), which the panel would then have to filter out.
    if (!delta) return;
    const key = `${kind}:${sourceId}`;
    let id = this.openParts.get(key)?.id;
    if (!id) {
      this.clearStatus();
      id = `${kind}-${++this.partCount}`;
      this.openParts.set(key, { kind, id });
      this.writer.write(kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id });
    }
    this.writer.write(kind === "text" ? { type: "text-delta", id, delta } : { type: "reasoning-delta", id, delta });
  }

  end(kind: StreamedPartKind, sourceId: string): void {
    const key = `${kind}:${sourceId}`;
    const part = this.openParts.get(key);
    if (!part) return;
    this.openParts.delete(key);
    this.writeEnd(part);
  }

  /**
   * End every open text and reasoning part. Before a tool card, so text the
   * harness sends later for the same block lands in a new part below the card
   * rather than being appended above it.
   */
  closeParts(): void {
    const parts = [...this.openParts.values()];
    this.openParts.clear();
    for (const part of parts) this.writeEnd(part);
  }

  private writeEnd({ kind, id }: { kind: StreamedPartKind; id: string }): void {
    this.writer.write(kind === "text" ? { type: "text-end", id } : { type: "reasoning-end", id });
  }

  /** A transient progress line for the panel; "" clears it. */
  status(text: string): void {
    this.writer.write({ type: "data-agent-status", data: { text }, transient: true });
    this.statusShown = text !== "";
  }

  private clearStatus(): void {
    if (this.statusShown) this.status("");
  }

  session(sessionId: string): void {
    if (!sessionId || sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    // Persisted with a fixed id, so a later session in the same turn (Claude
    // retrying without resume) replaces the part instead of adding one.
    this.writer.write({
      type: "data-agent-session",
      id: "session",
      data: { harness: this.harnessId, sessionId },
    });
  }

  notice(code: AgentErrorCode, message: string): void {
    this.noticeCount++;
    this.clearStatus();
    this.writer.write({ type: "data-agent-notice", data: { code, message, harness: this.harnessId } });
  }

  toolStarted(call: { toolCallId: string; toolName: string; title: string; input: unknown }): void {
    this.toolCallCount++;
    this.closeParts();
    this.clearStatus();
    this.writer.write({
      type: "tool-input-available",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      title: call.title,
      input: call.input,
      dynamic: true,
      // Ran on the server: keeps useChat's onToolCall from treating it as a
      // client tool waiting for a result.
      providerExecuted: true,
    });
  }

  toolFinished(toolCallId: string, result: AgentToolResult): void {
    if (result.ops.length > 0) {
      const batch: AgentGraphOpBatch = {
        batchId: `ops_${generateId()}`,
        toolCallId,
        ops: result.ops,
        summary: result.summary,
        ...(result.focusNodeIds ? { focusNodeIds: result.focusNodeIds } : {}),
        ...(result.replacedCanvas ? { replacedCanvas: true } : {}),
      };
      // Transient: the ops are applied once, when they arrive. Persisting them
      // would re-apply nothing but would bloat every later request's history.
      this.writer.write({ type: "data-graph-ops", data: batch, transient: true });
    }
    if (result.ok) {
      const output: AgentToolUIOutput = { ok: true, summary: result.summary };
      this.writer.write({ type: "tool-output-available", toolCallId, output, dynamic: true, providerExecuted: true });
    } else {
      this.writer.write({
        type: "tool-output-error",
        toolCallId,
        errorText: result.summary || result.text,
        dynamic: true,
        providerExecuted: true,
      });
    }
  }

  /** Ends the message. The last status line of a turn is always "". */
  finish(): void {
    this.closeParts();
    this.clearStatus();
    this.writer.write({
      type: "finish",
      finishReason: this.noticeCount > 0 ? "error" : "stop",
      messageMetadata: this.metadata(),
    });
  }

  finishWithNotice(code: AgentErrorCode, message: string): void {
    this.notice(code, message);
    this.finish();
  }

  /** The client is gone; this only matters to anything else reading the stream. */
  abort(): void {
    this.closeParts();
    this.clearStatus();
    this.writer.write({ type: "abort", reason: "The request was cancelled." });
  }

  private metadata(): AgentMessageMetadata {
    return {
      harness: this.harnessId,
      ...(this.model ? { model: this.model } : {}),
      ...(this.modelLabel ? { modelLabel: this.modelLabel } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Harnesses may hand back the name the model saw (`mcp__node_banana__x` from
 * Claude's MCP bridge, a namespaced name from Codex) rather than ours.
 */
const TOOL_NAME_PREFIXES = ["mcp__node_banana__", "node_banana__", "node_banana.", "node_banana/"];

function findToolDefinition(definitions: readonly AgentToolDefinition[], name: string): AgentToolDefinition | undefined {
  const exact = definitions.find((definition) => definition.name === name);
  if (exact) return exact;
  const prefix = TOOL_NAME_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return undefined;
  const bare = name.slice(prefix.length);
  return definitions.find((definition) => definition.name === bare);
}

/** The panel's "working" line while the model is still writing a tool call. */
function pendingToolStatus(definitions: readonly AgentToolDefinition[], toolName: string): string {
  const definition = findToolDefinition(definitions, toolName);
  if (!definition) return "Working…";
  return definition.readOnly ? "Reading the canvas…" : "Planning edits…";
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The runtime the harness sees. Same definitions; `execute` also writes the
 * tool's UI parts around the real call, and never throws.
 */
function wrapToolRuntime(runtime: AgentToolRuntime, turn: TurnWriter, context: { chatId: string }): AgentToolRuntime {
  return {
    definitions: runtime.definitions,
    async execute(name, args) {
      // The tool call reaches us on the harness's own path (an MCP handler, a
      // JSON-RPC request), while text the model wrote just before it may
      // still be queued in the event iterator. One macrotask lets that text
      // reach the stream first, so the card lands after it.
      await nextMacrotask();

      const definition = findToolDefinition(runtime.definitions, name);
      const toolName = definition?.name ?? name;
      const toolCallId = `call_${generateId()}`;
      turn.toolStarted({ toolCallId, toolName, title: definition?.title ?? toolName, input: args });

      let result: AgentToolResult;
      try {
        result = await runtime.execute(toolName, args);
      } catch (error) {
        // The runtime promises not to throw; if it does, the model still gets
        // an answer it can act on, and the canvas is untouched.
        logger.error("api.error", "Agent tool threw", { chatId: context.chatId, toolName }, asError(error));
        result = {
          ok: false,
          text: `The ${toolName} tool failed unexpectedly (${errorMessage(error)}). No canvas changes were applied.`,
          summary: `${definition?.title ?? toolName} failed unexpectedly`,
          ops: [],
        };
      }
      turn.toolFinished(toolCallId, result);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness events
// ---------------------------------------------------------------------------

const ABORTED = Symbol("aborted");

function whenAborted(signal: AbortSignal): { promise: Promise<typeof ABORTED>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => onAbort && signal.removeEventListener("abort", onAbort) };
}

interface PumpResult {
  outcome: "done" | "aborted" | "failed";
  error?: unknown;
  /** Resolves when the harness iterator has actually finished. */
  settled: Promise<void>;
}

const ignore = () => undefined;

/**
 * Feed the harness's events to `onEvent` until the turn ends.
 *
 * On abort this stops listening at once rather than waiting for the harness
 * to notice: the browser is already gone, and a harness slow to wind down must
 * not hold the stream open. The harness keeps the same signal and finishes
 * its own teardown; `settled` reports when it has, which is when the chat is
 * free for the next turn.
 */
async function pumpEvents(
  events: AsyncIterable<HarnessEvent>,
  signal: AbortSignal,
  onEvent: (event: HarnessEvent) => void
): Promise<PumpResult> {
  const iterator = events[Symbol.asyncIterator]();
  const abort = whenAborted(signal);
  try {
    for (;;) {
      const next = iterator.next();
      const step = await Promise.race([next, abort.promise]);
      if (step === ABORTED) {
        const settled = next
          .then(ignore, ignore)
          .then(() => iterator.return?.())
          .then(ignore, ignore);
        return { outcome: "aborted", settled };
      }
      if (step.done) return { outcome: "done", settled: Promise.resolve() };
      onEvent(step.value);
    }
  } catch (error) {
    const settled = Promise.resolve()
      .then(() => iterator.return?.())
      .then(ignore, ignore);
    return { outcome: signal.aborted ? "aborted" : "failed", error, settled };
  } finally {
    abort.dispose();
  }
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface AgentChatStreamOptions {
  body: AgentChatRequestBody;
  harness: AgentHarness;
  /** The request's signal: the browser stopping or leaving ends the turn. */
  signal: AbortSignal;
  /**
   * The user's provider API keys for this turn, read from the request
   * headers by the route (else the server's .env). They go to the tool
   * runtime only, for listing models and reading their schemas: never into
   * the harness's turn (prompts, history, tool text) or a log.
   */
  providerKeys?: ProviderKeys;
  /** Defaults to the real tool runtime. */
  createToolRuntime?: (snapshot: AgentWorkflowSnapshot, options: AgentToolRuntimeOptions) => AgentToolRuntime;
  /** Defaults to the real system prompt. */
  buildSystemPrompt?: (opts: { harness: AgentHarnessId }) => string;
  /** Defaults to the real turn prompt (canvas context + the user's words). */
  buildTurnPrompt?: (opts: { userText: string; snapshot: AgentWorkflowSnapshot }) => string;
  /** How long to wait for a stopped turn on the same chat to wind down. */
  abortedTurnGraceMs?: number;
  /** How many turns may run at once across all chats. Defaults to MAX_ACTIVE_TURNS. */
  maxActiveTurns?: number;
}

export function createAgentChatStream(options: AgentChatStreamOptions): ReadableStream<AgentUIMessageChunk> {
  return createUIMessageStream<AgentUIMessage>({
    execute: ({ writer }) => runAgentTurn(writer, options),
    // Only reached if the bridge itself breaks; everything expected becomes a
    // notice. The error chunk puts useChat in its error state with this text.
    onError: (error) => {
      logger.error("api.error", "Agent chat stream failed", { chatId: options.body.id }, asError(error));
      return `The agent stopped unexpectedly: ${errorMessage(error)}`;
    },
  });
}

async function runAgentTurn(writer: Writer, options: AgentChatStreamOptions): Promise<void> {
  const { body, harness, signal } = options;
  const turn = new TurnWriter(writer, harness.id);
  turn.start(body.model);

  const conversation = readConversation(body.messages);
  if (!conversation) {
    turn.finishWithNotice("bad_request", `Nothing to send: ${LAST_MESSAGE_PROBLEM}`);
    return;
  }

  const maxActive = options.maxActiveTurns ?? MAX_ACTIVE_TURNS;
  const claim = await claimChat(body.id, signal, {
    graceMs: options.abortedTurnGraceMs ?? ABORTED_TURN_GRACE_MS,
    maxActive,
  });
  if ("busy" in claim) {
    logger.warn("api.llm", "Agent turn refused: busy", { chatId: body.id, harness: harness.id, busy: claim.busy });
    turn.finishWithNotice(
      "session_busy",
      claim.busy === "chat"
        ? "The agent is still working on the previous message in this chat. Wait for it to finish, or stop it first."
        : `The agent is already working on ${maxActive} messages in other chats or tabs. ` +
            "Wait for one to finish, or stop it, then send again."
    );
    return;
  }
  const { release } = claim;

  let settled: Promise<void> = Promise.resolve();
  try {
    settled = (await runClaimedTurn(turn, options, conversation)).settled;
  } finally {
    void settled.then(release, release);
  }
}

async function runClaimedTurn(
  turn: TurnWriter,
  options: AgentChatStreamOptions,
  conversation: AgentConversation
): Promise<{ settled: Promise<void> }> {
  const { body, harness, signal } = options;
  const done = { settled: Promise.resolve() };
  const startedAt = Date.now();
  const logContext = { chatId: body.id, harness: harness.id };

  let status: AgentHarnessStatus;
  try {
    status = await harness.getStatus();
  } catch (error) {
    logger.error("api.error", "Agent status check failed", logContext, asError(error));
    turn.finishWithNotice("harness_error", `Could not check ${harness.label}: ${errorMessage(error)}`);
    return done;
  }

  const notReady = harnessNotReady(status);
  if (notReady) {
    logger.warn("api.llm", "Agent turn refused", { ...logContext, code: notReady.code });
    turn.finishWithNotice(notReady.code, notReady.message);
    return done;
  }
  if (signal.aborted) {
    turn.abort();
    return done;
  }

  const requestedModel = pickTurnModel(body.model, status.models);
  if (body.model && !requestedModel) {
    logger.warn("api.llm", "Agent model not offered by the harness; using its default", {
      ...logContext,
      requestedModel: body.model.slice(0, 100),
    });
  }
  const model = requestedModel ?? status.models.find((option) => option.isDefault)?.id;
  const modelOption = status.models.find((option) => option.id === model);
  turn.setModel(model, modelOption?.label);

  let params: HarnessTurnParams;
  try {
    const runtime = (options.createToolRuntime ?? createAgentToolRuntime)(body.workflow, {
      providerKeys: options.providerKeys ?? {},
      signal,
    });
    params = {
      history: conversation.history,
      prompt: (options.buildTurnPrompt ?? buildTurnPrompt)({
        userText: conversation.userText,
        snapshot: body.workflow,
      }),
      systemPrompt:
        (options.buildSystemPrompt ?? buildAgentSystemPrompt)({ harness: harness.id }) + modelIdentity(modelOption, status.label),
      tools: wrapToolRuntime(runtime, turn, { chatId: body.id }),
      signal,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      // Left out when the panel picked none, or one the harness does not offer,
      // so the harness uses its own default.
      ...(requestedModel ? { model: requestedModel } : {}),
    };
  } catch (error) {
    logger.error("api.error", "Agent turn setup failed", logContext, asError(error));
    turn.finishWithNotice("harness_error", `Could not prepare the agent's turn: ${errorMessage(error)}`);
    return done;
  }

  logger.info("api.llm", "Agent turn started", {
    ...logContext,
    model,
    resumed: Boolean(body.sessionId),
    historyLength: conversation.history.length,
    nodeCount: body.workflow.nodes.length,
  });
  turn.status(`Starting ${harness.label}…`);

  const usage = { inputTokens: 0, outputTokens: 0 };
  let events: AsyncIterable<HarnessEvent>;
  try {
    events = harness.runTurn(params);
  } catch (error) {
    logger.error("api.error", "Agent harness failed to start", logContext, asError(error));
    turn.finishWithNotice("harness_error", `${harness.label} could not start: ${errorMessage(error)}`);
    return done;
  }

  const pumped = await pumpEvents(events, signal, (event) => {
    switch (event.type) {
      case "session":
        turn.session(event.sessionId);
        break;
      case "text-delta":
        turn.delta("text", event.id, event.delta);
        break;
      case "text-end":
        turn.end("text", event.id);
        break;
      case "reasoning-delta":
        turn.delta("reasoning", event.id, event.delta);
        break;
      case "reasoning-end":
        turn.end("reasoning", event.id);
        break;
      case "tool-pending":
        turn.status(pendingToolStatus(params.tools.definitions, event.toolName));
        break;
      case "usage":
        usage.inputTokens += event.inputTokens ?? 0;
        usage.outputTokens += event.outputTokens ?? 0;
        break;
      case "error":
        // The harness reporting its own cancellation is not news to anyone.
        if (event.code === "aborted" && signal.aborted) break;
        logger.warn("api.llm", "Agent harness reported an error", { ...logContext, code: event.code });
        turn.notice(event.code, event.message);
        break;
    }
  });

  if (pumped.outcome === "failed") {
    logger.error("api.error", "Agent harness failed", logContext, asError(pumped.error));
    turn.notice("harness_error", `${harness.label} stopped with an error: ${errorMessage(pumped.error)}`);
  }

  logger.info("api.llm", "Agent turn finished", {
    ...logContext,
    outcome: pumped.outcome,
    durationMs: Date.now() - startedAt,
    toolCalls: turn.toolCallCount,
    notices: turn.noticeCount,
    ...usage,
  });

  if (pumped.outcome === "aborted") turn.abort();
  else turn.finish();
  return { settled: pumped.settled };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

function asError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}
