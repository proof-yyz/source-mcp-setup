/**
 * Public API. The CLI is the primary surface; programmatic usage is
 * also supported for embedded installers (a future EH onboarding
 * orchestrator could call install() directly).
 */

export { consumeHandshake, isPlausibleHandshakeUrl } from "./handshake.js";
export type { HandshakePayload } from "./handshake.js";
export {
  CLIENTS,
  ALL_CLIENT_NAMES,
  resolveTargets,
} from "./clients.js";
export type { ClientName, ClientSpec } from "./clients.js";
export { writeMcpEntry } from "./config-writer.js";
export type { WriteResult } from "./config-writer.js";

import { consumeHandshake, redactUrl } from "./handshake.js";
import { resolveTargets } from "./clients.js";
import { writeMcpEntry, type WriteResult } from "./config-writer.js";

export interface InstallOptions {
  handshakeUrl: string;
  client?: string;
  forceOverwrite?: boolean;
  dryRun?: boolean;
  /** DEV/STAGING ONLY — additional MCP host the package will accept in the handshake response. */
  allowMcpHost?: string;
}

export interface InstallResult {
  payload: { mcpUrl: string; expiresAt: string };
  writes: WriteResult[];
  /** Clients that were targeted but skipped because their config path is null on this OS. */
  unsupportedTargets: string[];
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const payload = await consumeHandshake(opts.handshakeUrl, {
    allowMcpHost: opts.allowMcpHost,
  });
  const targets = resolveTargets(opts.client);
  if (targets.length === 0) {
    throw new Error(
      "no install targets resolved; check --client value or your OS",
    );
  }

  const writes: WriteResult[] = [];
  const unsupported: string[] = [];

  for (const target of targets) {
    const path = target.configPath();
    if (!path) {
      unsupported.push(target.name);
      continue;
    }
    const entry = target.buildServerEntry({
      mcpUrl: payload.mcpUrl,
      bearer: payload.token,
    });
    if (opts.dryRun) {
      writes.push({
        path,
        action: "created",
        prevServerExisted: false,
      });
      continue;
    }
    const result = writeMcpEntry(path, entry, {
      forceOverwrite: opts.forceOverwrite,
    });
    writes.push(result);
  }

  return {
    payload: { mcpUrl: payload.mcpUrl, expiresAt: payload.expiresAt },
    writes,
    unsupportedTargets: unsupported,
  };
}

// Helper kept private to the package — only the CLI prints, library
// consumers can format their own.
export { redactUrl };
