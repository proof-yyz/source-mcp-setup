import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpEntry } from "../src/config-writer.js";

function tmpdirHere(): string {
  return mkdtempSync(join(tmpdir(), "source-mcp-setup-"));
}

const ENTRY = {
  type: "http",
  url: "https://source.enrollhere.com/api/mcp",
  headers: { Authorization: "Bearer src_test" },
};

test("creates config file when none exists", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  const result = writeMcpEntry(path, ENTRY);
  assert.equal(result.action, "created");
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("preserves unrelated keys + other servers", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(
    path,
    JSON.stringify({
      theme: "dark",
      mcpServers: {
        github: { url: "https://gh.example.com" },
      },
    }),
  );
  const result = writeMcpEntry(path, ENTRY);
  assert.equal(result.action, "updated");
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(back.theme, "dark");
  assert.deepEqual(back.mcpServers.github, { url: "https://gh.example.com" });
  assert.deepEqual(back.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("replaces stale source entry on rerun", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        source: { url: "stale", headers: { Authorization: "Bearer src_old" } },
      },
    }),
  );
  const result = writeMcpEntry(path, ENTRY);
  assert.equal(result.action, "replaced");
  assert.equal(result.prevServerExisted, true);
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(back.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("creates parent dir when missing", () => {
  const dir = tmpdirHere();
  const path = join(dir, "nested", "deep", "claude.json");
  const result = writeMcpEntry(path, ENTRY);
  assert.equal(result.action, "created");
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(back.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses to clobber non-JSON config without --force-overwrite", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(path, "this is not json");
  assert.throws(
    () => writeMcpEntry(path, ENTRY),
    /isn't valid JSON/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("force-overwrite replaces non-JSON content + writes backup", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(path, "garbage with valuable comments");
  const result = writeMcpEntry(path, ENTRY, {
    forceOverwrite: true,
    now: () => 1234567890,
  });
  assert.equal(result.action, "updated");
  // Backup contains the pre-overwrite content.
  assert.ok(result.backupPath, "backupPath should be set");
  const backup = readFileSync(result.backupPath as string, "utf8");
  assert.equal(backup, "garbage with valuable comments");
  // Main file is the new JSON.
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(back.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("treats empty file as fresh config", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(path, "");
  const result = writeMcpEntry(path, ENTRY);
  assert.equal(result.action, "updated");
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(back.mcpServers.source, ENTRY);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses when mcpServers is non-object array", () => {
  const dir = tmpdirHere();
  const path = join(dir, "claude.json");
  writeFileSync(path, JSON.stringify({ mcpServers: ["bogus"] }));
  assert.throws(
    () => writeMcpEntry(path, ENTRY),
    /not an object — refusing to clobber/,
  );
  rmSync(dir, { recursive: true, force: true });
});
