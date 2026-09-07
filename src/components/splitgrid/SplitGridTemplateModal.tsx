"use client";

/**
 * Split Grid cell template editor — a mini node graph in a modal.
 *
 * Users design the set of nodes created for every split image: the base cell
 * image node is always present, and new nodes are added exactly like on the
 * main canvas — drag from a handle into empty space and pick from the
 * connection menu. Confirming saves the template and materializes one node
 * group per cell.
 */

import {
  Dialog,
  DialogButton,
  DialogCloseButton,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { MenuHeader, MenuIconButton, MenuItem, MenuList, MenuSectionLabel, MenuSurface } from "@/components/ui/Menu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeTypes,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWheelPanZoom } from "@/hooks/useWheelPanZoom";
import type {
  LLMGenerateNodeData,
  NanoBananaNodeData,
  NodeType,
  SplitGridNodeData,
  SplitGridTemplate,
} from "@/types";
import { createDefaultNodeData, defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import {
  clampGridDimension,
  createClassicSplitGridTemplate,
  createDefaultSplitGridTemplate,
  getSplitGridTemplate,
} from "@/store/utils/splitGridTemplate";
import {
  RouterRail,
  RouterWires,
  isInRailDropZone,
  type RouterWire,
  type RailSize,
} from "./RouterRail";
import {
  getTemplateEntry,
  getTemplateNodeIcon,
  TEMPLATE_NODE_CATALOG,
  type TemplateCatalogEntry,
  type TemplateHandleKind,
} from "./templateCatalog";
import {
  SplitGridTemplateNode,
  TemplateEditableEdge,
  TemplateEditorContext,
  templateHandleTop,
  type TemplateNodeData,
  type TemplateRFNode,
} from "./TemplateNodes";
import { GEMINI_IMAGE_MODELS } from "@/types";

const nodeTypes: NodeTypes = {
  splitGridTemplateNode: SplitGridTemplateNode,
};

const edgeTypes: EdgeTypes = {
  templateEditable: TemplateEditableEdge,
};

const TEMPLATE_EDGE_TYPE = "templateEditable";

// Match the main canvas: on macOS a left-drag must not pan (that reads as
// "dragging a connection moved everything"); panning is via the trackpad.
const isMacOS =
  typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const EDGE_COLOR: Record<TemplateHandleKind, string> = {
  image: "#0d9668",
  text: "#2563eb",
};

function edgeStyleFor(sourceHandle: string | null | undefined): React.CSSProperties {
  const kind = (sourceHandle === "text" ? "text" : "image") as TemplateHandleKind;
  return { stroke: EDGE_COLOR[kind], strokeWidth: 2 };
}

/**
 * Snapshot of the user's sticky generate defaults — a template generate node
 * starts from the same settings a Generate Image node gets on the main canvas.
 */
function seedGenerateOverrides(): Record<string, unknown> {
  const defaults = createDefaultNodeData("nanoBanana") as NanoBananaNodeData;
  const seed: Record<string, unknown> = {
    model: defaults.model,
    selectedModel:
      defaults.selectedModel ?? {
        provider: "gemini",
        modelId: defaults.model,
        displayName:
          GEMINI_IMAGE_MODELS.find((m) => m.value === defaults.model)?.label || defaults.model,
      },
    aspectRatio: defaults.aspectRatio,
    resolution: defaults.resolution,
    useGoogleSearch: defaults.useGoogleSearch,
    useImageSearch: defaults.useImageSearch,
  };
  if (defaults.parameters && Object.keys(defaults.parameters).length > 0) {
    seed.parameters = defaults.parameters;
  }
  return seed;
}

/** LLM template nodes start from the same defaults as a main-canvas LLM node */
function seedLlmOverrides(): Record<string, unknown> {
  const defaults = createDefaultNodeData("llmGenerate") as LLMGenerateNodeData;
  return {
    provider: defaults.provider,
    model: defaults.model,
    temperature: defaults.temperature,
    maxTokens: defaults.maxTokens,
  };
}

function seedOverridesFor(type: NodeType): Record<string, unknown> {
  if (type === "nanoBanana") return seedGenerateOverrides();
  if (type === "llmGenerate") return seedLlmOverrides();
  return {};
}

function editorNodeDimensions(type: NodeType): { width: number; height: number } {
  return defaultNodeDimensions[type] ?? { width: 300, height: 280 };
}

function templateToRfNodes(
  template: SplitGridTemplate,
  sourceImage: string | null
): TemplateRFNode[] {
  return template.nodes.map((templateNode) => {
    // Nodes with an in-flow settings panel auto-grow to fit it on mount
    const dims = templateNode.size ?? editorNodeDimensions(templateNode.type);
    const isBase = templateNode.id === template.baseNodeId;
    let overrides = { ...(templateNode.data ?? {}) };
    // Generate/LLM nodes always show concrete settings, like the main canvas
    if (Object.keys(overrides).length === 0) {
      overrides = seedOverridesFor(templateNode.type);
    }
    return {
      id: templateNode.id,
      type: "splitGridTemplateNode",
      position: { ...templateNode.position },
      deletable: !isBase,
      width: dims.width,
      style: { width: dims.width },
      data: {
        nodeType: templateNode.type,
        overrides,
        isBase,
        sourceImage: isBase ? sourceImage : undefined,
      } satisfies TemplateNodeData,
    };
  });
}

/** The downstream-router wiring stored on the template, as editor wire records. */
function templateToRouterWires(template: SplitGridTemplate): RouterWire[] {
  return (template.router ?? []).map((connection) => ({
    source: connection.source,
    sourceHandle: connection.sourceHandle,
  }));
}

function templateToRfEdges(template: SplitGridTemplate): Edge[] {
  return template.edges.map((templateEdge) => ({
    id: templateEdge.id,
    type: TEMPLATE_EDGE_TYPE,
    source: templateEdge.source,
    sourceHandle: templateEdge.sourceHandle,
    target: templateEdge.target,
    targetHandle: templateEdge.targetHandle,
    style: edgeStyleFor(templateEdge.sourceHandle),
  }));
}

/** Serialize editor state back into a template (also used for dirty checks) */
function serializeTemplate(
  baseNodeId: string,
  rfNodes: TemplateRFNode[],
  rfEdges: Edge[],
  routerWires: RouterWire[]
): SplitGridTemplate {
  // The fixed rail's wires become the router wiring (sorted for a stable,
  // non-dirty baseline); targetHandle equals the source handle's type.
  const router = routerWires
    .map((wire) => ({
      source: wire.source,
      sourceHandle: wire.sourceHandle,
      targetHandle: wire.sourceHandle,
    }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.sourceHandle.localeCompare(b.sourceHandle) ||
        a.targetHandle.localeCompare(b.targetHandle)
    );
  return {
    baseNodeId,
    nodes: rfNodes.map((node) => {
      // Persist the node's width and its measured height. Real nodes derive
      // their height from content at runtime, so the height is only a hint
      // for laying the cells out.
      const width =
        (node.width as number | undefined) ?? (node.style?.width as number | undefined);
      const rawHeight = node.measured?.height ?? (node.height as number | undefined);
      const size = width && rawHeight ? { width, height: Math.max(80, rawHeight) } : undefined;
      return {
        id: node.id,
        type: node.data.nodeType,
        position: { x: node.position.x, y: node.position.y },
        size,
        data: Object.keys(node.data.overrides).length > 0 ? node.data.overrides : undefined,
      };
    }),
    edges: rfEdges
      .filter((edge) => edge.sourceHandle && edge.targetHandle)
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle!,
        target: edge.target,
        targetHandle: edge.targetHandle!,
      })),
    ...(router.length ? { router } : {}),
  };
}

interface TemplateDropMenuState {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  fromNodeId: string;
  fromHandleId: TemplateHandleKind;
  fromHandleType: "source" | "target";
}

/** Connection-drop menu — same look and behavior as the main canvas menu */
function TemplateConnectionMenu({
  menu,
  options,
  onSelect,
  onClose,
}: {
  menu: TemplateDropMenuState;
  options: TemplateCatalogEntry[];
  onSelect: (type: NodeType) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % options.length);
          break;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          break;
        case "Enter":
          event.preventDefault();
          if (options[selectedIndex]) onSelect(options[selectedIndex].type);
          break;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [options, selectedIndex, onSelect]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (options.length === 0) return null;

  return (
    <MenuSurface
      ref={menuRef}
      tabIndex={-1}
      // Inside the dialog's own stacking context, so any positive value sits
      // above the mini canvas
      className="z-[110]"
      style={{
        left: menu.screen.x,
        top: menu.screen.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <MenuHeader>
        <MenuSectionLabel>Add {menu.fromHandleId} node</MenuSectionLabel>
      </MenuHeader>
      <MenuList>
        {options.map((option, index) => (
          <MenuItem
            key={option.type}
            selected={index === selectedIndex}
            onClick={() => onSelect(option.type)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {getTemplateNodeIcon(option.type)}
            {option.label}
          </MenuItem>
        ))}
      </MenuList>
    </MenuSurface>
  );
}

interface SplitGridTemplateModalProps {
  nodeId: string;
  nodeData: SplitGridNodeData;
  onClose: () => void;
}

function SplitGridTemplateModalInner({ nodeId, nodeData, onClose }: SplitGridTemplateModalProps) {
  const materializeSplitGridCells = useWorkflowStore((state) => state.materializeSplitGridCells);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const canvasNavigationSettings = useWorkflowStore((state) => state.canvasNavigationSettings);

  // Match the main canvas's wheel navigation (scroll-to-pan when zoomMode is
  // altScroll/ctrlScroll) instead of React Flow's default scroll-to-zoom.
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  useWheelPanZoom(canvasWrapperRef, canvasNavigationSettings, true);

  const initialTemplate = useMemo(() => getSplitGridTemplate(nodeData), [nodeData]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<TemplateRFNode>(
    templateToRfNodes(initialTemplate, nodeData.sourceImage)
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>(
    templateToRfEdges(initialTemplate)
  );
  // Downstream-router wires live outside the flow (the rail is a fixed overlay)
  const [routerWires, setRouterWires] = useState<RouterWire[]>(() =>
    templateToRouterWires(initialTemplate)
  );
  const [wrapperSize, setWrapperSize] = useState<RailSize>({ width: 0, height: 0 });
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [dropMenu, setDropMenu] = useState<TemplateDropMenuState | null>(null);
  // Floating delete toolbar — same interaction as the main canvas: click a
  // noodle (or a router wire) and a toolbar appears just above the cursor.
  const [edgeToolbar, setEdgeToolbar] = useState<
    | { x: number; y: number; target: { kind: "edge"; id: string } }
    | { x: number; y: number; target: { kind: "wire"; source: string; sourceHandle: string } }
    | null
  >(null);
  // Drags that end over the backdrop synthesize a click on it — only treat a
  // click as backdrop-close when the pointer also went DOWN on the backdrop
  const backdropPointerDownRef = useRef(false);
  const idCounterRef = useRef(0);
  const baseNodeId = initialTemplate.baseNodeId;
  const { fitView, screenToFlowPosition } = useReactFlow();

  const refitSoon = useCallback(() => {
    requestAnimationFrame(() => {
      fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
    });
  }, [fitView]);

  // Freeze the main canvas while the editor is open

  // Track the canvas wrapper size so the fixed rail can be placed + hit-tested
  useEffect(() => {
    const el = canvasWrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWrapperSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Drop router wires whose terminal node was deleted from the set
  useEffect(() => {
    setRouterWires((prev) => {
      const ids = new Set(rfNodes.map((node) => node.id));
      const next = prev.filter((wire) => ids.has(wire.source));
      return next.length === prev.length ? prev : next;
    });
  }, [rfNodes]);

  const addRouterWire = useCallback((source: string, sourceHandle: string) => {
    setRouterWires((prev) =>
      prev.some((w) => w.source === source && w.sourceHandle === sourceHandle)
        ? prev
        : [...prev, { source, sourceHandle }]
    );
  }, []);

  const disconnectRouterType = useCallback((type: string) => {
    setRouterWires((prev) => prev.filter((w) => w.sourceHandle !== type));
  }, []);

  // Delete one specific router wire (its midpoint × button)
  const disconnectRouterWire = useCallback((source: string, sourceHandle: string) => {
    setRouterWires((prev) =>
      prev.filter((w) => !(w.source === source && w.sourceHandle === sourceHandle))
    );
  }, []);

  const deleteEdge = useCallback(
    (id: string) => {
      setRfEdges((edges) => edges.filter((edge) => edge.id !== id));
    },
    [setRfEdges]
  );

  const handleToolbarDelete = useCallback(() => {
    setEdgeToolbar((current) => {
      if (!current) return null;
      if (current.target.kind === "edge") deleteEdge(current.target.id);
      else disconnectRouterWire(current.target.source, current.target.sourceHandle);
      return null;
    });
  }, [deleteEdge, disconnectRouterWire]);

  // Click a noodle or a router wire → show the delete toolbar just above the
  // cursor; a click anywhere else dismisses it (but not clicks on the toolbar
  // itself). Mirrors the main-canvas EdgeToolbar, which also detects edge
  // clicks via a native mousedown listener.
  useEffect(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest("[data-edge-toolbar]")) return;
      const above = { x: event.clientX, y: event.clientY - 40 };
      const edgeEl = target.closest(".react-flow__edge");
      if (edgeEl) {
        const id =
          edgeEl.getAttribute("data-id") ??
          edgeEl.getAttribute("data-testid")?.replace(/^rf__edge-/, "") ??
          null;
        if (id) setEdgeToolbar({ ...above, target: { kind: "edge", id } });
        return;
      }
      const wireEl = target.closest("[data-wire-source]");
      if (wireEl) {
        const source = wireEl.getAttribute("data-wire-source");
        const sourceHandle = wireEl.getAttribute("data-wire-handle");
        if (source && sourceHandle) {
          setEdgeToolbar({ ...above, target: { kind: "wire", source, sourceHandle } });
        }
        return;
      }
      setEdgeToolbar(null);
    };
    wrapper.addEventListener("mousedown", handlePointerDown);
    return () => wrapper.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // Dismiss the toolbar if its target disappears (its node/edge/wire is removed)
  useEffect(() => {
    setEdgeToolbar((current) => {
      if (!current) return current;
      const target = current.target;
      if (target.kind === "edge") {
        return rfEdges.some((edge) => edge.id === target.id) ? current : null;
      }
      return routerWires.some(
        (w) => w.source === target.source && w.sourceHandle === target.sourceHandle
      )
        ? current
        : null;
    });
  }, [rfEdges, routerWires]);

  // Dirty check: compare against the initial template mapped through the same
  // serializer, so an untouched editor is never considered dirty
  const initialSerializedRef = useRef<string | null>(null);
  if (initialSerializedRef.current === null) {
    initialSerializedRef.current = JSON.stringify(
      serializeTemplate(
        baseNodeId,
        templateToRfNodes(initialTemplate, nodeData.sourceImage),
        templateToRfEdges(initialTemplate),
        templateToRouterWires(initialTemplate)
      )
    );
  }
  const isDirty = useCallback(
    () =>
      JSON.stringify(serializeTemplate(baseNodeId, rfNodes, rfEdges, routerWires)) !==
      initialSerializedRef.current,
    [baseNodeId, rfNodes, rfEdges, routerWires]
  );

  const requestClose = useCallback(() => {
    if (isDirty()) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  // Escape: drop menu first, then discard confirmation, then close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (edgeToolbar) {
        setEdgeToolbar(null);
      } else if (dropMenu) {
        setDropMenu(null);
      } else if (showDiscardConfirm) {
        setShowDiscardConfirm(false);
      } else {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [edgeToolbar, dropMenu, showDiscardConfirm, requestClose]);

  const setOverrides = useCallback(
    (id: string, overrides: Record<string, unknown>) => {
      setRfNodes((nodes) =>
        nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, overrides } } : node))
      );
    },
    [setRfNodes]
  );
  const editorContext = useMemo(() => ({ setOverrides }), [setOverrides]);

  const makeTemplateNodeId = useCallback(
    (type: NodeType, existing: TemplateRFNode[]): string => {
      const taken = new Set(existing.map((node) => node.id));
      let id: string;
      do {
        id = `tmpl-${type}-${++idCounterRef.current}`;
      } while (taken.has(id));
      return id;
    },
    []
  );

  const applyPreset = useCallback(
    (template: SplitGridTemplate) => {
      setRfNodes(templateToRfNodes(template, nodeData.sourceImage));
      setRfEdges(templateToRfEdges(template));
      setRouterWires([]); // presets carry no router wiring
      idCounterRef.current = 0;
      refitSoon();
    },
    [nodeData.sourceImage, setRfNodes, setRfEdges, refitSoon]
  );

  // Cycles would materialize as cells the scheduler silently never executes
  const createsCycle = useCallback(
    (source: string, target: string): boolean => {
      const stack = [target];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === source) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const edge of rfEdges) {
          if (edge.source === current) stack.push(edge.target);
        }
      }
      return false;
    },
    [rfEdges]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!source || !target || source === target) return false;
      const sourceNode = rfNodes.find((node) => node.id === source);
      const targetNode = rfNodes.find((node) => node.id === target);
      if (!sourceNode || !targetNode) return false;
      const sourceEntry = getTemplateEntry(sourceNode.data.nodeType);
      const targetEntry = getTemplateEntry(targetNode.data.nodeType);
      const output = sourceEntry.outputs.find((handle) => handle.id === sourceHandle);
      const input = targetEntry.inputs.find((handle) => handle.id === targetHandle);
      if (!output || !input || output.id !== input.id) return false;
      return !createsCycle(source, target);
    },
    [rfNodes, createsCycle]
  );

  const addConnectedEdge = useCallback(
    (connection: Connection) => {
      setRfEdges((edges) => {
        let next = edges;
        // Text inputs accept a single connection — replace the existing one
        if (connection.targetHandle === "text") {
          next = next.filter(
            (edge) =>
              !(edge.target === connection.target && edge.targetHandle === connection.targetHandle)
          );
        }
        return addEdge(
          { ...connection, type: TEMPLATE_EDGE_TYPE, style: edgeStyleFor(connection.sourceHandle) },
          next
        );
      });
    },
    [setRfEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;
      addConnectedEdge(connection);
    },
    [isValidConnection, addConnectedEdge]
  );

  // Dropping a connection over the fixed rail wires it to the router; dropping
  // in empty space opens the add-node menu (main-canvas style).
  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid) return;
      const fromHandle = connectionState.fromHandle;
      const fromNode = connectionState.fromNode;
      if (!fromHandle?.id || !fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;

      // Drop an output onto the router rail → wire it to the shared router
      const rect = canvasWrapperRef.current?.getBoundingClientRect();
      if (rect && fromHandle.type === "source") {
        const wrapperPoint = { x: point.clientX - rect.left, y: point.clientY - rect.top };
        if (isInRailDropZone(wrapperPoint, wrapperSize, routerWires)) {
          addRouterWire(fromNode.id, fromHandle.id);
          return;
        }
      }

      const targetElement = event.target as HTMLElement | null;
      if (!targetElement?.closest(".react-flow__pane")) return;
      setDropMenu({
        screen: { x: point.clientX, y: point.clientY },
        flow: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        fromNodeId: fromNode.id,
        fromHandleId: (fromHandle.id === "text" ? "text" : "image") as TemplateHandleKind,
        fromHandleType: fromHandle.type,
      });
    },
    [screenToFlowPosition, wrapperSize, routerWires, addRouterWire]
  );

  const dropMenuOptions = useMemo(() => {
    if (!dropMenu) return [];
    return TEMPLATE_NODE_CATALOG.filter((entry) =>
      dropMenu.fromHandleType === "source"
        ? entry.inputs.some((handle) => handle.id === dropMenu.fromHandleId)
        : entry.outputs.some((handle) => handle.id === dropMenu.fromHandleId)
    );
  }, [dropMenu]);

  const handleDropMenuSelect = useCallback(
    (type: NodeType) => {
      if (!dropMenu) return;
      const dims = editorNodeDimensions(type);
      const entry = getTemplateEntry(type);
      const kind = dropMenu.fromHandleId;
      const newId = makeTemplateNodeId(type, rfNodes);

      let position: { x: number; y: number };
      let connection: Connection;
      if (dropMenu.fromHandleType === "source") {
        // Forward drag: align the new node's input socket with the drop point
        const inputIndex = Math.max(0, entry.inputs.findIndex((handle) => handle.id === kind));
        position = { x: dropMenu.flow.x, y: dropMenu.flow.y - templateHandleTop(inputIndex) };
        connection = { source: dropMenu.fromNodeId, sourceHandle: kind, target: newId, targetHandle: kind };
      } else {
        // Backward drag: align the new node's output socket with the drop point
        const outputIndex = Math.max(0, entry.outputs.findIndex((handle) => handle.id === kind));
        position = { x: dropMenu.flow.x - dims.width, y: dropMenu.flow.y - templateHandleTop(outputIndex) };
        connection = { source: newId, sourceHandle: kind, target: dropMenu.fromNodeId, targetHandle: kind };
      }

      setRfNodes((nodes) => [
        ...nodes,
        {
          id: newId,
          type: "splitGridTemplateNode" as const,
          position,
          deletable: true,
          width: dims.width,
          style: { width: dims.width },
          data: {
            nodeType: type,
            overrides: seedOverridesFor(type),
            isBase: false,
          } satisfies TemplateNodeData,
        },
      ]);
      addConnectedEdge(connection);
      setDropMenu(null);
    },
    [dropMenu, makeTemplateNodeId, rfNodes, setRfNodes, addConnectedEdge]
  );

  const cellCount =
    clampGridDimension(nodeData.gridRows) * clampGridDimension(nodeData.gridCols);
  const perCellNodeCount = rfNodes.length;

  // Advisory warnings for templates that would materialize un-runnable cells
  const warnings = useMemo(() => {
    const list: string[] = [];
    const generateMissingPrompt = rfNodes.some(
      (node) =>
        node.data.nodeType === "nanoBanana" &&
        !rfEdges.some((edge) => edge.target === node.id && edge.targetHandle === "text")
    );
    if (generateMissingPrompt) {
      list.push("Generate Image nodes need a Prompt connected to their text input");
    }
    // Image-processing/output nodes are dead (or fail validation) without an image
    const IMAGE_OPTIONAL = new Set(["nanoBanana", "llmGenerate"]);
    const unwired = rfNodes.filter((node) => {
      if (node.data.isBase || IMAGE_OPTIONAL.has(node.data.nodeType)) return false;
      const entry = getTemplateEntry(node.data.nodeType);
      if (!entry.inputs.some((handle) => handle.id === "image")) return false;
      return !rfEdges.some((edge) => edge.target === node.id && edge.targetHandle === "image");
    });
    if (unwired.length > 0) {
      const labels = [...new Set(unwired.map((node) => getTemplateEntry(node.data.nodeType).label))];
      list.push(`${labels.join(", ")} node${unwired.length === 1 ? " is" : "s are"} missing an image input`);
    }
    // Text terminals collapse to a single cell through the shared router (only
    // image outputs aggregate), so flag it rather than silently dropping cells.
    if (routerWires.some((wire) => wire.sourceHandle !== "image")) {
      list.push("Only image terminals aggregate through the Router — text collapses to one cell");
    }
    return list;
  }, [rfNodes, rfEdges, routerWires]);

  const handleApply = useCallback(() => {
    if (isRunning) return;
    // Single store call: saving the template and rebuilding the cells share
    // one undo checkpoint, so one Cmd+Z reverts the whole apply
    materializeSplitGridCells(nodeId, {
      force: true,
      template: serializeTemplate(baseNodeId, rfNodes, rfEdges, routerWires),
    });
    onClose();
  }, [isRunning, baseNodeId, rfNodes, rfEdges, routerWires, nodeId, materializeSplitGridCells, onClose]);

  return (
    <Dialog
      open
      onClose={requestClose}
      // Escape and the backdrop have their own rules here: Escape closes a
      // menu or toolbar first, and a drag that ends on the backdrop is not a
      // click. Both stay with this component.
      closeOnEscape={false}
      closeOnBackdrop={false}
      stopWheel={false}
      portal
      className="w-[min(1080px,94vw)] h-[min(720px,88vh)] max-h-none"
      overlayProps={{
        // Bubble-phase (not capture): the mini-canvas's native wheel-to-pan
        // listener on the wrapper must run first; we still stop the wheel from
        // leaking to the frozen main canvas behind the modal.
        onWheel: (event) => event.stopPropagation(),
        onPointerDown: (event) => {
          backdropPointerDownRef.current = event.target === event.currentTarget;
        },
        onClick: (event) => {
          if (event.target === event.currentTarget && backdropPointerDownRef.current) {
            requestClose();
          }
          backdropPointerDownRef.current = false;
        },
      }}
    >
        {/* Header */}
        <DialogHeader
          divider
          closeButton={false}
          className="pb-2.5"
          actions={
            <>
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mr-1">
              Presets
            </span>
            <button
              onClick={() => applyPreset(createDefaultSplitGridTemplate())}
              className="h-7 px-2.5 text-xs text-neutral-400 hover:text-neutral-100 bg-well border border-chrome-border hover:border-neutral-500 rounded-md transition-colors"
            >
              Image only
            </button>
            <button
              onClick={() =>
                applyPreset(
                  createClassicSplitGridTemplate(nodeData.defaultPrompt, nodeData.generateSettings)
                )
              }
              className="h-7 px-2.5 text-xs text-neutral-400 hover:text-neutral-100 bg-well border border-chrome-border hover:border-neutral-500 rounded-md transition-colors"
            >
              Prompt + Generate
            </button>
            <div className="w-px h-4 bg-neutral-600 mx-1" />
            <DialogCloseButton />
            </>
          }
        >
          <DialogTitle>Cell Node Set</DialogTitle>
          <DialogDescription className="truncate">
            These nodes are created for every split image and grouped per cell
          </DialogDescription>
        </DialogHeader>

        {/* Mini canvas */}
        <div ref={canvasWrapperRef} className="flex-1 min-h-0 relative bg-well">
          {/* Router wires render BEHIND the canvas so nodes occlude them, like
              normal edges (the pane is transparent, so they show in the gaps) */}
          <RouterWires wires={routerWires} nodes={rfNodes} size={wrapperSize} />

          <div className="absolute inset-0">
          <TemplateEditorContext.Provider value={editorContext}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onConnectEnd={handleConnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.5}
              zoomOnScroll={false}
              panOnDrag={!isMacOS}
              // The router is a fixed, always-visible overlay on the right, so
              // panning toward it mid-connection only jostles the graph.
              autoPanOnConnect={false}
              deleteKeyCode={["Backspace", "Delete"]}
              defaultEdgeOptions={{ type: TEMPLATE_EDGE_TYPE, animated: false }}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#404040" />
              <Controls showInteractive={false} className="!bg-neutral-800 !border-neutral-700 !shadow-none [&>button]:!bg-neutral-800 [&>button]:!border-neutral-700 [&>button]:!text-neutral-300 [&>button:hover]:!bg-neutral-700" />
            </ReactFlow>
          </TemplateEditorContext.Provider>
          </div>

          {/* Fixed downstream-router rail + invisible wire click targets (on top) */}
          <RouterRail
            wires={routerWires}
            nodes={rfNodes}
            size={wrapperSize}
            onDisconnectType={disconnectRouterType}
          />

          {/* Connection drop menu */}
          {dropMenu && (
            <TemplateConnectionMenu
              menu={dropMenu}
              options={dropMenuOptions}
              onSelect={handleDropMenuSelect}
              onClose={() => setDropMenu(null)}
            />
          )}

          {/* Floating delete toolbar — same look/behavior as the main canvas
              EdgeToolbar, minus pause (cells run in one shot) */}
          {edgeToolbar && (
            <MenuSurface
              variant="bar"
              data-edge-toolbar
              className="z-[110]"
              style={{ left: edgeToolbar.x, top: edgeToolbar.y, transform: "translateX(-50%)" }}
            >
              <MenuIconButton
                onClick={handleToolbarDelete}
                className="hover:text-red-400"
                title="Delete"
                aria-label="Delete connection"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                  />
                </svg>
              </MenuIconButton>
            </MenuSurface>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="justify-between gap-4">
          <div className="text-xs text-neutral-500 min-w-0">
            <span>
              {perCellNodeCount} node{perCellNodeCount === 1 ? "" : "s"} per cell · {nodeData.gridRows}×{nodeData.gridCols} grid → {cellCount} group{cellCount === 1 ? "" : "s"}
            </span>
            {warnings.map((warning) => (
              <span key={warning} className="ml-3 text-amber-400">
                {warning}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <DialogButton variant="ghost" onClick={requestClose}>
              Cancel
            </DialogButton>
            <DialogButton
              variant="primary"
              onClick={handleApply}
              disabled={isRunning}
              title={isRunning ? "Wait for the current run to finish" : undefined}
            >
              Apply to {cellCount} cell{cellCount === 1 ? "" : "s"}
            </DialogButton>
          </div>
        </DialogFooter>

        {/* Discard-changes confirmation */}
        {showDiscardConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-scrim">
            <div className="bg-card border border-chrome-border rounded-card p-5 mx-4 max-w-sm shadow-dialog">
              <h3 className="text-base font-semibold text-neutral-100">Discard changes?</h3>
              <p className="text-[13px] text-neutral-400 mt-1">
                Your edits to the cell node set haven&apos;t been applied.
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <DialogButton variant="secondary" onClick={() => setShowDiscardConfirm(false)}>
                  Keep editing
                </DialogButton>
                <DialogButton variant="danger" onClick={onClose}>
                  Discard
                </DialogButton>
              </div>
            </div>
          </div>
        )}
    </Dialog>
  );
}

export function SplitGridTemplateModal(props: SplitGridTemplateModalProps) {
  // Own provider: isolates the mini canvas from the app-level React Flow store
  return (
    <ReactFlowProvider>
      <SplitGridTemplateModalInner {...props} />
    </ReactFlowProvider>
  );
}
