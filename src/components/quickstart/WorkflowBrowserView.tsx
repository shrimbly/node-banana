"use client";

import { useState, useEffect, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import {
  DialogButton,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageHead,
  DialogPane,
  DialogPaneFoot,
  DialogRowTitle,
  DialogStatus,
  DialogTextButton,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
import { APP_VERSION } from "@/lib/appVersion";
import { QuickstartBackButton } from "./QuickstartBackButton";
import {
  getWorkflowsDirectory,
  setWorkflowsDirectory,
} from "@/store/utils/localStorage";

interface WorkflowListEntry {
  name: string;
  directoryPath: string;
  relativePath: string;
  lastModified: number;
}

interface WorkflowBrowserViewProps {
  onBack?: () => void;
  onWorkflowLoaded: (workflow: WorkflowFile, directoryPath: string) => void;
  onClose?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function dirBasename(dirPath: string): string {
  return dirPath.split("/").filter(Boolean).pop() || dirPath;
}

function FolderIcon({ className, strokeWidth = 1.5 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
    </svg>
  );
}

/**
 * "Your workflows": the pane names the folder and holds the actions on it,
 * the page lists the projects inside as ruled rows. Without a folder the
 * page is one centred prompt to choose it.
 */
export function WorkflowBrowserView({
  onBack,
  onWorkflowLoaded,
  onClose,
}: WorkflowBrowserViewProps) {
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowListEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingWorkflow, setLoadingWorkflow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaultDir(getWorkflowsDirectory());
  }, []);

  const fetchWorkflows = useCallback(async (dirPath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/list-workflows?path=${encodeURIComponent(dirPath)}`
      );
      const result = await res.json();
      if (result.success) {
        setWorkflows(result.workflows);
        if (result.workflows.length === 0) {
          setError("No workflows found in this folder");
        }
      } else {
        setError(result.error || "Failed to list workflows");
      }
    } catch {
      setError("Failed to fetch workflows");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (defaultDir) {
      fetchWorkflows(defaultDir);
    }
  }, [defaultDir, fetchWorkflows]);

  const browseAndSetDir = useCallback(async () => {
    try {
      const res = await fetch("/api/browse-directory");
      const result = await res.json();
      if (result.success && !result.cancelled && result.path) {
        setWorkflowsDirectory(result.path);
        setDefaultDir(result.path);
      }
    } catch {
      setError("Failed to open directory picker");
    }
  }, []);

  const handleBrowseOther = useCallback(async () => {
    try {
      const browseRes = await fetch("/api/browse-directory");
      const browseResult = await browseRes.json();

      if (
        !browseResult.success ||
        browseResult.cancelled ||
        !browseResult.path
      ) {
        if (!browseResult.success && !browseResult.cancelled) {
          setError(browseResult.error || "Failed to open directory picker");
        }
        return;
      }

      const dirPath = browseResult.path;

      setLoadingWorkflow(dirPath);
      const loadRes = await fetch(
        `/api/workflow?path=${encodeURIComponent(dirPath)}&load=true`
      );
      const loadResult = await loadRes.json();
      setLoadingWorkflow(null);

      if (!loadResult.success) {
        setError(loadResult.error || "No workflow file found in directory");
        return;
      }

      onWorkflowLoaded(loadResult.workflow as WorkflowFile, dirPath);
      onClose?.();
    } catch {
      setLoadingWorkflow(null);
      setError("Failed to open workflow");
    }
  }, [onWorkflowLoaded, onClose]);

  const handleSelectWorkflow = useCallback(
    async (entry: WorkflowListEntry) => {
      setLoadingWorkflow(entry.directoryPath);
      setError(null);
      try {
        const res = await fetch(
          `/api/workflow?path=${encodeURIComponent(entry.directoryPath)}&load=true`
        );
        const result = await res.json();

        if (!result.success) {
          setError(result.error || "Failed to load workflow");
          setLoadingWorkflow(null);
          return;
        }

        onWorkflowLoaded(
          result.workflow as WorkflowFile,
          entry.directoryPath
        );
        onClose?.();
      } catch {
        setError("Failed to load workflow");
        setLoadingWorkflow(null);
      }
    },
    [onWorkflowLoaded, onClose]
  );

  const heading = (
    <h2
      id="workflow-browser-title"
      className="font-display text-[28px] leading-8 font-bold tracking-display text-neutral-100"
    >
      Your workflows
    </h2>
  );

  // State A: No default directory configured
  if (defaultDir === null) {
    return (
      <>
        <DialogPane width={300}>
          <div className="flex flex-col gap-[18px]">
            {onBack && <QuickstartBackButton onClick={onBack} />}
            {heading}
          </div>
          <DialogPaneFoot version={APP_VERSION || undefined} />
        </DialogPane>

        <DialogPage data-testid="workflow-browser-view">
          <DialogPageHead eyebrow="No folder yet" />
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 px-12 pb-6 text-center">
            <FolderIcon className="w-10 h-10 text-neutral-600" strokeWidth={1.25} />
            <p className="max-w-[300px] text-[13px] leading-[19px] text-neutral-400">
              Choose the folder that contains your workflow projects. You can change this later.
            </p>
            <DialogButton variant="primary" size="md" onClick={browseAndSetDir}>
              Choose folder
            </DialogButton>
          </div>
        </DialogPage>
      </>
    );
  }

  // State B: Default directory configured — show listing
  const busy = loadingWorkflow !== null;

  return (
    <>
      <DialogPane width={300}>
        <div className="flex flex-col gap-[18px] min-h-0">
          {onBack && <QuickstartBackButton onClick={onBack} />}
          {heading}
          <div className="flex flex-col gap-1.5 min-h-0">
            <DialogEyebrow className="tabular-nums">
              {workflows.length} project{workflows.length !== 1 ? "s" : ""}
            </DialogEyebrow>
            <p className="font-mono text-[11px] leading-4 text-neutral-500 break-all" title={defaultDir}>
              {defaultDir}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-start gap-2">
          <DialogButton variant="outline" size="md" onClick={handleBrowseOther} disabled={busy}>
            <FolderIcon className="w-3.5 h-3.5" />
            Open from directory
          </DialogButton>
          <DialogTextButton onClick={browseAndSetDir} disabled={busy}>
            Change folder
          </DialogTextButton>
        </div>
      </DialogPane>

      <DialogPage data-testid="workflow-browser-view">
        <DialogPageHead eyebrow="Recent" />

        <DialogPageBody className="overscroll-contain pt-2 pb-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
            </div>
          ) : error && workflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FolderIcon className="w-10 h-10 text-neutral-600 mb-4" strokeWidth={1.25} />
              <p className="font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
                No workflows found
              </p>
              <p className="mt-1 text-xs leading-4 text-ink-3">
                This folder doesn&apos;t contain any workflow projects
              </p>
            </div>
          ) : (
            <div className="flex flex-col">
              {workflows.map((entry, index) => {
                const isActive = loadingWorkflow === entry.directoryPath;
                return (
                  <button
                    key={entry.directoryPath}
                    type="button"
                    onClick={() => handleSelectWorkflow(entry)}
                    disabled={busy}
                    aria-busy={isActive || undefined}
                    className={cn(
                      "group flex items-center gap-3 w-full py-3 px-1 text-left transition-colors",
                      "hover:bg-white/[0.03] focus-visible:outline-none focus-visible:bg-white/[0.04]",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      index > 0 && "border-t border-card",
                      isActive && "bg-white/[0.03] opacity-100"
                    )}
                  >
                    <span className="flex shrink-0 items-center justify-center w-[18px] h-[18px] text-neutral-500 group-hover:text-neutral-300 transition-colors">
                      {isActive ? (
                        <span className="w-3.5 h-3.5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
                      ) : (
                        <FolderIcon className="w-[18px] h-[18px]" />
                      )}
                    </span>

                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <DialogRowTitle className="truncate">{entry.name}</DialogRowTitle>
                      <span className="font-mono text-[11px] leading-4 text-neutral-500 truncate">
                        {entry.relativePath || dirBasename(entry.directoryPath)}
                      </span>
                    </span>

                    <span className="shrink-0 font-mono text-[11px] leading-4 text-neutral-500 tabular-nums">
                      {formatRelativeTime(entry.lastModified)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {error && workflows.length > 0 && (
            <DialogStatus tone="error" className="mt-3 px-1 normal-case tracking-normal text-neutral-300">
              {error}
            </DialogStatus>
          )}
        </DialogPageBody>
      </DialogPage>
    </>
  );
}
