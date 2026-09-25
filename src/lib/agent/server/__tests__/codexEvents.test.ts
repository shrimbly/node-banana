// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../types";
import { classifyCodexError, CodexTurnMapper } from "../codexEvents";
import { loadRecordedCodexTurn } from "./fakeAppServer";

const recordedCodexTurn = loadRecordedCodexTurn();

const THREAD = "01a0d9b3-5b28-7ed1-a978-8c9292102095";
const TURN = "01a0d9b3-5b68-75a0-a565-db58898287e0";
const MESSAGE = "msg_060584e5b42dbe2b016ab6b51ae4b887d0b904e3935d6fa13c";

function mapAll(notifications: Array<{ method: string; params?: unknown }>, turnId: string | undefined = TURN) {
  const mapper = new CodexTurnMapper(THREAD);
  mapper.turnId = turnId;
  const events: HarnessEvent[] = [];
  for (const notification of notifications) {
    events.push(...mapper.map(notification));
    if (mapper.done) break;
  }
  return { mapper, events };
}

describe("CodexTurnMapper on the recorded turn", () => {
  const { mapper, events } = mapAll(recordedCodexTurn);

  it("maps to tool-pending → streamed text → text-end → usage", () => {
    expect(events).toEqual([
      { type: "tool-pending", toolName: "add_numbers" },
      { type: "text-delta", id: MESSAGE, delta: "5" },
      { type: "text-delta", id: MESSAGE, delta: "," },
      { type: "text-delta", id: MESSAGE, delta: " banana" },
      { type: "text-end", id: MESSAGE },
      // Sum of the two requests' `last` usage in the turn (1571+1627 in, 32+7 out).
      { type: "usage", inputTokens: 3198, outputTokens: 39 },
    ]);
  });

  it("finishes on turn/completed", () => {
    expect(mapper).toMatchObject({ done: true, status: "completed", errorReported: false });
  });

  it("adopts the turn id from turn/started when it isn't known yet", () => {
    const { mapper: adopting, events: adopted } = mapAll(recordedCodexTurn, undefined);
    expect(adopting.turnId).toBe(TURN);
    expect(adopted).toEqual(events);
  });
});

describe("CodexTurnMapper", () => {
  it("ignores other threads and other (stale) turns on the same thread", () => {
    const { events } = mapAll([
      { method: "item/agentMessage/delta", params: { threadId: "other", turnId: TURN, itemId: "m", delta: "x" } },
      { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "old-turn", itemId: "m", delta: "x" } },
      { method: "turn/completed", params: { threadId: THREAD, turn: { id: "old-turn", status: "interrupted" } } },
      { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, itemId: "m", delta: "ok" } },
    ]);
    expect(events).toEqual([{ type: "text-delta", id: "m", delta: "ok" }]);
  });

  it("streams reasoning summaries, separating summary parts", () => {
    const at = { threadId: THREAD, turnId: TURN };
    const { events } = mapAll([
      { method: "item/started", params: { ...at, item: { type: "reasoning", id: "rs_1", summary: [], content: [] } } },
      { method: "item/reasoning/summaryTextDelta", params: { ...at, itemId: "rs_1", delta: "Adding a prompt", summaryIndex: 0 } },
      { method: "item/reasoning/summaryPartAdded", params: { ...at, itemId: "rs_1", summaryIndex: 1 } },
      { method: "item/reasoning/summaryTextDelta", params: { ...at, itemId: "rs_1", delta: "Then connect", summaryIndex: 1 } },
      { method: "item/completed", params: { ...at, item: { type: "reasoning", id: "rs_1", summary: ["Adding a prompt", "Then connect"] } } },
    ]);
    expect(events).toEqual([
      { type: "reasoning-delta", id: "rs_1", delta: "Adding a prompt" },
      { type: "reasoning-delta", id: "rs_1", delta: "\n\nThen connect" },
      { type: "reasoning-end", id: "rs_1" },
    ]);
  });

  it("skips empty reasoning items (the recorded low-effort turn had one)", () => {
    const at = { threadId: THREAD, turnId: TURN };
    const { events } = mapAll([
      { method: "item/completed", params: { ...at, item: { type: "reasoning", id: "rs_2", summary: [], content: [] } } },
    ]);
    expect(events).toEqual([]);
  });

  it("emits a whole agent message that never streamed", () => {
    const { events } = mapAll([
      { method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "agentMessage", id: "m9", text: "Done." } } },
    ]);
    expect(events).toEqual([
      { type: "text-delta", id: "m9", delta: "Done." },
      { type: "text-end", id: "m9" },
    ]);
  });

  it("ignores tool calls from other namespaces", () => {
    const { events } = mapAll([
      {
        method: "item/started",
        params: { threadId: THREAD, turnId: TURN, item: { type: "dynamicToolCall", id: "c", namespace: "other", tool: "x" } },
      },
    ]);
    expect(events).toEqual([]);
  });

  it("treats retrying errors as transient and reports the final one once", () => {
    const at = { threadId: THREAD, turnId: TURN };
    const { events, mapper } = mapAll([
      { method: "error", params: { ...at, willRetry: true, error: { message: "Reconnecting... 1/5", codexErrorInfo: null } } },
      { method: "error", params: { ...at, willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } },
      {
        method: "turn/completed",
        params: { threadId: THREAD, turn: { id: TURN, status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } },
      },
    ]);
    expect(events).toEqual([{ type: "error", code: "usage_limit", message: "You've hit your usage limit." }]);
    expect(mapper).toMatchObject({ done: true, status: "failed" });
  });

  it("reports a failed turn without a preceding error notification", () => {
    const { events } = mapAll([
      { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed", error: { message: "boom", codexErrorInfo: "other" } } } },
    ]);
    expect(events).toEqual([{ type: "error", code: "harness_error", message: "Codex: boom" }]);
  });

  it("closes open text on an interrupted turn, without an error", () => {
    const at = { threadId: THREAD, turnId: TURN };
    const { events } = mapAll([
      { method: "item/agentMessage/delta", params: { ...at, itemId: "m", delta: "Work" } },
      { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "interrupted", error: null } } },
    ]);
    expect(events).toEqual([
      { type: "text-delta", id: "m", delta: "Work" },
      { type: "text-end", id: "m" },
    ]);
  });
});

describe("classifyCodexError", () => {
  it.each([
    ["usageLimitExceeded", "usage_limit"],
    ["rateLimitExceeded", "usage_limit"],
    ["sessionBudgetExceeded", "usage_limit"],
    ["unauthorized", "not_signed_in"],
    ["contextWindowExceeded", "harness_error"],
    ["internalServerError", "harness_error"],
    [{ httpConnectionFailed: { httpStatusCode: 502 } }, "harness_error"],
    [null, "harness_error"],
  ])("%j → %s", (codexErrorInfo, code) => {
    expect(classifyCodexError({ message: "x", codexErrorInfo }).code).toBe(code);
  });
});

describe("CodexTurnMapper.awaitingModel", () => {
  const at = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: THREAD, turnId: TURN, ...params } });

  it("is set after a reasoning item or a tool call, and cleared once the model starts anything", () => {
    const mapper = new CodexTurnMapper(THREAD);
    mapper.turnId = TURN;
    mapper.map(at("item/completed", { item: { type: "reasoning", id: "r1", summary: ["Plan"] } }));
    expect(mapper.awaitingModel).toBe(true);
    mapper.map(at("item/started", { item: { type: "dynamicToolCall", id: "c1", namespace: "node_banana", tool: "get_workflow" } }));
    expect(mapper.awaitingModel).toBe(false);
    mapper.map(at("item/completed", { item: { type: "dynamicToolCall", id: "c1", namespace: "node_banana", tool: "get_workflow" } }));
    expect(mapper.awaitingModel).toBe(true);
    mapper.map(at("item/started", { item: { type: "agentMessage", id: "m1", text: "" } }));
    expect(mapper.awaitingModel).toBe(false);
  });

  it("stays clear on the recorded turn once the reply streams", () => {
    expect(mapAll(recordedCodexTurn).mapper.awaitingModel).toBe(false);
  });
});

describe("Codex sign-in errors", () => {
  it("name the terminal command", () => {
    expect(classifyCodexError({ codexErrorInfo: "unauthorized" }).message).toMatch(/`codex login`/);
  });
});
