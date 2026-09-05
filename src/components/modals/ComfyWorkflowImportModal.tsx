"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ComfyMark } from "@/components/icons/ComfyMark";
import { ComfyNodePreview } from "./ComfyNodePreview";
import {
  ComfySettingsTab,
  useComfySettingsDraft,
} from "@/components/settings/ComfySettingsTab";
import { useSavedComfyNodes } from "@/hooks/useSavedComfyNodes";
import { buildComfyApp } from "@/lib/comfy/buildApp";
import { loaderInputType } from "@/lib/comfy/graph";
import {
  instantiateSavedComfyNode,
  removeSavedComfyNode,
  saveComfyNode,
  withDialledValues,
  type SavedComfyNode,
} from "@/lib/comfy/library";
import { inputFromCandidate, inputFromLoader, paramFromCandidate } from "@/lib/comfy/inspect";
import { bindingKey, withAppLabels } from "@/lib/comfy/reconfigure";
import {
  buildComfyHeaders,
  comfyConfigError,
  getComfySettings,
  saveComfySettings,
} from "@/lib/comfy/settings";
import type {
  ComfyAppDefinition,
  ComfyAppInput,
  ComfyAppOutput,
  ComfyGraph,
  ComfyInputType,
  ComfyNodeCandidate,
  ComfyOutputType,
  ComfyWidgetCandidate,
  ComfyWorkflowInspection,
} from "@/lib/comfy/types";

/** A workflow JSON handed to the dialog rather than picked from disk. */
export interface ComfyUpload {
  workflow: unknown;
  /** The original filename — it seeds the node's default name. */
  filename: string;
}

/** An already-attached workflow whose picks are being revisited. */
export interface ComfyReconfigureTarget {
  app: ComfyAppDefinition;
  /** The candidate list stored at import; re-derived from the graph if absent. */
  inspection?: ComfyWorkflowInspection;
}

interface ComfyWorkflowImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The confirmed contract, plus the candidate list it was chosen from.
   *
   * A saved node carries no candidate list when it was stored without one —
   * better to pass nothing and let the node re-read the graph than to hand it
   * an empty list, which reads as "this workflow exposes nothing".
   */
  onAttach: (
    app: ComfyAppDefinition,
    inspection: ComfyWorkflowInspection | undefined,
    meta?: { savedNodeId?: string }
  ) => void;
  /** Shown as the "replacing" hint when the node already has a workflow. */
  existingName?: string;
  /**
   * The library entry this node was created from, which turns the save action
   * into an update of that entry.
   */
  savedNodeId?: string;
  /**
   * The node's current settings. Folded into the defaults when saving, so a
   * saved node arrives dialled in rather than back at the workflow's own values.
   */
  paramValues?: Record<string, unknown>;
  /**
   * Set to skip the file/blueprint step and edit an attached workflow's picks
   * directly. The node's current selection is what gets pre-filled, not the
   * inspection's original suggestion.
   */
  reconfigure?: ComfyReconfigureTarget | null;
  /**
   * A workflow the user already handed over — dropped onto the canvas rather
   * than chosen here. Read as soon as the dialog opens, so it lands on the
   * picks with no second "choose a file" step.
   */
  upload?: ComfyUpload | null;
}

interface BlueprintListItem {
  id: string;
  name: string;
  nodePack: string;
  source: string;
}

type Inspection = ComfyWorkflowInspection & { graph: ComfyGraph };

/** How each detected widget is exposed on the node. */
type WidgetRole = "off" | "setting" | "input";

const INPUT_TYPE_LABEL: Record<ComfyInputType, string> = {
  image: "Image",
  text: "Text",
  audio: "Audio",
  video: "Video",
};

const OUTPUT_TYPE_LABEL: Record<ComfyOutputType, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
  "3d": "3D",
};


/** ComfyUI's own guide to preparing a workflow for this — inputs, outputs, saving. */
const APP_MODE_DOCS = "https://docs.comfy.org/interface/app-mode";

/** The dialog's one committing action, wherever the current step puts it. */
const PRIMARY_BUTTON =
  "px-4 py-2 text-sm rounded-lg bg-neutral-100 text-neutral-900 font-medium hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,scale] duration-150 active:scale-[0.96] disabled:active:scale-100";

/** Beside it: keeping this node is a different act from attaching it, and a
 *  second filled button would make the dialog ask twice which one you meant. */
const SECONDARY_BUTTON =
  "px-3 py-2 text-sm rounded-lg bg-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:active:scale-100";

/**
 * Import a ComfyUI workflow and confirm what it exposes.
 *
 * Two ways in: a workflow file the user already has (whatever ComfyUI saved —
 * no special export), or a Blueprint the connected engine already ships. Either
 * way the second step is the same: confirm the inputs, settings and outputs
 * that will become the node's handles.
 */
export function ComfyWorkflowImportModal({
  isOpen,
  onClose,
  onAttach,
  existingName,
  savedNodeId,
  paramValues,
  reconfigure,
  upload,
}: ComfyWorkflowImportModalProps) {
  const [tab, setTab] = useState<"file" | "blueprints" | "saved">("file");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [source, setSource] = useState<"upload" | "blueprint">("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingNodes, setMissingNodes] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Confirm-step state
  const [name, setName] = useState("");
  const [inputs, setInputs] = useState<ComfyAppInput[]>([]);
  const [outputs, setOutputs] = useState<ComfyAppOutput[]>([]);
  const [roles, setRoles] = useState<Record<string, WidgetRole>>({});

  // Blueprint list state
  const [blueprints, setBlueprints] = useState<BlueprintListItem[] | null>(null);
  const [blueprintError, setBlueprintError] = useState<string | null>(null);
  const [blueprintId, setBlueprintId] = useState("");

  // Saved-node library
  const savedNodes = useSavedComfyNodes();
  const [savedPick, setSavedPick] = useState("");
  /** The outcome of the last save, shown where the button is. */
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  // The two panels that take over the body: how to prepare a workflow, and
  // where it runs. Settings live here because this dialog is where a missing
  // key first shows up, and reporting a problem it cannot fix is a dead end.
  const [view, setView] = useState<"main" | "help" | "settings">("main");
  const showSettings = view === "settings";
  const showHelp = view === "help";
  const isMain = view === "main";
  const setShowSettings = (open: boolean | ((prev: boolean) => boolean)) =>
    setView((prev) =>
      (typeof open === "function" ? open(prev === "settings") : open) ? "settings" : "main"
    );
  const [settingsDraft, setSettingsDraft] = useComfySettingsDraft(showSettings);
  const [settingsSaved, setSettingsSaved] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const settings = useMemo(
    () => (isOpen ? getComfySettings() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOpen, settingsSaved]
  );
  const configError = settings ? comfyConfigError(settings) : null;

  // Escape belongs to the dialog, not to whatever happens to be focused. Bound
  // on the document because opening the dialog does not move focus into it —
  // a keydown on the page would otherwise never reach the panel.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  // Focus starts inside, so the first Tab continues through the dialog rather
  // than through the canvas behind it.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  /** Keep Tab inside the dialog: a modal the keyboard can walk out of is not one. */
  const trapFocus = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  /**
   * Keep the new connection and go back to what the dialog was doing.
   *
   * The Blueprint list is dropped rather than kept: it is the *old* engine's
   * catalog, and the point of coming here was usually that the old one was
   * wrong or unreachable.
   */
  const saveSettings = useCallback(() => {
    saveComfySettings(settingsDraft);
    setSettingsSaved((n) => n + 1);
    setShowSettings(false);
    setBlueprints(null);
    setBlueprintError(null);
  }, [settingsDraft]);

  const reset = useCallback(() => {
    setInspection(null);
    setError(null);
    setMissingNodes([]);
    setName("");
    setInputs([]);
    setOutputs([]);
    setRoles({});
    setBusy(false);
    setDragOver(false);
    setSaveResult(null);
  }, []);

  // The tab only exists while there is a library to show, so deleting the last
  // entry has to put the dialog back on a step that still exists.
  useEffect(() => {
    if (tab === "saved" && savedNodes.length === 0) setTab("file");
  }, [tab, savedNodes.length]);

  useEffect(() => {
    if (!isOpen) setView("main");
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  /**
   * Move an inspection into the confirm step.
   *
   * `selection` is the contract whose picks should be pre-filled: the
   * inspection's own suggestion on a fresh import, or the node's existing
   * contract when its picks are being revisited.
   */
  const adopt = useCallback(
    (
      result: Inspection,
      from: "upload" | "blueprint",
      selection?: Pick<ComfyAppDefinition, "name" | "inputs" | "params" | "outputs">
    ) => {
      const picked = selection ?? result.suggested;
      setInspection(result);
      setSource(from);
      setName(picked.name);
      setInputs(picked.inputs);
      setOutputs(picked.outputs);

      const next: Record<string, WidgetRole> = {};
      for (const candidate of result.widgetCandidates) {
        const key = bindingKey(candidate.nodeId, candidate.inputKey);
        if (picked.inputs.some((i) => i.id === key)) next[key] = "input";
        else if (picked.params.some((p) => p.id === key)) next[key] = "setting";
        else next[key] = "off";
      }
      setRoles(next);
    },
    []
  );

  const readError = useCallback(async (response: Response, fallback: string): Promise<string> => {
    try {
      const body = (await response.json()) as { error?: string; missingNodes?: string[] };
      setMissingNodes(body.missingNodes ?? []);
      return body.error ?? fallback;
    } catch {
      return fallback;
    }
  }, []);

  const inspectWorkflow = useCallback(
    async (workflow: unknown, filename: string) => {
      setBusy(true);
      setError(null);
      setMissingNodes([]);
      try {
        const response = await fetch("/api/comfy/inspect", {
          method: "POST",
          headers: buildComfyHeaders(getComfySettings()),
          body: JSON.stringify({ workflow, filename }),
        });
        if (!response.ok) {
          setError(await readError(response, "Could not read that workflow."));
          return;
        }
        adopt((await response.json()) as Inspection, "upload");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read that workflow.");
      } finally {
        setBusy(false);
      }
    },
    [adopt, readError]
  );

  const inspectFile = useCallback(
    async (file: File) => {
      let workflow: unknown;
      try {
        workflow = JSON.parse(await file.text());
      } catch {
        setError("That file is not valid JSON.");
        return;
      }
      await inspectWorkflow(workflow, file.name);
    },
    [inspectWorkflow]
  );

  // A workflow dropped onto the canvas: the user has already chosen, so read it
  // rather than showing them a file picker for a file they just gave us. Guarded
  // by identity so a re-render — or a Back out of the picks — does not re-read.
  const readUpload = useRef<ComfyUpload | null>(null);
  useEffect(() => {
    if (!isOpen || !upload || reconfigure) return;
    if (readUpload.current === upload) return;
    readUpload.current = upload;
    void inspectWorkflow(upload.workflow, upload.filename);
  }, [isOpen, upload, reconfigure, inspectWorkflow]);

  // Revisiting an attached workflow: go straight to the picks. The candidate
  // list stored at import is preferred — re-deriving it from the runnable graph
  // works, but App Mode lives in the uploaded file, so the author's curation
  // (which widgets they meant to expose, and their names for them) is lost.
  useEffect(() => {
    if (!isOpen || !reconfigure) return;
    const { app, inspection: stored } = reconfigure;
    const from = app.source === "blueprint" ? "blueprint" : "upload";

    if (stored) {
      adopt(withAppLabels({ ...stored, graph: app.graph }, app), from, app);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/comfy/inspect", {
          method: "POST",
          headers: buildComfyHeaders(getComfySettings()),
          body: JSON.stringify({ workflow: app.graph, filename: `${app.name}.json` }),
        });
        if (cancelled) return;
        if (!response.ok) {
          // Re-checked: `readError` awaits the body, and the dialog can be
          // closed during that await. The success path below already does this.
          const message = await readError(response, "Could not re-read this workflow.");
          if (!cancelled) setError(message);
          return;
        }
        const result = (await response.json()) as Inspection;
        if (!cancelled) adopt(withAppLabels(result, app), from, app);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not re-read this workflow.");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, reconfigure, adopt, readError]);

  const loadBlueprints = useCallback(async () => {
    setBlueprintError(null);
    setBlueprints(null);
    try {
      const response = await fetch("/api/comfy/blueprints", {
        headers: buildComfyHeaders(getComfySettings()),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setBlueprintError(body.error ?? "Could not load Blueprints.");
        return;
      }
      const body = (await response.json()) as { blueprints: BlueprintListItem[] };
      setBlueprints(body.blueprints);
    } catch (err) {
      setBlueprintError(err instanceof Error ? err.message : "Could not load Blueprints.");
    }
  }, []);

  useEffect(() => {
    if (isOpen && tab === "blueprints" && blueprints === null && !blueprintError) {
      void loadBlueprints();
    }
  }, [isOpen, tab, blueprints, blueprintError, loadBlueprints]);

  const importBlueprint = useCallback(
    async (blueprintId: string) => {
      setBusy(true);
      setError(null);
      setMissingNodes([]);
      try {
        const response = await fetch("/api/comfy/blueprints", {
          method: "POST",
          headers: buildComfyHeaders(getComfySettings()),
          body: JSON.stringify({ id: blueprintId }),
        });
        if (!response.ok) {
          setError(await readError(response, "Could not load that Blueprint."));
          return;
        }
        adopt((await response.json()) as Inspection, "blueprint");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load that Blueprint.");
      } finally {
        setBusy(false);
      }
    },
    [adopt, readError]
  );

  /** Move a detected widget between "not exposed", "setting" and "input". */
  const setRole = useCallback(
    (candidate: ComfyWidgetCandidate, role: WidgetRole) => {
      const key = bindingKey(candidate.nodeId, candidate.inputKey);
      setRoles((prev) => ({ ...prev, [key]: role }));
      setInputs((prev) => {
        const without = prev.filter((i) => i.id !== key);
        if (role !== "input" || !candidate.connectableAs) return without;
        return [...without, inputFromCandidate(candidate, candidate.connectableAs, new Set())];
      });
    },
    []
  );

  /**
   * Expose or hide a media loader.
   *
   * Re-enabling one restores the requiredness inspection gave it, rather than
   * defaulting: an App Mode input the author marked essential must stay
   * essential, while a loader that was merely detected stays optional so the
   * workflow still runs on the author's own image.
   */
  const toggleMediaInput = useCallback(
    (candidate: ComfyNodeCandidate, type: ComfyInputType) => {
      if (!inspection) return;
      setInputs((prev) => {
        if (prev.some((i) => i.nodeId === candidate.nodeId)) {
          return prev.filter((i) => i.nodeId !== candidate.nodeId);
        }
        const taken = new Set(prev.map((i) => i.name));
        const restored = inputFromLoader(
          candidate,
          type,
          taken,
          inspection.graph[candidate.nodeId]
        );
        const suggested = inspection.suggested.inputs.find(
          (i) => i.nodeId === candidate.nodeId
        );
        return [...prev, { ...restored, required: suggested?.required ?? false }];
      });
    },
    [inspection]
  );

  const renameInput = useCallback((inputId: string, label: string) => {
    setInputs((prev) => prev.map((i) => (i.id === inputId ? { ...i, label } : i)));
  }, []);

  const renameOutput = useCallback((outputId: string, label: string) => {
    setOutputs((prev) => prev.map((o) => (o.id === outputId ? { ...o, label } : o)));
  }, []);

  const toggleOutput = useCallback(
    (candidateNodeId: string, classType: string, label: string, type: ComfyOutputType) => {
      setOutputs((prev) =>
        prev.some((o) => o.nodeId === candidateNodeId)
          ? prev.filter((o) => o.nodeId !== candidateNodeId)
          : [...prev, { id: candidateNodeId, label, type, nodeId: candidateNodeId, classType }]
      );
    },
    []
  );

  // Derived once, so the preview shows the settings that will actually be
  // attached rather than a second guess at them.
  const params = useMemo(
    () =>
      (inspection?.widgetCandidates ?? [])
        .filter((c) => roles[bindingKey(c.nodeId, c.inputKey)] === "setting")
        .map(paramFromCandidate),
    [inspection, roles]
  );

  /**
   * The contract as the picks currently stand — what Add, Save changes and
   * Save as node all commit, so the three cannot disagree about it.
   */
  const buildContract = useCallback(() => {
    if (!inspection) return null;
    // The candidate list travels back to the node so the picks can be revisited.
    // The graph is dropped (the app already carries it), as are the blueprint
    // listing and the import-time warnings — both describe the upload, not the
    // contract, and replaying "could not reach the engine" weeks later misleads.
    const { graph: _graph, ...snapshot } = inspection;
    return {
      app: buildComfyApp({
        name,
        source: source === "blueprint" ? "blueprint" : "upload",
        graph: inspection.graph,
        inputs,
        params,
        outputs,
      }),
      inspection: { ...snapshot, blueprints: [], warnings: [] } as ComfyWorkflowInspection,
    };
  }, [inspection, params, name, source, inputs, outputs]);

  const attach = useCallback(() => {
    const built = buildContract();
    if (built) onAttach(built.app, built.inspection);
  }, [buildContract, onAttach]);

  /**
   * Keep this node, as configured, in the library.
   *
   * The values the node is running are folded into the defaults, which is the
   * whole point: a saved node arrives set up, not merely attached. Updating
   * overwrites the entry it came from; anything else adds one.
   */
  const saveToLibrary = useCallback(
    (mode: "new" | "update") => {
      const built = buildContract();
      if (!built) return;
      try {
        saveComfyNode({
          ...(mode === "update" && savedNodeId ? { id: savedNodeId } : {}),
          name,
          app: withDialledValues(built.app, paramValues ?? {}),
          inspection: built.inspection,
        });
        setSaveResult({ ok: true, message: mode === "update" ? "Updated" : "Saved" });
      } catch (err) {
        setSaveResult({
          ok: false,
          message: err instanceof Error ? err.message : "Could not save this node.",
        });
      }
    },
    [buildContract, name, paramValues, savedNodeId]
  );

  // A confirmation that stayed put would still be sitting there after the next
  // change, claiming that change was saved too.
  useEffect(() => {
    if (!saveResult?.ok) return;
    const timer = setTimeout(() => setSaveResult(null), 2500);
    return () => clearTimeout(timer);
  }, [saveResult]);

  /** Attach a library entry straight to the node — nothing to inspect. */
  const addSaved = useCallback(
    (entry: SavedComfyNode) => {
      const { app, inspection: stored } = instantiateSavedComfyNode(entry);
      onAttach(app, stored, { savedNodeId: entry.id });
    },
    [onAttach]
  );

  if (!isOpen) return null;

  const subtitle = showHelp
    ? null
    : showSettings
    ? "Where your workflows run, and what they run as."
    : inspection || reconfigure
      ? "These become the node's handles and settings."
      : existingName
        ? `Replacing "${existingName}".`
        : null;

  const canAttach = Boolean(inspection && name.trim() && outputs.length > 0);
  const blockingReason = !inspection
    ? null
    : !name.trim()
      ? "Give this node a name"
      : outputs.length === 0
        ? "Choose at least one output"
        : null;
  const showBlueprintAdd =
    !reconfigure && tab === "blueprints" && blueprints !== null && blueprints.length > 0;
  const showSavedAdd = !reconfigure && tab === "saved" && savedNodes.length > 0;
  // Only offer to update an entry that is still there — the node keeps its
  // `savedNodeId` after the library entry has been deleted.
  const canUpdateSaved = Boolean(
    savedNodeId && savedNodes.some((entry) => entry.id === savedNodeId)
  );
  // The preview is of the node being built, so it belongs to that step alone —
  // not to the file picker, the connection settings or the help text.
  const showPreview = Boolean(isMain && inspection);

  const dialog = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 animate-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="comfy-import-title"
        tabIndex={-1}
        // Wider only where there is a second column to hold: every other step
        // is a single list, and stretching it would leave a hall of empty grey.
        className={`bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-clip flex flex-col max-h-[82vh] focus:outline-none animate-dialog-panel transition-[width] duration-200 ${
          showPreview ? "w-[880px]" : "w-[600px]"
        }`}
        onKeyDown={trapFocus}
      >
        <div className="px-4 pt-4 pb-0 shrink-0 animate-dialog-section">
          <div className="flex items-center gap-2">
            <ComfyMark className="w-4 h-[19px] text-neutral-300 shrink-0" />
            <h2 id="comfy-import-title" className="text-xl font-medium text-neutral-100 truncate">
              {showHelp
                ? "Preparing a workflow"
                : showSettings
                ? "ComfyUI connection"
                : reconfigure
                  ? "Inputs, settings and outputs"
                  : inspection
                    ? "Confirm inputs and outputs"
                    : "Add a ComfyUI workflow"}
            </h2>
            <div className="ml-auto shrink-0 flex items-center gap-1 -my-1">
              {inspection?.hasAppMode && isMain && (
                <span
                  className="mr-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-300/90 border border-emerald-500/25"
                  title="This workflow ships an App Mode configuration — its author's inputs, settings and outputs are already selected."
                >
                  App Mode
                </span>
              )}
              <button
                type="button"
                onClick={() => setView((prev) => (prev === "help" ? "main" : "help"))}
                title="How to prepare a workflow for this"
                aria-label="How to prepare a workflow"
                aria-pressed={showHelp}
                className={`w-10 h-10 flex items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
                  showHelp
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50"
                }`}
              >
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9.5" />
                  <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4" />
                  <path d="M12 17.6h.01" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setShowSettings((open) => !open)}
                title="ComfyUI connection — engine, API key"
                aria-label="ComfyUI connection settings"
                aria-pressed={showSettings}
                className={`w-10 h-10 flex items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
                  showSettings
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50"
                }`}
              >
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>
          {subtitle && <p className="text-xs text-neutral-500 mt-1">{subtitle}</p>}

          {isMain && !inspection && !reconfigure && (
            <div className="flex gap-1.5 p-1 mt-4 bg-neutral-900/50 rounded-lg">
              <TabButton active={tab === "file"} onClick={() => setTab("file")}>
                Workflow file
              </TabButton>
              <TabButton active={tab === "blueprints"} onClick={() => setTab("blueprints")}>
                Blueprints
              </TabButton>
              {/* Absent until there is something in it — an empty tab for a
                  feature you have not used yet is a dead end with a label. */}
              {savedNodes.length > 0 && (
                <TabButton active={tab === "saved"} onClick={() => setTab("saved")}>
                  Saved nodes
                </TabButton>
              )}
            </div>
          )}
        </div>

        {/* Two columns while a node is being built: the picks scroll on the
            left, the node they describe stands still on the right. */}
        <div className="flex-1 min-h-0 flex">
        {/* The vertical padding lives on the inner wrapper, not here: a sticky
            heading inside a padded scroller stops at the *content* edge, and
            rows then scroll through the padding band above it in full view. */}
        <div
          className="flex-1 min-w-0 overflow-y-auto px-4 animate-dialog-section"
          style={{ animationDelay: "80ms" }}
        >
          <div className="py-4">
          {showSettings && (
            <ComfySettingsTab settings={settingsDraft} onChange={setSettingsDraft} />
          )}

          {showHelp && <HelpPanel />}

          {isMain && configError && !inspection && (
            <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <p className="text-xs text-amber-300">{configError}</p>
            </div>
          )}

          {isMain && error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <p className="text-xs text-red-300 whitespace-pre-wrap">{error}</p>
              {missingNodes.length > 0 && (
                <p className="text-[10px] text-red-400/70 mt-2 font-mono break-words">
                  {missingNodes.join(", ")}
                </p>
              )}
            </div>
          )}

          {isMain && reconfigure && !inspection && !error && (
            <div className="py-12 flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-xs text-neutral-500">Reading this workflow…</span>
            </div>
          )}

          {isMain && !reconfigure && !inspection && tab === "file" && (
            <FileDropZone
              busy={busy}
              dragOver={dragOver}
              onDragOver={setDragOver}
              onPick={() => fileInputRef.current?.click()}
              onFile={inspectFile}
            />
          )}

          {isMain && !reconfigure && !inspection && tab === "blueprints" && (
            <BlueprintPicker
              blueprints={blueprints}
              error={blueprintError}
              selected={blueprintId}
              onSelect={setBlueprintId}
              onRetry={loadBlueprints}
              onAdd={() => void importBlueprint(blueprintId)}
              busy={busy}
            />
          )}

          {isMain && !reconfigure && !inspection && tab === "saved" && (
            <SavedNodePicker
              nodes={savedNodes}
              selected={savedPick}
              onSelect={setSavedPick}
              onAdd={addSaved}
              onDelete={(entryId) => {
                removeSavedComfyNode(entryId);
                setSavedPick((current) => (current === entryId ? "" : current));
              }}
            />
          )}

          {isMain && inspection && (
            <ConfirmStep
              inspection={inspection}
              name={name}
              onName={setName}
              inputs={inputs}
              outputs={outputs}
              roles={roles}
              onRole={setRole}
              onRenameInput={renameInput}
              onRenameOutput={renameOutput}
              onToggleOutput={toggleOutput}
              onToggleMediaInput={toggleMediaInput}
            />
          )}
          </div>
        </div>

        {showPreview && inspection && (
          // 8px to the dialog's outer edge on the three sides it can reach.
          <div
            className="w-[400px] shrink-0 py-2 pr-2 animate-dialog-section"
            style={{ animationDelay: "120ms" }}
          >
            <ComfyNodePreview
              name={name}
              source={source === "blueprint" ? "blueprint" : "upload"}
              nodeCount={inspection.nodeCount}
              inputs={inputs}
              params={params}
              outputs={outputs}
            />
          </div>
        )}
        </div>

        <div
          className="flex items-center justify-between gap-3 p-4 border-t border-neutral-700/60 shrink-0 animate-dialog-section"
          style={{ animationDelay: "160ms" }}
        >
          <button
            type="button"
            // There is nothing behind the picks when they were opened directly,
            // so "Back" would strand the dialog on an empty file step.
            onClick={
              isMain
                ? inspection && !reconfigure
                  ? reset
                  : onClose
                : () => setView("main")
            }
            className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-[color,scale] duration-150 active:scale-[0.96]"
          >
            {!isMain || (inspection && !reconfigure) ? "Back" : "Cancel"}
          </button>
          {/* Why the button is dead, said where the button is — otherwise the
              reason is a section away, under two screens of settings. */}
          {isMain && inspection && blockingReason && (
            <span className="text-[11px] text-neutral-500 truncate">{blockingReason}</span>
          )}
          {showHelp ? null : showSettings ? (
            <button type="button" onClick={saveSettings} className={PRIMARY_BUTTON}>
              Save connection
            </button>
          ) : inspection ? (
            <div className="flex items-center gap-2 shrink-0">
              {/* Saving is otherwise invisible — the dialog stays exactly as it
                  was, so without this there is no way to tell it worked. */}
              {saveResult && (
                <span
                  role="status"
                  className={`text-[11px] ${
                    saveResult.ok ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {saveResult.message}
                </span>
              )}
              {canUpdateSaved && (
                <button
                  type="button"
                  onClick={() => saveToLibrary("update")}
                  disabled={!canAttach}
                  title="Overwrite the saved node this one came from"
                  className={SECONDARY_BUTTON}
                >
                  Update saved node
                </button>
              )}
              <button
                type="button"
                onClick={() => saveToLibrary("new")}
                disabled={!canAttach}
                title="Keep this node, as configured, in the node menus"
                className={SECONDARY_BUTTON}
              >
                {canUpdateSaved ? "Save as new" : "Save as node"}
              </button>
              <button type="button" onClick={attach} disabled={!canAttach} className={PRIMARY_BUTTON}>
                {reconfigure ? "Save changes" : "Add to node"}
              </button>
            </div>
          ) : showSavedAdd ? (
            <button
              type="button"
              onClick={() => {
                const entry = savedNodes.find((n) => n.id === savedPick);
                if (entry) addSaved(entry);
              }}
              disabled={!savedPick}
              className={PRIMARY_BUTTON}
            >
              Add
            </button>
          ) : (
            // The Blueprint list confirms from here too, so the dialog has one
            // place where a choice is committed rather than one per step.
            showBlueprintAdd && (
              <button
                type="button"
                onClick={() => void importBlueprint(blueprintId)}
                disabled={!blueprintId || busy}
                className={PRIMARY_BUTTON}
              >
                {busy ? "Reading…" : "Add"}
              </button>
            )
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void inspectFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );

  // Portalled to the body: this dialog is rendered from inside a node, and
  // React Flow's viewport carries a `transform`, which makes it the containing
  // block for `position: fixed` — so without this the dialog is scaled and
  // shifted by the canvas zoom.
  if (typeof document === "undefined") return null;
  return createPortal(dialog, document.body);
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
        active
          ? "bg-neutral-700 text-neutral-100 font-medium"
          : "text-neutral-400 hover:text-neutral-300 hover:bg-neutral-800/50"
      }`}
    >
      {children}
    </button>
  );
}

function FileDropZone({
  busy,
  dragOver,
  onDragOver,
  onPick,
  onFile,
}: {
  busy: boolean;
  dragOver: boolean;
  onDragOver: (over: boolean) => void;
  onPick: () => void;
  onFile: (file: File) => void;
}) {
  return (
    // A button, not a div: dropping a file needs a pointer, but *picking* one
    // should not — and the Blueprints tab is a different task, not an
    // equivalent keyboard path to importing a local file.
    <button
      type="button"
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(true);
      }}
      onDragLeave={() => onDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      onClick={onPick}
      className={`w-full flex flex-col items-center justify-center gap-3 py-12 rounded-xl border border-dashed cursor-pointer transition-colors ${
        dragOver
          ? "border-blue-500 bg-blue-500/5"
          : "border-neutral-600 hover:border-neutral-500 bg-neutral-900/40"
      }`}
    >
      {busy ? (
        <>
          <span className="w-5 h-5 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-xs text-neutral-400">Reading workflow…</span>
        </>
      ) : (
        <>
          <svg
            className="w-8 h-8 text-neutral-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5-5 5 5" />
            <path d="M12 5v12" />
          </svg>
          {/* Spans, not p/div: a button may only hold phrasing content. */}
          <span className="block text-center">
            <span className="block text-sm text-neutral-300">Drop a workflow JSON here</span>
            <span className="block text-[11px] text-neutral-500 mt-0.5">
              Saved or API-format exports both work
            </span>
          </span>
        </>
      )}
    </button>
  );
}

/**
 * Pick one Blueprint out of the engine's catalog.
 *
 * A catalog is long — Comfy Cloud ships around ninety — and every entry is the
 * same kind of thing, so they share one list rather than each getting a card
 * and a button of its own. Picking only highlights a row; nothing is fetched
 * until Add (or a double-click) confirms it.
 */
function BlueprintPicker({
  blueprints,
  error,
  selected,
  onSelect,
  onRetry,
  onAdd,
  busy,
}: {
  blueprints: BlueprintListItem[] | null;
  error: string | null;
  selected: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onAdd: () => void;
  busy: boolean;
}) {
  const [filter, setFilter] = useState("");

  if (error) {
    return (
      <div className="py-8 text-center">
        <p className="text-xs text-neutral-400 mb-3">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-2 text-xs rounded-lg bg-neutral-700 hover:bg-neutral-600 text-neutral-100 transition-[background-color,scale] duration-150 active:scale-[0.96]"
        >
          Try again
        </button>
      </div>
    );
  }

  if (blueprints === null) {
    return (
      <div className="py-12 flex flex-col items-center gap-2">
        <div className="w-5 h-5 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin" />
        <span className="text-xs text-neutral-500">Loading Blueprints…</span>
      </div>
    );
  }

  if (blueprints.length === 0) {
    return (
      <p className="text-xs text-neutral-500 py-8 text-center">
        This ComfyUI has no Blueprints installed.
      </p>
    );
  }

  const term = filter.trim().toLowerCase();
  const visible = term
    ? blueprints.filter((b) => b.name.toLowerCase().includes(term))
    : blueprints;

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 overflow-hidden">
      {/* Header row: the list is long enough that scanning it is the slow way
          to a known name. */}
      <div className="flex items-center gap-2 px-3 border-b border-neutral-800">
        <svg
          className="w-3.5 h-3.5 shrink-0 text-neutral-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search Blueprints…"
          aria-label="Search Blueprints"
          className="w-full bg-transparent py-2.5 text-sm text-neutral-100 placeholder:text-neutral-400 focus:outline-none"
        />
      </div>
      <div
        role="listbox"
        aria-label="Blueprints"
        className="divide-y divide-neutral-800/80 max-h-[280px] overflow-y-auto"
      >
        {visible.map((blueprint) => {
          const isSelected = blueprint.id === selected;
          return (
            <button
              key={blueprint.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              disabled={busy}
              onClick={() => onSelect(blueprint.id)}
              onDoubleClick={onAdd}
              className={`w-full text-left px-3 py-3 text-sm truncate transition-[background-color,color,scale] duration-150 active:scale-[0.99] disabled:cursor-not-allowed ${
                isSelected
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
              }`}
            >
              {blueprint.name}
            </button>
          );
        })}
        {visible.length === 0 && (
          <p className="px-3 py-6 text-xs text-neutral-600 text-center">
            No Blueprints match that search.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The saved-node library.
 *
 * Each entry is a workflow someone already confirmed and dialled in, so there
 * is nothing to read and nothing to choose — picking one attaches it. What the
 * row has to answer is which one this is, hence the handle counts: two saves of
 * the same workflow usually differ by what they expose, not by name.
 */
function SavedNodePicker({
  nodes,
  selected,
  onSelect,
  onAdd,
  onDelete,
}: {
  nodes: SavedComfyNode[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: (entry: SavedComfyNode) => void;
  onDelete: (id: string) => void;
}) {
  // Deleting is not undoable — localStorage keeps no history — so it asks,
  // inline rather than through a system dialog stacked on top of this one.
  const [confirming, setConfirming] = useState<string | null>(null);

  if (nodes.length === 0) {
    return (
      <p className="text-xs text-neutral-500 py-8 text-center">
        Nothing saved yet. Confirm a workflow&rsquo;s inputs and outputs, then
        &ldquo;Save as node&rdquo;.
      </p>
    );
  }

  return (
    <ul className="rounded-lg border border-neutral-700 bg-neutral-900 overflow-hidden divide-y divide-neutral-800/80 max-h-[320px] overflow-y-auto">
      {nodes.map((entry) => {
        const isSelected = entry.id === selected;
        const { app } = entry;
        const handles = [
          `${app.inputs.length} input${app.inputs.length === 1 ? "" : "s"}`,
          `${app.params.length} setting${app.params.length === 1 ? "" : "s"}`,
          `${app.outputs.length} output${app.outputs.length === 1 ? "" : "s"}`,
        ].join(" · ");

        return (
          <li key={entry.id} className={isSelected ? "bg-neutral-700" : "hover:bg-neutral-800"}>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onSelect(entry.id)}
                onDoubleClick={() => onAdd(entry)}
                className="flex-1 min-w-0 text-left px-3 py-2.5 transition-[scale] duration-150 active:scale-[0.99]"
              >
                {/* Spans, as in `FileDropZone`: a button holds phrasing content
                    only, and a browser reparenting a `p` out of one takes the
                    row's layout with it. */}
                <span
                  className={`block text-sm truncate ${
                    isSelected ? "text-white" : "text-neutral-300"
                  }`}
                >
                  {entry.name}
                </span>
                <span className="block text-[10px] text-neutral-500 truncate">
                  {app.source === "blueprint" ? "Blueprint" : "App workflow"} · {handles}
                </span>
              </button>

              {confirming === entry.id ? (
                <div className="flex items-center gap-1 pr-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(entry.id);
                      setConfirming(null);
                    }}
                    className="px-2 py-1 text-[11px] rounded bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200 transition-colors"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(entry.id)}
                  title={`Delete "${entry.name}"`}
                  aria-label={`Delete ${entry.name}`}
                  className="shrink-0 w-10 h-10 flex items-center justify-center text-neutral-600 hover:text-red-400 transition-colors"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                    <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                  </svg>
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ConfirmStep({
  inspection,
  name,
  onName,
  inputs,
  outputs,
  roles,
  onRole,
  onRenameInput,
  onRenameOutput,
  onToggleOutput,
  onToggleMediaInput,
}: {
  inspection: Inspection;
  name: string;
  onName: (value: string) => void;
  inputs: ComfyAppInput[];
  outputs: ComfyAppOutput[];
  roles: Record<string, WidgetRole>;
  onRole: (candidate: ComfyWidgetCandidate, role: WidgetRole) => void;
  onRenameInput: (id: string, label: string) => void;
  onRenameOutput: (id: string, label: string) => void;
  onToggleOutput: (
    nodeId: string,
    classType: string,
    label: string,
    type: ComfyOutputType
  ) => void;
  onToggleMediaInput: (candidate: ComfyNodeCandidate, type: ComfyInputType) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [widgetFilter, setWidgetFilter] = useState("");

  /**
   * The widgets worth showing without being asked for.
   *
   * A workflow of any size offers dozens — a Cloud Blueprint typically ~30,
   * mostly loader plumbing (which checkpoint, which dtype, which device) that
   * no node should expose. The ones its author curated, plus whatever is
   * already exposed, are the short list; the rest waits behind a disclosure.
   */
  const [featured, rest] = useMemo(() => {
    const isFeatured = (c: ComfyWidgetCandidate) =>
      c.fromAppMode || (roles[bindingKey(c.nodeId, c.inputKey)] ?? "off") !== "off";
    return [
      inspection.widgetCandidates.filter(isFeatured),
      inspection.widgetCandidates.filter((c) => !isFeatured(c)),
    ];
    // Deliberately not reacting to `roles`: a widget must not leap between
    // lists as it is ticked, which would move the row out from under the
    // pointer mid-click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection.widgetCandidates]);

  /** The hidden remainder, grouped by the node it belongs to. */
  const groups = useMemo(() => {
    const term = widgetFilter.trim().toLowerCase();
    const matching = term
      ? rest.filter((c) => c.label.toLowerCase().includes(term))
      : rest;
    const byNode = new Map<string, { classType: string; items: ComfyWidgetCandidate[] }>();
    for (const candidate of matching) {
      const group = byNode.get(candidate.nodeId) ?? { classType: candidate.classType, items: [] };
      group.items.push(candidate);
      byNode.set(candidate.nodeId, group);
    }
    return [...byNode.entries()];
  }, [rest, widgetFilter]);

  const exposedCount = inspection.widgetCandidates.filter(
    (c) => (roles[bindingKey(c.nodeId, c.inputKey)] ?? "off") !== "off"
  ).length;

  // Every loader in the graph, selected or not — a workflow can carry several
  // and only some are meant to be wired from the canvas.
  const mediaCandidates = useMemo(
    () =>
      [...inspection.imageInputCandidates, ...inspection.mediaInputCandidates].map(
        (candidate) => ({
          candidate,
          type: loaderInputType(candidate.classType) ?? ("image" as ComfyInputType),
        })
      ),
    [inspection.imageInputCandidates, inspection.mediaInputCandidates]
  );

  // Text inputs are promoted widgets, so the Settings list below owns their
  // on/off state; here they only get renamed.
  const textInputs = inputs.filter((i) => i.type === "text");

  return (
    <div className="space-y-5">
      {inspection.warnings.map((warning) => (
        <div key={warning} className="p-3 rounded-lg bg-neutral-900 border border-neutral-700">
          <p className="text-xs text-neutral-400">{warning}</p>
        </div>
      ))}

      <div>
        <label className="block text-sm text-neutral-400 mb-1">Node name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded-lg text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
        />
        <p className="text-[10px] text-neutral-600 mt-1">
          {inspection.nodeCount} nodes · {inspection.classTypes.length} node types
        </p>
      </div>

      <Section
        title="Inputs"
        hint="Connected from other nodes."
        count={`${inputs.length} of ${mediaCandidates.length + textInputs.length} exposed`}
        empty="Nothing in this workflow accepts an incoming connection."
        isEmpty={mediaCandidates.length === 0 && textInputs.length === 0}
      >
        <ListBox>
          {mediaCandidates.map(({ candidate, type }) => {
            const bound = inputs.find((i) => i.nodeId === candidate.nodeId);
            return (
              <BindingRow
                key={candidate.nodeId}
                type={type}
                typeLabel={INPUT_TYPE_LABEL[type]}
                nodeId={candidate.nodeId}
                name={bound?.label ?? candidate.label}
                bound={Boolean(bound)}
                onRename={(value) => bound && onRenameInput(bound.id, value)}
                onToggle={() => onToggleMediaInput(candidate, type)}
                onLabel="Input"
                onTitle="A handle other nodes connect to"
                offTitle="Hidden — the workflow keeps its own file"
              />
            );
          })}
          {textInputs.map((input) => (
            <BindingRow
              key={input.id}
              type={input.type}
              typeLabel={INPUT_TYPE_LABEL[input.type]}
              nodeId={input.nodeId}
              name={input.label}
              bound
              onRename={(value) => onRenameInput(input.id, value)}
              onLabel="Input"
              onTitle="A handle other nodes connect to"
              offTitle=""
            />
          ))}
        </ListBox>
      </Section>

      <Section
        title="Settings"
        hint="Adjustable on the node itself."
        count={`${exposedCount} of ${inspection.widgetCandidates.length} exposed`}
        empty="This workflow has no adjustable widgets."
        isEmpty={inspection.widgetCandidates.length === 0}
      >
        {featured.length > 0 ? (
          <ListBox>
            {featured.map((candidate) => (
              <SettingRow
                key={bindingKey(candidate.nodeId, candidate.inputKey)}
                candidate={candidate}
                label={candidate.label}
                role={roles[bindingKey(candidate.nodeId, candidate.inputKey)] ?? "off"}
                onRole={onRole}
              />
            ))}
          </ListBox>
        ) : (
          !showAll && (
            <p className="text-xs text-neutral-600">
              This workflow&apos;s author exposed none of its widgets.
            </p>
          )
        )}

        {rest.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowAll((open) => !open)}
              aria-expanded={showAll}
              className="flex items-center gap-1.5 min-h-10 text-xs text-neutral-400 hover:text-neutral-200 transition-[color,scale] duration-150 active:scale-[0.96]"
            >
              <svg
                className={`w-3 h-3 transition-transform duration-150 ${showAll ? "rotate-90" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              {showAll ? "Hide" : `Show ${rest.length} more`} widget{rest.length === 1 ? "" : "s"}
            </button>

            {showAll && (
              <div className="mt-1 rounded-lg border border-neutral-700/60 bg-neutral-900 overflow-hidden">
                <div className="flex items-center gap-2 px-2.5 border-b border-neutral-800">
                  <svg
                    className="w-3.5 h-3.5 shrink-0 text-neutral-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    type="text"
                    value={widgetFilter}
                    onChange={(e) => setWidgetFilter(e.target.value)}
                    placeholder="Search widgets…"
                    aria-label="Search widgets"
                    className="w-full bg-transparent py-2.5 text-xs text-neutral-100 placeholder:text-neutral-400 focus:outline-none"
                  />
                </div>
                {/* Bounded: thirty rows would push the Outputs section — and the
                    reason Save is disabled — back off the bottom of the dialog. */}
                <div className="max-h-[300px] overflow-y-auto">
                  {groups.length === 0 ? (
                    <p className="px-2.5 py-4 text-xs text-neutral-600">
                      No widgets match that search.
                    </p>
                  ) : (
                    // Grouped by node: the class name is the same on every row of a
                    // group, so saying it once leaves the widget's own name to read.
                    groups.map(([nodeId, group]) => (
                      <div key={nodeId}>
                        {/* A band, not a row: the node a widget belongs to is a
                            heading over the list, and at row weight the two
                            were being read as the same kind of thing.

                            Weighted to the top, because a heading belongs to
                            what follows it — evenly padded, it floated between
                            two groups and read as ending the one above. */}
                        <div className="flex items-baseline gap-2 px-2.5 pt-2.5 pb-1 bg-neutral-950/80 border-y border-neutral-800">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                            {group.classType}
                          </span>
                          <span className="text-[10px] text-neutral-700 font-mono">#{nodeId}</span>
                        </div>
                        {group.items.map((candidate) => (
                          <SettingRow
                            key={bindingKey(candidate.nodeId, candidate.inputKey)}
                            candidate={candidate}
                            label={widgetName(candidate)}
                            role={roles[bindingKey(candidate.nodeId, candidate.inputKey)] ?? "off"}
                            onRole={onRole}
                            indented
                          />
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Outputs"
        hint="Produced results, connected onward."
        count={`${outputs.length} of ${inspection.outputCandidates.length} exposed`}
        empty="This workflow has no Save or Preview node."
        isEmpty={inspection.outputCandidates.length === 0}
      >
        <ListBox>
          {inspection.outputCandidates.map((candidate) => {
            const bound = outputs.find((o) => o.nodeId === candidate.nodeId);
            const type = outputTypeOf(inspection, candidate.nodeId);
            return (
              <BindingRow
                key={candidate.nodeId}
                type={type}
                typeLabel={OUTPUT_TYPE_LABEL[type]}
                nodeId={candidate.nodeId}
                name={bound?.label ?? candidate.label}
                bound={Boolean(bound)}
                onRename={(value) => onRenameOutput(candidate.nodeId, value)}
                onToggle={() =>
                  onToggleOutput(candidate.nodeId, candidate.classType, candidate.label, type)
                }
                onLabel="Output"
                onTitle="A handle downstream nodes read from"
                offTitle="Hidden — this result is discarded"
              />
            );
          })}
        </ListBox>
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  count,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  hint: string;
  /** State of the section, readable without scrolling it. */
  count?: string;
  empty: string;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Sticky, and bled to the dialog's edges so rows pass behind it rather
          than beside it — three sections deep, the heading is the only thing
          saying which list you are in. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-neutral-800 flex items-baseline gap-2">
        <h3 className="text-sm text-neutral-200 font-medium shrink-0">{title}</h3>
        <span className="text-[10px] text-neutral-600 truncate">{hint}</span>
        {count && !isEmpty && (
          <span className="ml-auto shrink-0 text-[10px] text-neutral-500 tabular-nums">{count}</span>
        )}
      </div>
      {isEmpty ? (
        <p className="text-xs text-neutral-600 py-2">{empty}</p>
      ) : (
        <div className="space-y-1.5">{children}</div>
      )}
    </div>
  );
}

/** `KSampler · Seed` → `Seed`, for rows already sitting under their node. */
function widgetName(candidate: ComfyWidgetCandidate): string {
  const tail = candidate.label.split("·").pop()?.trim();
  return tail && tail.length > 0 ? tail : candidate.label;
}

/**
 * What this dialog reads from a ComfyUI workflow.
 *
 * Written plainly and kept short: it is read once, by someone who came here
 * because an import did not produce the node they expected.
 */
function HelpPanel() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm text-neutral-200 leading-relaxed">
          Drop a ComfyUI workflow onto the canvas, or start from a Blueprint. Select the inputs and
          the outputs you want, and it becomes a node like any other.
        </p>
        <p className="text-sm text-neutral-200 leading-relaxed">
          It runs on Comfy Cloud, or on your local ComfyUI.
        </p>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-sm font-medium text-neutral-100">App Mode gives the best result</h3>
        <p className="text-xs text-neutral-400 leading-relaxed">
          App Mode is part of the ComfyUI editor. In App Mode, you select the inputs and the outputs
          of the graph. Node Banana keeps those selections, so the node arrives ready to run.
        </p>
        <p className="text-xs text-neutral-400 leading-relaxed">
          Without App Mode, Node Banana finds the inputs and the outputs itself. You confirm them
          here, and you can change them later.
        </p>
      </section>

      <a
        href={APP_MODE_DOCS}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        Read the App Mode guide
        <svg
          className="w-3 h-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>
    </div>
  );
}

/** The recessed surface a list of rows sits on. */
function ListBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-700/60 bg-neutral-900 overflow-hidden divide-y divide-neutral-800/60">
      {children}
    </div>
  );
}

/**
 * What a row becomes, chosen from named states rather than ticked.
 *
 * Each option says what the row *is* when it wins — Setting, Input, Output —
 * so the row's state is legible without cross-referencing a checkbox against
 * the section it sits in.
 */
function ChoiceToggle({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string; title: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-0.5 p-0.5 bg-neutral-950/60 rounded-md shrink-0">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-2.5 py-1.5 text-[10px] font-medium rounded transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
            value === option.value
              ? "bg-neutral-700 text-neutral-100"
              : "text-neutral-500 hover:text-neutral-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A loader or a sink: a handle on the node, or left to the workflow's own file.
 *
 * The name is editable in place, but only once the row is on — a field that
 * renames something the node will not have is a place to waste a keystroke.
 */
function BindingRow({
  type,
  typeLabel,
  nodeId,
  name,
  bound,
  onRename,
  onToggle,
  onLabel,
  onTitle,
  offTitle,
}: {
  type: string;
  typeLabel: string;
  nodeId: string;
  name: string;
  bound: boolean;
  onRename: (value: string) => void;
  /** Absent for rows that cannot be turned off, such as a promoted widget. */
  onToggle?: () => void;
  onLabel: string;
  onTitle: string;
  offTitle: string;
}) {
  return (
    <div className="flex items-center gap-2 min-h-11 px-2.5 hover:bg-neutral-800/40 transition-colors">
      <TypePill color={handleColor(type)}>{typeLabel}</TypePill>
      <input
        type="text"
        value={name}
        disabled={!bound}
        onChange={(e) => onRename(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1.5 bg-transparent border border-transparent rounded-md text-neutral-100 text-xs hover:border-neutral-700 focus:border-neutral-600 focus:bg-neutral-950/40 focus:outline-none disabled:text-neutral-500 disabled:hover:border-transparent"
      />
      <span className="text-[10px] text-neutral-600 shrink-0 font-mono">#{nodeId}</span>
      {onToggle && (
        <ChoiceToggle
          value={bound ? "on" : "off"}
          onChange={(next) => {
            if ((next === "on") !== bound) onToggle();
          }}
          options={[
            { value: "off", label: "Hide", title: offTitle },
            { value: "on", label: onLabel, title: onTitle },
          ]}
        />
      )}
    </div>
  );
}

/**
 * One widget, exposed or not.
 *
 * The whole row is the target: a checkbox alone is 14px of hittable area in a
 * list dozens long. Connectable widgets get a second choice — inline setting or
 * a handle — but only once exposed, and only where it is possible at all, which
 * in a typical workflow is one row in thirty.
 */
function SettingRow({
  candidate,
  label,
  role,
  onRole,
  indented = false,
}: {
  candidate: ComfyWidgetCandidate;
  label: string;
  role: WidgetRole;
  onRole: (candidate: ComfyWidgetCandidate, role: WidgetRole) => void;
  /** Set under a node heading, so the rows read as that node's. */
  indented?: boolean;
}) {
  const exposed = role !== "off";
  return (
    <div
      className={`flex items-center gap-2 min-h-11 pr-2.5 hover:bg-neutral-800/40 transition-colors ${
        indented ? "pl-5 border-b border-neutral-800/50 last:border-b-0" : "pl-2.5"
      }`}
    >
      <span
        className={`flex-1 min-w-0 text-xs truncate ${exposed ? "text-neutral-100" : "text-neutral-400"}`}
        title={`${candidate.label} — currently ${describeValue(candidate.currentValue)}`}
      >
        {label}
      </span>
      {candidate.fromAppMode && (
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400/70"
          title="Chosen by this workflow's author"
        />
      )}
      <ChoiceToggle
        value={role}
        onChange={(next) => onRole(candidate, next as WidgetRole)}
        options={[
          { value: "off", label: "Hide", title: "Keep the workflow's saved value" },
          { value: "setting", label: "Setting", title: "Adjustable on the node itself" },
          // Only some widgets can be driven by a wire — a model filename cannot.
          ...(candidate.connectableAs
            ? [
                {
                  value: "input",
                  label: "Input",
                  title: "A handle other nodes connect to",
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

function TypePill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide"
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** A widget's current value, short enough for a tooltip. */
function describeValue(value: ComfyWidgetCandidate["currentValue"]): string {
  // A curve is a nest of coordinates; its point count is the useful summary.
  if (value && typeof value === "object") {
    return "points" in value ? `a curve of ${value.points.length} points` : "a structured value";
  }
  return String(value);
}

function handleColor(type: string): string {
  if (type === "text") return "var(--color-handle-text)";
  if (type === "audio") return "var(--color-handle-audio)";
  if (type === "video") return "var(--color-handle-video)";
  if (type === "3d") return "var(--color-handle-3d)";
  return "var(--color-handle-image)";
}

/** The handle type inspection assigned to a sink node. */
function outputTypeOf(inspection: Inspection, nodeId: string): ComfyOutputType {
  const suggested = inspection.suggested.outputs.find((o) => o.nodeId === nodeId);
  return suggested?.type ?? "image";
}

