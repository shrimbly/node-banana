import { ContentLevel } from "./templates";
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER } from "@/lib/llm/catalog";

/**
 * Build a comprehensive prompt for Gemini to generate a workflow
 */
export function buildQuickstartPrompt(
  description: string,
  contentLevel: ContentLevel
): string {
  const timestamp = Date.now();

  return `You are a workflow designer for Node Banana, a visual node-based AI image generation tool. Your task is to create a workflow JSON based on the user's description.

## CRITICAL: OUTPUT FORMAT
You MUST output ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object starting with { and ending with }.

## Available Node Types

### 1. imageInput
Purpose: Load/display input images from user
- Outputs: "image" handle (green, right side of node)
- Data structure:
  {
    "image": null,
    "filename": null,
    "dimensions": null,
    "customTitle": "Descriptive name for this input"
  }

### 2. prompt
Purpose: Text prompts that feed into generation or LLM nodes
- Outputs: "text" handle (blue, right side of node)
- Data structure:
  {
    "prompt": "${contentLevel === "empty" ? "" : contentLevel === "minimal" ? "Enter your prompt here..." : "Your detailed prompt text"}",
    "customTitle": "Descriptive name for this prompt"
  }

### 3. annotation
Purpose: Draw/annotate on images before generation. Only use this if the user asks for annotation capability.
- Inputs: "image" handle (left side)
- Outputs: "image" handle (right side)
- Data structure:
  {
    "sourceImage": null,
    "annotations": [],
    "outputImage": null,
    "customTitle": "Annotation step"
  }

### 4. nanoBanana
Purpose: AI image generation using Gemini (REQUIRES both image AND text inputs). This is the primary node for image generation.
- Inputs: "image" handle (accepts multiple connections), "text" handle (required)
- Outputs: "image" handle
- IMPORTANT: Always use "nano-banana-pro" model with "2K" resolution by default unless the user specifically requests otherwise.
- Data structure:
  {
    "inputImages": [],
    "inputPrompt": null,
    "outputImage": null,
    "aspectRatio": "1:1",
    "resolution": "2K",
    "model": "nano-banana-pro",
    "useGoogleSearch": false,
    "status": "idle",
    "error": null,
    "imageHistory": [],
    "selectedHistoryIndex": 0,
    "customTitle": "Generation step name"
  }

### 5. llmGenerate
Purpose: Text generation using LLM (for prompt expansion, analysis, etc.)
- Inputs: "text" handle (required), "image" handle (optional)
- Outputs: "text" handle
- Data structure:
  {
    "inputPrompt": null,
    "inputImages": [],
    "outputText": null,
    "provider": "${DEFAULT_LLM_PROVIDER}",
    "model": "${DEFAULT_LLM_MODEL}",
    "temperature": 0.7,
    "maxTokens": 8192,
    "status": "idle",
    "error": null,
    "customTitle": "LLM step name"
  }

### 6. splitGrid
Purpose: Split a grid/contact sheet image into individual cells for parallel processing. Use this when the user wants to generate a grid of images and then process each cell separately.
- Inputs: "image" handle (left side)
- Outputs: "reference" handle (connects to child imageInput nodes)
- IMPORTANT: When using splitGrid, you MUST also create the child nodes for each grid cell:
  - For each cell: 1 imageInput + 1 prompt + 1 nanoBanana
  - For a 2x2 grid (4 cells): create 4 imageInputs, 4 prompts, 4 nanoBananas
  - Connect splitGrid → each imageInput via "reference" handles
  - Connect each imageInput → its nanoBanana via "image" handles
  - Connect each prompt → its nanoBanana via "text" handles
- Data structure:
  {
    "sourceImage": null,
    "targetCount": 4,
    "gridRows": 2,
    "gridCols": 2,
    "defaultPrompt": "Enhance this frame...",
    "generateSettings": {
      "aspectRatio": "2:3",
      "resolution": "2K",
      "model": "nano-banana-pro",
      "useGoogleSearch": false
    },
    "childNodeIds": [
      { "imageInput": "imageInput-10", "prompt": "prompt-10", "nanoBanana": "nanoBanana-10" },
      { "imageInput": "imageInput-11", "prompt": "prompt-11", "nanoBanana": "nanoBanana-11" },
      { "imageInput": "imageInput-12", "prompt": "prompt-12", "nanoBanana": "nanoBanana-12" },
      { "imageInput": "imageInput-13", "prompt": "prompt-13", "nanoBanana": "nanoBanana-13" }
    ],
    "isConfigured": true,
    "status": "idle",
    "error": null,
    "customTitle": "Split Grid"
  }

### 7. output
Purpose: Display final generated images (optional - not required)
- Inputs: "image" handle (left side)
- Data structure:
  {
    "image": null,
    "customTitle": "Final output"
  }

## EDGES/CONNECTIONS - CRITICAL SECTION

Edges connect nodes together. Every edge MUST have these fields:

\`\`\`json
{
  "id": "edge-{sourceNodeId}-{targetNodeId}-{sourceHandle}-{targetHandle}",
  "source": "{sourceNodeId}",
  "sourceHandle": "{handleType}",
  "target": "{targetNodeId}",
  "targetHandle": "{handleType}"
}
\`\`\`

### Connection Rules
1. **Type matching is mandatory**:
   - "image" handles connect ONLY to "image" handles
   - "text" handles connect ONLY to "text" handles
2. **Direction**: Data flows from source (output, right side) → target (input, left side)
3. **nanoBanana nodes REQUIRE TWO incoming edges**:
   - One edge bringing "image" data
   - One edge bringing "text" data
4. **Multiple image inputs**: nanoBanana can receive multiple image edges (for multi-image context)

### Edge Examples

**Connecting imageInput to nanoBanana (image → image):**
\`\`\`json
{
  "id": "edge-imageInput-1-nanoBanana-1-image-image",
  "source": "imageInput-1",
  "sourceHandle": "image",
  "target": "nanoBanana-1",
  "targetHandle": "image"
}
\`\`\`

**Connecting prompt to nanoBanana (text → text):**
\`\`\`json
{
  "id": "edge-prompt-1-nanoBanana-1-text-text",
  "source": "prompt-1",
  "sourceHandle": "text",
  "target": "nanoBanana-1",
  "targetHandle": "text"
}
\`\`\`

**Chaining nanoBanana to nanoBanana (image → image):**
\`\`\`json
{
  "id": "edge-nanoBanana-1-nanoBanana-2-image-image",
  "source": "nanoBanana-1",
  "sourceHandle": "image",
  "target": "nanoBanana-2",
  "targetHandle": "image"
}
\`\`\`

**Connecting prompt to llmGenerate, then llmGenerate to nanoBanana:**
\`\`\`json
{
  "id": "edge-prompt-1-llmGenerate-1-text-text",
  "source": "prompt-1",
  "sourceHandle": "text",
  "target": "llmGenerate-1",
  "targetHandle": "text"
},
{
  "id": "edge-llmGenerate-1-nanoBanana-1-text-text",
  "source": "llmGenerate-1",
  "sourceHandle": "text",
  "target": "nanoBanana-1",
  "targetHandle": "text"
}
\`\`\`

**Connecting nanoBanana output to splitGrid (for splitting a grid image):**
\`\`\`json
{
  "id": "edge-nanoBanana-1-splitGrid-1-image-image",
  "source": "nanoBanana-1",
  "sourceHandle": "image",
  "target": "splitGrid-1",
  "targetHandle": "image"
}
\`\`\`

**Connecting splitGrid to its child imageInput nodes (reference edges):**
\`\`\`json
{
  "id": "edge-splitGrid-1-imageInput-10-reference-reference",
  "source": "splitGrid-1",
  "sourceHandle": "reference",
  "target": "imageInput-10",
  "targetHandle": "reference",
  "type": "reference"
}
\`\`\`

**Connecting child nodes within a splitGrid cell (imageInput + prompt → nanoBanana):**
\`\`\`json
{
  "id": "edge-imageInput-10-nanoBanana-10-image-image",
  "source": "imageInput-10",
  "sourceHandle": "image",
  "target": "nanoBanana-10",
  "targetHandle": "image"
},
{
  "id": "edge-prompt-10-nanoBanana-10-text-text",
  "source": "prompt-10",
  "sourceHandle": "text",
  "target": "nanoBanana-10",
  "targetHandle": "text"
}
\`\`\`

## Node Layout Guidelines
- Start input nodes on the left (x: 50-150)
- Flow left to right, increasing x position
- Horizontal spacing: ~350-400px between columns
- Vertical spacing: ~300-330px between rows
- Prompt nodes should be positioned near the generation node they feed into
- Use these dimensions:
  - imageInput: { width: 300, height: 280 }
  - annotation: { width: 300, height: 280 }
  - prompt: { width: 320, height: 220 }
  - nanoBanana: { width: 300, height: 300 }
  - llmGenerate: { width: 320, height: 360 }
  - splitGrid: { width: 300, height: 320 }
  - output: { width: 320, height: 320 }

## Groups (Optional - for organizing complex workflows)

Groups visually organize related nodes. Include if the workflow has 4+ nodes:

\`\`\`json
"groups": {
  "group-1": {
    "id": "group-1",
    "name": "Input Images",
    "color": "blue",
    "position": { "x": 30, "y": 80 },
    "size": { "width": 360, "height": 600 }
  }
}
\`\`\`

Nodes reference their group via \`"groupId": "group-1"\`.
Available colors: "neutral", "blue", "green", "purple", "orange"

## Node ID Format
Use format: "{type}-{number}" starting from 1
Examples: "imageInput-1", "imageInput-2", "prompt-1", "nanoBanana-1"

## Content Level: ${contentLevel.toUpperCase()}
${contentLevel === "empty" ? "- Leave ALL prompt fields completely empty (empty string)" : ""}
${contentLevel === "minimal" ? '- Add brief placeholder prompts like "Describe your scene here..." or "Enter style instructions..."' : ""}
${contentLevel === "full" ? "- Add complete, detailed example prompts that demonstrate the workflow's purpose" : ""}

## COMPLETE EXAMPLE WORKFLOW

Here is an example of a "Background Swap" workflow that combines a character with a new background:

\`\`\`json
{
  "version": 1,
  "id": "wf_${timestamp}_quickstart",
  "name": "Background Swap",
  "nodes": [
    {
      "id": "imageInput-1",
      "type": "imageInput",
      "position": { "x": 50, "y": 100 },
      "data": {
        "image": null,
        "filename": null,
        "dimensions": null,
        "customTitle": "Character"
      },
      "style": { "width": 300, "height": 280 }
    },
    {
      "id": "imageInput-2",
      "type": "imageInput",
      "position": { "x": 50, "y": 420 },
      "data": {
        "image": null,
        "filename": null,
        "dimensions": null,
        "customTitle": "New Background"
      },
      "style": { "width": 300, "height": 280 }
    },
    {
      "id": "prompt-1",
      "type": "prompt",
      "position": { "x": 400, "y": 100 },
      "data": {
        "prompt": "Place the character from the first image into the background scene from the second image. Match the lighting and color grading so it looks like a natural photograph. Preserve all details of the character's appearance.",
        "customTitle": "Combine Instructions"
      },
      "style": { "width": 320, "height": 220 }
    },
    {
      "id": "nanoBanana-1",
      "type": "nanoBanana",
      "position": { "x": 780, "y": 200 },
      "data": {
        "inputImages": [],
        "inputPrompt": null,
        "outputImage": null,
        "aspectRatio": "1:1",
        "resolution": "2K",
        "model": "nano-banana-pro",
        "useGoogleSearch": false,
        "status": "idle",
        "error": null,
        "imageHistory": [],
        "selectedHistoryIndex": 0,
        "customTitle": "Generate Composite"
      },
      "style": { "width": 300, "height": 300 }
    }
  ],
  "edges": [
    {
      "id": "edge-imageInput-1-nanoBanana-1-image-image",
      "source": "imageInput-1",
      "sourceHandle": "image",
      "target": "nanoBanana-1",
      "targetHandle": "image"
    },
    {
      "id": "edge-imageInput-2-nanoBanana-1-image-image",
      "source": "imageInput-2",
      "sourceHandle": "image",
      "target": "nanoBanana-1",
      "targetHandle": "image"
    },
    {
      "id": "edge-prompt-1-nanoBanana-1-text-text",
      "source": "prompt-1",
      "sourceHandle": "text",
      "target": "nanoBanana-1",
      "targetHandle": "text"
    }
  ],
  "edgeStyle": "curved"
}
\`\`\`

Notice how:
- Every nanoBanana has BOTH image edge(s) AND a text edge connected to it
- Edge IDs follow the pattern exactly: "edge-{source}-{target}-{sourceHandle}-{targetHandle}"
- Nodes are laid out left-to-right with proper spacing
- customTitle makes each node's purpose clear

## User's Request
"${description}"

## CHECKLIST BEFORE OUTPUT
1. ✓ Every nanoBanana node has at least one "image" edge AND one "text" edge targeting it
2. ✓ All edge IDs follow the format: "edge-{source}-{target}-{sourceHandle}-{targetHandle}"
3. ✓ Handle types match: image→image, text→text, reference→reference
4. ✓ Nodes have customTitle fields describing their purpose
5. ✓ Layout flows left-to-right with proper spacing
6. ✓ If using splitGrid: child nodes are created (imageInput + prompt + nanoBanana per cell), childNodeIds array is populated, and reference edges connect splitGrid to each child imageInput

Generate a practical, well-organized workflow for: "${description}"

OUTPUT ONLY THE JSON:`;
}

/**
 * Build a simpler prompt for quick generation
 */
export function buildSimplePrompt(description: string): string {
  return `Create a Node Banana workflow JSON for: "${description}"

Node types: imageInput (output: image), prompt (output: text), nanoBanana (inputs: image+text, output: image), llmGenerate (input: text, output: text), annotation (input: image, output: image), splitGrid (input: image, creates child nodes for each cell), output (input: image).

Rules:
- nanoBanana NEEDS both image and text inputs - create edges for BOTH
- image handles connect to image, text to text
- Node IDs: type-number (e.g., imageInput-1)
- Edge IDs: edge-source-target-sourceHandle-targetHandle
- Every edge needs: id, source, sourceHandle, target, targetHandle

Return ONLY valid JSON with: version:1, name, nodes[], edges[], edgeStyle:"curved"`;
}
