"use client";

import { Dialog, DialogBody, DialogHeader, DialogSectionHeader, DialogTitle } from "@/components/ui/Dialog";

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
      { keys: ["Shift", "L"], description: "Add LLM Text node" },
      { keys: ["Shift", "A"], description: "Add Annotation node" },
      { keys: ["Shift", "T"], description: "Add Audio node" },
      { keys: ["Shift", "Y"], description: "Add Video Input node" },
      { keys: ["Shift", "R"], description: "Add Array node" },
      { keys: ["Shift", "C"], description: "Add ComfyUI App node" },
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

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[11px] font-medium text-neutral-200 bg-neutral-700 border border-neutral-600 rounded shadow-sm">
      {children}
    </kbd>
  );
}

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={isOpen} onClose={onClose} className="w-[520px] max-h-[80vh]">
      <DialogHeader>
        <DialogTitle>Keyboard Shortcuts</DialogTitle>
      </DialogHeader>

      <DialogBody className="pb-4 space-y-4">
          {shortcutGroups.map((group) => (
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
                    <div className="flex items-center gap-1 ml-4 shrink-0">
                      {shortcut.keys.map((key, keyIdx) => (
                        <span key={keyIdx} className="flex items-center gap-1">
                          {keyIdx > 0 && (
                            <span className="text-[10px] text-neutral-500">+</span>
                          )}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
      </DialogBody>
    </Dialog>
  );
}
