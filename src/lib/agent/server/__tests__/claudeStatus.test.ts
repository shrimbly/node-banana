// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyClaudeAccount, classifyClaudeAuthStatus, CLAUDE_MODELS, claudeModelOptions, formatClaudePlan } from "../claudeStatus";

/**
 * `claude auth status` JSON, shaped like the CLI prints it (2.1.282; see
 * .scratch/agent/reports/claude-sdk.md §2 and the CLI's authStatus source).
 * Paths and analytics fields are the same in every case.
 */
function authStatus(fields: Record<string, unknown>) {
  return {
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: "/Users/user/.claude/projects",
    configDirectory: "/Users/user/.claude",
    ...fields,
  };
}

const NO_OAUTH_ENV = { oauthTokenInEnv: false };

describe("classifyClaudeAuthStatus", () => {
  it("runs on a stored claude.ai login with a Max plan", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.com",
        orgId: "org",
        orgName: "Org",
        subscriptionType: "max",
      }),
      NO_OAUTH_ENV,
    );
    expect(verdict).toEqual({
      signedIn: true,
      billing: "subscription",
      account: { email: "person@example.com", plan: "Max" },
    });
  });

  it("reports signed out (exit 1 output)", () => {
    const verdict = classifyClaudeAuthStatus(authStatus({ loggedIn: false, authMethod: "none" }), NO_OAUTH_ENV);
    expect(verdict.signedIn).toBe(false);
    expect(verdict.billing).toBe("none");
    expect(verdict.problem).toMatch(/isn't signed in/);
  });

  it("refuses an ANTHROPIC_API_KEY even when a claude.ai login exists (the key wins)", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({
        loggedIn: true,
        authMethod: "claude.ai",
        apiKeySource: "ANTHROPIC_API_KEY",
        email: null,
        orgId: null,
        orgName: null,
        subscriptionType: null,
      }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("api");
    expect(verdict.problem).toMatch(/ANTHROPIC_API_KEY/);
    expect(verdict.problem).toMatch(/API credits/);
  });

  it("refuses a Console login (claude.ai method with a /login managed key)", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({ loggedIn: true, authMethod: "claude.ai", apiKeySource: "/login managed key", subscriptionType: null }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("api");
    expect(verdict.problem).toMatch(/Console/);
  });

  it("refuses authMethod api_key", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({ loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("api");
  });

  it("refuses authMethod api_key even without an apiKeySource field", () => {
    const verdict = classifyClaudeAuthStatus(authStatus({ loggedIn: true, authMethod: "api_key" }), NO_OAUTH_ENV);
    expect(verdict.billing).toBe("api");
  });

  it("refuses an apiKeyHelper", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({ loggedIn: true, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("api");
    expect(verdict.problem).toMatch(/apiKeyHelper/);
  });

  it.each(["bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle"])(
    "refuses the cloud provider %s",
    (apiProvider) => {
      const verdict = classifyClaudeAuthStatus(
        authStatus({ loggedIn: true, authMethod: "third_party", apiProvider }),
        NO_OAUTH_ENV,
      );
      expect(verdict.billing).toBe("api");
      expect(verdict.problem).toMatch(/bills that cloud account/);
    },
  );

  it("refuses an enterprise gateway, signed in or not", () => {
    for (const loggedIn of [true, false]) {
      const verdict = classifyClaudeAuthStatus(
        authStatus({ loggedIn, authMethod: "none", apiProvider: "gateway" }),
        NO_OAUTH_ENV,
      );
      expect(verdict.billing).toBe("api");
      expect(verdict.problem).toMatch(/gateway/);
    }
  });

  it("runs on oauth_token only when the agent's env carries CLAUDE_CODE_OAUTH_TOKEN", () => {
    const status = authStatus({ loggedIn: true, authMethod: "oauth_token" });
    expect(classifyClaudeAuthStatus(status, { oauthTokenInEnv: true }).billing).toBe("subscription");
    // Otherwise it's a bearer token from settings (ANTHROPIC_AUTH_TOKEN, a federation profile, ...).
    const refused = classifyClaudeAuthStatus(status, NO_OAUTH_ENV);
    expect(refused.billing).toBe("api");
    expect(refused.problem).toMatch(/bearer token/);
  });

  it("refuses a claude.ai login with no plan (unknown billing)", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", subscriptionType: null }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("unknown");
    expect(verdict.problem).toMatch(/no Claude Pro or Max plan/);
  });

  it("refuses when organization policy forces Console sign-in", () => {
    const verdict = classifyClaudeAuthStatus(
      authStatus({ loggedIn: false, authMethod: "none", forcedLoginMethod: "console" }),
      NO_OAUTH_ENV,
    );
    expect(verdict.billing).toBe("api");
  });

  it("refuses unrecognised auth methods and unreadable output", () => {
    expect(classifyClaudeAuthStatus(authStatus({ loggedIn: true, authMethod: "martian" }), NO_OAUTH_ENV).billing).toBe(
      "unknown",
    );
    expect(classifyClaudeAuthStatus(null, NO_OAUTH_ENV).billing).toBe("unknown");
    expect(classifyClaudeAuthStatus("not json", NO_OAUTH_ENV).billing).toBe("unknown");
  });

  it("only omits the problem when the verdict is subscription", () => {
    const cases = [
      authStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }),
      authStatus({ loggedIn: false, authMethod: "none" }),
      authStatus({ loggedIn: true, authMethod: "api_key" }),
    ];
    for (const status of cases) {
      const verdict = classifyClaudeAuthStatus(status, NO_OAUTH_ENV);
      expect(verdict.problem === undefined).toBe(verdict.billing === "subscription");
    }
  });
});

/**
 * The Agent SDK's initializationResult().account for each credential source,
 * as recorded in .scratch/agent/reports/claude-sdk.md §2 ("Results by
 * credential source").
 */
describe("classifyClaudeAccount", () => {
  it("runs on the stored subscription login (no tokenSource)", () => {
    const verdict = classifyClaudeAccount({
      email: "person@example.com",
      organization: "Org",
      subscriptionType: "Claude Max",
      apiProvider: "firstParty",
    });
    expect(verdict).toEqual({
      signedIn: true,
      billing: "subscription",
      account: { email: "person@example.com", plan: "Max" },
    });
  });

  it("reports signed out for tokenSource none", () => {
    const verdict = classifyClaudeAccount({ tokenSource: "none", apiProvider: "firstParty" });
    expect(verdict).toMatchObject({ signedIn: false, billing: "none" });
  });

  it("refuses ANTHROPIC_API_KEY (tokenSource claude.ai + apiKeySource)", () => {
    const verdict = classifyClaudeAccount({ tokenSource: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" });
    expect(verdict.billing).toBe("api");
  });

  it("runs on CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)", () => {
    const verdict = classifyClaudeAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" });
    expect(verdict.billing).toBe("subscription");
  });

  it("refuses ANTHROPIC_AUTH_TOKEN (a bearer token)", () => {
    const verdict = classifyClaudeAccount({ tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" });
    expect(verdict.billing).toBe("api");
  });

  it("refuses an apiKeyHelper", () => {
    const verdict = classifyClaudeAccount({ tokenSource: "apiKeyHelper", apiKeySource: "apiKeyHelper", apiProvider: "firstParty" });
    expect(verdict.billing).toBe("api");
  });

  it("refuses a Console login's managed key", () => {
    const verdict = classifyClaudeAccount({ apiKeySource: "/login managed key", apiProvider: "firstParty" });
    expect(verdict.billing).toBe("api");
  });

  it.each(["bedrock", "vertex", "foundry", "gateway", "mantle"])("refuses apiProvider %s", (apiProvider) => {
    const verdict = classifyClaudeAccount({ apiProvider: apiProvider as "bedrock" });
    expect(verdict.billing).toBe("api");
  });

  it("refuses unknown token sources (profiles, federation, ...)", () => {
    expect(classifyClaudeAccount({ tokenSource: "profile", apiProvider: "firstParty" }).billing).toBe("api");
  });

  it("refuses a login without a plan, and an empty report", () => {
    expect(classifyClaudeAccount({ email: "a@b.c", apiProvider: "firstParty" }).billing).toBe("unknown");
    expect(classifyClaudeAccount({}).billing).toBe("unknown");
    expect(classifyClaudeAccount(undefined).billing).toBe("unknown");
  });
});

describe("formatClaudePlan", () => {
  it.each([
    ["max", "Max"],
    ["Claude Max", "Max"],
    ["pro", "Pro"],
    ["team", "Team"],
    [null, undefined],
    ["", undefined],
  ])("%s → %s", (input, expected) => {
    expect(formatClaudePlan(input)).toBe(expected);
  });
});

describe("claudeModelOptions", () => {
  it("names the picker's models from Claude Code's own list, keeping Sonnet the default", () => {
    const options = claudeModelOptions([
      { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolvedModel: "claude-opus-5-5" },
      { value: "opus", displayName: "Opus 5.5", description: "Most capable for ambitious work", resolvedModel: "claude-opus-5-5" },
      { value: "sonnet", displayName: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
      { value: "haiku", displayName: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
    expect(options.map((o) => [o.id, o.label, o.resolvedModel, Boolean(o.isDefault)])).toEqual([
      ["default", "Plan default (Opus 5.5)", "claude-opus-5-5", false],
      ["opus", "Opus 5.5", "claude-opus-5-5", false],
      ["sonnet", "Sonnet 5", "claude-sonnet-5", true],
      ["haiku", "Haiku 4.5", "claude-haiku-4-5-20251001", false],
    ]);
  });

  it("falls back to the static aliases when the CLI reports no list", () => {
    expect(claudeModelOptions(undefined)).toBe(CLAUDE_MODELS);
    expect(claudeModelOptions([])).toBe(CLAUDE_MODELS);
  });
});

describe("claudeModelOptions efforts", () => {
  it("carries each model's effort levels, defaulting to high", () => {
    const [opus, haiku] = claudeModelOptions([
      { value: "opus", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "haiku", displayName: "Haiku 4.5", supportsEffort: false },
    ]);
    expect(opus).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" });
    expect(haiku.efforts).toBeUndefined();
  });
});
