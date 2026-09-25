/**
 * Who would pay for a Codex turn, and which models to offer. Server-only, pure.
 *
 * `account/read` is the source: a ChatGPT login is the user's plan; an API
 * key or Amazon Bedrock login bills something else and is refused, and so is
 * a flexible-pricing workspace, which bills credits per token rather than a
 * plan. The `CODEX_API_KEY` override is invisible to `account/read`, which is
 * why the app-server's environment is an allowlist (env.ts) — this check can
 * only see stored logins.
 *
 * `account/rateLimits/read` then says whether the plan's included usage has
 * room. Past the plan limit ChatGPT draws on purchased credits
 * automatically, so a turn is refused there too: purchased credits are never
 * a reason to run.
 */

import type { AgentModelOption } from "../types";
import type { BillingVerdict } from "./billing";

/** Fast, and without the sub-agent tools the gpt-6 family always carries. */
export const CODEX_PREFERRED_MODEL = "gpt-5.6-luna";

export const CODEX_SIGN_IN_COMMAND = "codex login";

const SIGNED_OUT_PROBLEM = "Codex isn't signed in. Sign in with your ChatGPT account to use the agent.";

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

/** "pro" → "Pro"; unknown plans are title-cased; "unknown" is dropped. */
export function formatChatGptPlan(planType: unknown): string | undefined {
  if (typeof planType !== "string" || !planType || planType === "unknown") return undefined;
  return (
    PLAN_NAMES[planType] ??
    planType
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/**
 * Plans billed per token from workspace credits ("flexible pricing") rather
 * than by a subscription's included usage.
 */
export function isCreditBilledPlan(planType: unknown): boolean {
  return typeof planType === "string" && (/_usage_based$/.test(planType) || /^enterprise_cbp_/.test(planType));
}

/** Classify an `account/read` response. */
export function classifyCodexAccount(response: unknown): BillingVerdict {
  if (!response || typeof response !== "object") {
    return { signedIn: false, billing: "unknown", problem: "Couldn't read Codex's sign-in status." };
  }
  const account = (response as { account?: unknown }).account;
  if (!account || typeof account !== "object") {
    return { signedIn: false, billing: "none", problem: SIGNED_OUT_PROBLEM };
  }
  const { type, email, planType } = account as { type?: unknown; email?: unknown; planType?: unknown };
  switch (type) {
    case "chatgpt": {
      const details = {
        email: typeof email === "string" && email ? email : undefined,
        plan: formatChatGptPlan(planType),
      };
      if (isCreditBilledPlan(planType)) {
        return {
          signedIn: true,
          billing: "api",
          account: details.email || details.plan ? details : undefined,
          problem:
            "Codex is signed in to a ChatGPT workspace on flexible pricing, which bills credits per token " +
            "rather than a fixed plan, so the agent won't run on it. Sign in with a ChatGPT account on a plan.",
        };
      }
      return {
        signedIn: true,
        billing: "subscription",
        account: details.email || details.plan ? details : undefined,
      };
    }
    case "apiKey":
      return {
        signedIn: true,
        billing: "api",
        problem:
          "Codex is signed in with an OpenAI API key, which bills API credits. " +
          "Sign in with your ChatGPT account instead.",
      };
    case "amazonBedrock":
      return {
        signedIn: true,
        billing: "api",
        problem:
          "Codex is signed in to Amazon Bedrock, which bills your AWS account rather than a ChatGPT plan. " +
          "Sign in with your ChatGPT account instead.",
      };
    default:
      return {
        signedIn: true,
        billing: "unknown",
        problem: `Codex reports an unrecognised sign-in type (${JSON.stringify(type)}), so the agent won't run on it.`,
      };
  }
}

/* ── plan usage ───────────────────────────────────────────────── */

interface RateLimitWindowLike {
  usedPercent?: unknown;
  resetsAt?: unknown;
}

interface RateLimitSnapshotLike {
  limitId?: unknown;
  normalModelSlug?: unknown;
  primary?: RateLimitWindowLike | null;
  secondary?: RateLimitWindowLike | null;
  spendControlReached?: unknown;
  rateLimitReachedType?: unknown;
  credits?: { hasCredits?: unknown; unlimited?: unknown } | null;
}

/**
 * Whether purchased credits could pay for requests past the plan on this
 * bucket: it has credits, unlimited ones, or doesn't say (no credits entry).
 */
function creditsCouldPay(snapshot: RateLimitSnapshotLike): boolean {
  const credits = snapshot.credits;
  if (!credits || typeof credits !== "object") return true;
  return credits.hasCredits !== false || credits.unlimited === true;
}

export interface CodexUsageVerdict {
  /** The plan's included usage has room for a turn. */
  allowed: boolean;
  /** Why not, for the panel. */
  problem?: string;
  /** When the full window resets (epoch seconds), if known. */
  resetsAt?: number;
}

function asSnapshot(value: unknown): RateLimitSnapshotLike | null {
  return value && typeof value === "object" ? (value as RateLimitSnapshotLike) : null;
}

function windowsOf(snapshot: RateLimitSnapshotLike): RateLimitWindowLike[] {
  return [snapshot.primary, snapshot.secondary].filter((window): window is RateLimitWindowLike => !!window && typeof window === "object");
}

function formatReset(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "";
  const at = new Date(epochSeconds * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? ` until ${time}` : ` until ${at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

/**
 * Whether a turn may run on the plan's included usage, from an
 * `account/rateLimits/read` response (or the last snapshot merged with
 * `account/rateLimits/updated`). Refused when the backend says ordinary
 * usage isn't allowed, a limit or the workspace's spend control is reached,
 * or a window is full. When the backend doesn't say (`ordinaryUsageAllowed`
 * null: "unavailable; clients must not infer recovery from percentages"), a
 * turn runs only if no credits could pay past the plan. Credits never count
 * as room: past the plan they are what would pay.
 */
export function classifyCodexUsage(response: unknown, model?: string): CodexUsageVerdict {
  const body = (response && typeof response === "object" ? response : {}) as {
    ordinaryUsageAllowed?: unknown;
    rateLimits?: unknown;
    rateLimitsByLimitId?: Record<string, unknown> | null;
  };
  const snapshots: RateLimitSnapshotLike[] = [];
  const main = asSnapshot(body.rateLimits);
  if (main) snapshots.push(main);
  for (const [limitId, value] of Object.entries(body.rateLimitsByLimitId ?? {})) {
    const snapshot = asSnapshot(value);
    if (!snapshot) continue;
    if (limitId === "codex" || snapshot.limitId === "codex" || (model && snapshot.normalModelSlug === model)) {
      snapshots.push(snapshot);
    }
  }

  const windows = snapshots.flatMap(windowsOf);
  const full = windows.filter((window) => typeof window.usedPercent === "number" && window.usedPercent >= 100);
  const resets = full.map((window) => window.resetsAt).filter((at): at is number => typeof at === "number" && at > 0);
  const resetsAt = resets.length > 0 ? Math.max(...resets) : undefined;
  const reached = snapshots.map((snapshot) => snapshot.rateLimitReachedType).find((type) => typeof type === "string" && type);

  const refuse = (problem: string): CodexUsageVerdict => ({ allowed: false, problem, resetsAt });
  const noCredits = " The agent runs only on your plan's included usage and won't spend purchased credits.";

  if (snapshots.some((snapshot) => snapshot.spendControlReached === true)) {
    return refuse("Your ChatGPT workspace's spend limit for Codex has been reached, so the agent won't run.");
  }
  if (typeof reached === "string" && /credits_depleted$/.test(reached)) {
    return refuse("Your ChatGPT workspace is out of Codex credits, so the agent won't run.");
  }
  if (body.ordinaryUsageAllowed === false || reached || (body.ordinaryUsageAllowed !== true && full.length > 0)) {
    return refuse(`Your ChatGPT plan's included Codex usage is used up${formatReset(resetsAt)}.${noCredits}`);
  }
  if (body.ordinaryUsageAllowed !== true && (snapshots.length === 0 || snapshots.some(creditsCouldPay))) {
    return refuse(
      "Couldn't confirm that your ChatGPT plan has included Codex usage left (Codex didn't say), so the agent " +
        `didn't start the turn.${noCredits} Try again in a moment.`,
    );
  }
  return { allowed: true };
}

/**
 * A problem when Codex would send turns somewhere other than OpenAI's own
 * backend (a custom `model_provider` in config.toml, e.g. an API gateway).
 * The app-server is started with `model_provider="openai"`; this double-checks
 * the effective value.
 */
export function codexProviderProblem(modelProvider: string | null | undefined): string | undefined {
  if (!modelProvider || modelProvider === "openai") return undefined;
  return (
    `Codex is configured to use the model provider "${modelProvider}" (config.toml), which isn't your ` +
    "ChatGPT plan, so the agent won't run on it."
  );
}

interface ListedModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
}

/**
 * The picker's models from `model/list` data: visible models, labelled by
 * display name. Default: {@link CODEX_PREFERRED_MODEL} when listed, else the
 * server's default, else the first.
 */
export function codexModelOptions(models: unknown[]): AgentModelOption[] {
  const options: Array<AgentModelOption & { serverDefault: boolean }> = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as ListedModel;
    const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
    if (!id || model.hidden === true || options.some((option) => option.id === id)) continue;
    options.push({
      id,
      label: typeof model.displayName === "string" && model.displayName ? model.displayName : id,
      serverDefault: model.isDefault === true,
    });
  }
  const defaultId =
    options.find((option) => option.id === CODEX_PREFERRED_MODEL)?.id ??
    options.find((option) => option.serverDefault)?.id ??
    options[0]?.id;
  return options.map(({ id, label }) => (id === defaultId ? { id, label, isDefault: true } : { id, label }));
}
