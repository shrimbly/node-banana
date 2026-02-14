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
  PromptConstructorNodeData,
  PromptNodeData,
  OutputNodeData,
  OutputGalleryNodeData,
  WorkflowNode,
} from "@/types";
import type { NodeExecutionContext } from "./types";

/**
 * Annotation node: receives upstream image as source, passes through if no annotations.
 */
export async function executeAnnotation(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const image = images[0] || null;
    if (image) {
      updateNodeData(node.id, { sourceImage: image });
      // If no annotations, pass through the image
      const nodeData = node.data as AnnotationNodeData;
      if (!nodeData.outputImage) {
        updateNodeData(node.id, { outputImage: image });
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

    // Find connected prompt nodes via text edges
    const connectedPromptNodes = edges
      .filter((e) => e.target === node.id && e.targetHandle === "text")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is WorkflowNode => n !== undefined && n.type === "prompt");

    // Build variable map from connected prompt nodes
    const variableMap: Record<string, string> = {};
    connectedPromptNodes.forEach((promptNode) => {
      const promptData = promptNode.data as PromptNodeData;
      if (promptData.variableName) {
        variableMap[promptData.variableName] = promptData.prompt;
      }
    });

    // Find all @variable patterns in template
    const varPattern = /@(\w+)/g;
    const unresolvedVars: string[] = [];
    let resolvedText = template;

    // Replace @variables with values or track unresolved
    const matches = template.matchAll(varPattern);
    for (const match of matches) {
      const varName = match[1];
      if (variableMap[varName] !== undefined) {
        resolvedText = resolvedText.replaceAll(`@${varName}`, variableMap[varName]);
      } else {
        if (!unresolvedVars.includes(varName)) {
          unresolvedVars.push(varName);
        }
      }
    }

    updateNodeData(node.id, {
      outputText: resolvedText,
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
  const { images, videos } = getConnectedInputs(node.id);

  // Check videos array first (typed data from source)
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
 * GLB Viewer node: receives 3D model URL from upstream, fetches and loads it.
 */
export async function executeGlbViewer(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { model3d } = getConnectedInputs(node.id);
  if (model3d) {
    // Fetch the GLB URL and create a blob URL for the viewer
    try {
      const response = await fetch(model3d);
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Workflow] GLB Viewer node ${node.id} failed:`, message);
      updateNodeData(node.id, { error: message });
    }
  }
}
