import { GoogleGenAI } from "@google/genai";
import { setTimeout as delay } from "node:timers/promises";
import type { GenerationOutput } from "@/lib/providers/types";
import { GEMINI_OMNI_PARAMETERS, isGeminiOmni } from "@/lib/providers/geminiOmni";

type MediaKind = "image" | "video" | "audio";
type OmniContent = { type: MediaKind; data?: string; uri?: string; mime_type?: string } | { type: "text"; text: string };
interface OmniResponse {
  status?: string;
  error?: { message?: string };
  steps?: Array<{ type: string; content?: OmniContent[] }>;
}

function values(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter((entry) => entry.trim());
}

/** Omni uses Interactions, not Veo's generateVideos operation. */
export async function generateWithGeminiOmni(
  apiKey: string,
  modelId: string,
  prompt: string,
  images: string[] = [],
  parameters: Record<string, unknown> = {},
  dynamicInputs: Record<string, string | string[]> = {},
  callerSignal?: AbortSignal,
): Promise<GenerationOutput> {
  if (!isGeminiOmni(modelId)) return { success: false, statusCode: 400, error: "Unknown Gemini Omni model" };
  if (!prompt.trim()) return { success: false, statusCode: 400, error: "Gemini Omni requires a prompt describing the video or edit." };
  for (const parameter of GEMINI_OMNI_PARAMETERS) {
    const value = parameters[parameter.name];
    if (value !== undefined && !parameter.enum?.includes(value)) {
      return { success: false, statusCode: 400, error: `Invalid Gemini Omni ${parameter.name}: choose ${parameter.enum?.join(", ")}.` };
    }
  }

  const timeout = AbortSignal.timeout(9 * 60 * 1000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const ai = new GoogleGenAI({ apiKey });
  const uploadedFiles: string[] = [];

  // Images can travel inline. Upload clips/audio through Files, waiting until
  // processing completes; delete only files this request created afterwards.
  const mediaContent = async (source: string, type: MediaKind): Promise<OmniContent> => {
    signal.throwIfAborted();
    let data: Buffer;
    let mime: string;
    const inline = source.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (inline) {
      mime = inline[1];
      data = Buffer.from(inline[2], "base64");
    } else {
      const url = new URL(source);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Media must be a data URL or HTTP(S) URL.");
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Unable to download ${type} input (${response.status}).`);
      mime = response.headers.get("content-type")?.split(";")[0] ?? "";
      data = Buffer.from(await response.arrayBuffer());
    }
    if (!mime.startsWith(`${type}/`) || data.length === 0) throw new Error(`Invalid ${type} input: expected ${type} media.`);
    if (type === "image" && data.length < 10 * 1024 * 1024) {
      return { type, data: data.toString("base64"), mime_type: mime };
    }
    let file = await ai.files.upload({
      file: new Blob([new Uint8Array(data)], { type: mime }),
      config: { mimeType: mime, abortSignal: signal },
    });
    if (!file.name) throw new Error(`Google did not return an uploaded ${type} file.`);
    const name = file.name;
    uploadedFiles.push(name);
    while (file.state === "PROCESSING") {
      await delay(2000, undefined, { signal });
      file = await ai.files.get({ name, config: { abortSignal: signal } });
    }
    if (file.state === "FAILED" || !file.uri) throw new Error(`Google could not process the ${type} input.`);
    return { type, uri: file.uri, mime_type: mime };
  };

  try {
    signal.throwIfAborted();
    const input: OmniContent[] = [];
    // Dynamic image inputs duplicate the top-level image list. Keep a single,
    // ordered copy so first/last-frame and reference prompts remain stable.
    const imageInputs = values(dynamicInputs.image);
    for (const image of imageInputs.length ? imageInputs : images) input.push(await mediaContent(image, "image"));
    for (const video of values(dynamicInputs.video)) input.push(await mediaContent(video, "video"));
    for (const audio of values(dynamicInputs.audio)) input.push(await mediaContent(audio, "audio"));
    input.push({ type: "text", text: prompt });
    const task = parameters.task;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, "Api-Revision": "2026-05-20" },
      signal,
      body: JSON.stringify({
        model: modelId,
        input,
        store: false,
        response_format: { type: "video", aspect_ratio: parameters.aspectRatio ?? "16:9", resolution: parameters.resolution ?? "720p" },
        ...(task && task !== "auto" ? { generation_config: { video_config: { task } } } : {}),
      }),
    });
    const result = await response.json() as OmniResponse;
    if (!response.ok || result.error) {
      return { success: false, statusCode: response.ok ? 502 : response.status, error: result.error?.message ?? `Gemini Omni request failed (${response.status}).` };
    }
    if (result.status !== "completed") {
      return { success: false, error: `Gemini Omni generation did not complete (${result.status ?? "unknown status"}).` };
    }
    // output_video is an SDK convenience. REST returns generated media only
    // in model_output steps; never mistake the input video for a result.
    const output = result.steps?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? []).find((part) => part.type === "video" && part.data);
    if (!output || output.type !== "video" || !output.data) {
      return { success: false, error: "Gemini Omni returned no video. The request may have been filtered; try revising the prompt." };
    }
    return { success: true, outputs: [{ type: "video", data: `data:${output.mime_type ?? "video/mp4"};base64,${output.data}` }] };
  } catch (error) {
    if (callerSignal?.aborted) return { success: false, statusCode: 499, error: "Video generation cancelled." };
    if (timeout.aborted) return { success: false, statusCode: 504, error: "Gemini Omni timed out after 9 minutes." };
    return { success: false, error: error instanceof Error ? error.message : "Gemini Omni generation failed." };
  } finally {
    await Promise.allSettled(uploadedFiles.map((name) => ai.files.delete({ name, config: { abortSignal: AbortSignal.timeout(5000) } })));
  }
}
