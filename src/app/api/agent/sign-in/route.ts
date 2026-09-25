/**
 * Start the vendor's own sign-in flow for a harness.
 *
 * `POST /api/agent/sign-in {harness, force?}` asks the official CLI to sign
 * in (Claude Code opens the vendor's page itself; Codex hands back a URL or
 * device code for the panel to show). Node Banana never sees the credentials;
 * the panel then polls `/api/agent/status` until the CLI reports a
 * subscription login. `force` (sent after a turn the vendor rejected) starts
 * the flow even though the CLI's local status still reads signed in.
 *
 * Every answer, errors included, is an `AgentSignInStart`, so the panel can
 * read `state` and `message` whatever the HTTP status.
 */

import { NextRequest, NextResponse } from "next/server";

import { getHarness } from "@/lib/agent/server/harnesses";
import { checkSameOrigin } from "@/lib/agent/server/sameOrigin";
import type { AgentSignInOptions, AgentSignInStart } from "@/lib/agent/types";
import { logger } from "@/utils/logger";
import {
  AGENT_HARNESS_LABELS,
  AGENT_SIGN_IN_MAX_BODY_BYTES,
  formatByteLimit,
  isAgentHarnessId,
  readJsonBody,
  unknownHarnessMessage,
} from "../shared";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function failed(message: string, status: number): NextResponse<AgentSignInStart> {
  return NextResponse.json<AgentSignInStart>({ state: "failed", message }, { status });
}

export async function POST(request: NextRequest) {
  const origin = checkSameOrigin(request);
  if (!origin.ok) {
    logger.warn("api.llm", "Agent sign-in request blocked", { reason: origin.reason });
    return failed(origin.reason, 403);
  }

  const read = await readJsonBody(request, AGENT_SIGN_IN_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.problem === "too_large"
      ? failed(`Invalid sign-in request: the body is over the ${formatByteLimit(AGENT_SIGN_IN_MAX_BODY_BYTES)} limit.`, 413)
      : failed("Invalid sign-in request: the body is not JSON.", 400);
  }
  const body = read.value;
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const harnessId = fields.harness;
  if (!isAgentHarnessId(harnessId)) {
    return failed(`Invalid sign-in request: ${unknownHarnessMessage(harnessId)}`, 400);
  }
  const force = fields.force;
  if (force !== undefined && typeof force !== "boolean") {
    return failed("Invalid sign-in request: force must be true or false.", 400);
  }
  const options: AgentSignInOptions = force ? { force: true } : {};

  try {
    const result = await getHarness(harnessId).startSignIn(options);
    logger.info("api.llm", "Agent sign-in started", { harness: harnessId, force: Boolean(force), state: result.state });
    return NextResponse.json<AgentSignInStart>(result);
  } catch (error) {
    logger.error(
      "api.error",
      "Agent sign-in failed to start",
      { harness: harnessId },
      error instanceof Error ? error : undefined
    );
    const reason = error instanceof Error ? error.message : String(error);
    return failed(`Could not start the ${AGENT_HARNESS_LABELS[harnessId]} sign-in: ${reason}`, 500);
  }
}
