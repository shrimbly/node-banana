import type { PersistedGenerationRun } from "@/types/generationRuns";

export const GENERATION_RUNS_STORAGE_KEY = "node-banana-generation-runs-v1";
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_STATUSES = new Set(["submitting", "running", "provider-polling", "completed", "failed"]);
const PROVIDERS = new Set(["gemini", "openai", "anthropic", "replicate", "fal", "kie", "wavespeed"]);

function isRun(value: unknown): value is PersistedGenerationRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<PersistedGenerationRun>;
  return (
    run.version === 1 &&
    typeof run.runId === "string" &&
    (typeof run.workflowId === "string" || run.workflowId === null) &&
    typeof run.nodeId === "string" &&
    run.nodeType === "generateVideo" &&
    typeof run.provider === "string" &&
    PROVIDERS.has(run.provider) &&
    typeof run.modelId === "string" &&
    typeof run.modelName === "string" &&
    run.mediaType === "video" &&
    typeof run.prompt === "string" &&
    typeof run.status === "string" &&
    RUN_STATUSES.has(run.status) &&
    typeof run.createdAt === "number" &&
    typeof run.updatedAt === "number"
  );
}

export function loadGenerationRuns(): PersistedGenerationRun[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(GENERATION_RUNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    return parsed.filter(
      (run): run is PersistedGenerationRun =>
        isRun(run) &&
        (!(["completed", "failed"] as string[]).includes(run.status) ||
          run.updatedAt >= cutoff)
    );
  } catch {
    return [];
  }
}

function saveGenerationRuns(runs: PersistedGenerationRun[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(GENERATION_RUNS_STORAGE_KEY, JSON.stringify(runs));
  } catch (error) {
    console.warn("Could not persist generation recovery state:", error);
  }
}

export function upsertGenerationRun(run: PersistedGenerationRun): void {
  const runs = loadGenerationRuns();
  const index = runs.findIndex((candidate) => candidate.runId === run.runId);
  if (index === -1) runs.push(run);
  else runs[index] = run;
  saveGenerationRuns(runs);
}

export function updateGenerationRun(
  runId: string,
  updates: Partial<Omit<PersistedGenerationRun, "runId" | "version">>
): PersistedGenerationRun | null {
  const runs = loadGenerationRuns();
  const index = runs.findIndex((run) => run.runId === runId);
  if (index === -1) return null;
  const updated: PersistedGenerationRun = {
    ...runs[index],
    ...updates,
    updatedAt: Date.now(),
  };
  runs[index] = updated;
  saveGenerationRuns(runs);
  return updated;
}

export function removeGenerationRun(runId: string): void {
  saveGenerationRuns(loadGenerationRuns().filter((run) => run.runId !== runId));
}

export function acknowledgeGenerationRun(runId: string): void {
  removeGenerationRun(runId);
  if (typeof window === "undefined") return;
  void fetch(`/api/generate/run?runId=${encodeURIComponent(runId)}`, {
    method: "DELETE",
  }).catch(() => {
    // The server cache is best-effort; local acknowledgement is authoritative.
  });
}

export function acknowledgeSavedVideoRuns(
  nodes: Array<{ type?: string; data?: unknown }>
): void {
  const runIds = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "generateVideo" || !node.data || typeof node.data !== "object") continue;
    const history = (node.data as { videoHistory?: Array<{ runId?: string }> }).videoHistory;
    for (const item of history || []) {
      if (item.runId) runIds.add(item.runId);
    }
  }
  for (const runId of runIds) acknowledgeGenerationRun(runId);
}

export function getGenerationRunsForWorkflow(
  workflowId: string | null
): PersistedGenerationRun[] {
  if (!workflowId) return [];
  return loadGenerationRuns().filter((run) => run.workflowId === workflowId);
}

export function createGenerationRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
