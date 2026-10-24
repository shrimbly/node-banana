"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileWarning,
  FolderInput,
  Maximize2,
  Minimize2,
  RotateCcw,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import { cn } from "@/components/nodes/ui/cn";
import { DialogButton, DialogEyebrow, DialogSpinner } from "@/components/ui/Dialog";
import { assetFileUrl, assetThumbUrl } from "@/lib/assets/client/api";
import { openWorkflowBlockedReason } from "@/lib/assets/client/openWorkflow";
import type { AssetView } from "@/lib/assets/types";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  assetEyebrow,
  assetTitle,
  formatBytes,
  formatCost,
  formatDateTime,
  formatDimensions,
  formatDuration,
  modelLabel,
  operationLabel,
  projectLabel,
  resolvePlatform,
  revealLabel,
  workflowLabel,
} from "./assetFormat";
import {
  copyPrompt,
  isDesktopApp,
  openWorkflowFor,
  requestRemoveFromLibrary,
  requestPermanentDelete,
  restoreSelection,
  revealAssetFile,
  saveCopy,
  selectionOf,
  toggleFavorite,
} from "./assetActions";
import { workflowActions } from "./AssetContextMenu";
import { gridReveal } from "./AssetGrid";
import { AssetNotice } from "./AssetNotice";
import { AssetPlaceholder, KIND_TONE } from "./AssetTile";
import { TagInput } from "./TagEditor";

const PANEL_WIDTH = 340;

/** Toggle real fullscreen on the detail (the F key). */
export function toggleDetailFullscreen() {
  const el = document.querySelector<HTMLElement>("[data-asset-detail]");
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen?.();
  else void el.requestFullscreen?.().catch(() => {});
}

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

/** Whether the detail is truly fullscreen: then nothing outside it is painted. */
export function useDetailFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => !!document.fullscreenElement?.matches?.("[data-asset-detail]"),
    () => false,
  );
}

/** A kind-coloured square and a line, where the media cannot be shown. */
function StageNote({ kind, children }: { kind: AssetView["kind"]; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
      <AssetPlaceholder kind={kind} size={48} className="h-40 w-40 rounded-card" />
      <p className="text-xs text-ink-3">{children}</p>
    </div>
  );
}

/** Image at fit, click for 100% and drag to pan, click again to fit. */
function ImageStage({ asset }: { asset: AssetView }) {
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  useEffect(() => {
    setActual(false);
    setFailed(false);
  }, [asset.id]);

  if (failed) return <StageNote kind="image">The image could not be shown.</StageNote>;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!actual || !scroller.current) return;
    drag.current = { x: event.clientX, y: event.clientY, left: scroller.current.scrollLeft, top: scroller.current.scrollTop, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !scroller.current) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    scroller.current.scrollLeft = d.left - dx;
    scroller.current.scrollTop = d.top - dy;
  };
  const onPointerUp = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) setActual((value) => !value);
  };

  return (
    <div
      ref={scroller}
      className={cn("absolute inset-0 select-none", actual ? "cursor-grab overflow-auto active:cursor-grabbing" : "flex cursor-zoom-in items-center justify-center p-10")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={actual ? onPointerUp : undefined}
      onClick={actual ? undefined : () => setActual(true)}
      role="img"
      aria-label={assetTitle(asset)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetFileUrl(asset.id)}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className={cn(actual ? "m-auto block max-w-none" : "max-h-full max-w-full object-contain", "rounded-[2px]")}
      />
    </div>
  );
}

function Stage({ asset }: { asset: AssetView }) {
  const platform = resolvePlatform(useAssetStore.getState().library);
  if (asset.missing) return <StageNote kind={asset.kind}>The file is not where it was saved.</StageNote>;
  switch (asset.kind) {
    case "image":
      return <ImageStage asset={asset} />;
    case "video":
      return (
        <div className="flex h-full w-full items-center justify-center p-10">
          <video key={asset.id} src={assetFileUrl(asset.id)} controls autoPlay playsInline className="max-h-full max-w-full rounded-[2px] bg-black" />
        </div>
      );
    case "audio":
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-8 p-10">
          <AssetPlaceholder kind="audio" size={96} className="aspect-[2/1] h-auto w-full max-w-[560px] rounded-card" />
          <audio key={asset.id} src={assetFileUrl(asset.id)} controls className="w-full max-w-[560px]" />
        </div>
      );
    case "3d":
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-10">
          {asset.hasPoster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={assetThumbUrl(asset.sha256, 640)} alt="" className="max-h-[70%] max-w-full rounded-card object-contain" />
          ) : (
            <AssetPlaceholder kind="3d" size={64} className="h-56 w-56 rounded-card" />
          )}
          <DialogButton variant="outline" onClick={() => void revealAssetFile(asset)}>
            <ExternalLink size={14} strokeWidth={1.75} />
            {revealLabel(platform)}
          </DialogButton>
        </div>
      );
  }
}

/** Icon action in the panel's row: 32px, label as hover title. */
function PanelIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        danger && "hover:text-red-300",
        pressed && "text-neutral-100",
      )}
    >
      <Icon size={16} strokeWidth={1.75} fill={pressed ? "currentColor" : "none"} />
    </button>
  );
}

function Section({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] px-6 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <DialogEyebrow>{label}</DialogEyebrow>
        {action}
      </div>
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-white/[0.04] py-1.5 first:border-t-0">
      <dt className="shrink-0 text-xs text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[13px] text-neutral-200">{children}</dd>
    </div>
  );
}

function formatParameter(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The right-hand panel: what it is, what to do with it, and everything recorded about it. */
function DetailPanel({ asset }: { asset: AssetView }) {
  const { view, facets, library, runBulk } = useAssetStore(
    useShallow((state) => ({ view: state.filters.view, facets: state.facets, library: state.library, runBulk: state.runBulk })),
  );
  // The open-workflow reasons follow the canvas's busy state
  useWorkflowStore((state) => state.isRunning || state.isSaving || state.pendingMediaSaves > 0);
  const [showParameters, setShowParameters] = useState(false);
  const platform = resolvePlatform(library);
  const actions = workflowActions(asset);
  const primary = actions[0];
  const secondary = actions[1];
  const primaryBlocked = primary ? openWorkflowBlockedReason(asset, primary.mode) : null;
  const secondaryBlocked = secondary ? openWorkflowBlockedReason(asset, secondary.mode) : null;
  const one = selectionOf([asset.id]);
  const parameters = Object.entries(asset.parameters ?? {});
  const node = asset.producer.nodeTitle || asset.producer.nodeType;
  const format = `${asset.ext.toUpperCase()} · ${asset.mime}`;
  // Named as the rail names it, so an untitled workflow reads the same in both
  const workflowAt = facets?.workflows.find((workflow) => workflow.id === asset.workflow.id)?.lastAt ?? asset.createdAt;

  return (
    <aside
      className="flex shrink-0 flex-col overflow-y-auto overscroll-contain bg-pane"
      style={{ width: PANEL_WIDTH }}
      aria-label="Asset details"
    >
      <div className="px-6 pb-4 pt-5">
        <DialogEyebrow className="block">{assetEyebrow(asset)}</DialogEyebrow>
        <h2 className="mt-1.5 line-clamp-3 select-text font-display text-xl font-semibold leading-6 tracking-[-0.02em] text-neutral-100" title={asset.name ?? asset.prompt ?? asset.filename}>
          {assetTitle(asset)}
        </h2>
        {asset.name && asset.name !== asset.filename && (
          <p className="mt-1 select-text truncate text-xs text-ink-3" title={asset.filename}>
            {asset.filename}
          </p>
        )}

        {asset.missing && (
          <div role="alert" className="mt-4 flex flex-col gap-2 rounded-lg border border-error/40 bg-error/10 p-3">
            <span className="flex items-start gap-2 text-xs text-red-200">
              <FileWarning size={14} strokeWidth={1.75} className="mt-px shrink-0" />
              <span className="min-w-0 break-all">File not found at {asset.displayPath}</span>
            </span>
            <DialogButton variant="outline" compact className="self-start" onClick={() => requestRemoveFromLibrary(one, 1)}>
              Remove from library
            </DialogButton>
          </div>
        )}

        {view !== "trash" && primary && (
          <div className="mt-4 flex flex-col gap-1.5">
            <DialogButton variant="primary" size="md" disabled={!!primaryBlocked} onClick={() => void openWorkflowFor(asset, primary.mode)}>
              {primary.label}
            </DialogButton>
            {primaryBlocked && <p className="text-xs leading-4 text-ink-3">{primaryBlocked}</p>}
            {secondary && (
              <>
                <DialogButton variant="outline" disabled={!!secondaryBlocked} onClick={() => void openWorkflowFor(asset, secondary.mode)} className="mt-1">
                  {secondary.label}
                </DialogButton>
                <p className="text-xs leading-4 text-ink-3">{secondaryBlocked ?? "Opens a copy; your project isn't changed."}</p>
              </>
            )}
          </div>
        )}

        <div className="-ml-1.5 mt-3 flex items-center gap-0.5">
          <PanelIconButton icon={ExternalLink} label={revealLabel(platform)} disabled={asset.missing} onClick={() => void revealAssetFile(asset)} />
          <PanelIconButton
            icon={isDesktopApp() ? FolderInput : Download}
            label={isDesktopApp() ? "Save a copy…" : "Download"}
            disabled={asset.missing}
            onClick={() => saveCopy(asset)}
          />
          <PanelIconButton icon={Copy} label="Copy prompt" disabled={!asset.prompt} onClick={() => void copyPrompt(asset)} />
          <PanelIconButton
            icon={Star}
            label={asset.favorite ? "Remove from Favorites" : "Add to Favorites"}
            pressed={asset.favorite}
            onClick={() => toggleFavorite(asset)}
          />
          {view === "trash" ? (
            <>
              <PanelIconButton icon={RotateCcw} label="Restore" onClick={() => restoreSelection(one)} />
              <PanelIconButton icon={Trash2} label="Delete permanently…" danger onClick={() => requestPermanentDelete(one, 1)} />
            </>
          ) : (
            <PanelIconButton icon={Trash2} label="Trash" danger onClick={() => void runBulk(one, { action: "trash" })} />
          )}
        </div>
      </div>

      {asset.prompt && (
        <Section
          label="Prompt"
          action={
            <button
              type="button"
              onClick={() => void copyPrompt(asset)}
              aria-label="Copy prompt"
              title="Copy prompt"
              className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <Copy size={13} strokeWidth={1.75} />
            </button>
          }
        >
          <p className="max-h-60 select-text overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-5 text-neutral-200">{asset.prompt}</p>
        </Section>
      )}

      <Section label="Tags">
        <TagInput
          tags={asset.tags}
          suggestions={(facets?.tags ?? []).map((tag) => tag.tag)}
          onAdd={(tag) => void runBulk(one, { action: "tag", tags: [tag] })}
          onRemove={(tag) => void runBulk(one, { action: "untag", tags: [tag] })}
        />
      </Section>

      <Section label="Details">
        <dl>
          <DetailRow label="Created">{formatDateTime(asset.createdAt)}</DetailRow>
          <DetailRow label="Workflow">{workflowLabel(asset.workflow.name ?? asset.workflowName, workflowAt)}</DetailRow>
          <DetailRow label="Project">{asset.workflow.projectPath ? projectLabel(asset.workflow.projectPath) : "Not in a project"}</DetailRow>
          {/* No node made an upload; its Workflow row says where it came in */}
          {asset.origin !== "uploaded" && (
            <DetailRow label="Node">{asset.origin === "edited" && asset.producer.operation ? `${node} · ${operationLabel(asset.producer.operation)}` : node}</DetailRow>
          )}
          <DetailRow label="Model">{modelLabel(asset.model)}</DetailRow>
          <DetailRow label="Dimensions">{formatDimensions(asset.width, asset.height)}</DetailRow>
          <DetailRow label="Duration">{asset.durationSec ? formatDuration(asset.durationSec) : null}</DetailRow>
          <DetailRow label="Size">{formatBytes(asset.bytes)}</DetailRow>
          <DetailRow label="Format">{format}</DetailRow>
          <DetailRow label="Cost">{asset.cost ? formatCost(asset.cost) : null}</DetailRow>
        </dl>
      </Section>

      {parameters.length > 0 && (
        <section className="border-t border-white/[0.06] px-6 py-4">
          <button
            type="button"
            aria-expanded={showParameters}
            onClick={() => setShowParameters(!showParameters)}
            className="flex w-full items-center justify-between rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            <DialogEyebrow>Parameters · {parameters.length}</DialogEyebrow>
            <ChevronDown size={14} className={cn("text-neutral-500 transition-transform motion-reduce:transition-none", showParameters && "rotate-180")} />
          </button>
          {showParameters && (
            <dl className="mt-2">
              {parameters.map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-4 border-t border-white/[0.04] py-1.5 first:border-t-0">
                  <dt className="shrink-0 font-mono text-[11px] text-ink-3">{key}</dt>
                  <dd className="min-w-0 select-text break-words text-right font-mono text-[11px] text-neutral-200">{formatParameter(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      <Section label="File">
        <button
          type="button"
          onClick={() => void revealAssetFile(asset)}
          disabled={asset.missing}
          title={asset.missing ? "The file is missing" : revealLabel(platform)}
          className="w-full break-all rounded text-left font-mono text-[11px] leading-4 text-neutral-300 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:cursor-default disabled:hover:text-neutral-300"
        >
          {asset.displayPath}
        </button>
      </Section>
    </aside>
  );
}

/**
 * One asset, full size, over the grid: the media on a dark stage with
 * previous/next, the details panel on the right. Lives inside the canvas
 * frame (the tab strip stays a drag region); F makes it truly fullscreen.
 */
export function AssetDetail() {
  const { detailId, asset, items, total, nextCursor, closeDetail, stepDetail } = useAssetStore(
    useShallow((state) => ({
      detailId: state.detailId,
      asset: state.detailAsset,
      items: state.items,
      total: state.total,
      nextCursor: state.nextCursor,
      closeDetail: state.closeDetail,
      stepDetail: state.stepDetail,
    })),
  );
  const fullscreen = useDetailFullscreen();
  const layerRef = useRef<HTMLDivElement>(null);
  const open = detailId !== null;

  // Focus comes in with the detail (the grid behind is inert), and goes back
  // to the tile it ended on, scrolled into view, when it closes
  useEffect(() => {
    if (!open) return;
    layerRef.current?.focus({ preventScroll: true });
    return () => {
      const state = useAssetStore.getState();
      if (state.appView === "assets" && !state.detailId && state.focusedId) gridReveal.current?.(state.focusedId);
    };
  }, [open]);

  // Leaving the view leaves fullscreen too
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen?.();
    },
    [],
  );

  if (!detailId) return null;
  const index = items.findIndex((item) => item.id === detailId);
  const hasPrevious = index > 0;
  const hasNext = index !== -1 && (index < items.length - 1 || !!nextCursor);
  const kind = asset?.kind ?? items[index]?.kind ?? "image";

  return (
    <div
      ref={layerRef}
      data-asset-detail=""
      role="dialog"
      aria-modal="true"
      aria-label={asset ? assetTitle(asset) : "Asset"}
      tabIndex={-1}
      className="animate-drop-in motion-reduce:animate-none absolute inset-0 z-30 flex bg-canvas-bg outline-none"
    >
      <div className="relative flex min-w-0 flex-1 flex-col bg-[#0f0f0f]">
        <div className="flex h-12 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            onClick={closeDetail}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 font-display text-[13px] font-medium text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            <ArrowLeft size={16} strokeWidth={1.75} />
            Assets
          </button>
          {index !== -1 && (
            <DialogEyebrow className="ml-1 tabular-nums">
              {(index + 1).toLocaleString("en-US")} / {Math.max(total, items.length).toLocaleString("en-US")}
            </DialogEyebrow>
          )}
          <button
            type="button"
            onClick={toggleDetailFullscreen}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            {fullscreen ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          {asset ? <Stage asset={asset} /> : (
            <div className={cn("flex h-full items-center justify-center", KIND_TONE[kind].ground)}>
              <DialogSpinner />
            </div>
          )}
          {hasPrevious && (
            <button
              type="button"
              onClick={() => void stepDetail(-1)}
              aria-label="Previous asset"
              title="Previous (←)"
              className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-800/90 text-neutral-200 transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <ChevronLeft size={20} strokeWidth={1.75} />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={() => void stepDetail(1)}
              aria-label="Next asset"
              title="Next (→)"
              className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-800/90 text-neutral-200 transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <ChevronRight size={20} strokeWidth={1.75} />
            </button>
          )}
          {fullscreen && (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center">
              <AssetNotice />
            </div>
          )}
        </div>
      </div>

      {asset ? <DetailPanel asset={asset} /> : <aside className="shrink-0 bg-pane" style={{ width: PANEL_WIDTH }} />}
    </div>
  );
}
