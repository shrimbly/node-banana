// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentHarnessId } from "../../types";
import { AsyncQueue } from "../asyncQueue";
import { getHarness } from "../harnesses";
import { isHarnessReady } from "../billing";

describe("getHarness", () => {
  it("returns one harness per id", () => {
    const claude = getHarness("claude");
    expect(claude).toMatchObject({ id: "claude", label: "Claude Code" });
    expect(getHarness("claude")).toBe(claude);
    expect(getHarness("codex")).toMatchObject({ id: "codex", label: "Codex" });
  });

  it("rejects unknown ids", () => {
    expect(() => getHarness("gemini" as AgentHarnessId)).toThrow(/Unknown agent harness/);
  });
});

describe("isHarnessReady", () => {
  it("needs installed, signed in and subscription billing", () => {
    expect(isHarnessReady({ installed: true, signedIn: true, billing: "subscription" })).toBe(true);
    expect(isHarnessReady({ installed: true, signedIn: true, billing: "api" })).toBe(false);
    expect(isHarnessReady({ installed: true, signedIn: false, billing: "subscription" })).toBe(false);
    expect(isHarnessReady({ installed: false, signedIn: true, billing: "subscription" })).toBe(false);
  });
});

describe("AsyncQueue", () => {
  it("yields pushed items in order, waiting for more, until ended", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const item of queue) seen.push(item);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    queue.push(2);
    queue.push(3);
    queue.end();
    queue.push(4);
    await reading;
    expect(seen).toEqual([1, 2, 3]);
    expect(queue.isEnded).toBe(true);
  });
});
