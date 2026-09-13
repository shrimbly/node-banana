import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { mockReaddir } = vi.hoisted(() => ({ mockReaddir: vi.fn() }));
vi.mock("fs/promises", () => ({ readdir: mockReaddir }));

import { GET } from "../route";

const request = (path: string | null) =>
  ({ nextUrl: { searchParams: new URLSearchParams(path === null ? "" : { path }) } }) as unknown as NextRequest;

describe("GET /api/list-generations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists media files by id, ignoring extensions and other files", async () => {
    mockReaddir.mockResolvedValue(["a.png", "b.MP4", "notes.txt", "c.webp", ".DS_Store"]);
    const data = await (await GET(request("/proj/generations"))).json();
    expect(data).toEqual({ success: true, ids: ["a", "b", "c"] });
  });

  it("lists nothing for a folder that does not exist", async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    const data = await (await GET(request("/proj/generations"))).json();
    expect(data).toEqual({ success: true, ids: [] });
  });

  it("reports any other failure so the caller keeps its history", async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    const response = await GET(request("/proj/generations"));
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
  });

  it("rejects a missing or relative path", async () => {
    expect((await GET(request(null))).status).toBe(400);
    expect((await GET(request("relative/generations"))).status).toBe(400);
    expect(mockReaddir).not.toHaveBeenCalled();
  });
});
