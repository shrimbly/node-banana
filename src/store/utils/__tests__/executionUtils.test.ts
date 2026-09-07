import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  groupNodesByLevel,
  chunk,
  runNodesWithConcurrency,
  revokeBlobUrl,
  clearNodeImageRefs,
  loadConcurrencySetting,
  saveConcurrencySetting,
  DEFAULT_MAX_CONCURRENT_CALLS,
  CONCURRENCY_SETTINGS_KEY,
} from "../executionUtils";
import type { WorkflowNode, WorkflowEdge } from "@/types";

function makeNode(id: string, type = "prompt"): WorkflowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {},
  } as WorkflowNode;
}

function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: "text",
    targetHandle: "text",
  } as WorkflowEdge;
}

describe("groupNodesByLevel", () => {
  it("should put all nodes at level 0 when there are no edges", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const result = groupNodesByLevel(nodes, []);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe(0);
    expect(result[0].nodeIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("should handle a linear chain", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const result = groupNodesByLevel(nodes, edges);
    expect(result).toHaveLength(3);
    expect(result[0].nodeIds).toEqual(["a"]);
    expect(result[1].nodeIds).toEqual(["b"]);
    expect(result[2].nodeIds).toEqual(["c"]);
  });

  it("should group parallel nodes at the same level", () => {
    // a -> b, a -> c (b and c are parallel)
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];
    const result = groupNodesByLevel(nodes, edges);
    expect(result).toHaveLength(2);
    expect(result[0].nodeIds).toEqual(["a"]);
    expect(result[1].nodeIds.sort()).toEqual(["b", "c"]);
  });

  it("should handle diamond dependencies", () => {
    // a -> b, a -> c, b -> d, c -> d
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [
      makeEdge("a", "b"),
      makeEdge("a", "c"),
      makeEdge("b", "d"),
      makeEdge("c", "d"),
    ];
    const result = groupNodesByLevel(nodes, edges);
    expect(result).toHaveLength(3);
    expect(result[0].nodeIds).toEqual(["a"]);
    expect(result[1].nodeIds.sort()).toEqual(["b", "c"]);
    expect(result[2].nodeIds).toEqual(["d"]);
  });

  it("should handle empty inputs", () => {
    const result = groupNodesByLevel([], []);
    expect(result).toEqual([]);
  });
});

describe("chunk", () => {
  it("should split array into chunks of specified size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("should handle array smaller than chunk size", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("should handle empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("should handle chunk size of 1", () => {
    expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("should handle exact multiples", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("should throw on size 0", () => {
    expect(() => chunk([1, 2], 0)).toThrow("Invalid chunk size: must be a positive integer");
  });

  it("should throw on negative size", () => {
    expect(() => chunk([1, 2], -1)).toThrow("Invalid chunk size: must be a positive integer");
  });

  it("should throw on NaN size", () => {
    expect(() => chunk([1, 2], NaN)).toThrow("Invalid chunk size: must be a positive integer");
  });

  it("should throw on Infinity size", () => {
    expect(() => chunk([1, 2], Infinity)).toThrow("Invalid chunk size: must be a positive integer");
  });
});

describe("revokeBlobUrl", () => {
  it("should revoke blob URLs", () => {
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revokeBlobUrl("blob:http://localhost/abc");
    expect(spy).toHaveBeenCalledWith("blob:http://localhost/abc");
    spy.mockRestore();
  });

  it("should not revoke non-blob URLs", () => {
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revokeBlobUrl("http://example.com/image.png");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should handle null", () => {
    expect(() => revokeBlobUrl(null)).not.toThrow();
  });

  it("should handle undefined", () => {
    expect(() => revokeBlobUrl(undefined)).not.toThrow();
  });
});

describe("clearNodeImageRefs", () => {
  it("keeps live video and model blobs readable when preparing Save As", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const nodes = [
        {
          ...makeNode("video", "videoTrim"),
          data: { outputVideo: "blob:http://localhost/video", outputVideoRef: "old/video.mp4" },
        },
        {
          ...makeNode("model", "glbViewer"),
          data: { glbUrl: "blob:http://localhost/model", glbUrlRef: "old/model.glb" },
        },
      ] as unknown as WorkflowNode[];

      const result = clearNodeImageRefs(nodes);

      expect(result[0].data).toEqual({ outputVideo: "blob:http://localhost/video" });
      expect(result[1].data).toEqual({ glbUrl: "blob:http://localhost/model" });
      // Externalization still needs to read these URLs after the refs are cleared.
      expect(revoke).not.toHaveBeenCalled();
      expect(nodes[0].data).toHaveProperty("outputVideoRef", "old/video.mp4");
    } finally {
      revoke.mockRestore();
    }
  });

  it("should clear imageRef fields", () => {
    const nodes = [
      {
        ...makeNode("a"),
        data: {
          imageRef: "some-ref",
          sourceImageRef: "src-ref",
          outputImageRef: "out-ref",
          inputImageRefs: ["ref1"],
          prompt: "keep this",
        },
      },
    ] as unknown as WorkflowNode[];

    const result = clearNodeImageRefs(nodes);
    const data = result[0].data as Record<string, unknown>;
    expect(data.imageRef).toBeUndefined();
    expect(data.sourceImageRef).toBeUndefined();
    expect(data.outputImageRef).toBeUndefined();
    expect(data.inputImageRefs).toBeUndefined();
    expect(data.prompt).toBe("keep this");
  });

  it("should not mutate original nodes", () => {
    const original = [
      {
        ...makeNode("a"),
        data: { imageRef: "ref" },
      },
    ] as unknown as WorkflowNode[];

    clearNodeImageRefs(original);
    expect((original[0].data as Record<string, unknown>).imageRef).toBe("ref");
  });
});

describe("concurrency settings", () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => { mockStorage[key] = value; },
    });
  });

  it("should return default when no setting stored", () => {
    expect(loadConcurrencySetting()).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
  });

  it("should load stored setting", () => {
    mockStorage[CONCURRENCY_SETTINGS_KEY] = "5";
    expect(loadConcurrencySetting()).toBe(5);
  });

  it("should reject out-of-range values", () => {
    mockStorage[CONCURRENCY_SETTINGS_KEY] = "0";
    expect(loadConcurrencySetting()).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    mockStorage[CONCURRENCY_SETTINGS_KEY] = "11";
    expect(loadConcurrencySetting()).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
  });

  it("should reject invalid values", () => {
    mockStorage[CONCURRENCY_SETTINGS_KEY] = "abc";
    expect(loadConcurrencySetting()).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
  });

  it("should save setting", () => {
    saveConcurrencySetting(7);
    expect(mockStorage[CONCURRENCY_SETTINGS_KEY]).toBe("7");
  });
});

describe("runNodesWithConcurrency", () => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: unknown) => void;
  }
  function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Flush pending microtasks so the scheduler advances between assertions.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  interface Harness {
    promise: Promise<void>;
    started: string[];
    finished: string[];
    peak: number;
    ac: AbortController;
  }

  function run(opts: {
    levels: { level: number; nodeIds: string[] }[];
    edges: { source: string; target: string }[];
    maxConcurrent: number;
    runners: Record<string, () => Promise<void>>;
    isRunning?: () => boolean;
  }): Harness {
    const nodes = new Map(
      Object.keys(opts.runners).map((id) => [id, makeNode(id)] as const)
    );
    const running = new Set<string>();
    const h: Harness = {
      promise: Promise.resolve(),
      started: [],
      finished: [],
      peak: 0,
      ac: new AbortController(),
    };
    h.promise = runNodesWithConcurrency({
      levels: opts.levels,
      startLevel: 0,
      edges: opts.edges,
      maxConcurrent: opts.maxConcurrent,
      signal: h.ac.signal,
      isRunning: opts.isRunning ?? (() => true),
      getNode: (id) => nodes.get(id),
      setCurrentNodeIds: () => {},
      runNode: async (node) => {
        h.started.push(node.id);
        running.add(node.id);
        h.peak = Math.max(h.peak, running.size);
        try {
          await opts.runners[node.id]();
        } finally {
          running.delete(node.id);
          h.finished.push(node.id);
        }
      },
      abort: () => h.ac.abort(),
    });
    return h;
  }

  it("respects dependencies: a node waits for its direct upstream", async () => {
    const d = { a: deferred(), b: deferred(), c: deferred() };
    const h = run({
      levels: [
        { level: 0, nodeIds: ["a"] },
        { level: 1, nodeIds: ["b"] },
        { level: 2, nodeIds: ["c"] },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      maxConcurrent: 4,
      runners: { a: () => d.a.promise, b: () => d.b.promise, c: () => d.c.promise },
    });

    await tick();
    expect(h.started).toEqual(["a"]);
    d.a.resolve();
    await tick();
    expect(h.started).toEqual(["a", "b"]);
    d.b.resolve();
    await tick();
    expect(h.started).toEqual(["a", "b", "c"]);
    d.c.resolve();
    await h.promise;
    expect(h.finished).toEqual(["a", "b", "c"]);
  });

  it("does not cross-block independent branches (the core fix)", async () => {
    // a->b and c->d are independent chains. d must be able to start as soon as c
    // finishes, without waiting for the slow a in the same level.
    const d = { a: deferred(), b: deferred(), c: deferred(), dd: deferred() };
    const h = run({
      levels: [
        { level: 0, nodeIds: ["a", "c"] },
        { level: 1, nodeIds: ["b", "dd"] },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "c", target: "dd" },
      ],
      maxConcurrent: 4,
      runners: {
        a: () => d.a.promise,
        b: () => d.b.promise,
        c: () => d.c.promise,
        dd: () => d.dd.promise,
      },
    });

    await tick();
    expect(h.started).toEqual(expect.arrayContaining(["a", "c"]));

    // c finishes while a is still running -> dd starts, b does NOT (a pending)
    d.c.resolve();
    await tick();
    expect(h.started).toContain("dd");
    expect(h.started).not.toContain("b");

    d.a.resolve();
    await tick();
    expect(h.started).toContain("b");

    d.b.resolve();
    d.dd.resolve();
    await h.promise;
    expect(h.finished.sort()).toEqual(["a", "b", "c", "dd"]);
  });

  it("never exceeds the concurrency limit", async () => {
    const d = { a: deferred(), b: deferred(), c: deferred(), e: deferred() };
    const h = run({
      levels: [{ level: 0, nodeIds: ["a", "b", "c", "e"] }],
      edges: [],
      maxConcurrent: 2,
      runners: {
        a: () => d.a.promise,
        b: () => d.b.promise,
        c: () => d.c.promise,
        e: () => d.e.promise,
      },
    });

    await tick();
    expect(h.started).toHaveLength(2);
    expect(h.peak).toBe(2);

    d.a.resolve();
    d.b.resolve();
    await tick();
    expect(h.started).toHaveLength(4);
    expect(h.peak).toBe(2);

    d.c.resolve();
    d.e.resolve();
    await h.promise;
    expect(h.finished).toHaveLength(4);
  });

  it("fails fast: a rejecting node aborts and downstream never starts", async () => {
    const h = run({
      levels: [
        { level: 0, nodeIds: ["a"] },
        { level: 1, nodeIds: ["b"] },
      ],
      edges: [{ source: "a", target: "b" }],
      maxConcurrent: 2,
      runners: {
        a: () => Promise.reject(new Error("boom")),
        b: () => Promise.resolve(),
      },
    });

    await expect(h.promise).rejects.toThrow("boom");
    expect(h.started).toEqual(["a"]);
    expect(h.ac.signal.aborted).toBe(true);
  });

  it("stops launching new nodes when isRunning() becomes false (pause)", async () => {
    let running = true;
    const h = run({
      levels: [
        { level: 0, nodeIds: ["a"] },
        { level: 1, nodeIds: ["b"] },
      ],
      edges: [{ source: "a", target: "b" }],
      maxConcurrent: 2,
      isRunning: () => running,
      runners: {
        a: async () => {
          running = false; // simulate a pause edge stopping the run
        },
        b: () => Promise.resolve(),
      },
    });

    await h.promise; // resolves (not rejects) on cooperative stop
    expect(h.started).toEqual(["a"]);
  });
});
