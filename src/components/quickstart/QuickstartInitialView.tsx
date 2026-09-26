"use client";

import type { ReactNode } from "react";

import {
  DialogChip,
  DialogEyebrow,
  DialogPage,
  DialogPageHead,
  DialogPane,
  DialogWordmark,
} from "@/components/ui/Dialog";
import { APP_VERSION } from "@/lib/appVersion";

interface QuickstartInitialViewProps {
  onNewProject: () => void;
  onSelectTemplates: () => void;
  onStartWithAgent: () => void;
  onSelectLoad: () => void;
}

/**
 * The first view of the welcome dialog. The pane carries the mark, the
 * stacked wordmark and the site's three points; the page is four ruled
 * rows, one per way in, and the links along the bottom.
 */
export function QuickstartInitialView({
  onNewProject,
  onSelectTemplates,
  onStartWithAgent,
  onSelectLoad,
}: QuickstartInitialViewProps) {
  return (
    <>
      <DialogPane width={300}>
        <div className="flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/banana_icon.png" alt="" className="w-10 h-10 rounded-[10px]" />
          {APP_VERSION && <DialogEyebrow className="text-neutral-500">{APP_VERSION}</DialogEyebrow>}
        </div>
        <div>
          <h1 className="sr-only">Node Banana</h1>
          <DialogWordmark />
          <ul className="mt-[18px] flex flex-col gap-1 font-mono text-[11px] leading-4 tracking-eyebrow uppercase text-ink-3">
            <li>Free</li>
            <li>Open source</li>
            <li>Bring your own key</li>
          </ul>
        </div>
      </DialogPane>

      <DialogPage>
        <DialogPageHead eyebrow="Welcome" />
        <div className="flex-1 min-h-0 px-8 pt-2 flex flex-col">
          <OptionRow
            onClick={onNewProject}
            title="New project"
            description="Start a new workflow"
            first
          />
          <OptionRow
            onClick={onSelectLoad}
            title="Load workflow"
            description="Open existing file"
          />
          <OptionRow
            onClick={onSelectTemplates}
            title="Templates"
            description="Pre-built workflows"
          />
          <OptionRow
            onClick={onStartWithAgent}
            title="Start with Agent"
            description="Describe it and the agent builds it"
            badge={<DialogChip className="nb-new-badge">New</DialogChip>}
          />
        </div>
        <div className="shrink-0 flex flex-wrap gap-x-5 gap-y-2 px-8 pt-4 pb-5">
          <FootLink href="https://node-banana-docs.vercel.app/">Docs</FootLink>
          <FootLink href="https://discord.com/invite/89Nr6EKkTf">Discord</FootLink>
          <FootLink href="https://x.com/ReflctWillie">@ReflctWillie</FootLink>
        </div>
      </DialogPage>
    </>
  );
}

function OptionRow({
  onClick,
  title,
  description,
  badge,
  first = false,
}: {
  onClick: () => void;
  title: string;
  description: string;
  badge?: ReactNode;
  first?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center justify-between gap-4 w-full py-4 px-1 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:bg-white/[0.04] ${first ? "" : "border-t border-card"}`}
    >
      <span className="flex flex-col gap-[3px] min-w-0">
        <span className="flex items-center gap-2.5 font-display text-[17px] leading-[22px] font-semibold tracking-[-0.015em] text-neutral-100">
          <span>{title}</span>
          {badge}
        </span>
        <span className="text-[13px] leading-[18px] text-neutral-400">{description}</span>
      </span>
      <svg
        className="w-[18px] h-[18px] shrink-0 text-neutral-500 group-hover:text-neutral-300 transition-colors"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  );
}

function FootLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[11px] leading-4 tracking-eyebrow uppercase text-neutral-400 hover:text-neutral-100 transition-colors"
    >
      {children}
    </a>
  );
}
