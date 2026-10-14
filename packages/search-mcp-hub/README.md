# search-mcp-hub

One MCP server, multiple coding-agent search providers. Cursor and CodeBuddy web search, extracted from their CLIs into pure protocol clients — no agent binaries, zero npm dependencies (Node ≥ 18).

## Tools

| Tool | What it does |
|------|--------------|
| `web_search {searchTerm, provider?, maxResults?, ...}` | Web search. `provider`: `"cursor"` (synthesized answer + sources) or `"codebuddy"` (fast link results, CN-friendly, domain/freshness filters). Omit → configured default. |
| `web_fetch {url, maxLength?}` | Fetch a page as markdown (CodeBuddy server-side extraction). |
| `search_status {provider?}` | Login state of one or all providers. |
| `search_login {provider, trigger_browser_login?, wait?}` | Login management / browser OAuth. |

## Providers

| Provider | Search path | Auth |
|----------|-------------|------|
| `cursor` | Reverse-engineered agent-loop protocol (`RunSSE` + `BidiAppend`, KV blob ACKs, heartbeats) — runs the real server-side search, returns a synthesized answer with sources | API key (`CURSOR_API_KEY` or `~/.cursor-search-mcp/key`) or browser OAuth (PKCE device flow) |
| `codebuddy` | Direct HTTP API (`/agenttool/v1/search` + `/webfetch`), ~2s | Browser OAuth (writes the CodeBuddy CLI's own auth file — `codebuddy login` equivalent, auto-refresh 7-day window) or API key (`CODEBUDDY_API_KEY` or `~/.codebuddy-search-mcp/key`) |

Credentials are **inherited** from the standalone packages / CLIs — if you already ran `cursor-search-mcp login` or `codebuddy login`, you are logged in here too.

## Install

```bash
# MCP config (pi / any stdio client)
{
  "mcpServers": {
    "search-hub": { "type": "stdio", "command": "npx", "args": ["-y", "search-mcp-hub"] }
  }
}

# One-time logins
npx search-mcp-hub login cursor
npx search-mcp-hub login codebuddy

# Default provider (persisted to ~/.search-mcp-hub/provider)
npx search-mcp-hub use cursor

# CLI one-shots
npx search-mcp-hub search "mcp spec 2026 changes" -p cursor
npx search-mcp-hub fetch https://example.com
npx search-mcp-hub status
```

Provider routing order: per-call `provider` argument > `SEARCH_HUB_PROVIDER` env > persisted `use` choice > auto (first logged-in provider).

## CLI

```
search-mcp-hub                             MCP stdio server (no args)
search-mcp-hub login <cursor|codebuddy>   Browser OAuth login
search-mcp-hub status [provider]          Login state
search-mcp-hub use <cursor|codebuddy>     Set default provider
search-mcp-hub search <q> [-p provider]   One-shot search
search-mcp-hub fetch <url>                One-shot fetch
search-mcp-hub help
```

## Caveats

Uses **undocumented** provider APIs, reverse-engineered for research and personal automation. Protocols may change without notice; pin versions. Quota counts against your own accounts. Respect each provider's terms of service.

## Related

The per-provider packages live on as thin, standalone alternatives: [`cursor-search-mcp`](../cursor-search-mcp), [`codebuddy-search-mcp`](../codebuddy-search-mcp).

## License

MIT
