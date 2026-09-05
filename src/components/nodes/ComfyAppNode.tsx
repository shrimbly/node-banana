"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";

import { NodeShell } from "./NodeShell";
import { ComfyAppParameters } from "./ComfyAppParameters";
import { ControlsCard, HeightGrip, SummaryValues, type SocketSpec, type SocketType } from "./ui";
import {
  ComfyWorkflowImportModal,
  type ComfyReconfigureTarget,
  type ComfyUpload,
} from "@/components/modals/ComfyWorkflowImportModal";
import { ComfyWordmark } from "@/components/icons/ComfyWordmark";
import { useComfyPreview } from "@/hooks/useComfyPreview";
import { useWorkflowStore } from "@/store/workflowStore";
import { outputsToNodeData } from "@/store/execution/comfyAppExecutor";
import { appInputHandles, appToInputSchema } from "@/lib/comfy/nodeSchema";
import { mergeParamValues } from "@/lib/comfy/reconfigure";
import type {
  ComfyAppDefinition,
  ComfyInputType,
  ComfyOutputType,
  ComfyWorkflowInspection,
} from "@/lib/comfy/types";
import type { ComfyAppNodeData } from "@/types";
import { downloadMedia } from "@/utils/downloadMedia";

type ComfyAppNodeType = Node<ComfyAppNodeData, "comfyApp">;

const SOCKET_TYPES = new Set<string>(["image", "text", "audio", "video", "3d"]);

function asSocketType(type: string): SocketType {
  return (SOCKET_TYPES.has(type) ? type : "image") as SocketType;
}

/** Media slot height when the output is not something with a picture. */
const TEXTUAL_HEIGHT = 120;
/** Media slot height while there is no workflow to run. */
const EMPTY_HEIGHT = 150;

export function ComfyAppNode({ id, data, selected }: NodeProps<ComfyAppNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  /** `replace` picks a different workflow; `edit` revisits this one's picks. */
  const [modal, setModal] = useState<"replace" | "edit" | null>(null);
  /** A workflow dropped on the canvas, to be read instead of asking for a file. */
  const [dropped, setDropped] = useState<ComfyUpload | null>(null);

  // Created from the connection menu, which had nowhere to attach its wire —
  // go straight to choosing a workflow so the node becomes usable.
  useEffect(() => {
    if (!nodeData._autoOpenImport) return;
    setModal("replace");
    updateNodeData(id, { _autoOpenImport: false });
  }, [nodeData._autoOpenImport, id, updateNodeData]);

  // Created by dropping a ComfyUI workflow onto the canvas: skip the file step
  // and read the dropped file straight away. It moves into local state because
  // it belongs to this import, not to the node — a saved workflow should not
  // carry a copy of the upload it was built from.
  useEffect(() => {
    const pending = nodeData._pendingWorkflow;
    if (!pending) return;
    setDropped(pending);
    setModal("replace");
    updateNodeData(id, { _pendingWorkflow: null });
  }, [nodeData._pendingWorkflow, id, updateNodeData]);

  const edges = useWorkflowStore((state) => state.edges);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);

  const app = nodeData.app;

  // Handles are derived from the app contract, and `inputSchema` is what maps a
  // handle back to its graph binding at run time (via `dynamicInputs`). Keep it
  // in sync whenever the attached workflow changes.
  useEffect(() => {
    if (!app) return;
    const schema = appToInputSchema(app);
    const current = nodeData.inputSchema;
    if (JSON.stringify(current) === JSON.stringify(schema)) return;
    updateNodeData(id, { inputSchema: schema });
  }, [app, id, nodeData.inputSchema, updateNodeData]);

  /** Input handles, grouped by type so ids stay `image-0`, `text-0`, … */
  const inputHandles = useMemo(() => (app ? appInputHandles(app) : []), [app]);

  const outputHandles = useMemo(() => app?.outputs ?? [], [app]);

  /**
   * Re-register the handles whenever the contract changes them.
   *
   * React Flow reads a node's handles once, when it measures the node, and
   * caches where they are. Every other node declares its handles up front, but
   * this one has none until a workflow is attached — so the ones that appear
   * afterwards are invisible to the connection system: a wire dropped on them
   * lands nowhere, and an edge made anyway cannot be drawn. Resizing the node
   * forces a re-measure, which is why that appeared to fix it.
   */
  const updateNodeInternals = useUpdateNodeInternals();
  const handleIds = useMemo(
    () => [...inputHandles.map((i) => i.handleId), ...outputHandles.map((o) => o.id)].join("|"),
    [inputHandles, outputHandles]
  );
  useEffect(() => {
    updateNodeInternals(id);
  }, [handleIds, id, updateNodeInternals]);

  /**
   * Drop edges bound to handles the incoming contract does not declare.
   *
   * They would otherwise hang off the node with nowhere to attach — invisible,
   * unselectable, yet still counted as a dependency when the graph runs.
   */
  const pruneStaleEdges = useCallback(
    (attached: ComfyAppDefinition) => {
      const inputHandleIds = new Set(appInputHandles(attached).map((input) => input.handleId));
      const outputHandleIds = new Set(attached.outputs.map((o) => o.id));
      for (const edge of edges) {
        if (edge.target === id && edge.targetHandle && !inputHandleIds.has(edge.targetHandle)) {
          removeEdge(edge.id);
        } else if (edge.source === id && edge.sourceHandle && !outputHandleIds.has(edge.sourceHandle)) {
          removeEdge(edge.id);
        }
      }
    },
    [edges, id, removeEdge]
  );

  const handleAttach = useCallback(
    (
      attached: ComfyAppDefinition,
      inspection: ComfyWorkflowInspection | undefined,
      meta?: { savedNodeId?: string }
    ) => {
      pruneStaleEdges(attached);
      updateNodeData(id, {
        app: attached,
        inspection,
        // Cleared unless this came from the library: a node that has been given
        // a different workflow is no longer the saved one, and offering to
        // "update" that entry with it would overwrite something else entirely.
        savedNodeId: meta?.savedNodeId,
        inputSchema: appToInputSchema(attached),
        // A new contract invalidates the previous run entirely — old parameter
        // ids point at nodes the new graph may not even have.
        paramValues: Object.fromEntries(
          attached.params
            .filter((p) => p.default !== undefined && !p.isSeed)
            .map((p) => [p.id, p.default])
        ),
        outputs: {},
        outputImage: null,
        outputVideo: null,
        outputAudio: null,
        outputText: null,
        output3dUrl: null,
        status: "idle",
        error: null,
        runStatus: null,
        jobId: null,
      });
      setModal(null);
      setDropped(null);
    },
    [id, updateNodeData, pruneStaleEdges]
  );

  /**
   * The same workflow, exposing a different selection of it.
   *
   * Unlike attaching, this keeps the run: the graph has not changed, so the
   * last result is still that graph's result, and a value the user dialled in
   * on a setting they kept must survive being shown the list again.
   */
  const handleReconfigure = useCallback(
    (attached: ComfyAppDefinition, inspection: ComfyWorkflowInspection | undefined) => {
      pruneStaleEdges(attached);
      const paramValues = mergeParamValues(attached.params, nodeData.paramValues ?? {});
      // Results are keyed by output handle id, so a dropped output's value has
      // to go — and the typed mirrors re-derived from what is left, exactly as
      // a run would compute them.
      const surviving = attached.outputs
        .map((output) => ({
          handleId: output.id,
          type: output.type,
          value: nodeData.outputs?.[output.id] ?? "",
        }))
        .filter((output) => output.value !== "");

      updateNodeData(id, {
        app: attached,
        inspection,
        inputSchema: appToInputSchema(attached),
        paramValues,
        ...outputsToNodeData(attached.outputs, surviving),
      });
      setModal(null);
    },
    [id, updateNodeData, pruneStaleEdges, nodeData.paramValues, nodeData.outputs]
  );

  const handleParamsChange = useCallback(
    (values: Record<string, unknown>) => updateNodeData(id, { paramValues: values }),
    [id, updateNodeData]
  );

  // Identity-stable, because the dialog re-reads the workflow whenever this
  // changes — a fresh object every render would re-fetch on every render.
  const reconfigureTarget = useMemo<ComfyReconfigureTarget | null>(() => {
    if (modal !== "edit" || !app) return null;
    return nodeData.inspection ? { app, inspection: nodeData.inspection } : { app };
  }, [modal, app, nodeData.inspection]);

  const primaryPreview = useMemo(() => {
    if (!app) return null;
    for (const output of app.outputs) {
      const value = nodeData.outputs?.[output.id];
      if (value) return { type: output.type as ComfyOutputType, value, label: output.label };
    }
    return null;
  }, [app, nodeData.outputs]);

  const isRunning = nodeData.status === "loading";
  // The latent as it forms. Only the v2 engines emit these, so it stays null
  // on a stock ComfyUI and the node keeps its spinner.
  const livePreview = useComfyPreview(nodeData.jobId, isRunning);

  // Sockets: one per connectable input the workflow exposes, one per bound output.
  const inputSockets = useMemo<SocketSpec[]>(
    () =>
      inputHandles.map((input) => ({
        id: input.handleId,
        type: asSocketType(input.type),
        label: input.label,
        schemaName: input.name,
        title: input.description || input.label,
      })),
    [inputHandles]
  );
  const outputSockets = useMemo<SocketSpec[]>(
    () =>
      outputHandles.map((output) => ({
        id: output.id,
        type: asSocketType(output.type),
        label: output.label,
        title: output.label,
      })),
    [outputHandles]
  );

  // The clip follows a picture's real proportions; anything else gets a
  // fixed slot. A live latent preview is a picture too.
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);
  const pictureSrc =
    isRunning && livePreview ? livePreview : primaryPreview?.type === "image" ? primaryPreview.value : null;
  const media: { kind: "aspect"; aspect: number } | { kind: "fixed"; height: number } = !app
    ? { kind: "fixed", height: EMPTY_HEIGHT }
    : pictureSrc
      ? { kind: "aspect", aspect: loadedAspect?.src === pictureSrc ? loadedAspect.aspect : 1 }
      : primaryPreview?.type === "video"
        ? { kind: "aspect", aspect: 16 / 9 }
        : isRunning
          ? { kind: "aspect", aspect: 1 }
          : { kind: "fixed", height: nodeData.mediaHeight ?? TEXTUAL_HEIGHT };

  const runStatus = isRunning ? nodeData.runStatus ?? "running" : null;
  const hasParams = Boolean(app && app.params.length > 0);

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        isExecuting={isRunning}
        hasError={nodeData.status === "error"}
        media={media}
        inputs={inputSockets}
        outputs={outputSockets}
        minWidth={260}
        mediaClassName={app ? "bg-neutral-900/60" : undefined}
        controls={
          app ? (
            <ControlsCard
              id={id}
              summary={{
                icon: <ComfyWordmark className="h-3 w-auto" />,
                title: app.source === "blueprint" ? "Blueprint" : "App workflow",
                values: (
                  <span className="flex items-center gap-1.5">
                    <SummaryValues
                      items={[runStatus ? runStatus.replace(/_/g, " ") : `${app.nodeCount} node${app.nodeCount === 1 ? "" : "s"}`]}
                    />
                    <HeaderButton onClick={() => setModal("edit")} title="Choose inputs, settings and outputs">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </HeaderButton>
                    <HeaderButton onClick={() => setModal("replace")} title="Replace this workflow">
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </HeaderButton>
                  </span>
                ),
              }}
              expanded={Boolean(nodeData.parametersExpanded)}
              onToggle={
                hasParams
                  ? () => updateNodeData(id, { parametersExpanded: !nodeData.parametersExpanded })
                  : undefined
              }
            >
              {hasParams ? (
                <ComfyAppParameters
                  params={app.params}
                  values={nodeData.paramValues ?? {}}
                  onChange={handleParamsChange}
                />
              ) : undefined}
            </ControlsCard>
          ) : undefined
        }
      >
        {!app ? (
          <NoWorkflow
            onImport={() => setModal("replace")}
            onDropWorkflow={(upload) => {
              setDropped(upload);
              setModal("replace");
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Preview
              preview={primaryPreview}
              isRunning={isRunning}
              livePreview={livePreview}
              error={nodeData.status === "error" ? nodeData.error : null}
              onPictureLoad={(src, aspect) => setLoadedAspect({ src, aspect })}
            />
            {media.kind === "fixed" && (
              <HeightGrip
                height={media.height}
                onChange={(h) => updateNodeData(id, { mediaHeight: h })}
              />
            )}
          </div>
        )}
      </NodeShell>

      <ComfyWorkflowImportModal
        isOpen={modal !== null}
        onClose={() => {
          setModal(null);
          setDropped(null);
        }}
        onAttach={modal === "edit" ? handleReconfigure : handleAttach}
        {...(app ? { existingName: app.name } : {})}
        {...(nodeData.savedNodeId ? { savedNodeId: nodeData.savedNodeId } : {})}
        paramValues={nodeData.paramValues ?? {}}
        {...(reconfigureTarget ? { reconfigure: reconfigureTarget } : {})}
        {...(dropped && modal === "replace" ? { upload: dropped } : {})}
      />
    </>
  );
}

/**
 * A node with no workflow yet: a place to drop one.
 *
 * It takes a dropped file itself rather than leaving it to the canvas, which
 * would answer by making a *second* node and leaving this one still empty.
 */
function NoWorkflow({
  onImport,
  onDropWorkflow,
}: {
  onImport: () => void;
  onDropWorkflow: (upload: ComfyUpload) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  const jsonFrom = (transfer: DataTransfer): File | undefined =>
    Array.from(transfer.files).find(
      (file) => file.type === "application/json" || file.name.endsWith(".json")
    );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const file = jsonFrom(e.dataTransfer);
        // Anything else — an image, say — is the canvas's to deal with, so it
        // is left to bubble.
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        void file
          .text()
          .then((text) => {
            try {
              onDropWorkflow({ workflow: JSON.parse(text), filename: file.name });
            } catch {
              // The dialog is where a bad file gets explained; it reports the
              // same way whether the JSON or the workflow inside it is at fault.
              onDropWorkflow({ workflow: text, filename: file.name });
            }
          })
          .catch(() => {
            // A file the browser could not read at all. Still the dialog's to
            // report — without this the drop does nothing and says nothing.
            onDropWorkflow({ workflow: null, filename: file.name });
          });
      }}
      className={`nodrag nopan absolute inset-0 flex flex-col items-center justify-center gap-4 transition-colors ${
        dragOver ? "bg-blue-500/5" : "bg-neutral-900/40"
      }`}
    >
      <div
        className={`absolute inset-2 rounded-[6px] squircle border border-dashed pointer-events-none ${
          dragOver ? "border-blue-500" : "border-neutral-700/70"
        }`}
      />
      <ComfyWordmark className="h-5 w-auto text-neutral-500" />
      <button
        type="button"
        onClick={onImport}
        // `leading-none` is what centres this: the default 16px line box on
        // 12px text reserves room for descenders the label never uses, and
        // padding then measures from that empty space rather than the letters.
        className="nodrag nopan inline-flex items-center pl-[11px] pr-3 py-1.5 text-xs leading-none rounded-lg bg-neutral-700 hover:bg-neutral-600 text-neutral-100 transition-colors"
      >
        Load workflow
      </button>
    </div>
  );
}

function HeaderButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="nodrag nopan shrink-0 text-neutral-500 hover:text-neutral-200 transition-colors"
      onClickCapture={(e) => e.stopPropagation()}
    >
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * A node mid-render.
 *
 * Where the engine sends previews, the latent itself — which says more about
 * what is happening than any number Comfy Cloud currently reports, since its
 * progress carries no node name, no step counts, and a fraction that reaches
 * 100% several times before the job ends.
 *
 * The spinner stays for everything else: the first seconds of any run, and
 * every run on a stock ComfyUI, which has no event stream at all.
 */
function Rendering({
  livePreview,
  onPictureLoad,
}: {
  livePreview: string | null;
  onPictureLoad?: (src: string, aspect: number) => void;
}) {
  if (!livePreview) {
    return (
      <div className="flex flex-col items-center gap-2 text-neutral-500">
        <div className="w-5 h-5 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin" />
        <span className="text-[10px]">Rendering…</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={livePreview}
        alt="Rendering"
        // Each frame replaces the last; a fade would cross-blend two states of
        // the same image into something neither of them looked like.
        className="w-full h-full object-contain"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) onPictureLoad?.(livePreview, img.naturalWidth / img.naturalHeight);
        }}
      />
      {/* Over the image, not beside it: the preview fills the node, and this
          has to stay legible on whatever the latent happens to look like. */}
      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm">
        <div className="w-2.5 h-2.5 border-2 border-neutral-500 border-t-blue-400 rounded-full animate-spin" />
        <span className="text-[9px] text-neutral-200">Rendering…</span>
      </div>
    </div>
  );
}

function Preview({
  preview,
  isRunning,
  livePreview,
  error,
  onPictureLoad,
}: {
  preview: { type: ComfyOutputType; value: string; label: string } | null;
  isRunning: boolean;
  livePreview: string | null;
  error: string | null;
  onPictureLoad?: (src: string, aspect: number) => void;
}) {
  if (isRunning) return <Rendering livePreview={livePreview} onPictureLoad={onPictureLoad} />;
  if (error) {
    return (
      <div className="px-3 py-2 max-h-full overflow-y-auto nowheel">
        <p className="text-[10px] text-red-400 whitespace-pre-wrap break-words">{error}</p>
      </div>
    );
  }
  if (!preview) {
    return <span className="text-[10px] text-neutral-600">No output yet</span>;
  }
  if (preview.type === "text") {
    return (
      <div className="w-full h-full px-3 py-2 overflow-y-auto nowheel nodrag">
        <p className="text-[11px] text-neutral-200 whitespace-pre-wrap break-words">
          {preview.value}
        </p>
      </div>
    );
  }
  if (preview.type === "video") {
    return (
      <video
        src={preview.value}
        className="w-full h-full object-contain"
        controls
        loop
        muted
        playsInline
      />
    );
  }
  if (preview.type === "audio") {
    return (
      <div className="w-full px-3">
        <audio src={preview.value} controls className="w-full nodrag nopan" />
      </div>
    );
  }
  if (preview.type === "3d") {
    return (
      <button
        type="button"
        onClick={() => downloadMedia(preview.value, "image", "comfy-model")}
        className="nodrag nopan text-[10px] text-neutral-300 underline underline-offset-2"
      >
        Download 3D model
      </button>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={preview.value}
      alt={preview.label}
      className="w-full h-full object-cover"
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) onPictureLoad?.(preview.value, img.naturalWidth / img.naturalHeight);
      }}
    />
  );
}
