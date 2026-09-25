/**
 * Environments for the vendor CLIs the agent drives. Server-only.
 *
 * Billing safety starts here. Both CLIs let an environment variable outrank
 * the user's subscription login: `ANTHROPIC_API_KEY` (and friends) beats the
 * Claude login, and `CODEX_API_KEY` silently beats the ChatGPT login — without
 * either CLI's status command noticing. So the child never sees them:
 *
 * - Claude: `process.env` minus every Anthropic/cloud-provider credential, the
 *   app's own provider keys, anything else that looks like a secret, and the
 *   nested-session variables Node Banana inherits when it is itself started
 *   from a Claude Code terminal. The config dir (where the login lives) stays.
 * - Codex: an allowlist. Nothing reaches the child that isn't needed to find
 *   the home directory, the login, the network (proxies, custom CAs) and the
 *   locale.
 */

import packageJson from "../../../../package.json";

export const NODE_BANANA_VERSION: string = packageJson.version;

type SourceEnv = Record<string, string | undefined>;

/* ── Claude Code ───────────────────────────────────────────────── */

/**
 * Variable-name prefixes the Claude child never sees.
 *
 * `ANTHROPIC_` covers API keys, bearer tokens, base URLs, custom headers,
 * profiles, workload federation and the Bedrock/Vertex/Foundry settings.
 */
const CLAUDE_STRIP_PREFIXES = [
  "ANTHROPIC_",
  // Cloud-provider switches (Bedrock, Vertex, Foundry, ...).
  "CLAUDE_CODE_USE_",
  // CLAUDE_CODE_API_KEY, _FILE_DESCRIPTOR, _HELPER_TTL_MS.
  "CLAUDE_CODE_API_KEY",
  // Enterprise gateway credentials.
  "CLAUDE_CODE_GATEWAY_",
  "AWS_BEARER_TOKEN_BEDROCK",
  // The parent Claude Code session, when Node Banana runs inside one.
  "CLAUDE_CODE_SESSION_",
  "CLAUDE_CODE_MESSAGING_",
  "CLAUDE_CODE_BRIDGE_",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_BRIDGE_",
  "CLAUDE_BG_",
];

/** Exact names of parent-session variables the Claude child never sees. */
const CLAUDE_STRIP_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CLOUD_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_JOB_DIR",
  "CLAUDE_ENV_FILE",
  // server.js's per-process loopback stamp (sameOrigin.ts). SECRET_NAME
  // catches it too; named so the intent survives a change to the pattern.
  "NB_AGENT_LOCAL_SECRET",
]);

/**
 * The app's own provider keys. Most also match {@link SECRET_NAME}; they are
 * listed so the intent survives a change to the pattern.
 */
const APP_PROVIDER_KEYS = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "REPLICATE_API_KEY",
  "REPLICATE_API_TOKEN",
  "FAL_API_KEY",
  "FAL_KEY",
  "KIE_API_KEY",
  "WAVESPEED_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "COMFY_ORG_API_KEY",
  "COMFY_SMOKE_KEY",
]);

/**
 * Names that look like credentials: `*_API_KEY`, `*_KEY`, `*_TOKEN`,
 * `*_SECRET*`, `*_PASSWORD`, `*_CREDENTIALS`, `AWS_ACCESS_KEY_ID`, ... The
 * agent only calls our in-process tools, so it needs none of them — and some
 * (AWS keys, Google credentials) would let a cloud provider bill instead.
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and the like do not match (`TOKENS`).
 */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)(?:_|$)/;

/**
 * Credentials the user set up for Claude Code itself that still bill their
 * subscription (`claude setup-token`), plus mTLS settings some networks need
 * to reach Anthropic at all.
 */
const CLAUDE_KEEP = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
]);

/** Whether the Claude child must not see this variable. */
export function isStrippedForClaude(name: string): boolean {
  if (CLAUDE_KEEP.has(name)) return false;
  if (CLAUDE_STRIP_EXACT.has(name) || APP_PROVIDER_KEYS.has(name)) return true;
  if (CLAUDE_STRIP_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return SECRET_NAME.test(name.toUpperCase());
}

/**
 * The complete environment for a Claude Code child (`auth status`,
 * `auth login`, and the Agent SDK's `env`, which *replaces* the child's
 * environment rather than merging with it).
 */
export function buildClaudeEnv(source: SourceEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isStrippedForClaude(name)) continue;
    env[name] = value;
  }
  // Identify the app honestly in Claude Code's User-Agent.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `node-banana/${NODE_BANANA_VERSION}`;
  // Agent chats should not read or write the user's Claude memory files.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  // Print the sign-in URL as plain text, never wrapped in an OSC-8 link.
  env.FORCE_HYPERLINK = "0";
  return env;
}

/* ── Codex ─────────────────────────────────────────────────────── */

/**
 * Everything the Codex child may see. Notably absent: `CODEX_API_KEY` (it
 * overrides the ChatGPT login and `account/read` still reports "chatgpt"),
 * `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, and every Claude/Anthropic variable.
 */
const CODEX_ALLOW = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "Path",
  "SystemRoot",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "SHELL",
  "USER",
  "LOGNAME",
  "CODEX_HOME",
  // Network: proxies (ALL_PROXY covers SOCKS and anything the others don't) and
  // custom CAs for TLS-inspecting networks. CODEX_CA_CERTIFICATE is Codex's own
  // CA override and wins over SSL_CERT_FILE. Paths and URLs only: none of them
  // can change which account a turn bills.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Linux keyring access, for `cli_auth_credentials_store = "keyring"`.
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
]);

/** Whether the Codex child may see this variable. */
export function isAllowedForCodex(name: string): boolean {
  return CODEX_ALLOW.has(name) || name.startsWith("LC_");
}

/** The complete environment for the `codex app-server` child. */
export function buildCodexEnv(source: SourceEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !isAllowedForCodex(name)) continue;
    env[name] = value;
  }
  return env;
}
