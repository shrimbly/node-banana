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
  searchModels: "search_models",
  createWorkflow: "create_workflow",
  editWorkflow: "edit_workflow",
  updateNode: "update_node",
  arrangeWorkflow: "arrange_workflow",
  nameConversation: "name_conversation",
  getPromptGuide: "get_prompt_guide",
  runWorkflow: "run_workflow",
  switchWorkflow: "switch_workflow",
  newWorkflow: "new_workflow",
  saveWorkflow: "save_workflow",
  viewOutputs: "view_outputs",
} as const;

export type AgentToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const settingsField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Settings by field name, e.g. {"prompt": "a red fox in snow"} on a prompt node, {"model": "nano-banana-2", "aspectRatio": "16:9"} on nanoBanana, or {"model": {"provider": "openai", "modelId": "gpt-image-2.5-flare"}, "modelParameters": {"quality": "high"}} for a model found with search_models. Only the fields describe_node_types lists are accepted. To change part of a long prompt without retyping it: {"promptEdit": {"find": "old words", "replace": "new words"}} (or {"append": "…"} / {"prepend": "…"}; templateEdit on a Prompt Constructor).',
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
const groupNameField = z.string().describe('What the group\'s nodes do, shown as its title, e.g. "Scene set", "Hero film".');
const groupColorField = z
  .string()
  .optional()
  .describe("Group colour key: neutral (slate), blue (teal), green (olive), purple (plum), orange (amber) or red (terracotta). Omit to take the next colour no group uses; give related groups different colours.");

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

export const searchModelsShape = {
  nodeType: z
    .string()
    .optional()
    .describe('The node the model is for: nanoBanana (images), generateVideo, generate3d or generateAudio; llmGenerate returns its fixed LLM list. Filters by what the node accepts.'),
  capability: z
    .string()
    .optional()
    .describe("Narrower filter: text-to-image, image-to-image, text-to-video, image-to-video, audio-to-video, text-to-3d, image-to-3d or text-to-audio (or image, video, 3d, audio)."),
  provider: z.string().optional().describe("Only this provider: gemini, openai, kie, fal, replicate, wavespeed or comfy. Omit to search every provider the user has a key for."),
  query: z
    .string()
    .optional()
    .describe('Words from the model\'s name or id, e.g. "flare", "kling 2.6", "seedance". Short distinctive words find more than a full phrase.'),
  limit: z.number().optional().describe("How many models to show (default 15, max 50)."),
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
        title: z.string().optional().describe("Header title. Usually omit it (the node type names the node); set one only to tell apart several nodes of the same type."),
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
  groups: z
    .array(
      z.object({
        name: groupNameField,
        color: groupColorField,
        nodes: z.array(z.string()).describe("Its nodes: refs from `nodes` (or ids of nodes already on the canvas that are in no group). A node belongs to one group."),
      }),
    )
    .optional()
    .describe("Named, coloured boxes around the workflow's stages or branches. Each group's nodes are laid out together inside its box; groups that feed each other read left to right, the others stack top to bottom. Omit for a small workflow."),
};

export const editWorkflowShape = {
  operations: z
    .array(
      z.object({
        op: z
          .enum(["add_node", "update_node", "remove_node", "connect", "disconnect", "move_node", "group", "ungroup", "update_group", "add_to_group", "remove_from_group"])
          .describe("What to do. Each op uses only the fields listed for it."),
        ref: z.string().optional().describe("add_node: your name for the new node, usable as node/from/to in the other operations of this call."),
        type: z.string().optional().describe("add_node: node type."),
        node: z.string().optional().describe("update_node, remove_node, move_node: the node id (or a ref from this call)."),
        title: z.string().optional().describe("add_node: header title, only to tell apart several nodes of the same type. update_node: only when the user asked to rename the node (empty string clears it)."),
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
        nodes: z
          .array(z.string())
          .optional()
          .describe("group, add_to_group, remove_from_group: node ids (or refs from this call)."),
        group: z.string().optional().describe("ungroup, update_group, add_to_group: the group's id (e.g. group-2) or its exact name."),
        name: groupNameField.optional().describe("group: the new group's title (required). update_group: its new title."),
        color: groupColorField,
      }),
    )
    .describe("Operations applied together: add_node ops run first (so refs can be used anywhere in the list), then the rest in order."),
};

export const updateNodeShape = {
  node: z.string().describe("The node id, e.g. prompt-3."),
  title: z.string().optional().describe("New header title (empty string clears it). Only when the user asked to rename the node."),
  settings: settingsField,
};

export const arrangeWorkflowShape = {
  nodeIds: z.array(z.string()).optional().describe("Only tidy these nodes. Omit to tidy the whole canvas."),
};

export const nameConversationShape = {
  summary: z
    .string()
    .min(1)
    .max(80)
    .describe('3-6 words naming what the conversation is about, sentence case, no final period, e.g. "Espresso hero film workflow".'),
};

export const viewOutputsShape = {
  nodeIds: z
    .array(z.string())
    .optional()
    .describe("The nodes whose results to look at (ids, or refs from this turn). Omit for every node that has one."),
  takes: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Results per node: 1 (the default) is the one it shows; up to 4 adds its other recent takes, newest first, to compare runs."),
};

export const getPromptGuideShape = {
  node: z
    .string()
    .optional()
    .describe("A generator or LLM Generate node on the canvas (its id, or a ref from earlier this turn): its type, model and connected inputs pick the guide."),
  nodeType: z
    .string()
    .optional()
    .describe("For a node not made yet: nanoBanana, generateVideo, generateAudio, generate3d or llmGenerate."),
  model: z.string().optional().describe("The model the prompt is for, as settings.model takes it (an id from search_models). Overrides the node's model."),
  provider: z.string().optional().describe("The model's provider, when several list the same id."),
  task: z
    .string()
    .optional()
    .describe("A task of that node's guide, e.g. generate, edit, compose (image); text-to-video, image-to-video (video); speech, music, sound-effect (audio); instruction, prompt-writer (llmGenerate). Omit to have it picked from the node's inputs and model."),
  target: z
    .string()
    .optional()
    .describe("llmGenerate prompt-writer only: the node type the LLM's prompt is for, e.g. nanoBanana."),
};

export const runWorkflowShape = {
  scope: z
    .enum(["nodes", "all", "from"])
    .describe('"nodes": only nodeIds, fed by the outputs the nodes before them already hold. "all": the whole workflow, as the Run button does. "from": node and everything after it, and every other node at its depth or later (other branches too, as Run from on the canvas does), fed by the outputs the nodes before it hold.'),
  nodeIds: z.array(z.string()).optional().describe('scope "nodes": the nodes to run (ids, or refs from this turn).'),
  node: z.string().optional().describe('scope "from": the node to start from (an id, or a ref from this turn).'),
  runs: z.number().optional().describe("How many runs, one after another (1-50, default 1). Only when the user asked for several."),
};

export const switchWorkflowShape = {
  tab: z.string().describe("The open workflow to work in: its tab id from the canvas block's list of open workflows, or its exact name."),
};

export const newWorkflowShape = {
  name: z.string().optional().describe('A short name for what the new workflow will make, e.g. "Fox portraits".'),
};

export const saveWorkflowShape = {
  name: z
    .string()
    .optional()
    .describe("The project name for a workflow never saved before (required when it has no name). Ignored once it has been saved: a save never renames."),
};

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: TOOL_NAMES.getWorkflow,
    title: "Read workflow",
    readOnly: true,
    description:
      "Read the current canvas: nodes (id, type, title, key settings, whether they hold an image/video/text), connections with handle ids, groups (id, name, colour, box and their nodes) and the user's selection. Reflects every change you made earlier in this turn. Use detail \"full\" for all settings and each handle's type and connections before rewiring a node you are unsure about.",
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
    name: TOOL_NAMES.searchModels,
    title: "Search models",
    readOnly: true,
    description:
      "Search the image, video, 3D and audio models of every provider the user has an API key for (Gemini, OpenAI, Kie, fal, Replicate, WaveSpeed, ComfyUI), the same list the node's model browser shows. Returns each model's provider, exact id, name, capabilities, the node type it fits and its price, plus which providers were searched, which failed, and which have no key. Call it before setting any model you have not seen in this conversation: settings.model takes the exact id it returns (or {provider, modelId}); never guess an id. nodeType llmGenerate returns LLM Generate's fixed model list.",
    inputShape: searchModelsShape,
  },
  {
    name: TOOL_NAMES.createWorkflow,
    title: "Create workflow",
    readOnly: false,
    description:
      "Add new nodes and their connections in one call, laid out left to right. Give each node a ref and wire them with connections (from/to = refs, or ids of nodes already on the canvas). Handles are picked by data type, so you rarely need fromHandle/toHandle. Example: nodes [{ref:\"p\",type:\"prompt\",settings:{prompt:\"a cozy cabin at dusk\"}}, {ref:\"g\",type:\"nanoBanana\",settings:{aspectRatio:\"16:9\"}}, {ref:\"o\",type:\"output\"}], connections [{from:\"p\",to:\"g\"},{from:\"g\",to:\"o\"}]. For a workflow with distinct stages or branches, add groups [{name:\"Scene set\", color:\"blue\", nodes:[\"p\",\"g\"]}, …] so each stage sits in its own named box. All-or-nothing: if anything is invalid nothing changes and every problem is returned with its fix. Returns the ref → node id map and each group's id.",
    inputShape: createWorkflowShape,
  },
  {
    name: TOOL_NAMES.editWorkflow,
    title: "Edit workflow",
    readOnly: false,
    description:
      "Change the canvas with a list of operations applied together: add_node {ref, type, title?, settings?, position?}, update_node {node, title?, settings?}, remove_node {node}, connect {from, to, fromHandle?, toHandle?, arrayItemIndex?}, disconnect {from?, to?, fromHandle?, toHandle?} or {edgeId}, move_node {node, position}, group {nodes, name, color?} (a new named box around those nodes), ungroup {group} (removes the box; the nodes stay), update_group {group, name?, color?}, add_to_group {nodes, group}, remove_from_group {nodes}. A text input takes one connection: connecting another text source to it replaces the old one (reported). An output can feed any number of inputs, so adding a viewer never needs an existing connection removed. Connections must join the same data type (image→image, text→text…); there is no conversion. Group boxes follow their nodes: a new group's box is fitted around its nodes (moving them together if the box would cover other nodes), a group grows around nodes added to it, a node taken out moves clear of the box, and a group left with no nodes is removed. A node moved into a group's box joins that group, and one moved out leaves it, as on the canvas. All-or-nothing: if any operation is invalid nothing changes and every error is returned with its fix.",
    inputShape: editWorkflowShape,
  },
  {
    name: TOOL_NAMES.updateNode,
    title: "Update node",
    readOnly: false,
    description:
      "Change one node's settings and/or title, e.g. {node:\"prompt-2\", settings:{prompt:\"...\"}}, {node:\"nanoBanana-4\", settings:{model:\"nano-banana-2\", aspectRatio:\"9:16\"}} or {node:\"nanoBanana-4\", settings:{model:{provider:\"openai\", modelId:\"gpt-image-2.5-flare\"}}} (a model id from search_models). The canvas shows long prompts only in part: change part of one with settings.promptEdit {find, replace} (or {append}/{prepend}) instead of retyping it, or read it whole with get_workflow detail \"full\" first. Unlisted fields are rejected with the valid names; values out of range are rejected with the allowed ones.",
    inputShape: updateNodeShape,
  },
  {
    name: TOOL_NAMES.arrangeWorkflow,
    title: "Tidy layout",
    readOnly: false,
    description:
      "Re-arrange nodes into tidy left-to-right columns following the connections (the whole canvas, or only nodeIds). Each group moves as one unit: its nodes are tidied inside its box, which is refit around them (naming one node of a group arranges the whole group), and nothing else is moved into a box. Use when the user asks to tidy or clean up the layout; new nodes are already placed well.",
    inputShape: arrangeWorkflowShape,
  },
  {
    name: TOOL_NAMES.getPromptGuide,
    title: "Read prompt guide",
    readOnly: true,
    description:
      "How to write a strong prompt for one node: the parts it needs in order, the length, rules, a weak and a strong example, notes from the chosen model's own listing, and prompting notes the user saved for that model. Call it before you write or rewrite the prompt that feeds a generator or LLM Generate, once per node type and model in this conversation; pass the node when it exists.",
    inputShape: getPromptGuideShape,
  },
  {
    name: TOOL_NAMES.viewOutputs,
    title: "Review outputs",
    readOnly: true,
    description:
      "Look at the images the nodes generated, as the user sees them, each captioned with its node, model and prompt. Use it before judging results (quality, consistency, matching the brief) or changing a workflow to fix them, and say what you saw. A video shows its first frame only; audio, 3D models and uploaded images cannot be viewed. Shows what the nodes held when the user sent this message: a run you start this turn is not in it. At most 12 images per call; one call shows them all, so don't repeat it for the same nodes.",
    inputShape: viewOutputsShape,
  },
  {
    name: TOOL_NAMES.runWorkflow,
    title: "Run workflow",
    readOnly: false,
    description:
      "Start a run on the user's canvas, as their Run button does: generators call their models and spend the user's credits. Only when the user asks to run, try or generate. Call it last, after this turn's edits, and once per turn. scope \"nodes\" with the nodes you added or changed when every node feeding them holds its output; \"all\" for the whole workflow; \"from\" a node the user names. Refused while a run is going, and for nodes whose inputs have no output yet (the error says which to include). One run in the user's own workflow starts at once; more than one run, or a run in another tab, waits for the user to press Run under your reply. The run happens after this call: you do not see its results in this turn. The next message's canvas shows each node's status, error and output.",
    inputShape: runWorkflowShape,
  },
  {
    name: TOOL_NAMES.switchWorkflow,
    title: "Switch workflow",
    readOnly: false,
    description:
      "Make another open workflow (tab) the live one, as clicking its tab does: the user's canvas shows it, and your later tool calls this turn read and edit it. Returns its nodes. Refused while a run is going and after you started one.",
    inputShape: switchWorkflowShape,
  },
  {
    name: TOOL_NAMES.newWorkflow,
    title: "New workflow",
    readOnly: false,
    description:
      "Open an empty workflow in a new tab and make it the live one; the current workflow stays open in its own tab. Your later tool calls this turn build in the new one. Refused while a run is going and after you started one.",
    inputShape: newWorkflowShape,
  },
  {
    name: TOOL_NAMES.saveWorkflow,
    title: "Save workflow",
    readOnly: false,
    description:
      "Save the live workflow as the user's Save does: into its project folder, or, the first time, as a new project named `name` (else its current name) in the Node Banana folder. When the user asks, and once you have built a new workflow from scratch (unless they said not to). The save happens in the user's browser after this call, following your edits before it.",
    inputShape: saveWorkflowShape,
  },
  {
    name: TOOL_NAMES.nameConversation,
    title: "Name conversation",
    readOnly: true,
    description:
      "Label this conversation in the user's chat history with a short summary. Call it once in your first reply, together with your other tool calls; call it again only if the conversation moves on to a clearly different task. It changes nothing on the canvas and is not shown in the chat.",
    inputShape: nameConversationShape,
  },
];
