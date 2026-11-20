import { WorkflowNode } from "@/types";
import { WorkflowEdge } from "@/types/workflow";
import type {
  ImageInputNodeData,
  AnnotationNodeData,
  PromptNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  LLMGenerateNodeData,
  SplitGridNodeData,
  OutputNodeData,
} from "@/types";

/**
 * Binary fields by node type - fields containing base64 data URLs
 */
const BINARY_FIELDS_BY_TYPE: Record<string, string[]> = {
  imageInput: ["image", "batchImages"],
  annotation: ["sourceImage", "outputImage"],
  nanoBanana: ["inputImages", "outputImage"],
  generateVideo: ["inputImages", "outputVideo"],
  llmGenerate: ["inputImages"],
  splitGrid: ["sourceImage"],
  output: ["image", "video"],
  prompt: [],
};

/**
 * History fields to strip completely (irrelevant for editing context)
 */
const HISTORY_FIELDS = [
  "imageHistory",
  "videoHistory",
  "selectedHistoryIndex",
  "selectedVideoHistoryIndex",
];

/**
 * Ref fields to strip completely (internal storage tracking)
 */
const REF_FIELDS = [
  "imageRef",
  "batchImageRefs",
  "outputImageRef",
  "sourceImageRef",
  "inputImageRefs",
  "outputVideoRef",
];

/**
 * Stripped node with binary data replaced by metadata placeholders
 */
export interface StrippedNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

/**
 * Lightweight workflow context for LLM consumption.
 * Strips all base64 image data, history arrays, and internal state.
 */
export interface WorkflowContext {
  nodeCount: number;
  nodes: StrippedNode[];
  connections: Array<{
    from: string;
    to: string;
    sourceHandle: string | null;
    targetHandle: string | null;
  }>;
  isEmpty: boolean;
}

/**
 * Estimates the size of a base64 data URL in kilobytes.
 */
function estimateBase64Size(dataUrl: string): number {
  // Base64 encoding overhead: every 3 bytes becomes 4 characters
  // So to get original size: (length * 3) / 4
  return Math.round((dataUrl.length * 3) / 4 / 1024);
}

/**
 * Formats a binary field placeholder with metadata.
 */
function formatBinaryPlaceholder(
  value: string | string[],
  fieldName: string,
  context?: string
): string {
  // Handle array fields (inputImages)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[no images]";
    }
    const count = value.length;
    return `[${count} image(s)]`;
  }

  // Handle single string fields
  const sizeKB = estimateBase64Size(value);
  const isVideo = fieldName.toLowerCase().includes("video");
  const type = isVideo ? "video" : "image";

  // Format: [type: context, sizeKB] or [type: sizeKB] if no context
  if (context) {
    return `[${type}: ${context}, ${sizeKB}KB]`;
  }
  return `[${type}: ${sizeKB}KB]`;
}

/**
 * Strips binary data from workflow nodes, preserving all parameters and adding metadata placeholders.
 *
 * @param nodes - Workflow nodes to strip
 * @returns Stripped nodes with binary data replaced by metadata
 */
export function stripBinaryData(nodes: WorkflowNode[]): StrippedNode[] {
  return nodes.map((node) => {
    const strippedData: Record<string, unknown> = {};
    const binaryFields = BINARY_FIELDS_BY_TYPE[node.type] || [];

    // Copy all data fields except binary, history, and ref fields
    for (const [key, value] of Object.entries(node.data)) {
      // Skip history fields
      if (HISTORY_FIELDS.includes(key)) {
        continue;
      }
      // Skip ref fields
      if (REF_FIELDS.includes(key)) {
        continue;
      }

      // Handle binary fields
      if (binaryFields.includes(key)) {
        if (value === null || value === undefined) {
          strippedData[key] = value;
        } else {
          // Add context based on node type
          let context: string | undefined;
          if (node.type === "nanoBanana" || node.type === "generateVideo") {
            const nodeData = node.data as NanoBananaNodeData | GenerateVideoNodeData;
            context = nodeData.selectedModel?.displayName;
          } else if (node.type === "imageInput") {
            const nodeData = node.data as ImageInputNodeData;
            if (nodeData.dimensions) {
              context = `${nodeData.dimensions.width}x${nodeData.dimensions.height}`;
            }
          }

          strippedData[key] = formatBinaryPlaceholder(
            value as string | string[],
            key,
            context
          );
        }
      } else {
        // Copy non-binary field as-is
        strippedData[key] = value;
      }
    }

    return {
      id: node.id,
      type: node.type,
      position: node.position,
      data: strippedData,
    };
  });
}

/**
 * Builds a lightweight workflow context from nodes and edges.
 * Omits all base64 image data, history arrays, and internal state.
 *
 * @param nodes - Current workflow nodes
 * @param edges - Current workflow edges
 * @returns Lightweight workflow context suitable for LLM injection
 */
export function buildWorkflowContext(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowContext {
  const isEmpty = nodes.length === 0;

  // Strip binary data from all nodes
  const strippedNodes = stripBinaryData(nodes);

  // Map edges to connection summaries
  const connections = edges.map((edge) => ({
    from: edge.source,
    to: edge.target,
    sourceHandle: edge.sourceHandle || null,
    targetHandle: edge.targetHandle || null,
  }));

  return {
    nodeCount: nodes.length,
    nodes: strippedNodes,
    connections,
    isEmpty,
  };
}

/**
 * Formats workflow context as a readable string for injection into LLM system prompt.
 *
 * @param context - Workflow context
 * @returns Formatted string suitable for system prompt
 */
export function formatContextForPrompt(context: WorkflowContext): string {
  if (context.isEmpty) {
    return "The canvas is currently empty.";
  }

  const lines: string[] = [];

  // List nodes with their current parameters/settings so the model can see
  // (and correctly edit) values like prompt, resolution, aspectRatio, etc.
  // Binary fields have already been replaced with lightweight placeholders by
  // stripBinaryData, so serializing node.data here is safe (no base64 payloads).
  lines.push(`Current workflow has ${context.nodeCount} node(s):`);
  for (const node of context.nodes) {
    const title = (node.data.customTitle as string) || generateNodeTitle(node.type);
    lines.push(`  - ${node.id} (${node.type}): ${title}`);

    // Emit the remaining settings as a compact JSON block. customTitle is
    // already shown as the title above, so omit it to avoid duplication.
    const { customTitle: _customTitle, ...settings } = node.data;
    if (Object.keys(settings).length > 0) {
      lines.push(`    settings: ${JSON.stringify(settings)}`);
    }
  }

  // List connections
  if (context.connections.length > 0) {
    lines.push("");
    lines.push("Connections:");
    for (const conn of context.connections) {
      const handleInfo = conn.sourceHandle ? ` (${conn.sourceHandle})` : "";
      lines.push(`  - ${conn.from} → ${conn.to}${handleInfo}`);
    }
  }

  return lines.join("\n");
}

/**
 * Generates a human-readable title from a node type.
 */
function generateNodeTitle(type: string): string {
  const titles: Record<string, string> = {
    imageInput: "Image Input",
    annotation: "Annotation",
    prompt: "Prompt",
    array: "Array",
    nanoBanana: "Generate Image",
    generateVideo: "Generate Video",
    llmGenerate: "LLM Generate",
    splitGrid: "Split Grid",
    output: "Output",
  };
  return titles[type] || type;
}
