/**
 * LLM Generate Executor
 *
 * Unified executor for llmGenerate (text generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type {
  LLMGenerateNodeData,
  LLMProvider,
  LLMModelType,
  SelectedModel,
  ProviderType,
} from "@/types";
import { buildLlmHeaders } from "@/store/utils/buildApiHeaders";
import { runWithFallback } from "./runWithFallback";
import type { NodeExecutionContext } from "./types";

export interface LlmGenerateOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

/**
 * Map ProviderType (stored in SelectedModel) back to LLMProvider (used by the
 * /api/llm route). Gemini is persisted as "gemini" in SelectedModel but the LLM
 * API knows it as "google". Other providers share names.
 */
function providerTypeToLlmProvider(p: ProviderType): LLMProvider {
  if (p === "gemini") return "google";
  if (p === "openai") return "openai";
  if (p === "anthropic") return "anthropic";
  if (p === "orcarouter") return "orcarouter";
  // Unsupported provider for LLM — caller will surface an error from /api/llm.
  return p as unknown as LLMProvider;
}

export async function executeLlmGenerate(
  ctx: NodeExecutionContext,
  options: LlmGenerateOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    signal,
    providerSettings,
  } = ctx;

  const { useStoredFallback: _useStoredFallback = false } = options;
  void _useStoredFallback;

  const inputs = getConnectedInputs(node.id);
  const nodeData = node.data as LLMGenerateNodeData;

  // Determine images and text
  let images: string[];
  let text: string | null;

  images = inputs.images.length > 0 ? inputs.images : nodeData.inputImages;
  text = inputs.text ?? nodeData.inputPrompt;

  if (!text) {
    updateNodeData(node.id, {
      status: "error",
      error: "Missing text input - connect a prompt node or set internal prompt",
    });
    throw new Error("Missing text input");
  }

  // Capture text as a definitely-non-null string for use inside the closure.
  const finalText: string = text;

  updateNodeData(node.id, {
    inputPrompt: finalText,
    inputImages: images,
    status: "loading",
    error: null,
  });

  const runOnce = async (modelToUse: SelectedModel, parametersOverride?: Record<string, unknown>): Promise<void> => {
    const llmProvider = providerTypeToLlmProvider(modelToUse.provider);
    const llmModel = modelToUse.modelId as LLMModelType;
    const headers = buildLlmHeaders(llmProvider, providerSettings);

    const temperature = (parametersOverride?.temperature as number | undefined) ?? nodeData.temperature;
    const maxTokens = (parametersOverride?.maxTokens as number | undefined) ?? nodeData.maxTokens;

    try {
      const response = await fetch("/api/llm", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: finalText,
          ...(images.length > 0 && { images }),
          provider: llmProvider,
          model: llmModel,
          temperature,
          maxTokens,
        }),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorMessage;
        } catch {
          if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
        }
        updateNodeData(node.id, {
          status: "error",
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }

      const result = await response.json();

      if (result.success && result.text) {
        updateNodeData(node.id, {
          outputText: result.text,
          status: "complete",
          error: null,
        });
      } else {
        updateNodeData(node.id, {
          status: "error",
          error: result.error || "LLM generation failed",
        });
        throw new Error(result.error || "LLM generation failed");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      let errorMessage = "LLM generation failed";
      if (error instanceof TypeError && error.message.includes("NetworkError")) {
        errorMessage = "Network error. Check your connection and try again.";
      } else if (error instanceof TypeError) {
        errorMessage = `Network error: ${error.message}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      updateNodeData(node.id, {
        status: "error",
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }
  };

  // Synthesize a SelectedModel for the primary from the LLM's legacy provider/model fields.
  // "google" → "gemini" so SelectedModel carries the canonical ProviderType.
  const primaryProviderType: ProviderType =
    nodeData.provider === "google" ? "gemini" : (nodeData.provider as ProviderType);

  const primaryModel: SelectedModel = {
    provider: primaryProviderType,
    modelId: nodeData.model,
    displayName: nodeData.model,
  };

  await runWithFallback({
    nodeId: node.id,
    primary: primaryModel,
    fallback: nodeData.fallbackModel,
    fallbackParameters: nodeData.fallbackParameters,
    updateNodeData,
    runOnce,
    clearOutput: { outputText: null },
  });
}
