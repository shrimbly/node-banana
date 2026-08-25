import { NextRequest, NextResponse } from "next/server";
import { POST as runGeneration } from "../route";
import { startServerGenerationRun } from "../runRegistry";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // Matches /api/generate; the run itself outlives this request.

const RUN_ID_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const runId = body.clientRunId;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return NextResponse.json({ success: false, error: "Valid clientRunId is required" }, { status: 400 });
  }

  const generateUrl = new URL("/api/generate", request.url);
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of [
    "X-Gemini-API-Key",
    "X-Replicate-API-Key",
    "X-Fal-API-Key",
    "X-Kie-Key",
    "X-WaveSpeed-Key",
    "X-OpenAI-API-Key",
    "X-Anthropic-API-Key",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Invoke the generate handler in-process rather than over loopback HTTP.
  // A self-fetch is capped by the runtime's 5-minute headers timeout, which
  // killed video generations that legitimately run longer than that.
  const state = startServerGenerationRun(runId, () =>
    runGeneration(
      new NextRequest(generateUrl, {
        method: "POST",
        headers,
        body: bodyText,
      })
    )
  );

  return NextResponse.json({ success: true, runId, state }, { status: 202 });
}
