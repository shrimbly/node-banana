"use client";

import { MenuDivider, MenuItem, MenuSectionLabel, MenuStepper, MenuSurface } from "@/components/ui/Menu";
import { MAX_RUN_COUNT } from "@/store/utils/runBatch";
import { groupLabelColor } from "@/utils/groupColors";
import { getPaneCenter } from "@/utils/canvasPaneCenter";
import { useRef, useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { ChromeIconButton, type ChromeIconButtonProps } from "./ChromeIconButton";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { NodeType } from "@/types";
import { useReactFlow } from "@xyflow/react";
import { ModelSearchDialog } from "./modals/ModelSearchDialog";
import { useFTUXStore, TutorialStep } from "@/store/ftuxStore";
import type { EdgeStyle } from "@/types";
import {
  CHROME_DIVIDER,
  CHROME_SURFACE,
} from "./chromeStyles";
import { KbdGroup } from "@/components/ui/Kbd";
import {
  AlignLeft,
  Box,
  ChevronDown,
  ChevronUp,
  ChevronsRight,
  Eye,
  EyeOff,
  FastForward,
  Group,
  Image,
  LoaderCircle,
  MessageSquareText,
  Play,
  Repeat,
  Shapes,
  Sparkles,
  SquareArrowOutUpRight,
  Video,
  type LucideProps,
} from "lucide-react";

/** The action-bar button cycles curved → angular → straight → curved. */
const NEXT_EDGE_STYLE: Record<EdgeStyle, EdgeStyle> = { curved: "angular", angular: "straight", straight: "curved" };

// All nodes menu categories
const ALL_NODES_CATEGORIES: { label: string; nodes: { type: NodeType; label: string }[] }[] = [
  {
    label: "Input",
    nodes: [
      { type: "imageInput", label: "Image Input" },
      { type: "audioInput", label: "Audio Input" },
      { type: "videoInput", label: "Video Input" },
      { type: "glbViewer", label: "3D Viewer" },
    ],
  },
  {
    label: "Text",
    nodes: [
      { type: "prompt", label: "Prompt" },
      { type: "promptConstructor", label: "Prompt Constructor" },
      { type: "array", label: "Array" },
    ],
  },
  {
    label: "Generate",
    nodes: [
      { type: "nanoBanana", label: "Generate Image" },
      { type: "generateVideo", label: "Generate Video" },
      { type: "generate3d", label: "Generate 3D" },
      { type: "generateAudio", label: "Generate Audio" },
      { type: "llmGenerate", label: "LLM Generate" },
    ],
  },
  {
    label: "Process",
    nodes: [
      { type: "annotation", label: "Annotate" },
      { type: "splitGrid", label: "Split Grid" },
      { type: "videoStitch", label: "Video Stitch" },
      { type: "videoTrim", label: "Video Trim" },
      { type: "easeCurve", label: "Ease Curve" },
      { type: "videoFrameGrab", label: "Frame Grab" },
      { type: "removeBackground", label: "Remove Background" },
      { type: "imageCompare", label: "Image Compare" },
    ],
  },
  {
    label: "Route",
    nodes: [
      { type: "router", label: "Router" },
      { type: "switch", label: "Switch" },
      { type: "conditionalSwitch", label: "Conditional Switch" },
    ],
  },
  {
    label: "Output",
    nodes: [
      { type: "output", label: "Output" },
      { type: "outputGallery", label: "Output Gallery" },
    ],
  },
];


// ---- Icons: Lucide at 20px, 1.5 stroke, one style throughout ------------------

const ICON: LucideProps = { size: 20, strokeWidth: 1.5 };
/** Menu rows run a size down. */
const MENU_ICON: LucideProps = { size: 14, strokeWidth: 2 };

const ImageIcon = () => <Image {...ICON} />;
const VideoIcon = () => <Video {...ICON} />;
const PromptIcon = () => <AlignLeft {...ICON} />;
const SparkleIcon = () => <Sparkles {...ICON} />;
const OutputIcon = () => <SquareArrowOutUpRight {...ICON} />;
/** All nodes: one of every kind. */
const NodesIcon = () => <Shapes {...ICON} />;
/** All models: a box of models. The 3D item in the Generate menu uses the same cube. */
const ModelsIcon = () => <Box {...ICON} />;
/** 3D generation. */
const CubeIcon = () => <Box {...ICON} />;
const LlmIcon = () => <MessageSquareText {...ICON} />;
const CaretUpIcon = ({ open = false }: { open?: boolean }) => (
  <ChevronUp size={12} strokeWidth={2.25} className={`transition-transform duration-[120ms] ${open ? "rotate-180" : ""}`} />
);
const PlayIcon = () => <Play size={18} strokeWidth={0} fill="currentColor" />;
const SpinnerIcon = () => <LoaderCircle size={16} strokeWidth={3} className="animate-spin" />;

// ---- Primitives -------------------------------------------------------------------

/** The bar runs one size up from the navigator. */
function IconButton(props: ChromeIconButtonProps) {
  return <ChromeIconButton size="lg" {...props} />;
}

function Divider() {
  return <div className={CHROME_DIVIDER} />;
}

/** Closes a popover on outside mousedown while it is open. */
function useClickOutside(ref: React.RefObject<HTMLElement | null>, isOpen: boolean, onClose: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [ref, isOpen, onClose]);
}

/** Adds a node at the pane centre (jittered when `scatter`), or via drag onto the canvas. */
function useAddNode(scatter = false) {
  const addNode = useWorkflowStore((state) => state.addNode);
  const { screenToFlowPosition } = useReactFlow();

  const add = useCallback((type: NodeType) => {
    const center = getPaneCenter();
    const jitter = () => (scatter ? Math.random() * 100 - 50 : 0);
    // Nodes are created empty - tutorial will populate after connection
    addNode(type, screenToFlowPosition({ x: center.x + jitter(), y: center.y + jitter() }));
  }, [addNode, screenToFlowPosition, scatter]);

  const dragStart = useCallback((event: React.DragEvent, type: NodeType) => {
    event.dataTransfer.setData("application/node-type", type);
    event.dataTransfer.effectAllowed = "copy";
  }, []);

  return { add, dragStart };
}

interface NodeButtonProps {
  type: NodeType;
  label: string;
  shortcut?: string;
  dataTutorial?: string;
  children: ReactNode;
}

function NodeButton({ type, label, shortcut, dataTutorial, children }: NodeButtonProps) {
  const { add, dragStart } = useAddNode();
  return (
    <IconButton
      label={label}
      shortcut={shortcut}
      onClick={() => add(type)}
      draggable
      onDragStart={(e) => dragStart(e, type)}
      data-tutorial={dataTutorial}
      className="cursor-grab active:cursor-grabbing"
    >
      {children}
    </IconButton>
  );
}

const GENERATORS: { type: NodeType; label: string; shortcut?: string; icon: ReactNode }[] = [
  { type: "nanoBanana", label: "Image", shortcut: "⇧G", icon: <ImageIcon /> },
  { type: "generateVideo", label: "Video", shortcut: "⇧V", icon: <VideoIcon /> },
  { type: "generate3d", label: "3D", shortcut: "⇧D", icon: <CubeIcon /> },
  { type: "llmGenerate", label: "Text (LLM)", shortcut: "⇧L", icon: <LlmIcon /> },
];

/** One trigger; the menu lists the generators. Clicking the trigger never adds a node. */
function GenerateMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { add, dragStart } = useAddNode(true);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, isOpen, close);

  const handleAddNode = (type: NodeType) => {
    add(type);
    setIsOpen(false);
  };

  return (
    <div className="relative flex" ref={menuRef}>
      <IconButton
        label="Generate"
        open={isOpen}
        silent={isOpen}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="w-auto gap-0.5 pl-1.5 pr-1"
      >
        <SparkleIcon />
        <CaretUpIcon open={isOpen} />
      </IconButton>

      {isOpen && (
        <MenuSurface floating={false} role="menu" className="absolute bottom-full left-0 z-20 mb-2 min-w-[168px] py-1">
          {GENERATORS.map((g) => (
            <MenuItem
              key={g.type}
              role="menuitem"
              onClick={() => handleAddNode(g.type)}
              draggable
              onDragStart={(e) => { dragStart(e, g.type); setIsOpen(false); }}
              className="cursor-grab active:cursor-grabbing"
            >
              <span className="text-neutral-300">{g.icon}</span>
              <span className="whitespace-nowrap">{g.label}</span>
              {g.shortcut && <KbdGroup keys={g.shortcut} className="ml-auto pl-3" />}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </div>
  );
}

function AllNodesMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { add, dragStart } = useAddNode(true);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, isOpen, close);

  const handleAddNode = useCallback((type: NodeType) => {
    add(type);
    setIsOpen(false);
  }, [add]);

  return (
    <div className="relative flex" ref={menuRef}>
      <IconButton
        label="All nodes"
        open={isOpen}
        silent={isOpen}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        <NodesIcon />
      </IconButton>

      {isOpen && (
        <MenuSurface
          floating={false}
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-2 max-h-[400px] min-w-[188px] overflow-y-auto"
        >
          {ALL_NODES_CATEGORIES.map((category, catIndex) => (
            <div key={category.label}>
              <MenuSectionLabel className={`px-3 py-1${catIndex > 0 ? " border-t border-chrome-border" : ""}`}>
                {category.label}
              </MenuSectionLabel>
              {category.nodes.map((node) => (
                <MenuItem
                  key={node.type}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAddNode(node.type)}
                  draggable
                  onDragStart={(e) => { dragStart(e, node.type); setIsOpen(false); }}
                  className="cursor-grab active:cursor-grabbing"
                >
                  {node.label}
                </MenuItem>
              ))}
            </div>
          ))}
        </MenuSurface>
      )}
    </div>
  );
}

/** A diagram of the connector style rather than a symbol, so it stays hand-drawn. */
function EdgeStyleIcon({ style }: { style: EdgeStyle }) {
  const d = style === "angular" ? "M4 12h4l4-8 4 8h4" : style === "straight" ? "M4 16L20 8" : "M4 17c0 0 4-10 8-10s8 10 8 10";
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const EyeIcon = ({ off = false }: { off?: boolean }) => (off ? <EyeOff {...ICON} /> : <Eye {...ICON} />);

export function FloatingActionBar() {
  const {
    nodeCount,
    hasStandaloneNode,
    runningNodeName,
    isRunning,
    currentNodeIds,
    runBatch,
    requestStop,
    runCount,
    setRunCount,
    batch,
    mockTutorialExecution,
    edgeStyle,
    setEdgeStyle,
    setAllEdgesHidden,
    setModelSearchOpen,
    modelSearchOpen,
    modelSearchProvider,
  } = useWorkflowStore(useShallow((state) => ({
    nodeCount: state.nodes.length,
    hasStandaloneNode: state.nodes.some((node) => node.type === "comfyApp"),
    runningNodeName: (() => {
      const node = state.currentNodeIds.length === 1 ? state.nodes.find((node) => node.id === state.currentNodeIds[0]) : undefined;
      return node?.data?.customTitle || node?.type || "node";
    })(),
    isRunning: state.isRunning,
    currentNodeIds: state.currentNodeIds,
    runBatch: state.runBatch,
    requestStop: state.requestStop,
    runCount: state.runCount,
    setRunCount: state.setRunCount,
    batch: state.batch,
    mockTutorialExecution: state.mockTutorialExecution,
    edgeStyle: state.edgeStyle,
    setEdgeStyle: state.setEdgeStyle,
    setAllEdgesHidden: state.setAllEdgesHidden,
    setModelSearchOpen: state.setModelSearchOpen,
    modelSearchOpen: state.modelSearchOpen,
    modelSearchProvider: state.modelSearchProvider,
  })));

  // FTUX tutorial state (client-side only to avoid SSR hydration issues)
  const [tutorialActive, setTutorialActive] = useState(false);
  const [currentTutorialStep, setCurrentTutorialStep] = useState(0);
  const [tutorialSteps, setTutorialSteps] = useState<TutorialStep[]>([]);
  // Run shortcut hint; resolved after mount so the server and client markup agree.
  const [modKey, setModKey] = useState("Ctrl");

  useEffect(() => {
    // Subscribe to FTUX store on client-side only
    const unsubscribe = useFTUXStore.subscribe((state) => {
      setTutorialActive(state.tutorialActive);
      setCurrentTutorialStep(state.currentTutorialStep);
      setTutorialSteps(state.tutorialSteps);
    });

    // Initialize with current state
    const currentState = useFTUXStore.getState();
    setTutorialActive(currentState.tutorialActive);
    setCurrentTutorialStep(currentState.currentTutorialStep);
    setTutorialSteps(currentState.tutorialSteps);

    if (/Mac|iPod|iPhone|iPad/.test(navigator.userAgent)) setModKey("⌘");

    return unsubscribe;
  }, []);

  // Get display text for running nodes
  const runningNodeCount = currentNodeIds.length;
  const getRunningLabel = () => {
    if (runningNodeCount === 0) return "Running...";
    if (runningNodeCount === 1) {
      return `Running ${runningNodeName}...`;
    }
    return `Running ${runningNodeCount} nodes...`;
  };
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const runMenuRef = useRef<HTMLDivElement>(null);
  // Run is never held back by which nodes are wired: a node with nothing to
  // work with is skipped during the run and flagged on the node. A graph with
  // no connections at all has nothing to run, unless it holds a node that runs
  // on its own (a ComfyUI app with its values baked in).
  const totalEdgeCount = useWorkflowStore((state) => state.edges.length);
  const valid = nodeCount > 0 && (totalEdgeCount > 0 || hasStandaloneNode);
  const errors = valid ? [] : [nodeCount === 0 ? "Workflow is empty" : "Connect some nodes to run"];

  const selectedNodeIds = useWorkflowStore(useShallow((state) => state.nodes.filter((node) => node.selected).map((node) => node.id)));
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  // The selection is exactly one unlocked group's nodes: "Run selected" reads as running that group
  const selectedGroup = useWorkflowStore(useShallow((state) => {
    const selected = state.nodes.filter((node) => node.selected);
    const groupId = selected[0]?.groupId;
    const group = groupId ? state.groups[groupId] : undefined;
    if (!groupId || !group || group.locked || !selected.every((node) => node.groupId === groupId)) return null;
    const members = state.nodes.filter((node) => node.groupId === groupId).length;
    return members === selected.length ? { name: group.name, color: group.color } : null;
  }));

  // Check if we're on the run options tutorial step
  const isRunOptionsTutorialStep = useMemo(() => {
    if (!tutorialActive || tutorialSteps.length === 0) return false;
    const currentStep = tutorialSteps[currentTutorialStep];
    return currentStep?.id === "explain-run-options";
  }, [tutorialActive, currentTutorialStep, tutorialSteps]);

  // Close run menu when clicking outside (but not during tutorial step)
  const closeRunMenu = useCallback(() => {
    if (!isRunOptionsTutorialStep) setRunMenuOpen(false);
  }, [isRunOptionsTutorialStep]);
  useClickOutside(runMenuRef, runMenuOpen, closeRunMenu);

  // Open run menu when tutorial step is "explain-run-options"
  useEffect(() => {
    if (isRunOptionsTutorialStep) {
      setRunMenuOpen(true);
    }
  }, [isRunOptionsTutorialStep]);

  // Close run menu when tutorial advances past run options
  useEffect(() => {
    if (tutorialActive && tutorialSteps.length > 0) {
      const currentStep = tutorialSteps[currentTutorialStep];
      // Close menu when we're on run-workflow or later steps
      if (currentStep?.id === "run-workflow" || currentStep?.id === "demonstrate-downstream" || currentStep?.id === "demonstrate-complete") {
        setRunMenuOpen(false);
      }
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps]);

  const toggleEdgeStyle = () => {
    setEdgeStyle(NEXT_EDGE_STYLE[edgeStyle]);
  };

  // Hidden connections: the eye shows how many are hidden and toggles them all
  const hiddenEdgeCount = useWorkflowStore((state) => state.edges.filter((e) => e.data?.hidden).length);
  const toggleHiddenEdges = () => {
    setAllEdgesHidden(hiddenEdgeCount === 0);
  };

  // A batch is busy from its first run to its last, including the moments
  // between runs when no run is going.
  const busy = isRunning || batch !== null;

  const handleRunClick = useCallback(() => {
    // Check if we're in tutorial mode
    const ftuxState = useFTUXStore.getState();
    const currentStep = ftuxState.tutorialSteps[ftuxState.currentTutorialStep];

    if (busy) {
      requestStop();
    } else if (ftuxState.tutorialActive && currentStep?.id === "run-workflow") {
      // Use mock execution for tutorial
      mockTutorialExecution();
    } else {
      // Normal execution, as many runs as the menu's count. Resume-from-pause
      // (pause edges) is handled inside executeWorkflow when no explicit start
      // node is given.
      runBatch({ kind: "all" });
    }
  }, [busy, requestStop, runBatch, mockTutorialExecution]);

  const handleRunFromSelected = () => {
    if (selectedNodeId) {
      runBatch({ kind: "from", nodeId: selectedNodeId });
      setRunMenuOpen(false);
    }
  };

  const handleRunSelectedNodes = () => {
    if (selectedNodeIds.length > 0) {
      runBatch({ kind: "nodes", nodeIds: selectedNodeIds });
      setRunMenuOpen(false);
    }
  };

  const hiddenEdgesLabel = hiddenEdgeCount > 0
    ? `Show ${hiddenEdgeCount} hidden connection${hiddenEdgeCount === 1 ? "" : "s"}`
    : "Hide all connections";
  const edgeStyleLabel = `Switch to ${NEXT_EDGE_STYLE[edgeStyle]} connectors`;
  const desktopConnected = useWorkflowStore(state => state.desktopConnected);
  const runTitle = !desktopConnected
    ? "Local server disconnected"
    : !valid
      ? errors.join("\n")
      : batch
        ? batch.stopping
          ? `Stopping after run ${batch.index}. Click again to stop now`
          : batch.index < batch.count
            ? `Run ${batch.index} of ${batch.count}. Stop finishes this run first`
            : `Run ${batch.index} of ${batch.count}`
        : isRunning
          ? getRunningLabel()
          : runCount > 1
            ? `Run ${runCount} times`
            : "Run";

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      {/* w-max: a fixed element anchored at left-1/2 otherwise shrinks to half the viewport and wraps. */}
      <div className={`${CHROME_SURFACE} flex h-12 w-max items-center gap-0.5 rounded-xl px-1.5`}>
        <NodeButton type="imageInput" label="Image" shortcut="⇧I" dataTutorial="image-button"><ImageIcon /></NodeButton>
        <NodeButton type="videoInput" label="Video" shortcut="⇧Y"><VideoIcon /></NodeButton>
        <NodeButton type="prompt" label="Prompt" shortcut="⇧P" dataTutorial="prompt-button"><PromptIcon /></NodeButton>
        <GenerateMenu />
        <NodeButton type="output" label="Output" shortcut="⇧O" dataTutorial="output-button"><OutputIcon /></NodeButton>

        <Divider />

        <AllNodesMenu />
        <IconButton label="All models" onClick={() => setModelSearchOpen(true)}>
          <ModelsIcon />
        </IconButton>

        <Divider />

        <IconButton label={edgeStyleLabel} onClick={toggleEdgeStyle}>
          <EdgeStyleIcon style={edgeStyle} />
        </IconButton>
        <IconButton
          label={hiddenEdgesLabel}
          open={hiddenEdgeCount > 0}
          disabled={totalEdgeCount === 0}
          onClick={toggleHiddenEdges}
          badge={hiddenEdgeCount > 0 && (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-neutral-200 px-1 text-center text-[9px] font-semibold leading-[14px] text-neutral-900 ring-2 ring-neutral-800">
              {hiddenEdgeCount}
            </span>
          )}
        >
          <EyeIcon off={hiddenEdgeCount > 0} />
        </IconButton>

        <Divider />

        <div className="relative ml-0.5 flex items-center" ref={runMenuRef}>
          <div
            className={`relative flex h-9 items-stretch overflow-hidden rounded-lg squircle transition-[background-color,box-shadow,transform] duration-[120ms] ease-out ${
              !valid && !busy
                ? "bg-white/8 text-neutral-500"
                : "bg-neutral-50 text-neutral-900 hover:bg-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.35),0_1px_2px_rgba(0,0,0,0.3)] active:scale-[0.97] active:bg-neutral-200"
            }`}
          >
            <button
              type="button"
              onClick={handleRunClick}
              disabled={!desktopConnected || (!valid && !busy)}
              title={runTitle}
              data-tutorial="floating-run-button"
              className="flex items-center gap-1.5 whitespace-nowrap pl-3 pr-3.5 text-[13px] font-semibold focus-visible:outline-none disabled:cursor-not-allowed"
            >
              {batch ? (
                <>
                  <SpinnerIcon />
                  <span>{batch.stopping ? "Stopping" : "Stop"}</span>
                  <span className="font-mono text-[11px] font-medium tabular-nums text-neutral-500">
                    {batch.index} / {batch.count}
                  </span>
                </>
              ) : isRunning ? (
                <>
                  <SpinnerIcon />
                  <span className="max-w-[150px] truncate">
                    {runningNodeCount > 1 ? `${runningNodeCount} nodes` : "Stop"}
                  </span>
                </>
              ) : (
                <>
                  <PlayIcon />
                  <span>Run</span>
                  {runCount > 1 && <span className="-ml-0.5 tabular-nums text-neutral-500">{runCount}×</span>}
                </>
              )}
            </button>

            {/* Dropdown chevron button */}
            {!busy && valid && (
              <button
                type="button"
                onClick={() => setRunMenuOpen(!runMenuOpen)}
                data-tutorial="floating-run-dropdown"
                aria-expanded={runMenuOpen}
                title="Run options"
                className={`flex w-7 items-center justify-center border-l border-black/10 transition-colors duration-[120ms] focus-visible:outline-none ${runMenuOpen ? "bg-neutral-200" : ""}`}
              >
                <ChevronDown size={12} strokeWidth={2.5} className={`transition-transform duration-[120ms] ${runMenuOpen ? "rotate-180" : ""}`} />
              </button>
            )}

            {/* Batch progress: runs finished so far, along the button's bottom edge */}
            {batch && (
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-black/8">
                <span
                  className="block h-full bg-neutral-900 transition-[width] duration-300 ease-out"
                  style={{ width: `${((batch.index - 1) / batch.count) * 100}%` }}
                />
              </span>
            )}
          </div>

          {/* Dropdown menu */}
          {runMenuOpen && !busy && (
            <MenuSurface floating={false} role="menu" data-tutorial="floating-run-menu" className="absolute bottom-full right-0 z-20 mb-2 min-w-[220px] py-1 [&_button]:whitespace-nowrap">
              <MenuItem
                role="menuitem"
                onClick={() => {
                  runBatch({ kind: "all" });
                  setRunMenuOpen(false);
                }}
              >
                <PlayIcon />
                Run all
                <KbdGroup keys={[modKey, "↵"]} className="ml-auto pl-3" />
              </MenuItem>
              <MenuItem
                role="menuitem"
                onClick={handleRunFromSelected}
                disabled={!selectedNodeId}
                title={!selectedNodeId ? "Select a single node first" : undefined}
              >
                <ChevronsRight {...MENU_ICON} />
                Run from selected
              </MenuItem>
              <MenuItem
                role="menuitem"
                onClick={handleRunSelectedNodes}
                disabled={selectedNodeIds.length === 0}
                title={selectedNodeIds.length === 0 ? "Select one or more nodes first" : `Run ${selectedNodeIds.length} selected node${selectedNodeIds.length > 1 ? 's' : ''}`}
              >
                {selectedGroup ? (
                  <>
                    <Group {...MENU_ICON} />
                    Run group
                    <span className="max-w-[140px] truncate" style={{ color: groupLabelColor(selectedGroup.color) }}>
                      {selectedGroup.name}
                    </span>
                  </>
                ) : (
                  <>
                    <FastForward {...MENU_ICON} />
                    {selectedNodeIds.length > 1 ? `Run ${selectedNodeIds.length} selected` : "Run selected"}
                  </>
                )}
                <KbdGroup keys={["⌥", "↵"]} className="ml-auto pl-3" />
              </MenuItem>
              <MenuDivider className="my-1" />
              {/* How many times each row above (and ⌘↵ / ⌥↵) runs; saved with the workflow */}
              <div className="flex min-h-7 items-center gap-2 px-2.5 py-1 text-xs text-neutral-300">
                <Repeat {...MENU_ICON} />
                <span>Runs</span>
                <MenuStepper label="Runs" value={runCount} min={1} max={MAX_RUN_COUNT} onChange={setRunCount} />
              </div>
            </MenuSurface>
          )}
        </div>
      </div>

      {/* Model search dialog */}
      <ModelSearchDialog
        isOpen={modelSearchOpen}
        onClose={() => setModelSearchOpen(false)}
        initialProvider={modelSearchProvider}
      />
    </div>
  );
}
