// @vitest-environment node
import path from "path";
import { describe, expect, it } from "vitest";
import type { AssetRecord } from "../../types";
import {
  libraryFileName,
  librarySnippet,
  localDay,
  localTime,
  mediaTypeForExt,
  mediaTypeForMime,
  normaliseProjectDir,
  normaliseTags,
  projectFileName,
  scrubRecord,
  validatePatch,
  validateRecordMeta,
} from "../validate";

const SHA = "a".repeat(64);
const MD5 = "b".repeat(32);

function baseRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    v: 1,
    id: "a0000000000001",
    kind: "image",
    origin: "generated",
    mime: "image/png",
    ext: "png",
    bytes: 10,
    sha256: SHA,
    md5: MD5,
    file: { root: "library", rel: "Generations/2026-09-27/x.png" },
    filename: "x.png",
    createdAt: Date.now(),
    producer: { nodeId: "n1", nodeType: "nanoBanana" },
    workflowId: "wf_1",
    workflowName: null,
    runId: "r0000000000001",
    tags: [],
    favorite: false,
    ...overrides,
  };
}

describe("file names", () => {
  it("builds project names exactly like /api/save-generation", () => {
    expect(projectFileName("A red fox, jumping!", MD5, "png")).toBe(`a_red_fox_jumping_${MD5}.png`);
    expect(projectFileName(undefined, MD5, "mp4")).toBe(`generation_${MD5}.mp4`);
    expect(projectFileName("!!!", MD5, "png")).toBe(`generation_${MD5}.png`);
    expect(projectFileName("x".repeat(80), MD5, "png")).toBe(`${"x".repeat(30)}_${MD5}.png`);
  });

  it("builds library names that sort by time in a day folder", () => {
    const at = new Date(2026, 8, 27, 9, 5, 7).getTime();
    const meta = { prompt: "Neon Tokyo street at night", producer: { nodeId: "n", nodeType: "t" }, kind: "image" as const, createdAt: at };
    expect(localDay(at)).toBe("2026-09-27");
    expect(localTime(at)).toBe("090507");
    expect(libraryFileName(meta, SHA, "png")).toBe(`090507_neon_tokyo_street_at_night_${SHA.slice(0, 8)}.png`);
  });

  it("falls back to the operation, then the kind", () => {
    const producer = { nodeId: "n", nodeType: "t", operation: "removeBackground" };
    expect(librarySnippet({ prompt: "", producer, kind: "image" })).toBe("removebackground");
    expect(librarySnippet({ producer: { nodeId: "n", nodeType: "t" }, kind: "video" })).toBe("video");
  });
});

describe("media types", () => {
  it("maps MIME aliases and picks containers by kind", () => {
    expect(mediaTypeForMime("audio/mp3")?.ext).toBe("mp3");
    expect(mediaTypeForMime("image/jpeg; charset=binary")?.ext).toBe("jpg");
    expect(mediaTypeForMime("application/x-evil")).toBeNull();
    expect(mediaTypeForExt("webm", "audio")?.mime).toBe("audio/webm");
    expect(mediaTypeForExt("webm", "video")?.mime).toBe("video/webm");
    expect(mediaTypeForExt("jpeg")?.ext).toBe("jpg");
    expect(mediaTypeForExt("exe")).toBeNull();
  });
});

describe("normaliseProjectDir", () => {
  it("fixes mixed separators on Windows and refuses '..' and relative paths", () => {
    expect(normaliseProjectDir("C:\\p/x/", "win32")).toBe("C:\\p\\x");
    expect(() => normaliseProjectDir("C:\\p\\..\\x", "win32")).toThrow(/\.\./);
    expect(() => normaliseProjectDir("relative/dir", "linux")).toThrow(/absolute/);
    expect(normaliseProjectDir("/a/./b/", "linux")).toBe(path.posix.resolve("/a/b"));
  });
});

describe("tags", () => {
  it("trims, collapses and de-duplicates case-insensitively", () => {
    expect(normaliseTags(["  Hero ", "hero", "cover  art", "", 3, "data:x"])).toEqual(["Hero", "cover art"]);
  });
});

describe("scrubRecord", () => {
  it("drops inline media, clips long strings and keeps the sidecar under 64 KB", () => {
    const record = scrubRecord(
      baseRecord({
        prompt: "p".repeat(40_000),
        parameters: {
          image: "data:image/png;base64,AAAA",
          nested: { blob: "blob:http://x/1", keep: "ok", long: "l".repeat(5000) },
          list: ["data:x", "fine"],
        },
      }),
    );
    expect(record.prompt!.length).toBe(16 * 1024);
    expect(record.parameters).toEqual({ nested: { keep: "ok", long: "l".repeat(2048) }, list: ["fine"] });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(64 * 1024);
  });

  it("drops parameters when they would push the sidecar over 64 KB", () => {
    const parameters = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(1000)]));
    const record = scrubRecord(baseRecord({ parameters }));
    expect(record.parameters).toBeUndefined();
  });
});

describe("validateRecordMeta", () => {
  const valid = {
    id: "a0000000000001",
    kind: "image",
    origin: "generated",
    createdAt: Date.now(),
    producer: { nodeId: "n1", nodeType: "nanoBanana" },
    workflowId: "wf_123_abc",
    workflowName: "My flow",
    runId: "r0000000000001",
  };

  it("accepts a well-formed meta", () => {
    expect(validateRecordMeta({ ...valid, width: 10, height: 20, tags: ["a"] })).toMatchObject({ id: valid.id, width: 10, tags: ["a"] });
  });

  it("rejects ids that could reach a path", () => {
    expect(() => validateRecordMeta({ ...valid, id: "../../etc" })).toThrow(/asset id/);
    expect(() => validateRecordMeta({ ...valid, runId: "r/../x" })).toThrow(/run id/);
    expect(() => validateRecordMeta({ ...valid, workflowId: "a/b" })).toThrow(/workflow id/);
  });

  it("clamps an implausible createdAt to now", () => {
    const now = Date.now();
    expect(validateRecordMeta({ ...valid, createdAt: 5 }, now).createdAt).toBe(now);
  });

  it("takes an upload, and the display name it is recorded under, trimmed; an empty name is none", () => {
    expect(validateRecordMeta({ ...valid, kind: "video", origin: "uploaded", name: " sunset.mp4 " })).toMatchObject({
      origin: "uploaded",
      name: "sunset.mp4",
    });
    expect(validateRecordMeta({ ...valid, name: "   " })).not.toHaveProperty("name");
    expect(validateRecordMeta({ ...valid, name: null })).not.toHaveProperty("name");
  });

  it("refuses a display name that a rename could not set", () => {
    expect(() => validateRecordMeta({ ...valid, name: 4 })).toThrow("name must be a string");
    expect(() => validateRecordMeta({ ...valid, name: "x".repeat(121) })).toThrow("name is longer than 120 characters");
    expect(() => validateRecordMeta({ ...valid, name: "a\u2028b" })).toThrow("name must be one line");
    expect(() => validateRecordMeta({ ...valid, origin: "found" })).toThrow("Invalid origin");
  });

  it("keeps a batch tag that holds up and drops one that does not", () => {
    const batch = { id: "batch-1", index: 3, count: 10 };
    expect(validateRecordMeta({ ...valid, batch }).batch).toEqual(batch);
    expect(validateRecordMeta({ ...valid, batch: { ...batch, index: 11 } }).batch).toBeUndefined();
    expect(validateRecordMeta({ ...valid, batch: { ...batch, index: 0 } }).batch).toBeUndefined();
    expect(validateRecordMeta({ ...valid, batch: { ...batch, count: 2.5 } }).batch).toBeUndefined();
    expect(validateRecordMeta({ ...valid, batch: { index: 1, count: 2 } }).batch).toBeUndefined();
    expect(validateRecordMeta({ ...valid, batch: "batch-1" }).batch).toBeUndefined();
  });
});

describe("validatePatch", () => {
  it("keeps a display name trimmed, and an empty one as the request to clear it", () => {
    expect(validatePatch({ name: " Sunset " })).toEqual({ name: "Sunset" });
    expect(validatePatch({ name: "" })).toEqual({ name: "" });
    expect(validatePatch({ name: "x".repeat(120), favorite: true })).toEqual({ name: "x".repeat(120), favorite: true });
  });

  it("refuses a display name that is not a string, too long or more than one line", () => {
    for (const [name, message] of [
      [3, /^name must be a string$/],
      ["x".repeat(121), /^name is longer than 120 characters$/],
      ["Sun\nset", /^name must be one line$/],
      ["Sun\u2029set", /^name must be one line$/],
    ] as const) {
      expect(() => validatePatch({ name })).toThrow(expect.objectContaining({ status: 400, code: "bad_request", message: expect.stringMatching(message) }));
    }
  });
});

describe("scrubRecord name", () => {
  it("keeps a display name a rename could have set, trimmed, and drops any other", () => {
    expect(scrubRecord(baseRecord({ name: " Sunset " })).name).toBe("Sunset");
    expect("name" in scrubRecord(baseRecord({ name: "" }))).toBe(false);
    expect("name" in scrubRecord(baseRecord({ name: "Sun\nset" }))).toBe(false);
    expect("name" in scrubRecord(baseRecord({ name: "x".repeat(121) }))).toBe(false);
    expect("name" in scrubRecord(baseRecord({ name: 7 as unknown as string }))).toBe(false);
  });
});

describe("scrubRecord batch", () => {
  it("keeps a sound batch tag and removes a broken one", () => {
    expect(scrubRecord(baseRecord({ batch: { id: "b", index: 1, count: 2 } })).batch).toEqual({ id: "b", index: 1, count: 2 });
    expect("batch" in scrubRecord(baseRecord({ batch: { id: "b", index: 4, count: 2 } }))).toBe(false);
  });
});
