"use client";

import { Dialog, DialogBody, DialogHeader, DialogSectionHeader, DialogTitle } from "@/components/ui/Dialog";
import { KbdGroup } from "@/components/ui/Kbd";
import { useAssetStore } from "@/store/assetStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";

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
    { keys: ["E"], description: "Show or hide Edit video" },
  ],
};

/** The editor's keys and mouse modifiers, the same in the Edit video view and the Edit Video node's dialog. */
const editorShortcuts: ShortcutItem[] = [
  { keys: ["Space"], description: "Play or pause" },
  { keys: ["J", "K", "L"], description: "Back 1 s / pause / play" },
  { keys: ["I", "O"], description: "Set In / Out at the playhead" },
  { keys: ["S"], description: "Split at the playhead" },
  { keys: ["Delete"], description: "Remove the selected clips" },
  { keys: ["M"], description: "Mute the selected audio clips" },
  { keys: ["⌥", "M"], description: "Mute the selected clips' own audio" },
  { keys: [`${modKey}`, "C"], description: "Copy the selected clips" },
  { keys: [`${modKey}`, "X"], description: "Cut the selected clips" },
  { keys: [`${modKey}`, "V"], description: "Paste clips" },
  { keys: [`${modKey}`, "D"], description: "Duplicate the selected clips" },
  { keys: [`${modKey}`, "A"], description: "Select every clip" },
  { keys: ["⌥", "←", "→"], description: "Nudge the selected clips a frame" },
  { keys: ["⌥", "↑", "↓"], description: "Move the selected clips a row" },
  { keys: ["[", "]"], description: "Start / end the selected clip at the playhead" },
  { keys: ["−", "="], description: "Zoom the timeline out / in" },
  { keys: ["Shift", "Z"], description: "Fit the timeline" },
  { keys: [`${modKey}`, "Z"], description: "Undo" },
  { keys: [`${modKey}`, "Shift", "Z"], description: "Redo" },
  { keys: ["Esc"], description: "Close a menu, cancel a drag" },
  { keys: ["Shift", "Click"], description: "Select a range of clips" },
  { keys: [`${modKey}`, "Click"], description: "Add or remove a clip" },
  { keys: ["Shift", "Drag"], description: "Move or trim without snapping" },
  { keys: ["⌥", "Drag"], description: "Move a whole volume line" },
];

/** The open edit's own keys: the editor's, but ⌘S saves the edit. */
const editVideoGroup: ShortcutGroup = {
  title: "Edit video",
  shortcuts: [{ keys: [`${modKey}`, "S"], description: "Save the edit" }, ...editorShortcuts],
};

/** The Edit Video node's dialog: the editor's keys, ⌘S writing the edit to the node and saving the workflow. */
const editVideoDialogGroup: ShortcutGroup = {
  title: "Edit video",
  shortcuts: [{ keys: [`${modKey}`, "S"], description: "Save, keeping the editor open" }, ...editorShortcuts],
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
  /** In a body portal: the Edit Video node's dialog opens its own copy, which must sit above it. */
  portal?: boolean;
}

/** The canvas's keys under another view's: General is retitled, so ⌘S, ⌘C and ⌘V read as the canvas's there. */
const canvasGroups: ShortcutGroup[] = shortcutGroups.map((group) =>
  group.title === "General" ? { ...group, title: "On the canvas" } : group,
);

export function KeyboardShortcutsDialog({ isOpen, onClose, portal }: KeyboardShortcutsDialogProps) {
  // Opened over another view, the view switches come first, then that view's
  // own keys (Assets', or the open edit's: none on the Edit video home screen)
  const appView = useAssetStore((state) => state.appView);
  const editOpen = useStitchEditorStore((s) => s.isOpen && s.editId !== null);
  // Over the node's dialog (its ? opens its own copy): the editor's keys first, then the canvas's behind it
  const dialogOpen = useStitchEditorStore((s) => s.isOpen && s.nodeId !== null);
  const groups = dialogOpen
    ? [editVideoDialogGroup, ...canvasGroups, viewGroup, assetsGroup]
    : appView === "assets"
      ? [viewGroup, assetsGroup, ...shortcutGroups]
      : appView === "edit"
        ? [viewGroup, ...(editOpen ? [editVideoGroup] : []), ...canvasGroups, assetsGroup]
        : appView === "chat"
          ? [viewGroup, ...shortcutGroups, assetsGroup]
          : [...shortcutGroups, viewGroup, assetsGroup];
  return (
    <Dialog open={isOpen} onClose={onClose} portal={portal} className="w-[520px] max-h-[80vh]">
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
