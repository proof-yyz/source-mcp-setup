#!/usr/bin/env node

/**
 * CLI entrypoint for @proof-yyz/source-mcp-setup.
 *
 * Usage:
 *   npx @proof-yyz/source-mcp-setup <handshake-url>
 *   npx @proof-yyz/source-mcp-setup --handshake=<handshake-url>
 *   npx @proof-yyz/source-mcp-setup <url> --client=claude-desktop
 *   npx @proof-yyz/source-mcp-setup <url> --client=claude-code,cursor
 *   npx @proof-yyz/source-mcp-setup <url> --dry-run
 *
 * The handshake URL is one-shot, 60-second TTL. The first successful
 * fetch consumes it; the next call to the same URL returns 410.
 */

import { install, redactUrl } from "./index.js";
import { ALL_CLIENT_NAMES } from "./clients.js";
import { HandshakeExpiredError } from "./handshake.js";

interface ParsedArgs {
  handshake: string | null;
  client?: string;
  allowMcpHost?: string;
  dryRun: boolean;
  forceOverwrite: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    handshake: null,
    dryRun: false,
    forceOverwrite: false,
    help: false,
    version: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }
    if (a === "--version" || a === "-v") {
      args.version = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--force-overwrite") {
      args.forceOverwrite = true;
      continue;
    }
    if (a.startsWith("--handshake=")) {
      args.handshake = a.slice("--handshake=".length);
      continue;
    }
    if (a.startsWith("--client=")) {
      args.client = a.slice("--client=".length);
      continue;
    }
    if (a.startsWith("--mcp-host-override=")) {
      args.allowMcpHost = a.slice("--mcp-host-override=".length);
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    }
    // Positional handshake URL.
    if (args.handshake) {
      throw new Error("multiple handshake URLs supplied — pass exactly one");
    }
    args.handshake = a;
  }
  return args;
}

const HELP = `\
@proof-yyz/source-mcp-setup — wire Source's MCP server into Claude Desktop / Claude Code / Cursor.

Usage:
  npx @proof-yyz/source-mcp-setup <handshake-url> [flags]

Flags:
  --client=<name>      Comma-separated subset of: ${ALL_CLIENT_NAMES.join(", ")}, all (default: all)
  --mcp-host-override=<host>   Accept this host in the handshake mcp_url (DEV/STAGING ONLY)
  --dry-run            Plan the writes; don't touch any config file
  --force-overwrite    Replace an existing-but-non-JSON config (DESTRUCTIVE)
  -h, --help           Print this help
  -v, --version        Print package version

The handshake URL is generated from /me/api-tokens at the Source portal.
It's one-shot and expires 60 seconds after issuance.
`;

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`✗ ${describeErr(err)}\n\n${HELP}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (!args.handshake) {
    process.stderr.write(
      "✗ no handshake URL supplied. Generate one from /me/api-tokens at Source.\n\n" +
        HELP,
    );
    process.exit(2);
  }

  try {
    if (args.allowMcpHost) {
      process.stderr.write(
        `⚠ --mcp-host-override=${args.allowMcpHost} bypasses production-host pinning. Use only for DEV/STAGING.\n`,
      );
    }
    const result = await install({
      handshakeUrl: args.handshake,
      client: args.client,
      dryRun: args.dryRun,
      forceOverwrite: args.forceOverwrite,
      allowMcpHost: args.allowMcpHost,
    });

    process.stdout.write(
      `✓ Source MCP server: ${result.payload.mcpUrl}\n` +
        `  Token expires ${result.payload.expiresAt}\n\n`,
    );
    for (const w of result.writes) {
      const verb = args.dryRun ? `would ${w.action}` : w.action;
      process.stdout.write(`  ✓ ${verb}: ${w.path}\n`);
      if (w.backupPath) {
        process.stdout.write(`    backed up prior content → ${w.backupPath}\n`);
      }
    }
    if (result.unsupportedTargets.length > 0) {
      process.stdout.write(
        `\n  ⚠ skipped (unsupported on this OS): ${result.unsupportedTargets.join(", ")}\n`,
      );
    }
    process.stdout.write(
      args.dryRun
        ? "\n(dry run — no files changed)\n"
        : "\nRestart your client(s) for changes to take effect.\n",
    );
  } catch (err) {
    if (err instanceof HandshakeExpiredError) {
      process.stderr.write(`✗ ${err.message}\n`);
      process.exit(3);
    }
    // Defensive: never echo the handshake URL to stderr — the id is a
    // bearer secret during its 60s window.
    const url = args.handshake ?? "";
    let msg = describeErr(err);
    if (url) msg = msg.split(url).join(redactUrl(url));
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  }
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((err) => {
  process.stderr.write(
    `✗ unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
