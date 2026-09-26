"use client";

import type { ReactNode } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { DialogButton } from "@/components/ui/Dialog";
import { cn } from "@/components/agent/lib/utils";
import {
  HARNESS_BILLING_COPY,
  HARNESS_CLI_OPENS_BROWSER,
  HARNESS_LABELS,
  HARNESS_SIGN_IN_COMMANDS,
  readinessTone,
  type AgentReadiness,
  type AgentStatusTone,
} from "@/lib/agent/client/readiness";
import { safeExternalUrl } from "@/lib/agent/client/request";
import type { AgentHarnessId } from "@/lib/agent/types";
import { CommandLine, CopyButton, InlineSpinner, MonoWell, StatusDot } from "./AgentChrome";
import { AgentAlert, AgentTextButton } from "./AgentNotice";

export type AgentBlockedReadiness = Exclude<AgentReadiness, { kind: "ready" }>;

export interface AgentSignInCardProps {
  harness: AgentHarnessId;
  readiness: AgentBlockedReadiness;
  /** The sign-in request is in flight. */
  startingSignIn?: boolean;
  /** A "Check again" is in flight. */
  checking?: boolean;
  onSignIn: () => void;
  onCheckAgain: () => void;
  /** "full" fills the empty window; "inline" sits under an existing conversation. */
  variant?: "full" | "inline";
}

/**
 * The button launches the vendor tool's own sign-in, so it names that tool:
 * Node Banana doesn't offer a Claude login of its own (Anthropic's terms
 * forbid third-party apps offering Claude.ai login). "Sign in with ChatGPT"
 * is the Codex CLI's own name for its login.
 */
const SIGN_IN_BUTTON_LABELS: Record<AgentHarnessId, string> = {
  claude: "Open Claude Code sign-in",
  codex: "Sign in with ChatGPT",
};

/**
 * Everything between opening the panel and being able to chat: checking the
 * CLI, signing in through the vendor's own flow, and refusing logins that
 * would bill an API account.
 */
export function AgentSignInCard({
  harness,
  readiness,
  startingSignIn = false,
  checking = false,
  onSignIn,
  onCheckAgain,
  variant = "full",
}: AgentSignInCardProps) {
  const label = HARNESS_LABELS[harness];
  const { plan, runsOn, signInNote } = HARNESS_BILLING_COPY[harness];
  const cliOpensBrowser = HARNESS_CLI_OPENS_BROWSER[harness];
  const status = "status" in readiness ? readiness.status : undefined;
  const command = status?.signInCommand || HARNESS_SIGN_IN_COMMANDS[harness];

  const full = variant === "full";

  if (readiness.kind === "loading") {
    return (
      <div
        role="status"
        className={cn("flex items-center gap-2 text-[13px] text-ink-3", full ? "m-auto p-6" : "px-4 py-3")}
      >
        <InlineSpinner />
        Checking {label}…
      </div>
    );
  }

  // The primary path: the vendor's own sign-in, as the dialogs' ink button.
  const signInButton = (text = SIGN_IN_BUTTON_LABELS[harness]) => (
    <div className="flex flex-col items-start gap-2">
      <DialogButton
        variant="primary"
        size="md"
        data-agent-primary
        onClick={onSignIn}
        disabled={startingSignIn}
        // The billing card's label is longer than the column: wrap it rather than overflow.
        className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-center leading-[18px]"
      >
        {startingSignIn && <InlineSpinner />}
        {startingSignIn ? "Starting sign-in…" : text}
      </DialogButton>
      <p className="text-[11px] leading-4 text-ink-3">{signInNote}</p>
    </div>
  );
  const checkAgain = (
    <AgentTextButton onClick={onCheckAgain} disabled={checking} className="-ml-1.5 self-start">
      {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} />}
      {checking ? "Checking…" : "Check again"}
    </AgentTextButton>
  );
  // The fallback, ruled off from the primary path.
  const terminalFallback = (lead: string) => (
    <div className={cn("space-y-2 border-t fade-rule", full ? "pt-4" : "pt-3.5")}>
      <p className="text-xs leading-4 text-ink-3">{lead}</p>
      <CommandLine command={command} />
    </div>
  );
  const heading = (title: string, lead: ReactNode) => (
    <CardHeading harness={label} tone={readinessTone(readiness)} pulse={readiness.kind === "signing_in"} title={title} size={variant}>
      {lead}
    </CardHeading>
  );

  let content: ReactNode;
  switch (readiness.kind) {
    case "unavailable":
      content = (
        <>
          {heading("Couldn't check the agent", readiness.message)}
          <DialogButton variant="outline" onClick={onCheckAgain} disabled={checking} className="self-start">
            {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />}
            Try again
          </DialogButton>
        </>
      );
      break;

    case "not_installed":
      content = (
        <>
          {heading(
            `${label} isn't available`,
            readiness.status.problem || `Node Banana couldn't find or start the ${label} command-line tool.`,
          )}
          <p className="text-xs leading-5 text-ink-3">
            The agent runs through {label} on this computer. Once it is installed and signed in, check again.
          </p>
          {checkAgain}
        </>
      );
      break;

    case "signed_out":
      content = (
        <>
          {heading(`Sign in to ${label}`, runsOn)}
          {readiness.status.problem && <StatusLine tone="attention">{readiness.status.problem}</StatusLine>}
          {signInButton()}
          {terminalFallback("Or sign in from a terminal:")}
          {checkAgain}
        </>
      );
      break;

    case "signing_in": {
      // Claude Code's printed URL is its manual flow (a code pasted back into
      // the CLI), which this window can't finish: its fallback is the terminal.
      const url = cliOpensBrowser ? null : safeExternalUrl(readiness.url);
      content = (
        <>
          {heading(
            "Finish signing in",
            <>
              {cliOpensBrowser
                ? `${label} opened its sign-in page in your browser.`
                : `Sign in with your ${plan} account in your browser.`}{" "}
              This window updates on its own when you&apos;re done.
            </>,
          )}
          {/* Replacing a login that can't run: keep saying why. */}
          {readiness.status.signedIn && readiness.status.problem && (
            <StatusLine tone="blocked">{readiness.status.problem}</StatusLine>
          )}
          {readiness.userCode && (
            <div className="space-y-2">
              <p className="text-xs leading-4 text-ink-3">Enter this code on the sign-in page:</p>
              <MonoWell className="min-h-12 pl-4">
                <code className="min-w-0 flex-1 select-all font-mono text-xl font-medium leading-7 tracking-[0.2em] text-neutral-100">
                  {readiness.userCode}
                </code>
                <CopyButton value={readiness.userCode} label="Copy code" />
              </MonoWell>
            </div>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 self-start rounded font-display text-[13px] font-medium text-neutral-200 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <ExternalLinkIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
              Open the sign-in page
            </a>
          )}
          <p role="status" className="flex items-center gap-2 text-xs leading-4 text-ink-3">
            <StatusDot tone="attention" pulse />
            Waiting for {label}…
          </p>
          {terminalFallback(
            cliOpensBrowser
              ? "No browser tab opened? Sign in from a terminal instead:"
              : "Having trouble? Sign in from a terminal instead:",
          )}
          {checkAgain}
        </>
      );
      break;
    }

    case "sign_in_failed":
      content = (
        <>
          {heading("Sign-in didn't finish", readiness.message)}
          {signInButton("Try again")}
          {terminalFallback("Or sign in from a terminal:")}
          {checkAgain}
        </>
      );
      break;

    case "wrong_billing":
    case "unconfirmed_billing": {
      const api = readiness.kind === "wrong_billing";
      content = (
        <>
          {heading(
            api ? "This login would use API credits" : `No ${plan} plan found on this login`,
            <>
              Node Banana only runs the agent on your {plan} subscription, so it won&apos;t use the current {label}{" "}
              login.
            </>,
          )}
          {readiness.status.problem && <StatusLine tone="blocked">{readiness.status.problem}</StatusLine>}
          {readiness.signInError && (
            <StatusLine tone="blocked">Sign-in didn&apos;t finish: {readiness.signInError}</StatusLine>
          )}
          {signInButton(`Switch ${label} to your ${plan} account`)}
          {terminalFallback("Or switch from a terminal:")}
          {checkAgain}
        </>
      );
      break;
    }
  }

  return (
    <div
      data-readiness={readiness.kind}
      className={cn(
        "flex w-full flex-col",
        full
          ? "gap-5 px-4 pb-6 pt-5"
          : // Under a conversation: capped and scrolling on its own, so the transcript keeps some room.
            "max-h-[65%] shrink-0 gap-3.5 overflow-y-auto border-t fade-rule p-4",
      )}
    >
      {content}
    </div>
  );
}

/**
 * Shown when "Sign in" was answered `already_signed_in`: the CLI's own status
 * reads fine, so nothing was started. If turns still fail, the vendor's
 * terminal command is the way to sign in again.
 */
export function AgentAlreadySignedInHint({
  harness,
  message,
  command,
  onDismiss,
}: {
  harness: AgentHarnessId;
  /** The server's answer, e.g. "Claude Code is already signed in with your Claude plan." */
  message?: string;
  command?: string;
  onDismiss: () => void;
}) {
  const label = HARNESS_LABELS[harness];
  return (
    <AgentAlert
      tone="info"
      actions={
        <AgentTextButton onClick={onDismiss}>Dismiss</AgentTextButton>
      }
    >
      <div className="space-y-2" data-testid="agent-already-signed-in">
        <p>
          {message || `${label} is already signed in.`} Nothing was started; if turns still fail, sign in again from a
          terminal:
        </p>
        <CommandLine command={command || HARNESS_SIGN_IN_COMMANDS[harness]} />
      </div>
    </AgentAlert>
  );
}

/** A status line inside a card: a dot for the tone, plain text. */
function StatusLine({ tone, children }: { tone: AgentStatusTone; children: ReactNode }) {
  return (
    <p className="flex gap-2 text-xs leading-5 text-neutral-300">
      <StatusDot tone={tone} className="mt-[7px]" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** A split-dialog page head: the harness as a mono eyebrow with its status dot, a display heading, a lead. */
function CardHeading({
  harness,
  tone,
  pulse,
  title,
  size,
  children,
}: {
  harness: string;
  tone: AgentStatusTone;
  pulse: boolean;
  title: string;
  size: "full" | "inline";
  children: ReactNode;
}) {
  return (
    <div>
      <p
        data-agent-eyebrow
        className="mb-2.5 flex items-center gap-1.5 font-mono text-[11px] uppercase leading-4 tracking-eyebrow text-ink-3"
      >
        <StatusDot tone={tone} pulse={pulse} />
        {harness}
      </p>
      <h3
        className={cn(
          "font-display font-bold tracking-display text-neutral-100",
          size === "full" ? "text-xl leading-6" : "text-base leading-5",
        )}
      >
        {title}
      </h3>
      <p
        className={cn(
          "mt-1.5 font-display font-medium text-neutral-400",
          size === "full" ? "text-[13px] leading-5" : "text-xs leading-[18px]",
        )}
      >
        {children}
      </p>
    </div>
  );
}
