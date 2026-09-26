// @vitest-environment node
/**
 * The chat stream bridge, driven by a scripted fake harness and a fake tool
 * runtime. Each test reads the stream twice: the raw chunks (transient data
 * parts only exist there) and the final message `useChat` would hold.
 */

import { readUIMessageStream } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/utils/logger";
import type { ProviderKeys } from "@/lib/providers/keys";
import type { ProviderModel } from "@/lib/providers/types";
import { createAgentToolRuntime } from "../../tools/runtime";
import type { ModelSource } from "../../tools/modelSearch";
import {
  createAgentChatStream,
  harnessNotReady,
  MAX_ACTIVE_TURNS,
  parseAgentChatRequest,
  pickTurnEffort,
  pickTurnModel,
  readConversation,
  type AgentChatStreamOptions,
  type AgentUIMessageChunk,
} from "../chatStream";
import type {
  AgentChatRequestBody,
  AgentGraphOpBatch,
  AgentHarness,
  AgentHarnessStatus,
  AgentToolDefinition,
  AgentToolResult,
  AgentToolRuntime,
  AgentUIMessage,
  AgentWorkflowSnapshot,
  HarnessEvent,
  HarnessTurnParams,
} from "../../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function readyStatus(overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id: "claude",
    label: "Claude Code",
    installed: true,
    version: "2.1.0",
    signedIn: true,
    billing: "subscription",
    account: { email: "someone@example.com", plan: "max" },
    models: [
      { id: "sonnet", label: "Sonnet", isDefault: true },
      { id: "haiku", label: "Haiku" },
    ],
    signIn: { state: "idle" },
    signInCommand: "claude auth login",
    ...overrides,
  };
}

type TurnScript = (params: HarnessTurnParams) => AsyncIterable<HarnessEvent>;

function fakeHarness(script: TurnScript, status: AgentHarnessStatus | (() => Promise<AgentHarnessStatus>) = readyStatus()) {
  const turns: HarnessTurnParams[] = [];
  const harness: AgentHarness = {
    id: "claude",
    label: "Claude Code",
    getStatus: vi.fn(typeof status === "function" ? status : async () => status),
    startSignIn: vi.fn(async () => ({ state: "pending" as const })),
    runTurn: (params) => {
      turns.push(params);
      return script(params);
    },
  };
  return { harness, turns };
}

async function* emit(...events: HarnessEvent[]): AsyncGenerator<HarnessEvent> {
  for (const event of events) yield event;
}

const definitions: AgentToolDefinition[] = [
  { name: "get_workflow", title: "Read workflow", description: "Read the canvas.", inputShape: {}, readOnly: true },
  { name: "edit_workflow", title: "Edit workflow", description: "Change the canvas.", inputShape: {}, readOnly: false },
];

function fakeRuntime(results: Record<string, AgentToolResult | Error>) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const runtime: AgentToolRuntime = {
    definitions,
    async execute(name, args) {
      calls.push({ name, args });
      const result = results[name];
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`fake runtime has no result for ${name}`);
      return result;
    },
  };
  return { runtime, calls };
}

const addPromptResult: AgentToolResult = {
  ok: true,
  text: "Added prompt-ag1 (Prompt).",
  summary: "Added 1 node",
  ops: [{ op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: { prompt: "a cat" } }],
  focusNodeIds: ["prompt-ag1"],
};

const emptyWorkflow: AgentWorkflowSnapshot = { nodes: [], edges: [], groups: [], selectedNodeIds: [] };

function userMessage(text: string, id = `u-${text.length}`): AgentUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

let chatCounter = 0;

function requestBody(overrides: Partial<AgentChatRequestBody> = {}): AgentChatRequestBody {
  return {
    id: `chat-${++chatCounter}`,
    harness: "claude",
    messages: [userMessage("add a prompt node")],
    workflow: emptyWorkflow,
    ...overrides,
  };
}

interface RunResult {
  chunks: AgentUIMessageChunk[];
  message: AgentUIMessage;
}

/**
 * Every chunk as the browser receives it: serialised, so nothing downstream
 * (readUIMessageStream keeps data chunks as parts and mutates them) can
 * change what the test saw on the wire.
 */
async function readChunks(stream: ReadableStream<AgentUIMessageChunk>): Promise<AgentUIMessageChunk[]> {
  const chunks: AgentUIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(JSON.parse(JSON.stringify(value)));
  }
}

async function collect(stream: ReadableStream<AgentUIMessageChunk>): Promise<RunResult> {
  const chunks = await readChunks(stream);
  const replay = new ReadableStream<AgentUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(structuredClone(chunk));
      controller.close();
    },
  });
  let message: AgentUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<AgentUIMessage>({ stream: replay })) message = snapshot;
  if (!message) throw new Error("the stream produced no message");
  return { chunks, message };
}

function streamFor(options: Partial<AgentChatStreamOptions> & Pick<AgentChatStreamOptions, "harness">) {
  return createAgentChatStream({
    body: requestBody(),
    signal: new AbortController().signal,
    createToolRuntime: () => fakeRuntime({}).runtime,
    buildSystemPrompt: ({ harness }) => `SYSTEM for ${harness}`,
    buildTurnPrompt: ({ userText, snapshot }) => `<canvas nodes=${snapshot.nodes.length}/>\n<user>${userText}</user>`,
    ...options,
  });
}

const run = (options: Partial<AgentChatStreamOptions> & Pick<AgentChatStreamOptions, "harness">) =>
  collect(streamFor(options));

const types = (chunks: AgentUIMessageChunk[]) => chunks.map((chunk) => chunk.type);

function chunksOfType<T extends AgentUIMessageChunk["type"]>(chunks: AgentUIMessageChunk[], type: T) {
  return chunks.filter((chunk): chunk is Extract<AgentUIMessageChunk, { type: T }> => chunk.type === type);
}

function statusLines(chunks: AgentUIMessageChunk[]): string[] {
  return chunksOfType(chunks, "data-agent-status").map((chunk) => chunk.data.text);
}

function partsOfType<T extends AgentUIMessage["parts"][number]["type"]>(message: AgentUIMessage, type: T) {
  return message.parts.filter(
    (part): part is Extract<AgentUIMessage["parts"][number], { type: T }> => part.type === type
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Text and reasoning
// ---------------------------------------------------------------------------

describe("createAgentChatStream: text and reasoning", () => {
  it("streams reasoning and text parts between start and finish", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "reasoning-delta", id: "r1", delta: "The user wants " },
        { type: "reasoning-delta", id: "r1", delta: "a prompt node." },
        { type: "reasoning-end", id: "r1" },
        { type: "text-delta", id: "t1", delta: "Adding a " },
        { type: "text-delta", id: "t1", delta: "prompt node." },
        { type: "text-end", id: "t1" }
      )
    );

    const { chunks, message } = await run({ harness });

    expect(types(chunks)).toEqual([
      "start",
      "data-agent-status",
      "data-agent-status",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(statusLines(chunks)).toEqual(["Starting Claude Code…", ""]);
    expect(message.parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "The user wants a prompt node.", state: "done" }),
      expect.objectContaining({ type: "text", text: "Adding a prompt node.", state: "done" }),
    ]);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop", messageMetadata: { harness: "claude", model: "sonnet", modelLabel: "Sonnet" } });
    expect(message.metadata).toEqual({ harness: "claude", model: "sonnet", modelLabel: "Sonnet" });
  });

  it("reports the model the panel picked, and passes it to the harness", async () => {
    const { harness, turns } = fakeHarness(() => emit({ type: "text-delta", id: "t", delta: "ok" }));

    const { chunks, message } = await run({ harness, body: requestBody({ model: "haiku" }) });

    expect(chunks[0]).toMatchObject({ type: "start", messageMetadata: { harness: "claude", model: "haiku" } });
    expect(message.metadata).toEqual({ harness: "claude", model: "haiku", modelLabel: "Haiku" });
    expect(turns[0].model).toBe("haiku");
  });

  it("leaves the model to the harness when the panel did not pick one", async () => {
    const { harness, turns } = fakeHarness(() => emit({ type: "text-delta", id: "t", delta: "ok" }));

    await run({ harness });

    expect(turns[0]).not.toHaveProperty("model");
  });

  it("never hands the CLI a model the harness does not offer, and runs its default instead", async () => {
    const { harness, turns } = fakeHarness(() => emit({ type: "text-delta", id: "t", delta: "ok" }));

    for (const model of ["opus-9-unreleased", "--dangerously-skip-permissions", "sonnet --print"]) {
      const { chunks, message } = await run({ harness, body: requestBody({ model }) });

      expect(turns.at(-1), model).not.toHaveProperty("model");
      expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", messageMetadata: { model: "sonnet" } });
      expect(message.metadata).toEqual({ harness: "claude", model: "sonnet", modelLabel: "Sonnet" });
    }
  });

  it("skips empty deltas instead of opening empty parts", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "reasoning-delta", id: "r1", delta: "" },
        { type: "reasoning-end", id: "r1" },
        { type: "text-delta", id: "t1", delta: "" },
        { type: "text-delta", id: "t1", delta: "Hi" },
        { type: "text-end", id: "t1" }
      )
    );

    const { chunks, message } = await run({ harness });

    expect(types(chunks)).not.toContain("reasoning-start");
    expect(message.parts).toEqual([expect.objectContaining({ type: "text", text: "Hi" })]);
  });

  it("closes parts the harness never ended, and ignores ends it never started", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "text-end", id: "never-started" },
        { type: "reasoning-delta", id: "r1", delta: "thinking" },
        { type: "text-delta", id: "t1", delta: "unfinished" }
      )
    );

    const { chunks, message } = await run({ harness });

    expect(chunksOfType(chunks, "text-end")).toHaveLength(1);
    expect(chunksOfType(chunks, "reasoning-end")).toHaveLength(1);
    expect(message.parts.map((part) => ("state" in part ? part.state : undefined))).toEqual(["done", "done"]);
  });

  it("keeps separate text blocks in separate parts", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "text-delta", id: "a", delta: "First." },
        { type: "text-delta", id: "b", delta: "Second." },
        { type: "text-delta", id: "a", delta: " More first." },
        { type: "text-end", id: "a" },
        { type: "text-end", id: "b" }
      )
    );

    const { message } = await run({ harness });

    expect(partsOfType(message, "text").map((part) => part.text)).toEqual(["First. More first.", "Second."]);
  });
});

// ---------------------------------------------------------------------------
// Turn inputs
// ---------------------------------------------------------------------------

describe("createAgentChatStream: what the harness is given", () => {
  it("passes history, the turn prompt, the system prompt, the session and the signal", async () => {
    const { harness, turns } = fakeHarness(() => emit({ type: "text-delta", id: "t", delta: "ok" }));
    const controller = new AbortController();
    const body = requestBody({
      sessionId: "session-9",
      workflow: { ...emptyWorkflow, nodes: [{ id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, width: 320, height: 220, data: {} }] },
      messages: [
        userMessage("make a cat workflow", "u1"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Added a prompt." },
            {
              type: "dynamic-tool",
              toolName: "edit_workflow",
              toolCallId: "call_1",
              state: "output-available",
              input: {},
              output: { ok: true, summary: "Added 1 node" },
            },
            { type: "data-agent-notice", data: { code: "usage_limit", message: "slow down", harness: "claude" } },
            { type: "text", text: "Press Run when ready." },
          ],
        },
        { id: "a2", role: "assistant", parts: [{ type: "data-agent-notice", data: { code: "not_signed_in", message: "sign in", harness: "claude" } }] },
        userMessage("now make it a dog", "u2"),
      ],
    });

    await run({ harness, body, signal: controller.signal });

    expect(turns).toHaveLength(1);
    const params = turns[0];
    expect(params.history).toEqual([
      { role: "user", text: "make a cat workflow" },
      { role: "assistant", text: "Added a prompt.\n\nPress Run when ready." },
    ]);
    expect(params.prompt).toBe("<canvas nodes=1/>\n<user>now make it a dog</user>");
    // The prompt builder's text, then which model the turn runs on (our prompt replaces the CLI's own).
    expect(params.systemPrompt).toBe(
      "SYSTEM for claude\n\nYou are running on Sonnet (sonnet), through the user's Claude Code. Say so if asked which model you are.",
    );
    expect(params.sessionId).toBe("session-9");
    expect(params.signal).toBe(controller.signal);
    expect(params.tools.definitions).toEqual(definitions);
  });

  it("builds the tool runtime from the request's workflow snapshot", async () => {
    const { harness } = fakeHarness(() => emit());
    const createToolRuntime = vi.fn(() => fakeRuntime({}).runtime);
    const workflow = { ...emptyWorkflow, workflowName: "Cats" };

    await run({ harness, body: requestBody({ workflow }), createToolRuntime });

    expect(createToolRuntime).toHaveBeenCalledWith(workflow, expect.objectContaining({ providerKeys: {} }));
  });

  it("keeps provider keys inside the tool runtime: none reaches the harness, the stream or a log", async () => {
    const secrets = { openai: "sk-stream-secret-openai", fal: "fal-stream-secret" };
    const flare: ProviderModel = {
      id: "gpt-image-2.5-flare",
      name: "GPT Image 2.5 Flare",
      description: "OpenAI image generation.",
      provider: "openai",
      capabilities: ["text-to-image", "image-to-image"],
    };
    const keysSeen: ProviderKeys[] = [];
    const modelSource: ModelSource = {
      async listModels(query, keys) {
        keysSeen.push(keys);
        const models = !query.provider || query.provider === "openai" ? [flare] : [];
        return { ok: true, models, providers: { [query.provider ?? "openai"]: { success: true, count: models.length } }, availableProviders: ["gemini", "openai"], cached: false };
      },
      async getModelSchema(_provider, _modelId, keys) {
        keysSeen.push(keys);
        return { ok: true, parameters: [{ name: "quality", type: "string", enum: ["auto", "high"], default: "auto" }], inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }], cached: false };
      },
    };
    const results: AgentToolResult[] = [];
    const { harness, turns } = fakeHarness(async function* (params) {
      results.push(await params.tools.execute("search_models", { nodeType: "nanoBanana", query: "flare" }));
      results.push(await params.tools.execute("update_node", { node: "nanoBanana-1", settings: { model: "gpt-image-2.5-flare", modelParameters: { quality: "high" } } }));
      yield { type: "text-delta", id: "t1", delta: "Switched it to GPT Image 2.5 Flare." };
      yield { type: "text-end", id: "t1" };
    });
    const workflow: AgentWorkflowSnapshot = {
      ...emptyWorkflow,
      nodes: [{ id: "nanoBanana-1", type: "nanoBanana", position: { x: 0, y: 0 }, width: 300, height: 300, data: {} }],
    };

    const { chunks, message } = await run({
      harness,
      body: requestBody({ workflow }),
      providerKeys: secrets,
      createToolRuntime: (snapshot, options) => createAgentToolRuntime(snapshot, { ...options, modelSource }),
      buildSystemPrompt: undefined,
      buildTurnPrompt: undefined,
    });

    // The runtime had the keys and used them...
    expect(keysSeen.length).toBeGreaterThan(0);
    for (const keys of keysSeen) expect(keys).toEqual(secrets);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[1].ops[0]).toMatchObject({ data: { selectedModel: { provider: "openai", modelId: "gpt-image-2.5-flare" }, parameters: { quality: "high" } } });
    // ...and nothing else did.
    const { tools, signal: _signal, ...params } = turns[0];
    const everything = [
      JSON.stringify(params),
      JSON.stringify(tools.definitions),
      JSON.stringify(results),
      JSON.stringify(chunks),
      JSON.stringify(message),
      JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls]),
    ].join("\n");
    for (const secret of Object.values(secrets)) expect(everything).not.toContain(secret);
    expect(params.systemPrompt).toContain("search_models");
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("createAgentChatStream: tool calls", () => {
  it("sends the conversation's name as a persisted summary part, with no tool card", async () => {
    const { harness } = fakeHarness(async function* (params) {
      const result = await params.tools.execute("name_conversation", { summary: "  Espresso hero film workflow. " });
      expect(result.ok).toBe(true);
      yield { type: "text-delta", id: "t1", delta: "Done." };
      yield { type: "text-end", id: "t1" };
    });
    const { message } = await run({
      harness,
      createToolRuntime: (snapshot, options) => createAgentToolRuntime(snapshot, options),
    });
    expect(message.parts.filter((part) => part.type === "dynamic-tool")).toEqual([]);
    expect(message.parts.find((part) => part.type === "data-agent-summary")).toMatchObject({
      data: { summary: "Espresso hero film workflow" },
    });
  });

  it("turns a tool call into a dynamic-tool part and sends its ops as a transient graph-ops chunk", async () => {
    const { runtime, calls } = fakeRuntime({ edit_workflow: addPromptResult });
    const returned: AgentToolResult[] = [];
    const args = { operations: [{ op: "add_node", ref: "p", type: "prompt", settings: { prompt: "a cat" } }] };
    const { harness } = fakeHarness(async function* (params) {
      yield { type: "text-delta", id: "t1", delta: "Adding a prompt node." };
      yield { type: "tool-pending", toolName: "edit_workflow" };
      returned.push(await params.tools.execute("edit_workflow", args));
      yield { type: "text-delta", id: "t2", delta: "Done." };
    });

    const { chunks, message } = await run({ harness, createToolRuntime: () => runtime });

    // The harness gets the runtime's full answer, text for the model included.
    expect(returned).toEqual([addPromptResult]);
    expect(calls).toEqual([{ name: "edit_workflow", args }]);

    const [tool] = partsOfType(message, "dynamic-tool");
    expect(tool).toMatchObject({
      type: "dynamic-tool",
      toolName: "edit_workflow",
      title: "Edit workflow",
      state: "output-available",
      input: args,
      output: { ok: true, summary: "Added 1 node" },
      providerExecuted: true,
    });
    expect(message.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool", "text"]);

    const [opsChunk] = chunksOfType(chunks, "data-graph-ops");
    expect(opsChunk.transient).toBe(true);
    const batch: AgentGraphOpBatch = opsChunk.data;
    expect(batch).toEqual({
      batchId: expect.stringMatching(/^ops_/),
      toolCallId: tool.toolCallId,
      ops: addPromptResult.ops,
      summary: "Added 1 node",
      focusNodeIds: ["prompt-ag1"],
    });
    // Transient: seen by onData, never kept in the message.
    expect(message.parts.some((part) => part.type === "data-graph-ops")).toBe(false);

    const toolChunks = types(chunks).filter((type) => type.startsWith("tool-") || type === "data-graph-ops");
    expect(toolChunks).toEqual(["tool-input-available", "data-graph-ops", "tool-output-available"]);
    expect(statusLines(chunks)).toEqual(["Starting Claude Code…", "", "Planning edits…", ""]);
  });

  it("marks a canvas replacement on the ops batch", async () => {
    const replaced: AgentToolResult = {
      ...addPromptResult,
      ops: [{ op: "clearCanvas" }, ...addPromptResult.ops],
      replacedCanvas: true,
    };
    const { runtime } = fakeRuntime({ edit_workflow: replaced });
    const { harness } = fakeHarness(async function* (params) {
      await params.tools.execute("edit_workflow", {});
      yield* emit();
    });

    const { chunks } = await run({ harness, createToolRuntime: () => runtime });

    expect(chunksOfType(chunks, "data-graph-ops")[0].data).toMatchObject({
      replacedCanvas: true,
      ops: [{ op: "clearCanvas" }, expect.objectContaining({ op: "addNode" })],
    });
  });

  it("reports a failed tool as tool-output-error and sends no ops", async () => {
    const failure: AgentToolResult = {
      ok: false,
      text: 'Node "nope" does not exist. Call get_workflow for the current ids.',
      summary: 'No node "nope"',
      ops: [],
    };
    const { runtime } = fakeRuntime({ edit_workflow: failure });
    const returned: AgentToolResult[] = [];
    const { harness } = fakeHarness(async function* (params) {
      returned.push(await params.tools.execute("edit_workflow", { operations: [] }));
      yield { type: "text-delta", id: "t", delta: "Let me check the canvas." };
    });

    const { chunks, message } = await run({ harness, createToolRuntime: () => runtime });

    expect(returned).toEqual([failure]);
    expect(partsOfType(message, "dynamic-tool")[0]).toMatchObject({
      state: "output-error",
      errorText: 'No node "nope"',
      title: "Edit workflow",
    });
    expect(types(chunks)).toContain("tool-output-error");
    expect(types(chunks)).not.toContain("data-graph-ops");
  });

  it("answers the model and shows an error card when the runtime throws", async () => {
    const { runtime } = fakeRuntime({ edit_workflow: new Error("draft exploded") });
    const returned: AgentToolResult[] = [];
    const { harness } = fakeHarness(async function* (params) {
      returned.push(await params.tools.execute("edit_workflow", {}));
      yield* emit();
    });

    const { message } = await run({ harness, createToolRuntime: () => runtime });

    expect(returned[0]).toMatchObject({ ok: false, ops: [] });
    expect(returned[0].text).toContain("draft exploded");
    expect(partsOfType(message, "dynamic-tool")[0]).toMatchObject({
      state: "output-error",
      errorText: "Edit workflow failed unexpectedly",
    });
  });

  it("shows read-only tools without ops, and resolves the model-facing tool name", async () => {
    const read: AgentToolResult = { ok: true, text: "0 nodes", summary: "Read 0 nodes", ops: [] };
    const { runtime, calls } = fakeRuntime({ get_workflow: read });
    const { harness } = fakeHarness(async function* (params) {
      yield { type: "tool-pending", toolName: "mcp__node_banana__get_workflow" };
      await params.tools.execute("mcp__node_banana__get_workflow", { detail: "summary" });
      yield* emit();
    });

    const { chunks, message } = await run({ harness, createToolRuntime: () => runtime });

    expect(calls[0].name).toBe("get_workflow");
    expect(partsOfType(message, "dynamic-tool")[0]).toMatchObject({
      toolName: "get_workflow",
      title: "Read workflow",
      state: "output-available",
      output: { ok: true, summary: "Read 0 nodes" },
    });
    expect(types(chunks)).not.toContain("data-graph-ops");
    expect(statusLines(chunks)).toContain("Reading the canvas…");
  });

  it("writes text the harness queued before a tool call ahead of the tool card", async () => {
    // A harness whose tool call arrives on its own path (an MCP handler, a
    // JSON-RPC request) while text is still waiting in its event queue.
    const { runtime } = fakeRuntime({ edit_workflow: addPromptResult });
    const harness: AgentHarness = {
      ...fakeHarness(() => emit()).harness,
      runTurn(params) {
        const queue: HarnessEvent[] = [];
        let wake: (() => void) | undefined;
        let closed = false;
        const push = (event: HarnessEvent) => {
          queue.push(event);
          wake?.();
        };
        void (async () => {
          push({ type: "text-delta", id: "t1", delta: "Before the tool." });
          await params.tools.execute("edit_workflow", {});
          push({ type: "text-delta", id: "t2", delta: "After the tool." });
          closed = true;
          wake?.();
        })();
        return (async function* () {
          for (;;) {
            if (queue.length > 0) yield queue.shift()!;
            else if (closed) return;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        })();
      },
    };

    const { message } = await run({ harness, createToolRuntime: () => runtime });

    expect(message.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Before the tool.",
      "dynamic-tool",
      "After the tool.",
    ]);
  });

  it("starts a new text part when a text block continues after a tool call", async () => {
    const { runtime } = fakeRuntime({ edit_workflow: addPromptResult });
    const { harness } = fakeHarness(async function* (params) {
      yield { type: "text-delta", id: "t1", delta: "Adding." };
      await params.tools.execute("edit_workflow", {});
      yield { type: "text-delta", id: "t1", delta: "Added." };
      yield { type: "text-end", id: "t1" };
    });

    const { chunks, message } = await run({ harness, createToolRuntime: () => runtime });

    expect(message.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Adding.",
      "dynamic-tool",
      "Added.",
    ]);
    expect(chunksOfType(chunks, "text-start")).toHaveLength(2);
    expect(chunksOfType(chunks, "text-end")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("createAgentChatStream: sessions", () => {
  it("persists the harness session as one data-agent-session part", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "session", sessionId: "s-1" },
        { type: "session", sessionId: "s-1" },
        { type: "text-delta", id: "t", delta: "ok" },
        { type: "session", sessionId: "s-2" }
      )
    );

    const { chunks, message } = await run({ harness });

    expect(chunksOfType(chunks, "data-agent-session").map((chunk) => chunk.data.sessionId)).toEqual(["s-1", "s-2"]);
    expect(chunksOfType(chunks, "data-agent-session").every((chunk) => chunk.id === "session" && !chunk.transient)).toBe(true);
    expect(partsOfType(message, "data-agent-session")).toEqual([
      { type: "data-agent-session", id: "session", data: { harness: "claude", sessionId: "s-2" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Readiness and harness errors
// ---------------------------------------------------------------------------

describe("createAgentChatStream: notices", () => {
  it.each([
    [
      "not_signed_in",
      readyStatus({ signedIn: false, billing: "none", problem: "Sign in to Claude Code to use the agent." }),
      "Sign in to Claude Code to use the agent.",
    ],
    [
      "wrong_billing",
      readyStatus({ billing: "api", problem: "Claude Code is signed in with an API key, which bills API credits." }),
      "Claude Code is signed in with an API key, which bills API credits.",
    ],
    [
      "not_installed",
      readyStatus({ installed: false, signedIn: false, billing: "none", problem: "Claude Code is not installed." }),
      "Claude Code is not installed.",
    ],
  ] as const)("answers %s with a notice and never starts a turn", async (code, status, problem) => {
    const script = vi.fn(() => emit({ type: "text-delta", id: "t", delta: "should not run" }));
    const { harness, turns } = fakeHarness(script, status);
    const createToolRuntime = vi.fn(() => fakeRuntime({}).runtime);

    const { chunks, message } = await run({ harness, createToolRuntime });

    expect(turns).toHaveLength(0);
    expect(createToolRuntime).not.toHaveBeenCalled();
    expect(types(chunks)).toEqual(["start", "data-agent-notice", "finish"]);
    expect(message.parts).toEqual([
      { type: "data-agent-notice", data: { code, message: problem, harness: "claude" } },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "error" });
  });

  it("reports a failed status check as a harness error", async () => {
    const { harness, turns } = fakeHarness(
      () => emit(),
      async () => {
        throw new Error("spawn claude ENOENT");
      }
    );

    const { message } = await run({ harness });

    expect(turns).toHaveLength(0);
    expect(partsOfType(message, "data-agent-notice")[0].data).toEqual({
      code: "harness_error",
      message: "Could not check Claude Code: spawn claude ENOENT",
      harness: "claude",
    });
  });

  it("reports a turn that cannot be prepared as a harness error", async () => {
    const { harness, turns } = fakeHarness(() => emit());

    const { message } = await run({
      harness,
      buildTurnPrompt: () => {
        throw new Error("prompt builder missing");
      },
    });

    expect(turns).toHaveLength(0);
    expect(partsOfType(message, "data-agent-notice")[0].data).toMatchObject({
      code: "harness_error",
      message: "Could not prepare the agent's turn: prompt builder missing",
    });
  });

  it("turns harness error events into notices and keeps what was already said", async () => {
    const { harness } = fakeHarness(() =>
      emit(
        { type: "text-delta", id: "t", delta: "Working on it" },
        { type: "error", code: "usage_limit", message: "You have reached your Claude usage limit until 5pm." }
      )
    );

    const { chunks, message } = await run({ harness });

    expect(message.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Working on it", state: "done" }),
      {
        type: "data-agent-notice",
        data: { code: "usage_limit", message: "You have reached your Claude usage limit until 5pm.", harness: "claude" },
      },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "error" });
  });

  it("passes a mid-turn sign-out through as not_signed_in", async () => {
    const { harness } = fakeHarness(() =>
      emit({ type: "error", code: "not_signed_in", message: "Claude Code is not logged in." })
    );

    const { message } = await run({ harness });

    expect(partsOfType(message, "data-agent-notice")[0].data.code).toBe("not_signed_in");
  });

  it("reports a harness that throws mid-turn as a harness error", async () => {
    const { harness } = fakeHarness(async function* () {
      yield { type: "text-delta", id: "t", delta: "Partial" };
      throw new Error("Claude Code process exited with code 1");
    });

    const { message } = await run({ harness });

    expect(message.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Partial" }),
      {
        type: "data-agent-notice",
        data: {
          code: "harness_error",
          message: "Claude Code stopped with an error: Claude Code process exited with code 1",
          harness: "claude",
        },
      },
    ]);
  });

  it("reports a harness that fails to start as a harness error", async () => {
    const { harness } = fakeHarness(() => {
      throw new Error("no binary");
    });

    const { message } = await run({ harness });

    expect(partsOfType(message, "data-agent-notice")[0].data).toMatchObject({
      code: "harness_error",
      message: "Claude Code could not start: no binary",
    });
  });

  it("refuses a request whose last message is not the user's", async () => {
    const { harness, turns } = fakeHarness(() => emit());
    const body = requestBody({ messages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }] });

    const { message } = await run({ harness, body });

    expect(turns).toHaveLength(0);
    expect(harness.getStatus).not.toHaveBeenCalled();
    expect(partsOfType(message, "data-agent-notice")[0].data.code).toBe("bad_request");
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("createAgentChatStream: abort", () => {
  it("ends with an abort chunk when the browser stops the turn", async () => {
    const controller = new AbortController();
    const { harness, turns } = fakeHarness(async function* (params) {
      yield { type: "text-delta", id: "t", delta: "Working" };
      controller.abort(); // the user pressed stop
      await waitForAbort(params.signal);
    });

    const { chunks, message } = await run({ harness, signal: controller.signal });

    expect(turns[0].signal.aborted).toBe(true);
    expect(types(chunks).slice(-2)).toEqual(["text-end", "abort"]);
    expect(types(chunks)).not.toContain("finish");
    expect(message.parts).toEqual([expect.objectContaining({ type: "text", text: "Working", state: "done" })]);
  });

  it("does not wait for a harness that ignores the abort", async () => {
    const controller = new AbortController();
    const { harness } = fakeHarness(async function* () {
      yield { type: "text-delta", id: "t", delta: "Working" };
      controller.abort();
      await new Promise(() => {}); // never notices
    });

    const { chunks } = await run({ harness, signal: controller.signal, abortedTurnGraceMs: 10 });

    expect(chunks.at(-1)).toMatchObject({ type: "abort" });
  });

  it("does not report the harness's own cancellation as a problem", async () => {
    const controller = new AbortController();
    const { harness } = fakeHarness(async function* (params) {
      controller.abort();
      await waitForAbort(params.signal);
      yield { type: "error", code: "aborted", message: "Operation aborted" };
    });

    const { chunks } = await run({ harness, signal: controller.signal });

    expect(types(chunks)).not.toContain("data-agent-notice");
  });

  it("never starts the CLI when the request was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { harness, turns } = fakeHarness(() => emit({ type: "text-delta", id: "t", delta: "no" }));

    const { chunks } = await run({ harness, signal: controller.signal });

    expect(turns).toHaveLength(0);
    expect(types(chunks)).toEqual(["start", "abort"]);
  });

  it("treats a harness that throws after the abort as aborted, not failed", async () => {
    const controller = new AbortController();
    const { harness } = fakeHarness(async function* () {
      controller.abort();
      yield* emit();
      throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    });

    const { chunks } = await run({ harness, signal: controller.signal });

    expect(chunks.at(-1)).toMatchObject({ type: "abort" });
    expect(types(chunks)).not.toContain("data-agent-notice");
  });
});

// ---------------------------------------------------------------------------
// One turn per chat
// ---------------------------------------------------------------------------

describe("createAgentChatStream: one turn per chat", () => {
  it("answers a second turn on a busy chat with session_busy", async () => {
    const gate = deferred();
    const started = deferred();
    const { harness, turns } = fakeHarness(async function* () {
      started.resolve();
      await gate.promise;
      yield { type: "text-delta", id: "t", delta: "first turn done" };
    });
    const body = requestBody();

    const first = collect(streamFor({ harness, body }));
    await started.promise;
    const second = await run({ harness, body: { ...body, messages: [userMessage("again")] } });

    expect(turns).toHaveLength(1);
    expect(partsOfType(second.message, "data-agent-notice")[0].data.code).toBe("session_busy");
    expect(second.chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "error" });

    gate.resolve();
    const firstResult = await first;
    expect(partsOfType(firstResult.message, "text")[0].text).toBe("first turn done");

    // The chat is free again once the first turn is over.
    const third = await run({ harness, body });
    expect(turns).toHaveLength(2);
    expect(types(third.chunks)).not.toContain("data-agent-notice");
  });

  it("runs turns on different chats side by side", async () => {
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const { harness, turns } = fakeHarness(async function* () {
      running++;
      peak = Math.max(peak, running);
      await gate.promise;
      running--;
      yield { type: "text-delta", id: "t", delta: "ok" };
    });

    const turnsDone = Promise.all([run({ harness }), run({ harness })]);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    gate.resolve();
    const results = await turnsDone;

    expect(peak).toBe(2);
    expect(results.every(({ chunks }) => !types(chunks).includes("data-agent-notice"))).toBe(true);
  });

  it("lets a new turn wait for a stopped one to wind down instead of reporting busy", async () => {
    const order: string[] = [];
    const firstController = new AbortController();
    const { harness, turns } = fakeHarness(async function* (params) {
      if (turns.length === 1) {
        yield { type: "text-delta", id: "t", delta: "first" };
        firstController.abort();
        await waitForAbort(params.signal);
        await sleep(30); // the CLI takes a moment to exit
        order.push("first turn exited");
        return;
      }
      order.push("second turn started");
      yield { type: "text-delta", id: "t", delta: "second" };
    });
    const body = requestBody();

    await run({ harness, body, signal: firstController.signal });
    const second = await run({ harness, body: { ...body, messages: [userMessage("try this instead")] } });

    expect(order).toEqual(["first turn exited", "second turn started"]);
    expect(partsOfType(second.message, "text")[0].text).toBe("second");
  });

  it(`runs at most ${MAX_ACTIVE_TURNS} turns at once across all chats, and says so to the rest`, async () => {
    const gate = deferred();
    const { harness, turns } = fakeHarness(async function* () {
      await gate.promise;
      yield { type: "text-delta", id: "t", delta: "ok" };
    });

    // A flood of distinct chat ids, as from a script: only the first few get a CLI.
    const flood = Array.from({ length: 20 }, () => collect(streamFor({ harness, body: requestBody() })));
    await vi.waitFor(() => expect(turns).toHaveLength(MAX_ACTIVE_TURNS));
    await sleep(20);
    expect(turns).toHaveLength(MAX_ACTIVE_TURNS);

    gate.resolve();
    const results = await Promise.all(flood);
    const refused = results.filter(({ message }) => partsOfType(message, "data-agent-notice").length > 0);
    expect(refused).toHaveLength(20 - MAX_ACTIVE_TURNS);
    for (const { message, chunks } of refused) {
      const [notice] = partsOfType(message, "data-agent-notice");
      expect(notice.data.code).toBe("session_busy");
      expect(notice.data.message).toContain(`already working on ${MAX_ACTIVE_TURNS} messages`);
      expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "error" });
    }
    expect(harness.getStatus).toHaveBeenCalledTimes(MAX_ACTIVE_TURNS);

    // Once they are done, a new chat runs again.
    const after = await run({ harness });
    expect(turns).toHaveLength(MAX_ACTIVE_TURNS + 1);
    expect(types(after.chunks)).not.toContain("data-agent-notice");
  });

  it("does not count a stopped turn that is still winding down toward the cap", async () => {
    const stopped = new AbortController();
    const running = deferred();
    const { harness, turns } = fakeHarness(async function* (params) {
      if (turns.length === 1) {
        stopped.abort();
        await new Promise(() => {}); // a CLI slow to exit
      }
      if (params.signal === stopped.signal) return;
      await running.promise;
      yield { type: "text-delta", id: "t", delta: "ok" };
    });

    await run({ harness, signal: stopped.signal, maxActiveTurns: 1 });
    const next = run({ harness, maxActiveTurns: 1 });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const third = await run({ harness, maxActiveTurns: 1 });
    running.resolve();

    expect(types((await next).chunks)).not.toContain("data-agent-notice");
    expect(partsOfType(third.message, "data-agent-notice")[0].data.code).toBe("session_busy");
    expect(turns).toHaveLength(2);
  });

  it("stops holding the chat for a stopped turn that never winds down", async () => {
    const firstController = new AbortController();
    const { harness, turns } = fakeHarness(async function* () {
      if (turns.length === 1) {
        yield { type: "text-delta", id: "t", delta: "first" };
        firstController.abort();
        await new Promise(() => {}); // a stuck CLI
      }
      yield { type: "text-delta", id: "t", delta: "second" };
    });
    const body = requestBody();

    await run({ harness, body, signal: firstController.signal, abortedTurnGraceMs: 20 });
    const second = await run({ harness, body, abortedTurnGraceMs: 20 });

    expect(turns).toHaveLength(2);
    expect(partsOfType(second.message, "text")[0].text).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// harnessNotReady
// ---------------------------------------------------------------------------

describe("harnessNotReady", () => {
  it("lets a subscription login run", () => {
    expect(harnessNotReady(readyStatus())).toBeNull();
  });

  it("checks install, then sign-in, then billing", () => {
    expect(harnessNotReady(readyStatus({ installed: false, signedIn: false, billing: "none" }))?.code).toBe("not_installed");
    expect(harnessNotReady(readyStatus({ signedIn: false, billing: "none" }))?.code).toBe("not_signed_in");
    expect(harnessNotReady(readyStatus({ billing: "api" }))?.code).toBe("wrong_billing");
  });

  it("refuses billing it cannot confirm", () => {
    const result = harnessNotReady(readyStatus({ billing: "unknown" }));
    expect(result?.code).toBe("wrong_billing");
    expect(result?.message).toContain("Could not confirm");
  });

  it("falls back to its own words when the harness gives no problem text", () => {
    expect(harnessNotReady(readyStatus({ signedIn: false }))?.message).toBe(
      "Sign in to Claude Code with your subscription to use the agent (`claude auth login`)."
    );
    expect(harnessNotReady(readyStatus({ billing: "api" }))?.message).toContain("bills an API account");
    expect(harnessNotReady(readyStatus({ installed: false }))?.message).toContain("was not found");
  });
});

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

describe("parseAgentChatRequest", () => {
  const valid = () => ({
    id: "chat-1",
    messages: [userMessage("hello")],
    harness: "codex",
    workflow: {
      nodes: [{ id: "prompt-1", type: "prompt", position: { x: 1, y: 2 }, width: 320, height: 220, data: { prompt: "a cat" }, content: { text: "a cat" } }],
      edges: [{ id: "e1", source: "prompt-1", target: "nanoBanana-1", targetHandle: "text" }],
      groups: [],
      selectedNodeIds: ["prompt-1"],
    },
  });

  it("passes the user's saved node defaults through and drops malformed ones instead of refusing", () => {
    const nodeDefaults = { nanoBanana: { aspectRatio: "16:9" } };
    const good = parseAgentChatRequest({ ...valid(), workflow: { ...emptyWorkflow, nodeDefaults } });
    expect(good.ok && good.body.workflow.nodeDefaults).toEqual(nodeDefaults);
    const bad = parseAgentChatRequest({ ...valid(), workflow: { ...emptyWorkflow, nodeDefaults: { nanoBanana: "16:9" } } });
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.body.workflow.nodeDefaults).toBeUndefined();
  });
  it("accepts the panel's request and normalises optional fields", () => {
    const result = parseAgentChatRequest({ ...valid(), model: "", sessionId: null, trigger: "submit-message" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toHaveProperty("model");
    expect(result.body).not.toHaveProperty("sessionId");
    expect(result.body).not.toHaveProperty("trigger");
    expect(result.body.harness).toBe("codex");
    expect(result.body.workflow.edges[0]).toMatchObject({ sourceHandle: null, targetHandle: "text" });
    expect(result.body.workflow.nodes[0].content).toEqual({ text: "a cat" });
  });

  it("drops a session id that is not an id, so the turn starts a fresh session", () => {
    for (const sessionId of ["../../etc/passwd", "--settings={}", "a b", "x".repeat(129)]) {
      const result = parseAgentChatRequest({ ...valid(), sessionId });
      if (!result.ok) throw new Error(result.message);
      expect(result.body, sessionId).not.toHaveProperty("sessionId");
    }
    const uuid = parseAgentChatRequest({ ...valid(), sessionId: "0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b" });
    expect(uuid).toMatchObject({ ok: true, body: { sessionId: "0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b" } });
  });

  it("refuses a model name longer than any model id", () => {
    const result = parseAgentChatRequest({ ...valid(), model: "m".repeat(201) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("model:");
  });

  it("keeps a model and session when given", () => {
    const result = parseAgentChatRequest({ ...valid(), model: "gpt-5.6-luna", sessionId: "thread-1" });

    expect(result).toMatchObject({ ok: true, body: { model: "gpt-5.6-luna", sessionId: "thread-1" } });
  });

  it("defaults missing groups and selection", () => {
    const body = valid();
    const { groups: _groups, selectedNodeIds: _selected, ...workflow } = body.workflow;
    const result = parseAgentChatRequest({ ...body, workflow });

    expect(result).toMatchObject({ ok: true, body: { workflow: { groups: [], selectedNodeIds: [] } } });
  });

  it.each([
    ["null", null, "Invalid agent request"],
    ["an array", [], "Invalid agent request"],
    ["a missing chat id", { ...valid(), id: undefined }, "id:"],
    ["an unknown harness", { ...valid(), harness: "gemini" }, "harness:"],
    ["no messages", { ...valid(), messages: [] }, "messages:"],
    ["a message without parts", { ...valid(), messages: [{ id: "m", role: "user" }] }, "messages[0].parts:"],
    ["no workflow", { ...valid(), workflow: undefined }, "workflow:"],
    [
      "a node without a position",
      { ...valid(), workflow: { ...valid().workflow, nodes: [{ id: "n", type: "prompt", width: 1, height: 1, data: {} }] } },
      "workflow.nodes[0].position:",
    ],
    [
      "a last message from the assistant",
      { ...valid(), messages: [userMessage("hi"), { id: "a", role: "assistant", parts: [{ type: "text", text: "yo" }] }] },
      "the last message must be the user's",
    ],
    [
      "a last user message with no text",
      { ...valid(), messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "   " }] }] },
      "the last message must be the user's",
    ],
  ])("rejects %s", (_label, raw, expected) => {
    const result = parseAgentChatRequest(raw);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(expected);
  });

  it("summarises long lists of problems", () => {
    const result = parseAgentChatRequest({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/\(and \d+ more\)$/);
  });
});

describe("pickTurnModel", () => {
  const options = [
    { id: "sonnet", label: "Sonnet", isDefault: true },
    { id: "haiku", label: "Haiku" },
  ];

  it("keeps a model the harness offers", () => {
    expect(pickTurnModel("haiku", options)).toBe("haiku");
  });

  it("drops anything else, and anything at all when the harness listed none", () => {
    expect(pickTurnModel(undefined, options)).toBeUndefined();
    expect(pickTurnModel("Haiku", options)).toBeUndefined();
    expect(pickTurnModel("gpt-5", options)).toBeUndefined();
    expect(pickTurnModel("haiku", [])).toBeUndefined();
  });
});

describe("readConversation", () => {
  it("joins a message's text parts and skips empty turns", () => {
    const conversation = readConversation([
      { id: "u1", role: "user", parts: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { id: "a1", role: "assistant", parts: [{ type: "reasoning", text: "hidden", state: "done" }] },
      { id: "s", role: "system", parts: [{ type: "text", text: "ignored" }] },
      userMessage("three"),
    ]);

    expect(conversation).toEqual({ history: [{ role: "user", text: "one\n\ntwo" }], userText: "three" });
  });
});

describe("pickTurnEffort", () => {
  const opus = { id: "opus", label: "Opus", efforts: ["low", "high", "max"], defaultEffort: "high" };

  it("passes only a level the model lists", () => {
    expect(pickTurnEffort("max", opus)).toBe("max");
    expect(pickTurnEffort("xhigh", opus)).toBeUndefined();
    expect(pickTurnEffort("max", { id: "haiku", label: "Haiku" })).toBeUndefined();
    expect(pickTurnEffort(undefined, opus)).toBeUndefined();
  });
});
