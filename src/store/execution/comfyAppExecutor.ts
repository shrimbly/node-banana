/**
 * Comfy App Executor
 *
 * Runs a ComfyUI workflow bound to a node: gather the connected inputs, submit
 * them to the configured engine, poll until the render finishes, and write the
 * results back onto the node's typed output handles.
 *
 * Submission and polling are separate short-lived requests. A diffusion run
 * regularly takes minutes, and holding one connection open for that long is
 * what makes long generations fail on idle timeouts.
 */

import type { ComfyAppNodeData, ComfyRunHistoryItem, ComfyRunHistoryOutput, RunBatchTag } from "@/types";
import type { ComfyAppInput, ComfyResolvedOutput } from "@/lib/comfy/types";
import type { RecordAssetResult, RecordedAssetHandle } from "@/lib/assets/types";
import { buildComfyHeaders, comfyConfigError, getComfySettings } from "@/lib/comfy/settings";
import type { NodeExecutionContext } from "./types";
import { MissingInputError } from "./missingInput";
import { assetParameters, assetProducer, recordOutput, recordingResult, withFolderFallback } from "./assetRecording";

/** The carousel keeps this many runs, like the image and video nodes. */
const RUN_HISTORY_LIMIT = 50;

/** Polling cadence — starts responsive, then backs off for long renders. */
const INITIAL_INTERVAL = 1500;
const MAX_INTERVAL = 6000;
const INTERVAL_STEP = 500;
const MAX_CONSECUTIVE_ERRORS = 8;
/**
 * How long one poll may take before it is abandoned and retried.
 *
 * The deadline below is only checked *between* polls, so a request that hangs
 * spends the run's whole budget without the loop ever getting a turn — an 8
 * second video once failed with "timed out after 15 min" having been asked
 * about exactly once. Bounding each request keeps the loop turning, which is
 * what makes both the retry budget and the deadline mean anything.
 */
const POLL_REQUEST_TIMEOUT_MS = 45_000;
/**
 * How long the request that *downloads* the results may take.
 *
 * Asking whether a job is done and fetching what it produced are the same route
 * but not the same request: a status poll is a few hundred bytes, while
 * collecting moves every output — a minute of video is tens of megabytes, and
 * one measured at 73 seconds against Comfy Cloud. Holding both to the poll's
 * limit cut off a render that had already succeeded and been paid for, and the
 * retry started the download again from nothing, forever. Matches the route's
 * own `maxDuration`, so the client gives up no sooner than the server does.
 */
const COLLECT_REQUEST_TIMEOUT_MS = 300_000;

interface ComfyRunAccepted {
  success: true;
  polling: true;
  jobId: string;
  status: string;
}

interface ComfyPollUpdate {
  success: true;
  polling: boolean;
  status: string;
  progress?: number;
  outputs?: ComfyResolvedOutput[];
  /** The job is done and the results are waiting to be fetched. */
  ready?: boolean;
}

interface ComfyFailure {
  success: false;
  error: string;
  notConfigured?: boolean;
  missingNodes?: string[];
  /** The route could not reach the engine — nothing about the job is settled. */
  transient?: boolean;
}

/**
 * A failure the route itself reported — as opposed to a gateway or proxy error
 * on the way to it.
 *
 * The distinction decides whether a poll is terminal: a `{success: false}` body
 * means the engine has spoken and the run is over, while a bare 502 from
 * something in between is a blip a long render should survive.
 */
export class ComfyRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyRouteError";
  }
}

/** Read an error out of a response, distinguishing route errors from gateway ones. */
export async function readError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as ComfyFailure;
    // A route that says it could not reach the engine is reporting the network,
    // not a verdict — the render it was asked about is probably still going.
    if (body?.error) {
      return body.transient ? new Error(body.error) : new ComfyRouteError(body.error);
    }
  } catch {
    /* not a route-shaped response — treat as transient below */
  }
  const detail = text ? `${fallback}: ${text.slice(0, 200)}` : fallback;
  // 4xx is a request problem and will not fix itself; 5xx without a route body
  // is something in front of the route, which might.
  return response.status < 500 ? new ComfyRouteError(detail) : new Error(detail);
}

/**
 * Whether a failure is this run being cancelled.
 *
 * An abort can surface as a `DOMException`, as a plain `Error` named
 * AbortError, or — when the abort lands between two awaits — as an unrelated
 * network error with the signal already tripped. All three mean "stopped".
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/** How long a best-effort cancel may take before the node stops waiting on it. */
const CANCEL_TIMEOUT_MS = 10_000;

/** Best-effort stop for an engine job. Never throws. */
async function cancelJob(
  headers: Record<string, string>,
  jobId: string | null,
  app: unknown
): Promise<void> {
  if (!jobId) return;
  try {
    await fetch("/api/comfy/poll", {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId, app, cancel: true }),
      // Its own bound, unrelated to the run's: cancelling is what *unblocks*
      // the node, so a stalled route must not be able to hold the user's Stop
      // — or the job-timeout path — waiting forever for a best-effort request.
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
  } catch {
    // A cancel must never fail the cancel.
  }
}

/** Sleep that rejects promptly when the run is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeComfyApp(ctx: NodeExecutionContext): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    addToGlobalHistory,
    generationsPath,
    trackSaveGeneration,
  } = ctx;

  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data ?? node.data) as ComfyAppNodeData;
  const app = nodeData.app;

  if (!app) {
    const message = "No ComfyUI workflow attached to this node";
    updateNodeData(node.id, { status: "skipped", error: message });
    throw new MissingInputError(message);
  }

  const settings = getComfySettings();
  const configError = comfyConfigError(settings);
  if (configError) {
    updateNodeData(node.id, { status: "error", error: configError });
    throw new Error(configError);
  }

  // `dynamicInputs` is keyed by the schema names derived from `app.inputs`, so
  // it maps a connected handle straight onto the graph binding it feeds.
  const connected = getConnectedInputs(node.id);
  const inputs: Record<string, string> = {};
  for (const input of app.inputs) {
    const dynamic = connected.dynamicInputs[input.name];
    const value = Array.isArray(dynamic) ? dynamic[0] : dynamic;
    if (typeof value === "string" && value !== "") inputs[input.name] = value;
  }

  // Legacy fallback for an edge made before this node had a schema (its
  // targetHandle is the bare "image"/"text", which maps to no schema name).
  //
  // Only applied when the app has exactly ONE input of that type. With two —
  // a positive and a negative prompt, say — the untyped value cannot say which
  // it was meant for, and guessing would quietly feed the positive prompt into
  // the negative one. Leaving it unset runs the author's saved value instead,
  // which is wrong in an obvious way rather than an invisible one.
  const soleInputOfType = (type: ComfyAppInput["type"]): ComfyAppInput | null => {
    const matches = app.inputs.filter((i) => i.type === type);
    return matches.length === 1 && matches[0] ? matches[0] : null;
  };
  const fallbacks: Array<[ComfyAppInput["type"], string | undefined]> = [
    ["text", connected.text ?? undefined],
    ["image", connected.images[0]],
    ["video", connected.videos[0]],
    ["audio", connected.audio[0]],
  ];
  for (const [type, value] of fallbacks) {
    if (!value) continue;
    const target = soleInputOfType(type);
    if (target && !inputs[target.name]) inputs[target.name] = value;
  }

  const missing = app.inputs
    .filter((input) => input.required && !inputs[input.name])
    .map((input) => input.label);
  if (missing.length > 0) {
    const message = `Missing required input: ${missing.join(", ")}`;
    updateNodeData(node.id, { status: "skipped", error: message });
    throw new MissingInputError(message);
  }

  updateNodeData(node.id, {
    status: "loading",
    error: null,
    runStatus: "queued",
    jobId: null,
  });

  const headers = buildComfyHeaders(settings);
  let jobId: string | null = null;
  // The server derives randomised seeds from this, so it reproduces the run
  const seedKey = `${node.id}-${Date.now()}`;

  try {
    const submitRes = await fetch("/api/comfy/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        app,
        inputs,
        params: nodeData.paramValues ?? {},
        randomizeSeeds: settings.randomizeSeeds,
        seedKey,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!submitRes.ok) {
      throw await readError(submitRes, "ComfyUI rejected the workflow");
    }
    const accepted = (await submitRes.json()) as ComfyRunAccepted;
    jobId = accepted.jobId;
    updateNodeData(node.id, { jobId, runStatus: accepted.status });

    let interval = INITIAL_INTERVAL;
    let consecutiveErrors = 0;
    // The job is finished and only the download is left. Tracked separately
    // because the two requests want very different patience — see
    // COLLECT_REQUEST_TIMEOUT_MS — and because a failed download must be
    // retried as a download, not as another question.
    let collecting = false;
    const deadline = Date.now() + settings.jobTimeoutMs;

    for (;;) {
      if (Date.now() > deadline) {
        // Stop the engine too. An abandoned job keeps a GPU busy — and on
        // Comfy Cloud, keeps billing — long after the node gave up on it.
        await cancelJob(headers, jobId, app);
        throw new Error(
          `Timed out after ${Math.round(settings.jobTimeoutMs / 60_000)} min waiting for ComfyUI. Raise the job timeout in Settings → ComfyUI for long renders.`
        );
      }
      // Nothing to wait for once the job is done — the results are sitting
      // there. The pause belongs between questions, not before the answer.
      if (!collecting) {
        await delay(interval, signal);
        interval = Math.min(MAX_INTERVAL, interval + INTERVAL_STEP);
      }

      let update: ComfyPollUpdate;
      try {
        const limit = collecting ? COLLECT_REQUEST_TIMEOUT_MS : POLL_REQUEST_TIMEOUT_MS;
        const pollRes = await fetch("/api/comfy/poll", {
          method: "POST",
          headers,
          body: JSON.stringify({ jobId, app, collect: collecting }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(limit)])
            : AbortSignal.timeout(limit),
        });
        if (!pollRes.ok) throw await readError(pollRes, "ComfyUI run failed");
        update = (await pollRes.json()) as ComfyPollUpdate;
        consecutiveErrors = 0;
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        // A failure the route reported is the engine's verdict — terminal.
        // Anything else (a dropped connection, a gateway hiccup) is worth
        // retrying: the render itself is very likely still going.
        if (error instanceof ComfyRouteError) throw error;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw error;
        // A retried download would otherwise start again immediately, and a
        // failing one would spin.
        if (collecting) await delay(interval, signal);
        continue;
      }

      if (update.polling) {
        updateNodeData(node.id, { runStatus: update.status });
        continue;
      }

      // Done asking. Come back for the results themselves, patiently.
      if (update.ready) {
        collecting = true;
        continue;
      }

      const outputs = update.outputs ?? [];
      const resolved = outputsToNodeData(app.outputs, outputs);
      updateNodeData(node.id, {
        ...resolved,
        status: "complete",
        error: null,
        runStatus: null,
        jobId: null,
      });

      // Every media output is a generation like any other, so each goes to the
      // asset library under its own handle.
      const prompt = describeRun(app.name, inputs, nodeData.paramValues ?? {});
      const parameters = assetParameters({
        ...(nodeData.paramValues ?? {}),
        ...(settings.randomizeSeeds ? { seedKey } : {}),
      });
      const timestamp = Date.now();
      const imageId = `${timestamp}`;
      const recordings = new Map<string, RecordedAssetHandle>();
      let imageRecording: RecordedAssetHandle | null = null;
      for (const output of outputs) {
        if (output.type === "text" || !output.value) continue;
        const recorded = recordOutput(ctx, {
          kind: output.type,
          origin: "generated",
          media: output.value,
          prompt,
          model: { provider: "comfyui", modelId: app.name, displayName: app.name },
          parameters,
          producer: assetProducer(ctx, { outputHandle: output.handleId }),
        });
        if (!recorded) continue;
        recordings.set(output.handleId, recorded);
        if (!imageRecording && output.value === resolved.outputImage) imageRecording = recorded;
      }

      // The run joins the node's carousel, like an image or video generation:
      // every output by its handle, reloaded from the library or the project's
      // generations folder. Only a run saved to one of them gets an entry.
      const entry = comfyRunHistoryEntry({
        outputs,
        timestamp,
        prompt,
        model: app.name,
        batch: ctx.batch,
        assetIds: Object.fromEntries([...recordings].map(([handleId, handle]) => [handleId, handle.assetId])),
        folderImageId: generationsPath && resolved.outputImage ? imageId : undefined,
        primaryImage: resolved.outputImage,
      });
      if (entry) {
        const current = (ctx.getFreshNode(node.id)?.data as ComfyAppNodeData | undefined)?.runHistory ?? nodeData.runHistory ?? [];
        updateNodeData(node.id, {
          runHistory: [entry, ...current].slice(0, RUN_HISTORY_LIMIT),
          selectedRunHistoryIndex: 0,
        });
        for (const [handleId, handle] of recordings) {
          if (handle === imageRecording && generationsPath) continue; // followed with its folder save below
          void recordingResult(handle).then((result) => {
            recordedIntoHistory(ctx, entry.id, handleId, result);
          });
        }
      }

      // A Comfy app's image also belongs in the global history, and — without
      // the asset library, or when its recording fails or is held up — in the
      // project's generations folder, so it can be browsed and reloaded
      // alongside everything else.
      if (resolved.outputImage) {
        const image = resolved.outputImage;
        addToGlobalHistory({
          image,
          timestamp,
          prompt,
          aspectRatio: "1:1",
          model: app.name,
        });
        if (generationsPath) {
          const saveToFolder = () =>
            fetch("/api/save-generation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                directoryPath: generationsPath,
                image,
                prompt,
                imageId,
              }),
            })
              .then(() => undefined)
              .catch((err) => {
                console.error("Failed to save ComfyUI generation:", err);
              });
          const imageHandle = outputs.find((output) => output.value === image)?.handleId;
          trackSaveGeneration(
            imageId,
            imageRecording
              ? withFolderFallback(imageRecording, saveToFolder, (result) => {
                  if (entry && imageHandle) recordedIntoHistory(ctx, entry.id, imageHandle, result);
                })
              : saveToFolder()
          );
        }
      }
      return;
    }
  } catch (error) {
    if (isAbort(error, signal)) {
      await cancelJob(headers, jobId, app);
      updateNodeData(node.id, { status: "idle", runStatus: null, jobId: null });
      // Normalize so executeWorkflow sees the cancellation it expects, whatever
      // shape the underlying failure arrived in.
      throw error instanceof DOMException
        ? error
        : new DOMException("The operation was aborted.", "AbortError");
    }
    const message = error instanceof Error ? error.message : "ComfyUI run failed";
    updateNodeData(node.id, {
      status: "error",
      error: message,
      runStatus: null,
      jobId: null,
    });
    throw new Error(message);
  }
}

/**
 * The carousel entry for a run, or null when nothing in it can be reloaded:
 * a media output needs the library's id or a file in the project's folder
 * (which only the first image gets), text is kept as it is, and a 3D model,
 * which the node holds by URL, has nothing to reload.
 */
export function comfyRunHistoryEntry(run: {
  outputs: ComfyResolvedOutput[];
  timestamp: number;
  prompt: string;
  model: string;
  batch?: RunBatchTag;
  /** Asset ids by output handle, for the outputs the library is recording. */
  assetIds: Record<string, string | undefined>;
  /** The file name the first image gets in the project's generations folder. */
  folderImageId?: string;
  primaryImage?: string | null;
}): ComfyRunHistoryItem | null {
  const entries: Record<string, ComfyRunHistoryOutput> = {};
  let reloadable = false;
  for (const output of run.outputs) {
    if (!output.value || output.type === "3d") continue;
    if (output.type === "text") {
      entries[output.handleId] = { type: "text", text: output.value };
      continue;
    }
    const assetId = run.assetIds[output.handleId];
    const id = run.folderImageId && output.type === "image" && output.value === run.primaryImage ? run.folderImageId : undefined;
    if (!assetId && !id) continue;
    entries[output.handleId] = { type: output.type, ...(assetId ? { assetId } : {}), ...(id ? { id } : {}) };
    reloadable = true;
  }
  if (!reloadable) return null;
  return {
    id: `${run.timestamp}`,
    timestamp: run.timestamp,
    prompt: run.prompt,
    model: run.model,
    ...(run.batch ? { batch: run.batch } : {}),
    outputs: entries,
  };
}

/**
 * A recording settled: the entry's output takes the file name the library
 * gave it in the project's folder, or, when the recording failed, loses the
 * asset id it can no longer load by. An output left with nothing to load by
 * goes, and an entry left with no media goes with it; the selection stays
 * on its run, or names none (-1) when that run was the one dropped.
 */
export function recordedIntoHistory(
  ctx: NodeExecutionContext,
  entryId: string,
  handleId: string,
  result: RecordAssetResult | null
): void {
  const data = ctx.getFreshNode(ctx.node.id)?.data as ComfyAppNodeData | undefined;
  const history = data?.runHistory;
  if (!history) return;
  const index = history.findIndex((entry) => entry.id === entryId);
  if (index === -1) return;
  const entry = history[index];
  const output = entry.outputs[handleId];
  if (!output) return;
  const next: ComfyRunHistoryOutput = { ...output };
  if (result) {
    if (result.legacyId) next.id = result.legacyId;
  } else {
    delete next.assetId;
  }
  const outputs = { ...entry.outputs };
  if (next.assetId || next.id || next.type === "text") outputs[handleId] = next;
  else delete outputs[handleId];
  const hasMedia = Object.values(outputs).some((item) => item.type !== "text");
  const selected = data?.selectedRunHistoryIndex ?? 0;
  if (hasMedia) {
    const updated = [...history];
    updated[index] = { ...entry, outputs };
    ctx.updateNodeData(ctx.node.id, { runHistory: updated });
    return;
  }
  ctx.updateNodeData(ctx.node.id, {
    runHistory: history.filter((_, i) => i !== index),
    selectedRunHistoryIndex: selected > index ? selected - 1 : selected === index ? -1 : selected,
  });
}

/**
 * A one-line description of what produced an image, for the history entry.
 *
 * A Comfy app has no single "prompt" — it may have several text inputs, or
 * none at all — so the app name plus whatever text went in is the closest
 * honest summary.
 */
function describeRun(
  appName: string,
  inputs: Record<string, string>,
  params: Record<string, unknown>
): string {
  const text = Object.values(inputs)
    .filter((value) => !value.startsWith("data:"))
    .join(" · ")
    .slice(0, 400);
  if (text) return `${appName}: ${text}`;
  const settings = Object.entries(params)
    // A curve's coordinates would fill the line with "[object Object]" or worse,
    // and its shape is not something a one-line summary can carry.
    .filter(([, value]) => typeof value !== "object" || value === null)
    .map(([key, value]) => `${key.split(":").pop()}=${String(value)}`)
    .join(", ")
    .slice(0, 200);
  return settings ? `${appName} (${settings})` : appName;
}

/**
 * Spread resolved outputs across the node's data.
 *
 * `outputs` is the authoritative handle-keyed map; the typed mirrors
 * (`outputImage`, `outputText`, …) exist so the rest of the app — auto-save,
 * the gallery, cost tracking — can find a Comfy app's result without knowing
 * its handle layout.
 */
export function outputsToNodeData(
  declared: Array<{ id: string; type: string }>,
  resolved: ComfyResolvedOutput[]
): Partial<ComfyAppNodeData> {
  const outputs: Record<string, string> = {};
  for (const output of resolved) outputs[output.handleId] = output.value;

  const firstOfType = (type: string): string | null => {
    for (const declaration of declared) {
      if (declaration.type !== type) continue;
      const value = outputs[declaration.id];
      if (value) return value;
    }
    return null;
  };

  return {
    outputs,
    outputImage: firstOfType("image"),
    outputVideo: firstOfType("video"),
    outputAudio: firstOfType("audio"),
    outputText: firstOfType("text"),
    output3dUrl: firstOfType("3d"),
  };
}
