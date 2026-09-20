"use client";

import { useState, useEffect, useRef } from "react";
import { generateWorkflowId, useWorkflowStore } from "@/store/workflowStore";
import { ProviderType, ProviderSettings, NodeDefaultsConfig, LLMProvider, LLMModelType, EdgeAppearance, EdgeStyle } from "@/types";
import { CanvasNavigationSettings, PanMode, ZoomMode, SelectionMode } from "@/types/canvas";
import { EnvStatusResponse } from "@/app/api/env-status/route";
import { loadNodeDefaults, saveNodeDefaults, getLastProjectBaseDir, setLastProjectBaseDir, saveEdgeDefaults, getProviderSettings } from "@/store/utils/localStorage";
import { clearFetchCache } from "@/utils/deduplicatedFetch";
import { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { ComfySettingsTab, useComfySettingsDraft } from "@/components/settings/ComfySettingsTab";
import { saveComfySettings, getComfySettings } from "@/lib/comfy/settings";
import { EnvironmentImport } from '@/components/settings/EnvironmentImport';
import { isDesktop, comfySecretFields } from '@/lib/desktop/credentials';
import { ConnectionSettings } from "@/components/settings/ConnectionSettings";
import {
  Dialog,
  DialogButton,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageFooter,
  DialogPageHead,
  DialogPageTitle,
  DialogPane,
  DialogPaneFoot,
  DialogRailItem,
  DialogRow,
  DialogRowTitle,
  DialogStatus,
  DialogTextButton,
  splitPanelClass,
} from "@/components/ui/Dialog";
import { Field, Segmented, Select, Slider, Switch, TextInput, labelClass, type SegmentedOption } from "@/components/ui/Controls";
import { APP_VERSION } from "@/lib/appVersion";
import { cn } from "@/components/nodes/ui/cn";

import { DEFAULT_LLM_MODEL, LLM_PROVIDER_OPTIONS, defaultLLMModel, llmModelLabel, llmModelOptions } from "@/lib/llm/catalog";

// Provider icons
const GeminiIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
  </svg>
);

const ReplicateIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 1000 1000" fill="currentColor">
    <polygon points="1000,427.6 1000,540.6 603.4,540.6 603.4,1000 477,1000 477,427.6" />
    <polygon points="1000,213.8 1000,327 364.8,327 364.8,1000 238.4,1000 238.4,213.8" />
    <polygon points="1000,0 1000,113.2 126.4,113.2 126.4,1000 0,1000 0,0" />
  </svg>
);

const FalIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 1855 1855" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M1181.65 78C1212.05 78 1236.42 101.947 1239.32 131.261C1265.25 392.744 1480.07 600.836 1750.02 625.948C1780.28 628.764 1805 652.366 1805 681.816V1174.18C1805 1203.63 1780.28 1227.24 1750.02 1230.05C1480.07 1255.16 1265.25 1463.26 1239.32 1724.74C1236.42 1754.05 1212.05 1778 1181.65 1778H673.354C642.951 1778 618.585 1754.05 615.678 1724.74C589.754 1463.26 374.927 1255.16 104.984 1230.05C74.7212 1227.24 50 1203.63 50 1174.18V681.816C50 652.366 74.7213 628.764 104.984 625.948C374.927 600.836 589.754 392.744 615.678 131.261C618.585 101.946 642.951 78 673.353 78H1181.65ZM402.377 926.561C402.377 1209.41 638.826 1438.71 930.501 1438.71C1222.18 1438.71 1458.63 1209.41 1458.63 926.561C1458.63 643.709 1222.18 414.412 930.501 414.412C638.826 414.412 402.377 643.709 402.377 926.561Z" />
  </svg>
);

const WaveSpeedIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 512 512" fill="currentColor">
    <path d="M308.946 153.758C314.185 153.758 318.268 158.321 317.516 163.506C306.856 237.02 270.334 302.155 217.471 349.386C211.398 354.812 203.458 357.586 195.315 357.586H127.562C117.863 357.586 110.001 349.724 110.001 340.025V333.552C110.001 326.82 113.882 320.731 119.792 317.505C176.087 286.779 217.883 232.832 232.32 168.537C234.216 160.09 241.509 153.758 250.167 153.758H308.946Z" />
    <path d="M183.573 153.758C188.576 153.758 192.592 157.94 192.069 162.916C187.11 210.12 160.549 250.886 122.45 275.151C116.916 278.676 110 274.489 110 267.928V171.318C110 161.62 117.862 153.758 127.56 153.758H183.573Z" />
    <path d="M414.815 153.758C425.503 153.758 433.734 163.232 431.799 173.743C420.697 234.038 398.943 290.601 368.564 341.414C362.464 351.617 351.307 357.586 339.419 357.586H274.228C266.726 357.586 262.611 348.727 267.233 342.819C306.591 292.513 334.86 233.113 348.361 168.295C350.104 159.925 357.372 153.758 365.922 153.758H414.815Z" />
  </svg>
);

// Get provider icon component
const getProviderIcon = (provider: ProviderType) => {
  switch (provider) {
    case "gemini":
      return <GeminiIcon />;
    case "replicate":
      return <ReplicateIcon />;
    case "fal":
      return <FalIcon />;
    case "wavespeed":
      return <WaveSpeedIcon />;
    default:
      return null;
  }
};

type SettingsTab = "project" | "providers" | "comfy" | "nodeDefaults" | "canvas" | "noodles";

/** The rail's entries, with each page's heading and one-line subtitle. */
const SETTINGS_PAGES: { id: SettingsTab; label: string; title: string; description: string }[] = [
  { id: "project", label: "Project", title: "Project", description: "Name, location and how the file is written." },
  { id: "providers", label: "Providers", title: "Providers", description: "API keys for the model providers this project can call." },
  { id: "comfy", label: "ComfyUI", title: "ComfyUI", description: "Where Comfy app nodes run." },
  { id: "nodeDefaults", label: "Node defaults", title: "Node defaults", description: "Applied when a node is added from the bar or a shortcut." },
  { id: "canvas", label: "Canvas", title: "Canvas", description: "How you navigate and select on the canvas." },
  { id: "noodles", label: "Noodles", title: "Noodles", description: "How the connections between nodes are drawn." },
];

/** One ruled row per provider on the Providers page, in this order. */
const PROVIDER_ROWS: { id: ProviderType; name: string; placeholder: string }[] = [
  { id: "gemini", name: "Google Gemini", placeholder: "AIza..." },
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "replicate", name: "Replicate", placeholder: "r8_..." },
  { id: "fal", name: "fal.ai", placeholder: "..." },
  { id: "kie", name: "Kie.ai", placeholder: "..." },
  { id: "wavespeed", name: "WaveSpeed", placeholder: "..." },
];

const PAN_MODES: SegmentedOption<PanMode>[] = [
  { value: "space", label: "Space + Drag" },
  { value: "middleMouse", label: "Middle Mouse" },
  { value: "always", label: "Always On" },
];

const ZOOM_MODES: SegmentedOption<ZoomMode>[] = [
  { value: "altScroll", label: "Alt + Scroll" },
  { value: "ctrlScroll", label: "Ctrl + Scroll" },
  { value: "scroll", label: "Scroll" },
];

const SELECTION_MODES: SegmentedOption<SelectionMode>[] = [
  { value: "click", label: "Click" },
  { value: "altDrag", label: "Alt + Drag" },
  { value: "shiftDrag", label: "Shift + Drag" },
];

interface ProjectSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: string, name: string, directoryPath: string) => void;
  mode: "new" | "settings";
}

export function ProjectSetupModal({
  isOpen,
  onClose,
  onSave,
  mode,
}: ProjectSetupModalProps) {
  const sanitizeProjectFolderName = (projectName: string): string => {
    return projectName
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\.+$/g, "")
      .trim();
  };

  const joinPathForPlatform = (basePath: string, folderName: string): string => {
    const trimmedBase = basePath.trim();
    const separator = /^[A-Za-z]:[\\\/]/.test(trimmedBase) || trimmedBase.startsWith("\\\\") ? "\\" : "/";
    const endsWithSeparator = trimmedBase.endsWith("/") || trimmedBase.endsWith("\\");
    return `${trimmedBase}${endsWithSeparator ? "" : separator}${folderName}`;
  };

  const getPathBasename = (fullPath: string): string => {
    const withoutTrailingSeparator = fullPath.trim().replace(/[\\/]+$/, "");
    const parts = withoutTrailingSeparator.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  };

  const ensureProjectSubfolderPath = (basePath: string, projectName: string): string => {
    const trimmedBase = basePath.trim();
    const sanitizedFolder = sanitizeProjectFolderName(projectName);
    if (!sanitizedFolder) return trimmedBase;

    const basename = getPathBasename(trimmedBase);
    if (basename.toLowerCase() === sanitizedFolder.toLowerCase()) {
      return trimmedBase;
    }

    return joinPathForPlatform(trimmedBase, sanitizedFolder);
  };

  const {
    workflowName,
    saveDirectoryPath,
    useExternalImageStorage,
    setUseExternalImageStorage,
    providerSettings,
    updateProviderApiKey,
    toggleProvider,
    maxConcurrentCalls,
    setMaxConcurrentCalls,
    canvasNavigationSettings,
    updateCanvasNavigationSettings,
    edgeStyle,
    edgeAppearance,
    setEdgeStyle,
    setEdgeAppearance,
  } = useWorkflowStore();


  // Tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>("project");

  // Project tab state
  const [name, setName] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");
  const [externalStorage, setExternalStorage] = useState(true);
  const [isValidating, setIsValidating] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider tab state
  const [localProviders, setLocalProviders] = useState<ProviderSettings>(providerSettings);
  const editedProviderKeys = useRef(new Set<ProviderType>());
  const [showApiKey, setShowApiKey] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
    replicate: false,
    fal: false,
    kie: false,
    wavespeed: false,
  });
  const [overrideActive, setOverrideActive] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
    replicate: false,
    fal: false,
    kie: false,
    wavespeed: false,
  });
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);

  // Node defaults tab state
  const [localNodeDefaults, setLocalNodeDefaults] = useState<NodeDefaultsConfig>({});
  const [showImageModelDialog, setShowImageModelDialog] = useState(false);
  const [showVideoModelDialog, setShowVideoModelDialog] = useState(false);

  // Canvas tab state
  const [localCanvasSettings, setLocalCanvasSettings] = useState<CanvasNavigationSettings>(canvasNavigationSettings);

  // Connection appearance draft (Canvas tab); applied on Save
  const [localEdgeStyle, setLocalEdgeStyle] = useState<EdgeStyle>(edgeStyle);
  const [localEdgeAppearance, setLocalEdgeAppearance] = useState<EdgeAppearance>(edgeAppearance);
  const [edgeDefaultSaved, setEdgeDefaultSaved] = useState(false);

  // ComfyUI tab state
  const [localComfySettings, setLocalComfySettings, applyImportedComfySettings] = useComfySettingsDraft(isOpen);

  // Pre-fill when opening in settings mode
  useEffect(() => {
    if (isOpen) {
      // Reset to project tab when opening
      if (mode === "new") {
        setActiveTab("project");
      }

      if (mode === "settings") {
        setName(workflowName || "");
        setDirectoryPath(saveDirectoryPath || "");
        setExternalStorage(useExternalImageStorage);
      } else if (mode === "new") {
        setName("");
        setDirectoryPath(getLastProjectBaseDir() || "");
        setExternalStorage(true);
      }

      // Sync local providers state
      editedProviderKeys.current.clear();
      setLocalProviders(providerSettings);
      setShowApiKey({ gemini: false, openai: false, anthropic: false, replicate: false, fal: false, kie: false, wavespeed: false });
      // Initialize override as active if user already has a key set
      setOverrideActive({
        gemini: !!providerSettings.providers.gemini?.apiKey,
        openai: !!providerSettings.providers.openai?.apiKey,
        anthropic: !!providerSettings.providers.anthropic?.apiKey,
        replicate: !!providerSettings.providers.replicate?.apiKey,
        fal: !!providerSettings.providers.fal?.apiKey,
        kie: !!providerSettings.providers.kie?.apiKey,
        wavespeed: !!providerSettings.providers.wavespeed?.apiKey,
      });
      setError(null);

      // Load node defaults
      setLocalNodeDefaults(loadNodeDefaults());
      setShowImageModelDialog(false);
      setShowVideoModelDialog(false);

      // Sync canvas settings
      setLocalCanvasSettings(canvasNavigationSettings);
      setLocalEdgeStyle(edgeStyle);
      setLocalEdgeAppearance(edgeAppearance);
      setEdgeDefaultSaved(false);

      // Fetch env status
      fetch("/api/env-status")
        .then((res) => res.json())
        .then((data: EnvStatusResponse) => setEnvStatus(data))
        .catch(() => setEnvStatus(null));
    }
    // Provider edits/imports must not reset other unsaved settings drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, workflowName, saveDirectoryPath, useExternalImageStorage, canvasNavigationSettings]);

  const handleBrowse = async () => {
    setIsBrowsing(true);
    setError(null);

    try {
      const response = await fetch("/api/browse-directory");
      const result = await response.json();

      if (!result.success) {
        setError(result.error || "Failed to open directory picker");
        return;
      }

      if (result.cancelled) {
        return;
      }

      if (result.path) {
        setDirectoryPath(result.path);
      }
    } catch (err) {
      setError(
        `Failed to open directory picker: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSaveProject = async () => {
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    if (!directoryPath.trim()) {
      setError("Project directory is required");
      return;
    }

    const fullProjectPath = ensureProjectSubfolderPath(directoryPath, name);

    if (!(fullProjectPath.startsWith("/") || /^[A-Za-z]:[\\\/]/.test(fullProjectPath) || fullProjectPath.startsWith("\\\\"))) {
      setError("Project directory must be an absolute path (starting with /, a drive letter, or a UNC path)");
      return;
    }

    setIsValidating(true);
    setError(null);

    try {
      // Validate path shape when it already exists
      const response = await fetch(
        `/api/workflow?path=${encodeURIComponent(fullProjectPath)}`
      );
      const result = await response.json();

      if (result.exists && !result.isDirectory) {
        setError("Project path is not a directory");
        setIsValidating(false);
        return;
      }

      const id = mode === "new" ? generateWorkflowId() : useWorkflowStore.getState().workflowId || generateWorkflowId();
      // Update external storage setting
      setUseExternalImageStorage(externalStorage);
      // Remember the base directory for next time
      setLastProjectBaseDir(directoryPath);
      onSave(id, name.trim(), fullProjectPath);
      setIsValidating(false);
    } catch (err) {
      setError(
        `Failed to validate directory: ${err instanceof Error ? err.message : "Unknown error"}`
      );
      setIsValidating(false);
    }
  };

  const handleSaveProviders = () => {
    // Save each provider's settings
    const providerIds: ProviderType[] = ["gemini", "openai", "anthropic", "replicate", "fal", "kie", "wavespeed"];
    for (const providerId of providerIds) {
      const local = localProviders.providers[providerId];
      const current = providerSettings.providers[providerId];

      if (!local || !current) continue;

      // Update enabled state if changed
      if (local.enabled !== current.enabled) {
        toggleProvider(providerId, local.enabled);
      }

      // Update API key if changed
      if (local.apiKey !== current.apiKey) {
        updateProviderApiKey(providerId, local.apiKey);
      }
    }
    // Clear model/schema caches so the next fetch reflects updated provider keys
    clearFetchCache();
    localStorage.removeItem("node-banana-models-cache");
    localStorage.removeItem("node-banana-schema-cache");
    onClose();
  };

  const handleSaveNodeDefaults = () => {
    saveNodeDefaults(localNodeDefaults);
    onClose();
  };

  const handleSaveCanvas = () => {
    updateCanvasNavigationSettings(localCanvasSettings);
    onClose();
  };

  const handleSaveNoodles = () => {
    if (localEdgeStyle !== edgeStyle) setEdgeStyle(localEdgeStyle);
    if (localEdgeAppearance !== edgeAppearance) setEdgeAppearance(localEdgeAppearance);
    onClose();
  };

  const handleSetEdgeDefault = () => {
    saveEdgeDefaults({ edgeStyle: localEdgeStyle, appearance: localEdgeAppearance });
    setEdgeDefaultSaved(true);
  };

  const handleSaveComfy = () => {
    saveComfySettings(localComfySettings);
    onClose();
  };

  const handleSave = () => {
    if (activeTab === "project") {
      handleSaveProject();
    } else if (activeTab === "providers") {
      handleSaveProviders();
    } else if (activeTab === "comfy") {
      handleSaveComfy();
    } else if (activeTab === "canvas") {
      handleSaveCanvas();
    } else if (activeTab === "noodles") {
      handleSaveNoodles();
    } else {
      handleSaveNodeDefaults();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // The model browsers are React children of this panel, so their key events
    // bubble here through the portal. Enter in one of them picks a model; it
    // must not save the (still stale) draft and close the settings dialog.
    if (showImageModelDialog || showVideoModelDialog) return;
    if (e.key === "Enter" && !isValidating && !isBrowsing) {
      handleSave();
    }
  };

  const updateLocalProvider = (
    providerId: ProviderType,
    updates: { enabled?: boolean; apiKey?: string | null }
  ) => {
    if ('apiKey' in updates) editedProviderKeys.current.add(providerId);
    setLocalProviders((prev) => ({
      providers: {
        ...prev.providers,
        [providerId]: {
          ...prev.providers[providerId],
          ...updates,
        },
      },
    }));
  };

  if (!isOpen) return null;

  const page = SETTINGS_PAGES.find((p) => p.id === activeTab) ?? SETTINGS_PAGES[0];
  const llmProvider = localNodeDefaults.llm?.provider || "google";
  const llmTemperature = localNodeDefaults.llm?.temperature ?? 0.7;
  const llmMaxTokens = localNodeDefaults.llm?.maxTokens ?? 8192;
  // On the web there is no import row, so the first provider row opens the stack.
  const hasImportRow = isDesktop();

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      className={cn(splitPanelClass, "w-[840px] h-[560px] max-w-[92vw] max-h-[85vh]")}
      panelProps={{ onKeyDown: handleKeyDown }}
    >
      {/* Rail: one entry per page, the dialog's eyebrow at its head */}
      <DialogPane width={224}>
        <div>
          <DialogEyebrow className="block pl-4 pb-3.5 text-neutral-500">
            {mode === "new" ? "New project" : "Project settings"}
          </DialogEyebrow>
          <nav aria-label="Settings pages" className="flex flex-col">
            {SETTINGS_PAGES.map((p) => (
              <DialogRailItem key={p.id} active={activeTab === p.id} onClick={() => setActiveTab(p.id)}>
                {p.label}
              </DialogRailItem>
            ))}
          </nav>
        </div>
        <DialogPaneFoot version={APP_VERSION} />
      </DialogPane>

      <DialogPage>
        <DialogPageHead />
        <DialogPageTitle heading={page.title} lead={page.description} />

        {/* Scrollable page content */}
        <DialogPageBody>

        {/* Project Tab Content */}
        {activeTab === "project" && (
          <div className="flex flex-col gap-[18px]">
            <Field id="project-name" label="Project name">
              <TextInput
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
              />
            </Field>

            <Field
              id="project-directory"
              label="Project directory"
              help="Workflow files and images will be saved here. Subfolders for inputs and generations will be auto-created."
            >
              <div className="flex gap-2">
                <TextInput
                  id="project-directory"
                  type="text"
                  value={directoryPath}
                  onChange={(e) => setDirectoryPath(e.target.value)}
                  placeholder="/Users/username/projects/my-project"
                />
                <DialogButton
                  variant="outline"
                  size="md"
                  onClick={handleBrowse}
                  disabled={isBrowsing}
                  className="shrink-0"
                >
                  {isBrowsing ? "..." : "Browse"}
                </DialogButton>
              </div>
            </Field>

            <DialogRow
              title="Embed images as base64"
              description="Embeds all images in workflow, larger workflow files. Can hit memory limits on very large workflows."
              className="pt-[18px] pb-0"
            >
              <Switch
                checked={!externalStorage}
                onChange={() => setExternalStorage(externalStorage ? false : true)}
                label="Embed images as base64"
              />
            </DialogRow>

            {error && <DialogStatus tone="error">{error}</DialogStatus>}
          </div>
        )}

        {/* Providers Tab Content */}
        {activeTab === "providers" && (
          <div>
            <EnvironmentImport onImported={result => {
              const imported = getProviderSettings();
              setLocalProviders(previous => ({ providers: Object.fromEntries(Object.entries(previous.providers).map(([id, config]) => [id, {
                ...config, apiKey: editedProviderKeys.current.has(id as ProviderType) ? config.apiKey : imported.providers[id as ProviderType]?.apiKey,
              }])) as ProviderSettings['providers'] }));
              const comfy = getComfySettings();
              applyImportedComfySettings(comfy, [
                ...comfySecretFields,
                ...Object.keys(result.preferences) as (keyof typeof result.preferences)[],
              ]);
            }} />

            {PROVIDER_ROWS.map((provider, index) => {
              const fromEnv = Boolean(envStatus?.[provider.id]);
              return (
                <DialogRow
                  key={provider.id}
                  title={provider.name}
                  first={index === 0 && !hasImportRow}
                  className={index === 0 && !hasImportRow ? "pt-0 pb-2" : "py-2"}
                >
                  {fromEnv && !overrideActive[provider.id] ? (
                    <div className="flex items-center gap-3.5">
                      <DialogStatus tone="ok">Configured via .env</DialogStatus>
                      <DialogTextButton
                        onClick={() => setOverrideActive((prev) => ({ ...prev, [provider.id]: true }))}
                      >
                        Override
                      </DialogTextButton>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <TextInput
                        type={showApiKey[provider.id] ? "text" : "password"}
                        value={localProviders.providers[provider.id]?.apiKey || ""}
                        onChange={(e) => updateLocalProvider(provider.id, { apiKey: e.target.value || null })}
                        placeholder={provider.placeholder}
                        aria-label={`${provider.name} API key`}
                        className="w-[220px] h-8"
                      />
                      <DialogTextButton
                        onClick={() => setShowApiKey((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                      >
                        {showApiKey[provider.id] ? "Hide" : "Show"}
                      </DialogTextButton>
                      {fromEnv && (
                        <DialogTextButton
                          className="text-neutral-500"
                          onClick={() => {
                            setOverrideActive((prev) => ({ ...prev, [provider.id]: false }));
                            updateLocalProvider(provider.id, { apiKey: null });
                          }}
                        >
                          Cancel
                        </DialogTextButton>
                      )}
                    </div>
                  )}
                </DialogRow>
              );
            })}

            <p className="mt-2.5 pt-2.5 border-t border-card text-xs leading-4 text-neutral-500">
              {isDesktop() ? 'Keys are encrypted in your desktop profile. Imported keys are saved immediately.' : <>Add API keys via <code className="px-1 py-0.5 rounded bg-card font-mono text-[11px] text-neutral-400">.env.local</code> for server-side storage. Keys added here override .env and are stored in your browser.</>}
            </p>
          </div>
        )}

        {/* Node Defaults Tab Content */}
        {activeTab === "nodeDefaults" && (
          <div>
            {/* GenerateImage Section */}
            <DialogRow
              first
              title="Default image model"
              description={localNodeDefaults.generateImage?.selectedModel ? undefined : "System default (Gemini nano-banana-pro)"}
              className="pt-0 pb-3"
            >
              {localNodeDefaults.generateImage?.selectedModel ? (
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center gap-2 text-[13px] text-neutral-100">
                    {getProviderIcon(localNodeDefaults.generateImage.selectedModel.provider)}
                    <span className="truncate max-w-[150px]">
                      {localNodeDefaults.generateImage.selectedModel.displayName}
                    </span>
                  </span>
                  <DialogButton variant="outline" size="md" className="h-8" onClick={() => setShowImageModelDialog(true)}>
                    Change
                  </DialogButton>
                  <DialogTextButton
                    onClick={() => {
                      const { generateImage, ...rest } = localNodeDefaults;
                      setLocalNodeDefaults(rest);
                    }}
                  >
                    Clear
                  </DialogTextButton>
                </div>
              ) : (
                <DialogButton variant="outline" size="md" className="h-8" onClick={() => setShowImageModelDialog(true)}>
                  Select model
                </DialogButton>
              )}
            </DialogRow>

            {/* GenerateVideo Section */}
            <DialogRow
              title="Default video model"
              description={localNodeDefaults.generateVideo?.selectedModel ? undefined : "None set (select on first use)"}
              className="py-3"
            >
              {localNodeDefaults.generateVideo?.selectedModel ? (
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center gap-2 text-[13px] text-neutral-100">
                    {getProviderIcon(localNodeDefaults.generateVideo.selectedModel.provider)}
                    <span className="truncate max-w-[150px]">
                      {localNodeDefaults.generateVideo.selectedModel.displayName}
                    </span>
                  </span>
                  <DialogButton variant="outline" size="md" className="h-8" onClick={() => setShowVideoModelDialog(true)}>
                    Change
                  </DialogButton>
                  <DialogTextButton
                    onClick={() => {
                      const { generateVideo, ...rest } = localNodeDefaults;
                      setLocalNodeDefaults(rest);
                    }}
                  >
                    Clear
                  </DialogTextButton>
                </div>
              ) : (
                <DialogButton variant="outline" size="md" className="h-8" onClick={() => setShowVideoModelDialog(true)}>
                  Select model
                </DialogButton>
              )}
            </DialogRow>

            {/* LLM Section */}
            <div className="flex items-center justify-between gap-6 pt-3.5 pb-2.5 border-t border-card">
              <div className="min-w-0">
                <DialogRowTitle>Default LLM settings</DialogRowTitle>
                {!localNodeDefaults.llm ? (
                  <p className="mt-0.5 text-xs leading-4 text-ink-3">{`Using system defaults (Google ${llmModelLabel(DEFAULT_LLM_MODEL)})`}</p>
                ) : null}
              </div>
              {localNodeDefaults.llm && (
                <DialogTextButton
                  onClick={() => {
                    const { llm, ...rest } = localNodeDefaults;
                    setLocalNodeDefaults(rest);
                  }}
                >
                  Clear
                </DialogTextButton>
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {/* Provider dropdown */}
              <Field id="llm-provider" label="Provider">
                <Select
                  id="llm-provider"
                  value={llmProvider}
                  onChange={(e) => {
                    const newProvider = e.target.value as LLMProvider;
                    const firstModelForProvider = defaultLLMModel(newProvider);
                    const currentTemp = localNodeDefaults.llm?.temperature ?? 0.7;
                    setLocalNodeDefaults(prev => ({
                      ...prev,
                      llm: {
                        ...prev.llm,
                        provider: newProvider,
                        model: firstModelForProvider,
                        // Clamp temperature for Anthropic (max 1.0)
                        ...(newProvider === "anthropic" && currentTemp > 1 ? { temperature: 1 } : {}),
                      }
                    }));
                  }}
                >
                  {LLM_PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </Select>
              </Field>

              {/* Model dropdown */}
              <Field id="llm-model" label="Model">
                <Select
                  id="llm-model"
                  value={localNodeDefaults.llm?.model || defaultLLMModel(llmProvider)}
                  onChange={(e) => {
                    setLocalNodeDefaults(prev => ({
                      ...prev,
                      llm: { ...prev.llm, model: e.target.value as LLMModelType }
                    }));
                  }}
                >
                  {llmModelOptions(llmProvider, localNodeDefaults.llm?.model).map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </Field>

              {/* Temperature slider */}
              <div>
                <label htmlFor="llm-temperature" className={cn(labelClass, "mb-2")}>Temperature</label>
                <Slider
                  id="llm-temperature"
                  label="Temperature"
                  min={0}
                  max={llmProvider === "anthropic" ? 1 : 2}
                  step={0.1}
                  value={llmTemperature}
                  readout={llmTemperature.toFixed(1)}
                  onChange={(temperature) => {
                    setLocalNodeDefaults(prev => ({
                      ...prev,
                      llm: { ...prev.llm, temperature }
                    }));
                  }}
                />
              </div>

              {/* Max Tokens slider */}
              <div>
                <label htmlFor="llm-max-tokens" className={cn(labelClass, "mb-2")}>Max tokens</label>
                <Slider
                  id="llm-max-tokens"
                  label="Max tokens"
                  min={256}
                  max={16384}
                  step={256}
                  value={llmMaxTokens}
                  readout={llmMaxTokens.toLocaleString()}
                  onChange={(maxTokens) => {
                    setLocalNodeDefaults(prev => ({
                      ...prev,
                      llm: { ...prev.llm, maxTokens }
                    }));
                  }}
                />
              </div>
            </div>

            {/* Execution Section */}
            <DialogRow
              title="Max parallel calls"
              description="Maximum number of nodes to execute in parallel during workflow execution. Higher values may improve speed but increase API rate limit risk."
              className="mt-3.5"
            >
              <Slider
                className="w-[200px] shrink-0"
                label="Max parallel calls"
                min={1}
                max={10}
                step={1}
                value={maxConcurrentCalls}
                onChange={(value) => setMaxConcurrentCalls(value)}
              />
            </DialogRow>

            <p className="pt-3 border-t border-card text-xs leading-4 text-neutral-500">
              These defaults are applied when creating nodes via keyboard shortcuts (Shift+G, Shift+L, etc).
            </p>
          </div>
        )}

        {/* ComfyUI Tab Content */}
        {activeTab === "comfy" && (
          <ComfySettingsTab settings={localComfySettings} onChange={setLocalComfySettings} />
        )}

        {/* Canvas Tab Content */}
        {activeTab === "canvas" && (
          <div>
            {/* Pan Mode */}
            <DialogRow
              first
              title="Pan mode"
              description={
                <>
                  {localCanvasSettings.panMode === "space" && "Hold Space and drag to pan"}
                  {localCanvasSettings.panMode === "middleMouse" && "Click and drag with middle mouse button"}
                  {localCanvasSettings.panMode === "always" && "Pan without holding any keys"}
                </>
              }
              className="pt-0 pb-[18px]"
            >
              <Segmented
                className="w-[312px] shrink-0"
                label="Pan mode"
                options={PAN_MODES}
                value={localCanvasSettings.panMode}
                onChange={(panMode) => setLocalCanvasSettings({ ...localCanvasSettings, panMode })}
              />
            </DialogRow>

            {/* Zoom Mode */}
            <DialogRow
              title="Zoom mode"
              description={
                <>
                  {localCanvasSettings.zoomMode === "altScroll" && "Hold Alt and scroll to zoom"}
                  {localCanvasSettings.zoomMode === "ctrlScroll" && "Hold Ctrl/Cmd and scroll to zoom"}
                  {localCanvasSettings.zoomMode === "scroll" && "Scroll to zoom without modifier keys"}
                </>
              }
              className="py-[18px]"
            >
              <Segmented
                className="w-[312px] shrink-0"
                label="Zoom mode"
                options={ZOOM_MODES}
                value={localCanvasSettings.zoomMode}
                onChange={(zoomMode) => setLocalCanvasSettings({ ...localCanvasSettings, zoomMode })}
              />
            </DialogRow>

            {/* Selection Mode */}
            <DialogRow
              title="Selection mode"
              description={
                <>
                  {localCanvasSettings.selectionMode === "click" && "Click to select nodes"}
                  {localCanvasSettings.selectionMode === "altDrag" && "Hold Alt and drag to select"}
                  {localCanvasSettings.selectionMode === "shiftDrag" && "Hold Shift and drag to select"}
                </>
              }
              className="py-[18px]"
            >
              <Segmented
                className="w-[312px] shrink-0"
                label="Selection mode"
                options={SELECTION_MODES}
                value={localCanvasSettings.selectionMode}
                onChange={(selectionMode) => setLocalCanvasSettings({ ...localCanvasSettings, selectionMode })}
              />
            </DialogRow>
          </div>
        )}

        {/* Noodles Tab Content */}
        {activeTab === "noodles" && (
          <ConnectionSettings
            edgeStyle={localEdgeStyle}
            appearance={localEdgeAppearance}
            onEdgeStyleChange={setLocalEdgeStyle}
            onAppearanceChange={setLocalEdgeAppearance}
            onSetDefault={handleSetEdgeDefault}
            defaultSaved={edgeDefaultSaved}
          />
        )}

        </DialogPageBody>

        <DialogPageFooter>
          <DialogButton variant="ghost" size="md" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={activeTab === "project" && (isValidating || isBrowsing)}
          >
            {activeTab === "project"
              ? (isValidating ? "Validating..." : mode === "new" ? "Create" : "Save")
              : "Save"
            }
          </DialogButton>
        </DialogPageFooter>
      </DialogPage>

      {/* Model Selection Dialogs */}
      {showImageModelDialog && (
        <ModelSearchDialog
          isOpen={showImageModelDialog}
          onClose={() => setShowImageModelDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            setLocalNodeDefaults(prev => ({
              ...prev,
              generateImage: {
                ...prev.generateImage,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                }
              }
            }));
            setShowImageModelDialog(false);
          }}
          initialCapabilityFilter="image"
        />
      )}
      {showVideoModelDialog && (
        <ModelSearchDialog
          isOpen={showVideoModelDialog}
          onClose={() => setShowVideoModelDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            setLocalNodeDefaults(prev => ({
              ...prev,
              generateVideo: {
                ...prev.generateVideo,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                }
              }
            }));
            setShowVideoModelDialog(false);
          }}
          initialCapabilityFilter="video"
        />
      )}
    </Dialog>
  );
}
