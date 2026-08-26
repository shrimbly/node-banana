import { NextRequest, NextResponse } from "next/server";
import { deleteServerGenerationRun, getServerGenerationRun } from "../runRegistry";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ state: "failed", error: "runId is required" }, { status: 400 });
  }

  const run = getServerGenerationRun(runId);
  if (!run) {
    return NextResponse.json(
      { state: "failed", error: "Generation run is no longer available" },
      { status: 404 }
    );
  }

  return NextResponse.json(run);
}

export async function DELETE(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ success: false, error: "runId is required" }, { status: 400 });
  }
  deleteServerGenerationRun(runId);
  return NextResponse.json({ success: true });
}
