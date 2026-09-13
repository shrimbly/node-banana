/**
 * The static handles and display title of every node type. The canvas uses
 * it to validate connections and title node headers; the split grid cell
 * editor builds its node catalogue from it, so a node type added here is
 * connectable on the canvas and available in a cell without further wiring.
 *
 * Nodes whose handles come from data (schema-driven generators, switches,
 * Comfy apps) list the static superset here; the real set is read from the
 * node at connection time.
 */

export interface NodeHandleIds {
  inputs: string[];
  outputs: string[];
}

export const getNodeHandles = (nodeType: string): NodeHandleIds => {
  switch (nodeType) {
    case "imageInput":
      return { inputs: ["reference"], outputs: ["image"] };
    case "audioInput":
      return { inputs: ["audio"], outputs: ["audio"] };
    case "videoInput":
      return { inputs: ["video"], outputs: ["video"] };
    case "annotation":
      return { inputs: ["image"], outputs: ["image"] };
    case "prompt":
      return { inputs: ["text"], outputs: ["text"] };
    case "array":
      return { inputs: ["text"], outputs: ["text"] };
    case "promptConstructor":
      return { inputs: ["text"], outputs: ["text"] };
    case "nanoBanana":
      return { inputs: ["image", "text"], outputs: ["image"] };
    case "generateVideo":
      return { inputs: ["image", "video", "text", "audio"], outputs: ["video"] };
    case "generate3d":
      return { inputs: ["image", "text"], outputs: ["3d"] };
    case "generateAudio":
      return { inputs: ["text"], outputs: ["audio"] };
    case "llmGenerate":
      return { inputs: ["text", "image"], outputs: ["text"] };
    case "splitGrid":
      return { inputs: ["image"], outputs: ["reference"] };
    case "output":
      return { inputs: ["image", "video", "audio"], outputs: [] };
    case "outputGallery":
      return { inputs: ["image", "video"], outputs: [] };
    case "imageCompare":
      return { inputs: ["image"], outputs: [] };
    case "videoStitch":
      return { inputs: ["video", "audio"], outputs: ["video"] };
    case "easeCurve":
      return { inputs: ["video", "easeCurve"], outputs: ["video", "easeCurve"] };
    case "videoTrim":
      return { inputs: ["video"], outputs: ["video"] };
    case "videoFrameGrab":
      return { inputs: ["video"], outputs: ["image"] };
    case "removeBackground":
    case "imageResize":
      return { inputs: ["image"], outputs: ["image"] };
    case "gifEncoder":
      return { inputs: ["image"], outputs: ["image"] };
    case "router":
      return { inputs: ["image", "text", "video", "audio", "3d", "easeCurve", "generic-input"], outputs: ["image", "text", "video", "audio", "3d", "easeCurve", "generic-output"] };
    case "switch":
      // Switch has one input handle (generic-input when disconnected, typed when connected)
      // Output handles are dynamic based on switches array, all matching inputType
      return { inputs: ["generic-input"], outputs: [] }; // Outputs handled dynamically in SwitchNode
    case "conditionalSwitch":
      // Conditional Switch has one text input and dynamic rule outputs + default
      return { inputs: ["text"], outputs: [] }; // Outputs handled dynamically in ConditionalSwitchNode
    case "glbViewer":
      return { inputs: ["3d"], outputs: ["image"] };
    case "comfyApp":
      // Handles come from the attached ComfyUI workflow's contract, so the
      // static list is the superset every app could expose. The real per-node
      // set is read from `inputSchema` / `app.outputs` at connection time.
      return { inputs: ["image", "text", "video", "audio"], outputs: ["image", "text", "video", "audio", "3d"] };
    default:
      return { inputs: [], outputs: [] };
  }
};

/** Node title mapping for FloatingNodeHeaders */
export const NODE_TITLES: Record<string, string> = {
  imageInput: 'Image Input',
  audioInput: 'Audio Input',
  videoInput: 'Video Input',
  annotation: 'Annotation',
  prompt: 'Prompt',
  array: 'Array',
  promptConstructor: 'Prompt Constructor',
  nanoBanana: 'Generate Image',
  generateVideo: 'Generate Video',
  generate3d: 'Generate 3D',
  generateAudio: 'Generate Audio',
  llmGenerate: 'LLM Generate',
  splitGrid: 'Split Grid',
  output: 'Output',
  outputGallery: 'Output Gallery',
  imageCompare: 'Image Compare',
  videoStitch: 'Video Stitch',
  easeCurve: 'Ease Curve',
  videoTrim: 'Video Trim',
  videoFrameGrab: 'Frame Grab',
  removeBackground: 'Remove Background',
  imageResize: 'Image Resize',
  gifEncoder: 'GIF Encoder',
  router: 'Router',
  switch: 'Switch',
  conditionalSwitch: 'Conditional Switch',
  glbViewer: '3D Viewer',
  comfyApp: 'ComfyUI App',
};
