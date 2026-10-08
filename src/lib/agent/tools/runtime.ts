/**
 * The tool runtime for one agent turn.
 *
 * Tools read and edit a private draft seeded from the browser's snapshot, so
 * results are immediate and later calls in the same turn see earlier edits.
 * Mutating tools return the resolved graph ops the browser replays. Each open
 * tab the turn works in has a draft of its own; switching, opening and saving
 * tabs are steps the browser takes in order with the edits around them. At the
 * end of the turn, runOffer says what the chat's Run button should run.
 * Nothing here throws: bad arguments, invalid edits and internal failures all
 * come back as `ok: false` with text the model can act on.
 */

import { generateId } from "ai";
import { z } from "zod";
import type { NodeType, WorkflowEdge, WorkflowNode } from "@/types";
import type { ProviderKeys } from "@/lib/providers/keys";
import { groupNodesByLevel } from "@/store/utils/executionUtils";
import { clampRunCount, type RunScope } from "@/store/utils/runBatch";
import type {
  AgentRunOffer,
  AgentRunOption,
  AgentTabSummary,
  AgentToolDefinition,
  AgentToolResult,
  AgentToolRuntime,
  AgentWorkflowSnapshot,
} from "../types";
import { findNodeType, NODE_CATALOG, NODE_TYPES, normalizeKey } from "../graph/catalog";
import { describeNodeTypes, describeWorkflow, edgeLine, nodeLine, tabName } from "../graph/describe";
import { GraphDraft, groupLabel, titleOf, type DraftEdge, type DraftNode, type DraftTransaction, type GraphDraftOptions, type RemovedNode } from "../graph/draft";
import { graphPreview } from "../graph/preview";
import { isModelNodeType } from "../graph/settings";
import {
  AGENT_TOOL_DEFINITIONS,
  TOOL_NAMES,
  arrangeWorkflowShape,
  createWorkflowShape,
  describeNodeTypesShape,
  editWorkflowShape,
  getPromptGuideShape,
  getWorkflowShape,
  newWorkflowShape,
  runWorkflowShape,
  saveWorkflowShape,
  searchModelsShape,
  switchWorkflowShape,
  updateNodeShape,
} from "./definitions";
import { AgentModels, type ModelRequest, type ModelSource } from "./modelSearch";
import { PROMPT_NODE_MODALITY, renderPromptGuide, type PromptGuideInput } from "../prompting";
import { audioTaskOf } from "../prompting/modelNotes";
import { filePromptNotesStore, type PromptNotesStore } from "../prompting/notesStore";

const SUMMARY_MAX = 80;
const GET_WORKFLOW_MAX_NODES = 150;
const GENERATOR_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generate3d", "generateAudio", "llmGenerate", "comfyApp"]);
/** Nodes whose content is the user's own upload rather than a result. */
const UPLOAD_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["imageInput", "audioInput", "videoInput"]);

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export interface AgentToolRuntimeOptions extends Omit<GraphDraftOptions, "models"> {
  /**
   * The user's provider keys for this turn (from the chat request's headers,
   * else the server's .env). Used only to list models and read their
   * schemas; never written into any tool text.
   */
  providerKeys?: ProviderKeys;
  /** The turn's signal: model lookups stop when the turn is stopped. */
  signal?: AbortSignal;
  /** Where models come from; the provider registry by default. */
  modelSource?: ModelSource;
  /** Prompting notes the user saved per model; ~/.node-banana/prompt-notes by default. */
  promptNotes?: PromptNotesStore;
  /** Every open workflow tab, in strip order (the request's `tabs`). Without it the tab tools are refused. */
  tabs?: AgentTabSummary[];
  /** Media-free snapshots of the parked tabs, by tab id: a tab's draft is built from its snapshot when the turn first switches to it. */
  parkedWorkflows?: Record<string, AgentWorkflowSnapshot>;
}

/** Tools that change the canvas, and so may set models. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([TOOL_NAMES.createWorkflow, TOOL_NAMES.editWorkflow, TOOL_NAMES.updateNode]);
/** Tools that change the draft: a tab step waits for them, and they wait for one. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([...MUTATING_TOOLS, TOOL_NAMES.arrangeWorkflow]);
/** Tools that change the open workflows (`workspace` results), one after another with the edits around them. */
const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([TOOL_NAMES.switchWorkflow, TOOL_NAMES.newWorkflow, TOOL_NAMES.saveWorkflow]);
/** What a workflow built from scratch, and never saved, tells the agent to do next. */
const SAVE_NEW_WORKFLOW =
  "This is a new workflow and it is not saved: once it is built, and before any run, save it with save_workflow, named for what it makes (keep a name it already has), unless the user said not to.";
/** The tool search_models replaced; old sessions may still call it. */
const LIST_MODELS_ALIAS = "list_models";
const ignore = () => undefined;
/**
 * A macrotask after `promises` settle: by then each of their results has been
 * written to the stream (chatStream writes a result as soon as it resolves),
 * so what waited on them reaches the browser after them.
 */
const settled = (...promises: Promise<unknown>[]) =>
  Promise.all(promises.map((promise) => promise.catch(ignore))).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * One runtime per turn. Tools read and edit a private draft seeded from the
 * snapshot, so later calls in the same turn see earlier edits; with the open
 * tabs given, each tab the turn works in gets its own draft.
 */
export function createAgentToolRuntime(snapshot: AgentWorkflowSnapshot, options: AgentToolRuntimeOptions = {}): AgentToolRuntime {
  const { providerKeys, signal, modelSource, promptNotes, tabs, parkedWorkflows, ...draftOptions } = options;
  const models = new AgentModels(providerKeys ?? {}, { source: modelSource, signal });
  const live = snapshot ?? { nodes: [], edges: [], groups: [], selectedNodeIds: [] };
  const workspace = new TurnWorkspace(live, { tabs, parkedWorkflows }, (seed) => new GraphDraft(seed, { ...draftOptions, models }));
  // A run started (or is being started) this turn: the canvas must stay as the run found it.
  let runStarted = false;
  let runsStarting = 0;
  // Draft edits still being resolved; a run or a tab step waits for them, so its result follows theirs.
  let editsInFlight: Promise<unknown> = Promise.resolve();
  // The last tab step; edits and reads wait for it, so none lands on the tab it is leaving.
  let workspaceStep: Promise<unknown> = Promise.resolve();

  const handlers: Record<string, (args: unknown, draft: GraphDraft) => AgentToolResult | Promise<AgentToolResult>> = {
    [TOOL_NAMES.getWorkflow]: (args, draft) => getWorkflow(draft, args as Args<typeof getWorkflowShape>),
    [TOOL_NAMES.describeNodeTypes]: (args) => describeTypes(args as Args<typeof describeNodeTypesShape>),
    [TOOL_NAMES.searchModels]: (args) => searchModels(models, args as Args<typeof searchModelsShape>),
    [TOOL_NAMES.getPromptGuide]: (args, draft) =>
      getPromptGuide(draft, models, promptNotes ?? filePromptNotesStore(), args as Args<typeof getPromptGuideShape>),
    [TOOL_NAMES.createWorkflow]: (args, draft) => createWorkflow(draft, args as Args<typeof createWorkflowShape>),
    [TOOL_NAMES.editWorkflow]: (args, draft) => editWorkflow(draft, args as Args<typeof editWorkflowShape>),
    [TOOL_NAMES.updateNode]: (args, draft) => updateNode(draft, args as Args<typeof updateNodeShape>),
    [TOOL_NAMES.arrangeWorkflow]: (args, draft) => arrangeWorkflow(draft, args as Args<typeof arrangeWorkflowShape>),
    [TOOL_NAMES.switchWorkflow]: (args) => workspace.switchTo((args as Args<typeof switchWorkflowShape>).tab),
    [TOOL_NAMES.newWorkflow]: (args) => workspace.open((args as Args<typeof newWorkflowShape>).name),
    [TOOL_NAMES.saveWorkflow]: (args) => workspace.save((args as Args<typeof saveWorkflowShape>).name),
    // The label itself reaches the chat history through the stream (chatStream); the model only needs an ack.
    [TOOL_NAMES.nameConversation]: () => ({ ok: true, text: "Saved.", summary: "Named the conversation", ops: [] }),
  };
  const schemas = new Map(AGENT_TOOL_DEFINITIONS.map((d) => [d.name, z.object(d.inputShape)]));
  // Tabs this turn built a workflow in: their later edits carry the graph too, so the chat's map ends as the turn left it.
  const builtTabs = new Set<string | undefined>();
  /** Runs a handler on the live tab's draft, its result stamped with that tab. */
  const onLiveTab = async (tool: string, args: unknown) => {
    const tabId = workspace.currentId;
    const draft = workspace.draft;
    const startedEmpty = draft.nodes.size === 0;
    const result = workspace.stamp(await handlers[tool](args, draft), tabId);
    if (!result.ok || result.ops.length === 0 || !EDIT_TOOLS.has(tool)) return result;
    let text = result.text;
    if (tool === TOOL_NAMES.createWorkflow) {
      builtTabs.add(tabId);
      // Built from scratch where no save will follow by itself: the agent saves it, as a user would.
      const fromScratch = (startedEmpty || result.replacedCanvas) && draft.nodes.size > 1;
      if (fromScratch && workspace.isSaved(tabId) === false) text = `${text}\n${SAVE_NEW_WORKFLOW}`;
    } else if (!builtTabs.has(tabId)) {
      return result;
    }
    const graph = graphPreview(draft);
    return { ...result, text, ...(graph ? { graph } : {}) };
  };

  return {
    definitions: AGENT_TOOL_DEFINITIONS,
    async execute(name: string, args: unknown): Promise<AgentToolResult> {
      if (bareToolName(name) === LIST_MODELS_ALIAS) {
        name = TOOL_NAMES.searchModels;
        args = listModelsArgs(normalizeArgs(args));
      }
      const definition = findDefinition(name);
      if (!definition) {
        return workspace.stamp(failure(
          `Unknown tool "${name}". Available tools: ${AGENT_TOOL_DEFINITIONS.map((d) => d.name).join(", ")}.`,
          `Unknown tool ${name}`,
        ));
      }
      const tool = definition.name;
      try {
        const parsed = schemas.get(tool)!.safeParse(normalizeArgs(args));
        if (!parsed.success) {
          return workspace.stamp(failure(formatZodError(definition, parsed.error), `Invalid arguments for ${tool}`));
        }
        if (MUTATING_TOOLS.has(tool) && (runStarted || runsStarting > 0)) {
          return workspace.stamp(failure(
            `Nothing was changed: you started a run earlier in this turn, and ${tool} would change the canvas under it. Tell the user what you started; make this change in a later message, once the run has finished.`,
            "Not changed: a run started this turn",
          ));
        }
        if (WORKSPACE_TOOLS.has(tool)) {
          const refused = tool === TOOL_NAMES.saveWorkflow ? null : tabChangeRefusal(live.running === true, runStarted || runsStarting > 0);
          if (refused) return workspace.stamp(refused);
          // Stamped with the tab the step leaves live.
          const step = settled(editsInFlight, workspaceStep).then(async () => workspace.stamp(await handlers[tool](parsed.data, workspace.draft)));
          workspaceStep = settled(step);
          return await step;
        }
        if (EDIT_TOOLS.has(tool)) {
          const edit = workspaceStep.then(async () => {
            // Settings resolve synchronously inside the batch: look up every model it names first.
            if (MUTATING_TOOLS.has(tool)) await models.prepare(modelRequests(tool, parsed.data, workspace.draft));
            return onLiveTab(tool, parsed.data);
          });
          editsInFlight = Promise.all([editsInFlight, edit.catch(ignore)]);
          return await edit;
        }
        if (tool === TOOL_NAMES.runWorkflow) {
          runsStarting++;
          try {
            await settled(editsInFlight, workspaceStep);
            const result = runWorkflow(workspace.draft, parsed.data as Args<typeof runWorkflowShape>, runStarted);
            if (result.ok) runStarted = true;
            return workspace.stamp(result);
          } finally {
            runsStarting--;
          }
        }
        if (tool !== TOOL_NAMES.nameConversation) await workspaceStep;
        return await onLiveTab(tool, parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return workspace.stamp(failure(`${tool} failed unexpectedly (${message}). No changes were made; try again, or with fewer operations.`, `${definition.title} failed`));
      }
    },
    runOffer() {
      if (runStarted || runsStarting > 0 || live.running === true) return null;
      return buildRunOffer(workspace.draft, workspace.currentId);
    },
  };
}

/** Why the open workflows can't change now (a run is going, or this turn started one), or null. */
function tabChangeRefusal(running: boolean, startedThisTurn: boolean): AgentToolResult | null {
  if (running) {
    return failure(
      "Nothing was changed: a run is going on the canvas, and the open workflows can't change until it finishes. Keep working in the live workflow, or tell the user to try again once the run is done.",
      "Not changed: a run is going",
    );
  }
  if (startedThisTurn) {
    return failure(
      "Nothing was changed: you started a run earlier in this turn, and the open workflows can't change while it goes. Tell the user what you started; do this in a later message, once the run has finished.",
      "Not changed: a run started this turn",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Open workflows
// ---------------------------------------------------------------------------

/**
 * The open workflow tabs as one turn sees them: a draft per tab it has worked
 * in (built from the tab's parked snapshot the first time), and the live one,
 * which every other tool works on.
 */
class TurnWorkspace {
  /** The id of the tab live in the canvas; undefined when the snapshot named none. */
  currentId: string | undefined;
  private readonly tabs: AgentTabSummary[] | undefined;
  private readonly drafts = new Map<string | undefined, GraphDraft>();

  constructor(
    private readonly live: AgentWorkflowSnapshot,
    private readonly request: Pick<AgentToolRuntimeOptions, "tabs" | "parkedWorkflows">,
    private readonly makeDraft: (snapshot: AgentWorkflowSnapshot) => GraphDraft,
  ) {
    this.tabs = request.tabs?.map((tab) => ({ ...tab }));
    this.currentId = live.tabId ?? this.tabs?.find((tab) => tab.active)?.id;
    this.drafts.set(this.currentId, makeDraft(live));
  }

  get draft(): GraphDraft {
    return this.drafts.get(this.currentId)!;
  }

  /** The tab has a project folder, or this turn saved it; undefined without the tab strip, where nothing can be saved. */
  isSaved(tabId: string | undefined): boolean | undefined {
    if (!this.tabs) return undefined;
    return this.tabs.find((tab) => tab.id === tabId)?.saved === true;
  }

  /** The result as the tab it worked in reports it. */
  stamp(result: AgentToolResult, tabId = this.currentId): AgentToolResult {
    return tabId ? { ...result, tabId } : result;
  }

  switchTo(key: string): AgentToolResult {
    if (!this.tabs || !this.currentId) return tabsUnavailable();
    const found = this.find(key);
    if ("error" in found) return failure(found.error, "No such workflow");
    const tab = found.tab;
    const label = `${tabName(this.summaryOf(tab))} (${tab.id})`;
    if (tab.id === this.currentId) {
      return { ok: true, text: `${label} is already the live workflow; nothing changed.`, summary: clip(`Already in ${this.summaryOf(tab).name ?? "this workflow"}`), ops: [] };
    }
    const draft = this.draftFor(tab);
    if (!draft) {
      return failure(
        `Nothing was switched: the browser sent no picture of ${label}'s ${tab.nodeCount} nodes, so you can't work in it this turn. Ask the user to open that tab and send the message again.`,
        "Could not read that workflow",
      );
    }
    this.currentId = tab.id;
    const text = [
      `Switched to ${label}: the user's canvas shows it now, and your next tool calls read and edit it.`,
      describeWorkflow(draft, { detail: "summary", maxNodes: GET_WORKFLOW_MAX_NODES }),
    ].join("\n");
    return { ok: true, text, summary: clip(`Switched to ${draft.workflowName ?? "an untitled workflow"}`), ops: [], workspace: { op: "switchTab", tabId: tab.id } };
  }

  open(requestedName: string | undefined): AgentToolResult {
    if (!this.tabs || !this.currentId) return tabsUnavailable();
    const name = requestedName?.trim().slice(0, TAB_NAME_MAX) || undefined;
    const id = this.newTabId();
    const left = this.currentId;
    this.tabs.push({ id, ...(name ? { name } : {}), nodeCount: 0 });
    this.drafts.set(
      id,
      this.makeDraft({
        nodes: [],
        edges: [],
        groups: [],
        selectedNodeIds: [],
        ...(this.live.viewport ? { viewport: this.live.viewport } : {}),
        ...(this.live.nodeDefaults ? { nodeDefaults: this.live.nodeDefaults } : {}),
        ...(name ? { workflowName: name } : {}),
      }),
    );
    this.currentId = id;
    return {
      ok: true,
      text: `Opened a new, empty workflow${name ? ` "${name}"` : ""} in tab ${id}. It is the live one now: your next tool calls build in it. The workflow you were in stays open in tab ${left}.`,
      summary: clip(name ? `Opened ${name}` : "Opened a new workflow"),
      ops: [],
      workspace: { op: "newTab", tabId: id, ...(name ? { name } : {}) },
    };
  }

  save(requestedName: string | undefined): AgentToolResult {
    if (!this.tabs || !this.currentId) return tabsUnavailable();
    const tab = this.tabs.find((entry) => entry.id === this.currentId);
    const draft = this.draft;
    const given = requestedName?.trim().slice(0, TAB_NAME_MAX) || undefined;
    const current = draft.workflowName ?? tab?.name;
    // The browser saves it and tells the user itself if that fails: the model only says what it saved.
    const after =
      "The app saves it now, after your earlier edits, and tells the user itself if the save fails. Tell the user it is saved (as what); don't ask them to check.";
    if (tab?.saved) {
      const kept = given && given !== current ? " It keeps its name: saving never renames a workflow." : "";
      return {
        ok: true,
        text: `Saving ${tabName({ name: current })} into its project folder.${kept} ${after}`,
        summary: clip(`Saving ${current ?? "the workflow"}`),
        ops: [],
        workspace: { op: "save" },
      };
    }
    const name = given ?? current;
    if (!name) {
      return failure(
        "Nothing was saved: this workflow has never been saved and has no name. Call save_workflow again with name, a short project name for what it makes.",
        "Needs a name to save",
      );
    }
    // The browser names the workflow on its first save; later calls this turn see it as saved.
    draft.workflowName = name;
    if (tab) Object.assign(tab, { name, saved: true });
    return {
      ok: true,
      text: `Saving "${name}" as a new project. ${after}`,
      summary: clip(`Saving ${name}`),
      ops: [],
      workspace: { op: "save", ...(given ? { name: given } : {}) },
    };
  }

  /** A tab by id, else by a name that only one tab has (any case). */
  private find(key: string): { tab: AgentTabSummary } | { error: string } {
    const tabs = this.tabs ?? [];
    const wanted = key.trim();
    const byId = tabs.find((tab) => tab.id === wanted);
    if (byId) return { tab: byId };
    const named = tabs.filter((tab) => this.summaryOf(tab).name?.trim().toLowerCase() === wanted.toLowerCase());
    if (named.length === 1) return { tab: named[0] };
    const list = tabs.map((tab) => `${tab.id} ${tabName(this.summaryOf(tab))}`).join(", ");
    if (named.length > 1) return { error: `${named.length} open workflows are named "${wanted}": ${named.map((tab) => tab.id).join(", ")}. Pass the id of the one you mean.` };
    return { error: `No open workflow "${wanted}". Open workflows: ${list}. Pass one of those ids, or new_workflow for a new one.` };
  }

  /** A tab's summary with the name its draft has now (a first save names it). */
  private summaryOf(tab: AgentTabSummary): AgentTabSummary {
    const name = this.drafts.get(tab.id)?.workflowName ?? tab.name;
    return { ...tab, ...(name ? { name } : {}) };
  }

  /** The tab's draft, built from its parked snapshot the first time; null when it has nodes the browser did not describe. */
  private draftFor(tab: AgentTabSummary): GraphDraft | null {
    const existing = this.drafts.get(tab.id);
    if (existing) return existing;
    const parked = this.request.parkedWorkflows?.[tab.id];
    if (!parked && tab.nodeCount > 0) return null;
    const seed = parked ?? { nodes: [], edges: [], groups: [], selectedNodeIds: [] };
    const draft = this.makeDraft({
      ...seed,
      tabId: tab.id,
      viewport: seed.viewport ?? this.live.viewport,
      nodeDefaults: seed.nodeDefaults ?? this.live.nodeDefaults,
      workflowName: seed.workflowName ?? tab.name,
      // Only the live tab can be running.
      running: undefined,
    });
    this.drafts.set(tab.id, draft);
    return draft;
  }

  private newTabId(): string {
    const taken = (id: string) => this.drafts.has(id) || !!this.tabs?.some((tab) => tab.id === id);
    let id: string;
    do {
      id = `tab-ag${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    } while (taken(id));
    return id;
  }
}

const TAB_NAME_MAX = 120;

function tabsUnavailable(): AgentToolResult {
  return failure(
    "Nothing was changed: this message came without the list of open workflows, so you can't switch, open or save workflows in it. Keep working on the live canvas.",
    "Open workflows unavailable",
  );
}

/** Tool names may arrive prefixed by the harness (`mcp__node_banana__x`, `node_banana.x`). */
function findDefinition(name: string): AgentToolDefinition | undefined {
  const exact = AGENT_TOOL_DEFINITIONS.find((d) => d.name === name);
  if (exact) return exact;
  return AGENT_TOOL_DEFINITIONS.find((d) => d.name === bareToolName(name));
}

function bareToolName(name: string): string | undefined {
  return typeof name === "string" ? name.split(/__|[./]/).pop() : undefined;
}

/** list_models {kind} → search_models {nodeType}. */
function listModelsArgs(args: unknown): Record<string, unknown> {
  const kind = args && typeof args === "object" ? (args as { kind?: unknown }).kind : undefined;
  const nodeType = kind === "image" ? "nanoBanana" : kind === "video" ? "generateVideo" : kind === "llm" ? "llmGenerate" : undefined;
  return nodeType ? { nodeType } : {};
}

/**
 * The models a mutating call names (settings.model on generation nodes), and
 * the schemas of models a node already uses when only modelParameters
 * change. A node's type comes from the draft, or from the add_node of the
 * same call for a ref.
 */
function modelRequests(tool: string, args: unknown, draft: GraphDraft): ModelRequest[] {
  const requests: ModelRequest[] = [];
  const visit = (type: NodeType | undefined, settings: unknown, node?: DraftNode) => {
    if (!type || !settings || typeof settings !== "object" || Array.isArray(settings)) return;
    // A Split Grid's cells hold nodes of their own.
    if (type === "splitGrid") {
      const cells = settingValue(settings as Record<string, unknown>, "cells").value as { nodes?: unknown } | undefined;
      if (cells && Array.isArray(cells.nodes)) {
        for (const spec of cells.nodes) {
          const entry = spec as { type?: unknown; settings?: unknown } | null;
          visit(typeOf(entry?.type), entry?.settings);
        }
      }
      return;
    }
    if (!isModelNodeType(type)) return;
    const model = settingValue(settings as Record<string, unknown>, "model");
    if (model.present) {
      requests.push({ kind: "model", nodeType: type, value: model.value });
      return;
    }
    if (!settingValue(settings as Record<string, unknown>, "modelParameters").present) return;
    const data = node?.data ?? draft.options.createDefaultNodeData(type);
    const selected = data.selectedModel as { provider?: unknown; modelId?: unknown } | undefined;
    if (typeof selected?.provider === "string" && typeof selected.modelId === "string" && selected.modelId) {
      requests.push({ kind: "schema", provider: selected.provider, modelId: selected.modelId });
    }
  };
  const existing = (key: unknown): DraftNode | undefined => {
    if (typeof key !== "string") return undefined;
    const name = key.trim();
    return draft.nodes.get(name) ?? draft.nodes.get(draft.refs.get(name) ?? "");
  };
  const typeOf = (value: unknown) => (typeof value === "string" ? findNodeType(value) : undefined);

  if (tool === TOOL_NAMES.updateNode) {
    const { node, settings } = args as Args<typeof updateNodeShape>;
    const target = existing(node);
    visit(target?.type, settings, target);
  } else if (tool === TOOL_NAMES.createWorkflow) {
    for (const spec of (args as Args<typeof createWorkflowShape>).nodes ?? []) visit(typeOf(spec.type), spec.settings);
  } else if (tool === TOOL_NAMES.editWorkflow) {
    const operations = (args as Args<typeof editWorkflowShape>).operations ?? [];
    const refTypes = new Map<string, NodeType>();
    for (const op of operations) {
      if (op.op !== "add_node") continue;
      const type = typeOf(op.type);
      if (type && op.ref) refTypes.set(op.ref.trim(), type);
      visit(type, op.settings);
    }
    for (const op of operations) {
      if (op.op !== "update_node") continue;
      const target = existing(op.node);
      visit(target?.type ?? (typeof op.node === "string" ? refTypes.get(op.node.trim()) : undefined), op.settings, target);
    }
  }
  return requests;
}

/** A setting as the settings resolver finds it: exact name, else case- and separator-insensitive. */
function settingValue(settings: Record<string, unknown>, field: string): { present: boolean; value: unknown } {
  if (field in settings && settings[field] !== undefined) return { present: true, value: settings[field] };
  const key = Object.keys(settings).find((k) => normalizeKey(k) === normalizeKey(field) && settings[k] !== undefined);
  return key ? { present: true, value: settings[key] } : { present: false, value: undefined };
}

/**
 * Models occasionally send JSON-encoded strings where objects belong
 * (the whole argument object, `settings`, or a list). Decode those.
 */
export function normalizeArgs(args: unknown): unknown {
  const decode = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };
  const root = decode(args);
  if (root === undefined || root === null) return {};
  if (typeof root !== "object" || Array.isArray(root)) return root;
  const out: Record<string, unknown> = { ...(root as Record<string, unknown>) };
  for (const key of ["nodes", "connections", "operations", "groups", "nodeIds", "types", "settings"]) {
    if (key in out) out[key] = decode(out[key]);
  }
  for (const key of ["nodes", "operations"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((item) =>
        item && typeof item === "object" && "settings" in item
          ? { ...(item as Record<string, unknown>), settings: decode((item as Record<string, unknown>).settings) }
          : item,
      );
    }
  }
  return dropNulls(out) as Record<string, unknown>;
}

/**
 * Some models send `null` for every optional field they leave out (strict
 * function calling). Treat those as absent, except inside `settings`, where
 * null is a real value ("no size limit", "clear the variable name").
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) continue;
    out[key] = key === "settings" ? entry : dropNulls(entry);
  }
  return out;
}

function formatZodError(definition: AgentToolDefinition, error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(arguments)";
    return `- ${path}: ${issue.message}`;
  });
  return [`Invalid arguments for ${definition.name}; nothing was changed:`, ...issues, `Expected fields: ${Object.keys(definition.inputShape).join(", ")}.`].join("\n");
}

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

function getWorkflow(draft: GraphDraft, args: Args<typeof getWorkflowShape>): AgentToolResult {
  const text = describeWorkflow(draft, {
    nodeIds: args.nodeIds,
    detail: args.detail ?? "summary",
    // A whole huge canvas would flood the context; nodeIds reaches the rest.
    maxNodes: args.nodeIds?.length ? undefined : GET_WORKFLOW_MAX_NODES,
  });
  const count = args.nodeIds?.length ? `${args.nodeIds.filter((id) => draft.nodes.has(id)).length} of ${draft.nodes.size} nodes` : `${draft.nodes.size} nodes`;
  return { ok: true, text, summary: `Read the workflow (${count})`, ops: [] };
}

function describeTypes(args: Args<typeof describeNodeTypesShape>): AgentToolResult {
  const requested = args.types ?? [];
  const types: NodeType[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const type = findNodeType(name);
    if (type) {
      if (!types.includes(type)) types.push(type);
    } else unknown.push(name);
  }
  if (requested.length > 0 && types.length === 0) {
    return failure(`Unknown node type${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Types: ${NODE_TYPES.join(", ")}.`, "Unknown node types");
  }
  const lines = [describeNodeTypes(types)];
  if (unknown.length > 0) lines.push(`Unknown types skipped: ${unknown.join(", ")}. Types: ${NODE_TYPES.join(", ")}.`);
  const names = types.length > 0 ? types.join(", ") : "all node types";
  return { ok: true, text: lines.join("\n\n"), summary: clip(`Looked up ${names}`), ops: [] };
}

async function searchModels(models: AgentModels, args: Args<typeof searchModelsShape>): Promise<AgentToolResult> {
  const result = await models.search(args);
  return { ok: result.ok, text: result.text, summary: clip(result.summary), ops: [] };
}

async function getPromptGuide(
  draft: GraphDraft,
  models: AgentModels,
  notes: PromptNotesStore,
  args: Args<typeof getPromptGuideShape>,
): Promise<AgentToolResult> {
  const node = args.node ? (draft.getNode(args.node) ?? draft.getNode(draft.refs.get(args.node) ?? "")) : undefined;
  if (args.node && !node) return failure(`No node "${args.node}" on the canvas. Pass an id from the canvas, or nodeType for a node not made yet.`, "Node not found");
  const nodeType = node?.type ?? (args.nodeType ? findNodeType(args.nodeType) : undefined);
  if (!nodeType || !PROMPT_NODE_MODALITY[nodeType]) {
    return failure(
      `Pass node (a generator or LLM Generate on the canvas) or nodeType: one of ${Object.keys(PROMPT_NODE_MODALITY).join(", ")}.`,
      "No guide for that node",
    );
  }

  // A node not made yet starts with the user's saved model for its type: the guide is for that one.
  const modelValue = args.model
    ? args.provider
      ? { provider: args.provider, modelId: args.model }
      : args.model
    : nodeModelValue(node ?? { data: draft.options.createDefaultNodeData(nodeType) });
  let model: PromptGuideInput["model"];
  let modelProblem: string | undefined;
  if (modelValue !== undefined && isModelNodeType(nodeType)) {
    await models.prepare([{ kind: "model", nodeType, value: modelValue }]);
    const lookup = models.resolve(nodeType, modelValue);
    if (lookup?.ok) {
      model = { model: lookup.resolved.model, schema: lookup.resolved.schema };
    } else {
      modelProblem = lookup ? lookup.error : "the model could not be looked up";
    }
  } else if (isModelNodeType(nodeType)) {
    modelProblem = "no model chosen; the node will use the user's saved default";
  }

  const task =
    args.task ?? (node ? taskFromInputs(draft, node) : undefined) ?? (nodeType === "generateAudio" ? audioTaskOf(model?.model, model?.schema) : undefined);
  const savedNotes = model ? await notes.read(model.model.provider, model.model.id).catch(() => null) : null;
  const targetNodeType = args.target ? findNodeType(args.target) : undefined;
  const guide = renderPromptGuide({ nodeType, task, model, modelProblem, savedNotes, targetNodeType });
  if (!guide.ok) return failure(guide.text, "No such prompt guide");
  return { ok: true, text: guide.text, summary: clip(`Read the ${guide.task} prompt guide${model ? ` for ${model.model.name}` : ""}`), ops: [] };
}

/** A node's model as settings.model takes it: a provider pair, or a Gemini image id. */
function nodeModelValue(node: Pick<DraftNode, "data">): unknown {
  const selected = node.data.selectedModel as { provider?: unknown; modelId?: unknown } | undefined;
  if (selected && typeof selected.modelId === "string" && selected.modelId) {
    return typeof selected.provider === "string" && selected.provider ? { provider: selected.provider, modelId: selected.modelId } : selected.modelId;
  }
  return typeof node.data.model === "string" && node.data.model ? node.data.model : undefined;
}

/** The task a node's connected inputs imply: an edit when an image comes in, and so on. */
function taskFromInputs(draft: GraphDraft, node: DraftNode): string | undefined {
  const incoming = draft.edges.filter((edge) => edge.target === node.id);
  const count = (type: string) =>
    incoming.filter((edge) => {
      const handle = edge.targetHandle ?? "";
      if (handle) return handle.startsWith(type);
      const source = draft.getNode(edge.source);
      return source ? NODE_CATALOG[source.type].outputs[0]?.type === type : false;
    }).length;
  switch (node.type) {
    case "nanoBanana": {
      const images = count("image");
      return images > 1 ? "compose" : images === 1 ? "edit" : "generate";
    }
    case "generateVideo":
      return count("audio") > 0 ? "audio-to-video" : count("image") > 0 ? "image-to-video" : "text-to-video";
    case "generate3d":
      return count("image") > 0 ? "image-to-3d" : "text-to-3d";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

function createWorkflow(draft: GraphDraft, args: Args<typeof createWorkflowShape>): AgentToolResult {
  const nodes = args.nodes ?? [];
  const connections = args.connections ?? [];
  if (nodes.length === 0 && connections.length === 0 && !args.replaceCanvas) {
    return failure("create_workflow needs at least one node (or connection). Nothing was changed.", "Nothing to create");
  }
  // An empty canvas has nothing to replace: no removals, no "replaced canvas".
  const replace = !!args.replaceCanvas && draft.nodes.size > 0;
  const replacedCount = replace ? draft.nodes.size : 0;
  return runBatch(draft, TOOL_NAMES.createWorkflow, (tx) => {
    if (replace) tx.clearCanvas();
    nodes.forEach((spec, index) => {
      tx.addNode(spec, `nodes[${index}]${spec.ref ? ` (ref "${spec.ref}")` : ""}`);
    });
    connections.forEach((connection, index) => {
      tx.connect(connection, `connections[${index}] (${connection.from} → ${connection.to})`);
    });
    (args.groups ?? []).forEach((group, index) => {
      tx.createGroup(group, `groups[${index}]${group.name ? ` ("${group.name}")` : ""}`);
    });
  }, { replacedCount });
}

type EditOperation = Args<typeof editWorkflowShape>["operations"][number];

function editWorkflow(draft: GraphDraft, args: Args<typeof editWorkflowShape>): AgentToolResult {
  const operations = args.operations ?? [];
  if (operations.length === 0) {
    return failure("edit_workflow needs at least one operation. Nothing was changed.", "No operations");
  }
  return runBatch(draft, TOOL_NAMES.editWorkflow, (tx) => {
    const where = (op: EditOperation, index: number) => `operations[${index}] (${op.op})`;
    // add_node first, so refs can be used by any other operation in the list.
    operations.forEach((op, index) => {
      if (op.op !== "add_node") return;
      if (!op.type) {
        tx.errors.push(`${where(op, index)}: type is required (e.g. "prompt", "nanoBanana").`);
        return;
      }
      tx.addNode({ ref: op.ref, type: op.type, title: op.title, settings: op.settings, position: op.position }, where(op, index));
    });
    operations.forEach((op, index) => {
      const at = where(op, index);
      switch (op.op) {
        case "add_node":
          return;
        case "update_node":
          tx.updateNode(op.node, op.title, op.settings, at);
          return;
        case "remove_node":
          tx.removeNode(op.node, at);
          return;
        case "connect":
          if (!op.from || !op.to) {
            tx.errors.push(`${at}: connect needs from and to (node ids or refs).`);
            return;
          }
          tx.connect(
            { from: op.from, to: op.to, fromHandle: op.fromHandle, toHandle: op.toHandle, arrayItemIndex: op.arrayItemIndex, loop: op.loop, loopCount: op.loopCount },
            at,
          );
          return;
        case "disconnect":
          tx.disconnect({ edgeId: op.edgeId, from: op.from, to: op.to, fromHandle: op.fromHandle, toHandle: op.toHandle }, at);
          return;
        case "move_node":
          if (!op.position) {
            tx.errors.push(`${at}: move_node needs position {x, y}.`);
            return;
          }
          tx.moveNode(op.node, op.position, at);
          return;
        case "group":
          tx.createGroup({ nodes: nodeList(op), name: op.name ?? op.title ?? op.group, color: op.color }, at);
          return;
        case "ungroup":
          tx.removeGroup(op.group, at);
          return;
        case "update_group":
          tx.updateGroup(op.group, { name: op.name ?? op.title, color: op.color }, at);
          return;
        case "add_to_group":
          tx.addToGroup(nodeList(op), op.group, at);
          return;
        case "remove_from_group":
          tx.removeFromGroup(nodeList(op), at);
          return;
      }
    });
  });
}

/** The nodes a group operation names: `nodes`, or a single `node`. */
function nodeList(op: EditOperation): string[] | undefined {
  if (op.nodes && op.nodes.length > 0) return op.nodes;
  return op.node ? [op.node] : op.nodes;
}

function updateNode(draft: GraphDraft, args: Args<typeof updateNodeShape>): AgentToolResult {
  return runBatch(draft, TOOL_NAMES.updateNode, (tx) => {
    tx.updateNode(args.node, args.title, args.settings, "update_node");
  });
}

function arrangeWorkflow(draft: GraphDraft, args: Args<typeof arrangeWorkflowShape>): AgentToolResult {
  const requested = args.nodeIds ?? [];
  const missing = requested.filter((id) => !draft.nodes.has(id));
  if (missing.length > 0) {
    return failure(`Not on the canvas: ${missing.join(", ")}. Nothing was moved.`, "Unknown nodes");
  }
  if (draft.nodes.size === 0) {
    return { ok: true, text: "The canvas is empty; nothing to arrange.", summary: "Nothing to arrange", ops: [] };
  }
  // Groups move as units, their nodes tidied inside a refit box.
  return runBatch(draft, TOOL_NAMES.arrangeWorkflow, (tx) => tx.arrange(requested));
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Starts a run through the browser's runBatch (the `run` op). Validated here
 * against the draft, which already holds this turn's edits: a scope that
 * would find an input empty is refused with the nodes to include instead.
 */
function runWorkflow(draft: GraphDraft, args: Args<typeof runWorkflowShape>, alreadyStarted: boolean): AgentToolResult {
  if (alreadyStarted) {
    return failure("You already started a run in this turn; nothing more was started. Its results show on the canvas of the user's next message.", "Already started a run");
  }
  if (draft.running) {
    return failure(
      "A run is already going on the canvas, so nothing was started. Tell the user; the next message's canvas shows how it went, and you can start another run then if they ask.",
      "A run is already going",
    );
  }
  if (draft.nodes.size === 0) return failure("The canvas is empty: there is nothing to run.", "Nothing to run");
  const runs = clampRunCount(args.runs ?? 1);
  const times = runs > 1 ? ` ×${runs}` : "";
  const find = (key: string) => draft.getNode(key.trim()) ?? draft.getNode(draft.refs.get(key.trim()) ?? "");

  let scope: RunScope;
  let what: string;
  let summary: string;
  let ran: Set<string>;
  /** The nodes whose inputs must hold something: the scope, or what a "from" run leads to. */
  let checked: string[];
  // A whole-workflow run skips a locked group's nodes.
  const unlocked = (id: string) => !draft.getGroup(draft.getNode(id)?.groupId)?.locked;
  switch (args.scope) {
    case "all":
      scope = { kind: "all" };
      what = `the whole workflow (${draft.nodes.size} node${draft.nodes.size === 1 ? "" : "s"})`;
      summary = `Started the workflow${times}`;
      ran = new Set(draft.nodes.keys());
      checked = [...ran].filter(unlocked);
      break;
    case "nodes": {
      // A lone `node` is the same request.
      const keys = args.nodeIds ?? (args.node ? [args.node] : []);
      if (keys.length === 0) return failure('scope "nodes" needs nodeIds: the ids of the nodes to run. Nothing was started.', "No nodes to run");
      const missing = keys.filter((key) => !find(key));
      if (missing.length > 0) return failure(`Not on the canvas: ${missing.join(", ")}. Nothing was started.`, "Unknown nodes");
      const ids = [...new Set(keys.map((key) => find(key)!.id))];
      scope = { kind: "nodes", nodeIds: ids };
      what = ids.join(", ");
      summary = `Started ${ids.length === 1 ? nodeName(draft.getNode(ids[0])!) : `${ids.length} nodes`}${times}`;
      ran = new Set(ids);
      checked = ids;
      break;
    }
    case "from": {
      const key = args.node ?? (args.nodeIds?.length === 1 ? args.nodeIds[0] : undefined);
      if (!key) return failure('scope "from" needs node: the id of the node to start from. Nothing was started.', "No node to start from");
      const start = find(key);
      if (!start) return failure(`Not on the canvas: ${key}. Nothing was started.`, "Unknown node");
      scope = { kind: "from", nodeId: start.id };
      what = `from ${start.id} on`;
      summary = `Started from ${nodeName(start)}${times}`;
      ran = runsFrom(draft, start.id);
      checked = [...downstreamOf(draft, start.id)].filter((id) => ran.has(id) && unlocked(id));
      break;
    }
  }

  const problems = emptyInputs(draft, checked, ran);
  if (problems.length > 0) {
    return failure(
      [`Nothing was started: these inputs of the run would be empty.`, ...problems.map((problem) => `- ${problem}`)].join("\n"),
      "Inputs not ready",
    );
  }
  const text = [
    `Started a run of ${what}${runs > 1 ? `, ${runs} times one after another` : ""}. It runs on the user's canvas after your edits; you do not see its results in this turn.`,
    "Tell the user briefly what you started. The canvas in their next message shows each node's status, error and output: report how it went from that, never before.",
  ].join("\n");
  // What runs, for the chat's placeholders and Show on canvas: a "from" run
  // runs every later level, not only what it leads to.
  const planned = new Set(scope.kind === "from" ? [...ran].filter(unlocked) : checked);
  return { ok: true, text, summary: clip(summary), ops: [{ op: "run", scope, runs }], focusNodeIds: levelOrder(draft).filter((id) => planned.has(id)) };
}

/**
 * The Run button for what this turn built or changed in `draft`: the changed
 * nodes and everything they feed (outside locked groups), widened to their
 * group when they all sit in one and it can run, or the whole workflow when
 * the turn built it from empty or no narrower run can. Null when no generator
 * would run, or when nothing that includes the changes can run yet.
 */
function buildRunOffer(draft: GraphDraft, tabId: string | undefined): AgentRunOffer | null {
  const changed = [...draft.changedNodeIds].filter((id) => draft.nodes.has(id));
  if (changed.length === 0) return null;
  const unlocked = (id: string) => !draft.getGroup(draft.getNode(id)?.groupId)?.locked;
  const affected = new Set<string>();
  for (const id of changed) for (const reached of downstreamOf(draft, id)) if (unlocked(reached)) affected.add(reached);
  if (![...affected].some((id) => GENERATOR_TYPES.has(draft.getNode(id)!.type))) return null;

  const order = levelOrder(draft);
  const runnable = order.filter(unlocked);
  const whole = (label: string): AgentRunOption => ({ scope: { kind: "all" }, label, nodeIds: runnable });
  const wholeReady = emptyInputs(draft, runnable, new Set(draft.nodes.keys())).length === 0;
  const offer = (primary: AgentRunOption, alternatives: AgentRunOption[]): AgentRunOffer => ({
    offerId: `offer_${generateId()}`,
    ...(tabId ? { tabId } : {}),
    ...(draft.workflowName ? { workflowName: draft.workflowName } : {}),
    primary,
    alternatives,
  });

  const builtFromEmpty = draft.initialNodeIds.size === 0 || draft.canvasReplaced;
  for (const narrower of builtFromEmpty ? [] : changedScopes(draft, affected, order)) {
    // As many nodes as the whole workflow runs: that is the whole workflow, offered below.
    const isWhole = narrower.nodeIds.length >= runnable.length;
    if (isWhole && wholeReady) break;
    if (!isWhole && emptyInputs(draft, narrower.nodeIds, new Set(narrower.nodeIds)).length === 0) {
      return offer(narrower, wholeReady ? [whole("Run whole workflow")] : []);
    }
  }
  return wholeReady ? offer(whole("Run workflow"), []) : null;
}

/** The affected nodes as "nodes" runs, widest first: their group's when they all sit in one, then themselves. */
function changedScopes(draft: GraphDraft, affected: ReadonlySet<string>, order: string[]): AgentRunOption[] {
  const scope = (nodeIds: string[], label: string): AgentRunOption => ({ scope: { kind: "nodes", nodeIds }, label: clip(label), nodeIds });
  const scopes: AgentRunOption[] = [];
  const groupIds = new Set([...affected].map((id) => draft.getNode(id)?.groupId));
  const group = groupIds.size === 1 ? draft.getGroup([...groupIds][0]) : undefined;
  if (group) scopes.push(scope(order.filter((id) => draft.getNode(id)!.groupId === group.id), `Run ${group.name}`));
  const nodeIds = order.filter((id) => affected.has(id));
  // Viewers run but make nothing: the label names what does the work.
  const working = nodeIds.map((id) => draft.getNode(id)!).filter((node) => NODE_CATALOG[node.type].outputs.length > 0);
  scopes.push(scope(nodeIds, working.length === 1 ? `Run ${nodeName(working[0])}` : `Run ${working.length || nodeIds.length} changed nodes`));
  return scopes;
}

/** Every node in run order: by dependency level, as executeWorkflow orders the graph (loop edges left out). */
function levelOrder(draft: GraphDraft): string[] {
  const nodes = [...draft.nodes.values()] as unknown as WorkflowNode[];
  const edges = draft.edges.filter((edge) => !edge.data?.isLoop) as unknown as WorkflowEdge[];
  const order = groupNodesByLevel(nodes, edges).flatMap((level) => level.nodeIds);
  const placed = new Set(order);
  return [...order, ...[...draft.nodes.keys()].filter((id) => !placed.has(id))];
}

function nodeName(node: DraftNode): string {
  return titleOf(node) ?? NODE_CATALOG[node.type].displayName;
}

/**
 * What a run from `nodeId` runs: its dependency level and every later one,
 * as executeWorkflow orders the whole graph (loop edges left out).
 */
function runsFrom(draft: GraphDraft, nodeId: string): Set<string> {
  const nodes = [...draft.nodes.values()] as unknown as WorkflowNode[];
  const edges = draft.edges.filter((edge) => !edge.data?.isLoop) as unknown as WorkflowEdge[];
  const levels = groupNodesByLevel(nodes, edges);
  const start = levels.findIndex((level) => level.nodeIds.includes(nodeId));
  return new Set(levels.slice(Math.max(start, 0)).flatMap((level) => level.nodeIds));
}

/** The node and everything its outputs reach (loop edges left out). */
function downstreamOf(draft: GraphDraft, nodeId: string): Set<string> {
  const reached = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of draft.edges) {
      if (edge.source !== id || edge.data?.isLoop || reached.has(edge.target)) continue;
      reached.add(edge.target);
      queue.push(edge.target);
    }
  }
  return reached;
}

/**
 * What would leave the run's nodes reading nothing, each with its fix, read
 * as getConnectedInputs reads inputs: through a Router or Switch to what
 * feeds it, by the handle that carries the data.
 *
 * A node the run does not run must hold its output already; an upload or a
 * prompt must be filled whether or not it is in the run, since running it
 * fills nothing. A "nodes" run orders its nodes only by the wires between
 * them, so a Router, Switch or connected input left out between two of them
 * would let both start at once: it has to be in the run too.
 */
function emptyInputs(draft: GraphDraft, checked: readonly string[], ran: ReadonlySet<string>): string[] {
  const problems = new Map<string, string>();
  const ids = (nodes: DraftNode[]) => nodes.map((node) => node.id).join(", ");
  const visit = (edge: DraftEdge, target: string, via: DraftNode[], seen: Set<string>) => {
    const source = draft.getNode(edge.source);
    if (!source || problems.has(source.id) || seen.has(source.id)) return;
    seen.add(source.id);
    const feeds = `${source.id} (${nodeName(source)}) feeds ${target} but`;
    if ((source.type === "router" || source.type === "switch") && !ran.has(source.id)) {
      for (const next of inputEdges(draft, source, edge.sourceHandle)) visit(next, target, [...via, source], seen);
      return;
    }
    if (isFilledByUpstream(draft, source)) {
      // A connected input holds what its source hands it (a Split Grid cell's slice), once that has run.
      const fillers = inputEdges(draft, source).map((e) => draft.getNode(e.source)).filter((node): node is DraftNode => !!node);
      const idle = fillers.filter((node) => !ran.has(node.id));
      if (idle.length > 0) {
        problems.set(source.id, `${feeds} holds nothing until ${ids(idle)} runs: run from ${idle[0].id}, or run the whole workflow.`);
      } else if (!ran.has(source.id)) {
        problems.set(source.id, `${feeds} holds nothing until ${ids(fillers)} runs: include ${source.id} in the run too, so ${target} waits for it.`);
      }
      return;
    }
    const lack = missingOutput(source);
    if (lack === "upload") {
      problems.set(source.id, `${feeds} holds no upload: ask the user to upload one, or disconnect it if the run does not need it.`);
    } else if (lack === "text") {
      problems.set(source.id, `${feeds} has no text: write it first.`);
    } else if (!ran.has(source.id)) {
      if (lack) problems.set(source.id, `${feeds} has no output yet: include ${source.id} in the run (in nodeIds, or start from it), or run the whole workflow.`);
    } else if (via.length > 0) {
      const between = ids(via);
      problems.set(between, `${between} pass${via.length === 1 ? "es" : ""} ${source.id}'s output on to ${target}: include ${between} in the run too, so ${target} waits for ${source.id}.`);
    }
  };
  for (const id of checked) {
    const node = draft.getNode(id);
    // A viewer that gets nothing shows nothing and spends nothing.
    if (!node || NODE_CATALOG[node.type].outputs.length === 0) continue;
    for (const edge of inputEdges(draft, node)) visit(edge, id, [], new Set());
  }
  return [...problems.values()];
}

/**
 * The wires that bring `node` data: not loop edges (empty on the first pass),
 * not an Ease Curve's settings link. Through a Router, only the input of the
 * type that leaves on `routerType`.
 */
function inputEdges(draft: GraphDraft, node: DraftNode, routerType?: string | null): DraftEdge[] {
  return draft.edges.filter(
    (edge) =>
      edge.target === node.id &&
      !edge.data?.isLoop &&
      edge.targetHandle !== "easeCurve" &&
      !(node.type === "router" && routerType && edge.targetHandle !== routerType),
  );
}

/** An empty Image, Audio or Video Input wired to a source: it takes its media from there. */
function isFilledByUpstream(draft: GraphDraft, node: DraftNode): boolean {
  if (node.type !== "imageInput" && node.type !== "audioInput" && node.type !== "videoInput") return false;
  const content = node.content ?? {};
  return !(content.image || content.audio || content.video) && inputEdges(draft, node).length > 0;
}

/**
 * Why a node would hand its consumers nothing: an empty upload or prompt, or
 * no output because it has not run. Null when it holds something, when it is
 * an optional input left empty on purpose (the run skips what it feeds), or
 * when it passes nothing on by design (a Conditional Switch is a gate; a
 * Split Grid fills its cells' inputs instead).
 */
function missingOutput(node: DraftNode): "upload" | "text" | "output" | null {
  const filled = (value: unknown) => (typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0);
  const content = node.content ?? {};
  const holds = !!(content.image || content.video || content.audio || content.model3d || content.text);
  const optional = node.data.isOptional === true;
  switch (node.type) {
    case "imageInput":
    case "audioInput":
    case "videoInput":
      return holds || optional ? null : "upload";
    case "prompt":
      return filled(node.data.prompt) || optional ? null : "text";
    case "promptConstructor":
      return filled(node.data.template) || holds ? null : "text";
    case "array":
      return filled(node.data.outputItems) ? null : "output";
    case "conditionalSwitch":
    case "splitGrid":
      return null;
    default:
      return NODE_CATALOG[node.type].outputs.length === 0 || holds ? null : "output";
  }
}

// ---------------------------------------------------------------------------
// Batches and results
// ---------------------------------------------------------------------------

function runBatch(
  draft: GraphDraft,
  tool: string,
  build: (tx: DraftTransaction) => void,
  extra: { replacedCount?: number } = {},
): AgentToolResult {
  const tx = draft.begin();
  build(tx);
  if (tx.errors.length === 0) tx.finish();
  if (tx.errors.length > 0) {
    const text = [
      `No changes were made: ${tool} is all-or-nothing and ${tx.errors.length === 1 ? "this problem" : `these ${tx.errors.length} problems`} must be fixed first. Call ${tool} again with the fix (the canvas is unchanged).`,
      ...tx.errors.map((error, index) => `${index + 1}. ${error}`),
    ].join("\n");
    // "operations[2] (connect): X" → "X": the location is noise in a one-line summary.
    const first = tx.errors[0].replace(/^(?:[a-z_]+\[\d+\](?: \([^)]*\))?|update_node): /, "");
    return { ok: false, text, summary: clip(`Rejected: ${first}`), ops: [] };
  }
  draft.commit(tx);
  return successResult(draft, tx, extra.replacedCount ?? 0);
}

function successResult(draft: GraphDraft, tx: DraftTransaction, replacedCount: number): AgentToolResult {
  const log = tx.log;
  const created = log.created.filter((c) => draft.nodes.has(c.id));
  const updatedIds = [...log.changes.keys()].filter((id) => draft.nodes.has(id) && !created.some((c) => c.id === id));
  const lines: string[] = [];

  if (tx.cleared) lines.push(`Cleared the canvas (${replacedCount} node${replacedCount === 1 ? "" : "s"} removed; the user can undo it with Ctrl+Z, one step per change).`);
  if (created.length > 0) {
    lines.push("Added nodes:");
    for (const c of created) lines.push(`- ${c.ref ? `ref "${c.ref}" = ` : ""}${nodeLine(draft.nodes.get(c.id)!)}`);
  }
  if (updatedIds.length > 0) {
    lines.push("Updated:");
    for (const id of updatedIds) lines.push(`- ${id}: ${log.changes.get(id)!.join(", ")}`);
  }
  const removedNodes = tx.cleared ? [] : log.removedNodes;
  if (removedNodes.length > 0) {
    lines.push(`Removed nodes: ${removedNodes.map((n) => `${n.id}${n.title ? ` ("${n.title}")` : ""}`).join(", ")} (with their connections).`);
  }
  if (log.addedEdges.length > 0) {
    lines.push("Connected:");
    for (const edge of log.addedEdges) lines.push(`- ${edgeLine(edge)}`);
  }
  const removedNodeIds = new Set(log.removedNodes.map((n) => n.id));
  const disconnected = tx.cleared ? [] : log.removedEdges.filter((r) => !removedNodeIds.has(r.edge.source) && !removedNodeIds.has(r.edge.target));
  if (disconnected.length > 0) {
    lines.push("Disconnected:");
    for (const r of disconnected) lines.push(`- ${edgeLine(r.edge)}${r.reason ? ` (${r.reason})` : ""}`);
  }
  if (log.moved.length > 0) lines.push(`Moved: ${[...new Set(log.moved)].join(", ")}.`);
  const groupLines = describeGroupChanges(draft, tx);
  if (groupLines.length > 0) {
    lines.push("Groups:");
    for (const line of groupLines) lines.push(`- ${line}`);
  }
  if (log.notes.length > 0) lines.push(...log.notes.map((note) => `Note: ${note}`));
  if (tx.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of [...new Set(tx.warnings)]) lines.push(`- ${warning}`);
  }
  const hints = nextSteps(draft, created.map((c) => c.id), log.removedNodes);
  if (hints.length > 0) lines.push(`Next: ${hints.join(" ")}`);
  if (tx.ops.length === 0) lines.unshift("No changes were needed.");

  const focus = new Set<string>([
    ...created.map((c) => c.id),
    ...updatedIds,
    ...log.moved.filter((id) => draft.nodes.has(id)),
    ...log.groupedNodes.filter((id) => draft.nodes.has(id)),
  ]);
  if (focus.size === 0) {
    for (const edge of log.addedEdges) {
      focus.add(edge.source);
      focus.add(edge.target);
    }
  }
  return {
    ok: true,
    text: lines.join("\n"),
    summary: summarize(draft, tx, created.length, updatedIds, disconnected.length, replacedCount),
    ops: tx.ops,
    ...(focus.size > 0 || tx.cleared ? { focusNodeIds: tx.cleared ? [...draft.nodes.keys()] : [...focus] } : {}),
    ...(tx.cleared ? { replacedCanvas: true } : {}),
  };
}

function summarize(draft: GraphDraft, tx: DraftTransaction, created: number, updatedIds: string[], disconnected: number, replacedCount: number): string {
  if (tx.ops.length === 0) return "No changes needed";
  const log = tx.log;
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (created > 0) parts.push(`added ${plural(created, "node")}`);
  if (updatedIds.length === 1 && created === 0) {
    const node = draft.nodes.get(updatedIds[0])!;
    const fields = [...new Set(log.changes.get(updatedIds[0])!.map((c) => c.split(/[=\s]/)[0]))];
    parts.push(`updated ${titleOf(node) ?? NODE_CATALOG[node.type].displayName} (${fields.join(", ")})`);
  } else if (updatedIds.length > 0) {
    parts.push(`updated ${plural(updatedIds.length, "node")}`);
  }
  if (!tx.cleared && log.removedNodes.length > 0) parts.push(`removed ${plural(log.removedNodes.length, "node")}`);
  if (log.addedEdges.length > 0) parts.push(`${plural(log.addedEdges.length, "connection")}`);
  if (disconnected > 0) parts.push(`${disconnected} disconnected`);
  const newGroups = log.createdGroups.filter((id) => draft.getGroup(id));
  const removedGroups = log.removedGroups.filter((id) => !log.createdGroups.includes(id));
  if (newGroups.length > 0) parts.push(`${newGroups.length === 1 ? `grouped "${draft.getGroup(newGroups[0])!.name}"` : `${newGroups.length} groups`}`);
  if (removedGroups.length > 0 && !tx.cleared) parts.push(`removed ${plural(removedGroups.length, "group")}`);
  if (newGroups.length === 0 && removedGroups.length === 0 && log.groups.length > 0) parts.push("updated groups");
  if (log.moved.length > 0 && created === 0) parts.push(`moved ${plural(new Set(log.moved).size, "node")}`);
  let text = parts.join(", ") || "Updated the canvas";
  if (tx.cleared) text = `Replaced canvas (${replacedCount} removed): ${text}`;
  return clip(text.charAt(0).toUpperCase() + text.slice(1));
}

/** New groups with their nodes (as they ended up), then every other group change, in order. */
function describeGroupChanges(draft: GraphDraft, tx: DraftTransaction): string[] {
  const lines: string[] = [];
  for (const id of tx.log.createdGroups) {
    const group = draft.getGroup(id);
    if (!group) continue;
    const members = [...draft.nodes.values()].filter((n) => n.groupId === id).map((n) => n.id);
    const box = group.position && group.size ? `, box (${group.position.x}, ${group.position.y}) ${group.size.width}×${group.size.height}` : "";
    lines.push(`Created group ${groupLabel(group)} (${group.color ?? "neutral"}${box}): ${members.join(", ")}.`);
  }
  lines.push(...tx.log.groups);
  return lines;
}

/**
 * What to tell the user: first what was removed from their canvas (above all
 * uploads and results) and how to get it back, then what they have to do for
 * the nodes just created.
 */
function nextSteps(draft: GraphDraft, createdIds: string[], removed: RemovedNode[]): string[] {
  const types = new Set(createdIds.map((id) => draft.nodes.get(id)?.type).filter((t): t is NodeType => !!t));
  const hints: string[] = [];
  const theirs = removed.filter((n) => draft.initialNodeIds.has(n.id));
  if (theirs.length > 0) {
    const media = theirs.filter((n) => n.content && (n.content.image || n.content.video || n.content.audio || n.content.model3d));
    const named = media.slice(0, 6).map((n) => `${n.id}${n.title ? ` ("${n.title}")` : ""} (${heldContent(n)})`);
    const including = named.length > 0 ? `, including ${named.join(", ")}${media.length > named.length ? ` and ${media.length - named.length} more with media` : ""}` : "";
    hints.push(`Tell the user you removed ${theirs.length} of their nodes${including}, and that Ctrl+Z (one step per change) brings ${theirs.length === 1 ? "it" : "them"} back.`);
  }
  const uploads = createdIds.filter((id) => {
    const node = draft.nodes.get(id);
    if (!node || !["imageInput", "audioInput", "videoInput"].includes(node.type)) return false;
    return !draft.edges.some((e) => e.target === id);
  });
  if (uploads.length > 0) hints.push(`Tell the user to upload media into ${uploads.join(", ")}.`);
  const modelless = createdIds.filter((id) => {
    const node = draft.nodes.get(id);
    return (node?.type === "generate3d" || node?.type === "generateAudio") && !(node.data.selectedModel as { modelId?: string } | undefined)?.modelId;
  });
  if (modelless.length > 0) {
    hints.push(`${modelless.join(", ")} ha${modelless.length === 1 ? "s" : "ve"} no model: set one from search_models, or tell the user to pick one in the node (it needs a fal, Replicate, Kie, WaveSpeed or ComfyUI key).`);
  }
  if ([...types].some((t) => GENERATOR_TYPES.has(t))) {
    hints.push("Nothing has run yet: the user presses Run (Ctrl/Cmd+Enter), or asks you to run it.");
  }
  return hints;
}

/** What a removed node held, in the user's words. */
function heldContent(node: RemovedNode): string {
  const c = node.content ?? {};
  const made = UPLOAD_TYPES.has(node.type) ? "uploaded" : "generated";
  const kinds = [c.image && "image", c.video && "video", c.audio && "audio", c.model3d && "3D model"].filter(Boolean).join(" and ");
  return `${made} ${kinds}`;
}

function failure(text: string, summary: string): AgentToolResult {
  return { ok: false, text, summary: clip(summary), ops: [] };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}
