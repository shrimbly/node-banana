"use client";

import type { ReactNode } from "react";
import {
  CircleAlertIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  LogInIcon,
  PlugIcon,
  RefreshCwIcon,
  WifiOffIcon,
} from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Button } from "@/components/agent/ui/button";
import {
  HARNESS_BILLING_COPY,
  HARNESS_CLI_OPENS_BROWSER,
  HARNESS_LABELS,
  HARNESS_SIGN_IN_COMMANDS,
  type AgentReadiness,
} from "@/lib/agent/client/readiness";
import { safeExternalUrl } from "@/lib/agent/client/request";
import type { AgentHarnessId } from "@/lib/agent/types";
import { CommandLine, CopyButton, InlineSpinner } from "./AgentChrome";
import { AgentAlert } from "./AgentNotice";

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

  if (readiness.kind === "loading") {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 text-[13px] text-neutral-400",
          variant === "full" ? "m-auto p-6" : "px-4 py-3",
        )}
      >
        <InlineSpinner />
        Checking {label}…
      </div>
    );
  }

  const signInButton = (text = SIGN_IN_BUTTON_LABELS[harness]) => (
    <div className="space-y-1.5">
      <Button onClick={onSignIn} disabled={startingSignIn} className="w-full">
        {startingSignIn ? <InlineSpinner /> : <LogInIcon />}
        {startingSignIn ? "Starting sign-in…" : text}
      </Button>
      <p className="text-center text-[11px] leading-4 text-neutral-500">{signInNote}</p>
    </div>
  );
  const checkAgain = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onCheckAgain}
      disabled={checking}
      className="self-start text-neutral-400"
    >
      {checking ? <InlineSpinner /> : <RefreshCwIcon />}
      {checking ? "Checking…" : "Check again"}
    </Button>
  );
  const terminalFallback = (lead: string) => (
    <div className="space-y-1.5">
      <p className="text-xs text-neutral-500">{lead}</p>
      <CommandLine command={command} />
    </div>
  );

  let content: ReactNode;
  switch (readiness.kind) {
    case "unavailable":
      content = (
        <>
          <CardHeading icon={<WifiOffIcon />} tone="danger" title="Couldn't check the agent">
            {readiness.message}
          </CardHeading>
          <Button variant="outline" size="sm" onClick={onCheckAgain} disabled={checking} className="self-start">
            {checking ? <InlineSpinner /> : <RefreshCwIcon />}
            Try again
          </Button>
        </>
      );
      break;

    case "not_installed":
      content = (
        <>
          <CardHeading icon={<PlugIcon />} tone="danger" title={`${label} isn't available`}>
            {readiness.status.problem || `Node Banana couldn't find or start the ${label} command-line tool.`}
          </CardHeading>
          <p className="text-xs leading-5 text-neutral-400">
            The agent runs through {label} on this computer. Once it is installed and signed in, check again.
          </p>
          {checkAgain}
        </>
      );
      break;

    case "signed_out":
      content = (
        <>
          <CardHeading icon={<LogInIcon />} title={`Sign in to ${label}`}>
            {runsOn}
          </CardHeading>
          {readiness.status.problem && <p className="text-xs leading-5 text-neutral-500">{readiness.status.problem}</p>}
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
          <CardHeading icon={<InlineSpinner className="size-4" />} title="Finish signing in">
            {cliOpensBrowser
              ? `${label} opened its sign-in page in your browser.`
              : `Sign in with your ${plan} account in your browser.`}{" "}
            This window updates on its own when you&apos;re done.
          </CardHeading>
          {/* Replacing a login that can't run: keep saying why. */}
          {readiness.status.signedIn && readiness.status.problem && (
            <p className="text-xs leading-5 text-neutral-500">{readiness.status.problem}</p>
          )}
          {readiness.userCode && (
            <div className="space-y-1.5">
              <p className="text-xs text-neutral-400">Enter this code on the sign-in page:</p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 py-1 pl-3 pr-1">
                <code className="select-all font-mono text-base font-semibold tracking-[0.2em] text-blue-100">
                  {readiness.userCode}
                </code>
                <CopyButton value={readiness.userCode} label="Copy code" />
              </div>
            </div>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 self-start text-[13px] text-blue-400 underline-offset-4 hover:text-blue-300 hover:underline"
            >
              <ExternalLinkIcon className="size-3.5" />
              Open the sign-in page
            </a>
          )}
          <p role="status" className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400/60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-amber-400" />
            </span>
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
          <CardHeading icon={<CircleAlertIcon />} tone="danger" title="Sign-in didn't finish">
            {readiness.message}
          </CardHeading>
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
          <CardHeading
            icon={api ? <CreditCardIcon /> : <CircleAlertIcon />}
            tone="warning"
            title={api ? "This login would use API credits" : `No ${plan} plan found on this login`}
          >
            Node Banana only runs the agent on your {plan} subscription, so it won&apos;t use the current {label}{" "}
            login.
          </CardHeading>
          {readiness.status.problem && (
            <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
              {readiness.status.problem}
            </p>
          )}
          {readiness.signInError && (
            <p className="text-xs leading-5 text-red-300">Sign-in didn&apos;t finish: {readiness.signInError}</p>
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
        variant === "full" ? "my-auto gap-4 px-5 py-6" : "gap-3 border-t border-neutral-700 bg-neutral-800 p-4",
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
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
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

const HEADING_TONES = {
  neutral: "border-neutral-700 bg-neutral-900 text-neutral-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-300",
} as const;

function CardHeading({
  icon,
  title,
  tone = "neutral",
  children,
}: {
  icon: ReactNode;
  title: string;
  tone?: keyof typeof HEADING_TONES;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-4",
          HEADING_TONES[tone],
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium text-neutral-100">{title}</h3>
        <p className="text-[13px] leading-5 text-neutral-400">{children}</p>
      </div>
    </div>
  );
}
