type StoredRun =
  | { state: "running"; createdAt: number; updatedAt: number }
  | {
      state: "completed";
      createdAt: number;
      updatedAt: number;
      responseStatus: number;
      result: unknown;
    }
  | {
      state: "failed";
      createdAt: number;
      updatedAt: number;
      error: string;
    };

const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __nodeBananaGenerationRuns: Map<string, StoredRun> | undefined;
}

const runs =
  globalThis.__nodeBananaGenerationRuns ??
  (globalThis.__nodeBananaGenerationRuns = new Map<string, StoredRun>());

function cleanupRuns(now = Date.now()): void {
  for (const [runId, run] of runs) {
    if (run.state !== "running" && now - run.updatedAt > RUN_RETENTION_MS) {
      runs.delete(runId);
    }
  }
}

export function getServerGenerationRun(runId: string): StoredRun | null {
  cleanupRuns();
  return runs.get(runId) ?? null;
}

export function deleteServerGenerationRun(runId: string): boolean {
  return runs.delete(runId);
}

export function startServerGenerationRun(
  runId: string,
  execute: () => Promise<Response>
): "started" | "existing" {
  cleanupRuns();
  if (runs.has(runId)) return "existing";

  const createdAt = Date.now();
  runs.set(runId, { state: "running", createdAt, updatedAt: createdAt });

  void execute()
    .then(async (response) => {
      const body = await response.text();
      let result: unknown;
      try {
        result = JSON.parse(body);
      } catch {
        result = { success: false, error: body || `HTTP ${response.status}` };
      }
      runs.set(runId, {
        state: "completed",
        createdAt,
        updatedAt: Date.now(),
        responseStatus: response.status,
        result,
      });
    })
    .catch((error) => {
      runs.set(runId, {
        state: "failed",
        createdAt,
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : "Generation failed",
      });
    });

  return "started";
}
