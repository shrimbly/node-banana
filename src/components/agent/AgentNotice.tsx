"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LogInIcon } from "lucide-react";
import { DialogTextButton } from "@/components/ui/Dialog";
import { cn } from "@/components/agent/lib/utils";
import { HARNESS_LABELS, type AgentStatusTone } from "@/lib/agent/client/readiness";
import type { AgentDataParts, AgentErrorCode, AgentHarnessId } from "@/lib/agent/types";
import { StatusDot } from "./AgentChrome";

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

/** The dot carries the tone; the text stays plain. */
const TONE_DOTS: Record<Tone, AgentStatusTone> = {
  info: "unknown",
  warning: "attention",
  danger: "blocked",
};

/** A text-only action under a notice or on a card: "Try again", "Dismiss", "Check again". */
export function AgentTextButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <DialogTextButton
      {...rest}
      className={cn("inline-flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0", className)}
    >
      {children}
    </DialogTextButton>
  );
}

/** An inline notice in the conversation: a status dot, plain text, text-button actions. */
export function AgentAlert({
  tone,
  children,
  actions,
}: {
  tone: Tone;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      data-tone={tone}
      className="flex w-full gap-2.5 text-[13px] leading-5 text-neutral-300"
    >
      <StatusDot tone={TONE_DOTS[tone]} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="break-words">{children}</div>
        {actions && <div className="-ml-1.5 mt-1 flex flex-wrap items-center gap-1">{actions}</div>}
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
      actions={
        offersSignIn ? (
          <AgentTextButton onClick={() => onSignIn(notice.harness, notice.code)}>
            <LogInIcon aria-hidden="true" strokeWidth={1.75} />
            Sign in to {label}
          </AgentTextButton>
        ) : undefined
      }
    >
      {notice.message}
    </AgentAlert>
  );
}
