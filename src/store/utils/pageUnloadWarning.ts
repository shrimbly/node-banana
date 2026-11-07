import { unloadWarning } from "@/components/assets/unloadWarning";
import { pendingRecordings } from "@/lib/assets/client/recorder";
import { EDIT_UNSAVED_WARNING, editHasUnsavedWork } from "@/store/editProjectStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { anyWorkflowTabUnsaved } from "./workflowTabs";

/**
 * What closing the page now would lose, or null: unsaved tabs, or generations still on their way to the library, each
 * said as what it is; else an edit with changes not on disk.
 */
export function pageUnloadWarning(): string | null {
  const { tabs, hasUnsavedChanges } = useWorkflowStore.getState();
  return (
    unloadWarning({
      unsavedTabs: anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges }),
      pendingRecordings: pendingRecordings(),
    }) ?? (editHasUnsavedWork() ? EDIT_UNSAVED_WARNING : null)
  );
}
