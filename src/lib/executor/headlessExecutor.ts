/**
 * Headless Workflow Executor
 *
 * Server-side execution engine that runs workflows without a browser.
 * Reuses the same topological sort and data routing as the client,
 * and calls the existing API routes (/api/generate, /api/llm) via fetch.
 */

import type {
  WorkflowNode,
  WorkflowNodeData,
  ImageInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  PromptConstructorNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  LLMGenerateNodeData,
  OutputNodeData,
  WebhookTriggerNodeData,
  WebhookResponseNodeData,
} from "@/types";
import type { WorkflowEdge } from "@/types/workflow";
import type { WebhookOutput } from "@/types/webhook";
import { groupNodesByLevel, chunk, getConnectedInputsPure } from "./graphUtils";

const MAX_CONCURRENT = 3;

/**
 * Context for headless execution
 */
export interface ExecutionContext {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  apiKeys: Record<string, string>;
  baseUrl: string; // e.g., "http://localhost:3000"
  signal?: AbortSignal;
}

/**
 * In-memory node state manager for headless execution.
 * Tracks data updates without needing Zustand.
 */
class NodeStateManager {
  private overrides = new Map<string, Record<string, unknown>>();
  private nodes: WorkflowNode[];

  constructor(nodes: WorkflowNode[]) {
    this.nodes = nodes;
  }

  update(nodeId: string, data: Record<string, unknown>): void {
    const existing = this.overrides.get(nodeId) || {};
    this.overrides.set(nodeId, { ...existing, ...data });
  }

  /**
   * Get a node with its current data (original + overrides merged)
   */
  getNode(nodeId: string): WorkflowNode | undefined {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;

    const override = this.overrides.get(nodeId);
    if (!override) return node;

    return {
      ...node,
      data: { ...node.data, ...override } as WorkflowNodeData,
    };
  }

  /**
   * Get all nodes with current data
   */
  getAllNodes(): WorkflowNode[] {
    return this.nodes.map((node) => {
      const override = this.overrides.get(node.id);
      if (!override) return node;
      return {
        ...node,
        data: { ...node.data, ...override } as WorkflowNodeData,
      };
    });
  }
}

/**
 * Execute a workflow headlessly on the server.
 * Returns outputs captured from webhookResponse and output nodes.
 */
export async function executeWorkflowHeadless(
  ctx: ExecutionContext
): Promise<WebhookOutput[]> {
  const state = new NodeStateManager(ctx.nodes);
  const outputs: WebhookOutput[] = [];

  // Topological sort
  const levels = groupNodesByLevel(ctx.nodes, ctx.edges);

  // Execute level by level
  for (const level of levels) {
    const nodeChunks = chunk(level.nodeIds, MAX_CONCURRENT);

    for (const nodeIds of nodeChunks) {
      const results = await Promise.allSettled(
        nodeIds.map((nodeId) =>
          executeSingleNode(nodeId, state, ctx, outputs)
        )
      );

      // Check for failures
      for (const result of results) {
        if (result.status === "rejected") {
          throw new Error(
            `Node execution failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          );
        }
      }
    }
  }

  return outputs;
}

/**
 * Execute a single node based on its type
 */
async function executeSingleNode(
  nodeId: string,
  state: NodeStateManager,
  ctx: ExecutionContext,
  outputs: WebhookOutput[]
): Promise<void> {
  const node = state.getNode(nodeId);
  if (!node) return;

  if (ctx.signal?.aborted) {
    throw new Error("Execution aborted");
  }

  switch (node.type) {
    case "imageInput":
    case "audioInput":
    case "webhookTrigger":
      // Data sources - already populated
      break;

    case "annotation": {
      // Pass through image (no canvas drawing in headless mode)
      const { images } = getConnectedInputsPure(nodeId, state.getAllNodes(), ctx.edges);
      if (images[0]) {
        state.update(nodeId, { sourceImage: images[0], outputImage: images[0] });
      }
      break;
    }

    case "prompt": {
      const { text } = getConnectedInputsPure(nodeId, state.getAllNodes(), ctx.edges);
      if (text !== null) {
        state.update(nodeId, { prompt: text });
      }
      break;
    }

    case "promptConstructor": {
      const nodeData = node.data as PromptConstructorNodeData;
      const template = nodeData.template;

      // Find connected prompt nodes
      const connectedPromptNodes = ctx.edges
        .filter((e) => e.target === nodeId && e.targetHandle === "text")
        .map((e) => state.getNode(e.source))
        .filter((n): n is WorkflowNode => n !== undefined && n.type === "prompt");

      const variableMap: Record<string, string> = {};
      connectedPromptNodes.forEach((promptNode) => {
        const promptData = promptNode.data as PromptNodeData;
        if (promptData.variableName) {
          variableMap[promptData.variableName] = promptData.prompt;
        }
      });

      const varPattern = /@(\w+)/g;
      const unresolvedVars: string[] = [];
      let resolvedText = template;

      const matches = template.matchAll(varPattern);
      for (const match of matches) {
        const varName = match[1];
        if (variableMap[varName] !== undefined) {
          resolvedText = resolvedText.replaceAll(`@${varName}`, variableMap[varName]);
        } else if (!unresolvedVars.includes(varName)) {
          unresolvedVars.push(varName);
        }
      }

      state.update(nodeId, { outputText: resolvedText, unresolvedVars });
      break;
    }

    case "nanoBanana": {
      const { images, text, dynamicInputs } = getConnectedInputsPure(
        nodeId, state.getAllNodes(), ctx.edges
      );

      const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
        ? dynamicInputs.prompt[0]
        : dynamicInputs.prompt;
      const promptText = text || promptFromDynamic || null;

      if (!promptText) {
        throw new Error(`nanoBanana node ${nodeId}: Missing text input`);
      }

      const nodeData = node.data as NanoBananaNodeData;

      const headers = buildProviderHeaders(nodeData.selectedModel?.provider || "gemini", ctx.apiKeys);

      const response = await fetch(`${ctx.baseUrl}/api/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          images,
          prompt: promptText,
          aspectRatio: nodeData.aspectRatio,
          resolution: nodeData.resolution,
          model: nodeData.model,
          useGoogleSearch: nodeData.useGoogleSearch,
          selectedModel: nodeData.selectedModel,
          parameters: nodeData.parameters,
          dynamicInputs,
        }),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Generate API failed (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const result = await response.json();
      if (result.success && result.image) {
        state.update(nodeId, {
          outputImage: result.image,
          ...(result.sourceUrl && { outputImageUrl: result.sourceUrl }),
          status: "complete",
        });
      } else {
        throw new Error(`Generation failed: ${result.error || "Unknown error"}`);
      }
      break;
    }

    case "generateVideo": {
      const { images, text, dynamicInputs } = getConnectedInputsPure(
        nodeId, state.getAllNodes(), ctx.edges
      );
      const nodeData = node.data as GenerateVideoNodeData;

      if (!nodeData.selectedModel?.modelId) {
        throw new Error(`generateVideo node ${nodeId}: No model selected`);
      }

      const headers = buildProviderHeaders(nodeData.selectedModel.provider, ctx.apiKeys);

      const response = await fetch(`${ctx.baseUrl}/api/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          images,
          prompt: text,
          selectedModel: nodeData.selectedModel,
          parameters: nodeData.parameters,
          dynamicInputs,
          mediaType: "video",
        }),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Generate Video API failed (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const result = await response.json();
      // /api/generate returns all media in result.image (even video).
      // result.video/result.videoUrl may also exist for large videos returned as URL.
      const videoData = result.video || result.videoUrl || result.image;
      if (result.success && videoData) {
        state.update(nodeId, {
          outputVideo: videoData,
          ...(result.sourceUrl && { outputVideoUrl: result.sourceUrl }),
          status: "complete",
        });
      } else {
        throw new Error(`Video generation failed: ${result.error || "Unknown error"}`);
      }
      break;
    }

    case "llmGenerate": {
      const inputs = getConnectedInputsPure(nodeId, state.getAllNodes(), ctx.edges);
      const llmData = node.data as LLMGenerateNodeData;
      const promptText = inputs.text ?? llmData.inputPrompt;

      if (!promptText) {
        throw new Error(`llmGenerate node ${nodeId}: Missing text input`);
      }

      const headers = buildLLMHeaders(llmData.provider, ctx.apiKeys);

      const response = await fetch(`${ctx.baseUrl}/api/llm`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: promptText,
          ...(inputs.images.length > 0 && { images: inputs.images }),
          provider: llmData.provider,
          model: llmData.model,
          temperature: llmData.temperature,
          maxTokens: llmData.maxTokens,
        }),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API failed (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const result = await response.json();
      if (result.success && result.text) {
        state.update(nodeId, { outputText: result.text, status: "complete" });
      } else {
        throw new Error(`LLM generation failed: ${result.error || "Unknown error"}`);
      }
      break;
    }

    case "output": {
      const { images, videos } = getConnectedInputsPure(
        nodeId, state.getAllNodes(), ctx.edges
      );
      if (videos.length > 0) {
        state.update(nodeId, { image: videos[0], video: videos[0], contentType: "video" });
        outputs.push({
          nodeId,
          type: "video",
          base64: videos[0].startsWith("data:") ? videos[0] : undefined,
          url: !videos[0].startsWith("data:") ? videos[0] : undefined,
        });
      } else if (images.length > 0) {
        state.update(nodeId, { image: images[0], contentType: "image" });
        outputs.push({
          nodeId,
          type: "image",
          base64: images[0],
        });
      }
      break;
    }

    case "webhookResponse": {
      const { images, videos, text } = getConnectedInputsPure(
        nodeId, state.getAllNodes(), ctx.edges
      );
      // Find upstream source URL from generate nodes connected to this response.
      // Video connections arrive with targetHandle "image" (not "video"), so we
      // check both outputImageUrl and outputVideoUrl on the source node.
      const findUpstreamMediaUrl = (): string | undefined => {
        const edge = ctx.edges.find(
          (e) => e.target === nodeId && (e.targetHandle === "image" || e.targetHandle === "video" || !e.targetHandle)
        );
        if (!edge) return undefined;
        const sourceNode = state.getNode(edge.source);
        const sourceData = sourceNode?.data as Record<string, unknown> | undefined;
        return (sourceData?.["outputImageUrl"] || sourceData?.["outputVideoUrl"]) as string | undefined;
      };

      const upstreamMediaUrl = findUpstreamMediaUrl();

      if (videos.length > 0) {
        state.update(nodeId, { image: videos[0], video: videos[0], contentType: "video" });
        const videoOutput = {
          nodeId,
          type: "video" as const,
          base64: videos[0].startsWith("data:") ? videos[0] : undefined,
          url: upstreamMediaUrl || (!videos[0].startsWith("data:") ? videos[0] : undefined),
        };
        outputs.push(videoOutput);
      } else if (images.length > 0) {
        state.update(nodeId, { image: images[0], contentType: "image" });
        // Prefer the provider's original URL over base64
        outputs.push({
          nodeId,
          type: "image",
          base64: images[0].startsWith("data:") ? images[0] : undefined,
          url: upstreamMediaUrl || (!images[0].startsWith("data:") ? images[0] : undefined),
        });
      }

      if (text) {
        state.update(nodeId, { text });
        // Only add text output if no image/video was captured
        if (videos.length === 0 && images.length === 0) {
          outputs.push({
            nodeId,
            type: "text",
            text,
          });
        }
      }
      break;
    }

    case "splitGrid":
    case "outputGallery":
    case "imageCompare":
    case "videoStitch":
    case "easeCurve":
      // These nodes are not supported in headless mode
      console.warn(`[HeadlessExecutor] Node type "${node.type}" is not supported in headless mode, skipping`);
      break;
  }
}

/**
 * Build headers with API key for generation providers
 */
function buildProviderHeaders(
  provider: string,
  apiKeys: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "gemini":
      if (apiKeys.gemini) headers["X-Gemini-API-Key"] = apiKeys.gemini;
      break;
    case "replicate":
      if (apiKeys.replicate) headers["X-Replicate-API-Key"] = apiKeys.replicate;
      break;
    case "fal":
      if (apiKeys.fal) headers["X-Fal-API-Key"] = apiKeys.fal;
      break;
    case "kie":
      if (apiKeys.kie) headers["X-Kie-Key"] = apiKeys.kie;
      break;
    case "wavespeed":
      if (apiKeys.wavespeed) headers["X-WaveSpeed-Key"] = apiKeys.wavespeed;
      break;
  }

  return headers;
}

/**
 * Build headers with API key for LLM providers
 */
function buildLLMHeaders(
  provider: string,
  apiKeys: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "google" && apiKeys.gemini) {
    headers["X-Gemini-API-Key"] = apiKeys.gemini;
  } else if (provider === "openai" && apiKeys.openai) {
    headers["X-OpenAI-API-Key"] = apiKeys.openai;
  }

  return headers;
}

/**
 * Download an image from a URL and convert to base64 data URL.
 * Returns null if download fails.
 */
export async function downloadImageToBase64(url: string): Promise<string> {
  // Already a data URL
  if (url.startsWith("data:")) return url;

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download image from ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:${contentType};base64,${base64}`;
}
