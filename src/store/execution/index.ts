/**
 * Node Executor Registry
 *
 * Maps node types to their executor functions.
 * Used by executeWorkflow and regenerateNode to eliminate
 * duplicated switch/if-else chains.
 */

export type { NodeExecutionContext, NodeExecutor } from "./types";

export {
  executeAnnotation,
  executeArray,
  executePrompt,
  executePromptConstructor,
  executeOutput,
  executeOutputGallery,
  executeImageCompare,
  executeGlbViewer,
  executeRouter,
  executeSwitch,
  executeConditionalSwitch,
} from "./simpleNodeExecutors";

export { executeNanoBanana } from "./nanoBananaExecutor";
export type { NanoBananaOptions } from "./nanoBananaExecutor";

export {
  executeGenerateVideo,
  applyVideoGenerationResult,
  recordVideoGenerationFailure,
} from "./generateVideoExecutor";
export type { GenerateVideoOptions } from "./generateVideoExecutor";
export { pollGenerateTask } from "./pollTaskCompletion";
export { pollLocalGenerationRun } from "./persistentGeneration";

export { executeGenerate3D } from "./generate3dExecutor";
export type { Generate3DOptions } from "./generate3dExecutor";

export { executeGenerateAudio } from "./generateAudioExecutor";
export type { GenerateAudioOptions } from "./generateAudioExecutor";

export { executeLlmGenerate } from "./llmGenerateExecutor";
export type { LlmGenerateOptions } from "./llmGenerateExecutor";

export { executeSplitGrid } from "./splitGridExecutor";

export {
  executeVideoStitch,
  executeEaseCurve,
  executeVideoTrim,
  executeVideoFrameGrab,
} from "./videoProcessingExecutors";

export { executeRemoveBackground } from "./removeBackgroundExecutor";
export { executeImageResize, executeGifEncoder } from "./imageProcessingExecutors";

export { executeComfyApp } from "./comfyAppExecutor";

export { runBatchIfApplicable } from "./batchExecution";
