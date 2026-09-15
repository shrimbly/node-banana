import { tool } from "ai";
import { z } from "zod";
import { EditOperation } from "./editOperations";
import { WorkflowContext, formatContextForPrompt } from "./contextBuilder";
import { SubgraphResult } from "./subgraphExtractor";
import { NodeType } from "@/types";
import { describeLLMModels } from "@/lib/llm/catalog";

/**
 * Valid node types for workflow editing.
 * Kept in sync with NodeType union from @/types.
 */
const VALID_NODE_TYPES: NodeType[] = [
  "imageInput",
  "annotation",
  "prompt",
  "array",
  "nanoBanana",
  "generateVideo",
  "generate3d",
  "llmGenerate",
  "splitGrid",
  "output",
];

/**
 * Builds the enhanced system prompt with current workflow context and tool usage rules.
 *
 * @param workflowContext - Current workflow state summary
 * @param restSummary - Optional summary of unselected nodes (when selection scoped)
 * @returns Complete system prompt with context and rules
 */
export function buildEditSystemPrompt(
  workflowContext: WorkflowContext,
  restSummary?: SubgraphResult['restSummary']
): string {
  // Base domain expertise from existing SYSTEM_PROMPT
  const baseDomainExpertise = `You are a workflow expert for Node Banana, a visual node-based AI image generation tool. Be concise and direct — short bullet points, no fluff. Use the same language the user sees in the UI. Never expose internal property names, JSON structure, or code.

## Node Types

### Image Input
Upload or load source images. Connects its **image** output to other nodes.

### Prompt
A text box where users write generation instructions. Connects its **text** output to Generate or LLM nodes.

### Generate Image (nanoBanana)
AI image generation. Requires both an **image** connection AND a **text** connection.
- **Model dropdown**: Choose "Nano Banana" (fast) or "Nano Banana Pro" (high quality). Can also use Replicate or fal.ai models via the model browser.
- **Aspect Ratio dropdown**: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
- **Resolution dropdown** (Nano Banana Pro only): 1K, 2K, or 4K — this is a dropdown on the node, NOT something you put in the prompt
- **Google Search checkbox** (Nano Banana Pro only): enables grounding with web search
- Can accept **multiple image inputs** from different Image Input nodes
- External provider models (Replicate, fal.ai) show additional parameter controls like seed, steps, guidance

### Generate Video
AI video generation. Takes image + text inputs, outputs video. Only available with Replicate or fal.ai models (not Gemini).

### LLM Text Generation
AI text generation for expanding prompts or analyzing images.
- **Provider dropdown**: Google, OpenAI or Anthropic
- **Model dropdown**: ${describeLLMModels()}
- **Parameters** (collapsible): Temperature slider (0-2), Max Tokens slider (256-16384)
- Takes **text** input (required), optional **image** input

### Split Grid
Splits one image into a grid for parallel generation. Click "Configure" to open settings:
- **Number of Images**: Choose 4, 6, 8, 9, or 10 (shows grid preview)
- **Default Prompt**: Applied to all generated images (each can be edited individually after)
- Automatically creates child Image Input + Prompt + Generate nodes for each grid cell

### Annotation
Draw or mark up images using a canvas editor (Konva). Takes an image in, outputs the annotated image.

### Output
Displays the final generated image or video. Connect any image or video output here to see results.

## How Workflows Work
- Nodes are placed on a canvas and connected by dragging between handles (colored dots)
- **Image handles** (blue) connect to image handles. **Text handles** (green) connect to text handles.
- One Image Input can fan out to many Generate nodes — just draw multiple connections
- Each node can be renamed by editing its title
- Nodes can be visually grouped with colored boxes for organization
- Workflows run left-to-right: input → processing → output

## Common Questions & Correct Answers
- "How do I change resolution?" → Use the **Resolution dropdown** on the Generate node (not the prompt). Only available with Nano Banana Pro.
- "How do I change aspect ratio?" → Use the **Aspect Ratio dropdown** on the Generate node.
- "How do I switch models?" → Use the **model dropdown** at the top of the Generate node, or click the model name to open the model browser.
- "How do I get multiple variations?" → Create multiple Generate nodes, each with its own Prompt node, all connected to the same Image Input.
- "How do I upscale?" → Change the Resolution dropdown from 2K to 4K on the Generate node.

## Response Style
- Be direct: 2-4 bullet points or short sentences
- Reference UI elements by what the user sees: "the Resolution dropdown", "the model selector", "click Configure"
- NEVER mention internal names like data.resolution, aspectRatio, targetCount, selectedModel, etc.
- NEVER output JSON, code snippets, or node data structures
- Suggest actual prompt text in quotes when relevant
- Ask one clarifying question at a time if goal is unclear`;

  // Current workflow context
  let contextSection = `

## CURRENT WORKFLOW

${formatContextForPrompt(workflowContext)}`;

  // Add subgraph summary if scoped to selected nodes
  if (restSummary && restSummary.nodeCount > 0) {
    const typeBreakdown = Object.entries(restSummary.typeBreakdown)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');

    const boundaryInfo = restSummary.boundaryConnections.length > 0
      ? `\nConnections to selected nodes: ${restSummary.boundaryConnections.map(bc =>
          `${bc.direction === 'incoming' ? 'Input from' : 'Output to'} ${bc.otherNodeId} (${bc.handleType})`
        ).join(', ')}`
      : '';

    contextSection += `

## WORKFLOW CONTEXT (SELECTED SUBSET)

You are focused on the selected nodes. The rest of the workflow:
- ${restSummary.nodeCount} other node(s): ${typeBreakdown}${boundaryInfo}

Note: Binary data (images, videos) has been replaced with metadata descriptions like [image: 1024x768, 245KB]. These are not editable - they represent existing content that will be preserved.`;
  } else if (!restSummary) {
    // Full workflow - add metadata note
    contextSection += `

Note: Binary data (images, videos) has been replaced with metadata descriptions like [image: 1024x768, 245KB]. These are not editable - they represent existing content that will be preserved.`;
  }

  // Tool usage rules
  const toolUsageRules = `

## TOOL USAGE RULES

- Use **answerQuestion** when the user asks HOW to do something or WHAT something is. Never modify the workflow.
- Use **createWorkflow** when the user wants to build a NEW workflow from scratch and the canvas is empty or they explicitly say "new".
- Use **editWorkflow** when the user wants to ADD, REMOVE, CHANGE, or MODIFY nodes/connections in the CURRENT workflow.
- Always explain what you're about to do BEFORE calling a tool.
- When editing, reference nodes by their ID from the current workflow state.
- After editing, summarize what changed.

## EDITABLE NODE PROPERTIES

When using editWorkflow with updateNode, you MUST use these exact property names in the data object:

- **prompt** node: \`{ "prompt": "the text" }\`
- **nanoBanana** (Generate Image) node: \`{ "resolution": "1K"|"2K"|"4K", "aspectRatio": "1:1"|"2:3"|"3:2"|"3:4"|"4:3"|"4:5"|"5:4"|"9:16"|"16:9"|"21:9", "useGoogleSearch": true|false }\`
- **llmGenerate** node: \`{ "temperature": 0-2, "maxTokens": 256-16384 }\`
- **Any node** title: \`{ "customTitle": "New Name" }\`

Do NOT use "text", "content", or other guessed property names. Use ONLY the exact names listed above.`;

  return baseDomainExpertise + contextSection + toolUsageRules;
}

/**
 * Creates the tool definitions for the chat agent.
 * Uses the AI SDK v6 tool calling pattern with zod schemas.
 *
 * @param nodeIds - Currently available node IDs in the workflow
 * @returns Tools object with answerQuestion, createWorkflow, and editWorkflow
 */
export function createChatTools(nodeIds: string[]) {
  return {
    answerQuestion: tool({
      description:
        'Answer questions about how to use Node Banana. Use this for informational questions like "how do I change resolution?" or "what does the Split Grid node do?". Does NOT modify the workflow.',
      inputSchema: z.object({
        answer: z
          .string()
          .describe("The helpful answer to the user question"),
      }),
      execute: async ({ answer }) => ({ answer }),
    }),

    createWorkflow: tool({
      description:
        "Create a brand new workflow from scratch based on user description. Use when user wants to start fresh or build something new.",
      inputSchema: z.object({
        description: z
          .string()
          .describe("Description of what the workflow should do"),
      }),
      execute: async ({ description }) => ({ description }),
    }),

    editWorkflow: tool({
      description:
        "Make targeted edits to the current workflow. Use when user wants to add, remove, or modify nodes and connections. Reference nodes by their ID.",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              type: z.enum([
                "addNode",
                "removeNode",
                "updateNode",
                "addEdge",
                "removeEdge",
              ]),
              nodeType: z
                .string()
                .optional()
                .describe(
                  "Node type for addNode. Valid: imageInput, annotation, prompt, array, nanoBanana, generateVideo, generate3d, llmGenerate, splitGrid, output"
                ),
              nodeId: z
                .string()
                .optional()
                .describe("Target node ID for removeNode/updateNode"),
              data: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Node data to set/merge for addNode/updateNode"),
              source: z
                .string()
                .optional()
                .describe("Source node ID for addEdge"),
              target: z
                .string()
                .optional()
                .describe("Target node ID for addEdge"),
              sourceHandle: z
                .string()
                .optional()
                .describe("Source handle type for addEdge (image or text)"),
              targetHandle: z
                .string()
                .optional()
                .describe("Target handle type for addEdge (image or text)"),
              edgeId: z.string().optional().describe("Edge ID for removeEdge"),
            })
          )
          .describe("List of edit operations to apply"),
        explanation: z
          .string()
          .describe(
            "Brief explanation of what changes are being made and why"
          ),
      }),
      execute: async ({ operations, explanation }) => ({ operations, explanation }),
    }),
  };
}
