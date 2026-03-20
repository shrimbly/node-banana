/**
 * Simple Node Executors
 *
 * Executors for node types that don't call external APIs:
 * annotation, prompt, promptConstructor, output, outputGallery, imageCompare.
 *
 * These are used by executeWorkflow (and some by regenerateNode).
 */

import type {
  AnnotationNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  PromptNodeData,
  LLMGenerateNodeData,
  ImageInputNodeData,
  OutputNodeData,
  OutputGalleryNodeData,
  PromptPart,
  WorkflowNode,
} from "@/types";
import type { NodeExecutionContext } from "./types";
import { parseTextToArray } from "@/utils/arrayParser";
import { parseVarTags } from "@/utils/parseVarTags";
import { resolveImageVars } from "@/utils/resolveImageVars";

/**
 * Annotation node: receives upstream image as source, passes through if no annotations.
 */
export async function executeAnnotation(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const image = images[0] || null;
    if (image) {
      const nodeData = node.data as AnnotationNodeData;
      updateNodeData(node.id, { sourceImage: image, sourceImageRef: undefined });
      // Pass through the image if no annotations exist, or if the previous
      // output was itself a pass-through of the old source image
      if (!nodeData.outputImage || nodeData.outputImage === nodeData.sourceImage) {
        updateNodeData(node.id, { outputImage: image, outputImageRef: undefined });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Annotation node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Prompt node: receives upstream text and updates its prompt field.
 */
export async function executePrompt(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { text: connectedText } = getConnectedInputs(node.id);
    if (connectedText !== null) {
      updateNodeData(node.id, { prompt: connectedText });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Prompt node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Array node: splits connected text into itemized text outputs.
 */
export async function executeArray(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getFreshNode } = ctx;

  try {
    const freshNode = getFreshNode(node.id);
    const nodeData = (freshNode?.data || node.data) as ArrayNodeData;
    const { text: connectedText } = getConnectedInputs(node.id);
    const inputText = connectedText ?? nodeData.inputText ?? "";

    const parsed = parseTextToArray(inputText, {
      splitMode: nodeData.splitMode,
      delimiter: nodeData.delimiter,
      regexPattern: nodeData.regexPattern,
      trimItems: nodeData.trimItems,
      removeEmpty: nodeData.removeEmpty,
    });

    updateNodeData(node.id, {
      inputText,
      outputItems: parsed.items,
      outputText: JSON.stringify(parsed.items),
      error: parsed.error,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Array node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * PromptConstructor node: resolves @variables from connected prompt nodes.
 */
export async function executePromptConstructor(ctx: NodeExecutionContext): Promise<void> {
  const { node, updateNodeData, getFreshNode, getEdges, getNodes } = ctx;
  try {
    // Get fresh node data from store
    const freshNode = getFreshNode(node.id);
    const nodeData = (freshNode?.data || node.data) as PromptConstructorNodeData;
    const template = nodeData.template;

    const edges = getEdges();
    const nodes = getNodes();

    // Find all connected text nodes
    const connectedTextNodes = edges
      .filter((e) => e.target === node.id && e.targetHandle === "text")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is WorkflowNode => n !== undefined);

    // Find all connected image nodes
    const connectedImageNodes = edges
      .filter((e) => e.target === node.id && e.targetHandle === "image")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is WorkflowNode => n !== undefined);

    // Build variable map: named variables from Prompt nodes take precedence
    const variableMap: Record<string, string> = {};
    connectedTextNodes.forEach((srcNode) => {
      if (srcNode.type === "prompt") {
        const promptData = srcNode.data as PromptNodeData;
        if (promptData.variableName) {
          variableMap[promptData.variableName] = promptData.prompt;
        }
      }
    });

    // Build named images map from connected ImageInput nodes with variableName
    const namedImages: Record<string, string> = {};
    connectedImageNodes.forEach((srcNode) => {
      if (srcNode.type === "imageInput") {
        const imgData = srcNode.data as ImageInputNodeData;
        if (imgData.variableName && imgData.image) {
          namedImages[imgData.variableName] = imgData.image;
        }
      }
    });

    // Parse inline <var> tags from all connected text nodes
    connectedTextNodes.forEach((srcNode) => {
      let text: string | null = null;
      if (srcNode.type === "prompt") {
        text = (srcNode.data as PromptNodeData).prompt || null;
      } else if (srcNode.type === "llmGenerate") {
        text = (srcNode.data as LLMGenerateNodeData).outputText || null;
      } else if (srcNode.type === "promptConstructor") {
        const pcData = srcNode.data as PromptConstructorNodeData;
        text = pcData.outputText ?? pcData.template ?? null;
      }

      if (text) {
        const parsed = parseVarTags(text);
        parsed.forEach(({ name, value }) => {
          if (variableMap[name] === undefined) {
            variableMap[name] = value;
          }
        });
      }
    });

    // Find all @variable patterns in template
    const varPattern = /@(\w+)/g;
    const unresolvedVars: string[] = [];
    let resolvedText = template;

    // Replace text @variables with values or track unresolved
    // (image @variables are left as-is in outputText — they're resolved in outputParts)
    const matches = template.matchAll(varPattern);
    for (const match of matches) {
      const varName = match[1];
      if (variableMap[varName] !== undefined) {
        resolvedText = resolvedText.replaceAll(`@${varName}`, variableMap[varName]);
      } else if (!namedImages[varName]) {
        // Only unresolved if not an image variable either
        if (!unresolvedVars.includes(varName)) {
          unresolvedVars.push(varName);
        }
      }
    }

    // Build multimodal outputParts if there are image variables referenced in the template
    let outputParts: PromptPart[] | null = null;
    if (Object.keys(namedImages).length > 0) {
      outputParts = resolveImageVars(resolvedText, namedImages);
    }

    updateNodeData(node.id, {
      outputText: resolvedText,
      outputParts,
      unresolvedVars,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] PromptConstructor node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Output node: displays final image/video result.
 */
export async function executeOutput(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, saveDirectoryPath } = ctx;
  const { images, videos, audio } = getConnectedInputs(node.id);

  // Check audio array first
  if (audio.length > 0) {
    const audioContent = audio[0];
    updateNodeData(node.id, {
      audio: audioContent,
      image: null,
      video: null,
      contentType: "audio",
    });

    // Save to /outputs directory if we have a project path
    if (saveDirectoryPath) {
      const outputNodeData = node.data as OutputNodeData;
      const outputsPath = `${saveDirectoryPath}/outputs`;

      fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: outputsPath,
          audio: audioContent,
          customFilename: outputNodeData.outputFilename || undefined,
          createDirectory: true,
        }),
      }).catch((err) => {
        console.error("Failed to save output:", err);
      });
    }
    return;
  }

  // Check videos array (typed data from source)
  if (videos.length > 0) {
    const videoContent = videos[0];
    updateNodeData(node.id, {
      image: videoContent,
      video: videoContent,
      contentType: "video",
    });

    // Save to /outputs directory if we have a project path
    if (saveDirectoryPath) {
      const outputNodeData = node.data as OutputNodeData;
      const outputsPath = `${saveDirectoryPath}/outputs`;

      fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: outputsPath,
          video: videoContent,
          customFilename: outputNodeData.outputFilename || undefined,
          createDirectory: true,
        }),
      }).catch((err) => {
        console.error("Failed to save output:", err);
      });
    }
  } else if (images.length > 0) {
    const content = images[0];
    // Fallback pattern matching for edge cases (video data that ended up in images array)
    const isVideoContent =
      content.startsWith("data:video/") ||
      content.includes(".mp4") ||
      content.includes(".webm") ||
      content.includes("fal.media");

    if (isVideoContent) {
      updateNodeData(node.id, {
        image: content,
        video: content,
        contentType: "video",
      });
    } else {
      updateNodeData(node.id, {
        image: content,
        video: null,
        contentType: "image",
      });
    }

    // Save to /outputs directory if we have a project path
    if (saveDirectoryPath) {
      const outputNodeData = node.data as OutputNodeData;
      const outputsPath = `${saveDirectoryPath}/outputs`;

      fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: outputsPath,
          image: isVideoContent ? undefined : content,
          video: isVideoContent ? content : undefined,
          customFilename: outputNodeData.outputFilename || undefined,
          createDirectory: true,
        }),
      }).catch((err) => {
        console.error("Failed to save output:", err);
      });
    }
  }
}

/**
 * OutputGallery node: accumulates images from upstream nodes.
 */
export async function executeOutputGallery(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { images } = getConnectedInputs(node.id);
  const galleryData = node.data as OutputGalleryNodeData;
  const existing = new Set(galleryData.images || []);
  const newImages = images.filter((img) => !existing.has(img));
  if (newImages.length > 0) {
    updateNodeData(node.id, {
      images: [...newImages, ...(galleryData.images || [])],
    });
  }
}

/**
 * ImageCompare node: takes two upstream images for side-by-side comparison.
 */
export async function executeImageCompare(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { images } = getConnectedInputs(node.id);
  updateNodeData(node.id, {
    imageA: images[0] || null,
    imageB: images[1] || null,
  });
}

/**
 * Router node: pure passthrough with brief status flash.
 */
export async function executeRouter(ctx: NodeExecutionContext): Promise<void> {
  // Router is pure passthrough — data flows via edge traversal in getConnectedInputs.
  // Brief status flash to show execution occurred.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * Switch node: pure passthrough with toggle-controlled routing.
 */
export async function executeSwitch(ctx: NodeExecutionContext): Promise<void> {
  // Switch is pure passthrough — data flows via edge traversal in getConnectedInputs.
  // Disabled outputs are filtered during traversal.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * ConditionalSwitch node: pure passthrough with text-based rule matching.
 */
export async function executeConditionalSwitch(ctx: NodeExecutionContext): Promise<void> {
  // ConditionalSwitch is pure passthrough — actual text matching happens during connectedInputs traversal.
  // Brief status flash to show execution occurred.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * GLB Viewer node: receives 3D model URL from upstream, fetches and loads it.
 */
export async function executeGlbViewer(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, signal } = ctx;
  const { model3d } = getConnectedInputs(node.id);
  if (model3d) {
    // Fetch the GLB URL and create a blob URL for the viewer
    try {
      const response = await fetch(model3d, signal ? { signal } : {});
      if (!response.ok) {
        throw new Error(`Failed to fetch 3D model: ${response.status}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      updateNodeData(node.id, {
        glbUrl: blobUrl,
        filename: "generated.glb",
        capturedImage: null,
      });
    } catch (error) {
      // Don't set error state on abort
      if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Workflow] GLB Viewer node ${node.id} failed:`, message);
      updateNodeData(node.id, { error: message });
    }
  }
}
