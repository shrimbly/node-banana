/**
 * Codex app-server notifications → HarnessEvents. Server-only, pure.
 *
 * One mapper per turn, fed every notification for the turn's thread.
 * Notifications from another thread, or from an earlier turn on the same
 * thread (an interrupted one finishing late), are ignored once the turn id is
 * known.
 *
 * `item/tool/call` is a server *request*, answered by the harness; here a
 * dynamic tool call only shows up as `tool-pending` when its item starts —
 * which is when it *executes*: the app-server streams no tool arguments, so
 * unlike Claude there is no signal while a large call is being written.
 * `awaitingModel` marks those silent stretches (after a reasoning item or a
 * tool call, before anything else); the harness turns a long one into a
 * "Planning edits…" hint.
 */

import type { AgentErrorCode, HarnessEvent } from "../types";

/** Namespace our dynamic tools live under (`node_banana.<tool>`). */
export const CODEX_TOOL_NAMESPACE = "node_banana";

interface TurnErrorLike {
  message?: unknown;
  codexErrorInfo?: unknown;
}

const NOT_SIGNED_IN_MESSAGE =
  "Codex isn't signed in (or its sign-in expired or was revoked). Sign in with your ChatGPT account, or run " +
  "`codex login` in a terminal, then try again.";

/** The error code and user-facing message for a Codex turn error. */
export function classifyCodexError(error: TurnErrorLike | null | undefined): { code: AgentErrorCode; message: string } {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const info = error?.codexErrorInfo;
  switch (info) {
    case "usageLimitExceeded":
    case "rateLimitExceeded":
    case "sessionBudgetExceeded":
      return { code: "usage_limit", message: message || "Your ChatGPT plan's Codex usage limit has been reached." };
    case "unauthorized":
      return { code: "not_signed_in", message: NOT_SIGNED_IN_MESSAGE };
    case "contextWindowExceeded":
      return { code: "harness_error", message: "This chat is too long for the model. Start a new chat to continue." };
    default:
      return { code: "harness_error", message: message ? `Codex: ${message}` : "Codex stopped with an error." };
  }
}

type Params = Record<string, unknown>;

function asParams(value: unknown): Params {
  return value && typeof value === "object" ? (value as Params) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class CodexTurnMapper {
  readonly threadId: string;
  /** Set from the turn/start response (or the first turn/started). */
  turnId: string | undefined;
  /** turn/completed arrived for this turn. */
  done = false;
  /** How the turn ended ("completed" | "interrupted" | "failed"). */
  status: string | undefined;
  errorReported = false;
  /**
   * The model finished a reasoning item or a tool call and hasn't started
   * anything since: it is thinking, or writing a tool call Codex won't show
   * until it runs.
   */
  awaitingModel = false;

  private readonly openText = new Set<string>();
  private readonly openReasoning = new Map<string, number>();
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  map(notification: { method: string; params?: unknown }): HarnessEvent[] {
    const params = asParams(notification.params);
    if (params.threadId !== this.threadId) return [];
    const turnId = str(params.turnId) ?? str(asParams(params.turn).id);
    if (notification.method === "turn/started" && !this.turnId) this.turnId = turnId;
    if (this.turnId && turnId && turnId !== this.turnId) return [];
    if (this.done) return [];

    switch (notification.method) {
      case "item/agentMessage/delta":
        return this.textDelta(str(params.itemId), str(params.delta));
      case "item/reasoning/summaryTextDelta":
        return this.reasoningDelta(str(params.itemId), str(params.delta), Number(params.summaryIndex) || 0);
      case "item/started":
        return this.itemStarted(asParams(params.item));
      case "item/completed":
        return this.itemCompleted(asParams(params.item));
      case "thread/tokenUsage/updated": {
        const last = asParams(asParams(params.tokenUsage).last);
        this.inputTokens += Number(last.inputTokens) || 0;
        this.outputTokens += Number(last.outputTokens) || 0;
        return [];
      }
      case "error": {
        if (params.willRetry === true || this.errorReported) return [];
        return [this.error(classifyCodexError(asParams(params.error)))];
      }
      case "turn/completed":
        return this.turnCompleted(asParams(params.turn));
      default:
        return [];
    }
  }

  private textDelta(itemId: string | undefined, delta: string | undefined): HarnessEvent[] {
    if (!itemId || !delta) return [];
    this.awaitingModel = false;
    this.openText.add(itemId);
    return [{ type: "text-delta", id: itemId, delta }];
  }

  private reasoningDelta(itemId: string | undefined, delta: string | undefined, index: number): HarnessEvent[] {
    if (!itemId || !delta) return [];
    this.awaitingModel = false;
    const lastIndex = this.openReasoning.get(itemId);
    this.openReasoning.set(itemId, index);
    // Summary parts are separate paragraphs of one reasoning item.
    const separator = lastIndex !== undefined && index !== lastIndex ? "\n\n" : "";
    return [{ type: "reasoning-delta", id: itemId, delta: `${separator}${delta}` }];
  }

  private itemStarted(item: Params): HarnessEvent[] {
    if (item.type === "agentMessage") this.awaitingModel = false;
    if (item.type !== "dynamicToolCall") return [];
    this.awaitingModel = false;
    const namespace = str(item.namespace);
    const tool = str(item.tool);
    if (!tool || (namespace && namespace !== CODEX_TOOL_NAMESPACE)) return [];
    return [{ type: "tool-pending", toolName: tool }];
  }

  private itemCompleted(item: Params): HarnessEvent[] {
    const id = str(item.id);
    if (!id) return [];
    if (item.type === "agentMessage") {
      if (this.openText.delete(id)) return [{ type: "text-end", id }];
      // Never streamed: emit the whole message.
      const text = str(item.text);
      return text ? [{ type: "text-delta", id, delta: text }, { type: "text-end", id }] : [];
    }
    if (item.type === "dynamicToolCall") {
      this.awaitingModel = this.openText.size === 0;
      return [];
    }
    if (item.type === "reasoning") {
      this.awaitingModel = this.openText.size === 0;
      if (this.openReasoning.delete(id)) return [{ type: "reasoning-end", id }];
      const summary = Array.isArray(item.summary) ? item.summary.filter((part) => typeof part === "string" && part) : [];
      return summary.length > 0
        ? [{ type: "reasoning-delta", id, delta: summary.join("\n\n") }, { type: "reasoning-end", id }]
        : [];
    }
    return [];
  }

  private turnCompleted(turn: Params): HarnessEvent[] {
    this.done = true;
    this.awaitingModel = false;
    this.status = str(turn.status);
    const events: HarnessEvent[] = [];
    // Close anything a failure or interruption left open.
    for (const id of this.openText) events.push({ type: "text-end", id });
    for (const id of this.openReasoning.keys()) events.push({ type: "reasoning-end", id });
    this.openText.clear();
    this.openReasoning.clear();
    if (this.inputTokens || this.outputTokens) {
      events.push({ type: "usage", inputTokens: this.inputTokens, outputTokens: this.outputTokens });
    }
    if (this.status === "failed" && !this.errorReported) {
      events.push(this.error(classifyCodexError(asParams(turn.error))));
    }
    return events;
  }

  private error(details: { code: AgentErrorCode; message: string }): HarnessEvent {
    this.errorReported = true;
    return { type: "error", code: details.code, message: details.message };
  }
}
