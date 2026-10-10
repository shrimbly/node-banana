"use client";

import { Box, ChevronDown, Columns2, Download, LayoutGrid, Play, Rows2, SquareArrowRightExit, SquareDashed } from "lucide-react";
import { MenuDivider, MenuIconButton, MenuSurface } from "@/components/ui/Menu";
import { Tooltip, type TooltipPlacement } from "@/components/ui/Tooltip";
import { useStore } from "@xyflow/react";
import { ViewportPortal } from "@/components/flowPortals";
import { useShallow } from "zustand/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import { memo, useMemo, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import JSZip from "jszip";
import type {
  ImageInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  OutputNodeData,
} from "@/types";
import { parseDataUrl } from "@/utils/dataUrl";
import { sniffExtension } from "@/utils/mediaSniff";
import { getNodeSize } from "@/utils/nodeDimensions";
import { arrangeNodes, STACK_GAP, type Arrangement } from "@/utils/arrangeNodes";
import { cn } from "@/components/nodes/ui/cn";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { capabilityForGenerateNode, sharedGenerateType } from "@/store/utils/modelSelection";

/** A zipped image's extension when its bytes don't prove one. */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const ARRANGEMENTS: { mode: Arrangement; label: string; shortcut?: string; Icon: typeof LayoutGrid }[] = [
  { mode: "horizontal", label: "Stack horizontally", Icon: Columns2 },
  { mode: "vertical", label: "Stack vertically", shortcut: "V", Icon: Rows2 },
  { mode: "grid", label: "Arrange as grid", shortcut: "G", Icon: LayoutGrid },
];
/** Keeps a press inside the menu or slider from panning, dragging or deselecting on the canvas beneath. */
/** Screen px between the bar's bottom and the top of the selection: room for the
 *  spacing slider, which hangs under the bar, to clear a node's title row. */
const TOOLBAR_GAP = 48;

const stopCanvasEvents = {
  onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
  onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
};

/** A bar button with the chrome's hover label, which is also its accessible name. */
function ToolbarButton({
  label,
  shortcut,
  silent = false,
  tooltipPlacement = "top",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  /** Suppress the hover label (while this button's own menu is up). */
  silent?: boolean;
  tooltipPlacement?: TooltipPlacement;
}) {
  return (
    <div role="none" className="group relative flex">
      <MenuIconButton aria-label={label} {...rest} />
      {!silent && <Tooltip label={label} shortcut={shortcut} placement={tooltipPlacement} />}
    </div>
  );
}

// Memoised: rendered by the canvas, which re-renders on every drag frame
export const MultiSelectToolbar = memo(function MultiSelectToolbar() {
  // Only the selection: a drag of anything else must not re-render the toolbar
  const selectedNodes = useWorkflowStore(useShallow((state) => state.nodes.filter((node) => node.selected)));
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const createGroup = useWorkflowStore((state) => state.createGroup);
  const removeNodesFromGroup = useWorkflowStore((state) => state.removeNodesFromGroup);
  const runBatch = useWorkflowStore((state) => state.runBatch);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const runCount = useWorkflowStore((state) => state.runCount);
  const applyModelToNodes = useWorkflowStore((state) => state.applyModelToNodes);
  // One model for the whole selection, offered when every node is the same kind of generator
  const generateType = useMemo(() => sharedGenerateType(selectedNodes), [selectedNodes]);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  // The bar lives in the canvas's own coordinates (ViewportPortal), so it pans
  // and zooms with the nodes; the zoom is read back to keep it at screen size.
  const zoom = useStore((state) => state.transform[2]);
  const selectionKey = JSON.stringify(selectedNodes.map((node) => node.id).sort());
  const [arrangement, setArrangement] = useState<{
    selectionKey: string;
    mode: Arrangement;
    nodes: typeof selectedNodes;
    position: { x: number; y: number };
    gap: number;
  } | null>(null);
  const [arrangeMenuOpen, setArrangeMenuOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Clear the spacing control when the selection changes, including deselection.
  if (arrangement && arrangement.selectionKey !== selectionKey) {
    setArrangement(null);
  }
  const activeArrangement = arrangement?.selectionKey === selectionKey ? arrangement : null;
  const popoverOpen = arrangeMenuOpen || activeArrangement !== null;

  // The menu and the spacing slider behave like a popover: a press outside the
  // toolbar closes both; Escape closes the menu first, then the slider.
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      setArrangeMenuOpen(false);
      setArrangement(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (arrangeMenuOpen) setArrangeMenuOpen(false);
      else setArrangement(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [popoverOpen, arrangeMenuOpen]);

  // Check if any selected nodes are in a group
  const selectedNodeGroups = useMemo(() => {
    const groupIds = new Set(selectedNodes.map((n) => n.groupId).filter(Boolean));
    return [...groupIds];
  }, [selectedNodes]);

  const someInGroup = selectedNodeGroups.length > 0;

  // Where the bar hangs: the top centre of the selection, in flow units. A bar
  // anchored to the canvas can always be panned into view, unlike one fixed to
  // the screen, which a selection near the top pushed under the tab strip.
  const toolbarPosition = useMemo(() => {
    if (selectedNodes.length < 2) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;

    selectedNodes.forEach((node) => {
      const nodeWidth = getNodeSize(node).width;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + nodeWidth);
    });

    return { x: (minX + maxX) / 2, y: minY };
  }, [selectedNodes]);

  const applyArrangement = (mode: Arrangement, gap: number, nodes = selectedNodes) => {
    if (selectedNodes.length < 2) return;
    onNodesChange(arrangeNodes(mode, nodes, gap));
  };

  const chooseArrangement = (mode: Arrangement) => {
    setArrangeMenuOpen(false);
    if (!toolbarPosition || activeArrangement?.mode === mode) return;
    const gap = activeArrangement?.gap ?? STACK_GAP;
    setArrangement({
      selectionKey, mode, nodes: selectedNodes, gap,
      position: activeArrangement?.position ?? toolbarPosition,
    });
    applyArrangement(mode, gap);
  };

  const handleCreateGroup = () => {
    const nodeIds = selectedNodes.map((n) => n.id);
    createGroup(nodeIds);
  };

  const handleUngroup = () => {
    const nodeIds = selectedNodes.map((n) => n.id);
    removeNodesFromGroup(nodeIds);
  };

  const handleDownloadImages = useCallback(async () => {
    // Extract images from selected nodes based on node type
    const images: { bytes: Uint8Array; name: string }[] = [];

    selectedNodes.forEach((node, index) => {
      let imageData: string | null = null;

      switch (node.type) {
        case "imageInput":
          imageData = (node.data as ImageInputNodeData).image;
          break;
        case "annotation":
          imageData = (node.data as AnnotationNodeData).outputImage;
          break;
        case "nanoBanana":
          imageData = (node.data as NanoBananaNodeData).outputImage;
          break;
        case "output":
          imageData = (node.data as OutputNodeData).image;
          break;
      }

      // Only the payload is decoded (any declared type, or none); anything else — a URL — is left out
      // rather than written into the zip as noise.
      const parsed = imageData ? parseDataUrl(imageData) : null;
      if (parsed) {
        const ext = sniffExtension(parsed.bytes, "image") ?? IMAGE_MIME_EXTENSIONS[parsed.mime] ?? "png";
        images.push({ bytes: parsed.bytes, name: `image-${index + 1}.${ext}` });
      }
    });

    if (images.length === 0) return;

    // Create ZIP file
    const zip = new JSZip();
    images.forEach(({ bytes, name }) => {
      zip.file(name, bytes);
    });

    // Generate and download
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `images-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [selectedNodes]);

  if (!toolbarPosition || selectedNodes.length < 2) return null;
  // While the spacing slider is in use the bar stays where it was when the
  // arrangement began, so it does not slide under the pointer as the nodes spread.
  const anchor = activeArrangement?.position ?? toolbarPosition;

  return (
    <>
    <ViewportPortal>
    <div
      // The viewport layer is pointer-events: none (nodes opt back in); so does the bar.
      // A press inside it is the bar's own, never the pane's.
      // Above every node: React Flow lifts a selected node to z-index 1000 in this same layer.
      className="absolute left-0 top-0 z-[100000] pointer-events-auto"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      style={{
        // To the anchor, then unscale so the bar keeps its screen size, then sit
        // its bottom centre a gap above the anchor (the gap is in bar px, so it
        // comes out as screen px after the unscale).
        transform: `translate(${anchor.x}px, ${anchor.y}px) scale(${1 / zoom}) translate(-50%, calc(-100% - ${TOOLBAR_GAP}px))`,
        transformOrigin: "0 0",
      }}
    >
    <MenuSurface
      ref={toolbarRef}
      variant="bar"
      floating={false}
      className="nodrag nopan relative"
    >
      {/* Run just the selection */}
      <ToolbarButton
        onClick={() => runBatch({ kind: "nodes", nodeIds: selectedNodes.map((node) => node.id) })}
        disabled={isRunning}
        label={runCount > 1 ? `Run selected nodes ${runCount}×` : "Run selected nodes"}
        shortcut="⌥↵"
      >
        <Play size={16} strokeWidth={0} fill="currentColor" />
      </ToolbarButton>

      {/* Separator */}
      <MenuDivider variant="bar" className="mx-0.5" />

      <ToolbarButton
        onClick={() => setArrangeMenuOpen((open) => !open)}
        label="Arrange nodes"
        silent={popoverOpen}
        aria-haspopup="menu"
        aria-expanded={arrangeMenuOpen}
        className={cn(
          "flex items-center gap-0.5 pr-1",
          (arrangeMenuOpen || activeArrangement) && "bg-neutral-700 text-neutral-100"
        )}
      >
        <LayoutGrid size={16} strokeWidth={1.5} />
        <ChevronDown
          size={12}
          strokeWidth={2.25}
          className={cn("transition-transform duration-[120ms]", arrangeMenuOpen && "rotate-180")}
        />
      </ToolbarButton>

      {/* Separator */}
      <MenuDivider variant="bar" className="mx-0.5" />

      {/* Group/Ungroup buttons */}
      {someInGroup ? (
        <ToolbarButton onClick={handleUngroup} label="Remove from group">
          <SquareArrowRightExit size={16} strokeWidth={1.5} />
        </ToolbarButton>
      ) : (
        <ToolbarButton onClick={handleCreateGroup} label="Create group">
          <SquareDashed size={16} strokeWidth={1.5} />
        </ToolbarButton>
      )}

      {/* Separator */}
      <MenuDivider variant="bar" className="mx-0.5" />

      {generateType && (
        <>
          <ToolbarButton onClick={() => setModelDialogOpen(true)} label="Change model for selected nodes">
            <Box size={16} strokeWidth={1.5} />
          </ToolbarButton>
          <MenuDivider variant="bar" className="mx-0.5" />
        </>
      )}

      {/* Download images button */}
      <ToolbarButton onClick={handleDownloadImages} label="Download images as ZIP">
        <Download size={16} strokeWidth={1.5} />
      </ToolbarButton>

      {/* The slider sits directly under the bar, and a reopened menu opens beneath it so the slider never moves */}
      {popoverOpen && (
        <div className="absolute top-full left-1/2 mt-1.5 -translate-x-1/2 flex flex-col items-center gap-1.5">
        {activeArrangement && (
          <MenuSurface
            variant="bar"
            floating={false}
            className="nodrag nopan w-[200px] gap-2 px-2.5 py-1.5"
            {...stopCanvasEvents}
          >
            <span className="text-[10px] text-neutral-400">Gap</span>
            <input
              type="range"
              aria-label="Node spacing"
              aria-valuetext={`${activeArrangement.gap} pixels`}
              min={0}
              max={200}
              step={1}
              value={activeArrangement.gap}
              className="nodrag nopan min-w-0 flex-1 h-4 accent-neutral-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection rounded"
              onChange={(event) => {
                const gap = Number(event.target.value);
                setArrangement({ ...activeArrangement, gap });
                applyArrangement(activeArrangement.mode, gap, activeArrangement.nodes);
              }}
            />
            <span className="w-9 text-right text-[10px] text-neutral-400 tabular-nums">
              {activeArrangement.gap}px
            </span>
          </MenuSurface>
        )}
        {arrangeMenuOpen && (
          <MenuSurface
            variant="bar"
            floating={false}
            role="menu"
            aria-label="Arrange nodes"
            aria-orientation="horizontal"
            className="nodrag nopan"
            {...stopCanvasEvents}
          >
            {ARRANGEMENTS.map(({ mode, label, shortcut, Icon }) => (
              // Labels hang below the menu, clear of the bar and the slider above it
              <ToolbarButton
                key={mode}
                role="menuitemradio"
                aria-checked={activeArrangement?.mode === mode}
                label={label}
                shortcut={shortcut}
                tooltipPlacement="bottom"
                onClick={() => chooseArrangement(mode)}
                className={cn(activeArrangement?.mode === mode && "bg-neutral-700 text-neutral-100")}
              >
                <Icon size={16} strokeWidth={1.5} />
              </ToolbarButton>
            ))}
          </MenuSurface>
        )}
        </div>
      )}
    </MenuSurface>
    </div>
    </ViewportPortal>
      {/* The dialog is a window of its own, outside the canvas's transform. */}
      {modelDialogOpen && generateType && (
        <ModelSearchDialog
          isOpen
          onClose={() => setModelDialogOpen(false)}
          title={`Change model for ${selectedNodes.length} nodes`}
          initialCapabilityFilter={capabilityForGenerateNode(generateType)}
          onModelSelected={(model) => {
            applyModelToNodes(selectedNodes.map((node) => node.id), model);
            setModelDialogOpen(false);
          }}
        />
      )}
    </>
  );
});
