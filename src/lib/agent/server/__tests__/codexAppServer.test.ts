// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_LOCKDOWN_CONFIG,
  codexAppServerArgs,
  CodexAppServer,
  CodexRpcError,
  getCodexAppServer,
  parseCodexVersion,
  type CodexNotification,
} from "../codexAppServer";
import { FakeAppServer, type FakeHandler } from "./fakeAppServer";

function serverWith(handlers: Record<string, FakeHandler> = {}) {
  const children: FakeAppServer[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeAppServer(handlers);
    children.push(child);
    return child;
  });
  const server = new CodexAppServer({
    bin: "/opt/codex",
    env: { HOME: "/Users/user" },
    spawn,
    makeWorkDir: async () => "/tmp/nb-codex-test",
    requestTimeoutMs: 2_000,
  });
  return { server, spawn, children };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("codexAppServerArgs", () => {
  const args = codexAppServerArgs();

  it("runs app-server with every lockdown override as -c", () => {
    expect(args[0]).toBe("app-server");
    const overrides = args.slice(1).filter((_, index) => index % 2 === 1);
    expect(args.slice(1).filter((_, index) => index % 2 === 0).every((flag) => flag === "-c")).toBe(true);
    expect(overrides).toEqual([...CODEX_LOCKDOWN_CONFIG]);
  });

  it("switches off shell, sub-agents, web, plugins and the notify hook, and pins the OpenAI provider", () => {
    for (const expected of [
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.multi_agent=false",
      "features.plugins=false",
      "features.apps=false",
      "features.memories=false",
      "features.hooks=false",
      "features.view_image=false",
      'web_search="disabled"',
      "project_doc_max_bytes=0",
      "tools.experimental_request_user_input.enabled=false",
      "notify=[]",
      'model_provider="openai"',
      "thread_unload_delay_secs=60",
    ]) {
      expect(CODEX_LOCKDOWN_CONFIG).toContain(expected);
    }
  });

  it("never sets forced_login_method (it can log the user out) or anything about API keys", () => {
    expect(CODEX_LOCKDOWN_CONFIG.some((override) => /forced_login_method|api_key|apikey|env_key/i.test(override))).toBe(false);
  });
});

describe("CodexAppServer", () => {
  it("initializes as node_banana with the experimental API, then reads the user's MCP servers", async () => {
    const { server, spawn, children } = serverWith();
    await server.start();
    expect(spawn).toHaveBeenCalledWith("/opt/codex", codexAppServerArgs(), { env: { HOME: "/Users/user" } });
    const [child] = children;
    expect(child.received.map((line) => line.method)).toEqual(["initialize", "initialized", "config/read"]);
    expect(child.received[0].params).toEqual({
      clientInfo: { name: "node_banana", title: "Node Banana", version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(server.info).toMatchObject({ version: "0.157.0", codexHome: "/Users/user/.codex" });
    expect(server.userMcpServers).toEqual(["node_repl", "computer-use"]);
    expect(server.modelProvider).toBeNull();
    expect(server.workDir).toBe("/tmp/nb-codex-test");
    expect(server.generation).toBe(1);
    expect(server.running).toBe(true);
  });

  it("re-reads the user's MCP servers on request: exactly what config.toml lists now", async () => {
    let reads = 0;
    const { server } = serverWith({
      "config/read": () => ({ config: { mcp_servers: ++reads === 1 ? { a: {}, gone: {} } : { a: {}, late: {} } } }),
    });
    await server.start();
    expect(server.userMcpServers).toEqual(["a", "gone"]);
    // A server no longer in the file must not be disabled: thread/start rejects it ("invalid transport").
    expect(await server.refreshUserMcpServers()).toEqual(["a", "late"]);
  });

  it("sends requestIfRunning only to the live child of that generation, never starting one", async () => {
    const { server, spawn, children } = serverWith();
    expect(await server.requestIfRunning("turn/interrupt", {})).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    await server.start();
    await expect(server.requestIfRunning("account/read", {}, 1_000, server.generation)).resolves.toMatchObject({ account: { type: "chatgpt" } });
    expect(await server.requestIfRunning("account/read", {}, 1_000, server.generation + 1)).toBeUndefined();
    children[0].exit(1);
    expect(await server.requestIfRunning("account/read", {})).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("shares one start between concurrent callers", async () => {
    const { server, spawn } = serverWith();
    await Promise.all([server.start(), server.start(), server.request("account/read", {})]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("resolves results and rejects JSON-RPC errors", async () => {
    const { server } = serverWith({ "thread/start": () => { throw new Error("bad model"); } });
    await expect(server.request("account/read", { refreshToken: false })).resolves.toMatchObject({ account: { type: "chatgpt" } });
    const failure = server.request("thread/start", {});
    await expect(failure).rejects.toBeInstanceOf(CodexRpcError);
    await expect(failure).rejects.toThrow("thread/start: bad model");
  });

  it("delivers notifications to listeners until they unsubscribe", async () => {
    const { server, children } = serverWith();
    await server.start();
    const seen: CodexNotification[] = [];
    const off = server.onNotification((notification) => seen.push(notification));
    children[0].notify("turn/started", { threadId: "t" });
    await tick();
    off();
    children[0].notify("turn/completed", { threadId: "t" });
    await tick();
    expect(seen).toEqual([{ method: "turn/started", params: { threadId: "t" } }]);
  });

  it("answers server requests through registered handlers", async () => {
    const { server, children } = serverWith();
    server.setRequestHandler("item/tool/call", async (params) => ({
      contentItems: [{ type: "inputText", text: `got ${JSON.stringify(params)}` }],
      success: true,
    }));
    await server.start();
    const answer = await children[0].request("item/tool/call", { tool: "x" });
    expect(answer.result).toEqual({ contentItems: [{ type: "inputText", text: 'got {"tool":"x"}' }], success: true });
  });

  it("refuses approvals and every other unhandled server request", async () => {
    const { server, children } = serverWith();
    await server.start();
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
      "item/tool/requestUserInput",
      "account/chatgptAuthTokens/refresh",
    ]) {
      const answer = await children[0].request(method, {});
      expect(answer.result).toBeUndefined();
      expect(answer.error).toMatchObject({ code: -32601 });
    }
  });

  it("returns a handler's failure as a JSON-RPC error", async () => {
    const { server, children } = serverWith();
    server.setRequestHandler("item/tool/call", async () => {
      throw new Error("no runtime");
    });
    await server.start();
    const answer = await children[0].request("item/tool/call", {});
    expect(answer.error).toEqual({ code: -32603, message: "no runtime" });
  });

  it("rejects pending requests on exit, tells listeners, and restarts on the next request", async () => {
    const { server, children, spawn } = serverWith({ "turn/start": () => new Promise(() => {}) });
    await server.start();
    const exits: string[] = [];
    server.onExit((reason) => exits.push(reason));
    const pending = server.request("turn/start", {});
    await tick();
    children[0].stderr.write("panic: something\n");
    await tick();
    children[0].exit(101);
    await expect(pending).rejects.toThrow(/exited \(code 101\): panic: something/);
    expect(exits).toHaveLength(1);
    expect(server.running).toBe(false);

    await server.request("account/read", {});
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(server.generation).toBe(2);
  });

  it("fails start() when initialize fails, and kills the child", async () => {
    const { server, children } = serverWith({ initialize: () => { throw new Error("unsupported client"); } });
    await expect(server.start()).rejects.toThrow("initialize: unsupported client");
    expect(children[0].exited).toBe(true);
    expect(server.running).toBe(false);
  });

  it("times out a request the server never answers", async () => {
    const { server } = serverWith({ "model/list": () => new Promise(() => {}) });
    await server.start();
    await expect(server.request("model/list", {}, 20)).rejects.toThrow(/didn't answer model\/list/);
  });

  it("stop() ends the child", async () => {
    const { server, children } = serverWith();
    await server.start();
    server.stop();
    expect(children[0].exited).toBe(true);
    expect(server.running).toBe(false);
  });
});

describe("parseCodexVersion", () => {
  it("reads Codex's version from the user agent", () => {
    expect(parseCodexVersion("node_banana/0.157.0 (Mac OS 26.6.0; arm64) unknown (node_banana; 1.10.0)")).toBe("0.157.0");
    expect(parseCodexVersion("garbage")).toBeUndefined();
  });
});

describe("getCodexAppServer", () => {
  it("keeps one server per binary", () => {
    const first = getCodexAppServer("/opt/codex-a", {});
    expect(getCodexAppServer("/opt/codex-a", {})).toBe(first);
    const second = getCodexAppServer("/opt/codex-b", {});
    expect(second).not.toBe(first);
    expect(second.bin).toBe("/opt/codex-b");
  });
});
