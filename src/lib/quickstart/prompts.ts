import { ContentLevel } from "./templates";

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
- Outputs: "image" handle (green)
- Data structure:
  {
    "image": null,
    "filename": null,
    "dimensions": null
  }

### 2. prompt
Purpose: Text prompts that feed into generation or LLM nodes
- Outputs: "text" handle (blue)
- Data structure:
  {
    "prompt": "${contentLevel === "empty" ? "" : contentLevel === "minimal" ? "Enter your prompt here..." : "Your detailed prompt text"}"
  }

### 3. annotation
Purpose: Draw/annotate on images before generation
- Inputs: "image" handle
- Outputs: "image" handle
- Data structure:
  {
    "sourceImage": null,
    "annotations": [],
    "outputImage": null
  }

### 4. nanoBanana
Purpose: AI image generation using Gemini (REQUIRES both image AND text inputs)
- Inputs: "image" handle (accepts multiple), "text" handle (required)
- Outputs: "image" handle
- Data structure:
  {
    "inputImages": [],
    "inputPrompt": null,
    "outputImage": null,
    "aspectRatio": "1:1",
    "resolution": "1K",
    "model": "nano-banana-pro",
    "useGoogleSearch": false,
    "status": "idle",
    "error": null,
    "imageHistory": [],
    "selectedHistoryIndex": 0
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
    "provider": "google",
    "model": "gemini-3-flash-preview",
    "temperature": 0.7,
    "maxTokens": 8192,
    "status": "idle",
    "error": null
  }

### 6. output
Purpose: Display final generated images
- Inputs: "image" handle
- Data structure:
  {
    "image": null
  }

## Connection Rules (VERY IMPORTANT)
1. "image" handles can ONLY connect to "image" handles
2. "text" handles can ONLY connect to "text" handles
3. nanoBanana REQUIRES both an image input AND a text input to work
4. Connections flow from source (output) to target (input)

## Node Layout Guidelines
- Start input nodes on the left (x: 50-100)
- Flow left to right
- Horizontal spacing: ~400px between columns
- Vertical spacing: ~330px between rows
- Use these dimensions:
  - imageInput: { width: 300, height: 280 }
  - annotation: { width: 300, height: 280 }
  - prompt: { width: 320, height: 220 }
  - nanoBanana: { width: 300, height: 300 }
  - llmGenerate: { width: 320, height: 360 }
  - output: { width: 320, height: 320 }

## Node ID Format
Use format: "{type}-{number}" (e.g., "imageInput-1", "prompt-1", "nanoBanana-1")

## Edge ID Format
Use format: "edge-{source}-{target}-{sourceHandle}-{targetHandle}"

## Content Level: ${contentLevel.toUpperCase()}
${contentLevel === "empty" ? "- Leave ALL prompt fields completely empty (empty string)" : ""}
${contentLevel === "minimal" ? '- Add brief placeholder prompts like "Describe your style here..." or "Enter your prompt..."' : ""}
${contentLevel === "full" ? "- Add complete, detailed example prompts that demonstrate the workflow's purpose" : ""}

## User's Request
"${description}"

## Required JSON Structure
{
  "version": 1,
  "id": "wf_${timestamp}_quickstart",
  "name": "Descriptive Workflow Name",
  "nodes": [
    {
      "id": "nodeType-1",
      "type": "nodeType",
      "position": { "x": 50, "y": 100 },
      "data": { ... },
      "style": { "width": 300, "height": 280 }
    }
  ],
  "edges": [
    {
      "id": "edge-source-target-handle-handle",
      "source": "sourceNodeId",
      "sourceHandle": "image|text",
      "target": "targetNodeId",
      "targetHandle": "image|text"
    }
  ],
  "edgeStyle": "curved"
}

Generate a practical, well-organized workflow for: "${description}"

OUTPUT ONLY THE JSON:`;
}

/**
 * Build a simpler prompt for quick generation
 */
export function buildSimplePrompt(description: string): string {
  return `Create a Node Banana workflow JSON for: "${description}"

Node types: imageInput (output: image), prompt (output: text), nanoBanana (inputs: image+text, output: image), llmGenerate (input: text, output: text), annotation (input: image, output: image), output (input: image).

Rules:
- nanoBanana NEEDS both image and text inputs
- image handles connect to image, text to text
- Node IDs: type-number (e.g., imageInput-1)
- Edge IDs: edge-source-target-sourceHandle-targetHandle

Return ONLY valid JSON with: version:1, name, nodes[], edges[], edgeStyle:"curved"`;
}
