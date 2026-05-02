# @enrollhere/source-mcp-setup

One-shot installer for **Source** — EnrollHere's internal docs MCP server — into Claude Desktop, Claude Code, and Cursor. The plain bearer token is fetched directly from Source over a single-use, 60-second handshake URL and written into the appropriate client config file. The token never touches your OS clipboard.

## Usage

Generate an install command from `/me/api-tokens` on the Source portal, then run:

```bash
npx @enrollhere/source-mcp-setup https://source.enrollhere.com/api/v1/mcp/handshake/<id>
```

By default this targets every supported client. To target a subset:

```bash
npx @enrollhere/source-mcp-setup <handshake-url> --client=claude-desktop
npx @enrollhere/source-mcp-setup <handshake-url> --client=claude-code,cursor
```

To preview without writing:

```bash
npx @enrollhere/source-mcp-setup <handshake-url> --dry-run
```

Restart your client(s) after the writes complete.

### Supported clients + paths

| Client | Path |
| --- | --- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |

The installer **preserves** existing `mcpServers` entries — only the `source` key is replaced. Other client config keys (theme, settings, etc.) are untouched.

## Security model

- The handshake URL is **one-shot**. The first successful fetch consumes it; the next call to the same URL returns 410.
- The handshake expires **60 seconds** after issuance. Stale URLs always return 410.
- The plain token never appears on stdout, in process titles, or in shell history.
- The CLI writes the config file via temp-file + atomic rename so a crash mid-write never leaves a half-written `mcpServers` map.

If something goes wrong (network blip during fetch, write permission error), generate a fresh install command from `/me/api-tokens` — the old token is still valid; only the handshake URL is dead.

## Contributor docs

### Build + test

```bash
npm install
npm run lint    # tsc --noEmit
npm test        # node --test
npm run build   # tsc -p tsconfig.json → dist/
```

Tests run on Node 18, 20, 22 against ubuntu / macOS / windows in CI (`.github/workflows/ci.yml`).

### Publish

Publication is automated via `.github/workflows/publish.yml`. It fires on a pushed tag matching `v*.*.*`:

```bash
npm version patch          # bumps package.json + creates a tag
git push --follow-tags
```

The workflow:

1. Runs `npm ci`, `npm run lint`, `npm test`, `npm run build`.
2. Runs `npm pack --dry-run` and refuses to publish if `src/` or `tests/` would ship.
3. Runs `npm publish --provenance --access public`. Provenance ties the artifact to this exact commit via Sigstore.
4. Runs `npm audit signatures` against the freshly published package. Job fails if the attestation doesn't verify.

### Required secrets

`NPM_TOKEN` — npm automation token with publish permission on `@enrollhere`. Set in repo settings → secrets → actions.

### First-publish prerequisites (one-time)

- Claim the `@enrollhere` scope on npm (`npm org create enrollhere`) and add publish permissions for the GitHub Actions identity.
- In the npm scope settings, enable provenance for this package's name.
- Generate `NPM_TOKEN` with the `automation` permission and add to GitHub Actions secrets.
- **Configure the `npm-publish` environment** in GitHub repo settings → Environments → New → "npm-publish" → add Vlad as a required reviewer. The publish workflow declares `environment: npm-publish`, which means every tag-triggered publish pauses for explicit Vlad approval before any `secrets.NPM_TOKEN`-using step runs. Without this gate, anyone with push access can ship a version.

After the first publish, `npm audit signatures @enrollhere/source-mcp-setup` from any machine confirms the attestation chain.

## License

MIT — see `LICENSE`.
