/**
 * The agent end to end without a CLI: the live store's canvas becomes the
 * request snapshot, the real chat bridge runs the real tool runtime and
 * prompts, a scripted harness calls the tools the way Claude Code and Codex do
 * (prefixed names, JSON-string arguments), and the graph-ops batches it
 * streams are applied by the real store action. Then a second turn is built
 * from the resulting canvas.
 *
 * Everything the unit tests of each area fake is real here, so a contract
 * drifting between the areas fails this file.
 */

import { readUIMessageStream } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

import { useWorkflowStore } from "@/store/workflowStore";
import { sameInputSchema } from "@/components/nodes/ui/schemaSockets";
import type { ProviderKeys } from "@/lib/providers/keys";
import type { ModelInputDef } from "@/types";
import { getModelSchema } from "@/lib/providers/schema";
import { createDefaultNodeData, defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { applyGraphOps } from "../graph/applyOps";
import { buildAgentChatRequestBody } from "../client/request";
import { getInputHandles, getOutputHandles, isValidConnectionPort, type GraphNodeLike } from "../graph/handles";
import { createAgentChatStream, parseAgentChatRequest, type AgentUIMessageChunk } from "../server/chatStream";
import type {
  AgentGraphOpBatch,
  AgentHarness,
  AgentHarnessStatus,
  AgentUIMessage,
  HarnessEvent,
  HarnessTurnParams,
} from "../types";

const VIEWPORT = { x: 0, y: 0, width: 1400, height: 800, zoom: 1 };

function readyStatus(): AgentHarnessStatus {
  return {
    id: "claude",
    label: "Claude Code",
    installed: true,
    signedIn: true,
    billing: "subscription",
    models: [{ id: "sonnet", label: "Sonnet", isDefault: true }],
    signIn: { state: "idle" },
    signInCommand: "claude auth login",
  };
}

/** A harness whose turn is a script over the real (wrapped) tool runtime. */
function scriptedHarness(script: (params: HarnessTurnParams) => AsyncGenerator<HarnessEvent>) {
  const turns: HarnessTurnParams[] = [];
  const harness: AgentHarness = {
    id: "claude",
    label: "Claude Code",
    getStatus: async () => readyStatus(),
    startSignIn: async () => ({ state: "already_signed_in" }),
    runTurn: (params) => {
      turns.push(params);
      return script(params);
    },
  };
  return { harness, turns };
}

/**
 * One turn as the panel does it: body from the live store (serialised and
 * re-parsed as the route would), graph-ops applied to the store as they
 * arrive, the final message kept for the next turn's history.
 */
async function runPanelTurn(harness: AgentHarness, messages: AgentUIMessage[], providerKeys: ProviderKeys = {}) {
  const { nodes, edges, groups, workflowName } = useWorkflowStore.getState();
  const wire = JSON.parse(
    JSON.stringify(
      buildAgentChatRequestBody({
        chatId: "chat-e2e",
        messages,
        harness: "claude",
        canvas: { nodes, edges, groups, workflowName },
        viewport: VIEWPORT,
      })
    )
  );
  const parsed = parseAgentChatRequest(wire);
  if (!parsed.ok) throw new Error(parsed.message);

  const stream = createAgentChatStream({ body: parsed.body, harness, signal: new AbortController().signal, providerKeys });
  const chunks: AgentUIMessageChunk[] = [];
  const batches: AgentGraphOpBatch[] = [];
  const tapped = stream.pipeThrough(
    new TransformStream<AgentUIMessageChunk, AgentUIMessageChunk>({
      transform(chunk, controller) {
        const copy = JSON.parse(JSON.stringify(chunk)) as AgentUIMessageChunk;
        chunks.push(copy);
        if (copy.type === "data-graph-ops") {
          batches.push(copy.data);
          const result = useWorkflowStore.getState().applyAgentGraphOps(copy.data);
          expect(result.skipped).toEqual([]);
        }
        controller.enqueue(chunk);
      },
    })
  );
  let message: AgentUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<AgentUIMessage>({ stream: tapped })) message = snapshot;
  if (!message) throw new Error("no assistant message");
  return { chunks, batches, message, body: parsed.body };
}

function expectValidEdges() {
  const { nodes, edges } = useWorkflowStore.getState();
  const byId = new Map<string, GraphNodeLike>(
    nodes.map((node) => [node.id, { id: node.id, type: node.type as GraphNodeLike["type"], data: node.data as Record<string, unknown> }])
  );
  const graphEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }));
  for (const edge of graphEdges) {
    expect(isValidConnectionPort(edge, byId)).toBe(true);
    expect(getOutputHandles(byId.get(edge.source)!, graphEdges).map((h) => h.id)).toContain(edge.sourceHandle);
    expect(getInputHandles(byId.get(edge.target)!, graphEdges).map((h) => h.id)).toContain(edge.targetHandle);
  }
}

describe("agent end to end (scripted harness, real bridge, runtime, prompts and store)", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ nodes: [], edges: [], groups: {}, workflowName: null });
  });

  it("creates a workflow on an empty canvas, then edits it in a second turn", async () => {
    // Turn 1: Claude-style prefixed tool name, arguments as an object.
    const first = scriptedHarness(async function* (params) {
      yield { type: "session", sessionId: "session-1" };
      yield { type: "text-delta", id: "t1", delta: "Building it now." };
      yield { type: "text-end", id: "t1" };
      yield { type: "tool-pending", toolName: "mcp__node_banana__create_workflow" };
      const result = await params.tools.execute("mcp__node_banana__create_workflow", {
        nodes: [
          { ref: "p", type: "prompt", settings: { prompt: "A banana astronaut feeding a monkey in orbit" } },
          { ref: "g", type: "nanoBanana" },
          { ref: "o", type: "output" },
        ],
        connections: [
          { from: "p", to: "g" },
          { from: "g", to: "o" },
        ],
      });
      expect(result.ok).toBe(true);
      yield { type: "text-delta", id: "t2", delta: "Done. Press Run." };
      yield { type: "text-end", id: "t2" };
    });

    const user1: AgentUIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Make a text-to-image workflow" }] };
    const turn1 = await runPanelTurn(first.harness, [user1]);

    // The harness got the real prompts, with the (empty) canvas in the turn prompt.
    const params1 = first.turns[0];
    expect(params1.systemPrompt).toContain("Node Banana");
    expect(params1.prompt).toContain("<canvas>");
    expect(params1.prompt).toContain("The canvas is empty.");
    expect(params1.tools.definitions.map((d) => d.name)).toContain("create_workflow");

    // UI parts: a titled dynamic tool with the summary, text either side, the session.
    const tool = turn1.message.parts.find((part) => part.type === "dynamic-tool");
    expect(tool).toMatchObject({ type: "dynamic-tool", toolName: "create_workflow", title: "Create workflow", state: "output-available" });
    expect((tool as { output: { ok: boolean; summary: string } }).output).toEqual({ ok: true, summary: expect.stringMatching(/3 nodes/) });
    expect(turn1.message.parts.map((part) => part.type)).toEqual(["data-agent-session", "text", "dynamic-tool", "text"]);

    // The ops landed on the store: prompt → nanoBanana → output on valid handles.
    expect(turn1.batches).toHaveLength(1);
    const { nodes, edges } = useWorkflowStore.getState();
    expect(nodes.map((node) => node.type)).toEqual(["prompt", "nanoBanana", "output"]);
    const [prompt, generator, output] = nodes;
    expect(prompt.data).toMatchObject({ prompt: "A banana astronaut feeding a monkey in orbit" });
    expect(edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle])).toEqual([
      [prompt.id, "text", generator.id, "text"],
      [generator.id, "image", output.id, "image"],
    ]);
    expectValidEdges();
    // Width-driven layout: new nodes carry a width only; React Flow measures the height.
    expect(nodes.every((node) => node.width && node.style?.width === node.width && !node.measured)).toBe(true);
    expect(nodes.every((node, i) => i === 0 || node.position.x > nodes[i - 1].position.x)).toBe(true);
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(true);

    // Turn 2: Codex-style namespaced name, arguments as a JSON string.
    const second = scriptedHarness(async function* (params) {
      yield { type: "session", sessionId: "session-1" };
      const result = await params.tools.execute(
        "node_banana.edit_workflow",
        JSON.stringify({
          operations: [
            { op: "update_node", node: prompt.id, settings: { prompt: "A banana astronaut on Mars" } },
            { op: "update_node", node: generator.id, settings: { aspectRatio: "16:9" } },
          ],
        })
      );
      expect(result.ok).toBe(true);
      yield { type: "text-delta", id: "t3", delta: "Updated." };
      yield { type: "text-end", id: "t3" };
    });

    const user2: AgentUIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "Mars, and 16:9" }] };
    const turn2 = await runPanelTurn(second.harness, [user1, turn1.message, user2]);

    // Resumed session, history from the first turn, the live canvas with the node ids.
    expect(turn2.body.sessionId).toBe("session-1");
    const params2 = second.turns[0];
    expect(params2.sessionId).toBe("session-1");
    expect(params2.history).toEqual([
      { role: "user", text: "Make a text-to-image workflow" },
      { role: "assistant", text: "Building it now.\n\nDone. Press Run." },
    ]);
    for (const node of nodes) expect(params2.prompt).toContain(node.id);
    expect(turn2.body.workflow.nodes.find((node) => node.id === prompt.id)?.data).toMatchObject({
      prompt: "A banana astronaut feeding a monkey in orbit",
    });

    expect(turn2.batches.flatMap((batch) => batch.ops.map((op) => [op.op, "id" in op ? op.id : null]))).toEqual([
      ["updateNode", prompt.id],
      ["updateNode", generator.id],
    ]);
    const after = useWorkflowStore.getState();
    expect(after.nodes.find((node) => node.id === prompt.id)?.data).toMatchObject({ prompt: "A banana astronaut on Mars" });
    expect(after.nodes.find((node) => node.id === generator.id)?.data).toMatchObject({ aspectRatio: "16:9" });
    expect(after.edges).toHaveLength(2);
    expectValidEdges();
  });

  it("builds a grouped workflow through the real bridge, then renames a group in the next turn", async () => {
    const first = scriptedHarness(async function* (params) {
      const result = await params.tools.execute("mcp__node_banana__create_workflow", {
        nodes: [
          { ref: "sp", type: "prompt", settings: { prompt: "A misty harbour at dawn, wide establishing shot" } },
          { ref: "sg", type: "nanoBanana" },
          { ref: "fp", type: "prompt", settings: { prompt: "Slow push in across the water" } },
          { ref: "fv", type: "generateVideo" },
          { ref: "fo", type: "output" },
        ],
        connections: [
          { from: "sp", to: "sg" },
          { from: "sg", to: "fv" },
          { from: "fp", to: "fv" },
          { from: "fv", to: "fo" },
        ],
        groups: [
          { name: "Scene set", color: "blue", nodes: ["sp", "sg"] },
          { name: "Hero film", color: "purple", nodes: ["fp", "fv", "fo"] },
        ],
      });
      expect(result.ok, result.text).toBe(true);
      yield { type: "text-delta", id: "t", delta: "Grouped into Scene set and Hero film." };
      yield { type: "text-end", id: "t" };
    });
    const user1: AgentUIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "A harbour scene, then a hero film of it" }] };
    const turn1 = await runPanelTurn(first.harness, [user1]);
    expect(turn1.batches).toHaveLength(1);
    let { nodes, groups } = useWorkflowStore.getState();
    expect(Object.values(groups).map((g) => [g.id, g.name, g.color])).toEqual([
      ["group-ag1", "Scene set", "blue"],
      ["group-ag2", "Hero film", "purple"],
    ]);
    expect(nodes.map((n) => n.groupId)).toEqual(["group-ag1", "group-ag1", "group-ag2", "group-ag2", "group-ag2"]);
    expectValidEdges();

    // The next turn sees the groups in its canvas block and edits one by name.
    const second = scriptedHarness(async function* (params) {
      expect(params.prompt).toContain("- Scene set [group-ag1] blue box");
      const result = await params.tools.execute("node_banana.edit_workflow", JSON.stringify({ operations: [{ op: "update_group", group: "Scene set", name: "Establishing shot", color: "green" }] }));
      expect(result.ok, result.text).toBe(true);
      yield { type: "text-delta", id: "t", delta: "Renamed." };
      yield { type: "text-end", id: "t" };
    });
    const turn2 = await runPanelTurn(second.harness, [user1, turn1.message, { id: "u2", role: "user", parts: [{ type: "text", text: "Call the first one Establishing shot, in green" }] }]);
    expect(turn2.batches.flatMap((b) => b.ops)).toEqual([{ op: "updateGroup", id: "group-ag1", name: "Establishing shot", color: "green" }]);
    ({ nodes, groups } = useWorkflowStore.getState());
    expect(groups["group-ag1"]).toMatchObject({ name: "Establishing shot", color: "green" });
    expect(nodes.filter((n) => n.groupId === "group-ag1")).toHaveLength(2);
  });

  it("switches a generator to an OpenAI model found by search, as the store and the next turn see it", async () => {
    // The OpenAI and Gemini catalogs and schemas are fixed: no request goes out.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no network in this test");
    });
    try {
      useWorkflowStore.setState({
        nodes: [
          { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: { ...createDefaultNodeData("prompt"), prompt: "a lighthouse at dawn" } },
          { id: "nanoBanana-2", type: "nanoBanana", position: { x: 400, y: 0 }, data: { ...createDefaultNodeData("nanoBanana") } },
        ] as never,
        edges: [{ id: "edge-prompt-1-nanoBanana-2-text-text", source: "prompt-1", sourceHandle: "text", target: "nanoBanana-2", targetHandle: "text" }],
      });
      const before = useWorkflowStore.getState();
      const keys = { openai: "sk-e2e-openai-key" };
      const first = scriptedHarness(async function* (params) {
        const search = await params.tools.execute("mcp__node_banana__search_models", { nodeType: "nanoBanana", query: "gpt 2.5 flare" });
        expect(search.text).toContain("- openai gpt-image-2.5-flare");
        const result = await params.tools.execute("mcp__node_banana__update_node", {
          node: "nanoBanana-2",
          settings: { model: "gpt-image-2.5-flare", modelParameters: { quality: "high" } },
        });
        expect(result.ok, result.text).toBe(true);
        yield { type: "text-delta", id: "t", delta: "Switched it to GPT Image 2.5 Flare." };
        yield { type: "text-end", id: "t" };
      });
      const turn = await runPanelTurn(first.harness, [{ id: "u1", role: "user", parts: [{ type: "text", text: "Switch this generator to OpenAI GPT Image 2.5 Flare." }] }], keys);

      // The store holds exactly what the node shows once rendered.
      const schema = await getModelSchema("openai", "gpt-image-2.5-flare", {});
      if (!schema.ok) throw new Error(schema.error);
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === "nanoBanana-2")!;
      expect(node.data).toMatchObject({
        selectedModel: { provider: "openai", modelId: "gpt-image-2.5-flare", displayName: "GPT Image 2.5 Flare" },
        parameters: { size: "auto", quality: "high", background: "auto", output_format: "png", output_compression: 100 },
      });
      expect(sameInputSchema(node.data.inputSchema as ModelInputDef[], schema.inputs)).toBe(true);
      expectValidEdges();

      // The store's action and the pure replay agree.
      const replayed = applyGraphOps({ nodes: before.nodes, edges: before.edges, groups: before.groups }, turn.batches.flatMap((b) => b.ops), {
        createDefaultNodeData: (type) => createDefaultNodeData(type),
        defaultNodeDimensions,
        now: () => 1,
      });
      expect(replayed.nodes.find((n) => n.id === "nanoBanana-2")!.data).toEqual(node.data);

      // Keys went to the tools only.
      const { tools: _tools, signal: _signal, ...seen } = first.turns[0];
      expect(JSON.stringify([seen, turn.chunks, turn.message])).not.toContain(keys.openai);

      // The next turn's canvas names the model and its settings.
      const second = scriptedHarness(async function* (params) {
        expect(params.prompt).toContain('model "GPT Image 2.5 Flare" (openai gpt-image-2.5-flare), modelParameters size "auto", quality "high"');
        yield { type: "text-delta", id: "t", delta: "It uses GPT Image 2.5 Flare." };
        yield { type: "text-end", id: "t" };
      });
      await runPanelTurn(second.harness, [{ id: "u2", role: "user", parts: [{ type: "text", text: "Which model is it on?" }] }], keys);
      expect(second.turns).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports a rejected tool call as a tool error and leaves the canvas alone", async () => {
    const { harness } = scriptedHarness(async function* (params) {
      const result = await params.tools.execute("update_node", { node: "nope-1", settings: { prompt: "x" } });
      expect(result.ok).toBe(false);
      yield { type: "text-delta", id: "t", delta: "That node does not exist." };
      yield { type: "text-end", id: "t" };
    });
    const turn = await runPanelTurn(harness, [{ id: "u", role: "user", parts: [{ type: "text", text: "change it" }] }]);
    expect(turn.batches).toEqual([]);
    expect(turn.message.parts.find((part) => part.type === "dynamic-tool")).toMatchObject({ state: "output-error", title: "Update node" });
    expect(useWorkflowStore.getState().nodes).toEqual([]);
  });
});
