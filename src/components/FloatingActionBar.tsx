"use client";

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
  CHROME_MENU,
  CHROME_MENU_HEADING,
  CHROME_MENU_HINT,
  CHROME_MENU_ITEM,
  CHROME_SURFACE,
} from "./chromeStyles";

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

// Get the center of the React Flow pane in screen coordinates
function getPaneCenter() {
  const pane = document.querySelector('.react-flow');
  if (pane) {
    const rect = pane.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

// ---- Icons: 16px, 1.5 stroke, one style throughout ------------------------------

const ICON = "h-5 w-5";
const iconProps = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;

const ImageIcon = () => (
  <svg className={ICON} {...iconProps}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3 16l5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);
const VideoIcon = () => (
  <svg className={ICON} {...iconProps}>
    <rect x="3" y="7" width="13" height="10" rx="2.5" />
    <path d="M16 11l5-3v8l-5-3" />
  </svg>
);
const PromptIcon = () => (
  <svg className={ICON} {...iconProps}>
    <path d="M4 6h16M4 12h10M4 18h7" />
  </svg>
);
const SparkleIcon = () => (
  <svg className={ICON} {...iconProps}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  </svg>
);
const OutputIcon = () => (
  <svg className={ICON} {...iconProps}>
    <path d="M14 4h6v6M20 4l-8 8M11 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-5" />
  </svg>
);
const GridIcon = () => (
  <svg className={ICON} {...iconProps}>
    <rect x="4" y="4" width="6" height="6" rx="1.5" />
    <rect x="14" y="4" width="6" height="6" rx="1.5" />
    <rect x="4" y="14" width="6" height="6" rx="1.5" />
    <rect x="14" y="14" width="6" height="6" rx="1.5" />
  </svg>
);
const CubeIcon = () => (
  <svg className={ICON} {...iconProps}>
    <path d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
  </svg>
);
const LlmIcon = () => (
  <svg className={ICON} {...iconProps}>
    <path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
  </svg>
);
const CaretUpIcon = ({ open = false }: { open?: boolean }) => (
  <svg className={`h-3 w-3 transition-transform duration-[120ms] ${open ? "rotate-180" : ""}`} {...iconProps} strokeWidth={2.25}>
    <path d="M5 15l7-7 7 7" />
  </svg>
);
const PlayIcon = () => (
  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const SpinnerIcon = () => (
  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
    <path d="M12 3a9 9 0 019 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

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
  { type: "generate3d", label: "3D", icon: <CubeIcon /> },
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
        <div className={`${CHROME_MENU} left-0 min-w-[168px]`} role="menu">
          {GENERATORS.map((g) => (
            <button
              key={g.type}
              type="button"
              role="menuitem"
              onClick={() => handleAddNode(g.type)}
              draggable
              onDragStart={(e) => { dragStart(e, g.type); setIsOpen(false); }}
              className={`${CHROME_MENU_ITEM} cursor-grab active:cursor-grabbing`}
            >
              <span className="text-neutral-400">{g.icon}</span>
              {g.label}
              {g.shortcut && <span className={CHROME_MENU_HINT}>{g.shortcut}</span>}
            </button>
          ))}
        </div>
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
        <GridIcon />
      </IconButton>

      {isOpen && (
        <div className={`${CHROME_MENU} left-0 max-h-[400px] min-w-[188px] overflow-y-auto`} role="menu">
          {ALL_NODES_CATEGORIES.map((category) => (
            <div key={category.label}>
              <div className={CHROME_MENU_HEADING}>{category.label}</div>
              {category.nodes.map((node) => (
                <button
                  key={node.type}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAddNode(node.type)}
                  draggable
                  onDragStart={(e) => { dragStart(e, node.type); setIsOpen(false); }}
                  className={`${CHROME_MENU_ITEM} cursor-grab active:cursor-grabbing`}
                >
                  {node.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EdgeStyleIcon({ style }: { style: EdgeStyle }) {
  if (style === "angular") {
    return (
      <svg className={ICON} {...iconProps} strokeWidth={1.75}>
        <path d="M4 12h4l4-8 4 8h4" />
      </svg>
    );
  }
  if (style === "straight") {
    return (
      <svg className={ICON} {...iconProps} strokeWidth={1.75}>
        <path d="M4 16L20 8" />
      </svg>
    );
  }
  return (
    <svg className={ICON} {...iconProps} strokeWidth={1.75}>
      <path d="M4 17c0 0 4-10 8-10s8 10 8 10" />
    </svg>
  );
}

const EyeIcon = ({ off = false }: { off?: boolean }) =>
  off ? (
    <svg className={ICON} {...iconProps} strokeWidth={1.75}>
      <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c4.5 0 8.3 2.9 9.6 7a10 10 0 01-2.2 3.6M6.6 6.6A10 10 0 002.4 12c1.3 4.1 5.1 7 9.6 7 1.4 0 2.8-.3 4-.8" />
    </svg>
  ) : (
    <svg className={ICON} {...iconProps} strokeWidth={1.75}>
      <path d="M2.4 12C3.7 7.9 7.5 5 12 5s8.3 2.9 9.6 7c-1.3 4.1-5.1 7-9.6 7s-8.3-2.9-9.6-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

export function FloatingActionBar() {
  const {
    nodes,
    isRunning,
    currentNodeIds,
    executeWorkflow,
    regenerateNode,
    executeSelectedNodes,
    stopWorkflow,
    mockTutorialExecution,
    validateWorkflow,
    edgeStyle,
    setEdgeStyle,
    setAllEdgesHidden,
    setModelSearchOpen,
    modelSearchOpen,
    modelSearchProvider,
  } = useWorkflowStore(useShallow((state) => ({
    nodes: state.nodes,
    isRunning: state.isRunning,
    currentNodeIds: state.currentNodeIds,
    executeWorkflow: state.executeWorkflow,
    regenerateNode: state.regenerateNode,
    executeSelectedNodes: state.executeSelectedNodes,
    stopWorkflow: state.stopWorkflow,
    mockTutorialExecution: state.mockTutorialExecution,
    validateWorkflow: state.validateWorkflow,
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
      const node = nodes.find((n) => n.id === currentNodeIds[0]);
      const nodeName = node?.data?.customTitle || node?.type || "node";
      return `Running ${nodeName}...`;
    }
    return `Running ${runningNodeCount} nodes...`;
  };
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const runMenuRef = useRef<HTMLDivElement>(null);
  const { valid, errors } = validateWorkflow();

  // Get the selected nodes
  const selectedNodes = useMemo(() => {
    return nodes.filter((n) => n.selected);
  }, [nodes]);

  // Get the selected node (if exactly one is selected)
  const selectedNode = useMemo(() => {
    return selectedNodes.length === 1 ? selectedNodes[0] : null;
  }, [selectedNodes]);

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
  const totalEdgeCount = useWorkflowStore((state) => state.edges.length);
  const toggleHiddenEdges = () => {
    setAllEdgesHidden(hiddenEdgeCount === 0);
  };

  const handleRunClick = useCallback(() => {
    // Check if we're in tutorial mode
    const ftuxState = useFTUXStore.getState();
    const currentStep = ftuxState.tutorialSteps[ftuxState.currentTutorialStep];

    if (isRunning) {
      stopWorkflow();
    } else if (ftuxState.tutorialActive && currentStep?.id === "run-workflow") {
      // Use mock execution for tutorial
      mockTutorialExecution();
    } else {
      // Normal execution. Resume-from-pause (pause edges) is handled inside
      // executeWorkflow when no explicit start node is given.
      executeWorkflow();
    }
  }, [isRunning, stopWorkflow, executeWorkflow, mockTutorialExecution]);

  const handleRunFromSelected = () => {
    if (selectedNode) {
      executeWorkflow(selectedNode.id);
      setRunMenuOpen(false);
    }
  };

  const handleRunSelectedOnly = () => {
    if (selectedNode) {
      regenerateNode(selectedNode.id);
      setRunMenuOpen(false);
    }
  };

  const handleRunSelectedNodes = () => {
    if (selectedNodes.length > 0) {
      executeSelectedNodes(selectedNodes.map((n) => n.id));
      setRunMenuOpen(false);
    }
  };

  const hiddenEdgesLabel = hiddenEdgeCount > 0
    ? `Show ${hiddenEdgeCount} hidden connection${hiddenEdgeCount === 1 ? "" : "s"}`
    : "Hide all connections";
  const edgeStyleLabel = `Switch to ${NEXT_EDGE_STYLE[edgeStyle]} connectors`;
  const runTitle = !valid ? errors.join("\n") : isRunning ? getRunningLabel() : "Run";

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      {/* w-max: a fixed element anchored at left-1/2 otherwise shrinks to half the viewport and wraps. */}
      <div className={`${CHROME_SURFACE} flex h-12 w-max items-center gap-0.5 rounded-xl px-1.5`}>
        <NodeButton type="imageInput" label="Image" shortcut="⇧I" dataTutorial="image-button"><ImageIcon /></NodeButton>
        <NodeButton type="videoInput" label="Video" shortcut="⇧Y"><VideoIcon /></NodeButton>
        <NodeButton type="prompt" label="Prompt" shortcut="⇧P" dataTutorial="prompt-button"><PromptIcon /></NodeButton>
        <GenerateMenu />
        <NodeButton type="output" label="Output" dataTutorial="output-button"><OutputIcon /></NodeButton>

        <Divider />

        <AllNodesMenu />
        <IconButton label="All models" onClick={() => setModelSearchOpen(true)}>
          <CubeIcon />
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
            className={`flex h-9 items-stretch overflow-hidden rounded-lg squircle transition-[background-color,box-shadow,transform] duration-[120ms] ease-out ${
              !valid && !isRunning
                ? "bg-white/8 text-neutral-500"
                : "bg-neutral-50 text-neutral-900 hover:bg-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.35),0_1px_2px_rgba(0,0,0,0.3)] active:scale-[0.97] active:bg-neutral-200"
            }`}
          >
            <button
              type="button"
              onClick={handleRunClick}
              disabled={!valid && !isRunning}
              title={runTitle}
              data-tutorial="floating-run-button"
              className="flex items-center gap-1.5 whitespace-nowrap pl-3.5 pr-3 text-[11px] font-semibold focus-visible:outline-none disabled:cursor-not-allowed"
            >
              {isRunning ? (
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
                </>
              )}
            </button>

            {/* Dropdown chevron button */}
            {!isRunning && valid && (
              <button
                type="button"
                onClick={() => setRunMenuOpen(!runMenuOpen)}
                data-tutorial="floating-run-dropdown"
                aria-expanded={runMenuOpen}
                title="Run options"
                className={`flex w-7 items-center justify-center border-l border-black/10 transition-colors duration-[120ms] focus-visible:outline-none ${runMenuOpen ? "bg-neutral-200" : ""}`}
              >
                <svg className={`h-2.5 w-2.5 transition-transform duration-[120ms] ${runMenuOpen ? "rotate-180" : ""}`} {...iconProps} strokeWidth={2.5}>
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>

          {/* Dropdown menu */}
          {runMenuOpen && !isRunning && (
            <div data-tutorial="floating-run-menu" className={`${CHROME_MENU} right-0 min-w-[196px]`} role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  executeWorkflow();
                  setRunMenuOpen(false);
                }}
                className={CHROME_MENU_ITEM}
              >
                <PlayIcon />
                Run entire workflow
                <span className={CHROME_MENU_HINT}>{modKey}↵</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleRunFromSelected}
                disabled={!selectedNode}
                className={CHROME_MENU_ITEM}
                title={!selectedNode ? "Select a single node first" : undefined}
              >
                <svg className="h-3.5 w-3.5" {...iconProps} strokeWidth={2}>
                  <path d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
                Run from selected node
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleRunSelectedOnly}
                disabled={!selectedNode}
                className={CHROME_MENU_ITEM}
                title={!selectedNode ? "Select a single node first" : undefined}
              >
                <svg className="h-3.5 w-3.5" {...iconProps} strokeWidth={2}>
                  <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
                Run selected node only
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleRunSelectedNodes}
                disabled={selectedNodes.length === 0}
                className={CHROME_MENU_ITEM}
                title={selectedNodes.length === 0 ? "Select one or more nodes first" : `Run ${selectedNodes.length} selected node${selectedNodes.length > 1 ? 's' : ''}`}
              >
                <svg className="h-3.5 w-3.5" {...iconProps} strokeWidth={2}>
                  <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                  <path d="M9.75 9.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V9.653z" />
                </svg>
                {selectedNodes.length > 0
                  ? `Run ${selectedNodes.length} selected node${selectedNodes.length !== 1 ? 's' : ''}`
                  : 'Run selected nodes'}
              </button>
            </div>
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
