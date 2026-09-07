// @vitest-environment node
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { writeFile, rename } = vi.hoisted(() => ({ writeFile: vi.fn(), rename: vi.fn() }));
vi.mock("fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs/promises")>(),
  writeFile,
  rename,
}));
vi.mock("@/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "../route";

const fs = await vi.importActual<typeof import("fs/promises")>("fs/promises");
const previous = JSON.stringify({ version: 1, nodes: [{ id: "last-good-save" }], edges: [] });
const updated = { version: 1, nodes: [{ id: "new-save" }], edges: [] };
let directory: string;
let destination: string;

function save() {
  return POST(new NextRequest("http://localhost:3000/api/workflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directoryPath: directory, filename: "workflow", workflow: updated }),
  }));
}

describe("atomic workflow saves on disk", () => {
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "node-banana-workflow-save-"));
    destination = join(directory, "workflow.json");
    await fs.writeFile(destination, previous);
    writeFile.mockImplementation(fs.writeFile);
    rename.mockImplementation(fs.rename);
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("replaces the previous save only after the new file is complete", async () => {
    rename.mockImplementation(async (source, target) => {
      expect(await fs.readFile(destination, "utf8")).toBe(previous);
      expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual(updated);
      await fs.rename(source, target);
    });
    expect((await save()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(updated);
    expect((await fs.readdir(directory)).sort()).toEqual(["generations", "inputs", "workflow.json"]);
  });

  it("preserves the previous workflow after a partially written file hits disk full", async () => {
    writeFile.mockImplementation(async (file) => {
      await fs.writeFile(file, '{"version":');
      throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
    });
    expect((await save()).status).toBe(500);
    expect(await fs.readFile(destination, "utf8")).toBe(previous);
    expect((await fs.readdir(directory)).sort()).toEqual(["generations", "inputs", "workflow.json"]);
  });

  it("preserves the previous workflow and cleans up if replacement fails", async () => {
    rename.mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
    expect((await save()).status).toBe(500);
    expect(await fs.readFile(destination, "utf8")).toBe(previous);
    expect((await fs.readdir(directory)).sort()).toEqual(["generations", "inputs", "workflow.json"]);
  });
});
