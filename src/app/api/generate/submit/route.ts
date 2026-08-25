import { NextRequest, NextResponse } from "next/server";
import { startServerGenerationRun } from "../runRegistry";

export const dynamic = "force-dynamic";

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

  const state = startServerGenerationRun(runId, () =>
    fetch(generateUrl, {
      method: "POST",
      headers,
      body: bodyText,
    })
  );

  return NextResponse.json({ success: true, runId, state }, { status: 202 });
}
