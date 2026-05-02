/**
 * Atomic, idempotent merge of the Source MCP server entry into a
 * client's config file.
 *
 * Properties of the write:
 *   * Reads existing config if present; preserves all unrelated keys.
 *   * Replaces the "source" entry under mcpServers wholesale (so a
 *     re-run with a fresh token blows away the stale one).
 *   * Writes via temp file + rename (atomic on POSIX, near-atomic on
 *     Windows) so a crash mid-write never leaves a half-written
 *     mcpServers map.
 *   * If the parent directory doesn't exist, creates it (recursive
 *     mkdir). Most clients ship without their config file pre-created.
 *   * Handles legacy formats where mcpServers is missing entirely
 *     (writes a fresh map) and where the file is empty (initializes
 *     to {}).
 *
 * Refuses to write if:
 *   * The existing file isn't valid JSON (would silently destroy
 *     hand-edited content). User must fix or pass --force-overwrite.
 *   * The existing mcpServers value isn't an object.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const SERVER_KEY = "source";

export interface WriteResult {
  path: string;
  action: "created" | "updated" | "replaced";
  prevServerExisted: boolean;
  /** Path of a backup file written when --force-overwrite destroyed pre-existing content. */
  backupPath?: string;
}

export interface WriteOptions {
  forceOverwrite?: boolean;
  /** Override Date.now for tests (used in temp-file naming). */
  now?: () => number;
}

export function writeMcpEntry(
  configPath: string,
  serverEntry: Record<string, unknown>,
  opts: WriteOptions = {},
): WriteResult {
  const existed = existsSync(configPath);
  let parsed: Record<string, unknown>;
  let prevServerExisted = false;
  let backupPath: string | undefined;

  if (existed) {
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (err) {
      throw new Error(
        `couldn't read existing config at ${configPath}: ${describeErr(err)}`,
      );
    }
    if (raw.trim().length === 0) {
      parsed = {};
    } else {
      try {
        const cand = JSON.parse(raw);
        if (cand === null || typeof cand !== "object" || Array.isArray(cand)) {
          throw new Error("not a JSON object");
        }
        parsed = cand as Record<string, unknown>;
      } catch (err) {
        if (!opts.forceOverwrite) {
          throw new Error(
            `existing config at ${configPath} isn't valid JSON (${describeErr(err)}); fix the file or rerun with --force-overwrite (DESTROYS the current contents)`,
          );
        }
        // Red-team MED-4: even with --force-overwrite, write a backup
        // sibling first. Users sometimes don't realize their config has
        // JSON-with-comments (Claude Desktop / VS Code style); a single
        // mis-rerun would otherwise destroy unrelated MCP servers,
        // theme prefs, etc. with no recourse.
        const ts = (opts.now ? opts.now() : Date.now()).toString();
        backupPath = `${configPath}.bak.${ts}`;
        try {
          copyFileSync(configPath, backupPath);
        } catch (copyErr) {
          throw new Error(
            `--force-overwrite would destroy non-JSON content at ${configPath}, but pre-write backup to ${backupPath} failed: ${describeErr(copyErr)}. Refusing to overwrite without a backup.`,
          );
        }
        parsed = {};
      }
    }
  } else {
    parsed = {};
  }

  let mcpServers = parsed.mcpServers;
  if (mcpServers === undefined || mcpServers === null) {
    mcpServers = {};
  } else if (
    typeof mcpServers !== "object" ||
    Array.isArray(mcpServers)
  ) {
    if (!opts.forceOverwrite) {
      throw new Error(
        `existing mcpServers in ${configPath} is not an object — refusing to clobber. Fix manually or rerun with --force-overwrite.`,
      );
    }
    mcpServers = {};
  }
  const map = mcpServers as Record<string, unknown>;
  prevServerExisted = SERVER_KEY in map;
  map[SERVER_KEY] = serverEntry;
  parsed.mcpServers = map;

  const out = JSON.stringify(parsed, null, 2) + "\n";

  // Atomic rename pattern. Temp-file name includes Date.now + random
  // so multiple concurrent installs don't trample each other.
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const now = opts.now ? opts.now() : Date.now();
  const tmp = `${configPath}.tmp.${now}.${process.pid}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeSync(fd, out);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, configPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
    throw err;
  }

  return {
    path: configPath,
    action: existed ? (prevServerExisted ? "replaced" : "updated") : "created",
    prevServerExisted,
    backupPath,
  };
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
