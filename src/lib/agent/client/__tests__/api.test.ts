import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAgentStatus, startAgentSignIn } from "../api";

function respond(body: unknown, init: ResponseInit = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  // A fresh Response per call: a body can only be read once.
  return vi.fn().mockImplementation(async () => new Response(text, { status: 200, ...init }));
}

describe("agent client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches every harness, or one", async () => {
    const fetchMock = respond({ harnesses: [{ id: "claude" }] });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentStatus()).resolves.toEqual({ harnesses: [{ id: "claude" }] });
    await fetchAgentStatus("codex");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/status");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/agent/status?harness=codex");
  });

  it("tolerates a body without harnesses", async () => {
    vi.stubGlobal("fetch", respond({}));
    await expect(fetchAgentStatus()).resolves.toEqual({ harnesses: [] });
  });

  it("explains a failed status check with the server's reason", async () => {
    vi.stubGlobal("fetch", respond({ error: "Cross-site request refused" }, { status: 403, statusText: "Forbidden" }));
    await expect(fetchAgentStatus()).rejects.toThrow("Couldn't check the agent status: Cross-site request refused");

    vi.stubGlobal("fetch", respond("", { status: 502, statusText: "Bad Gateway" }));
    await expect(fetchAgentStatus()).rejects.toThrow("Couldn't check the agent status: 502 Bad Gateway");
  });

  it("posts the harness to start sign-in", async () => {
    const fetchMock = respond({ state: "pending", url: "https://auth.openai.com/oauth/authorize?x=1" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(startAgentSignIn("codex")).resolves.toEqual({ state: "pending", url: "https://auth.openai.com/oauth/authorize?x=1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/agent/sign-in");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ harness: "codex" });
  });

  it("sends force only when asked", async () => {
    const fetchMock = respond({ state: "pending" });
    vi.stubGlobal("fetch", fetchMock);

    await startAgentSignIn("claude", { force: true });
    await startAgentSignIn("claude", { force: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ harness: "claude", force: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ harness: "claude" });
  });

  it("passes the route's own failure message through", async () => {
    vi.stubGlobal(
      "fetch",
      respond(
        { state: "failed", message: "Could not start the Codex sign-in: app-server exited" },
        { status: 500, statusText: "Server Error" },
      ),
    );
    await expect(startAgentSignIn("codex")).resolves.toEqual({
      state: "failed",
      message: "Could not start the Codex sign-in: app-server exited",
    });
  });

  it("turns a failed sign-in request into a failed attempt", async () => {
    vi.stubGlobal("fetch", respond("codex app-server is not running", { status: 500, statusText: "Server Error" }));
    await expect(startAgentSignIn("codex")).resolves.toEqual({
      state: "failed",
      message: "Couldn't start sign-in: codex app-server is not running",
    });
  });
});
