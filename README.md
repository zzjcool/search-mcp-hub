# search-mcp-hub

Coding agents' web search, extracted into standalone MCP tools.

One repo, one shared architecture — a unified multi-provider package plus thin per-provider packages:

| Package | Providers | How it works |
|---------|-----------|--------------|
| [`search-mcp-hub`](packages/search-mcp-hub) | **Cursor + CodeBuddy in one server** | One MCP server, provider-routed tools: `web_search {searchTerm, provider?}` (per-call routing), `web_fetch`, `search_status`, `search_login`. CLI: `login <p>` / `use <p>` / `search <q> [-p p]` / `fetch` / `status`. Credentials inherited from the per-provider packages / CLIs. |
| [`cursor-search-mcp`](packages/cursor-search-mcp) | Cursor | Reverse-engineered `RunSSE` + `BidiAppend` protocol client — runs the real agent-loop server-side search, no `cursor-agent` binary. `login` / `status` / `search` CLI + 4 MCP tools. |
| [`codebuddy-search-mcp`](packages/codebuddy-search-mcp) | CodeBuddy (Tencent) | Direct HTTP API (`/agenttool/v1/search` + `/webfetch`), OAuth browser login, `pi mcp login`-ready HTTP serve mode. `login` / `status` / `search` / `fetch` / `serve` CLI + 3 MCP tools. |

**Start with `search-mcp-hub`** — it covers both providers behind one MCP config. The per-provider packages remain for minimal single-purpose setups.

## Why

Cursor and CodeBuddy both ship agent CLI binaries with built-in web search, but neither exposes the search as a standalone tool. Both were reverse-engineered (protocol- and behavior-verified against the shipped binaries) and re-implemented as zero-dependency Node.js MCP servers any client can use — pi, Claude Code, Cursor, anything that speaks MCP.

Key differences found during reverse engineering:

- **Cursor**: the search RPC is only invocable from inside a live agent-loop session (403 otherwise) → the client implements the full `RunSSE`/`BidiAppend` agent-loop protocol (KV blob ACKs, 5s heartbeats, tool approvals) so the server-side engine accepts it.
- **CodeBuddy**: search/fetch are plain authenticated HTTP APIs → direct calls, plus a full OAuth login flow (`auth/state` → browser → `auth/token` poll) cloned from the CLI.

## Shared architecture (aligned across packages)

- MCP **stdio** JSON-RPC 2024-11-05, zero npm dependencies (Node ≥ 18)
- **Login-aware `initialize` instructions** — the host's system prompt gets auth status (logged in / pending OAuth + URL / not logged in) at startup
- Identical CLI surface: `login` / `status` / one-shot action commands / `help`; no args → MCP stdio server
- Credentials: OAuth browser login (token cached locally, auto-refreshed) or API key fallback (env or `~/.<pkg>/key`)
- Startup auto-login: stdio servers start OAuth in the background and surface the URL via stderr + instructions when no credentials exist

## Roadmap

- [x] Single unified package `search-mcp-hub`: one MCP server exposing `search` / `fetch` with provider auto-routing (cursor + codebuddy + future providers), one shared login state
- [ ] More providers (Windsurf, Copilot CLI, …) — same pattern: reverse the search path, extract it, verify end-to-end

## Install

```bash
# Unified hub — recommended
npx search-mcp-hub login cursor         # one-time browser logins
npx search-mcp-hub login codebuddy
npx search-mcp-hub use cursor           # set default provider (optional)
npx search-mcp-hub search "mcp spec changes" -p codebuddy   # one-shot CLI

# Or the per-provider packages
npx cursor-search-mcp login
npx cursor-search-mcp search "mcp spec changes"
npx codebuddy-search-mcp login
npx codebuddy-search-mcp search "mcp spec changes"
```

MCP config (pi / any stdio client):

```json
{
  "mcpServers": {
    "search-hub": { "type": "stdio", "command": "npx", "args": ["-y", "search-mcp-hub"] }
  }
}
```

Or per-provider servers if you prefer them separate:

```json
{
  "mcpServers": {
    "cursor-search":   { "type": "stdio", "command": "npx", "args": ["-y", "cursor-search-mcp"] },
    "codebuddy-search": { "type": "stdio", "command": "npx", "args": ["-y", "codebuddy-search-mcp"] }
  }
}
```

Provider routing in the hub: per-call `provider` argument > `SEARCH_HUB_PROVIDER` env > persisted `search-mcp-hub use <p>` choice > auto (first logged-in provider).

## Caveats

Both packages use **undocumented** provider APIs, reverse-engineered for research and personal automation. Protocols may change without notice; pin versions. Search quota counts against your own account. Respect each provider's terms of service.

## License

MIT
