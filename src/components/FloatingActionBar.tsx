"use client";

import { useRef, useState, useEffect, useMemo } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { NodeType } from "@/types";
import { useReactFlow } from "@xyflow/react";
import { ModelSearchDialog } from "./modals/ModelSearchDialog";

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

interface NodeButtonProps {
  type: NodeType;
  label: string;
}

function NodeButton({ type, label }: NodeButtonProps) {
  const addNode = useWorkflowStore((state) => state.addNode);
  const { screenToFlowPosition } = useReactFlow();

  const handleClick = () => {
    const center = getPaneCenter();
    const position = screenToFlowPosition({
      x: center.x + Math.random() * 100 - 50,
      y: center.y + Math.random() * 100 - 50,
    });

    addNode(type, position);
  };

  const handleDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData("application/node-type", type);
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <button
      onClick={handleClick}
      draggable
      onDragStart={handleDragStart}
      className="px-2.5 py-1.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors cursor-grab active:cursor-grabbing"
    >
      {label}
    </button>
  );
}

function GenerateComboButton() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const addNode = useWorkflowStore((state) => state.addNode);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleAddNode = (type: NodeType) => {
    const center = getPaneCenter();
    const position = screenToFlowPosition({
      x: center.x + Math.random() * 100 - 50,
      y: center.y + Math.random() * 100 - 50,
    });

    addNode(type, position);
    setIsOpen(false);
  };

  const handleDragStart = (event: React.DragEvent, type: NodeType) => {
    event.dataTransfer.setData("application/node-type", type);
    event.dataTransfer.effectAllowed = "copy";
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="px-2.5 py-1.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors flex items-center gap-1"
      >
        Generate
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl overflow-hidden min-w-[140px]">
          <button
            onClick={() => handleAddNode("nanoBanana")}
            draggable
            onDragStart={(e) => handleDragStart(e, "nanoBanana")}
            className="w-full px-3 py-2 text-left text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors flex items-center gap-2 cursor-grab active:cursor-grabbing"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            Image
          </button>
          <button
            onClick={() => handleAddNode("generateVideo")}
            draggable
            onDragStart={(e) => handleDragStart(e, "generateVideo")}
            className="w-full px-3 py-2 text-left text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors flex items-center gap-2 cursor-grab active:cursor-grabbing"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            Video
          </button>
          <button
            onClick={() => handleAddNode("llmGenerate")}
            draggable
            onDragStart={(e) => handleDragStart(e, "llmGenerate")}
            className="w-full px-3 py-2 text-left text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors flex items-center gap-2 cursor-grab active:cursor-grabbing"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
            Text (LLM)
          </button>
        </div>
      )}
    </div>
  );
}


export function FloatingActionBar() {
  const {
    nodes,
    isRunning,
    currentNodeIds,
    executeWorkflow,
    regenerateNode,
    stopWorkflow,
    validateWorkflow,
    edgeStyle,
    setEdgeStyle,
    setModelSearchOpen,
    modelSearchOpen,
    modelSearchProvider,
  } = useWorkflowStore();

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

  // Get the selected node (if exactly one is selected)
  const selectedNode = useMemo(() => {
    const selected = nodes.filter((n) => n.selected);
    return selected.length === 1 ? selected[0] : null;
  }, [nodes]);

  // Close run menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (runMenuRef.current && !runMenuRef.current.contains(event.target as Node)) {
        setRunMenuOpen(false);
      }
    };

    if (runMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [runMenuOpen]);

  const toggleEdgeStyle = () => {
    setEdgeStyle(edgeStyle === "angular" ? "curved" : "angular");
  };

  const handleRunClick = () => {
    if (isRunning) {
      stopWorkflow();
    } else {
      executeWorkflow();
    }
  };

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

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50">
      <div className="flex items-center gap-0.5 bg-neutral-800/95 backdrop-blur-sm rounded-lg shadow-lg border border-neutral-700/80 px-1.5 py-1">
        <NodeButton type="imageInput" label="Image" />
        <NodeButton type="glbViewer" label="3D" />
        <NodeButton type="annotation" label="Annotate" />
        <NodeButton type="prompt" label="Prompt" />
        <GenerateComboButton />
        <NodeButton type="output" label="Output" />

        {/* Browse models button */}
        <div className="w-px h-5 bg-neutral-600 mx-1.5" />
        <button
          onClick={() => setModelSearchOpen(true)}
          title="Browse models"
          className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>

        <div className="w-px h-5 bg-neutral-600 mx-1.5" />

        <button
          onClick={toggleEdgeStyle}
          title={`Switch to ${edgeStyle === "angular" ? "curved" : "angular"} connectors`}
          className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
        >
          {edgeStyle === "angular" ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h4l4-8 4 8h4" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 12c0 0 4-8 8-8s8 8 8 8" />
            </svg>
          )}
        </button>

        <div className="w-px h-5 bg-neutral-600 mx-1.5" />

        <div className="relative flex items-center" ref={runMenuRef}>
          <button
            onClick={handleRunClick}
            disabled={!valid && !isRunning}
            title={!valid ? errors.join("\n") : isRunning ? "Stop" : "Run"}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors ${
              isRunning
                ? "bg-white text-neutral-900 hover:bg-neutral-200 rounded"
                : valid
                ? "bg-white text-neutral-900 hover:bg-neutral-200 rounded-l"
                : "bg-neutral-700 text-neutral-500 cursor-not-allowed rounded"
            }`}
          >
            {isRunning ? (
              <>
                <svg
                  className="w-3 h-3 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="max-w-[150px] truncate" title={getRunningLabel()}>
                  {runningNodeCount > 1 ? `${runningNodeCount} nodes` : "Stop"}
                </span>
              </>
            ) : (
              <>
                <svg
                  className="w-3 h-3"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Run</span>
              </>
            )}
          </button>

          {/* Dropdown chevron button */}
          {!isRunning && valid && (
            <button
              onClick={() => setRunMenuOpen(!runMenuOpen)}
              className="flex items-center self-stretch px-1.5 rounded-r bg-white text-neutral-900 hover:bg-neutral-200 border-l border-neutral-200 transition-colors"
              title="Run options"
            >
              <svg
                className={`w-2.5 h-2.5 transition-transform ${runMenuOpen ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}

          {/* Dropdown menu */}
          {runMenuOpen && !isRunning && (
            <div className="absolute bottom-full right-0 mb-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl overflow-hidden min-w-[180px]">
              <button
                onClick={() => {
                  executeWorkflow();
                  setRunMenuOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Run entire workflow
              </button>
              <button
                onClick={handleRunFromSelected}
                disabled={!selectedNode}
                className={`w-full px-3 py-2 text-left text-[11px] font-medium transition-colors flex items-center gap-2 ${
                  selectedNode
                    ? "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
                    : "text-neutral-500 cursor-not-allowed"
                }`}
                title={!selectedNode ? "Select a single node first" : undefined}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
                Run from selected node
              </button>
              <button
                onClick={handleRunSelectedOnly}
                disabled={!selectedNode}
                className={`w-full px-3 py-2 text-left text-[11px] font-medium transition-colors flex items-center gap-2 ${
                  selectedNode
                    ? "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
                    : "text-neutral-500 cursor-not-allowed"
                }`}
                title={!selectedNode ? "Select a single node first" : undefined}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
                Run selected node only
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
