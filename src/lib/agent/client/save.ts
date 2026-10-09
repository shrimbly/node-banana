/**
 * The agent's save_workflow, done in the browser the way the user's own Save
 * does it: a workflow with a folder saves into it; a first save goes into a
 * new project folder named after the workflow, in the Node Banana folder (or
 * the folder the user last saved a project in). With neither, the user's save
 * dialog opens, since only they can say where it goes.
 */

import { useToast } from "@/components/Toast";
import { fetchProjectFolderName } from "@/lib/assets/client/api";
import { getRecorderLibraryStatus } from "@/lib/assets/client/recorder";
import { requestSave } from "@/store/saveRequestStore";
import { getLastProjectBaseDir } from "@/store/utils/localStorage";
import { generateWorkflowId, useWorkflowStore } from "@/store/workflowStore";

export type SaveLiveWorkflowResult = { ok: true; name: string; path: string } | { ok: false; reason: string };

/** How many numbered folders ("Fox 2", "Fox 3", …) a first save outside the library tries. */
const MAX_FOLDER_TRIES = 20;

/** Saves the live workflow; a first save names it `name` (else its current name). */
export async function saveLiveWorkflow(name?: string): Promise<SaveLiveWorkflowResult> {
  const store = useWorkflowStore.getState();
  if (store.saveDirectoryPath) {
    if (!store.workflowName) return { ok: false, reason: "The workflow needs a name before it can be saved" };
    return save(store.workflowName, store.saveDirectoryPath);
  }

  const projectName = name?.trim() || store.workflowName?.trim() || "";
  if (!projectName) return { ok: false, reason: "The workflow needs a name before it can be saved" };
  const generation = store.canvasGeneration;
  // A canvas that never had a folder keeps its id, so what it already generated belongs to the project.
  const id = store.workflowId || generateWorkflowId();

  let path: string | null;
  try {
    path = await firstSaveFolder(projectName, id);
  } catch (error) {
    return { ok: false, reason: `Couldn't find a folder for ${projectName}: ${errorText(error)}` };
  }
  if (useWorkflowStore.getState().canvasGeneration !== generation) {
    return { ok: false, reason: "Didn't save: a different workflow was opened" };
  }
  if (!path) {
    // The dialog asks where; the name the agent chose is already in it.
    requestSave("menu", projectName);
    return { ok: false, reason: `Choose where to save ${projectName}: there is no default folder` };
  }

  useWorkflowStore.getState().setWorkflowMetadata(id, projectName, path);
  return save(projectName, path);
}

/**
 * Where a first save goes: a new folder in the Node Banana folder when the
 * library is there, else one in the last project folder used. Null when
 * there is neither.
 */
async function firstSaveFolder(projectName: string, id: string): Promise<string | null> {
  const library = getRecorderLibraryStatus();
  if (library?.available && library.root) {
    try {
      return (await fetchProjectFolderName(projectName)).path;
    } catch (error) {
      if (!getLastProjectBaseDir()) throw error;
    }
  }
  const base = getLastProjectBaseDir()?.trim();
  if (!base) return null;
  for (let attempt = 1; attempt <= MAX_FOLDER_TRIES; attempt++) {
    const candidate = ensureProjectSubfolderPath(base, attempt === 1 ? projectName : `${projectName} ${attempt}`);
    // Never write over another workflow's folder: the user's dialog asks first, the agent moves on to the next name.
    if (await folderIsFree(candidate, id)) return candidate;
  }
  throw new Error(`every folder from "${projectName}" to "${projectName} ${MAX_FOLDER_TRIES}" holds another workflow`);
}

/** The folder doesn't exist yet, is empty of workflows, or holds this one. */
async function folderIsFree(folder: string, id: string): Promise<boolean> {
  const response = await fetch(`/api/workflow?path=${encodeURIComponent(folder)}&load=true`);
  const result = (await response.json().catch(() => null)) as
    | { success?: boolean; exists?: boolean; isDirectory?: boolean; workflow?: { id?: unknown } }
    | null;
  if (!result) throw new Error("the workflow folder check sent an unreadable answer");
  if (result.exists && result.isDirectory === false) return false;
  if (!result.success || !result.workflow) return true;
  return result.workflow.id === id;
}

async function save(name: string, path: string): Promise<SaveLiveWorkflowResult> {
  const generation = useWorkflowStore.getState().canvasGeneration;
  const saved = await useWorkflowStore.getState().saveToFile({ reason: "manual" });
  if (saved) return { ok: true, name, path };
  if (useWorkflowStore.getState().canvasGeneration !== generation) {
    return { ok: false, reason: `Didn't save ${name}: a different workflow was opened` };
  }
  // A failed manual save has already said why in a toast; pass that on rather than a vaguer one.
  const toast = useToast.getState();
  return { ok: false, reason: toast.type === "error" && toast.message ? toast.message : `Couldn't save ${name}` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<base>/<folder>`, unless `base` already is that folder (as the project dialog does). */
export function ensureProjectSubfolderPath(basePath: string, projectName: string): string {
  const base = basePath.trim();
  const folder = projectName
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  if (!folder) return base;
  const basename = base.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (basename.toLowerCase() === folder.toLowerCase()) return base;
  const separator = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\") ? "\\" : "/";
  return `${base}${base.endsWith("/") || base.endsWith("\\") ? "" : separator}${folder}`;
}
