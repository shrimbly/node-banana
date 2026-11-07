"use client";

import { MenuFooter, MenuHeader, MenuHint, MenuItem, MenuList, MenuSectionLabel, MenuSurface } from "@/components/ui/Menu";
import { useEffect, useRef, useState, useCallback } from "react";
import { NodeType } from "@/types";
import { useSavedComfyNodes } from "@/hooks/useSavedComfyNodes";
import type { SavedComfyNode } from "@/lib/comfy/library";
import { ComfyMark } from "./icons/ComfyMark";
import { NodeTypeIcon } from "./icons/nodeTypeIcons";

// Actions are special menu items that trigger behavior instead of creating a node
export type MenuAction = "splitGridImmediate";

export interface MenuOption {
  type: NodeType | MenuAction;
  label: string;
  icon: React.ReactNode;
  isAction?: boolean; // true if this is an action, not a node type
  /**
   * Set on a saved Comfy node. The type is still `comfyApp` — a saved node is
   * that node arriving with its workflow already attached, not a new kind of
   * node — so this is what tells the canvas which one to attach.
   */
  savedNodeId?: string;
}

/** Menu entries repeat node types once saved nodes are in the list. */
export const optionKey = (option: MenuOption): string => option.savedNodeId ?? option.type;

// Define which nodes can accept which handle types as inputs
const IMAGE_TARGET_OPTIONS: MenuOption[] = [
  {
    type: "annotation",
    label: "Annotate",
    icon: <NodeTypeIcon type="annotation" />,
  },
  {
    type: "nanoBanana",
    label: "Generate Image",
    icon: <NodeTypeIcon type="nanoBanana" />,
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    icon: <NodeTypeIcon type="generateVideo" />,
  },
  {
    type: "splitGrid",
    label: "Split Grid Node",
    icon: <NodeTypeIcon type="splitGrid" />,
  },
  {
    type: "splitGridImmediate",
    label: "Split Grid Now",
    isAction: true,
    icon: <NodeTypeIcon type="splitGrid" />,
  },
  {
    type: "output",
    label: "Output",
    icon: <NodeTypeIcon type="output" />,
  },
  {
    type: "outputGallery",
    label: "Output Gallery",
    icon: <NodeTypeIcon type="outputGallery" />,
  },
  {
    type: "removeBackground",
    label: "Remove Background",
    icon: <NodeTypeIcon type="removeBackground" />,
  },
  {
    type: "imageCompare",
    label: "Image Compare",
    icon: <NodeTypeIcon type="imageCompare" />,
  },
  {
    type: "imageResize",
    label: "Resize Image",
    icon: <NodeTypeIcon type="imageResize" />,
  },
  {
    type: "gifEncoder",
    label: "GIF Encoder",
    icon: <NodeTypeIcon type="gifEncoder" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

const TEXT_TARGET_OPTIONS: MenuOption[] = [
  {
    type: "prompt",
    label: "Prompt",
    icon: <NodeTypeIcon type="prompt" />,
  },
  {
    type: "promptConstructor",
    label: "Prompt Constructor",
    icon: <NodeTypeIcon type="promptConstructor" />,
  },
  {
    type: "array",
    label: "Array",
    icon: <NodeTypeIcon type="array" />,
  },
  {
    type: "nanoBanana",
    label: "Generate Image",
    icon: <NodeTypeIcon type="nanoBanana" />,
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    icon: <NodeTypeIcon type="generateVideo" />,
  },
  {
    type: "generateAudio",
    label: "Generate Audio",
    icon: <NodeTypeIcon type="generateAudio" />,
  },
  {
    type: "llmGenerate",
    label: "LLM Generate",
    icon: <NodeTypeIcon type="llmGenerate" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "conditionalSwitch",
    label: "Conditional Switch",
    icon: <NodeTypeIcon type="conditionalSwitch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// Define which nodes can provide sources for handle types (when dragging to a target handle)
const IMAGE_SOURCE_OPTIONS: MenuOption[] = [
  {
    type: "imageInput",
    label: "Image Input",
    icon: <NodeTypeIcon type="imageInput" />,
  },
  {
    type: "glbViewer",
    label: "3D Viewer",
    icon: <NodeTypeIcon type="glbViewer" />,
  },
  {
    type: "videoFrameGrab",
    label: "Frame Grab",
    icon: <NodeTypeIcon type="videoFrameGrab" />,
  },
  {
    type: "annotation",
    label: "Annotate",
    icon: <NodeTypeIcon type="annotation" />,
  },
  {
    type: "removeBackground",
    label: "Remove Background",
    icon: <NodeTypeIcon type="removeBackground" />,
  },
  {
    type: "nanoBanana",
    label: "Generate Image",
    icon: <NodeTypeIcon type="nanoBanana" />,
  },
  {
    type: "imageResize",
    label: "Resize Image",
    icon: <NodeTypeIcon type="imageResize" />,
  },
  {
    type: "gifEncoder",
    label: "GIF Encoder",
    icon: <NodeTypeIcon type="gifEncoder" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

const TEXT_SOURCE_OPTIONS: MenuOption[] = [
  {
    type: "prompt",
    label: "Prompt",
    icon: <NodeTypeIcon type="prompt" />,
  },
  {
    type: "promptConstructor",
    label: "Prompt Constructor",
    icon: <NodeTypeIcon type="promptConstructor" />,
  },
  {
    type: "array",
    label: "Array",
    icon: <NodeTypeIcon type="array" />,
  },
  {
    type: "llmGenerate",
    label: "LLM Generate",
    icon: <NodeTypeIcon type="llmGenerate" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "conditionalSwitch",
    label: "Conditional Switch",
    icon: <NodeTypeIcon type="conditionalSwitch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// Video can connect to videoStitch, videoInput, generateVideo (video-to-video), or output nodes
const VIDEO_TARGET_OPTIONS: MenuOption[] = [
  {
    type: "videoInput",
    label: "Video Input",
    icon: <NodeTypeIcon type="videoInput" />,
  },
  {
    type: "videoStitch",
    label: "Edit Video",
    icon: <NodeTypeIcon type="videoStitch" />,
  },
  {
    type: "easeCurve",
    label: "Ease Curve",
    icon: <NodeTypeIcon type="easeCurve" />,
  },
  {
    type: "videoTrim",
    label: "Video Trim",
    icon: <NodeTypeIcon type="videoTrim" />,
  },
  {
    type: "videoFrameGrab",
    label: "Frame Grab",
    icon: <NodeTypeIcon type="videoFrameGrab" />,
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    icon: <NodeTypeIcon type="generateVideo" />,
  },
  {
    type: "output",
    label: "Output",
    icon: <NodeTypeIcon type="output" />,
  },
  {
    type: "outputGallery",
    label: "Output Gallery",
    icon: <NodeTypeIcon type="outputGallery" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// GenerateVideo, VideoStitch, and VideoInput nodes produce video output
const VIDEO_SOURCE_OPTIONS: MenuOption[] = [
  {
    type: "videoInput",
    label: "Video Input",
    icon: <NodeTypeIcon type="videoInput" />,
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    icon: <NodeTypeIcon type="generateVideo" />,
  },
  {
    type: "videoStitch",
    label: "Edit Video",
    icon: <NodeTypeIcon type="videoStitch" />,
  },
  {
    type: "easeCurve",
    label: "Ease Curve",
    icon: <NodeTypeIcon type="easeCurve" />,
  },
  {
    type: "videoTrim",
    label: "Video Trim",
    icon: <NodeTypeIcon type="videoTrim" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// Audio target options (nodes that accept audio input)
const AUDIO_TARGET_OPTIONS: MenuOption[] = [
  {
    type: "audioInput",
    label: "Audio",
    icon: <NodeTypeIcon type="audioInput" />,
  },
  {
    type: "generateVideo",
    label: "Generate Video",
    icon: <NodeTypeIcon type="generateVideo" />,
  },
  {
    type: "output",
    label: "Output",
    icon: <NodeTypeIcon type="output" />,
  },
  {
    type: "videoStitch",
    label: "Edit Video",
    icon: <NodeTypeIcon type="videoStitch" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// Audio source options (nodes that produce audio output)
const AUDIO_SOURCE_OPTIONS: MenuOption[] = [
  {
    type: "audioInput",
    label: "Audio",
    icon: <NodeTypeIcon type="audioInput" />,
  },
  {
    type: "generateAudio",
    label: "Generate Audio",
    icon: <NodeTypeIcon type="generateAudio" />,
  },
  {
    type: "router",
    label: "Router",
    icon: <NodeTypeIcon type="router" />,
  },
  {
    type: "switch",
    label: "Switch",
    icon: <NodeTypeIcon type="switch" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// 3D target options (nodes that accept 3D input)
const THREE_D_TARGET_OPTIONS: MenuOption[] = [
  {
    type: "glbViewer",
    label: "3D Viewer",
    icon: <NodeTypeIcon type="glbViewer" />,
  },
];

// 3D source options (nodes that produce 3D output)
const THREE_D_SOURCE_OPTIONS: MenuOption[] = [
  {
    type: "generate3d",
    label: "Generate 3D",
    icon: <NodeTypeIcon type="generate3d" />,
  },
  {
    type: "comfyApp",
    label: "ComfyUI App",
    icon: (
      <ComfyMark className="w-3.5 h-4" />
    ),
  },
];

// Every addable node type, de-duplicated across all handle-type lists, for the
// canvas double-click "add node" search menu (NodeSearchMenu). Reuses the icons
// and labels defined above. Actions (e.g. splitGridImmediate) are excluded since
// they are connection-specific behaviors, not standalone nodes.
export const ALL_NODE_OPTIONS: MenuOption[] = (() => {
  const lists = [
    IMAGE_SOURCE_OPTIONS, IMAGE_TARGET_OPTIONS,
    TEXT_SOURCE_OPTIONS, TEXT_TARGET_OPTIONS,
    VIDEO_SOURCE_OPTIONS, VIDEO_TARGET_OPTIONS,
    AUDIO_SOURCE_OPTIONS, AUDIO_TARGET_OPTIONS,
    THREE_D_SOURCE_OPTIONS, THREE_D_TARGET_OPTIONS,
  ];
  const seen = new Set<string>();
  const all: MenuOption[] = [];
  for (const list of lists) {
    for (const option of list) {
      if (option.isAction || seen.has(option.type)) continue;
      seen.add(option.type);
      all.push(option);
    }
  }
  return all.sort((a, b) => a.label.localeCompare(b.label));
})();

/** Saved Comfy nodes as menu entries, in the order the library lists them. */
export function savedComfyOptions(saved: SavedComfyNode[]): MenuOption[] {
  return saved.map((entry) => ({
    type: "comfyApp" as NodeType,
    label: entry.name,
    icon: <ComfyMark className="w-3.5 h-4" />,
    savedNodeId: entry.id,
  }));
}

/**
 * The saved nodes that can join a wire of this type.
 *
 * Dragging from an output looks for a node that can take it, so the match is
 * against the saved node's inputs; dragging from an input is the other way
 * round. This is what makes a saved node behave like a built-in one — it turns
 * up when it is useful, rather than only when asked for by name.
 */
export function savedComfyOptionsFor(
  saved: SavedComfyNode[],
  handleType: string,
  connectionType: "source" | "target"
): MenuOption[] {
  return savedComfyOptions(
    saved.filter((entry) =>
      connectionType === "source"
        ? entry.app.inputs.some((input) => input.type === handleType)
        : entry.app.outputs.some((output) => output.type === handleType)
    )
  );
}

interface ConnectionDropMenuProps {
  position: { x: number; y: number };
  handleType: "image" | "text" | "video" | "audio" | "3d" | "easeCurve" | null;
  connectionType: "source" | "target"; // source = dragging from output, target = dragging from input
  onSelect: (selection: {
    type: NodeType | MenuAction;
    isAction: boolean;
    savedNodeId?: string;
  }) => void;
  onClose: () => void;
}

export function ConnectionDropMenu({
  position,
  handleType,
  connectionType,
  onSelect,
  onClose,
}: ConnectionDropMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const savedNodes = useSavedComfyNodes();

  // Get the appropriate node options based on handle type and connection direction
  const getOptions = useCallback((): MenuOption[] => {
    if (!handleType) return [];
    // Appended rather than interleaved: the built-ins are a fixed list people
    // learn the shape of, and a saved node dropping into the middle of it would
    // move everything below it each time one is saved.
    const saved = savedComfyOptionsFor(savedNodes, handleType, connectionType);
    const withSaved = (options: MenuOption[]): MenuOption[] => [...options, ...saved];

    if (connectionType === "source") {
      // Dragging from a source handle (output), need nodes with target handles (inputs)
      if (handleType === "video") return withSaved(VIDEO_TARGET_OPTIONS);
      if (handleType === "audio") return withSaved(AUDIO_TARGET_OPTIONS);
      if (handleType === "3d") return withSaved(THREE_D_TARGET_OPTIONS);
      return withSaved(handleType === "image" ? IMAGE_TARGET_OPTIONS : TEXT_TARGET_OPTIONS);
    } else {
      // Dragging from a target handle (input), need nodes with source handles (outputs)
      if (handleType === "video") return withSaved(VIDEO_SOURCE_OPTIONS);
      if (handleType === "audio") return withSaved(AUDIO_SOURCE_OPTIONS);
      if (handleType === "3d") return withSaved(THREE_D_SOURCE_OPTIONS);
      return withSaved(handleType === "image" ? IMAGE_SOURCE_OPTIONS : TEXT_SOURCE_OPTIONS);
    }
  }, [handleType, connectionType, savedNodes]);

  const options = getOptions();

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % options.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          break;
        case "Enter":
          e.preventDefault();
          if (options[selectedIndex]) {
            const option = options[selectedIndex];
            onSelect({
              type: option.type,
              isAction: option.isAction || false,
              ...(option.savedNodeId ? { savedNodeId: option.savedNodeId } : {}),
            });
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [options, selectedIndex, onSelect, onClose]);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Focus the menu when it opens
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  if (options.length === 0) return null;

  return (
    <MenuSurface
      ref={menuRef}
      tabIndex={-1}
      data-tutorial="connection-drop-menu"
      style={{
        left: position.x,
        top: position.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <MenuHeader>
        <MenuSectionLabel>Add {handleType} node</MenuSectionLabel>
      </MenuHeader>
      <MenuList>
        {options.map((option, index) => (
          <MenuItem
            key={optionKey(option)}
            selected={index === selectedIndex}
            onClick={() =>
              onSelect({
                type: option.type,
                isAction: option.isAction || false,
                ...(option.savedNodeId ? { savedNodeId: option.savedNodeId } : {}),
              })
            }
            onMouseEnter={() => setSelectedIndex(index)}
            data-tutorial={option.type === "nanoBanana" ? "generate-image-option" : undefined}
          >
            {option.icon}
            {option.label}
          </MenuItem>
        ))}
      </MenuList>
      <MenuFooter>
        <MenuHint keys="↑↓">navigate</MenuHint>
        <MenuHint keys="↵">select</MenuHint>
      </MenuFooter>
    </MenuSurface>
  );
}
