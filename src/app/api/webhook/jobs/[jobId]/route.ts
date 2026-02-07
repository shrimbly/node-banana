import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/executor/jobStore";

export const dynamic = "force-dynamic";

/**
 * GET /api/webhook/jobs/[jobId]
 *
 * Check the status of an async webhook job.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json(
      { success: false, error: "Job not found or expired" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    status: job.status,
    ...(job.result && { outputs: job.result }),
    ...(job.error && { error: job.error }),
    createdAt: job.createdAt,
    ...(job.completedAt && { completedAt: job.completedAt }),
  });
}
