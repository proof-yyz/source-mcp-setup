/**
 * Source MCP setup — handshake URL consumer.
 *
 * Fetches the one-shot handshake URL once, parses + validates the
 * response, hands the caller back the credential payload. Single use,
 * 60s TTL — the moment this function returns ok, the URL is dead and
 * cannot be retried for the same payload.
 */

import { URL } from "node:url";

// Real Source tokens are `src_` + 27 base58 chars (31 chars total).
// Base58 = base64 minus 0/O/I/l for terminal-paste safety. Source for
// this constant: api/src/lib/api-tokens.ts (TOKEN_BODY_LENGTH = 27).
// Keep these duplicated — the npm package can't import from the app —
// and bump in lock-step if the format ever changes.
const TOKEN_PREFIX = "src_";
const TOKEN_BODY_LENGTH = 27;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Production MCP server hosts. The handshake response carries an
 * mcp_url field that the CLI writes into client configs alongside the
 * bearer token; if a compromised Source server returns
 * https://attacker.test/api/mcp, the CLI would happily install that
 * and Claude Desktop would forward every doc fetch (with the token in
 * the Authorization header) to the attacker.
 *
 * Defense: hardcode the legitimate hosts here. Override with
 * --mcp-host-override=<host> for staging/dev only, with a noisy warning.
 */
export const PRODUCTION_MCP_HOSTS = [
  "source.enrollhere.com",        // future — once DNS is wired to the Vercel deploy
  "source-portal-chi.vercel.app", // current Vercel deploy
];
const DEV_MCP_HOST_PATTERN = /^(?:localhost|127\.\d+\.\d+\.\d+)(?::\d+)?$/;

export interface HandshakePayload {
  token: string;
  scheme: "Bearer";
  mcpUrl: string;
  expiresAt: string;
}

export interface FetchOptions {
  /** Override the global fetch (test injection). */
  fetchImpl?: typeof fetch;
  /** Override AbortSignal (test injection). */
  signal?: AbortSignal;
  /** Soft cap on response body size, bytes. Defaults to 8KB. */
  maxBodyBytes?: number;
  /** Allow an additional MCP host (dev / staging override only). */
  allowMcpHost?: string;
}

const DEFAULT_MAX_BODY = 8 * 1024;

const URL_PATTERN = /^https:\/\/[^/\s]+\/api\/v1\/mcp\/handshake\/[A-Za-z0-9_-]{32,64}$/;
// localhost / 127.* allowed only over http for dev-loop.
const DEV_URL_PATTERN =
  /^http:\/\/(?:localhost|127\.\d+\.\d+\.\d+)(?::\d+)?\/api\/v1\/mcp\/handshake\/[A-Za-z0-9_-]{32,64}$/;

export function isPlausibleHandshakeUrl(input: string): boolean {
  return URL_PATTERN.test(input) || DEV_URL_PATTERN.test(input);
}

/**
 * Fetch + validate. Throws on:
 *   * Non-2xx status (handshake unknown / used / expired → 410)
 *   * Body too large (defends against a hostile server attempting to
 *     OOM the CLI by streaming MB of garbage)
 *   * Missing required fields
 *   * Unexpected scheme value
 */
export async function consumeHandshake(
  url: string,
  opts: FetchOptions = {},
): Promise<HandshakePayload> {
  if (!isPlausibleHandshakeUrl(url)) {
    throw new Error(
      `handshake URL doesn't match expected shape: ${redactUrl(url)}`,
    );
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent(),
    },
    signal: opts.signal,
    redirect: "manual",
  });

  if (res.status === 410) {
    throw new HandshakeExpiredError();
  }
  if (!res.ok) {
    throw new Error(`handshake fetch failed: HTTP ${res.status}`);
  }

  const cl = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(cl) && cl > maxBody) {
    throw new Error(
      `handshake response too large (${cl} bytes > ${maxBody} cap)`,
    );
  }

  const text = await res.text();
  if (text.length > maxBody) {
    throw new Error(
      `handshake response too large (${text.length} bytes > ${maxBody} cap)`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("handshake response is not JSON");
  }
  return validatePayload(body, opts.allowMcpHost);
}

export class HandshakeExpiredError extends Error {
  override readonly name = "HandshakeExpiredError";
  constructor() {
    super(
      "handshake unknown, already used, or expired (60-second window). Generate a fresh install command from /me/api-tokens.",
    );
  }
}

function validatePayload(
  body: unknown,
  allowMcpHost?: string,
): HandshakePayload {
  if (!body || typeof body !== "object") {
    throw new Error("handshake response was not a JSON object");
  }
  const obj = body as Record<string, unknown>;
  const token = obj.token;
  const scheme = obj.scheme;
  const mcpUrl = obj.mcp_url;
  const expiresAt = obj.expires_at;

  // Token must be exactly src_<27 base58 chars> (31 chars total).
  // Order: prefix → length → charset, so a malformed token returns the
  // most specific error message.
  if (typeof token !== "string") {
    throw new Error("handshake response: token missing");
  }
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error("handshake response: token missing src_ prefix");
  }
  if (token.length !== TOKEN_PREFIX.length + TOKEN_BODY_LENGTH) {
    throw new Error(
      `handshake response: token wrong length (got ${token.length}, want ${TOKEN_PREFIX.length + TOKEN_BODY_LENGTH})`,
    );
  }
  const body58 = token.slice(TOKEN_PREFIX.length);
  if (!BASE58_PATTERN.test(body58)) {
    throw new Error("handshake response: token body has non-base58 character");
  }

  if (scheme !== "Bearer") {
    throw new Error(`handshake response: unexpected scheme ${String(scheme)}`);
  }
  if (typeof mcpUrl !== "string") {
    throw new Error("handshake response: mcp_url missing");
  }
  let mcpUrlParsed: URL;
  try {
    mcpUrlParsed = new URL(mcpUrl);
  } catch {
    throw new Error(`handshake response: mcp_url is not a URL (${mcpUrl})`);
  }

  // Protocol gate.
  const isHttps = mcpUrlParsed.protocol === "https:";
  const isLocalhostHttp =
    mcpUrlParsed.protocol === "http:" &&
    DEV_MCP_HOST_PATTERN.test(mcpUrlParsed.host);
  if (!isHttps && !isLocalhostHttp) {
    throw new Error(
      `handshake response: mcp_url must be https (or localhost http), got ${mcpUrl}`,
    );
  }

  // Host pinning (CRIT-3): a compromised Source could otherwise return
  // https://attacker.test/api/mcp, which the CLI would write into
  // Claude Desktop's config. Bearer would then be exfiltrated on every
  // doc fetch. Allow only the allowlisted production hosts, plus
  // localhost (dev), plus any host explicitly opted in by the operator
  // via --mcp-host-override.
  const host = mcpUrlParsed.host;
  const allowed =
    PRODUCTION_MCP_HOSTS.includes(host) ||
    DEV_MCP_HOST_PATTERN.test(host) ||
    (allowMcpHost !== undefined && host === allowMcpHost);
  if (!allowed) {
    throw new Error(
      `handshake response: mcp_url host ${host} is not in the allowlist. ` +
        `Allowed: ${PRODUCTION_MCP_HOSTS.join(", ")}, localhost, 127.* . ` +
        `Pass --mcp-host-override=${host} to override (DEV/STAGING ONLY).`,
    );
  }

  if (typeof expiresAt !== "string") {
    throw new Error("handshake response: expires_at missing");
  }
  return {
    token,
    scheme: "Bearer",
    mcpUrl,
    expiresAt,
  };
}

/**
 * Strip the handshake id from a URL for safe logging — never print
 * the full URL to stderr/stdout, since the id IS the bearer secret
 * during its 60-second window. The greedy `.+$` consumes any
 * trailing query string / fragment too (red-team LOW-1).
 */
export function redactUrl(url: string): string {
  return url.replace(/\/handshake\/.+$/, "/handshake/<redacted>");
}

function userAgent(): string {
  // Helpful for the server-side ua-mismatch detector to distinguish a
  // setup-CLI fetch from a Claude Desktop runtime fetch later. Includes
  // the package version so we can bump-floor against known-bad releases.
  return `enrollhere-source-mcp-setup/${packageVersion()}`;
}

let _versionCache: string | null = null;
function packageVersion(): string {
  if (_versionCache !== null) return _versionCache;
  try {
    // dist/handshake.js → ../package.json (one level up).
    // tests/handshake.test.ts (with tsx) → ../package.json (also one level up).
    // Both resolve to the same file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { version?: string };
    _versionCache = pkg.version ?? "0.0.0";
  } catch {
    _versionCache = "0.0.0";
  }
  return _versionCache;
}
