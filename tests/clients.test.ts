import { test } from "node:test";
import assert from "node:assert";
import { resolveTargets, ALL_CLIENT_NAMES, CLIENTS } from "../src/clients.js";

test("resolveTargets defaults to all known clients on undefined input", () => {
  const all = resolveTargets(undefined);
  assert.ok(all.length > 0);
  for (const t of all) {
    assert.ok(ALL_CLIENT_NAMES.includes(t.name));
  }
});

test("resolveTargets accepts a single name", () => {
  const list = resolveTargets("claude-desktop");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "claude-desktop");
});

test("resolveTargets accepts comma-separated names", () => {
  const list = resolveTargets("claude-desktop,cursor");
  assert.equal(list.length, 2);
  const names = list.map((c) => c.name).sort();
  assert.deepEqual(names, ["claude-desktop", "cursor"]);
});

test("resolveTargets throws on unknown name", () => {
  assert.throws(
    () => resolveTargets("notepad"),
    /unknown --client value/,
  );
});

test("buildServerEntry produces stdio bridge config (npx mcp-remote ...) for all clients", () => {
  for (const name of ALL_CLIENT_NAMES) {
    const entry = CLIENTS[name].buildServerEntry({
      mcpUrl: "https://source.example/api/mcp",
      bearer: "src_test",
    });
    const e = entry as Record<string, unknown>;
    assert.equal(e.command, "npx");
    const args = e.args as string[];
    assert.deepEqual(args, [
      "-y",
      "mcp-remote",
      "https://source.example/api/mcp",
      "--header",
      "Authorization: Bearer src_test",
    ]);
  }
});

test("buildServerEntry never embeds the bearer outside args (no headers/env keys leak)", () => {
  // Defense-in-depth: if a future shape regression adds the bearer to
  // an env/headers key, this test catches it. The token is only
  // legitimate inside args[4].
  for (const name of ALL_CLIENT_NAMES) {
    const entry = CLIENTS[name].buildServerEntry({
      mcpUrl: "https://source.example/api/mcp",
      bearer: "src_secret_xyz",
    });
    const e = entry as Record<string, unknown>;
    assert.equal(
      e.headers,
      undefined,
      `${name} should not have a headers key`,
    );
    assert.equal(e.env, undefined, `${name} should not have an env key`);
    assert.equal(e.url, undefined, `${name} should not have a url key`);
  }
});
