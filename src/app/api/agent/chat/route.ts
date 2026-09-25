/**
 * The agent's chat endpoint: one POST per user message, answered with an AI
 * SDK UI message stream (SSE) that `useChat` reads.
 *
 * Everything about the turn itself (readiness, one turn per chat and a few in
 * all, the model, tool parts, graph ops) lives in `createAgentChatStream`; this
 * handler only guards the door and reads the body, refusing one over
 * AGENT_CHAT_MAX_BODY_BYTES before it is buffered. Failures before the stream starts are answered as
 * plain text, because `DefaultChatTransport` shows a failed response's body
 * verbatim as the chat's error message.
 *
 * `request.signal` fires when the browser stops the chat or goes away; it is
 * handed to the harness, which kills the CLI turn.
 */

import { NextRequest } from "next/server";
import { createUIMessageStreamResponse } from "ai";

import { createAgentChatStream, parseAgentChatRequest } from "@/lib/agent/server/chatStream";
import { getHarness } from "@/lib/agent/server/harnesses";
import { checkSameOrigin } from "@/lib/agent/server/sameOrigin";
import type { AgentHarness } from "@/lib/agent/types";
import { logger } from "@/utils/logger";
import { AGENT_CHAT_MAX_BODY_BYTES, AGENT_HARNESS_LABELS, formatByteLimit, readJsonBody } from "../shared";

export const runtime = "nodejs";
export const maxDuration = 600; // 10 minutes: a long agent turn with many tool calls
export const dynamic = "force-dynamic";

function plainText(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  const origin = checkSameOrigin(request);
  if (!origin.ok) {
    logger.warn("api.llm", "Agent chat request blocked", { reason: origin.reason });
    return plainText(origin.reason, 403);
  }

  const read = await readJsonBody(request, AGENT_CHAT_MAX_BODY_BYTES);
  if (!read.ok) {
    if (read.problem === "not_json") return plainText("Invalid agent request: the body is not JSON.", 400);
    logger.warn("api.llm", "Agent chat request rejected: body too large", {
      contentLength: request.headers.get("content-length"),
    });
    return plainText(
      `Invalid agent request: the body is over the ${formatByteLimit(AGENT_CHAT_MAX_BODY_BYTES)} limit. ` +
        "Start a new chat to continue.",
      413
    );
  }

  const parsed = parseAgentChatRequest(read.value);
  if (!parsed.ok) {
    logger.warn("api.llm", "Agent chat request rejected", { reason: parsed.message });
    return plainText(parsed.message, 400);
  }

  let harness: AgentHarness;
  try {
    harness = getHarness(parsed.body.harness);
  } catch (error) {
    logger.error(
      "api.error",
      "Agent harness unavailable",
      { harness: parsed.body.harness },
      error instanceof Error ? error : undefined
    );
    const reason = error instanceof Error ? error.message : String(error);
    return plainText(`${AGENT_HARNESS_LABELS[parsed.body.harness]} is not available: ${reason}`, 500);
  }

  const stream = createAgentChatStream({ body: parsed.body, harness, signal: request.signal });
  return createUIMessageStreamResponse({ stream });
}
