import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import type { WebhookRequest, WebhookOutput } from "@/types/webhook";
import type { WebhookTriggerNodeData } from "@/types";
import type { WorkflowNode } from "@/types";
import type { WorkflowEdge } from "@/types/workflow";
import {
  executeWorkflowHeadless,
  downloadImageToBase64,
} from "@/lib/executor/headlessExecutor";
import { createJobId, createJob, completeJob, failJob, getJob } from "@/lib/executor/jobStore";

export const maxDuration = 300; // 5 minutes
export const dynamic = "force-dynamic";

const MAX_IMAGES = 10;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

interface WorkflowFile {
  version: number;
  id?: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * POST /api/webhook/[workflowId]
 *
 * Execute a workflow via webhook. The workflowId is the workflow filename (without .json).
 *
 * Request body: WebhookRequest
 * - images: array of URLs or base64 strings (max 10)
 * - text: prompt text
 * - workflowDir: directory where the workflow JSON is saved
 * - callbackUrl: (optional) for async execution
 * - apiKeys: (optional) provider API key overrides
 *
 * Response: WebhookSyncResponse or WebhookAsyncResponse
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const startTime = Date.now();
  const { workflowId } = await params;

  let body: WebhookRequest & { workflowDir?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // --- Validate request ---
  if (body.images && body.images.length > MAX_IMAGES) {
    return NextResponse.json(
      { success: false, error: `Maximum ${MAX_IMAGES} images allowed` },
      { status: 400 }
    );
  }

  // --- Locate workflow file ---
  const workflowDir =
    body.workflowDir || process.env.WEBHOOK_WORKFLOWS_DIR || process.cwd();
  const workflowPath = path.join(workflowDir, `${workflowId}.json`);

  let workflowFile: WorkflowFile;
  try {
    const raw = await fs.readFile(workflowPath, "utf-8");
    workflowFile = JSON.parse(raw);
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: `Workflow "${workflowId}" not found at ${workflowPath}. Set workflowDir in request body or WEBHOOK_WORKFLOWS_DIR env var.`,
      },
      { status: 404 }
    );
  }

  // --- Find WebhookTrigger node ---
  const triggerNode = workflowFile.nodes.find(
    (n) => n.type === "webhookTrigger"
  );

  if (!triggerNode) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Workflow has no Webhook Trigger node. Add a webhookTrigger node to your workflow.",
      },
      { status: 400 }
    );
  }

  // --- Validate webhook secret ---
  const triggerData = triggerNode.data as WebhookTriggerNodeData;
  if (triggerData.webhookSecret) {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token !== triggerData.webhookSecret) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: invalid or missing Bearer token" },
        { status: 401 }
      );
    }
  }

  // --- Pre-download all images in parallel ---
  let resolvedImages: (string | null)[] = [];
  if (body.images && body.images.length > 0) {
    const downloadPromises = body.images.map(async (img, i) => {
      if (!img) return null;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          IMAGE_DOWNLOAD_TIMEOUT_MS
        );
        const result = await downloadImageToBase64(img);
        clearTimeout(timeout);
        return result;
      } catch (err) {
        throw new Error(
          `Failed to download image[${i}] (${img.substring(0, 80)}...): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    try {
      resolvedImages = await Promise.all(downloadPromises);
    } catch (err) {
      return NextResponse.json(
        {
          success: false,
          error: err instanceof Error ? err.message : "Image download failed",
        },
        { status: 400 }
      );
    }
  }

  // --- Inject data into the trigger node ---
  const injectedNodes = workflowFile.nodes.map((node) => {
    if (node.id !== triggerNode.id) return node;
    return {
      ...node,
      data: {
        ...node.data,
        images: resolvedImages,
        text: body.text || null,
      },
    } as WorkflowNode;
  });

  // --- Build API keys from request + env ---
  const apiKeys: Record<string, string> = {
    ...(process.env.GEMINI_API_KEY ? { gemini: process.env.GEMINI_API_KEY } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.KIE_API_KEY ? { kie: process.env.KIE_API_KEY } : {}),
    ...(process.env.REPLICATE_API_TOKEN ? { replicate: process.env.REPLICATE_API_TOKEN } : {}),
    ...(process.env.FAL_KEY ? { fal: process.env.FAL_KEY } : {}),
    ...(process.env.WAVESPEED_API_KEY ? { wavespeed: process.env.WAVESPEED_API_KEY } : {}),
    ...body.apiKeys,
  };

  // --- Determine base URL for internal API calls ---
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  const baseUrl = `${proto}://${host}`;

  // --- Async mode ---
  if (body.callbackUrl) {
    const jobId = createJobId();
    createJob(jobId, body.callbackUrl);

    // Fire and forget - execute in background
    executeInBackground(
      injectedNodes,
      workflowFile.edges,
      apiKeys,
      baseUrl,
      jobId,
      body.callbackUrl,
      body.recordId
    );

    return NextResponse.json({
      success: true,
      jobId,
      status: "processing",
    });
  }

  // --- Sync mode ---
  try {
    const outputs = await executeWorkflowHeadless({
      nodes: injectedNodes,
      edges: workflowFile.edges,
      apiKeys,
      baseUrl,
    });

    return NextResponse.json({
      success: true,
      outputs,
      executionTime: Date.now() - startTime,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Execution failed",
        executionTime: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}

/**
 * Background execution for async mode.
 * Runs the workflow and sends results to the callback URL.
 */
async function executeInBackground(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  apiKeys: Record<string, string>,
  baseUrl: string,
  jobId: string,
  callbackUrl: string,
  recordId?: string
): Promise<void> {
  try {
    const outputs = await executeWorkflowHeadless({
      nodes,
      edges,
      apiKeys,
      baseUrl,
    });

    completeJob(jobId, outputs);

    // Extract media URL for the callback (skip base64 - too large for Airtable)
    const firstImage = outputs.find((o) => o.type === "image");
    const firstVideo = outputs.find((o) => o.type === "video");
    const mediaUrl: string | null = firstImage?.url || firstVideo?.url || null;

    // Send results to callback URL
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        jobId,
        ...(recordId && { recordId }),
        ...(mediaUrl && { imageUrl: mediaUrl }),
      }),
    }).catch(() => {});
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Execution failed";
    failJob(jobId, errorMsg);

    // Send error to callback URL
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        jobId,
        ...(recordId && { recordId }),
        error: errorMsg,
      }),
    }).catch(() => {});
  }
}
