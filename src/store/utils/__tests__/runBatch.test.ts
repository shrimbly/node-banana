import { describe, it, expect, vi } from "vitest";
import { MAX_RUN_COUNT, batchTag, clampRunCount, runBatchLoop, type RunOutcome } from "../runBatch";

const ok: RunOutcome = { started: true, failed: false };

describe("clampRunCount", () => {
  it("keeps whole numbers from 1 to the maximum", () => {
    expect(clampRunCount(1)).toBe(1);
    expect(clampRunCount(10)).toBe(10);
    expect(clampRunCount(MAX_RUN_COUNT)).toBe(MAX_RUN_COUNT);
  });

  it("clamps and rounds everything else", () => {
    expect(clampRunCount(0)).toBe(1);
    expect(clampRunCount(-4)).toBe(1);
    expect(clampRunCount(999)).toBe(MAX_RUN_COUNT);
    expect(clampRunCount(2.6)).toBe(3);
    expect(clampRunCount("4")).toBe(4);
    expect(clampRunCount("lots")).toBe(1);
    expect(clampRunCount(undefined)).toBe(1);
    expect(clampRunCount(Number.NaN)).toBe(1);
  });
});

describe("batchTag", () => {
  it("drops the store's stopping flag", () => {
    expect(batchTag({ id: "b", index: 2, count: 5, stopping: true })).toEqual({ id: "b", index: 2, count: 5 });
    expect(batchTag(null)).toBeUndefined();
  });
});

describe("runBatchLoop", () => {
  it("runs count times, setting each run's index first", async () => {
    const indexes: number[] = [];
    let current = 0;
    const runOnce = vi.fn(async () => {
      indexes.push(current);
      return ok;
    });
    const completed = await runBatchLoop({ count: 4, setIndex: (i) => (current = i), runOnce, keepGoing: () => true });
    expect(completed).toBe(4);
    expect(indexes).toEqual([1, 2, 3, 4]);
  });

  it("stops after the run in which keepGoing turns false", async () => {
    let runs = 0;
    const completed = await runBatchLoop({
      count: 10,
      setIndex: () => {},
      runOnce: async () => {
        runs++;
        return ok;
      },
      keepGoing: () => runs < 3,
    });
    expect(runs).toBe(3);
    expect(completed).toBe(3);
  });

  it("stops at the first failed run", async () => {
    let runs = 0;
    const completed = await runBatchLoop({
      count: 10,
      setIndex: () => {},
      runOnce: async () => {
        runs++;
        return { started: true, failed: runs === 2 };
      },
      keepGoing: () => true,
    });
    expect(runs).toBe(2);
    expect(completed).toBe(2);
  });

  it("goes on past failed runs it tolerates, and stops after too many in a row", async () => {
    const outcomes = [true, false, true, true, false, true, true, true, false];
    let runs = 0;
    const completed = await runBatchLoop({
      count: outcomes.length,
      setIndex: () => {},
      runOnce: async () => ({ started: true, failed: outcomes[runs++]! }),
      keepGoing: () => true,
      toleratedFailures: 2,
    });
    // Runs 1, 3, 4 fail with successes between; 6, 7, 8 are three in a row
    expect(completed).toBe(8);
  });

  it("stops when a run never started, without counting it", async () => {
    const completed = await runBatchLoop({
      count: 5,
      setIndex: () => {},
      runOnce: async () => ({ started: false, failed: false }),
      keepGoing: () => true,
    });
    expect(completed).toBe(0);
  });
});
