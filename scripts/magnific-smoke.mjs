#!/usr/bin/env node
/**
 * Magnific smoke tests, against the live API.
 *
 * Two tiers, because they cost differently:
 *
 *   check   No credits. Confirms the key works and that the parts of the
 *           API the app relies on but the hermetic suite cannot see behave
 *           as recorded: the upload step (ask for a slot, PUT a file, read
 *           it back from the URL a model would be given), and the status
 *           routes (a made-up task id must answer "task not found", which
 *           shows the route exists).
 *   run     Costs credits. Drives one real generation end to end through
 *           Node Banana's own routes (/api/generate, then /api/generate/poll),
 *           so it exercises the same path the browser does. Needs a dev
 *           server.
 *
 *   MAGNIFIC_API_KEY=… node scripts/magnific-smoke.mjs check
 *   MAGNIFIC_API_KEY=… node scripts/magnific-smoke.mjs run --model text-to-image/flux-dev --prompt "a red kite"
 *   MAGNIFIC_API_KEY=… node scripts/magnific-smoke.mjs run --model image-upscaler-precision-v2 --image photo.png
 *
 *   MAGNIFIC_SMOKE_BASE   Node Banana dev server (default http://localhost:3000)
 *   MAGNIFIC_KEY_FILE     a file holding the key, instead of MAGNIFIC_API_KEY
 */
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

const API = "https://api.magnific.com/v1/ai";
const [command, ...rest] = process.argv.slice(2);

function flag(name, fallback) {
  const at = rest.indexOf(`--${name}`);
  return at !== -1 && rest[at + 1] ? rest[at + 1] : fallback;
}

const keyFile = process.env.MAGNIFIC_KEY_FILE;
const KEY = (keyFile ? readFileSync(keyFile, "utf8") : process.env.MAGNIFIC_API_KEY || "").trim();
if (!KEY) {
  console.error("Set MAGNIFIC_API_KEY (or MAGNIFIC_KEY_FILE).");
  process.exit(2);
}
const auth = { "x-magnific-api-key": KEY };

let failed = 0;
function report(ok, what, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

async function checkUpload() {
  const slotResponse = await fetch(`${API}/uploads/request-url`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ content_type: "image/png" }] }),
  });
  const slotText = await slotResponse.text();
  report(slotResponse.ok, "upload: a slot is granted", `HTTP ${slotResponse.status}`);
  if (!slotResponse.ok) {
    console.log(`      ${slotText.slice(0, 300)}`);
    return;
  }
  const answer = JSON.parse(slotText);
  const slot = (answer.files ?? answer.data?.files)?.[0];
  report(Boolean(slot?.upload_url && slot?.asset_url), "upload: the slot names upload_url and asset_url", `fields: ${Object.keys(slot ?? {}).join(", ")}`);
  if (!slot?.upload_url || !slot?.asset_url) return;
  console.log(`      headers to send: ${JSON.stringify(slot.headers ?? {})}; asset URL lasts ${slot.asset_url_expires_in ?? "?"}s`);

  const put = await fetch(slot.upload_url, { method: "PUT", headers: { "Content-Type": "image/png", ...(slot.headers ?? {}) }, body: PNG });
  report(put.ok, "upload: the PUT is accepted", `HTTP ${put.status}`);
  if (!put.ok) {
    console.log(`      ${(await put.text()).slice(0, 300)}`);
    return;
  }

  const back = await fetch(slot.asset_url);
  const bytes = back.ok ? Buffer.from(await back.arrayBuffer()) : Buffer.alloc(0);
  report(back.ok && bytes.equals(PNG), "upload: the asset URL serves the file back, without the key", `HTTP ${back.status}, ${bytes.length} bytes, ${back.headers.get("content-type")}`);
}

async function checkStatusRoutes() {
  const spec = JSON.parse(readFileSync(join(process.cwd(), "src/lib/providers/magnific/spec.json"), "utf8"));
  // The routes that are not simply the create path: the ones the sync script worked out.
  const families = [...new Set(spec.endpoints.filter((endpoint) => endpoint.poll && endpoint.poll !== endpoint.id && !endpoint.id.includes("{")).map((endpoint) => endpoint.poll))];
  const sample = ["text-to-image/flux-dev", "mystic", "image-upscaler", ...families];
  const madeUp = "00000000-0000-4000-8000-000000000000";
  for (const route of sample) {
    const response = await fetch(`${API}/${route}/${madeUp}`, { headers: auth });
    const text = (await response.text()).replace(/\s+/g, " ").slice(0, 120);
    // A route that exists answers about the task; one that does not answers as the router.
    const exists = response.status !== 401 && response.status !== 403 && !/^\{?"?message"?:? ?"?not found"?\}?$/i.test(text.trim()) && !/Cannot GET|no Route matched/i.test(text);
    report(exists, `status route ${route}`, `HTTP ${response.status}: ${text}`);
    if (response.status === 401 || response.status === 403) return;
  }
}

async function check() {
  await checkUpload();
  await checkStatusRoutes();
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

function dataUrl(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Cannot tell the type of ${path}`);
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

async function run() {
  const base = (process.env.MAGNIFIC_SMOKE_BASE || "http://localhost:3000").replace(/\/+$/, "");
  const model = flag("model", "text-to-image/flux-dev");
  const headers = { "Content-Type": "application/json", "X-Magnific-Key": KEY };

  const schemaResponse = await fetch(`${base}/api/models/${encodeURIComponent(model)}?provider=magnific`, { headers });
  const schema = await schemaResponse.json();
  report(schemaResponse.ok, `schema for ${model}`, schemaResponse.ok ? `${schema.inputs?.length ?? 0} handles, ${schema.parameters?.length ?? 0} settings` : JSON.stringify(schema).slice(0, 200));
  if (!schemaResponse.ok) return;

  const mediaType = model.startsWith("music-generation") || model.startsWith("sound-effects") || model.startsWith("voiceover") ? "audio" : /video|lip-sync/.test(model.split("/")[0]) ? "video" : "image";
  const dynamicInputs = {};
  for (const type of ["image", "video", "audio"]) {
    const path = flag(type);
    if (!path) continue;
    const handle = schema.inputs.find((input) => input.type === type);
    if (!handle) throw new Error(`${model} has no ${type} handle`);
    dynamicInputs[handle.name] = handle.isArray ? [dataUrl(path)] : dataUrl(path);
  }
  const parameters = JSON.parse(flag("params", "{}"));

  const started = Date.now();
  const submit = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: flag("prompt", ""),
      images: [],
      selectedModel: { provider: "magnific", modelId: model, displayName: model },
      parameters,
      dynamicInputs,
      mediaType,
    }),
  });
  let answer = await submit.json();
  report(submit.ok && answer.polling === true, "submitted", submit.ok ? `task ${answer.taskId}` : answer.error);
  if (!submit.ok || !answer.polling) return;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(`${base}/api/generate/poll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: answer.taskId, provider: "magnific", modelId: model, modelName: model, mediaType }),
    });
    const next = await poll.json();
    if (poll.ok && next.polling) {
      process.stdout.write(".");
      continue;
    }
    process.stdout.write("\n");
    const output = next.image || next.video || next.audio || next.videoUrl || next.audioUrl;
    report(poll.ok && Boolean(output), "finished with an output", poll.ok ? `${next.contentType}, ${String(output).slice(0, 40)}… ${Math.round(String(output).length / 1024)}KB, ${Math.round((Date.now() - started) / 1000)}s` : `HTTP ${poll.status}: ${next.error}`);
    return;
  }
}

if (command === "check") await check();
else if (command === "run") await run();
else {
  console.log("Usage: node scripts/magnific-smoke.mjs check | run --model <id> [--prompt …] [--image file] [--video file] [--audio file] [--params '{…}']");
  process.exit(2);
}
process.exit(failed ? 1 : 0);
