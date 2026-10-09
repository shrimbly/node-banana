"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon, TerminalIcon, XIcon } from "lucide-react";
import { DialogButton } from "@/components/ui/Dialog";
import { cn } from "@/components/agent/lib/utils";
import {
  AGENT_SIGN_IN_TIMEOUT_MS,
  HARNESS_BILLING_COPY,
  HARNESS_CLI_OPENS_BROWSER,
  HARNESS_INSTALL,
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
  /** When the running sign-in started (ms epoch), for the elapsed and give-up times. */
  signInStartedAt?: number;
  onSignIn: () => void;
  onCheckAgain: () => void;
  /** Stop the running sign-in. Absent: no Cancel. */
  onCancelSignIn?: () => void;
  /** "full" fills the empty window; "inline" sits under an existing conversation. */
  variant?: "full" | "inline";
  /** The checking card's eyebrow when no harness is chosen yet ("Agent"). */
  eyebrow?: string;
  /** Classes after the variant's own: a host that caps the card itself lifts the inline cap. */
  className?: string;
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

/** After this long without the status flipping, the card offers the ways out of a tab that never opened. */
const NO_TAB_HINT_MS = 60_000;
/** The checking card says so after this long, so a slow CLI is not mistaken for a hang. */
const STILL_CHECKING_MS = 3_000;

/**
 * Everything between opening the panel and being able to chat: checking the
 * CLI, installing it, signing in through the vendor's own flow, and refusing
 * logins that would bill an API account. One primary action per state;
 * everything else folds under a disclosure or a text button.
 */
export function AgentSignInCard({
  harness,
  readiness,
  startingSignIn = false,
  checking = false,
  signInStartedAt,
  onSignIn,
  onCheckAgain,
  onCancelSignIn,
  variant = "full",
  eyebrow,
  className,
}: AgentSignInCardProps) {
  const label = HARNESS_LABELS[harness];
  const { plan, account, runsOn, signInNote } = HARNESS_BILLING_COPY[harness];
  const cliOpensBrowser = HARNESS_CLI_OPENS_BROWSER[harness];
  const status = "status" in readiness ? readiness.status : undefined;
  const command = status?.signInCommand || HARNESS_SIGN_IN_COMMANDS[harness];
  const full = variant === "full";

  if (readiness.kind === "loading") return <CheckingCard label={eyebrow ?? label} full={full} />;

  const signInButton = (text = SIGN_IN_BUTTON_LABELS[harness]) => (
    <div className="flex flex-col items-start gap-2">
      <DialogButton
        variant="primary"
        size="md"
        data-agent-primary
        onClick={onSignIn}
        disabled={startingSignIn}
        className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-center leading-[18px]"
      >
        {startingSignIn && <InlineSpinner />}
        {startingSignIn ? "Starting sign-in…" : text}
      </DialogButton>
      <p className="text-[11px] leading-4 text-ink-3">{signInNote}</p>
    </div>
  );
  const checkAgainButton = (text = "Check again", className = "-ml-1.5 self-start") => (
    <AgentTextButton onClick={onCheckAgain} disabled={checking} className={className}>
      {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} />}
      {checking ? "Checking…" : text}
    </AgentTextButton>
  );
  const terminal = (lead: string) => (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-4 text-ink-3">{lead}</p>
      <CommandLine command={command} />
    </div>
  );
  const heading = (title: string, lead: ReactNode) => (
    <CardHeading harness={label} tone={readinessTone(readiness)} pulse={readiness.kind === "signing_in"} title={title} size={variant}>
      {lead}
    </CardHeading>
  );
  const footer = (children: ReactNode) => <p className="mt-auto text-[11px] leading-4 text-ink-3">{children}</p>;

  let content: ReactNode;
  switch (readiness.kind) {
    case "unavailable":
      content = (
        <>
          {heading(
            `Couldn't reach ${label}`,
            `Node Banana's own server failed while asking ${label} for its status. The agent isn't affected; this window is.`,
          )}
          <div className="flex flex-col gap-2.5">
            <DialogButton variant="primary" size="md" data-agent-primary onClick={onCheckAgain} disabled={checking} className="self-start">
              {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />}
              Try again
            </DialogButton>
            <Disclosure label="Details" defaultOpen>
              <MonoWell className="min-h-0 py-2 pr-3">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] leading-4 text-neutral-400">
                  {readiness.message}
                </code>
              </MonoWell>
            </Disclosure>
          </div>
          {footer("If this keeps happening, restart Node Banana.")}
        </>
      );
      break;

    case "not_installed": {
      const install = HARNESS_INSTALL[harness];
      content = (
        <>
          {heading(
            `Install ${label} to use the agent`,
            `The agent runs through ${label} on this computer. It isn't installed yet, or it's not on your PATH.`,
          )}
          <div className="flex flex-col gap-2.5">
            <CommandLine command={install.command} />
            <a
              href={install.guideUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 self-start rounded text-xs text-neutral-400 transition-colors hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <ExternalLinkIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
              Installation guide
            </a>
          </div>
          <div className="flex flex-col items-start gap-2">
            <DialogButton variant="primary" size="md" data-agent-primary onClick={onCheckAgain} disabled={checking}>
              {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />}
              {checking ? "Checking…" : "Check again"}
            </DialogButton>
            <p className="text-[11px] leading-4 text-ink-3">
              Already installed somewhere else? Node Banana looks on your PATH and in the usual npm and Homebrew locations.
            </p>
          </div>
          {footer(`Runs on your ${plan} through ${label}.`)}
        </>
      );
      break;
    }

    case "signed_out":
      content = (
        <>
          {heading(`Sign in to ${label}`, runsOn)}
          {readiness.status.problem && <StatusLine tone="attention">{readiness.status.problem}</StatusLine>}
          {signInButton()}
          <Disclosure label="Other ways to sign in">{terminal("Sign in from a terminal, then check again here:")}</Disclosure>
          {footer(
            <>
              Already signed in from a terminal?{" "}
              <button type="button" onClick={onCheckAgain} disabled={checking} className="underline decoration-white/30 underline-offset-2 hover:text-neutral-200">
                {checking ? "Checking…" : "Check again"}
              </button>
            </>,
          )}
        </>
      );
      break;

    case "signing_in": {
      // Claude Code's printed URL is its manual flow (a code pasted back into
      // the CLI), which this window can't finish: its fallback is the terminal.
      const url = cliOpensBrowser ? null : safeExternalUrl(readiness.url);
      const steps = cliOpensBrowser
        ? ["Sign-in page opened", `Approve ${label} in the browser`, "Come back here"]
        : ["Open the sign-in page", readiness.userCode ? "Enter the code and approve" : "Approve in the browser", "Come back here"];
      content = (
        <>
          {heading(
            "Finish in your browser",
            cliOpensBrowser
              ? `${label} opened its sign-in page. This window updates on its own.`
              : `Sign in with your ${account} account on the page that opens.`,
          )}
          {/* Replacing a login that can't run: keep saying why. */}
          {readiness.status.signedIn && readiness.status.problem && (
            <StatusLine tone="blocked">{readiness.status.problem}</StatusLine>
          )}
          {readiness.userCode && (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-4 text-ink-3">Enter this code when the page asks:</p>
              <MonoWell className="min-h-12 pl-4">
                <code className="min-w-0 flex-1 select-all font-mono text-xl font-medium leading-7 tracking-[0.2em] text-neutral-100">
                  {readiness.userCode}
                </code>
                <CopyButton value={readiness.userCode} label="Copy code" />
              </MonoWell>
            </div>
          )}
          <Steps steps={steps} current={cliOpensBrowser ? 1 : 0} />
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              data-agent-primary
              className="inline-flex h-9 items-center gap-2 self-start rounded-lg bg-neutral-200 px-3.5 font-display text-[13px] font-semibold text-neutral-900 transition-colors hover:bg-[#ededed] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
            >
              <ExternalLinkIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
              Open the sign-in page
            </a>
          )}
          <WaitRow label={label} startedAt={signInStartedAt} />
          <div className="flex flex-col gap-2">
            <NoTabHint
              label={label}
              startedAt={signInStartedAt}
              cliOpensBrowser={cliOpensBrowser}
              onOpenAgain={onSignIn}
              starting={startingSignIn}
              terminal={terminal(
                cliOpensBrowser ? "Run this in a terminal, finish in the browser, then come back:" : "Or sign in from a terminal:",
              )}
            />
            <div className="-ml-1.5 flex flex-wrap items-center gap-1">
              {checkAgainButton("Check now", "")}
              {onCancelSignIn && (
                <AgentTextButton onClick={onCancelSignIn}>
                  <XIcon aria-hidden="true" strokeWidth={1.75} />
                  Cancel sign-in
                </AgentTextButton>
              )}
            </div>
          </div>
        </>
      );
      break;
    }

    case "sign_in_failed":
      content = (
        <>
          {heading("Sign-in didn't finish", `${label} stopped before it got a login.`)}
          <StatusLine tone="attention">{readiness.message}</StatusLine>
          <div className="flex flex-col items-start gap-2">
            <DialogButton variant="primary" size="md" data-agent-primary onClick={onSignIn} disabled={startingSignIn}>
              {startingSignIn && <InlineSpinner />}
              {startingSignIn ? "Starting sign-in…" : "Try again"}
            </DialogButton>
            <p className="text-[11px] leading-4 text-ink-3">Starts {label}&apos;s sign-in again in your browser.</p>
          </div>
          <Disclosure label="Sign in from a terminal instead" defaultOpen>
            {terminal("Run this, finish in the browser, then come back and check again.")}
          </Disclosure>
          {checkAgainButton()}
        </>
      );
      break;

    case "wrong_billing":
    case "unconfirmed_billing": {
      const api = readiness.kind === "wrong_billing";
      content = (
        <>
          {heading(
            api ? "This login would bill API credits" : `No ${plan} on this login`,
            `Node Banana only runs the agent on a ${plan}, so it won't use this login.`,
          )}
          <div className="flex gap-2.5 rounded-lg bg-well px-3 py-2.5 shadow-well">
            <StatusDot tone="blocked" className="mt-[7px]" />
            <div className="min-w-0 flex-1 text-xs leading-4">
              <p className="text-neutral-200">{api ? "Bills API credits" : `No ${plan} found`}</p>
              {readiness.status.problem && <p className="mt-0.5 text-neutral-500">{readiness.status.problem}</p>}
            </div>
          </div>
          {readiness.signInError && (
            <StatusLine tone="blocked">Sign-in didn&apos;t finish: {readiness.signInError}</StatusLine>
          )}
          <div className="flex flex-col items-start gap-2">
            <DialogButton variant="primary" size="md" data-agent-primary onClick={onSignIn} disabled={startingSignIn}>
              {startingSignIn && <InlineSpinner />}
              {startingSignIn ? "Starting sign-in…" : `Switch to your ${account} account`}
            </DialogButton>
            <p className="text-[11px] leading-4 text-ink-3">
              Opens {label}&apos;s sign-in for your {plan}. The current login stays in {label} until you switch.
            </p>
          </div>
          <Disclosure label="Other ways to switch">{terminal("Switch from a terminal, then check again here:")}</Disclosure>
          {checkAgainButton()}
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
          ? "min-h-0 flex-1 gap-5 px-4 pb-6 pt-5"
          : // Under a conversation: capped and scrolling on its own, so the transcript keeps some room.
            "max-h-[65%] shrink-0 gap-3.5 overflow-y-auto border-t fade-rule p-4",
        className,
      )}
    >
      {content}
    </div>
  );
}

/** The first check: a skeleton in the card's shape, and a word after a few seconds so a slow CLI doesn't read as a hang. */
function CheckingCard({ label, full }: { label: string; full: boolean }) {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStill(true), STILL_CHECKING_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" aria-label={`Checking ${label}`} data-readiness="loading" className={cn("flex w-full flex-col gap-3", full ? "px-4 pb-6 pt-5" : "px-4 py-3")}>
      <p className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase leading-4 tracking-eyebrow text-ink-3">
        <StatusDot tone="unknown" />
        {label}
      </p>
      <span className="h-3 w-3/5 rounded-full bg-white/[0.06]" />
      <span className="h-3 w-[88%] rounded-full bg-white/[0.06]" />
      <span className="h-3 w-2/5 rounded-full bg-white/[0.06]" />
      <p className={cn("mt-2 text-xs text-neutral-500 transition-opacity", still ? "opacity-100" : "opacity-0")} aria-hidden={!still}>
        Still checking…
      </p>
    </div>
  );
}

/** Where the flow is: done steps ticked, the current one lit, the rest dim. */
function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className={cn("flex items-start gap-2.5 text-[13px] leading-5", active ? "text-neutral-100" : done ? "text-neutral-400" : "text-neutral-500")}
          >
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]",
                done && "bg-handle-image/15 text-handle-image",
                active && "bg-amber-400/15 text-amber-400 ring-[3px] ring-amber-400/15",
                !done && !active && "bg-white/[0.06] text-neutral-500",
              )}
            >
              {done ? "✓" : index + 1}
            </span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A pulsing dot, the elapsed time, and when the server will give up on the flow. */
function WaitRow({ label, startedAt }: { label: string; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = startedAt ? now - startedAt : null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs leading-4 text-neutral-400">
      <StatusDot tone="attention" pulse />
      <span>
        Waiting for {label}
        {elapsed !== null && (
          <>
            {" · "}
            <span className="font-mono text-neutral-300">{formatClock(elapsed)}</span>
          </>
        )}
      </span>
      {elapsed !== null && (
        <span className="ml-auto font-mono text-[11px] text-neutral-500">gives up in {formatClock(AGENT_SIGN_IN_TIMEOUT_MS - elapsed)}</span>
      )}
    </p>
  );
}

/**
 * The ways out when the vendor's page never appeared: closed until a minute
 * has passed (Claude Code) or always open (Codex, whose link the card shows
 * itself), holding "Open again" and the terminal command.
 */
function NoTabHint({
  label,
  startedAt,
  cliOpensBrowser,
  onOpenAgain,
  starting,
  terminal,
}: {
  label: string;
  startedAt?: number;
  cliOpensBrowser: boolean;
  onOpenAgain: () => void;
  starting: boolean;
  terminal: ReactNode;
}) {
  const [late, setLate] = useState(() => (startedAt ? Date.now() - startedAt >= NO_TAB_HINT_MS : false));
  useEffect(() => {
    if (!startedAt || late) return;
    const timer = setTimeout(() => setLate(true), Math.max(0, NO_TAB_HINT_MS - (Date.now() - startedAt)));
    return () => clearTimeout(timer);
  }, [startedAt, late]);
  const [showTerminal, setShowTerminal] = useState(false);
  return (
    <Disclosure label={cliOpensBrowser ? "No tab opened?" : "Having trouble?"} defaultOpen={late || !cliOpensBrowser} key={String(late)}>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-2">
          {cliOpensBrowser && (
            <DialogButton variant="outline" size="md" onClick={onOpenAgain} disabled={starting}>
              {starting ? <InlineSpinner /> : <ExternalLinkIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />}
              Open again
            </DialogButton>
          )}
          <DialogButton variant="outline" size="md" onClick={() => setShowTerminal((shown) => !shown)} aria-expanded={showTerminal}>
            <TerminalIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            Use the terminal
          </DialogButton>
        </div>
        {showTerminal && terminal}
        <p className="sr-only">{label}</p>
      </div>
    </Disclosure>
  );
}

/** A small chevron toggle for the secondary path, closed by default. */
function Disclosure({ label, defaultOpen = false, children }: { label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 self-start rounded font-display text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
      >
        <ChevronRightIcon aria-hidden="true" strokeWidth={2} className={cn("size-3.5 text-neutral-500 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && children}
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

/** Once, right after a sign-in lands: who is signed in, on what, with what. Dismissable. */
export function AgentSignedInBanner({
  harness,
  email,
  plan,
  model,
  onDismiss,
}: {
  harness: AgentHarnessId;
  email?: string;
  plan?: string;
  model?: string;
  onDismiss: () => void;
}) {
  const label = HARNESS_LABELS[harness];
  const parts = [email && <span key="email" className="text-neutral-100">{email}</span>, plan, model].filter(Boolean);
  return (
    <div
      role="status"
      data-testid="agent-signed-in-banner"
      className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-handle-image/20 bg-handle-image/[0.08] py-2.5 pl-3 pr-2 text-xs leading-[18px] text-neutral-200"
    >
      <StatusDot tone="ready" className="mt-1.5" />
      <span className="min-w-0 flex-1">
        Signed in to {label}
        {parts.length > 0 && " as "}
        {parts.map((part, index) => (
          <span key={index}>
            {index > 0 && " · "}
            {part}
          </span>
        ))}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
      >
        <XIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
      </button>
    </div>
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
export function CardHeading({
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
