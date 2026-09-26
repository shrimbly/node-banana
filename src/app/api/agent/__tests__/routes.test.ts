// @vitest-environment node
/**
 * The agent routes end to end over real Request/Response objects, with the
 * harness registry, prompt builders and tool runtime replaced by fakes.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_LOCAL_HEADER, AGENT_LOCAL_SECRET_ENV } from "@/lib/agent/server/sameOrigin";

import type {
  AgentHarness,
  AgentHarnessId,
  AgentHarnessStatus,
  AgentSignInStart,
  AgentStatusResponse,
  HarnessEvent,
  HarnessTurnParams,
} from "@/lib/agent/types";

const { getHarness } = vi.hoisted(() => ({ getHarness: vi.fn() }));

vi.mock("@/lib/agent/server/harnesses", () => ({ getHarness }));
vi.mock("@/lib/agent/prompt", () => ({
  buildAgentSystemPrompt: () => "SYSTEM",
  buildTurnPrompt: ({ userText }: { userText: string }) => `<user>${userText}</user>`,
}));
vi.mock("@/lib/agent/tools/runtime", () => ({
  createAgentToolRuntime: () => ({ definitions: [], execute: vi.fn() }),
}));
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { POST: chatPOST } = await import("../chat/route");
const { GET: statusGET } = await import("../status/route");
const { POST: signInPOST } = await import("../sign-in/route");
const { AGENT_CHAT_MAX_BODY_BYTES, AGENT_SIGN_IN_MAX_BODY_BYTES } = await import("../shared");

const LABELS: Record<AgentHarnessId, string> = { claude: "Claude Code", codex: "Codex" };

function status(id: AgentHarnessId, overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id,
    label: LABELS[id],
    installed: true,
    signedIn: true,
    billing: "subscription",
    models: [{ id: id === "claude" ? "sonnet" : "gpt-5.6-luna", label: "Default", isDefault: true }],
    signIn: { state: "idle" },
    signInCommand: id === "claude" ? "claude auth login" : "codex login",
    ...overrides,
  };
}

function fakeHarness(id: AgentHarnessId, events: HarnessEvent[] = []) {
  const turns: HarnessTurnParams[] = [];
  const harness: AgentHarness = {
    id,
    label: LABELS[id],
    getStatus: vi.fn(async () => status(id)),
    startSignIn: vi.fn(async (): Promise<AgentSignInStart> => ({ state: "pending", message: "Finish signing in in your browser." })),
    async *runTurn(params) {
      turns.push(params);
      for (const event of events) yield event;
    },
  };
  return { harness, turns };
}

/** What server.js stamps on a loopback connection. */
const LOCAL_SECRET = "f".repeat(64);

/** Node Banana's page, over a loopback connection server.js stamped. */
const SAME_ORIGIN = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  [AGENT_LOCAL_HEADER]: LOCAL_SECRET,
};
const CROSS_SITE = {
  host: "localhost:3000",
  origin: "https://evil.example",
  "sec-fetch-site": "cross-site",
  "content-type": "application/json",
  [AGENT_LOCAL_HEADER]: LOCAL_SECRET,
};
/** curl on another machine: the owner's LAN address as Host, no browser headers. */
const LAN_CURL = { host: "192.168.4.22:3000", "content-type": "application/json" };
/** Another machine copying the page's headers and claiming to be localhost: no stamp from the server. */
const LAN_FORGED = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-forwarded-for": "127.0.0.1",
};
/** curl on this machine: no browser headers, no stamp from the server. */
const LOCAL_CURL = { host: "localhost:3000", "content-type": "application/json", "x-forwarded-for": "::1" };
/**
 * A request the app's own server makes to 127.0.0.1 (a route fetching a URL it
 * was given): loopback, so stamped, but with none of a browser page's headers.
 */
const SERVER_SIDE_FETCH = {
  host: "127.0.0.1:3000",
  accept: "*/*",
  "sec-fetch-mode": "cors",
  "user-agent": "node",
  "content-type": "application/json",
  [AGENT_LOCAL_HEADER]: LOCAL_SECRET,
};

function post(path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN, signal?: AbortSignal) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function get(path: string, headers: Record<string, string> = SAME_ORIGIN) {
  return new NextRequest(`http://localhost:3000${path}`, { method: "GET", headers });
}

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  id: `route-chat-${Math.random().toString(36).slice(2)}`,
  trigger: "submit-message",
  harness: "claude",
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "add a prompt node" }] }],
  workflow: { nodes: [], edges: [], groups: [], selectedNodeIds: [] },
  ...overrides,
});

/** The SSE body as its JSON events, `[DONE]` excluded. */
async function sseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  return text
    .split("\n\n")
    .map((event) => event.replace(/^data: /, "").trim())
    .filter((event) => event && event !== "[DONE]")
    .map((event) => JSON.parse(event));
}

/** A body that streams without a Content-Length, and records how much of it was pulled. */
function endlessBody(chunkBytes = 64 * 1024) {
  const seen = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

function postStream(path: string, stream: ReadableStream<Uint8Array>) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: SAME_ORIGIN,
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  getHarness.mockReset();
  // server.js sets this at startup; the tests for a server that doesn't vouch delete it.
  process.env[AGENT_LOCAL_SECRET_ENV] = LOCAL_SECRET;
});

afterEach(() => {
  delete process.env[AGENT_LOCAL_SECRET_ENV];
});

describe("POST /api/agent/chat", () => {
  it("streams the turn as an AI SDK UI message stream", async () => {
    const { harness, turns } = fakeHarness("claude", [
      { type: "session", sessionId: "s-1" },
      { type: "text-delta", id: "t1", delta: "Hello" },
      { type: "text-end", id: "t1" },
    ]);
    getHarness.mockReturnValue(harness);

    const response = await chatPOST(post("/api/agent/chat", chatBody()));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const events = await sseEvents(response);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "data-agent-status",
      "data-agent-session",
      "data-agent-status",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(getHarness).toHaveBeenCalledWith("claude");
    expect(turns[0]).toMatchObject({ prompt: "<user>add a prompt node</user>", history: [] });
    // The prompt builder's text, then which model the turn runs on.
    expect(turns[0].systemPrompt).toMatch(/^SYSTEM\n\nYou are running on .+\. Say so if asked which model you are\.$/);
  });

  it("hands the request's abort signal to the harness", async () => {
    const controller = new AbortController();
    const { harness, turns } = fakeHarness("claude");
    getHarness.mockReturnValue(harness);

    const response = await chatPOST(post("/api/agent/chat", chatBody(), SAME_ORIGIN, controller.signal));
    await response.text();
    controller.abort();

    expect(turns[0].signal.aborted).toBe(true);
  });

  it("answers a not-ready harness inside the stream, without starting a turn", async () => {
    const { harness, turns } = fakeHarness("codex");
    vi.mocked(harness.getStatus).mockResolvedValue(
      status("codex", { signedIn: false, billing: "none", problem: "Sign in to Codex with ChatGPT." })
    );
    getHarness.mockReturnValue(harness);

    const response = await chatPOST(post("/api/agent/chat", chatBody({ harness: "codex" })));
    const events = await sseEvents(response);

    expect(turns).toHaveLength(0);
    expect(events).toContainEqual({
      type: "data-agent-notice",
      data: { code: "not_signed_in", message: "Sign in to Codex with ChatGPT.", harness: "codex" },
    });
  });

  it("refuses a cross-site request before touching the harness", async () => {
    const response = await chatPOST(post("/api/agent/chat", chatBody(), CROSS_SITE));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("cross-site");
    expect(getHarness).not.toHaveBeenCalled();
  });

  it.each([
    ["curl from another machine", LAN_CURL],
    ["another machine claiming Host: localhost", LAN_FORGED],
    ["a script on this machine the server did not vouch for", LOCAL_CURL],
    ["the app's own server-side fetch to 127.0.0.1 (stamped, but not from a page)", SERVER_SIDE_FETCH],
  ])("refuses %s before touching the harness", async (_label, headers) => {
    const response = await chatPOST(post("/api/agent/chat", chatBody(), headers));

    expect(response.status).toBe(403);
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("refuses every localhost request on a server that can't stamp them (plain next start)", async () => {
    delete process.env[AGENT_LOCAL_SECRET_ENV];

    const response = await chatPOST(post("/api/agent/chat", chatBody(), LAN_FORGED));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("npm start");
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("refuses a body declared over the limit with a 413, unread and before touching the harness", async () => {
    const { stream, seen } = endlessBody();
    const request = new NextRequest("http://localhost:3000/api/agent/chat", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-length": String(AGENT_CHAT_MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);

    const response = await chatPOST(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Invalid agent request: the body is over the 2 MB limit. Start a new chat to continue.");
    expect(seen.pulled).toBeLessThanOrEqual(64 * 1024 * 2); // at most what the stream buffered on its own
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("stops reading a body that streams past the limit, and answers 413", async () => {
    const { stream, seen } = endlessBody();

    const response = await chatPOST(postStream("/api/agent/chat", stream));

    expect(response.status).toBe(413);
    expect(seen.pulled).toBeLessThan(AGENT_CHAT_MAX_BODY_BYTES + 3 * 64 * 1024);
    await vi.waitFor(() => expect(seen.cancelled).toBe(true));
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("accepts a body just under the limit", async () => {
    const { harness } = fakeHarness("claude");
    getHarness.mockReturnValue(harness);
    const body = JSON.stringify(chatBody());
    const padded = body.slice(0, -1) + `,"padding":"${" ".repeat(AGENT_CHAT_MAX_BODY_BYTES - body.length - 20)}"}`;
    expect(Buffer.byteLength(padded)).toBeLessThanOrEqual(AGENT_CHAT_MAX_BODY_BYTES);

    const response = await chatPOST(post("/api/agent/chat", padded));

    expect(response.status).toBe(200);
    await response.text();
  });

  it("answers a body that is not JSON with a plain-text 400", async () => {
    const response = await chatPOST(post("/api/agent/chat", "{not json"));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Invalid agent request: the body is not JSON.");
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("answers a malformed body with a 400 naming the problem", async () => {
    const response = await chatPOST(post("/api/agent/chat", chatBody({ harness: "gemini", workflow: undefined })));

    expect(response.status).toBe(400);
    const message = await response.text();
    expect(message).toContain("harness:");
    expect(message).toContain("workflow:");
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("answers with a 500 when the harness cannot be created", async () => {
    getHarness.mockImplementation(() => {
      throw new Error("module failed to load");
    });

    const response = await chatPOST(post("/api/agent/chat", chatBody()));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Claude Code is not available: module failed to load");
  });
});

describe("GET /api/agent/status", () => {
  it("reports every harness", async () => {
    getHarness.mockImplementation((id: AgentHarnessId) => fakeHarness(id).harness);

    const response = await statusGET(get("/api/agent/status"));
    const body = (await response.json()) as AgentStatusResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.harnesses.map((entry) => entry.id)).toEqual(["claude", "codex"]);
  });

  it("reports one harness when asked", async () => {
    getHarness.mockImplementation((id: AgentHarnessId) => fakeHarness(id).harness);

    const body = (await (await statusGET(get("/api/agent/status?harness=codex"))).json()) as AgentStatusResponse;

    expect(body.harnesses).toEqual([status("codex")]);
    expect(getHarness).toHaveBeenCalledTimes(1);
  });

  it("reports a harness whose check failed as not ready, with the reason", async () => {
    getHarness.mockImplementation((id: AgentHarnessId) => {
      const { harness } = fakeHarness(id);
      if (id === "claude") vi.mocked(harness.getStatus).mockRejectedValue(new Error("spawn claude ENOENT"));
      return harness;
    });

    const body = (await (await statusGET(get("/api/agent/status"))).json()) as AgentStatusResponse;

    expect(body.harnesses[0]).toMatchObject({
      id: "claude",
      label: "Claude Code",
      installed: false,
      signedIn: false,
      billing: "unknown",
      problem: "Could not check Claude Code: spawn claude ENOENT",
      signInCommand: "claude auth login",
    });
    expect(body.harnesses[1]).toEqual(status("codex"));
  });

  it("leaves the account email out unless the server vouched for a loopback connection", async () => {
    getHarness.mockImplementation((id: AgentHarnessId) => {
      const { harness } = fakeHarness(id);
      vi.mocked(harness.getStatus).mockResolvedValue(
        status(id, { account: { email: "owner@example.com", plan: id === "claude" ? "Max" : "Pro" } })
      );
      return harness;
    });

    // Another machine on a host the owner listed in NB_AGENT_ALLOWED_HOSTS: no stamp, so no email.
    process.env.NB_AGENT_ALLOWED_HOSTS = "studio.lan";
    try {
      const lan = new NextRequest("http://studio.lan:3000/api/agent/status", {
        method: "GET",
        headers: { host: "studio.lan:3000", "sec-fetch-site": "same-origin", "x-forwarded-for": "192.168.4.30" },
      });
      const plain = (await (await statusGET(lan)).json()) as AgentStatusResponse;
      expect(plain.harnesses.map((entry) => entry.account)).toEqual([{ plan: "Max" }, { plan: "Pro" }]);
    } finally {
      delete process.env.NB_AGENT_ALLOWED_HOSTS;
    }

    const vouched = (await (await statusGET(get("/api/agent/status"))).json()) as AgentStatusResponse;
    expect(vouched.harnesses[0].account).toEqual({ email: "owner@example.com", plan: "Max" });

    // A wrong stamp means another machine: refused outright.
    const forged = await statusGET(get("/api/agent/status", { ...SAME_ORIGIN, [AGENT_LOCAL_HEADER]: "0".repeat(64) }));
    expect(forged.status).toBe(403);
  });

  it.each([
    ["curl from another machine", LAN_CURL],
    ["another machine claiming Host: localhost", LAN_FORGED],
    ["the app's own server-side fetch to 127.0.0.1 (save-generation handed this URL)", SERVER_SIDE_FETCH],
  ])("refuses %s, so the owner's account is not read", async (_label, headers) => {
    const response = await statusGET(get("/api/agent/status", headers));

    expect(response.status).toBe(403);
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("rejects an unknown harness", async () => {
    const response = await statusGET(get("/api/agent/status?harness=gemini"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Unknown agent harness "gemini". Use one of: claude, codex.');
  });

  it("refuses a cross-site request", async () => {
    const response = await statusGET(get("/api/agent/status", CROSS_SITE));

    expect(response.status).toBe(403);
    expect(getHarness).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/sign-in", () => {
  it("starts the harness's own sign-in flow", async () => {
    const { harness } = fakeHarness("claude");
    getHarness.mockReturnValue(harness);

    const response = await signInPOST(post("/api/agent/sign-in", { harness: "claude" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "pending", message: "Finish signing in in your browser." });
    expect(harness.startSignIn).toHaveBeenCalledOnce();
    // No force unless asked: a harness that reads as ready answers already_signed_in.
    expect(harness.startSignIn).toHaveBeenCalledWith({});
  });

  it("passes force through, for a sign-in after a turn the vendor rejected", async () => {
    const { harness } = fakeHarness("codex");
    getHarness.mockReturnValue(harness);

    const response = await signInPOST(post("/api/agent/sign-in", { harness: "codex", force: true }));

    expect(response.status).toBe(200);
    expect(harness.startSignIn).toHaveBeenCalledWith({ force: true });
  });

  it("treats force: false as no force", async () => {
    const { harness } = fakeHarness("claude");
    getHarness.mockReturnValue(harness);

    await signInPOST(post("/api/agent/sign-in", { harness: "claude", force: false }));

    expect(harness.startSignIn).toHaveBeenCalledWith({});
  });

  it("answers a failure to start as a failed sign-in", async () => {
    const { harness } = fakeHarness("codex");
    vi.mocked(harness.startSignIn).mockRejectedValue(new Error("app-server exited"));
    getHarness.mockReturnValue(harness);

    const response = await signInPOST(post("/api/agent/sign-in", { harness: "codex" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      state: "failed",
      message: "Could not start the Codex sign-in: app-server exited",
    });
  });

  it.each([
    ["not JSON", "harness=claude", "Invalid sign-in request: the body is not JSON."],
    ["missing the harness", {}, "Invalid sign-in request: Unknown agent harness undefined. Use one of: claude, codex."],
    ["for an unknown harness", { harness: "gemini" }, 'Invalid sign-in request: Unknown agent harness "gemini". Use one of: claude, codex.'],
    ["that is an array", [{ harness: "claude" }], "Invalid sign-in request: Unknown agent harness undefined. Use one of: claude, codex."],
    ["with a non-boolean force", { harness: "claude", force: "yes" }, "Invalid sign-in request: force must be true or false."],
    ["with force: 1", { harness: "codex", force: 1 }, "Invalid sign-in request: force must be true or false."],
  ])("rejects a body %s", async (_label, body, message) => {
    const response = await signInPOST(post("/api/agent/sign-in", body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ state: "failed", message });
    expect(getHarness).not.toHaveBeenCalled();
  });

  it.each([
    ["curl from another machine", LAN_CURL],
    ["another machine claiming Host: localhost", LAN_FORGED],
  ])("refuses %s, so no one else can start or read a sign-in", async (_label, headers) => {
    const response = await signInPOST(post("/api/agent/sign-in", { harness: "codex" }, headers));

    expect(response.status).toBe(403);
    expect((await response.json()).state).toBe("failed");
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("refuses a body over its small limit with a 413", async () => {
    const { stream } = endlessBody(4 * 1024);

    const response = await signInPOST(postStream("/api/agent/sign-in", stream));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      state: "failed",
      message: `Invalid sign-in request: the body is over the ${AGENT_SIGN_IN_MAX_BODY_BYTES / 1024} KB limit.`,
    });
    expect(getHarness).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request, so no other site can open a sign-in", async () => {
    const response = await signInPOST(post("/api/agent/sign-in", { harness: "claude" }, CROSS_SITE));

    expect(response.status).toBe(403);
    expect((await response.json()).state).toBe("failed");
    expect(getHarness).not.toHaveBeenCalled();
  });
});
