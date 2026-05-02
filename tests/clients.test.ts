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

test("buildServerEntry produces http + Bearer headers for all clients", () => {
  for (const name of ALL_CLIENT_NAMES) {
    const entry = CLIENTS[name].buildServerEntry({
      mcpUrl: "https://source.example/api/mcp",
      bearer: "src_test",
    });
    const e = entry as Record<string, unknown>;
    assert.equal(e.url, "https://source.example/api/mcp");
    const headers = e.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer src_test");
  }
});
