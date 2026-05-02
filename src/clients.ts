/**
 * Target-client detection + config-file paths.
 *
 * Each entry knows where the client expects its MCP config JSON, plus
 * how to render the per-server entry. Source's MCP server speaks
 * HTTP, but Claude Desktop / Claude Code / Cursor's local-config
 * parser rejects the `{type: "http", url, headers}` shape on many
 * builds (verified empirically 2026-05-02 — Claude Desktop logs
 * "Skipped invalid MCP server config entries"). The compatible-
 * everywhere shape uses `mcp-remote` as a stdio→HTTP bridge:
 *
 *   {
 *     "command": "npx",
 *     "args": ["-y", "mcp-remote", "<URL>", "--header", "Authorization: Bearer <TOKEN>"]
 *   }
 *
 * `mcp-remote` is a small published proxy that exposes any HTTP MCP
 * server as a stdio MCP server. It runs as a subprocess of Claude
 * Desktop / Code / Cursor, forwards JSON-RPC over HTTPS, returns
 * responses on stdout. Same security model — bearer is in args (not
 * env / clipboard / network log), CLI's host pinning has already
 * verified the URL is legitimate before this config gets written.
 *
 * Adding a client: append to CLIENTS. Adding a per-OS path variant:
 * extend the paths function. The CLI's --client flag matches by name.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export type ClientName = "claude-desktop" | "claude-code" | "cursor";

export interface ClientSpec {
  name: ClientName;
  /** Human-readable label for output. */
  label: string;
  /** Returns the absolute config path on the current OS, or null if unsupported. */
  configPath(): string | null;
  /**
   * Builds the per-server entry for this client. Source's MCP server
   * speaks HTTP, so the shape is { type: 'http', url, headers }.
   * Different clients accept slightly different keys — capture per-
   * client variation here, NOT in the writer.
   */
  buildServerEntry(args: {
    mcpUrl: string;
    bearer: string;
  }): Record<string, unknown>;
}

function homeJoin(...segments: string[]): string {
  return join(homedir(), ...segments);
}

/**
 * Stdio-bridge entry. All three clients accept this shape because it
 * runs `mcp-remote` as a stdio subprocess — universally supported.
 */
function stdioBridgeEntry(args: {
  mcpUrl: string;
  bearer: string;
}): Record<string, unknown> {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      args.mcpUrl,
      "--header",
      `Authorization: Bearer ${args.bearer}`,
    ],
  };
}

export const CLIENTS: Record<ClientName, ClientSpec> = {
  "claude-desktop": {
    name: "claude-desktop",
    label: "Claude Desktop",
    configPath() {
      switch (platform()) {
        case "darwin":
          return homeJoin(
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
          );
        case "win32":
          // %APPDATA% on Windows; Node sets process.env.APPDATA
          return process.env.APPDATA
            ? join(
                process.env.APPDATA,
                "Claude",
                "claude_desktop_config.json",
              )
            : null;
        case "linux":
          return homeJoin(
            ".config",
            "Claude",
            "claude_desktop_config.json",
          );
        default:
          return null;
      }
    },
    buildServerEntry: stdioBridgeEntry,
  },

  "claude-code": {
    name: "claude-code",
    label: "Claude Code",
    configPath() {
      // Claude Code uses ~/.claude.json on all platforms (per official
      // docs). Both stdio and http MCP servers live under "mcpServers".
      return homeJoin(".claude.json");
    },
    buildServerEntry: stdioBridgeEntry,
  },

  cursor: {
    name: "cursor",
    label: "Cursor",
    configPath() {
      // Cursor's per-user MCP config (project-level lives at
      // .cursor/mcp.json next to the workspace, but per-user is what
      // a CSM doing onboarding wants).
      return homeJoin(".cursor", "mcp.json");
    },
    buildServerEntry: stdioBridgeEntry,
  },
};

export const ALL_CLIENT_NAMES: ClientName[] = Object.keys(
  CLIENTS,
) as ClientName[];

/**
 * Resolve the user-supplied --client flag to one or more ClientSpecs.
 *   * "all" / undefined → every client whose configPath() is non-null
 *   * Single name → that one
 *   * Comma-separated list → those
 * Throws on unknown names.
 */
export function resolveTargets(input: string | undefined): ClientSpec[] {
  if (!input || input === "all") {
    return ALL_CLIENT_NAMES.map((n) => CLIENTS[n]).filter(
      (c) => c.configPath() !== null,
    );
  }
  const names = input.split(",").map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    if (!isClientName(n)) {
      throw new Error(
        `unknown --client value "${n}"; supported: ${ALL_CLIENT_NAMES.join(", ")}, all`,
      );
    }
    return CLIENTS[n];
  });
}

function isClientName(s: string): s is ClientName {
  return (ALL_CLIENT_NAMES as string[]).includes(s);
}
