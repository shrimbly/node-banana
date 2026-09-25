// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildClaudeEnv, buildCodexEnv, isAllowedForCodex, isStrippedForClaude, NODE_BANANA_VERSION } from "../env";

/** Everything that could make Claude Code bill something other than the user's subscription. */
const CLAUDE_BILLING_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_API_KEY",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/** Set when Node Banana itself runs inside a Claude Code session (as in this repo's dev shells). */
const NESTED_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CLOUD_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BG_BACKEND",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_JOB_DIR",
  "CLAUDE_ENV_FILE",
];

/** The app's own provider keys (see CLAUDE.md and process.env reads across src/). */
const APP_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "GEMINI_API_KEY",
  "REPLICATE_API_KEY",
  "FAL_API_KEY",
  "FAL_KEY",
  "KIE_API_KEY",
  "WAVESPEED_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "COMFY_ORG_API_KEY",
];

const OTHER_SECRETS = ["GITHUB_TOKEN", "NPM_TOKEN", "HF_TOKEN", "DATABASE_PASSWORD", "STRIPE_SECRET", "github_token"];

const KEEP_FOR_CLAUDE: Record<string, string> = {
  HOME: "/Users/someone",
  PATH: "/usr/bin:/bin",
  USER: "someone",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp/",
  LANG: "en_NZ.UTF-8",
  CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription-token",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
  CLAUDE_CODE_CLIENT_CERT: "/certs/client.pem",
  CLAUDE_CODE_CLIENT_KEY: "/certs/client.key",
  HTTPS_PROXY: "http://proxy.local:8080",
  HTTP_PROXY: "http://proxy.local:8080",
  NO_PROXY: "localhost",
  ALL_PROXY: "socks5h://proxy.local:1080",
  all_proxy: "socks5h://proxy.local:1080",
  NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
  SSL_CERT_FILE: "/certs/ca.pem",
  CODEX_CA_CERTIFICATE: "/certs/corp.pem",
  NB_CLAUDE_BIN: "/opt/claude",
};

function fill(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `value-of-${name}`]));
}

const EVERYTHING = {
  ...fill(CLAUDE_BILLING_VARIABLES),
  ...fill(NESTED_SESSION_VARIABLES),
  ...fill(APP_KEYS),
  ...fill(OTHER_SECRETS),
  ...KEEP_FOR_CLAUDE,
  CODEX_HOME: "/Users/someone/.codex",
  LC_ALL: "en_NZ.UTF-8",
  UNDEFINED_VALUE: undefined,
};

describe("buildClaudeEnv", () => {
  const env = buildClaudeEnv(EVERYTHING);

  it.each(CLAUDE_BILLING_VARIABLES)("strips %s, which could bill an API or cloud account", (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it.each(NESTED_SESSION_VARIABLES)("strips the nested-session variable %s", (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it.each([...APP_KEYS, ...OTHER_SECRETS])("strips the secret %s", (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it("keeps the config dir, the subscription token, paths, proxies and certificates", () => {
    for (const [name, value] of Object.entries(KEEP_FOR_CLAUDE)) {
      expect(env[name], name).toBe(value);
    }
    expect(env.CODEX_HOME).toBe("/Users/someone/.codex");
  });

  it("identifies the app and turns off auto memory and hyperlinks", () => {
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(`node-banana/${NODE_BANANA_VERSION}`);
    expect(NODE_BANANA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.FORCE_HYPERLINK).toBe("0");
  });

  it("drops undefined values and never leaves an ANTHROPIC_ variable", () => {
    expect(env).not.toHaveProperty("UNDEFINED_VALUE");
    expect(Object.keys(env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
  });

  it("strips any ANTHROPIC_ or CLAUDE_CODE_USE_ variable, including ones not listed today", () => {
    expect(isStrippedForClaude("ANTHROPIC_SOMETHING_NEW")).toBe(true);
    expect(isStrippedForClaude("CLAUDE_CODE_USE_SOMETHING_NEW")).toBe(true);
    expect(isStrippedForClaude("CLAUDE_CODE_SESSION_SOMETHING_NEW")).toBe(true);
  });

  it("reads process.env by default without mutating it", () => {
    const before = { ...process.env };
    buildClaudeEnv();
    expect(process.env).toEqual(before);
  });
});

describe("server.js's loopback stamp secret", () => {
  // server.js sets it on process.env before Next starts; a CLI that could read
  // it could vouch for requests from another machine (sameOrigin.ts).
  const source = { ...EVERYTHING, NB_AGENT_LOCAL_SECRET: "a".repeat(64), NB_AGENT_ALLOWED_HOSTS: "192.168.4.22" };

  it("never reaches the Claude Code child", () => {
    expect(isStrippedForClaude("NB_AGENT_LOCAL_SECRET")).toBe(true);
    const env = buildClaudeEnv(source);
    expect(env).not.toHaveProperty("NB_AGENT_LOCAL_SECRET");
    expect(Object.values(env)).not.toContain("a".repeat(64));
  });

  it("never reaches the Codex child", () => {
    expect(isAllowedForCodex("NB_AGENT_LOCAL_SECRET")).toBe(false);
    const env = buildCodexEnv(source);
    expect(env).not.toHaveProperty("NB_AGENT_LOCAL_SECRET");
    expect(Object.values(env)).not.toContain("a".repeat(64));
  });

  it("stays out of both when read from process.env, as in the running server", () => {
    const before = process.env.NB_AGENT_LOCAL_SECRET;
    process.env.NB_AGENT_LOCAL_SECRET = "b".repeat(64);
    try {
      expect(buildClaudeEnv()).not.toHaveProperty("NB_AGENT_LOCAL_SECRET");
      expect(buildCodexEnv()).not.toHaveProperty("NB_AGENT_LOCAL_SECRET");
    } finally {
      if (before === undefined) delete process.env.NB_AGENT_LOCAL_SECRET;
      else process.env.NB_AGENT_LOCAL_SECRET = before;
    }
  });
});

describe("buildCodexEnv", () => {
  const env = buildCodexEnv(EVERYTHING);

  it("passes only the allowlist", () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        "ALL_PROXY",
        "CODEX_CA_CERTIFICATE",
        "CODEX_HOME",
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "NO_PROXY",
        "PATH",
        "SHELL",
        "SSL_CERT_FILE",
        "TMPDIR",
        "USER",
        "all_proxy",
      ].sort(),
    );
  });

  it("keeps every proxy and custom-CA variable Codex reads", () => {
    const network = {
      CODEX_CA_CERTIFICATE: "/certs/corp.pem",
      SSL_CERT_FILE: "/certs/ca.pem",
      SSL_CERT_DIR: "/certs",
      ALL_PROXY: "socks5h://p:1080",
      all_proxy: "http://p:3128",
      HTTPS_PROXY: "http://p:3128",
      https_proxy: "http://p:3128",
      HTTP_PROXY: "http://p:3128",
      http_proxy: "http://p:3128",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    };
    expect(buildCodexEnv(network)).toEqual(network);
  });

  it.each(["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"])("never passes %s (it would bill the API)", (name) => {
    expect(env).not.toHaveProperty(name);
    expect(isAllowedForCodex(name)).toBe(false);
  });

  it("never passes Claude or Anthropic variables", () => {
    expect(Object.keys(env).filter((name) => /^(ANTHROPIC|CLAUDE)/.test(name))).toEqual([]);
  });

  it("keeps CODEX_HOME, where the ChatGPT login lives", () => {
    expect(env.CODEX_HOME).toBe("/Users/someone/.codex");
  });

  it("keeps Windows and Linux essentials when present", () => {
    const windows = buildCodexEnv({ USERPROFILE: "C:\\Users\\x", APPDATA: "a", LOCALAPPDATA: "b", Path: "c", SystemRoot: "d", TEMP: "e", TMP: "f" });
    expect(Object.keys(windows).sort()).toEqual(["APPDATA", "LOCALAPPDATA", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]);
    const linux = buildCodexEnv({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(Object.keys(linux).sort()).toEqual(["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]);
  });
});
