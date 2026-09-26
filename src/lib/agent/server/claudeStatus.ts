/**
 * Who would pay for a Claude Code turn. Server-only, pure.
 *
 * Two readings of the same login, both taken with the agent's own
 * environment (see env.ts):
 *
 * - The Agent SDK's `initializationResult().account` — read by the panel's
 *   status from a Claude Code started like a turn but never given a prompt
 *   (no model call), and checked again at the start of every turn, before the
 *   prompt is sent, so a turn can never reach the model on anything but a
 *   subscription login.
 * - `claude --setting-sources= auth status` (JSON) — the status fallback when
 *   that probe fails, reading the same settings a turn does.
 *
 * Only a Claude subscription login may run: a stored claude.ai login with a
 * plan, or a `claude setup-token` token (`CLAUDE_CODE_OAUTH_TOKEN`). Any API
 * key (environment, apiKeyHelper, a Console login's "/login managed key"),
 * bearer token, workload federation, cloud provider or gateway is refused.
 */

import type { AgentModelOption } from "../types";
import type { BillingVerdict } from "./billing";

export type { BillingVerdict } from "./billing";

export interface ClaudeBillingContext {
  /**
   * The agent's environment carries `CLAUDE_CODE_OAUTH_TOKEN` (a subscription
   * token from `claude setup-token`). `auth status` reports that token and an
   * `ANTHROPIC_AUTH_TOKEN` bearer token alike, as authMethod "oauth_token";
   * the agent strips the latter, so this tells the two apart.
   */
  oauthTokenInEnv: boolean;
}

/** Aliases the Claude Code CLI resolves to the newest model of each family. */
export const CLAUDE_MODELS: AgentModelOption[] = [
  { id: "sonnet", label: "Sonnet (latest)", isDefault: true },
  { id: "opus", label: "Opus (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
  { id: "default", label: "Your plan's default" },
];

export const CLAUDE_DEFAULT_MODEL = "sonnet";

/** One row of Claude Code's model list (the Agent SDK's ModelInfo), as far as the picker goes. */
export interface ClaudeModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/** Claude Code's own default effort ("high"), when the model offers it. */
const CLAUDE_DEFAULT_EFFORT = "high";

/**
 * The picker's models from Claude Code's own list (initializationResult().models):
 * real names ("Opus 5.5") and the exact model each alias runs today. Node Banana's
 * default stays Sonnet (fast, and what the evals passed on); the CLI's own
 * "Default (recommended)" row is kept, labelled by the model it resolves to.
 * Falls back to the static aliases when the CLI reports no list.
 */
export function claudeModelOptions(models: readonly ClaudeModelInfo[] | undefined): AgentModelOption[] {
  const rows = (models ?? []).filter((row) => typeof row?.value === "string" && row.value.trim());
  if (rows.length === 0) return CLAUDE_MODELS;
  const options = rows.map((row): AgentModelOption => {
    const summary = row.description?.split("·")[0]?.trim();
    const label =
      row.value === "default"
        ? `Plan default${summary ? ` (${summary})` : ""}`
        : row.displayName?.trim() || row.value;
    return {
      id: row.value,
      label,
      ...(row.description ? { description: row.description } : {}),
      ...(row.resolvedModel ? { resolvedModel: row.resolvedModel } : {}),
      ...effortFields(row),
    };
  });
  const defaultId = options.some((option) => option.id === CLAUDE_DEFAULT_MODEL) ? CLAUDE_DEFAULT_MODEL : options[0].id;
  return options.map((option) => (option.id === defaultId ? { ...option, isDefault: true } : option));
}

function effortFields(row: ClaudeModelInfo): Pick<AgentModelOption, "efforts" | "defaultEffort"> {
  const efforts = (row.supportedEffortLevels ?? []).filter((level) => typeof level === "string" && level);
  if (row.supportsEffort === false || efforts.length === 0) return {};
  return {
    efforts,
    defaultEffort: efforts.includes(CLAUDE_DEFAULT_EFFORT) ? CLAUDE_DEFAULT_EFFORT : efforts[efforts.length - 1],
  };
}

export const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

const SIGNED_OUT_PROBLEM =
  "Claude Code isn't signed in. Sign in with your Claude Pro or Max account to use the agent.";

const NO_PLAN_PROBLEM =
  "Claude Code is signed in, but no Claude Pro or Max plan was found on the account. " +
  "The agent runs only on a Claude subscription.";

const PROVIDER_NAMES: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Claude on AWS",
  anthropicGoogleCloud: "Claude on Google Cloud",
  mantle: "Mantle",
};

function providerProblem(provider: string): string {
  if (provider === "gateway") {
    return (
      "Claude Code is set up to sign in through an enterprise gateway, which isn't a Claude " +
      "Pro or Max subscription. The agent runs only on a Claude subscription."
    );
  }
  const name = PROVIDER_NAMES[provider] ?? provider;
  return (
    `Claude Code is set up to use ${name}, which bills that cloud account rather than a Claude ` +
    "subscription. Turn that off in Claude Code's settings and sign in with your Claude Pro or Max account."
  );
}

function apiKeyProblem(source: string): string {
  switch (source) {
    case "/login managed key":
      return (
        "Claude Code is signed in with an Anthropic Console account, which bills API credits. " +
        "Sign in with your Claude Pro or Max account instead."
      );
    case "ANTHROPIC_API_KEY":
      return (
        "Claude Code would use an Anthropic API key (ANTHROPIC_API_KEY), which bills API credits. " +
        "Remove it and sign in with your Claude Pro or Max account."
      );
    case "apiKeyHelper":
      return (
        "Claude Code is configured to get an API key from an apiKeyHelper, which bills API credits. " +
        "Remove the helper from Claude Code's settings and sign in with your Claude Pro or Max account."
      );
    default:
      return (
        `Claude Code would use an API key (${source}), which bills API credits. ` +
        "Sign in with your Claude Pro or Max account instead."
      );
  }
}

const BEARER_TOKEN_PROBLEM =
  "Claude Code is using a bearer token from its settings (such as ANTHROPIC_AUTH_TOKEN or a " +
  "federation profile), which isn't a Claude Pro or Max login. Remove it and sign in with your Claude account.";

/** "max" → "Max", "Claude Max" → "Max". */
export function formatClaudePlan(subscriptionType: string | null | undefined): string | undefined {
  const plan = subscriptionType?.trim().replace(/^claude\s+/i, "");
  if (!plan) return undefined;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function accountOf(email: unknown, plan: unknown): BillingVerdict["account"] {
  const account = { email: stringField(email), plan: formatClaudePlan(stringField(plan)) };
  return account.email || account.plan ? account : undefined;
}

/**
 * Classify `claude auth status` output (JSON; the command exits 1 when signed
 * out but still prints it).
 */
export function classifyClaudeAuthStatus(raw: unknown, context: ClaudeBillingContext): BillingVerdict {
  if (!raw || typeof raw !== "object") {
    return { signedIn: false, billing: "unknown", problem: "Couldn't read Claude Code's sign-in status." };
  }
  const status = raw as Record<string, unknown>;
  const loggedIn = status.loggedIn === true;
  const authMethod = stringField(status.authMethod) ?? "none";
  const apiProvider = stringField(status.apiProvider) ?? "firstParty";
  const apiKeySource = stringField(status.apiKeySource);
  const account = accountOf(status.email, status.subscriptionType);

  if (apiProvider !== "firstParty") {
    return { signedIn: loggedIn, billing: "api", problem: providerProblem(apiProvider) };
  }
  if (apiKeySource && apiKeySource !== "none") {
    return { signedIn: loggedIn, billing: "api", account, problem: apiKeyProblem(apiKeySource) };
  }
  if (!loggedIn || authMethod === "none") {
    if (status.forcedLoginMethod === "console") {
      return {
        signedIn: false,
        billing: "api",
        problem:
          "Your organization's Claude Code settings only allow Anthropic Console sign-in, which bills " +
          "API credits. The agent runs only on a Claude Pro or Max subscription.",
      };
    }
    return { signedIn: false, billing: "none", problem: SIGNED_OUT_PROBLEM };
  }

  switch (authMethod) {
    case "claude.ai":
      if (stringField(status.subscriptionType)) {
        return { signedIn: true, billing: "subscription", account };
      }
      return { signedIn: true, billing: "unknown", account, problem: NO_PLAN_PROBLEM };
    case "oauth_token":
      if (context.oauthTokenInEnv) {
        return { signedIn: true, billing: "subscription", account };
      }
      return { signedIn: true, billing: "api", problem: BEARER_TOKEN_PROBLEM };
    case "api_key":
      return { signedIn: true, billing: "api", problem: apiKeyProblem("ANTHROPIC_API_KEY") };
    case "api_key_helper":
      return { signedIn: true, billing: "api", problem: apiKeyProblem("apiKeyHelper") };
    case "third_party":
      return { signedIn: true, billing: "api", problem: providerProblem("a third-party provider") };
    default:
      return {
        signedIn: true,
        billing: "unknown",
        problem: `Claude Code reports an unrecognised sign-in method ("${authMethod}"), so the agent won't run on it.`,
      };
  }
}

/** The Agent SDK's AccountInfo (initializationResult().account), as far as billing goes. */
export interface ClaudeAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

/** Token sources that are a Claude subscription login. Absent means the stored /login. */
const SUBSCRIPTION_TOKEN_SOURCES = new Set(["claude.ai", "CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Classify the account a live Claude Code process is about to use. Run at the
 * start of every turn, before the prompt is sent.
 */
export function classifyClaudeAccount(info: ClaudeAccountInfo | null | undefined): BillingVerdict {
  if (!info) {
    return { signedIn: false, billing: "unknown", problem: "Claude Code didn't report which account it would use." };
  }
  const account = accountOf(info.email, info.subscriptionType);
  if (info.apiProvider && info.apiProvider !== "firstParty") {
    return { signedIn: true, billing: "api", problem: providerProblem(info.apiProvider) };
  }
  if (info.apiKeySource && info.apiKeySource !== "none") {
    return { signedIn: true, billing: "api", account, problem: apiKeyProblem(info.apiKeySource) };
  }
  if (info.tokenSource === "none") {
    return { signedIn: false, billing: "none", problem: SIGNED_OUT_PROBLEM };
  }
  if (info.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN") {
    return { signedIn: true, billing: "subscription", account };
  }
  if (info.tokenSource !== undefined && !SUBSCRIPTION_TOKEN_SOURCES.has(info.tokenSource)) {
    return { signedIn: true, billing: "api", problem: BEARER_TOKEN_PROBLEM };
  }
  if (stringField(info.subscriptionType)) {
    return { signedIn: true, billing: "subscription", account };
  }
  if (info.email || info.organization) {
    return { signedIn: true, billing: "unknown", account, problem: NO_PLAN_PROBLEM };
  }
  return { signedIn: false, billing: "unknown", problem: SIGNED_OUT_PROBLEM };
}
