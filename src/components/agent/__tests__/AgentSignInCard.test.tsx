import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentSignInCard, type AgentBlockedReadiness } from "@/components/agent/AgentSignInCard";
import { HARNESS_BILLING_COPY } from "@/lib/agent/client/readiness";
import type { AgentHarnessStatus } from "@/lib/agent/types";

/** What `claude auth login` prints for "If the browser didn't open": its manual flow, finished by pasting a code. */
const CLAUDE_MANUAL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=s";

function status(overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id: "claude",
    label: "Claude Code",
    installed: true,
    signedIn: false,
    billing: "none",
    models: [],
    signIn: { state: "idle" },
    signInCommand: "claude auth login",
    ...overrides,
  };
}

function renderCard(readiness: AgentBlockedReadiness, extra: Partial<Parameters<typeof AgentSignInCard>[0]> = {}) {
  const onSignIn = vi.fn();
  const onCheckAgain = vi.fn();
  const utils = render(
    <AgentSignInCard harness="claude" readiness={readiness} onSignIn={onSignIn} onCheckAgain={onCheckAgain} {...extra} />,
  );
  return { ...utils, onSignIn, onCheckAgain };
}

describe("AgentSignInCard", () => {
  it("shows a check in progress", () => {
    renderCard({ kind: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Checking Claude Code…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a retry when the status route failed", () => {
    const { onCheckAgain } = renderCard({ kind: "unavailable", message: "Couldn't check the agent status: 500" });
    expect(screen.getByText("Couldn't check the agent status: 500")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it("explains a missing CLI without offering sign-in", () => {
    renderCard({ kind: "not_installed", status: status({ installed: false, problem: "Claude Code wasn't found." }) });
    expect(screen.getByText("Claude Code isn't available")).toBeInTheDocument();
    expect(screen.getByText("Claude Code wasn't found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
  });

  it("signs out: says what it runs on, offers the vendor sign-in and the terminal command", () => {
    const { onSignIn, onCheckAgain } = renderCard({ kind: "signed_out", status: status() });

    expect(screen.getByRole("heading", { name: "Sign in to Claude Code" })).toBeInTheDocument();
    expect(screen.getByText(HARNESS_BILLING_COPY.claude.runsOn)).toBeInTheDocument();
    expect(screen.getByText(/Runs on your Claude subscription through Claude Code — never an API key/)).toBeInTheDocument();
    expect(screen.getByText(/Opens Claude Code's own sign-in in your browser/)).toBeInTheDocument();
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Claude Code sign-in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it("uses Codex wording and its own command", () => {
    render(
      <AgentSignInCard
        harness="codex"
        readiness={{ kind: "signed_out", status: status({ id: "codex", signInCommand: "codex login" }) }}
        onSignIn={vi.fn()}
        onCheckAgain={vi.fn()}
      />,
    );
    expect(screen.getByText(HARNESS_BILLING_COPY.codex.runsOn)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    expect(screen.getByText("codex login")).toBeInTheDocument();
  });

  it("disables sign-in while the request is starting", () => {
    renderCard({ kind: "signed_out", status: status() }, { startingSignIn: true });
    expect(screen.getByRole("button", { name: /starting sign-in/i })).toBeDisabled();
  });

  it("shows a pending Codex sign-in with the page link and device code", () => {
    renderCard(
      {
        kind: "signing_in",
        status: status({ id: "codex", signInCommand: "codex login" }),
        url: "https://auth.openai.com/codex/device",
        userCode: "WXYZ-1234",
      },
      { harness: "codex" },
    );

    expect(screen.getByText("Finish signing in")).toBeInTheDocument();
    expect(screen.getByText("WXYZ-1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open the sign-in page/i });
    expect(link).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Waiting for Codex…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in with/i })).not.toBeInTheDocument();
  });

  // The URL Claude Code prints is its manual flow: it ends on a page showing a code
  // to paste into the CLI, which this window can't (and mustn't) relay.
  it("never links Claude Code's manual sign-in URL; points to the terminal instead", () => {
    renderCard({ kind: "signing_in", status: status(), url: CLAUDE_MANUAL_URL });
    expect(screen.queryByRole("link", { name: /open the sign-in page/i })).not.toBeInTheDocument();
    expect(screen.getByText("Claude Code opened its sign-in page in your browser.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("No browser tab opened? Sign in from a terminal instead:")).toBeInTheDocument();
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Claude Code…")).toBeInTheDocument();
  });

  it("never renders a non-http sign-in link", () => {
    renderCard(
      { kind: "signing_in", status: status({ id: "codex" }), url: "javascript:alert(1)" },
      { harness: "codex" },
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps saying why while a sign-in replaces a login that can't run", () => {
    renderCard({
      kind: "signing_in",
      status: status({ signedIn: true, billing: "api", problem: "Claude Code is signed in with a Console API key." }),
    });
    expect(screen.getByText("Claude Code is signed in with a Console API key.")).toBeInTheDocument();
  });

  it("shows a failed sign-in with a retry", () => {
    const { onSignIn } = renderCard({ kind: "sign_in_failed", status: status(), message: "Login timed out" });
    expect(screen.getByText("Sign-in didn't finish")).toBeInTheDocument();
    expect(screen.getByText("Login timed out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("refuses an API-billed login and explains the fix", () => {
    renderCard({
      kind: "wrong_billing",
      status: status({
        signedIn: true,
        billing: "api",
        problem: "Claude Code is signed in with a Console account, which bills API credits.",
      }),
    });

    expect(screen.getByRole("heading", { name: "This login would use API credits" })).toBeInTheDocument();
    expect(
      screen.getByText("Claude Code is signed in with a Console account, which bills API credits."),
    ).toBeInTheDocument();
    expect(screen.getByText(/only runs the agent on your Claude Pro or Max subscription/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch Claude Code to your Claude Pro or Max account" }),
    ).toBeInTheDocument();
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
  });

  // A claude.ai login with no readable plan doesn't bill API credits: don't say it does.
  it("describes an unconfirmed subscription without API-credit wording", () => {
    const problem =
      "Claude Code is signed in, but no Claude Pro or Max plan was found on the account. Sign in with a Pro or Max account.";
    renderCard({ kind: "unconfirmed_billing", status: status({ signedIn: true, billing: "unknown", problem }) });

    expect(screen.getByRole("heading", { name: "No Claude Pro or Max plan found on this login" })).toBeInTheDocument();
    expect(screen.queryByText(/API credits/)).not.toBeInTheDocument();
    expect(screen.getByText(problem)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch Claude Code to your Claude Pro or Max account" }),
    ).toBeInTheDocument();
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
  });

  it("shows why a replacement sign-in didn't finish on the billing card", () => {
    renderCard({
      kind: "wrong_billing",
      status: status({ signedIn: true, billing: "api" }),
      signInError: "Sign-in wasn't completed within 10 minutes",
    });
    expect(screen.getByText("Sign-in didn't finish: Sign-in wasn't completed within 10 minutes")).toBeInTheDocument();
  });

  // Anthropic's terms forbid third-party apps offering Claude.ai login; the button
  // launches Claude Code's own sign-in and must say so, in every state.
  it("never labels a button as a Claude login offered by the app", () => {
    const blocked: AgentBlockedReadiness[] = [
      { kind: "signed_out", status: status() },
      { kind: "sign_in_failed", status: status(), message: "Login timed out" },
      { kind: "wrong_billing", status: status({ signedIn: true, billing: "api" }) },
      { kind: "unconfirmed_billing", status: status({ signedIn: true, billing: "unknown" }) },
      { kind: "signing_in", status: status(), url: CLAUDE_MANUAL_URL },
      { kind: "not_installed", status: status({ installed: false }) },
    ];
    for (const readiness of blocked) {
      const { unmount } = renderCard(readiness);
      for (const button of screen.queryAllByRole("button")) {
        expect(button, readiness.kind).not.toHaveAccessibleName(/sign in with claude/i);
      }
      unmount();
    }
    renderCard({ kind: "signed_out", status: status() });
    expect(screen.getByRole("button", { name: /Claude Code/ })).toHaveAccessibleName("Open Claude Code sign-in");
  });

  it("shows progress on Check again", () => {
    renderCard({ kind: "signed_out", status: status() }, { checking: true });
    expect(screen.getByRole("button", { name: /checking/i })).toBeDisabled();
  });

  it("falls back to the default command before the status has one", () => {
    renderCard({ kind: "signed_out", status: status({ signInCommand: "" }) });
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
  });
});
