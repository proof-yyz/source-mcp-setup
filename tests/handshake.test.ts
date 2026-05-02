import { test } from "node:test";
import assert from "node:assert";
import {
  consumeHandshake,
  isPlausibleHandshakeUrl,
  HandshakeExpiredError,
  redactUrl,
} from "../src/handshake.js";

// Real Source token: "src_" + 27 base58 chars. Base58 = base64 minus
// 0/O/I/l. Use real-shape input so we exercise the actual validator,
// not an approximation (red-team CRIT-1 root cause: synthetic 40-char
// tokens passed the old regex but real 27-char tokens didn't).
const VALID_TOKEN = "src_AbCDeFgHiJKLMNoPqRSTUVWXyzm";
const VALID_ID = "a".repeat(43);
const VALID_URL = `https://source.enrollhere.com/api/v1/mcp/handshake/${VALID_ID}`;

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
}

test("isPlausibleHandshakeUrl accepts valid https + dev http URLs", () => {
  assert.ok(isPlausibleHandshakeUrl(VALID_URL));
  assert.ok(
    isPlausibleHandshakeUrl(
      `http://localhost:3000/api/v1/mcp/handshake/${VALID_ID}`,
    ),
  );
  assert.ok(
    isPlausibleHandshakeUrl(
      `http://127.0.0.1/api/v1/mcp/handshake/${VALID_ID}`,
    ),
  );
});

test("isPlausibleHandshakeUrl rejects non-https remote URLs", () => {
  assert.ok(
    !isPlausibleHandshakeUrl(
      `http://example.com/api/v1/mcp/handshake/${VALID_ID}`,
    ),
  );
});

test("isPlausibleHandshakeUrl rejects malformed paths + ids", () => {
  assert.ok(
    !isPlausibleHandshakeUrl("https://source.enrollhere.com/api/v1/mcp"),
  );
  assert.ok(
    !isPlausibleHandshakeUrl(
      `https://source.enrollhere.com/api/v1/mcp/handshake/short`,
    ),
  );
  assert.ok(
    !isPlausibleHandshakeUrl(
      `https://source.enrollhere.com/api/v1/mcp/handshake/${"a".repeat(28)}!`,
    ),
  );
});

test("consumeHandshake returns parsed payload on 200", async () => {
  const out = await consumeHandshake(VALID_URL, {
    fetchImpl: mockFetch(200, {
      token: VALID_TOKEN,
      scheme: "Bearer",
      mcp_url: "https://source.enrollhere.com/api/mcp",
      expires_at: "2026-08-01T00:00:00Z",
    }),
  });
  assert.equal(out.token, VALID_TOKEN);
  assert.equal(out.scheme, "Bearer");
  assert.equal(out.mcpUrl, "https://source.enrollhere.com/api/mcp");
});

test("consumeHandshake throws HandshakeExpiredError on 410", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(410, { error: "handshake_unknown_or_used" }),
    }),
    HandshakeExpiredError,
  );
});

test("consumeHandshake rejects token with wrong shape", async () => {
  // Wrong prefix.
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: "wrong_AbCDeFgHiJKLMNoPqRSTUVWXyzm",
        scheme: "Bearer",
        mcp_url: "https://source.enrollhere.com/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /token missing src_ prefix/,
  );
  // Wrong length.
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: "src_short",
        scheme: "Bearer",
        mcp_url: "https://source.enrollhere.com/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /token wrong length/,
  );
  // Non-base58 character (uppercase O is excluded from base58).
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: "src_OOOOOOOOOOOOOOOOOOOOOOOOOOO",
        scheme: "Bearer",
        mcp_url: "https://source.enrollhere.com/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /non-base58 character/,
  );
});

test("consumeHandshake rejects mcp_url for non-allowlisted host", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: VALID_TOKEN,
        scheme: "Bearer",
        mcp_url: "https://attacker.test/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /not in the allowlist/,
  );
});

test("consumeHandshake accepts mcp_url with --mcp-host-override matching", async () => {
  const out = await consumeHandshake(VALID_URL, {
    fetchImpl: mockFetch(200, {
      token: VALID_TOKEN,
      scheme: "Bearer",
      mcp_url: "https://staging.enrollhere.com/api/mcp",
      expires_at: "2026-08-01T00:00:00Z",
    }),
    allowMcpHost: "staging.enrollhere.com",
  });
  assert.equal(out.mcpUrl, "https://staging.enrollhere.com/api/mcp");
});

test("consumeHandshake rejects --mcp-host-override pointing at a different host than the response", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: VALID_TOKEN,
        scheme: "Bearer",
        mcp_url: "https://attacker.test/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
      allowMcpHost: "staging.enrollhere.com",
    }),
    /not in the allowlist/,
  );
});

test("consumeHandshake rejects http mcp_url for non-localhost", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: VALID_TOKEN,
        scheme: "Bearer",
        mcp_url: "http://attacker.example.com/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /mcp_url must be https/,
  );
});

test("consumeHandshake rejects body too large via content-length header", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(
        200,
        {
          token: VALID_TOKEN,
          scheme: "Bearer",
          mcp_url: "https://source.enrollhere.com/api/mcp",
          expires_at: "2026-08-01T00:00:00Z",
        },
        { "content-length": "999999" },
      ),
    }),
    /response too large/,
  );
});

test("consumeHandshake rejects unexpected scheme", async () => {
  await assert.rejects(
    consumeHandshake(VALID_URL, {
      fetchImpl: mockFetch(200, {
        token: VALID_TOKEN,
        scheme: "Basic",
        mcp_url: "https://source.enrollhere.com/api/mcp",
        expires_at: "2026-08-01T00:00:00Z",
      }),
    }),
    /unexpected scheme/,
  );
});

test("redactUrl strips the handshake id", () => {
  assert.equal(
    redactUrl(VALID_URL),
    "https://source.enrollhere.com/api/v1/mcp/handshake/<redacted>",
  );
});

test("redactUrl strips trailing query strings + fragments too", () => {
  assert.equal(
    redactUrl(`${VALID_URL}?leak=${VALID_ID}`),
    "https://source.enrollhere.com/api/v1/mcp/handshake/<redacted>",
  );
  assert.equal(
    redactUrl(`${VALID_URL}#${VALID_ID}`),
    "https://source.enrollhere.com/api/v1/mcp/handshake/<redacted>",
  );
});

test("consumeHandshake refuses to fetch an obviously-bad URL shape", async () => {
  let called = false;
  const bogus = "https://attacker.test/foo/bar";
  await assert.rejects(
    consumeHandshake(bogus, {
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    }),
    /doesn't match expected shape/,
  );
  assert.equal(called, false, "fetch should not be invoked for bad URLs");
});
