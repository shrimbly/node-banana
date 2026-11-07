import { useToast, type ToastAction } from "@/components/Toast";
import { formatDuration } from "@/components/assets/assetFormat";
import { assetFileUrl } from "@/lib/assets/client/api";
import { newRunId } from "@/lib/assets/client/ids";
import { isRecorderEnabled, recordAsset } from "@/lib/assets/client/recorder";
import type { AssetRunContext, AssetView } from "@/lib/assets/types";
import { useAssetStore } from "@/store/assetStore";
import { currentEditSession, useEditProjectStore } from "@/store/editProjectStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { assetParameters } from "@/store/execution/assetRecording";
import { gatherDraftInputs, stitchEngineOptions, stitchRecordParameters } from "@/store/execution/stitchInputs";

/**
 * Render in the Edit video view: the open edit's draft as it is at the press, encoded by the node's engine with the
 * node's options, kept in the asset library as an edited video of the edit (its id and name stand in for a workflow;
 * no workflow snapshot, no project), and listed in the edit's file. The view stays open; a toast offers Show in
 * Assets and Add to canvas.
 */

/** The canvas adder the view hands in (useAddMediaNode needs React Flow's context, which this module has not). */
export type AddVideoToCanvas = (video: { src: string; filename: string }) => void;

let controller: AbortController | null = null;
let addToCanvas: AddVideoToCanvas | null = null;

export function setRenderCanvasAdder(adder: AddVideoToCanvas | null): void {
  addToCanvas = adder;
}

/** Stop: the encode is aborted; nothing is recorded and no toast is shown. */
export function stopEditRender(): void {
  controller?.abort();
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Runs `then` once no node's editor dialog is open. The dialog would stay over the view a toast's action switches to,
 * so it closes first as Cancel closes it: at once when nothing changed, else after the discard sheet's Discard
 * (Keep editing drops `then`).
 */
function afterNodeDialog(then: () => void): void {
  const s = useStitchEditorStore.getState();
  if (!s.isOpen || s.nodeId === null) return then();
  if (!selectIsDirty(s)) {
    s.close();
    return then();
  }
  s.setDiscardOpen(true);
  const stop = useStitchEditorStore.subscribe((now) => {
    if (!now.isOpen || now.nodeId === null) {
      stop();
      then();
    } else if (!now.discardOpen) stop();
  });
}

/**
 * Show in Assets: the Assets view, with the asset's detail open. A render's toast shows one just made, which the list
 * takes in as new; the media pane's ⋯ one the library already holds (`arrived: false`), which it must not.
 */
export function showInAssets(asset: AssetView, { arrived = true }: { arrived?: boolean } = {}): void {
  afterNodeDialog(() => revealInAssets(asset, arrived));
}

function revealInAssets(asset: AssetView, arrived: boolean): void {
  const assets = useAssetStore.getState();
  if (arrived) assets.receiveArrivals([asset]);
  assets.setAppView("assets");
  assets.openDetail(asset.id);
  // Not on a loaded page (filters, the view not loaded yet, further down the list): the detail shows the record given
  if (useAssetStore.getState().detailAsset === null) useAssetStore.setState({ detailAsset: asset });
}

function canvasAction(asset: AssetView): ToastAction[] {
  if (!addToCanvas) return [];
  const add = addToCanvas;
  return [
    {
      label: "Add to canvas",
      onClick: () => {
        add({ src: assetFileUrl(asset.id), filename: asset.filename });
        // Neutral, as the render's own notice: the Edit video view has no colour but the footage's
        useToast.getState().show("Video added to the canvas", "info", false, null, [
          { label: "Go to canvas", onClick: () => useAssetStore.getState().setAppView("canvas") },
        ]);
      },
    },
  ];
}

export async function renderEdit(): Promise<"rendered" | "stopped" | "failed" | "skipped"> {
  const store = useEditProjectStore.getState();
  const open = store.open;
  const draft = currentEditSession()?.draft;
  if (controller || !open || !draft) return "skipped";
  const edit = { id: open.id, name: open.name };
  const own = new AbortController();
  controller = own;
  const { signal } = own;
  store.setRenderState({ state: "rendering", editId: edit.id, progress: 0, message: null });
  try {
    if (!isRecorderEnabled()) throw new Error("The asset library is off, so the render has nowhere to go.");
    const gathered = await gatherDraftInputs(draft, signal);
    const { stitchVideosAsync } = await import("@/hooks/useStitchVideos");
    const blob = await stitchVideosAsync(
      gathered.clips,
      gathered.music,
      (progress) => {
        if (!signal.aborted) useEditProjectStore.getState().setRenderState({ progress: progress.progress });
      },
      signal,
      stitchEngineOptions(gathered),
    );
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const run: AssetRunContext = {
      runId: newRunId(),
      workflowId: edit.id,
      workflowName: edit.name,
      projectDir: null,
      startedAt: Date.now(),
    };
    const handle = recordAsset(
      {
        kind: "video",
        origin: "edited",
        media: blob,
        mime: blob.type || "video/mp4",
        parameters: assetParameters(stitchRecordParameters(gathered)),
        producer: { nodeId: edit.id, nodeType: "editProject", nodeTitle: edit.name, operation: "stitch" },
      },
      run,
    );
    const result = await handle.done;
    if (!result) throw new Error("The render could not be kept in the asset library.");
    const asset = result.asset;
    void useEditProjectStore.getState().addRender(edit.id, {
      assetId: asset.id,
      renderedAt: Date.now(),
      durationSec: typeof asset.durationSec === "number" && Number.isFinite(asset.durationSec) ? asset.durationSec : null,
    });
    useEditProjectStore.getState().setRenderState({ state: "idle", progress: 100, message: null });
    const length = typeof asset.durationSec === "number" && asset.durationSec > 0 ? ` · ${formatDuration(asset.durationSec)}` : "";
    // Neutral, not the app's green success: in the Edit video view it would be the one strong colour
    useToast.getState().show(`Rendered “${edit.name}”${length}`, "info", false, null, [
      { label: "Show in Assets", onClick: () => showInAssets(asset) },
      ...canvasAction(asset),
    ]);
    return "rendered";
  } catch (error) {
    if (isAbort(error) || signal.aborted) {
      useEditProjectStore.getState().setRenderState({ state: "idle", progress: 0, message: null });
      return "stopped";
    }
    const message = error instanceof Error ? error.message : String(error);
    useEditProjectStore.getState().setRenderState({ state: "failed", progress: 0, message });
    useToast.getState().show(`Couldn't render “${edit.name}”`, "error", false, message);
    return "failed";
  } finally {
    if (controller === own) controller = null;
  }
}
