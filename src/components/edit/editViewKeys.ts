import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { KeyLike } from "@/components/stitch/editorKeys";

/**
 * The Edit video view's own keys, as pure functions of a keydown: bare E goes
 * back to the canvas (as A does in Assets and C in Chat), A to Assets, C to
 * the chat, ? shows the shortcuts. No ⌘, Ctrl or ⌥; ⇧ only for the ?.
 */

export type EditViewKeyAction = "canvas" | "assets" | "chat" | "shortcuts";

export function editViewKeyAction(e: Pick<KeyLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): EditViewKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "?") return "shortcuts";
  if (e.shiftKey) return null;
  switch (e.key.toLowerCase()) {
    case "e":
      return "canvas";
    case "a":
      return "assets";
    case "c":
      return "chat";
    default:
      return null;
  }
}

/** Runs a view key; a held key switches nothing (it would flip back and forth). */
export function runEditViewKey(action: EditViewKeyAction, repeat: boolean): void {
  if (action === "shortcuts") {
    useWorkflowStore.getState().setShortcutsDialogOpen(true);
    return;
  }
  if (!repeat) useAssetStore.getState().setAppView(action);
}
