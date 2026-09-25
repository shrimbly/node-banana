"use client";

import type { ReactNode } from "react";
import { CircleAlertIcon, HourglassIcon, InfoIcon, LogInIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Button } from "@/components/agent/ui/button";
import { HARNESS_LABELS } from "@/lib/agent/client/readiness";
import type { AgentDataParts, AgentErrorCode, AgentHarnessId } from "@/lib/agent/types";

type Tone = "info" | "warning" | "danger";

const NOTICE_TONES: Record<AgentErrorCode, Tone> = {
  not_installed: "danger",
  not_signed_in: "warning",
  wrong_billing: "warning",
  usage_limit: "warning",
  session_busy: "info",
  bad_request: "danger",
  aborted: "info",
  harness_error: "danger",
};

const TONE_CLASSES: Record<Tone, string> = {
  info: "border-neutral-600 bg-neutral-900/60 text-neutral-300 [&>svg]:text-neutral-400",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-100 [&>svg]:text-amber-400",
  danger: "border-red-500/30 bg-red-500/10 text-red-100 [&>svg]:text-red-400",
};

const TONE_ICONS: Record<Tone, ReactNode> = {
  info: <InfoIcon />,
  warning: <TriangleAlertIcon />,
  danger: <CircleAlertIcon />,
};

/** An inline alert in the conversation. */
export function AgentAlert({
  tone,
  icon,
  children,
  actions,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex w-full gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        TONE_CLASSES[tone],
      )}
    >
      {icon ?? TONE_ICONS[tone]}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="break-words">{children}</div>
        {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

/** A sign-in started from a notice (or the sign-in card, without a notice code). */
export type AgentNoticeSignIn = (harness: AgentHarnessId, noticeCode?: AgentErrorCode) => void;

/** A `data-agent-notice` part: why a turn couldn't run, with a way forward when there is one. */
export function AgentNotice({
  notice,
  onSignIn,
}: {
  notice: AgentDataParts["agent-notice"];
  /**
   * Offered for not_signed_in / wrong_billing notices; told which notice it
   * came from (a not_signed_in after a rejected turn needs a forced sign-in).
   */
  onSignIn?: AgentNoticeSignIn;
}) {
  const tone = NOTICE_TONES[notice.code] ?? "danger";
  const label = HARNESS_LABELS[notice.harness] ?? notice.harness;
  const offersSignIn = onSignIn && (notice.code === "not_signed_in" || notice.code === "wrong_billing");

  return (
    <AgentAlert
      tone={tone}
      icon={notice.code === "usage_limit" ? <HourglassIcon /> : undefined}
      actions={
        offersSignIn ? (
          <Button size="xs" variant="secondary" onClick={() => onSignIn(notice.harness, notice.code)}>
            <LogInIcon />
            Sign in to {label}
          </Button>
        ) : undefined
      }
    >
      {notice.message}
    </AgentAlert>
  );
}
