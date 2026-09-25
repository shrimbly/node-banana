/**
 * Claude Agent SDK messages → HarnessEvents. Server-only, pure.
 *
 * One mapper per query. Text and reasoning stream from the partial messages
 * (`includePartialMessages: true`); a complete `assistant` message only adds
 * text when its content never streamed (and carries the SDK's error codes).
 * Messages from sub-agents (`parent_tool_use_id` set) are ignored; the agent
 * has no Agent tool, so there should be none.
 *
 * Tool calls are not reported here beyond `tool-pending`: the route's tool
 * wrapper writes the tool UI parts when our MCP handler actually runs.
 *
 * Extra usage: once a Pro/Max plan's included usage runs out, Claude Code
 * keeps serving requests from the account's extra usage (billed at API
 * rates) when that is enabled, and says so only in `rate_limit_event`. The
 * agent runs on included usage only, so that event is fatal: the turn stops
 * after the one request that reported it.
 */

import {
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk/core";
import type { AgentErrorCode, HarnessEvent } from "../types";

/** The in-process MCP server's name; tools reach the model as `mcp__node_banana__<tool>`. */
export const CLAUDE_MCP_SERVER_NAME = "node_banana";

const TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER_NAME}__`;

export function claudeToolName(tool: string): string {
  return `${TOOL_PREFIX}${tool}`;
}

const MISSING_SESSION = /No conversation found with session ID/i;

const SIGN_IN_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"]);
const USAGE_ERRORS = new Set(["rate_limit", "billing_error"]);

const NOT_SIGNED_IN_MESSAGE =
  "Claude Code isn't signed in (or its sign-in expired or was revoked). Sign in with your Claude Pro or Max " +
  "account, or run `claude auth login` in a terminal, then try again.";

/** "3:30 PM" today, "Tue 3:30 PM" within a week, else the date. Server-local time (the app runs on the user's machine). */
export function formatResetTime(epochSeconds: number, now: number = Date.now()): string {
  const at = new Date(epochSeconds * 1000);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return time;
  if (epochSeconds * 1000 - now < 6 * 24 * 60 * 60 * 1000) {
    return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  }
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/**
 * Whether a rate-limit report means Claude Code is (or is about to be)
 * serving the turn from extra usage instead of the plan's included usage.
 * A plain rejection with extra usage unavailable is a hard limit, not this.
 */
export function isExtraUsage(info: Partial<SDKRateLimitInfo> | null | undefined): boolean {
  if (!info) return false;
  return (
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    info.rateLimitType === "overage" ||
    (info.status === "rejected" && (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"))
  );
}

/** The plan limit Claude Code reported, when the agent stopped for it. */
export interface ClaudeUsageLimit {
  /** When the plan window resets (epoch seconds), if reported. */
  resetsAt?: number;
  /** When the extra-usage period resets (the monthly cycle), if reported. */
  overageResetsAt?: number;
  rateLimitType?: string;
}

export function extraUsageMessage(resetsAt: number | undefined, now: number = Date.now()): string {
  return (
    "Your Claude plan's included usage is used up, and Claude Code switched to extra usage (billed at API " +
    "rates), so the agent stopped. It only runs on your plan's included usage." +
    (resetsAt ? ` Try again after ${formatResetTime(resetsAt, now)}.` : " Try again when your plan's limit resets.")
  );
}

/**
 * The error code and user-facing message for an error Claude Code reported,
 * from the SDK's assistant error code and/or its text.
 */
export function classifyClaudeError(
  text: string,
  assistantError?: string,
  rateLimited = false,
): { code: AgentErrorCode; message: string } {
  const trimmed = text.trim();
  if (
    (assistantError && SIGN_IN_ERRORS.has(assistantError)) ||
    /not logged in|please run \/login|oauth token (has )?expired|invalid (api key|bearer token)/i.test(trimmed)
  ) {
    return { code: "not_signed_in", message: NOT_SIGNED_IN_MESSAGE };
  }
  const limitText = [...USAGE_LIMIT_ERROR_PREFIXES, ...ORG_POLICY_LIMIT_PREFIXES].some((prefix) =>
    trimmed.startsWith(prefix),
  );
  // A rejected rate_limit_event earlier in the turn explains an otherwise vague error.
  if (limitText || (assistantError && USAGE_ERRORS.has(assistantError)) || rateLimited) {
    return {
      code: "usage_limit",
      message: trimmed || "Your Claude plan's usage limit has been reached. Try again when it resets.",
    };
  }
  return { code: "harness_error", message: trimmed ? `Claude Code: ${trimmed}` : "Claude Code stopped with an error." };
}

type OpenBlock = { kind: "text" | "reasoning"; id: string; open: boolean };

interface ContentBlockLike {
  type?: string;
  text?: string;
  name?: string;
}

/**
 * Stateful mapper for one query. Read the public flags after the stream ends:
 * `sessionMissing` asks the harness to retry without `resume`, `fatal` means
 * the turn must be stopped now (the error event has been emitted).
 */
export class ClaudeEventMapper {
  /** Session id from the init message. */
  sessionId: string | undefined;
  /** The init message listed missing tools or an API-key source: stop the query. */
  fatal = false;
  /** `resume` named a session Claude Code no longer has. */
  sessionMissing = false;
  /** An error event was emitted; later error signals for the turn are duplicates. */
  errorReported = false;
  /** The result message arrived: the turn is over. */
  resultSeen = false;
  /** Set when the turn was stopped because Claude Code moved to extra usage. */
  limit: ClaudeUsageLimit | undefined;
  /** The last plan report of the turn. */
  rateLimit: SDKRateLimitInfo | undefined;

  private readonly expectedTools: string[];
  private blocks = new Map<number, OpenBlock>();
  private messageId = "";
  private messageSeq = 0;
  private readonly streamedMessageIds = new Set<string>();
  private rateLimited = false;

  constructor(options: { expectedTools: string[] }) {
    this.expectedTools = options.expectedTools;
  }

  map(message: SDKMessage): HarnessEvent[] {
    switch (message.type) {
      case "system":
        return message.subtype === "init" ? this.onInit(message) : [];
      case "stream_event":
        return message.parent_tool_use_id ? [] : this.onStreamEvent(message.event);
      case "assistant":
        return message.parent_tool_use_id ? [] : this.onAssistant(message);
      case "rate_limit_event":
        return this.onRateLimit(message.rate_limit_info);
      case "result":
        return this.onResult(message);
      default:
        return [];
    }
  }

  private onInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    if (message.session_id && message.session_id !== this.sessionId) {
      this.sessionId = message.session_id;
      events.push({ type: "session", sessionId: message.session_id });
    }
    if (message.apiKeySource && message.apiKeySource !== "none") {
      this.fatal = true;
      events.push(
        this.error(
          "wrong_billing",
          `Claude Code was about to use an API key (${message.apiKeySource}), which bills API credits, ` +
            "so the turn was stopped. Sign in with your Claude Pro or Max account.",
        ),
      );
      return events;
    }
    const loaded = new Set(message.tools);
    const missing = this.expectedTools.filter((tool) => !loaded.has(claudeToolName(tool)));
    if (missing.length > 0) {
      this.fatal = true;
      events.push(
        this.error(
          "harness_error",
          `Node Banana's tools failed to load in Claude Code (missing: ${missing.join(", ")}). ` +
            "The turn was stopped before the model could act without them.",
        ),
      );
    }
    return events;
  }

  private onRateLimit(info: SDKRateLimitInfo | undefined): HarnessEvent[] {
    this.rateLimited = info?.status === "rejected";
    this.rateLimit = info;
    if (!info || !isExtraUsage(info)) return [];
    this.fatal = true;
    this.limit = { resetsAt: info.resetsAt, overageResetsAt: info.overageResetsAt, rateLimitType: info.rateLimitType };
    if (this.errorReported) return [];
    return [this.error("usage_limit", extraUsageMessage(info.resetsAt))];
  }

  private onStreamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): HarnessEvent[] {
    switch (event.type) {
      case "message_start": {
        this.messageSeq += 1;
        this.messageId = event.message?.id || `message-${this.messageSeq}`;
        this.streamedMessageIds.add(this.messageId);
        this.blocks = new Map();
        return [];
      }
      case "content_block_start": {
        const block = event.content_block as ContentBlockLike;
        const id = `${this.messageId}:${event.index}`;
        if (block.type === "text") this.blocks.set(event.index, { kind: "text", id, open: false });
        else if (block.type === "thinking") this.blocks.set(event.index, { kind: "reasoning", id, open: false });
        else if (block.type === "tool_use" && block.name?.startsWith(TOOL_PREFIX)) {
          return [{ type: "tool-pending", toolName: block.name.slice(TOOL_PREFIX.length) }];
        }
        return [];
      }
      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        if (!block) return [];
        const delta = event.delta as { type: string; text?: string; thinking?: string };
        if (block.kind === "text" && delta.type === "text_delta" && delta.text) {
          block.open = true;
          return [{ type: "text-delta", id: block.id, delta: delta.text }];
        }
        if (block.kind === "reasoning" && delta.type === "thinking_delta" && delta.thinking) {
          block.open = true;
          return [{ type: "reasoning-delta", id: block.id, delta: delta.thinking }];
        }
        return [];
      }
      case "content_block_stop": {
        const block = this.blocks.get(event.index);
        this.blocks.delete(event.index);
        if (!block?.open) return [];
        return [{ type: block.kind === "text" ? "text-end" : "reasoning-end", id: block.id }];
      }
      default:
        return [];
    }
  }

  private onAssistant(message: Extract<SDKMessage, { type: "assistant" }>): HarnessEvent[] {
    const content = (Array.isArray(message.message?.content) ? message.message.content : []) as ContentBlockLike[];
    const text = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");

    if (message.error) {
      if (this.errorReported) return [];
      const { code, message: userMessage } = classifyClaudeError(text, message.error, this.rateLimited);
      return [this.error(code, userMessage)];
    }

    // Content that never streamed (partial messages unavailable for it): emit it whole.
    const id = message.message?.id;
    if (!text || (id && this.streamedMessageIds.has(id))) return [];
    const textId = `${id || `assistant-${message.uuid}`}:text`;
    return [
      { type: "text-delta", id: textId, delta: text },
      { type: "text-end", id: textId },
    ];
  }

  private onResult(message: Extract<SDKMessage, { type: "result" }>): HarnessEvent[] {
    this.resultSeen = true;
    const events: HarnessEvent[] = [];
    const usage = message.usage;
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      events.push({
        type: "usage",
        inputTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
      });
    }
    if (!message.is_error || this.errorReported) return events;

    if (message.subtype === "success") {
      const { code, message: userMessage } = classifyClaudeError(message.result ?? "", undefined, this.rateLimited);
      events.push(this.error(code, userMessage));
      return events;
    }
    const detail = (message.errors ?? []).join("; ");
    if (MISSING_SESSION.test(detail)) {
      this.sessionMissing = true;
      return events;
    }
    if (message.subtype === "error_max_turns") {
      events.push(this.error("harness_error", "The agent stopped after reaching its step limit for one message."));
      return events;
    }
    const { code, message: userMessage } = classifyClaudeError(detail || message.subtype, undefined, this.rateLimited);
    events.push(this.error(code, userMessage));
    return events;
  }

  private error(code: AgentErrorCode, message: string): HarnessEvent {
    this.errorReported = true;
    return { type: "error", code, message };
  }
}

/**
 * Whether a thrown error means `resume` named a session that no longer exists.
 * With streaming input the SDK throws it from `initializationResult()`.
 */
export function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && MISSING_SESSION.test(error.message);
}

/** The SDK's throw after an `is_error` result; the result message already said why. */
export function isErrorResultThrow(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Claude Code returned an error result");
}
