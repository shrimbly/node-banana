"use client";

import { Dialog, DialogBody, DialogHeader, DialogSectionHeader, DialogTitle } from "@/components/ui/Dialog";
import { KbdGroup } from "@/components/ui/Kbd";
import { useAssetStore } from "@/store/assetStore";

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutItem[];
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const modKey = isMac ? "⌘" : "Ctrl";

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "General",
    shortcuts: [
      { keys: [`${modKey}`, "Enter"], description: "Run workflow" },
      { keys: ["⌥", "Enter"], description: "Run selected nodes" },
      { keys: [`${modKey}`, "S"], description: "Save workflow" },
      { keys: [`${modKey}`, "C"], description: "Copy selected nodes" },
      { keys: [`${modKey}`, "V"], description: "Paste nodes / image / text" },
      { keys: [`${modKey}`, "Z"], description: "Undo" },
      { keys: [`${modKey}`, "Shift", "Z"], description: "Redo" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Add Nodes",
    shortcuts: [
      { keys: ["Shift", "P"], description: "Add Prompt node" },
      { keys: ["Shift", "I"], description: "Add Image Input node" },
      { keys: ["Shift", "G"], description: "Add Generate Image node" },
      { keys: ["Shift", "V"], description: "Add Generate Video node" },
      { keys: ["Shift", "D"], description: "Add Generate 3D node" },
      { keys: ["Shift", "L"], description: "Add LLM Text node" },
      { keys: ["Shift", "A"], description: "Add Annotation node" },
      { keys: ["Shift", "T"], description: "Add Audio node" },
      { keys: ["Shift", "Y"], description: "Add Video Input node" },
      { keys: ["Shift", "R"], description: "Add Array node" },
      { keys: ["Shift", "C"], description: "Add ComfyUI App node" },
      { keys: ["Shift", "O"], description: "Add Output node" },
    ],
  },
  {
    title: "Layout (select 2+ nodes first)",
    shortcuts: [
      { keys: ["V"], description: "Stack selected vertically" },
      { keys: ["G"], description: "Arrange selected as grid" },
    ],
  },
  {
    title: "Canvas",
    shortcuts: [
      { keys: ["Hold H", "Drag"], description: "Hook connections into one bundle" },
      { keys: ["Scroll"], description: "Zoom in / out" },
      { keys: ["Trackpad"], description: "Pan (macOS)" },
      { keys: ["Delete"], description: "Delete selected nodes" },
    ],
  },
];

/** Switching views: bare letters, outside the Shift+letter namespace that adds nodes. */
const viewGroup: ShortcutGroup = {
  title: "Views",
  shortcuts: [
    { keys: ["C"], description: "Show or hide the chat" },
    { keys: ["A"], description: "Show or hide Assets" },
  ],
};

const assetsGroup: ShortcutGroup = {
  title: "Assets",
  shortcuts: [
    { keys: ["←", "→", "↑", "↓"], description: "Move between assets" },
    { keys: ["Enter"], description: "Open the asset" },
    { keys: ["←", "→"], description: "Previous / next asset (open)" },
    { keys: ["Space"], description: "Select the asset" },
    { keys: [`${modKey}`, "A"], description: "Select all loaded assets" },
    { keys: ["Delete"], description: "Trash the selected assets" },
    { keys: [`${modKey}`, "Z"], description: "Undo the last asset action" },
    { keys: [`${modKey}`, "C"], description: "Copy the prompt (open)" },
    { keys: ["F"], description: "Full screen (open)" },
    { keys: ["Esc"], description: "Close, clear selection, back to canvas" },
  ],
};

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  // Opened over another view, the view switches come first, then the Assets
  // view's own keys when it is that one
  const appView = useAssetStore((state) => state.appView);
  const groups =
    appView === "assets"
      ? [viewGroup, assetsGroup, ...shortcutGroups]
      : appView === "chat"
        ? [viewGroup, ...shortcutGroups, assetsGroup]
        : [...shortcutGroups, viewGroup, assetsGroup];
  return (
    <Dialog open={isOpen} onClose={onClose} className="w-[520px] max-h-[80vh]">
      <DialogHeader>
        <DialogTitle>Keyboard Shortcuts</DialogTitle>
      </DialogHeader>

      <DialogBody className="pb-4 space-y-4">
          {groups.map((group) => (
            <div key={group.title}>
              <DialogSectionHeader className="mb-2">{group.title}</DialogSectionHeader>
              <div className="space-y-0.5">
                {group.shortcuts.map((shortcut, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between h-8 px-2 rounded hover:bg-neutral-700/40 transition-colors"
                  >
                    <span className="text-[13px] text-neutral-300">
                      {shortcut.description}
                    </span>
                    <KbdGroup keys={shortcut.keys} size="md" className="ml-4 shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          ))}
      </DialogBody>
    </Dialog>
  );
}
