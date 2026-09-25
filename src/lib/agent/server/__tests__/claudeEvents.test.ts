// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../types";
import {
  classifyClaudeError,
  ClaudeEventMapper,
  formatResetTime,
  isErrorResultThrow,
  isExtraUsage,
  isMissingSessionError,
} from "../claudeEvents";

/**
 * A real Claude Agent SDK stream (haiku, one tool call, includePartialMessages),
 * recorded by the research spike as .scratch/agent/claude-sdk/log-turn1.json.
 * It was recorded with the MCP server named "nb"; the fixture renames it to
 * "node_banana" and replaces local paths, nothing else.
 */
const recorded = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "claude-turn.json"), "utf8"),
) as SDKMessage[];

const SESSION = "42aeca93-6672-48dd-897c-3b62f633dd55";

function mapAll(messages: unknown[], expectedTools = ["add_numbers"]) {
  const mapper = new ClaudeEventMapper({ expectedTools });
  const events = messages.flatMap((message) => mapper.map(message as SDKMessage));
  return { mapper, events };
}

function init(overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "init",
    session_id: "s-1",
    uuid: "u-init",
    cwd: "/Users/user/.node-banana/agent",
    tools: ["mcp__node_banana__add_numbers"],
    mcp_servers: [{ name: "node_banana", status: "connected" }],
    model: "claude-haiku",
    permissionMode: "dontAsk",
    apiKeySource: "none",
    claude_code_version: "2.1.282",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    ...overrides,
  };
}

function streamEvent(event: Record<string, unknown>, parent: string | null = null) {
  return { type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: "s-1" };
}

describe("ClaudeEventMapper on the recorded turn", () => {
  const { mapper, events } = mapAll(recorded);

  it("maps the stream to session → tool-pending → text → usage", () => {
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
  });

  it("reports the session from the init message", () => {
    expect(events[0]).toEqual({ type: "session", sessionId: SESSION });
    expect(mapper.sessionId).toBe(SESSION);
  });

  it("names our tool without the MCP prefix", () => {
    expect(events[1]).toEqual({ type: "tool-pending", toolName: "add_numbers" });
  });

  it("streams the answer under one id per content block and closes it", () => {
    const text = events.filter((event): event is Extract<HarnessEvent, { type: "text-delta" }> => event.type === "text-delta");
    expect(text.map((event) => event.delta).join("")).toBe("2 + 3 = **5**");
    const ids = new Set(text.map((event) => event.id));
    expect(ids).toEqual(new Set(["msg_011CfQX6yLQceWjz75x7oEVL:1"]));
    expect(events[7]).toEqual({ type: "text-end", id: "msg_011CfQX6yLQceWjz75x7oEVL:1" });
  });

  it("skips empty thinking blocks (thinking text off in that recording)", () => {
    expect(events.some((event) => event.type.startsWith("reasoning"))).toBe(false);
  });

  it("does not repeat streamed text from the complete assistant messages", () => {
    expect(events.filter((event) => event.type === "text-end")).toHaveLength(1);
  });

  it("reports usage including cached input", () => {
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 2601, outputTokens: 194 });
  });

  it("ends clean", () => {
    expect(mapper).toMatchObject({ resultSeen: true, fatal: false, errorReported: false, sessionMissing: false });
  });
});

describe("ClaudeEventMapper", () => {
  it("streams summarized thinking as reasoning", () => {
    const { events } = mapAll([
      streamEvent({ type: "message_start", message: { id: "m1" } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan: " } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "add nodes." } }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ]);
    expect(events).toEqual([
      { type: "reasoning-delta", id: "m1:0", delta: "Plan: " },
      { type: "reasoning-delta", id: "m1:0", delta: "add nodes." },
      { type: "reasoning-end", id: "m1:0" },
    ]);
  });

  it("ignores sub-agent messages", () => {
    const { events } = mapAll([
      streamEvent({ type: "message_start", message: { id: "m1" } }, "toolu_parent"),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "toolu_parent"),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hidden" } }, "toolu_parent"),
      {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        uuid: "u",
        session_id: "s-1",
        message: { id: "m-sub", content: [{ type: "text", text: "hidden" }] },
      },
    ]);
    expect(events).toEqual([]);
  });

  it("ignores tool_use blocks for tools that aren't ours", () => {
    const { events } = mapAll([
      streamEvent({ type: "message_start", message: { id: "m1" } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } }),
    ]);
    expect(events).toEqual([]);
  });

  it("emits assistant text that never streamed", () => {
    const { events } = mapAll([
      {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "u",
        session_id: "s-1",
        message: { id: "m-whole", content: [{ type: "text", text: "Done." }] },
      },
    ]);
    expect(events).toEqual([
      { type: "text-delta", id: "m-whole:text", delta: "Done." },
      { type: "text-end", id: "m-whole:text" },
    ]);
  });

  it("stops the turn when our tools didn't load (e.g. the z.record bug)", () => {
    const { mapper, events } = mapAll([init({ tools: [] })], ["get_workflow", "edit_workflow"]);
    expect(mapper.fatal).toBe(true);
    expect(events).toEqual([
      { type: "session", sessionId: "s-1" },
      expect.objectContaining({ type: "error", code: "harness_error" }),
    ]);
    expect((events[1] as { message: string }).message).toMatch(/get_workflow, edit_workflow/);
  });

  it("stops the turn when Claude Code reports an API key source at init", () => {
    const { mapper, events } = mapAll([init({ apiKeySource: "ANTHROPIC_API_KEY" })]);
    expect(mapper.fatal).toBe(true);
    expect(events[1]).toMatchObject({ type: "error", code: "wrong_billing" });
  });

  it("maps the signed-out sequence to one not_signed_in error", () => {
    // Shape verified live with an empty CLAUDE_CONFIG_DIR (reports/claude-sdk.md §2).
    const { mapper, events } = mapAll([
      init(),
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "authentication_failed",
        uuid: "u",
        session_id: "s-1",
        message: { id: "synthetic", model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        terminal_reason: "api_error",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "s-1",
        uuid: "u-result",
      },
    ]);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toEqual([{ type: "error", code: "not_signed_in", message: expect.stringMatching(/isn't signed in/) }]);
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(mapper.errorReported).toBe(true);
  });

  it("flags a missing session instead of reporting an error", () => {
    // Recorded live: resume with an unknown id → a zeroed result before any init.
    const { mapper, events } = mapAll([
      {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 0,
        is_error: true,
        num_turns: 0,
        errors: ["No conversation found with session ID: 3b1f0c7e-0000-4000-8000-000000000000"],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "3b1f0c7e-0000-4000-8000-000000000000",
        uuid: "u",
      },
    ]);
    expect(events).toEqual([]);
    expect(mapper.sessionMissing).toBe(true);
    expect(mapper.errorReported).toBe(false);
  });

  it("maps usage-limit results", () => {
    const { events } = mapAll([
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        uuid: "u",
        session_id: "s-1",
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your limit · resets 5pm",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "s-1",
        uuid: "u",
      },
    ]);
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: "You've hit your limit · resets 5pm" }]);
  });

  it("maps the step limit and other execution errors", () => {
    const maxTurns = mapAll([
      { type: "result", subtype: "error_max_turns", is_error: true, errors: [], usage: {}, session_id: "s", uuid: "u" },
    ]);
    expect(maxTurns.events).toEqual([{ type: "error", code: "harness_error", message: expect.stringMatching(/step limit/) }]);

    const execution = mapAll([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["socket hang up"],
        usage: {},
        session_id: "s",
        uuid: "u",
      },
    ]);
    expect(execution.events).toEqual([{ type: "error", code: "harness_error", message: "Claude Code: socket hang up" }]);
  });

  it("reports one error even when the assistant and the result both carry it", () => {
    const { events } = mapAll([
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "rate_limit",
        uuid: "u",
        session_id: "s-1",
        message: { id: "x", content: [{ type: "text", text: "Rate limited" }] },
      },
      { type: "result", subtype: "success", is_error: true, result: "Rate limited", usage: {}, session_id: "s-1", uuid: "u" },
    ]);
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: "Rate limited" }]);
  });
});

describe("ClaudeEventMapper and extra usage", () => {
  const rateLimit = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: SESSION });

  it("stops the turn when Claude Code starts serving it from extra usage", () => {
    const messages = recorded.map((message, index) =>
      index === 4
        ? rateLimit({ status: "rejected", overageStatus: "allowed", isUsingOverage: true, rateLimitType: "five_hour", resetsAt: 1790368200 })
        : message,
    );
    const mapper = new ClaudeEventMapper({ expectedTools: ["add_numbers"] });
    const events: HarnessEvent[] = [];
    for (const message of messages) {
      events.push(...mapper.map(message as SDKMessage));
      if (mapper.fatal) break;
    }
    expect(events.find((event) => event.type === "error")).toEqual({
      type: "error",
      code: "usage_limit",
      message: expect.stringMatching(/extra usage \(billed at API rates\).*Try again after/),
    });
    expect(mapper.fatal).toBe(true);
    expect(mapper.limit).toMatchObject({ resetsAt: 1790368200, rateLimitType: "five_hour" });
    // Nothing of the turn after the switch is passed on.
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
  });

  it.each([
    ["overage in use while the plan says allowed", { status: "allowed", overageInUse: true }],
    ["the overage limit itself", { status: "allowed_warning", rateLimitType: "overage" }],
    ["a rejection extra usage will serve", { status: "rejected", overageStatus: "allowed_warning" }],
  ])("treats %s as extra usage", (_label, info) => {
    const { mapper, events } = mapAll([rateLimit(info)]);
    expect(mapper.fatal).toBe(true);
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: expect.stringMatching(/extra usage/) }]);
  });

  it("leaves included usage alone (the recorded events: overage off, plan allowed)", () => {
    const events = recorded.filter(
      (message): message is Extract<SDKMessage, { type: "rate_limit_event" }> => message.type === "rate_limit_event",
    );
    expect(events).toHaveLength(2);
    for (const event of events) expect(isExtraUsage(event.rate_limit_info)).toBe(false);
    expect(mapAll(recorded).mapper.fatal).toBe(false);
  });

  it("leaves a hard rejection (no extra usage) to the error that follows", () => {
    const { mapper, events } = mapAll([rateLimit({ status: "rejected", overageStatus: "rejected", overageDisabledReason: "org_level_disabled" })]);
    expect(mapper.fatal).toBe(false);
    expect(events).toEqual([]);
  });

  it("formats reset times for the message", () => {
    const now = Date.UTC(2026, 8, 26, 12, 0);
    expect(formatResetTime(now / 1000 + 3600, now)).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
    expect(formatResetTime(now / 1000 + 3 * 86400, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2}/);
  });
});

describe("classifyClaudeError", () => {
  it("names the terminal command when the sign-in is gone", () => {
    expect(classifyClaudeError("OAuth token revoked · Please run /login").message).toMatch(/`claude auth login`/);
  });

  it.each([
    ["Not logged in · Please run /login", undefined, "not_signed_in"],
    ["anything", "authentication_failed", "not_signed_in"],
    ["anything", "oauth_org_not_allowed", "not_signed_in"],
    ["You've reached your weekly limit", undefined, "usage_limit"],
    ["This service is disabled for your org", undefined, "usage_limit"],
    ["Overloaded", "billing_error", "usage_limit"],
    ["model not found", "model_not_found", "harness_error"],
    ["", undefined, "harness_error"],
  ])("%j (%s) → %s", (text, assistantError, code) => {
    expect(classifyClaudeError(text, assistantError).code).toBe(code);
  });
});

describe("thrown SDK errors", () => {
  it("recognises the missing-session and error-result throws", () => {
    const missing = new Error("Claude Code returned an error result: No conversation found with session ID: abc");
    expect(isMissingSessionError(missing)).toBe(true);
    expect(isErrorResultThrow(missing)).toBe(true);
    expect(isMissingSessionError(new Error("boom"))).toBe(false);
    expect(isErrorResultThrow("Claude Code returned an error result")).toBe(false);
  });
});
