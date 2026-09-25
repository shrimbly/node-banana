/**
 * The agent's tools as the models see them: names, descriptions and flat zod
 * shapes. Flat objects with optional fields (an `op` enum rather than a
 * union) convert cleanly to JSON Schema for both the Claude Agent SDK and
 * Codex dynamic tools.
 */

import { z } from "zod";
import type { AgentToolDefinition } from "../types";

export const TOOL_NAMES = {
  getWorkflow: "get_workflow",
  describeNodeTypes: "describe_node_types",
  listModels: "list_models",
  createWorkflow: "create_workflow",
  editWorkflow: "edit_workflow",
  updateNode: "update_node",
  arrangeWorkflow: "arrange_workflow",
} as const;

export type AgentToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const settingsField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Settings by field name, e.g. {"prompt": "a red fox in snow"} on a prompt node or {"model": "nano-banana-2", "aspectRatio": "16:9"} on nanoBanana. Only the fields describe_node_types lists are accepted. To change part of a long prompt without retyping it: {"promptEdit": {"find": "old words", "replace": "new words"}} (or {"append": "…"} / {"prepend": "…"}; templateEdit on a Prompt Constructor).',
  );

const fromField = z.string().describe("Source node: an existing node id, or a ref defined earlier in this call.");
const toField = z.string().describe("Target node: an existing node id, or a ref defined earlier in this call.");
const fromHandleField = z
  .string()
  .optional()
  .describe("Output handle. Usually omit it: it is picked by type. Needed for nodes with several outputs: a Switch output name, a Conditional Switch rule label or \"default\" (its Fallback output), a Router type, an Ease Curve's \"easeCurve\".");
const toHandleField = z
  .string()
  .optional()
  .describe('Input handle id, type or label, e.g. "text", "image", "image-1", "negative_prompt". Usually omit it: the right input is picked by type (a second image goes to the next free image slot).');
const arrayItemIndexField = z
  .number()
  .optional()
  .describe("Connections from an Array node only: which item (0-based) this connection carries. Omit to number connections 0, 1, 2… in order.");
const loopField = z
  .boolean()
  .optional()
  .describe("Only when the user asked for a loop: allow this connection to close a cycle (it becomes a loop edge that re-runs part of the graph).");
const positionField = z
  .object({ x: z.number(), y: z.number() })
  .optional()
  .describe("Canvas position (top-left corner, canvas coordinates). Omit to place automatically next to what it connects to.");

export const getWorkflowShape = {
  nodeIds: z.array(z.string()).optional().describe("Only these nodes and their connections. Omit for the whole canvas."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe('"summary" (default): one line per node plus connections. "full": every setting, position, and each input/output handle with its type and what is connected.'),
};

export const describeNodeTypesShape = {
  types: z.array(z.string()).optional().describe('Node types to describe, e.g. ["nanoBanana", "llmGenerate"]. Omit for all of them.'),
};

export const listModelsShape = {
  kind: z.enum(["image", "video", "llm"]).optional().describe("Which models. Omit for all."),
};

export const createWorkflowShape = {
  replaceCanvas: z
    .boolean()
    .optional()
    .describe("true deletes every node on the canvas first (unnecessary when the canvas is empty). Only when the user asked to start over or for a new workflow from scratch, or confirmed replacing a non-empty canvas. Default false: the new nodes are added next to the existing ones."),
  nodes: z
    .array(
      z.object({
        ref: z.string().describe('Your short name for the node, used in connections (e.g. "prompt", "gen").'),
        type: z.string().describe("Node type, e.g. prompt, nanoBanana, llmGenerate, output (see describe_node_types)."),
        title: z.string().optional().describe("Optional header title for the node."),
        settings: settingsField,
      }),
    )
    .describe("Nodes to add, in data-flow order (sources first). They are laid out left to right as one cluster."),
  connections: z
    .array(
      z.object({
        from: fromField,
        fromHandle: fromHandleField,
        to: toField,
        toHandle: toHandleField,
        arrayItemIndex: arrayItemIndexField,
        loop: loopField,
      }),
    )
    .optional()
    .describe("Wires between nodes; from/to are refs from `nodes` or ids of nodes already on the canvas."),
};

export const editWorkflowShape = {
  operations: z
    .array(
      z.object({
        op: z
          .enum(["add_node", "update_node", "remove_node", "connect", "disconnect", "move_node"])
          .describe("What to do. Each op uses only the fields listed for it."),
        ref: z.string().optional().describe("add_node: your name for the new node, usable as node/from/to in the other operations of this call."),
        type: z.string().optional().describe("add_node: node type."),
        node: z.string().optional().describe("update_node, remove_node, move_node: the node id (or a ref from this call)."),
        title: z.string().optional().describe("add_node, update_node: header title (empty string clears it)."),
        settings: settingsField,
        from: fromField.optional(),
        fromHandle: fromHandleField,
        to: toField.optional(),
        toHandle: toHandleField,
        arrayItemIndex: arrayItemIndexField,
        loop: loopField,
        loopCount: z.number().optional().describe("connect with loop: how many times the loop runs (1-100, default 3)."),
        edgeId: z.string().optional().describe("disconnect: a connection id from get_workflow (alternative to from/to)."),
        position: positionField,
      }),
    )
    .describe("Operations applied together: add_node ops run first (so refs can be used anywhere in the list), then the rest in order."),
};

export const updateNodeShape = {
  node: z.string().describe("The node id, e.g. prompt-3."),
  title: z.string().optional().describe("New header title (empty string clears it)."),
  settings: settingsField,
};

export const arrangeWorkflowShape = {
  nodeIds: z.array(z.string()).optional().describe("Only tidy these nodes. Omit to tidy the whole canvas."),
};

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: TOOL_NAMES.getWorkflow,
    title: "Read workflow",
    readOnly: true,
    description:
      "Read the current canvas: nodes (id, type, title, key settings, whether they hold an image/video/text), connections with handle ids, groups and the user's selection. Reflects every change you made earlier in this turn. Use detail \"full\" for all settings and each handle's type and connections before rewiring a node you are unsure about.",
    inputShape: getWorkflowShape,
  },
  {
    name: TOOL_NAMES.describeNodeTypes,
    title: "Look up node types",
    readOnly: true,
    description:
      "Describe node types: purpose, input and output handles (id and data type), every setting you may change with its allowed values and default, and usage notes. Check it before using a node type or setting you have not used yet.",
    inputShape: describeNodeTypesShape,
  },
  {
    name: TOOL_NAMES.listModels,
    title: "List models",
    readOnly: true,
    description:
      "List the models you can set: Gemini image models for Generate Image (with their aspect ratios and resolutions), Gemini video models (Veo, Gemini Omni) for Generate Video with their settings, and LLM providers/models for LLM Generate. Other providers' models cannot be set by you; the user picks them in the node.",
    inputShape: listModelsShape,
  },
  {
    name: TOOL_NAMES.createWorkflow,
    title: "Create workflow",
    readOnly: false,
    description:
      "Add a group of new nodes and their connections in one call, laid out left to right. Give each node a ref and wire them with connections (from/to = refs, or ids of nodes already on the canvas). Handles are picked by data type, so you rarely need fromHandle/toHandle. Example: nodes [{ref:\"p\",type:\"prompt\",settings:{prompt:\"a cozy cabin at dusk\"}}, {ref:\"g\",type:\"nanoBanana\",settings:{aspectRatio:\"16:9\"}}, {ref:\"o\",type:\"output\"}], connections [{from:\"p\",to:\"g\"},{from:\"g\",to:\"o\"}]. All-or-nothing: if anything is invalid nothing changes and every problem is returned with its fix. Returns the ref → node id map.",
    inputShape: createWorkflowShape,
  },
  {
    name: TOOL_NAMES.editWorkflow,
    title: "Edit workflow",
    readOnly: false,
    description:
      "Change the canvas with a list of operations applied together: add_node {ref, type, title?, settings?, position?}, update_node {node, title?, settings?}, remove_node {node}, connect {from, to, fromHandle?, toHandle?, arrayItemIndex?}, disconnect {from?, to?, fromHandle?, toHandle?} or {edgeId}, move_node {node, position}. A text input takes one connection: connecting another text source to it replaces the old one (reported). An output can feed any number of inputs, so adding a viewer never needs an existing connection removed. Connections must join the same data type (image→image, text→text…); there is no conversion. A node moved into a group's box joins that group, and one moved out leaves it, as on the canvas. All-or-nothing: if any operation is invalid nothing changes and every error is returned with its fix.",
    inputShape: editWorkflowShape,
  },
  {
    name: TOOL_NAMES.updateNode,
    title: "Update node",
    readOnly: false,
    description:
      "Change one node's settings and/or title, e.g. {node:\"prompt-2\", settings:{prompt:\"...\"}} or {node:\"nanoBanana-4\", settings:{model:\"nano-banana-2\", aspectRatio:\"9:16\"}}. The canvas shows long prompts only in part: change part of one with settings.promptEdit {find, replace} (or {append}/{prepend}) instead of retyping it, or read it whole with get_workflow detail \"full\" first. Unlisted fields are rejected with the valid names; values out of range are rejected with the allowed ones.",
    inputShape: updateNodeShape,
  },
  {
    name: TOOL_NAMES.arrangeWorkflow,
    title: "Tidy layout",
    readOnly: false,
    description:
      "Re-arrange nodes into tidy left-to-right columns following the connections (the whole canvas, or only nodeIds). Nodes in groups stay where they are, and nothing is moved into a group's box. Use when the user asks to tidy or clean up the layout; new nodes are already placed well.",
    inputShape: arrangeWorkflowShape,
  },
];
