#!/usr/bin/env node
/**
 * Record Magnific's API as the app reads it.
 *
 *   npm run magnific:sync
 *   npm run magnific:sync -- --file path/to/openapi.yaml   (a copy already on disk)
 *
 * Magnific has no endpoint that lists its models. What it publishes is one
 * OpenAPI document for the whole API (public, no key). This downloads it
 * into .scratch/magnific and writes the part the app uses to
 * src/lib/providers/magnific/spec.json: every POST under /v1/ai with its
 * request schema (refs inlined, examples dropped) and the route its task is
 * polled on. Which of those the app offers, and how each is called, is
 * decided from that file by src/lib/providers/magnific/bindings.ts.
 *
 * After a sync, run the suite that checks every endpoint is either bound or
 * excluded with a reason, and that each bound request validates against its
 * schema:
 *
 *   npx vitest run src/lib/providers/magnific
 *
 * js-yaml is not a dependency of its own; it arrives with eslint and
 * electron-updater, as ajv does for the schema suites.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const SOURCE = "https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml";
const ROOT = process.cwd();
const SCRATCH = join(ROOT, ".scratch/magnific");
const OUT = join(ROOT, "src/lib/providers/magnific/spec.json");
const PREFIX = "/v1/ai/";

const fileFlag = process.argv.indexOf("--file");
let text;
if (fileFlag !== -1 && process.argv[fileFlag + 1]) {
  text = readFileSync(process.argv[fileFlag + 1], "utf8");
} else {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`GET ${SOURCE} answered ${response.status}`);
  text = await response.text();
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, "openapi.yaml"), text);
}
const spec = yaml.load(text);

/** Keys that only document a schema; nothing reads them. */
const DROPPED = new Set(["example", "examples", "xml", "discriminator", "externalDocs", "title"]);

function resolve(ref) {
  let node = spec;
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) throw new Error(`Unresolved $ref ${ref}`);
  return node;
}

/**
 * A schema with every $ref inlined. A ref met again on its own path is cut,
 * so a recursive schema ends. An empty anyOf/oneOf/allOf (the description
 * carries a few) says nothing and is not a valid schema, so it is dropped.
 */
function inline(node, trail = []) {
  if (Array.isArray(node)) return node.map((item) => inline(item, trail));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    if (trail.includes(node.$ref)) return {};
    const { $ref, ...rest } = node;
    return inline({ ...resolve($ref), ...rest }, [...trail, $ref]);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue;
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value) && value.length === 0) continue;
    out[key] = inline(value, trail);
  }
  return out;
}

const operation = (node) => (node && typeof node.$ref === "string" ? resolve(node.$ref) : node);

/** GET routes that end in a path parameter: where a task's status is read. */
const taskRoutes = Object.entries(spec.paths)
  .filter(([path, item]) => item.get && /\/\{[^}]+\}$/.test(path))
  .map(([path]) => path.replace(/\/\{[^}]+\}$/, ""));

/**
 * The route a task made at `path` is polled on: its own, or its family's
 * (kling-v3-pro and kling-v3-std are both read at video/kling-v3, and the
 * turbo video upscaler at video-upscaler). The family is the longest status
 * route the path extends by a whole segment or a "-suffix".
 */
function pollRoute(path) {
  if (taskRoutes.includes(path)) return path;
  const families = taskRoutes
    .filter((base) => path.startsWith(base) && /^[-/]/.test(path.slice(base.length)) && base.length > PREFIX.length)
    .sort((a, b) => b.length - a.length);
  return families[0] ?? null;
}

const endpoints = [];
for (const [path, item] of Object.entries(spec.paths)) {
  if (!path.startsWith(PREFIX) || !item.post) continue;
  const post = item.post;
  const content = operation(post.requestBody)?.content ?? {};
  const contentType = Object.keys(content)[0] ?? null;
  const poll = pollRoute(path);
  endpoints.push({
    id: path.slice(PREFIX.length),
    summary: post.summary ?? "",
    description: (post.description ?? "").trim(),
    ...(post.deprecated ? { deprecated: true } : {}),
    ...(contentType && contentType !== "application/json" ? { contentType } : {}),
    poll: poll ? poll.slice(PREFIX.length) : null,
    schema: contentType ? inline(content[contentType].schema ?? {}) : null,
  });
}
endpoints.sort((a, b) => a.id.localeCompare(b.id));

// One endpoint per line, so a later sync shows as the endpoints that changed.
const lines = endpoints.map((endpoint) => JSON.stringify(endpoint));
const header = JSON.stringify({ source: SOURCE, version: spec.info?.version ?? null });
writeFileSync(OUT, `${header.slice(0, -1)},"endpoints":[\n${lines.join(",\n")}\n]}\n`);

const polled = endpoints.filter((endpoint) => endpoint.poll).length;
console.log(`${endpoints.length} endpoints under ${PREFIX} (${polled} with a status route) written to ${OUT}`);
console.log("\nCheck: npx vitest run src/lib/providers/magnific");
