// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyCodexAccount,
  classifyCodexUsage,
  codexModelOptions,
  codexProviderProblem,
  formatChatGptPlan,
  isCreditBilledPlan,
} from "../codexStatus";

/** `account/read` responses, shaped per the app-server's GetAccountResponse (0.157). */
describe("classifyCodexAccount", () => {
  it("runs on a ChatGPT login (recorded live: pro plan)", () => {
    const verdict = classifyCodexAccount({
      account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
      workspaceRouting: { chatgptAccountId: "acct", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" },
    });
    expect(verdict).toEqual({
      signedIn: true,
      billing: "subscription",
      account: { email: "person@example.com", plan: "Pro" },
    });
  });

  it.each(["self_serve_business_usage_based", "enterprise_cbp_usage_based", "enterprise_cbp_automation"])(
    "refuses a flexible-pricing workspace (%s): it bills credits per token, not a plan",
    (planType) => {
      const verdict = classifyCodexAccount({ account: { type: "chatgpt", email: "x@example.com", planType } });
      expect(verdict).toMatchObject({ signedIn: true, billing: "api" });
      expect(verdict.problem).toMatch(/flexible pricing/);
      expect(isCreditBilledPlan(planType)).toBe(true);
    },
  );

  it.each(["free", "go", "plus", "team", "business", "enterprise", "edu", "unknown"])(
    "treats every ChatGPT plan (%s) as the subscription",
    (planType) => {
      expect(classifyCodexAccount({ account: { type: "chatgpt", email: null, planType } }).billing).toBe("subscription");
    },
  );

  it("reports signed out when there is no account (recorded live: empty CODEX_HOME)", () => {
    const verdict = classifyCodexAccount({ requiresOpenaiAuth: true });
    expect(verdict).toMatchObject({ signedIn: false, billing: "none" });
    expect(verdict.problem).toMatch(/isn't signed in/);
    expect(classifyCodexAccount({ account: null, requiresOpenaiAuth: true }).billing).toBe("none");
  });

  it("refuses an API-key login", () => {
    const verdict = classifyCodexAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(verdict).toMatchObject({ signedIn: true, billing: "api" });
    expect(verdict.problem).toMatch(/API key/);
  });

  it("refuses Amazon Bedrock", () => {
    const verdict = classifyCodexAccount({ account: { type: "amazonBedrock", usesCodexManagedCredentials: true } });
    expect(verdict).toMatchObject({ signedIn: true, billing: "api" });
    expect(verdict.problem).toMatch(/Bedrock/);
  });

  it("refuses account types it doesn't know, and unreadable responses", () => {
    expect(classifyCodexAccount({ account: { type: "somethingNew" } }).billing).toBe("unknown");
    expect(classifyCodexAccount(null).billing).toBe("unknown");
    expect(classifyCodexAccount("chatgpt").billing).toBe("unknown");
  });

  it("only omits the problem on a subscription", () => {
    for (const response of [{ account: { type: "chatgpt", planType: "plus" } }, { account: { type: "apiKey" } }, {}]) {
      const verdict = classifyCodexAccount(response);
      expect(verdict.problem === undefined).toBe(verdict.billing === "subscription");
    }
  });
});

describe("formatChatGptPlan", () => {
  it.each([
    ["pro", "Pro"],
    ["plus", "Plus"],
    ["prolite", "Pro Lite"],
    ["self_serve_business_usage_based", "Business"],
    ["enterprise_cbp_automation", "Enterprise"],
    ["edu_plus", "Edu Plus"],
    ["brand_new_plan", "Brand New Plan"],
    ["unknown", undefined],
    [null, undefined],
  ])("%s → %s", (planType, expected) => {
    expect(formatChatGptPlan(planType)).toBe(expected);
  });
});

describe("codexProviderProblem", () => {
  it("accepts the built-in OpenAI provider and refuses custom ones", () => {
    expect(codexProviderProblem(null)).toBeUndefined();
    expect(codexProviderProblem("openai")).toBeUndefined();
    expect(codexProviderProblem("azure")).toMatch(/"azure"/);
  });
});

describe("codexModelOptions", () => {
  // model/list data recorded live for a ChatGPT Pro account (trimmed to the fields used).
  const live = [
    { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, isDefault: true },
    { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false, isDefault: false },
    { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false },
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: false },
    { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", hidden: false, isDefault: false },
    { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", hidden: false, isDefault: false },
    { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", hidden: false, isDefault: false },
  ];

  it("lists visible models and prefers gpt-5.6-luna as the default", () => {
    const options = codexModelOptions(live);
    expect(options.map((option) => option.id)).toEqual(live.map((model) => model.model));
    expect(options.filter((option) => option.isDefault)).toEqual([{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna", isDefault: true }]);
  });

  it("falls back to the server's default, then the first model", () => {
    const withoutLuna = live.filter((model) => model.model !== "gpt-5.6-luna");
    expect(codexModelOptions(withoutLuna).find((option) => option.isDefault)?.id).toBe("gpt-6-astra");
    const noDefault = withoutLuna.map((model) => ({ ...model, isDefault: false }));
    expect(codexModelOptions(noDefault).find((option) => option.isDefault)?.id).toBe("gpt-6-astra");
    expect(codexModelOptions([])).toEqual([]);
  });

  it("skips hidden, duplicate and malformed entries", () => {
    const options = codexModelOptions([
      { model: "a", displayName: "A", hidden: true },
      { model: "b", displayName: "" },
      { model: "b", displayName: "B again" },
      null,
      "nope",
      { id: "c" },
    ]);
    expect(options).toEqual([{ id: "b", label: "b", isDefault: true }, { id: "c", label: "c" }]);
  });
});

/** `account/rateLimits/read` responses, shaped per GetAccountRateLimitsResponse (0.157). */
describe("classifyCodexUsage", () => {
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790368200 },
    secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1790647200 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  });
  const response = (overrides: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) => ({
    ordinaryUsageAllowed: true,
    rateLimits: snapshot(limits),
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
    ...overrides,
  });

  it("allows a plan with room (recorded live: Pro, no credits)", () => {
    expect(classifyCodexUsage(response())).toEqual({ allowed: true });
  });

  it("never counts purchased or unlimited credits as room", () => {
    const paying = { credits: { hasCredits: true, unlimited: true, balance: "480" } };
    const verdict = classifyCodexUsage(response({ ordinaryUsageAllowed: false }, paying));
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toMatch(/won't spend purchased credits/);
  });

  it.each([
    ["a reached limit", {}, { rateLimitReachedType: "rate_limit_reached" }],
    ["workspace credits depleted", {}, { rateLimitReachedType: "workspace_owner_credits_depleted" }],
    ["the workspace spend control", {}, { spendControlReached: true }],
    ["a full window when the backend doesn't say", { ordinaryUsageAllowed: null }, { secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790647200 } }],
  ])("refuses on %s", (_label, overrides, limits) => {
    expect(classifyCodexUsage(response(overrides, limits)).allowed).toBe(false);
  });

  it("trusts ordinaryUsageAllowed over percentages for recovery", () => {
    const full = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790368200 } };
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: true }, full)).allowed).toBe(true);
  });

  it("refuses when the backend doesn't say (null) and credits could pay, whatever the percentages read (audit probe)", () => {
    const withCredits = { primary: { usedPercent: 99.5, resetsAt: 1 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "40" } };
    const verdict = classifyCodexUsage(response({ ordinaryUsageAllowed: null }, withCredits));
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toMatch(/Couldn't confirm/);
    // Low percentages don't make it safe either: they are not the backend's answer.
    const low = { credits: { hasCredits: true, unlimited: false, balance: "40" } };
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: null }, low)).allowed).toBe(false);
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: null }, { credits: { hasCredits: false, unlimited: true } })).allowed).toBe(false);
    // No credits entry: nothing says they couldn't pay.
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: null }, { credits: null })).allowed).toBe(false);
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: undefined })).allowed).toBe(true);
    // Nothing at all to judge by.
    expect(classifyCodexUsage({ ordinaryUsageAllowed: null, rateLimits: null, rateLimitsByLimitId: null }).allowed).toBe(false);
  });

  it("goes ahead when the backend doesn't say but no credits exist to pay past the plan", () => {
    // Past the plan such an account is stopped, not billed.
    expect(classifyCodexUsage(response({ ordinaryUsageAllowed: null })).allowed).toBe(true);
  });

  it("reports when a full window resets", () => {
    const verdict = classifyCodexUsage(
      response({ ordinaryUsageAllowed: false }, { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790368200 } }),
    );
    expect(verdict.resetsAt).toBe(1790368200);
    expect(verdict.problem).toMatch(/used up until /);
  });

  it("checks the codex limit and the chosen model's limit in the multi-bucket view", () => {
    const byId = (entries: Record<string, unknown>) => response({ rateLimitsByLimitId: entries });
    const reached = snapshot({ limitId: "other", normalModelSlug: "gpt-5.6-luna", rateLimitReachedType: "rate_limit_reached" });
    expect(classifyCodexUsage(byId({ luna: reached }), "gpt-5.6-luna").allowed).toBe(false);
    expect(classifyCodexUsage(byId({ luna: reached }), "gpt-6-astra").allowed).toBe(true);
    expect(classifyCodexUsage(byId({ codex: snapshot({ spendControlReached: true }) })).allowed).toBe(false);
  });
});

describe("codexModelOptions efforts", () => {
  const listed = [
    {
      id: "gpt-6-sol",
      model: "gpt-6-sol",
      displayName: "GPT-6-Sol",
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    },
  ];

  it("lists the reasoning levels, defaulting to Node Banana's own level when offered", () => {
    expect(codexModelOptions(listed, "medium")[0]).toMatchObject({
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
    expect(codexModelOptions(listed, "xhigh")[0].defaultEffort).toBe("high");
    expect(codexModelOptions(listed)[0].defaultEffort).toBe("high");
  });
});
