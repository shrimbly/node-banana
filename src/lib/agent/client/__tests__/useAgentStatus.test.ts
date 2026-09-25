import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentHarnessStatus } from "../../types";
import { useAgentStatus } from "../useAgentStatus";

function status(id: "claude" | "codex", overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    installed: true,
    signedIn: false,
    billing: "none",
    models: [],
    signIn: { state: "idle" },
    signInCommand: id === "claude" ? "claude auth login" : "codex login",
    ...overrides,
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** Lets queued promise callbacks (fetch → json → setState) run. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useAgentStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url: string) =>
      url.includes("harness=claude")
        ? json({ harnesses: [status("claude", { signIn: { state: "pending" } })] })
        : json({ harnesses: [status("claude"), status("codex")] }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing while inactive", async () => {
    renderHook(() => useAgentStatus({ active: false }));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every harness when it becomes active", async () => {
    const { result, rerender } = renderHook(({ active }) => useAgentStatus({ active }), {
      initialProps: { active: false },
    });
    rerender({ active: true });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith("/api/agent/status", expect.anything());
    expect(Object.keys(result.current.statuses).sort()).toEqual(["claude", "codex"]);
    expect(result.current.checkedAt.claude).toBeTypeOf("number");
    expect(result.current.error).toBeNull();
  });

  it("polls only the signing-in harness, every interval, and stops when told", async () => {
    const { result, rerender } = renderHook(
      ({ pollHarness }) => useAgentStatus({ active: true, pollHarness, intervalMs: 2000 }),
      { initialProps: { pollHarness: "claude" as "claude" | null } },
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/agent/status?harness=claude");
    expect(result.current.statuses.claude?.signIn.state).toBe("pending");
    // The other harness keeps its earlier answer.
    expect(result.current.statuses.codex).toBeDefined();

    rerender({ pollHarness: null });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling when the panel closes", async () => {
    const { rerender } = renderHook(({ active }) => useAgentStatus({ active, pollHarness: "claude" }), {
      initialProps: { active: true },
    });
    await flush();
    rerender({ active: false });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never stacks polls while a check is still running", async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ harnesses: [status("claude")] }));
          if (!url.includes("harness=")) release();
        }),
    );
    renderHook(() => useAgentStatus({ active: true, pollHarness: "claude", intervalMs: 2000 }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    // One initial check plus one poll that has not answered yet.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release();
    await flush();
  });

  it("keeps the last statuses and reports the error when a check fails", async () => {
    const { result } = renderHook(() => useAgentStatus({ active: true }));
    await flush();
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Internal Server Error" }));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("Couldn't check the agent status: boom");
    expect(result.current.statuses.claude).toBeDefined();
  });

  it("does not let an older answer overwrite a newer one", async () => {
    const { result } = renderHook(() => useAgentStatus({ active: false }));
    let resolveSlow: (response: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveSlow = resolve)))
      .mockImplementationOnce(async () =>
        json({ harnesses: [status("claude", { signedIn: true, billing: "subscription" })] }),
      );

    let slow: Promise<void> = Promise.resolve();
    await act(async () => {
      slow = result.current.refresh();
      vi.advanceTimersByTime(5);
      await result.current.refresh();
    });
    expect(result.current.statuses.claude?.signedIn).toBe(true);

    await act(async () => {
      resolveSlow(json({ harnesses: [status("claude")] }));
      await slow;
    });
    expect(result.current.statuses.claude?.signedIn).toBe(true);
  });
});
