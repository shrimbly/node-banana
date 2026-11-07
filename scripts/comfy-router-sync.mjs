#!/usr/bin/env node
/**
 * Fetch every Comfy Router model schema, and report coverage.
 *
 *   npm run comfy:router-sync
 *
 * Downloads each published schema (docs.comfy.org/router-schemas/…, public,
 * no key) into .scratch/comfy-router-schemas, where the schema suite
 * (src/lib/providers/comfyRouter/__tests__/routerSchemas.test.ts) validates
 * every bound model's request against it. Then lists Router models that
 * are neither bound in families.json nor listed under "excluded": those
 * are new since the last sync and need a family, or an exclusion reason.
 *
 * With COMFY_API_KEY set, the model list comes from the Router itself
 * (GET /v2/models); otherwise from the docs index. The key also fetches a
 * schema the docs have not published yet from the Router
 * (GET /v2/models/{id}/openapi.json), as the app does at run time.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const OUT = join(ROOT, ".scratch/comfy-router-schemas");
const DOCS = "https://docs.comfy.org";

async function liveIds(key) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = `https://api.comfy.org/v2/models?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: { "X-API-Key": key } });
    if (!res.ok) throw new Error(`GET /v2/models ${res.status}`);
    const body = await res.json();
    ids.push(...body.data.map((m) => m.id));
    cursor = body.next_cursor;
    if (!body.has_more || !cursor) break;
  }
  return ids;
}

async function docIds() {
  const text = await (await fetch(`${DOCS}/llms.txt`)).text();
  return [...new Set([...text.matchAll(/\/router-schemas\/([^)\s]+)\.json/g)].map((m) => m[1]))];
}

const key = process.env.COMFY_API_KEY;
const ids = key ? await liveIds(key) : await docIds();
console.log(`${ids.length} Router models (${key ? "live list" : "docs index"})`);

mkdirSync(OUT, { recursive: true });
let failed = 0;
const queue = [...ids];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        let res = await fetch(`${DOCS}/router-schemas/${id}.json`);
        if (res.status === 404 && key) {
          res = await fetch(`https://api.comfy.org/v2/models/${id}/openapi.json`, { headers: { "X-API-Key": key } });
        }
        if (!res.ok) throw new Error(String(res.status));
        writeFileSync(join(OUT, `${id.replace("/", "__")}.json`), await res.text());
      } catch (error) {
        failed += 1;
        console.warn(`  could not fetch ${id}: ${error.message}`);
      }
    }
  })
);
console.log(`schemas written to ${OUT}${failed ? ` (${failed} failed)` : ""}`);

const catalog = JSON.parse(readFileSync(join(ROOT, "src/lib/providers/comfyRouter/families.json"), "utf8"));
const bound = new Set(catalog.families.flatMap((family) => family.models.map((model) => model.id)));
const excluded = new Set(Object.keys(catalog.excluded));
const unknown = ids.filter((id) => !bound.has(id) && !excluded.has(id));
const retired = [...bound].filter((id) => !ids.includes(id));
console.log(`bound ${bound.size}, excluded ${excluded.size}, new ${unknown.length}, retired ${retired.length}`);
for (const id of unknown) console.log(`  new: ${id}`);
for (const id of retired) console.log(`  no longer served: ${id}`);
console.log("\nValidate: npx vitest run src/lib/providers/comfyRouter/__tests__/routerSchemas.test.ts");
