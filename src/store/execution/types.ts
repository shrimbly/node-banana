/**
 * Node Executor Types
 *
 * Defines the interface for per-node-type execution functions.
 * Used by both executeWorkflow and regenerateNode to avoid duplication.
 */

import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeData,
  ProviderSettings,
  ImageHistoryItem,
  RunBatchTag,
  SelectedModel,
} from "@/types";
import type { ConnectedInputs } from "@/store/utils/connectedInputs";
import type { AssetRunContext, RecordAssetInput, RecordedAssetHandle } from "@/lib/assets/types";

/**
 * Context passed to every node executor.
 *
 * - `node`: The node being executed (may be stale; use `getFreshNode` for current data).
 * - `getConnectedInputs`: Returns upstream images/text/etc. for this node.
 * - `updateNodeData`: Zustand partial-data updater for any node.
 * - `getFreshNode`: Returns the current node data from the store (not the stale sorted copy).
 * - `getEdges`: Returns current edges from the store.
 * - `getNodes`: Returns current nodes from the store.
 * - `signal`: AbortSignal for cancellable fetch calls (only present in executeWorkflow).
 * - `providerSettings`: API key settings for providers.
 * - `addIncurredCost`: Tracks cost for billing.
 * - `addToGlobalHistory`: Adds an image or video to the recent-generations list, with its recording if it has one.
 * - `generationsPath`: Path for auto-saving generations (null if not configured).
 * - `saveDirectoryPath`: Path for output node file saving (null if not configured).
 * - `trackSaveGeneration`: Registers a save-generation promise in pendingImageSyncs so auto-save waits.
 * - `assetRun` / `recordAsset`: The run this node belongs to and the asset library's recorder.
 *   Present only while the library is available and a run is in progress; without them,
 *   executors fall back to saving into `generationsPath`.
 * - `get`: Raw store accessor for edge cases.
 */
export interface NodeExecutionContext {
  node: WorkflowNode;
  getConnectedInputs: (nodeId: string) => ConnectedInputs;
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  getFreshNode: (nodeId: string) => WorkflowNode | undefined;
  getEdges: () => WorkflowEdge[];
  getNodes: () => WorkflowNode[];
  signal?: AbortSignal;
  providerSettings: ProviderSettings;
  addIncurredCost: (cost: number) => void;
  addToGlobalHistory: (item: Omit<ImageHistoryItem, "id">, recording?: RecordedAssetHandle | null) => void;
  /** Set during a batch ("Run 10×"): which run this is. Goes on the node's carousel entries. */
  batch?: RunBatchTag;
  generationsPath: string | null;
  saveDirectoryPath: string | null;
  trackSaveGeneration: (key: string, promise: Promise<void>) => void;
  appendOutputGalleryImage: (targetId: string, image: string) => void;
  appendOutputGalleryVideo: (targetId: string, video: string) => void;
  /** Rebuilds a splitGrid node's cells from its template when stale; returns true if rebuilt */
  materializeSplitGridCells: (nodeId: string) => boolean;
  /** Release a replaced media URL, unless a node, tab, the clipboard or undo history still holds it. */
  releaseMediaUrl?: (url: string | null | undefined) => void;
  assetRun?: AssetRunContext;
  /** Saves an output to the asset library. Returns at once; the id can go into node data with the output. */
  recordAsset?: (input: RecordAssetInput) => RecordedAssetHandle;
  get: () => unknown;
}

/**
 * A node executor function.
 * Receives the execution context and performs the node's work.
 * May throw on error (caller handles error reporting).
 */
export type NodeExecutor = (ctx: NodeExecutionContext) => Promise<void>;

/**
 * What a generate run asked /api/generate for, which its output is recorded
 * with. A request picked up again rebuilds it from the node (resumeGeneration).
 */
export interface GenerationRequest {
  selectedModel: SelectedModel;
  prompt: string | null;
  parameters?: Record<string, unknown>;
  dynamicInputs: Record<string, string | string[]>;
}
