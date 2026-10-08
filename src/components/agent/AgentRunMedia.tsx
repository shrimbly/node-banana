"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, LocateFixedIcon, Maximize2Icon, PlayIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/components/agent/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/agent/ui/tooltip";
import { AssetPlaceholder } from "@/components/assets/AssetTile";
import { CHROME_ICON_BUTTON } from "@/components/chromeStyles";
import { assetFileUrl, assetThumbUrl } from "@/lib/assets/client/api";
import { getNodeHandles } from "@/lib/nodes/handles";
import type { AgentRunOutput } from "@/lib/agent/types";
import { AGENT_ICON, AGENT_POPOVER_LAYER } from "./AgentChrome";
import type { AgentSurface } from "./AgentSurface";

/**
 * The pieces of a run's results card: media tiles (from the asset library,
 * or from the node while its tab is open), skeletons for outputs still on
 * their way, audio rows, text cards, and the cards' small icon buttons.
 */

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * An icon button on a transcript card, with the chrome's hover label. The
 * label is a portalled tooltip: the chrome's CSS one shows whenever any
 * `group` around it is hovered, and a message is one. A `disabledReason`
 * keeps it focusable and says why in the label.
 */
export function CardIconButton({
  label,
  onClick,
  disabledReason,
  size = "md",
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabledReason?: string | null;
  /** md: 28px, on a card's header. sm: 24px, on a tool row. */
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  const blocked = !!disabledReason;
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-disabled={blocked || undefined}
            onClick={blocked ? undefined : onClick}
            className={cn(
              CHROME_ICON_BUTTON,
              "focus-visible:ring-selection",
              size === "sm" ? "size-6 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
              blocked && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-neutral-300 active:scale-100 active:bg-transparent",
              className,
            )}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent className={AGENT_POPOVER_LAYER}>{blocked ? `${label}: ${disabledReason}` : label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Copies `value`; a check for a moment after. */
export function CardCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the text stays selectable.
    }
  }, [value]);
  return (
    <CardIconButton label={copied ? "Copied" : label} onClick={copy}>
      {copied ? <CheckIcon {...AGENT_ICON} /> : <CopyIcon {...AGENT_ICON} />}
    </CardIconButton>
  );
}

// ---------------------------------------------------------------------------
// Type dots
// ---------------------------------------------------------------------------

const HANDLE_DOTS: Record<string, string> = {
  image: "bg-handle-image",
  text: "bg-handle-text",
  video: "bg-handle-video",
  audio: "bg-handle-audio",
  "3d": "bg-handle-3d",
  easeCurve: "bg-handle-easeCurve",
  reference: "bg-handle-reference",
};

/** The handle type a node's main output carries ("reference" when it has none). */
export function nodeOutputHandle(nodeType: string): string {
  return getNodeHandles(nodeType).outputs[0] ?? "reference";
}

/** A small dot in a socket's colour: what a node makes, at a glance. */
export function TypeDot({ handle, className }: { handle: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", HANDLE_DOTS[handle] ?? HANDLE_DOTS.reference, className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** How long a missing file gets before it is asked for again: the recorder may still be writing it. */
export const MEDIA_RETRY_MS = 1500;

interface SourceStep {
  src: string;
  /** Wait this long before trying it. */
  delayMs?: number;
}

function withRetry(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}retry=1`;
}

/** A library file, once more after a moment (it may still be uploading), then the node's own media. */
function fileSteps(url: string, liveSrc: string | undefined): SourceStep[] {
  const steps: SourceStep[] = [{ src: url }, { src: withRetry(url), delayMs: MEDIA_RETRY_MS }];
  if (liveSrc) steps.push({ src: liveSrc });
  return steps;
}

/**
 * What a preview tries, in order. An image starts from the 640px thumbnail (a
 * video's poster is separate, and a video plays, so it starts from the file).
 * The node's own media is last.
 */
function tileSteps(output: AgentRunOutput, liveSrc: string | undefined): SourceStep[] {
  if (!output.assetId) return liveSrc ? [{ src: liveSrc }] : [];
  const file = assetFileUrl(output.assetId);
  if (output.kind !== "image" || !output.sha256) return fileSteps(file, liveSrc);
  return [...fileSteps(assetThumbUrl(output.sha256, 640), undefined), ...fileSteps(file, liveSrc).filter((step) => !step.delayMs)];
}

/**
 * Walks `steps` on each load error: the next source, after its delay (a
 * skeleton shows meanwhile). `exhausted` once none is left. The steps are
 * read on every render, so the walk never restarts: a step whose source
 * changes (a live output following its node) swaps in place, and one added
 * after the walk ran out (the node's media, once its tab opens) is shown.
 */
export function useSourceChain(steps: readonly SourceStep[]) {
  const [index, setIndex] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onError = () => {
    if (timer.current) return;
    const next = index + 1;
    const delay = steps[next]?.delayMs;
    if (!delay) {
      setIndex(next);
      return;
    }
    setWaiting(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setWaiting(false);
      setIndex(next);
    }, delay);
  };
  const step = steps[index];
  return { src: waiting ? undefined : step?.src, waiting, exhausted: !step, onError };
}

/** The full file for the viewer and downloads: the library's, else the node's. */
export function outputFileSrc(output: AgentRunOutput, liveSrc: string | undefined): string | undefined {
  return output.assetId ? assetFileUrl(output.assetId) : liveSrc;
}

/** A video's stored poster frame, when it has one. */
export function posterUrl(output: AgentRunOutput): string | undefined {
  return output.hasPoster && output.sha256 ? `${assetThumbUrl(output.sha256, 640)}&poster=1` : undefined;
}

/** A frame to show while a video sits still: a moment in, not the black first frame (not for data URLs). */
function stillFrame(src: string): string {
  return src.startsWith("data:") || src.startsWith("blob:") || src.includes("#") ? src : `${src}#t=0.1`;
}

export function outputAspect(output: Pick<AgentRunOutput, "width" | "height">): number | undefined {
  return output.width && output.height ? output.width / output.height : undefined;
}

// ---------------------------------------------------------------------------
// The preview row
// ---------------------------------------------------------------------------

/** An output a node is still making: a skeleton in its place. */
export interface PendingOutput {
  key: string;
  nodeId: string;
  nodeTitle: string;
  kind: AgentRunOutput["kind"];
  /** Width over height, when the node says (an image node's aspect ratio). */
  aspect?: number;
  /** Which run of a batch it belongs to (0-based), when the record ran more than once. */
  batchIndex?: number;
}

/** One preview: an image, video or 3D output, or a skeleton for one. */
export type RunVisual = { key: string; output: AgentRunOutput; pending?: never } | { key: string; pending: PendingOutput; output?: never };

export interface RunPreviewRowProps {
  items: RunVisual[];
  /** The nodes' own media, by output id, while the run's tab is open. */
  liveSources: Readonly<Record<string, string>>;
  surface: AgentSurface;
  /** The record ran more than once: each caption says which run (R1, R2…). */
  batched: boolean;
  onOpen: (outputId: string) => void;
  /** Bring a node into view on the canvas; absent outside the agent session. */
  onShowNode?: (nodeId: string) => void;
}

/** The row's fixed height: every preview is this tall, as wide as its own shape makes it. */
export const PREVIEW_HEIGHT: Record<AgentSurface, number> = { page: 200, window: 120 };
export const PREVIEW_GAP = 6;
/** The widest the row gets on the page, beyond the 768px text column. */
export const PREVIEW_ROW_MAX_WIDTH = 1084;
/** What the row measures before it has been laid out (and in tests): its usual width. */
const ROW_WIDTH_FALLBACK: Record<AgentSurface, number> = { page: PREVIEW_ROW_MAX_WIDTH, window: 388 };

/**
 * How many of `aspects` fit side by side in `width` at `height`, each
 * `height × aspect` wide with `gap` between: always at least one.
 */
export function fitPreviews(aspects: readonly number[], height: number, width: number, gap = PREVIEW_GAP): number {
  let used = 0;
  for (let index = 0; index < aspects.length; index++) {
    const next = used + (index > 0 ? gap : 0) + Math.round(height * aspects[index]);
    if (next > width && index > 0) return index;
    used = next;
  }
  return aspects.length;
}

/** Width over height for a preview's frame. A panorama past 4:1 (or a strip past 1:4) is cropped to that. */
function previewAspect(item: RunVisual, measured: Readonly<Record<string, number>>): number {
  const known = item.pending
    ? (item.pending.aspect ?? (item.pending.kind === "video" ? 16 / 9 : 1))
    : item.output.kind === "model3d"
      ? 1
      : (outputAspect(item.output) ?? measured[item.output.id] ?? (item.output.kind === "video" ? 16 / 9 : 1));
  return Math.min(4, Math.max(1 / 4, known));
}

/** The row's own width, followed as the chat resizes; `shown` once the row is in the page. */
function useRowWidth(shown: boolean, fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!shown || !row) return;
    setWidth(row.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, [shown]);
  return { ref, width: width || fallback };
}

/**
 * A run's images, videos and 3D in one line: a fixed height, each preview at
 * its own shape (nothing cropped), named under it. As many as fit; the last
 * one that fits says how many more there are and opens the viewer at the
 * first of them. On the page the line is wider than the text column, up to
 * PREVIEW_ROW_MAX_WIDTH (the transcript is a size container, so `cqw` is the
 * chat's width); in the window it runs past the text's inset to the edges.
 */
export function RunPreviewRow({ items, liveSources, surface, batched, onOpen, onShowNode }: RunPreviewRowProps) {
  const height = PREVIEW_HEIGHT[surface];
  const { ref, width } = useRowWidth(items.length > 0, ROW_WIDTH_FALLBACK[surface]);
  // Natural shapes of outputs whose record has none (a live output's image), once loaded.
  const [measured, setMeasured] = useState<Readonly<Record<string, number>>>({});
  const onMeasure = useCallback((id: string, aspect: number) => {
    setMeasured((previous) => (Math.abs((previous[id] ?? 0) - aspect) < 0.01 ? previous : { ...previous, [id]: aspect }));
  }, []);
  if (items.length === 0) return null;

  const aspects = items.map((item) => previewAspect(item, measured));
  const fit = fitPreviews(aspects, height, width);
  const more = items.length - fit;
  // "+N" opens the first output it stands for that can be opened (a skeleton or 3D can't).
  const firstHidden = items.slice(fit).find((item) => item.output && item.output.kind !== "model3d")?.output?.id;

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`${items.length} ${items.length === 1 ? "preview" : "previews"}`}
      data-run-media="row"
      data-shown={fit}
      className={cn(
        "flex",
        surface === "page"
          ? "relative left-1/2 w-[min(1084px,calc(100cqw-48px))] -translate-x-1/2 justify-center"
          : "-mx-2.5 w-[calc(100%+20px)]",
      )}
      style={{ gap: PREVIEW_GAP }}
    >
      {items.slice(0, fit).map((item, index) => {
        const frameWidth = Math.round(height * aspects[index]);
        const overflow = more > 0 && index === fit - 1;
        const batchIndex = item.output ? item.output.batchIndex : item.pending.batchIndex;
        const title = item.output ? item.output.nodeTitle : item.pending.nodeTitle;
        return (
          <figure key={item.key} className="m-0 flex shrink-0 flex-col gap-[7px]" style={{ width: frameWidth }}>
            <div className="relative overflow-hidden rounded-[10px] bg-well" style={{ width: frameWidth, height }}>
              <PreviewFrame item={item} liveSrc={item.output ? liveSources[item.output.id] : undefined} onOpen={onOpen} onShowNode={onShowNode} onMeasure={onMeasure} />
              {overflow && (
                <button
                  type="button"
                  aria-label={`Show all ${items.length}`}
                  disabled={!firstHidden}
                  onClick={firstHidden ? () => onOpen(firstHidden) : undefined}
                  className={cn(
                    "absolute inset-0 flex items-center justify-center bg-black/60 font-display font-semibold tracking-[-0.02em] text-white",
                    "transition-colors duration-150 enabled:hover:bg-black/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selection",
                    surface === "page" ? "text-[26px]" : "text-lg",
                  )}
                >
                  +{more}
                </button>
              )}
            </div>
            <figcaption className="flex min-w-0 items-baseline gap-1.5 px-0.5 text-[11px] leading-[14px]">
              <span className="min-w-0 truncate text-neutral-400">{overflow ? `${more} more` : title}</span>
              {batched && !overflow && batchIndex !== undefined && (
                <span className="shrink-0 font-mono text-[10px] text-neutral-600">R{batchIndex + 1}</span>
              )}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function PreviewFrame({
  item,
  liveSrc,
  onOpen,
  onShowNode,
  onMeasure,
}: {
  item: RunVisual;
  liveSrc: string | undefined;
  onOpen: (outputId: string) => void;
  onShowNode?: (nodeId: string) => void;
  onMeasure: (outputId: string, aspect: number) => void;
}) {
  if (item.pending) return <SkeletonTile kind={item.pending.kind} />;
  const { output } = item;
  if (output.kind === "model3d") return <Model3dTile output={output} onShowNode={onShowNode} />;
  return <MediaTile key={output.id} output={output} liveSrc={liveSrc} onOpen={onOpen} onShowNode={onShowNode} onMeasure={onMeasure} />;
}

const TILE_BUTTON = cn(
  "group/tile relative block size-full overflow-hidden rounded-[10px] bg-well text-left",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selection",
);

/** The image's hairline: an outline over the picture so light edges don't bleed into the page. */
function TileOutline() {
  return <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" />;
}

/** An expand glyph on hover or focus (the caption under the preview names it). */
function TileHoverOverlay() {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-black/55 text-white",
        "opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100 motion-reduce:transition-none",
      )}
    >
      <Maximize2Icon size={13} strokeWidth={2} />
    </span>
  );
}

function MediaTile({
  output,
  liveSrc,
  onOpen,
  onShowNode,
  onMeasure,
}: {
  output: AgentRunOutput;
  liveSrc: string | undefined;
  onOpen: (outputId: string) => void;
  onShowNode?: (nodeId: string) => void;
  onMeasure: (outputId: string, aspect: number) => void;
}) {
  const video = output.kind === "video";
  const chain = useSourceChain(tileSteps(output, liveSrc));
  const poster = video ? posterUrl(output) : undefined;
  const [posterFailed, setPosterFailed] = useState(false);

  if (chain.exhausted) return <UnavailableTile nodeId={output.nodeId} nodeTitle={output.nodeTitle} onShowNode={onShowNode} />;
  const label = `Open ${output.nodeTitle}'s ${video ? "video" : "image"}`;
  return (
    <button type="button" aria-label={label} data-run-tile={output.id} onClick={() => onOpen(output.id)} className={TILE_BUTTON}>
      {chain.src === undefined ? (
        <span aria-hidden="true" className="absolute inset-0 bg-white/[0.04] motion-safe:animate-pulse" />
      ) : video ? (
        poster && !posterFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" draggable={false} decoding="async" onError={() => setPosterFailed(true)} className="pointer-events-none size-full object-cover" />
        ) : (
          <video
            src={stillFrame(chain.src)}
            muted
            playsInline
            preload="metadata"
            onError={chain.onError}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) onMeasure(output.id, videoWidth / videoHeight);
            }}
            className="pointer-events-none size-full object-cover"
          />
        )
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chain.src}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onError={chain.onError}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth && naturalHeight) onMeasure(output.id, naturalWidth / naturalHeight);
          }}
          className="pointer-events-none size-full object-cover"
        />
      )}
      {video && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <PlayIcon size={15} strokeWidth={0} fill="currentColor" className="ml-0.5" />
          </span>
        </span>
      )}
      <TileOutline />
      <TileHoverOverlay />
    </button>
  );
}

/** A pulsing stand-in at the shape the node will make, so the row doesn't jump when the output lands. */
function SkeletonTile({ kind }: { kind: AgentRunOutput["kind"] }) {
  return <div data-run-skeleton={kind} aria-hidden="true" className="absolute inset-0 bg-white/[0.04] motion-safe:animate-pulse" />;
}

/** 3D isn't drawn in the chat: the tile opens it on the canvas, where the viewer node shows it. */
function Model3dTile({ output, onShowNode }: { output: AgentRunOutput; onShowNode?: (nodeId: string) => void }) {
  const body = (
    <>
      <AssetPlaceholder kind="3d" className="absolute inset-0" />
      {onShowNode && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 px-2.5 pb-2 text-[10px] leading-[14px] text-ink-3">Open on canvas</span>
      )}
      <TileOutline />
    </>
  );
  if (!onShowNode) {
    return (
      <div role="img" aria-label={`${output.nodeTitle}: 3D model`} className="relative size-full overflow-hidden rounded-[10px]">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Show ${output.nodeTitle}'s 3D model on the canvas`}
      onClick={() => onShowNode(output.nodeId)}
      className={cn(TILE_BUTTON, "transition-[filter] duration-150 hover:brightness-125")}
    >
      {body}
    </button>
  );
}

/** Where an output can't be drawn here (only on the node, and its tab isn't open): a way to it. */
export function UnavailableTile({
  nodeId,
  nodeTitle,
  onShowNode,
  verb = "see",
}: {
  nodeId: string;
  nodeTitle: string;
  onShowNode?: (nodeId: string) => void;
  verb?: "see" | "play";
}) {
  const inner = (
    <>
      <LocateFixedIcon {...AGENT_ICON} className="size-4 shrink-0 text-ink-3" />
      <span className="text-[11px] leading-4 text-neutral-300">Open the canvas to {verb} it</span>
      <span className="sr-only">{nodeTitle}</span>
    </>
  );
  const frame = "flex size-full flex-col items-center justify-center gap-1 rounded-[10px] bg-well px-3 text-center shadow-well";
  if (!onShowNode) return <div className={frame}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={() => onShowNode(nodeId)}
      className={cn(
        frame,
        "transition-colors duration-[120ms] hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
      )}
    >
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const ROW_FRAME = "rounded-media border border-white/[0.06] bg-white/[0.02]";

function RowHeading({ handle, title, meta, action }: { handle: string; title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <TypeDot handle={handle} />
      <span className="min-w-0 truncate text-xs font-medium leading-4 text-neutral-200">{title}</span>
      {meta && <span className="min-w-0 truncate text-[11px] leading-4 text-ink-3">{meta}</span>}
      {action && <span className="ml-auto flex shrink-0 items-center">{action}</span>}
    </div>
  );
}

/** An audio output: its node, and the browser's own player (loaded only when played). */
export function RunAudioRow({
  output,
  liveSrc,
  onShowNode,
}: {
  output: AgentRunOutput;
  liveSrc: string | undefined;
  onShowNode?: (nodeId: string) => void;
}) {
  const chain = useSourceChain(output.assetId ? fileSteps(assetFileUrl(output.assetId), liveSrc) : liveSrc ? [{ src: liveSrc }] : []);
  return (
    <div data-run-audio={output.id} className={cn(ROW_FRAME, "flex flex-col gap-1.5 px-3 pt-1.5 pb-2.5")}>
      <RowHeading handle="audio" title={output.nodeTitle} meta={output.model} />
      {chain.exhausted ? (
        <div className="h-[72px]">
          <UnavailableTile nodeId={output.nodeId} nodeTitle={output.nodeTitle} onShowNode={onShowNode} verb="play" />
        </div>
      ) : chain.src === undefined ? (
        <div aria-hidden="true" className="h-8 rounded-full bg-white/[0.05] motion-safe:animate-pulse" />
      ) : (
        <audio
          src={chain.src}
          controls
          preload="none"
          onError={chain.onError}
          aria-label={`${output.nodeTitle} audio`}
          className="h-8 w-full [color-scheme:dark]"
        />
      )}
    </div>
  );
}

/** An audio output still being made. */
export function PendingAudioRow({ pending }: { pending: PendingOutput }) {
  return (
    <div data-run-skeleton="audio" className={cn(ROW_FRAME, "flex flex-col gap-1.5 px-3 pt-1.5 pb-2.5")}>
      <RowHeading handle="audio" title={pending.nodeTitle} />
      <div aria-hidden="true" className="h-8 rounded-full bg-white/[0.05] motion-safe:animate-pulse" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Keeps an LLM reply's own line breaks (a poem, a list of taglines): markdown
 * would join single newlines into one paragraph. Each newline outside a fenced
 * code block becomes a hard break.
 */
export function withLineBreaks(text: string): string {
  let fenced = false;
  const lines = text.split("\n");
  return lines
    .map((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      const next = lines[index + 1];
      return !fenced && line.trim() && next !== undefined && next.trim() ? `${line.trimEnd()}  ` : line;
    })
    .join("\n");
}

/**
 * A text output (an LLM's reply) as markdown, with copy. Past about twelve
 * lines it folds, fading out, behind "Show more". A text the record had to
 * shorten copies whole from `fullText` (the node's, while it holds it), else
 * says it is shortened.
 */
export function RunTextCard({ output, fullText }: { output: AgentRunOutput; fullText?: string }) {
  const text = output.text ?? "";
  const meta = [output.model, output.truncated && !fullText ? "Shortened" : undefined].filter(Boolean).join(" · ");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text, expanded]);
  const folded = !expanded && overflows;

  return (
    <div data-run-text={output.id} className={cn(ROW_FRAME, "flex flex-col pt-1 pr-1 pb-2 pl-3")}>
      <RowHeading handle="text" title={output.nodeTitle} meta={meta} action={<CardCopyButton value={fullText ?? text} label="Copy text" />} />
      <div
        ref={bodyRef}
        className={cn(
          "relative mt-0.5 overflow-hidden pr-2",
          !expanded && "max-h-[12lh]",
          folded && "[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_2.5rem),transparent)]",
        )}
      >
        {/* Finished text: nothing to repair as it streams, so a stray "*" stays a "*". */}
        <MessageResponse parseIncompleteMarkdown={false}>{withLineBreaks(text)}</MessageResponse>
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="-ml-1.5 mt-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-neutral-400 transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** A text output still being written: a few lines of skeleton. */
export function PendingTextCard({ pending }: { pending: PendingOutput }) {
  return (
    <div data-run-skeleton="text" className={cn(ROW_FRAME, "flex flex-col gap-2 px-3 pt-1 pb-3")}>
      <RowHeading handle="text" title={pending.nodeTitle} />
      <div aria-hidden="true" className="flex flex-col gap-1.5 motion-safe:animate-pulse">
        <span className="h-2.5 w-11/12 rounded-full bg-white/[0.06]" />
        <span className="h-2.5 w-4/5 rounded-full bg-white/[0.06]" />
        <span className="h-2.5 w-3/5 rounded-full bg-white/[0.06]" />
      </div>
    </div>
  );
}
