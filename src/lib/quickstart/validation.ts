import { WorkflowFile } from "@/store/workflowStore";
import { NodeType, WorkflowNodeData } from "@/types";

interface ValidationError {
  path: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const VALID_NODE_TYPES: NodeType[] = [
  "imageInput",
  "annotation",
  "prompt",
  "nanoBanana",
  "llmGenerate",
  "splitGrid",
  "output",
];

const VALID_HANDLE_TYPES = ["image", "text", "reference"];

// Default node dimensions
const DEFAULT_DIMENSIONS: Record<NodeType, { width: number; height: number }> = {
  imageInput: { width: 300, height: 280 },
  annotation: { width: 300, height: 280 },
  prompt: { width: 320, height: 220 },
  nanoBanana: { width: 300, height: 300 },
  llmGenerate: { width: 320, height: 360 },
  splitGrid: { width: 300, height: 320 },
  output: { width: 320, height: 320 },
};

/**
 * Validate a workflow JSON object
 */
export function validateWorkflowJSON(workflow: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  // Check root object
  if (!workflow || typeof workflow !== "object") {
    errors.push({ path: "", message: "Workflow must be an object" });
    return { valid: false, errors };
  }

  const wf = workflow as Record<string, unknown>;

  // Validate version
  if (wf.version !== 1) {
    errors.push({ path: "version", message: "Version must be 1" });
  }

  // Validate name
  if (!wf.name || typeof wf.name !== "string") {
    errors.push({ path: "name", message: "Name must be a non-empty string" });
  }

  // Validate nodes array
  if (!Array.isArray(wf.nodes)) {
    errors.push({ path: "nodes", message: "Nodes must be an array" });
  } else {
    const nodeIds = new Set<string>();

    (wf.nodes as unknown[]).forEach((node: unknown, i: number) => {
      if (!node || typeof node !== "object") {
        errors.push({ path: `nodes[${i}]`, message: "Node must be an object" });
        return;
      }

      const n = node as Record<string, unknown>;

      // Validate node id
      if (!n.id || typeof n.id !== "string") {
        errors.push({ path: `nodes[${i}].id`, message: "Node must have a string id" });
      } else {
        if (nodeIds.has(n.id)) {
          errors.push({ path: `nodes[${i}].id`, message: `Duplicate node id: ${n.id}` });
        }
        nodeIds.add(n.id);
      }

      // Validate node type
      if (!VALID_NODE_TYPES.includes(n.type as NodeType)) {
        errors.push({
          path: `nodes[${i}].type`,
          message: `Invalid node type: ${n.type}. Valid types: ${VALID_NODE_TYPES.join(", ")}`,
        });
      }

      // Validate position
      if (!n.position || typeof n.position !== "object") {
        errors.push({ path: `nodes[${i}].position`, message: "Node must have a position object" });
      } else {
        const pos = n.position as Record<string, unknown>;
        if (typeof pos.x !== "number" || typeof pos.y !== "number") {
          errors.push({
            path: `nodes[${i}].position`,
            message: "Position must have numeric x and y values",
          });
        }
      }

      // Validate data exists
      if (!n.data || typeof n.data !== "object") {
        errors.push({ path: `nodes[${i}].data`, message: "Node must have a data object" });
      }
    });
  }

  // Validate edges array
  if (!Array.isArray(wf.edges)) {
    errors.push({ path: "edges", message: "Edges must be an array" });
  } else {
    const nodeIds = new Set(
      (Array.isArray(wf.nodes) ? wf.nodes : []).map((n: { id: string }) => n.id)
    );

    (wf.edges as unknown[]).forEach((edge: unknown, i: number) => {
      if (!edge || typeof edge !== "object") {
        errors.push({ path: `edges[${i}]`, message: "Edge must be an object" });
        return;
      }

      const e = edge as Record<string, unknown>;

      // Validate source exists
      if (!e.source || typeof e.source !== "string") {
        errors.push({ path: `edges[${i}].source`, message: "Edge must have a source id" });
      } else if (!nodeIds.has(e.source)) {
        errors.push({
          path: `edges[${i}].source`,
          message: `Source node not found: ${e.source}`,
        });
      }

      // Validate target exists
      if (!e.target || typeof e.target !== "string") {
        errors.push({ path: `edges[${i}].target`, message: "Edge must have a target id" });
      } else if (!nodeIds.has(e.target)) {
        errors.push({
          path: `edges[${i}].target`,
          message: `Target node not found: ${e.target}`,
        });
      }

      // Validate handle types
      if (e.sourceHandle && !VALID_HANDLE_TYPES.includes(e.sourceHandle as string)) {
        errors.push({
          path: `edges[${i}].sourceHandle`,
          message: `Invalid sourceHandle: ${e.sourceHandle}`,
        });
      }

      if (e.targetHandle && !VALID_HANDLE_TYPES.includes(e.targetHandle as string)) {
        errors.push({
          path: `edges[${i}].targetHandle`,
          message: `Invalid targetHandle: ${e.targetHandle}`,
        });
      }

      // Validate handle types match (except reference which is special)
      const srcHandle = e.sourceHandle as string;
      const tgtHandle = e.targetHandle as string;
      if (
        srcHandle &&
        tgtHandle &&
        srcHandle !== "reference" &&
        tgtHandle !== "reference" &&
        srcHandle !== tgtHandle
      ) {
        errors.push({
          path: `edges[${i}]`,
          message: `Handle type mismatch: ${srcHandle} → ${tgtHandle}`,
        });
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create default node data based on type
 */
function createDefaultNodeData(type: NodeType): WorkflowNodeData {
  switch (type) {
    case "imageInput":
      return {
        image: null,
        filename: null,
        dimensions: null,
      };
    case "annotation":
      return {
        sourceImage: null,
        annotations: [],
        outputImage: null,
      };
    case "prompt":
      return {
        prompt: "",
      };
    case "nanoBanana":
      return {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      };
    case "llmGenerate":
      return {
        inputPrompt: null,
        inputImages: [],
        outputText: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        temperature: 0.7,
        maxTokens: 8192,
        status: "idle",
        error: null,
      };
    case "splitGrid":
      return {
        sourceImage: null,
        targetCount: 6,
        defaultPrompt: "",
        generateSettings: {
          aspectRatio: "1:1",
          resolution: "1K",
          model: "nano-banana-pro",
          useGoogleSearch: false,
        },
        childNodeIds: [],
        gridRows: 2,
        gridCols: 3,
        isConfigured: false,
        status: "idle",
        error: null,
      };
    case "output":
      return {
        image: null,
      };
  }
}

/**
 * Repair a workflow JSON object by filling in missing fields and removing invalid edges
 */
export function repairWorkflowJSON(workflow: unknown): WorkflowFile {
  const wf = (workflow || {}) as Record<string, unknown>;

  // Ensure required fields
  const repaired: WorkflowFile = {
    version: 1,
    id: (wf.id as string) || `wf_${Date.now()}_repaired`,
    name: (wf.name as string) || "Generated Workflow",
    nodes: [],
    edges: [],
    edgeStyle: (wf.edgeStyle as "angular" | "curved") || "curved",
  };

  // Repair nodes
  if (Array.isArray(wf.nodes)) {
    repaired.nodes = wf.nodes
      .filter((n): n is Record<string, unknown> => n && typeof n === "object")
      .map((node, index) => {
        const type = VALID_NODE_TYPES.includes(node.type as NodeType)
          ? (node.type as NodeType)
          : "prompt";

        const id =
          typeof node.id === "string" && node.id
            ? node.id
            : `${type}-${index + 1}`;

        const position =
          node.position && typeof node.position === "object"
            ? {
                x:
                  typeof (node.position as Record<string, unknown>).x === "number"
                    ? ((node.position as Record<string, unknown>).x as number)
                    : 50 + index * 400,
                y:
                  typeof (node.position as Record<string, unknown>).y === "number"
                    ? ((node.position as Record<string, unknown>).y as number)
                    : 100,
              }
            : { x: 50 + index * 400, y: 100 };

        // Merge existing data with defaults
        const defaultData = createDefaultNodeData(type);
        const existingData = node.data && typeof node.data === "object" ? node.data : {};
        const data = { ...defaultData, ...existingData };

        return {
          id,
          type,
          position,
          data,
          style: DEFAULT_DIMENSIONS[type],
        };
      }) as WorkflowFile["nodes"];
  }

  // Repair edges
  if (Array.isArray(wf.edges)) {
    const nodeIds = new Set(repaired.nodes.map((n) => n.id));

    repaired.edges = wf.edges
      .filter((e): e is Record<string, unknown> => e && typeof e === "object")
      .filter((edge) => {
        // Only keep edges where both source and target exist
        const sourceExists = nodeIds.has(edge.source as string);
        const targetExists = nodeIds.has(edge.target as string);

        // Only keep edges where handle types match (or are reference)
        const srcHandle = edge.sourceHandle as string;
        const tgtHandle = edge.targetHandle as string;
        const handlesMatch =
          !srcHandle ||
          !tgtHandle ||
          srcHandle === "reference" ||
          tgtHandle === "reference" ||
          srcHandle === tgtHandle;

        return sourceExists && targetExists && handlesMatch;
      })
      .map((edge) => ({
        id:
          (edge.id as string) ||
          `edge-${edge.source}-${edge.target}-${edge.sourceHandle || "default"}-${edge.targetHandle || "default"}`,
        source: edge.source as string,
        sourceHandle: (edge.sourceHandle as string) || undefined,
        target: edge.target as string,
        targetHandle: (edge.targetHandle as string) || undefined,
      })) as WorkflowFile["edges"];
  }

  return repaired;
}

/**
 * Parse JSON from LLM response, handling various formats
 */
export function parseJSONFromResponse(text: string): unknown {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Continue to other methods
  }

  // Try extracting from markdown code blocks
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {
      // Continue to other methods
    }
  }

  // Try finding a JSON object in the text
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Continue to other methods
    }
  }

  throw new Error("Could not parse JSON from response");
}
