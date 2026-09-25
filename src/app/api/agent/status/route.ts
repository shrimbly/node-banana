/**
 * Which agent harnesses can run here, and why not when they cannot.
 *
 * `GET /api/agent/status` reports both; `?harness=claude|codex` just one (the
 * panel polls that every couple of seconds while a sign-in is pending). A
 * harness whose own check fails is still reported, as not ready with the
 * reason, so the panel always has an entry to render.
 *
 * The account's email address is reported only to a request the server
 * vouched came over a loopback connection (see sameOrigin.ts); everyone else
 * sees the plan alone.
 *
 * Errors before any harness is asked answer `{ error }` with a 4xx status.
 */

import { NextRequest, NextResponse } from "next/server";

import { getHarness } from "@/lib/agent/server/harnesses";
import { checkSameOrigin, isVouchedLocal } from "@/lib/agent/server/sameOrigin";
import {
  AGENT_HARNESS_IDS,
  type AgentHarnessId,
  type AgentHarnessStatus,
  type AgentStatusResponse,
} from "@/lib/agent/types";
import { isAgentHarnessId, unavailableHarnessStatus, unknownHarnessMessage, withoutAccountEmail } from "../shared";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export interface AgentStatusErrorResponse {
  error: string;
}

export async function GET(request: NextRequest) {
  const origin = checkSameOrigin(request);
  if (!origin.ok) {
    return NextResponse.json<AgentStatusErrorResponse>({ error: origin.reason }, { status: 403 });
  }

  const requested = request.nextUrl.searchParams.get("harness");
  let ids: AgentHarnessId[];
  if (!requested) {
    ids = [...AGENT_HARNESS_IDS];
  } else if (isAgentHarnessId(requested)) {
    ids = [requested];
  } else {
    return NextResponse.json<AgentStatusErrorResponse>({ error: unknownHarnessMessage(requested) }, { status: 400 });
  }

  const statuses = await Promise.all(ids.map(readStatus));
  const harnesses = isVouchedLocal(request) ? statuses : statuses.map(withoutAccountEmail);
  return NextResponse.json<AgentStatusResponse>(
    { harnesses },
    // Sign-in state changes underneath this answer; never let anything cache it.
    { headers: { "Cache-Control": "no-store" } }
  );
}

async function readStatus(id: AgentHarnessId): Promise<AgentHarnessStatus> {
  try {
    return await getHarness(id).getStatus();
  } catch (error) {
    return unavailableHarnessStatus(id, error);
  }
}
