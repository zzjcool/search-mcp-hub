# search-mcp-hub

Coding agents' web search, extracted into standalone MCP tools.

One repo, one shared architecture, one npm package per provider:

| Package | Provider | How it works |
|---------|----------|--------------|
| [`cursor-search-mcp`](packages/cursor-search-mcp) | Cursor | Reverse-engineered `RunSSE` + `BidiAppend` protocol client — runs the real agent-loop server-side search, no `cursor-agent` binary. `login` / `status` / `search` CLI + 4 MCP tools. |
| [`codebuddy-search-mcp`](packages/codebuddy-search-mcp) | CodeBuddy (Tencent) | Direct HTTP API (`/agenttool/v1/search` + `/webfetch`), OAuth browser login, `pi mcp login`-ready HTTP serve mode. `login` / `status` / `search` / `fetch` / `serve` CLI + 3 MCP tools. |

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
# Cursor provider
npx cursor-search-mcp login          # one-time browser login
npx cursor-search-mcp search "mcp spec changes"

# CodeBuddy provider
npx codebuddy-search-mcp login
npx codebuddy-search-mcp search "mcp spec changes"
```

MCP config (pi / any stdio client):

```json
{
  "mcpServers": {
    "cursor-search":   { "type": "stdio", "command": "npx", "args": ["-y", "cursor-search-mcp"] },
    "codebuddy-search": { "type": "stdio", "command": "npx", "args": ["-y", "codebuddy-search-mcp"] }
  }
}
```

## Caveats

Both packages use **undocumented** provider APIs, reverse-engineered for research and personal automation. Protocols may change without notice; pin versions. Search quota counts against your own account. Respect each provider's terms of service.

## License

MIT
