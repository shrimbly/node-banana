"use client";

import { useState, useCallback, useMemo } from "react";
import type { DashboardProject } from "@/store/utils/localStorage";

function formatRelativeTime(timestamp: number | undefined | null): string {
  if (!timestamp) return "Never saved";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatCost(cost: number): string {
  if (cost === 0) return "";
  return `$${cost.toFixed(2)}`;
}

function truncatePath(dirPath: string, maxLen: number = 50): string {
  if (dirPath.length <= maxLen) return dirPath;
  const parts = dirPath.split("/");
  if (parts.length <= 2) return "..." + dirPath.slice(-maxLen);
  return ".../" + parts.slice(-2).join("/");
}

// Derive a "workflow type" label from the node composition
function deriveWorkflowType(summary?: Record<string, number>): { label: string; color: string } | null {
  if (!summary) return null;
  const has = (k: string) => (summary[k] ?? 0) > 0;

  if (has("generateVideo")) return { label: "Video", color: "text-purple-400 bg-purple-500/15 border-purple-500/20" };
  if (has("generate3d")) return { label: "3D", color: "text-orange-400 bg-orange-500/15 border-orange-500/20" };
  if (has("generateAudio")) return { label: "Audio", color: "text-green-400 bg-green-500/15 border-green-500/20" };
  if (has("nanoBanana")) return { label: "Image Gen", color: "text-yellow-400 bg-yellow-500/15 border-yellow-500/20" };
  if (has("llmGenerate")) return { label: "LLM", color: "text-blue-400 bg-blue-500/15 border-blue-500/20" };
  if (has("annotation")) return { label: "Annotation", color: "text-cyan-400 bg-cyan-500/15 border-cyan-500/20" };
  return null;
}

// Small node-type icon pills
const NODE_TYPE_ICONS: Record<string, { label: string; icon: React.ReactNode }> = {
  nanoBanana: {
    label: "Generate",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
    ),
  },
  generateVideo: {
    label: "Video",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
      </svg>
    ),
  },
  llmGenerate: {
    label: "LLM",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
      </svg>
    ),
  },
  prompt: {
    label: "Prompts",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
    ),
  },
  imageInput: {
    label: "Images",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75Z" />
      </svg>
    ),
  },
  annotation: {
    label: "Draw",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" />
      </svg>
    ),
  },
  generateAudio: {
    label: "Audio",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
      </svg>
    ),
  },
  generate3d: {
    label: "3D",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
      </svg>
    ),
  },
};

// Ordered by visual priority
const NODE_TYPE_DISPLAY_ORDER = [
  "nanoBanana", "generateVideo", "generate3d", "generateAudio",
  "llmGenerate", "annotation", "prompt", "imageInput",
];

interface ProjectCardProps {
  project: DashboardProject;
  isCurrent: boolean;
  onOpen: (workflowId: string) => void;
  onDelete: (workflowId: string) => void;
}

export function ProjectCard({ project, isCurrent, onOpen, onDelete }: ProjectCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (showDeleteConfirm) {
      onDelete(project.workflowId);
      setShowDeleteConfirm(false);
    } else {
      setShowDeleteConfirm(true);
    }
  }, [showDeleteConfirm, onDelete, project.workflowId]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  }, []);

  const workflowType = useMemo(
    () => deriveWorkflowType(project.nodeTypeSummary),
    [project.nodeTypeSummary]
  );

  // Get node type pills to show (top 4 by display order)
  const nodeTypePills = useMemo(() => {
    if (!project.nodeTypeSummary) return [];
    return NODE_TYPE_DISPLAY_ORDER
      .filter((t) => (project.nodeTypeSummary![t] ?? 0) > 0)
      .slice(0, 4)
      .map((t) => ({
        type: t,
        count: project.nodeTypeSummary![t],
        ...NODE_TYPE_ICONS[t],
      }));
  }, [project.nodeTypeSummary]);

  return (
    <button
      onClick={() => onOpen(project.workflowId)}
      className={`group relative w-full text-left p-5 rounded-xl border transition-all duration-150 ${
        isCurrent
          ? "border-blue-500/40 bg-blue-500/[0.07] hover:bg-blue-500/[0.12] shadow-[0_0_0_1px_rgba(59,130,246,0.1)]"
          : "border-neutral-700/50 hover:border-neutral-600 hover:bg-neutral-750/50"
      }`}
    >
      {/* Top row: name + badges + delete */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[15px] font-medium text-neutral-100 truncate">
              {project.name}
            </h3>
            {isCurrent && (
              <span className="flex-shrink-0 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/20">
                Active
              </span>
            )}
            {workflowType && (
              <span className={`flex-shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full border ${workflowType.color}`}>
                {workflowType.label}
              </span>
            )}
          </div>
        </div>

        {/* Delete button */}
        <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {showDeleteConfirm ? (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={handleDelete}
                className="px-2.5 py-1 text-[11px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-md transition-colors"
              >
                Delete
              </button>
              <button
                onClick={handleCancelDelete}
                className="px-2.5 py-1 text-[11px] font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600 rounded-md transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
              title="Delete project"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Path row */}
      <p className="text-xs text-neutral-500 truncate mt-1.5" title={project.directoryPath}>
        {truncatePath(project.directoryPath)}
      </p>

      {/* Node type pills */}
      {nodeTypePills.length > 0 && (
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          {nodeTypePills.map((pill) => (
            <span
              key={pill.type}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-neutral-400 bg-neutral-700/40 rounded-md border border-neutral-700/30"
            >
              {pill.icon}
              {pill.count > 1 ? `${pill.label} x${pill.count}` : pill.label}
            </span>
          ))}
        </div>
      )}

      {/* Bottom meta row */}
      <div className="flex items-center gap-3 mt-3 text-xs text-neutral-500">
        {/* Time */}
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          {formatRelativeTime(project.updatedAt ?? project.lastSavedAt)}
        </span>

        {(project.nodeCount != null && project.nodeCount > 0) && (
          <>
            <span className="text-neutral-700">·</span>
            <span>{project.nodeCount} nodes</span>
          </>
        )}

        {(project.edgeCount != null && project.edgeCount > 0) && (
          <>
            <span className="text-neutral-700">·</span>
            <span>{project.edgeCount} connections</span>
          </>
        )}

        {project.primaryModel && (
          <>
            <span className="text-neutral-700">·</span>
            <span className="text-neutral-400">{project.primaryModel}</span>
          </>
        )}

        {project.incurredCost > 0 && (
          <>
            <span className="text-neutral-700">·</span>
            <span className="text-green-500/80">{formatCost(project.incurredCost)}</span>
          </>
        )}
      </div>
    </button>
  );
}
