#!/usr/bin/env node
/**
 * search-mcp-hub — one MCP server, multiple search providers.
 *
 * Providers are selected per call (tool argument `provider`) or globally
 * (env SEARCH_HUB_PROVIDER / config file ~/.search-mcp-hub/provider):
 *
 *   cursor    Cursor agent-loop search (RunSSE/BidiAppend protocol client) — synthesized answers
 *   codebuddy Tencent CodeBuddy agenttool search + webfetch — fast, CN-friendly, link results
 *
 * MCP tools:
 *   web_search     {searchTerm, provider?, maxResults?, ...codebuddy-only filters}
 *   web_fetch      {url, maxLength?}                       (codebuddy only)
 *   search_status   {provider?}                             login state of one or all providers
 *   search_login   {provider, trigger_browser_login?}       login state report or browser login
 *
 * CLI (mirrors the per-provider packages):
 *   search-mcp-hub login <cursor|codebuddy>     browser OAuth login
 *   search-mcp-hub status [provider]            login state (all providers by default)
 *   search-mcp-hub search <q> [--provider p]    one-shot search
 *   search-mcp-hub fetch <url>                 one-shot fetch (codebuddy)
 *   search-mcp-hub use <cursor|codebuddy>      set the default provider (persisted)
 *   search-mcp-hub help
 *
 * (no args → MCP stdio server)
 *
 * Zero npm dependencies. Node.js >= 18.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cursor = require("./providers/cursor.js");
const codebuddy = require("./providers/codebuddy.js");

const HUB_DIR = process.env.SEARCH_HUB_STATE_DIR || path.join(os.homedir(), ".search-mcp-hub");
const PROVIDER_FILE = path.join(HUB_DIR, "provider");
const VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch {
    return "1.0.0";
  }
})();

const PROVIDERS = { cursor, codebuddy };

/* ---------------- provider routing ---------------- */

function validProvider(name) {
  return name === "cursor" || name === "codebuddy";
}

/** Default provider: SEARCH_HUB_PROVIDER env > persisted choice > auto (first logged in). */
function defaultProvider() {
  const env = process.env.SEARCH_HUB_PROVIDER;
  if (validProvider(env)) return env;
  try {
    const saved = fs.readFileSync(PROVIDER_FILE, "utf8").trim();
    if (validProvider(saved)) return saved;
  } catch {}
  // Auto: prefer a provider that is already logged in
  for (const name of ["cursor", "codebuddy"]) {
    const s = PROVIDERS[name].authStatus();
    if (s.state === "ok" || s.state === "api-key" || s.state === "refreshable") return name;
  }
  return "cursor";
}

function resolveProvider(requested) {
  const name = validProvider(requested) ? requested : defaultProvider();
  return { name, mod: PROVIDERS[name] };
}

function saveDefaultProvider(name) {
  if (!validProvider(name)) throw new Error(`unknown provider: ${name} (cursor|codebuddy)`);
  fs.mkdirSync(HUB_DIR, { recursive: true });
  fs.writeFileSync(PROVIDER_FILE, name);
  return name;
}

/* ---------------- tool implementations ---------------- */

async function toolSearch(args = {}) {
  const { name, mod } = resolveProvider(args.provider);
  const r = await mod.search(args);
  return { ...r, provider_used: name, ...(name !== defaultProvider() ? { default_provider: defaultProvider() } : {}) };
}

async function toolFetch(args = {}) {
  // fetch is codebuddy-only; if another provider is requested explicitly, say so
  if (args.provider && args.provider !== "codebuddy") {
    throw new Error(`provider "${args.provider}" does not support web_fetch — use codebuddy`);
  }
  return { ...(await codebuddy.fetchPage(args)), provider_used: "codebuddy" };
}

/** Login state of one or all providers. Optionally trigger browser login. */
async function toolLogin(args = {}) {
  if (args.trigger_browser_login || args.login) {
    const { name, mod } = resolveProvider(args.provider);
    if (name === "codebuddy") {
      const r = await codebuddy.browserLogin();
      return { ok: true, provider: name, logged_in: true, account: r.account, login_url: r.authUrl };
    }
    // cursor: start login, return URL for the host/agent to open, then call search_login again with wait
    const { uuid, loginUrl, expiresInMin } = cursor.startLogin();
    pendingCursorLogin = { uuid, expiresAt: Date.now() + expiresInMin * 60_000 };
    return {
      ok: true,
      provider: "cursor",
      login_url: loginUrl,
      instructions: `Open login_url in a browser (valid ${expiresInMin} min), then call search_login again with {provider:"cursor", wait:true}.`,
    };
  }
  if (args.wait && args.provider === "cursor") {
    if (!pendingCursorLogin) throw new Error("no pending cursor login — call search_login with trigger_browser_login first");
    await cursor.waitLogin(pendingCursorLogin.uuid, args.timeoutMs || 15 * 60_000);
    pendingCursorLogin = null;
    return { ok: true, provider: "cursor", logged_in: true };
  }
  // default: report status for one or all providers
  const names = validProvider(args.provider) ? [args.provider] : ["cursor", "codebuddy"];
  const report = { default_provider: defaultProvider() };
  for (const n of names) report[n] = PROVIDERS[n].authStatus();
  return report;
}

let pendingCursorLogin = null;

async function toolStatus(args = {}) {
  const names = validProvider(args.provider) ? [args.provider] : ["cursor", "codebuddy"];
  const report = { default_provider: defaultProvider() };
  for (const n of names) report[n] = PROVIDERS[n].authStatus();
  return report;
}

/* ---------------- MCP stdio protocol ---------------- */

const TOOLS = [
  {
    name: "web_search",
    description:
      "Web search. provider: \"cursor\" (synthesized answer + sources, best for research questions) " +
      'or "codebuddy" (fast link results, CN-friendly, supports freshness/domain filters). ' +
      "Omit provider to use the configured default.",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "Search query / question" },
        provider: { type: "string", enum: ["cursor", "codebuddy"], description: "Search provider (default: configured)" },
        maxResults: { type: "number", description: "Result/link limit (default 5)" },
        // codebuddy-only extras (ignored by cursor)
        allowedDomains: { type: "array", items: { type: "string" }, description: "codebuddy only: restrict to these domains" },
        blockedDomains: { type: "array", items: { type: "string" }, description: "codebuddy only: exclude these domains" },
        freshness: { type: "string", description: 'codebuddy only: "d"/"d1".."d30"/"m"/"m1".."m12"/"y"/"y1".."y5"' },
      },
      required: ["searchTerm"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page as markdown (CodeBuddy server-side extraction). Good after web_search for full text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL" },
        maxLength: { type: "number", description: "Max content length (default 4000)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "search_status",
    description: "Report login state of all providers (or one) and the configured default provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["cursor", "codebuddy"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_login",
    description:
      "Login management. Default: report login states. {provider, trigger_browser_login:true}: start browser OAuth " +
      '(codebuddy completes in one call; cursor returns login_url and needs a second call with {provider:"cursor", wait:true}).',
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["cursor", "codebuddy"], description: "Which provider (default: all, for reports)" },
        trigger_browser_login: { type: "boolean", description: "Start browser OAuth login" },
        wait: { type: "boolean", description: "Wait for a pending cursor login to complete" },
        timeoutMs: { type: "number", description: "Wait timeout in ms (default 900000)" },
      },
      additionalProperties: false,
    },
  },
];

function rpcSend(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let chain = Promise.resolve();

async function handleCall(name, args) {
  if (name === "web_search") return await toolSearch(args);
  if (name === "web_fetch") return await toolFetch(args);
  if (name === "search_status") return await toolStatus(args);
  if (name === "search_login") return await toolLogin(args);
  throw new Error(`unknown tool: ${name}`);
}

/** Login-aware initialize instructions: per-provider status + how to log in. */
function buildInstructions() {
  const parts = [];
  for (const n of ["cursor", "codebuddy"]) {
    const s = PROVIDERS[n].authStatus();
    let line;
    if (s.state === "ok" || s.state === "api-key") line = "✓ logged in";
    else if (s.state === "refreshable") line = `✓ logged in (${s.account}, auto-refresh)`;
    else if (s.state === "expired") line = `⚠ expired (re-login: search_login {provider:"${n}", trigger_browser_login:true})`;
    else line = `⚠ not logged in (search_login {provider:"${n}", trigger_browser_login:true})`;
    parts.push(`${n}: ${line}`);
  }
  return (
    "Multi-provider web search. Tools: web_search {searchTerm, provider?}, web_fetch {url} (codebuddy), " +
    "search_status, search_login. Auth: " +
    parts.join(" | ") +
    `. Default provider: ${defaultProvider()} (per-call "provider" argument overrides; CLI: search-mcp-hub use <p>).`
  );
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRpc(msg).catch((e) => {
      if (msg.id !== undefined) {
        rpcSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      }
    });
  }
});

async function handleRpc(msg) {
  if (msg.method === "initialize") {
    return rpcSend({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "search-mcp-hub", version: VERSION },
        instructions: buildInstructions(),
      },
    });
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return rpcSend({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params || {};
    const task = chain.then(
      () => handleCall(name, args),
      () => handleCall(name, args)
    );
    chain = task.catch(() => {});
    let result;
    try {
      result = await task;
      rpcSend({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] },
      });
    } catch (e) {
      rpcSend({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true },
      });
    }
    return;
  }
  if (msg.id !== undefined) {
    return rpcSend({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  }
}

/* ---------------- CLI ---------------- */

async function cliMain(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === "login") {
    const p = rest[0];
    if (!validProvider(p)) {
      console.error("usage: search-mcp-hub login <cursor|codebuddy>");
      if (p === "status" || !p) console.error("(login state is a separate command: search-mcp-hub status)");
      process.exit(1);
    }
    if (p === "codebuddy") {
      console.log("Starting CodeBuddy OAuth login…");
      const r = await codebuddy.browserLogin({
        onAuthUrl: (url) => {
          console.log(`Login URL: ${url}`);
          console.log("(browser opened automatically; copy the URL above if it did not)");
        },
      });
      console.log(`\n✓ Logged in as ${r.account}`);
      process.exit(0);
    }
    // cursor
    const { uuid, loginUrl, expiresInMin } = cursor.startLogin();
    console.log(`\nOpen this URL in a browser to sign in to Cursor (valid for ${expiresInMin} min):\n`);
    console.log(`  ${loginUrl}\n`);
    console.log("Waiting for authorization… (Ctrl+C to cancel)\n");
    try {
      await cursor.waitLogin(uuid, 15 * 60_000);
      console.log(`\n✓ Logged in. Token cached at ${path.join(cursor.STATE_DIR, "auth.json")}`);
      process.exit(0);
    } catch (e) {
      console.error(`\n✗ ${e.message}`);
      process.exit(1);
    }
  }

  if (cmd === "status") {
    const p = rest[0];
    const names = validProvider(p) ? [p] : ["cursor", "codebuddy"];
    console.log(`Default provider: ${defaultProvider()}`);
    for (const n of names) {
      const s = PROVIDERS[n].authStatus();
      if (s.state === "ok") console.log(`  ${n}: logged in`);
      else if (s.state === "api-key") console.log(`  ${n}: logged in (API key)`);
      else if (s.state === "refreshable") console.log(`  ${n}: logged in (${s.account}, auto-refresh)`);
      else if (s.state === "expired") console.log(`  ${n}: expired — re-login: search-mcp-hub login ${n}`);
      else console.log(`  ${n}: not logged in — search-mcp-hub login ${n}`);
    }
    process.exit(0);
  }

  if (cmd === "use") {
    const p = rest[0];
    if (!validProvider(p)) {
      console.error("usage: search-mcp-hub use <cursor|codebuddy>");
      process.exit(1);
    }
    saveDefaultProvider(p);
    console.log(`✓ Default provider set to "${p}" (${PROVIDER_FILE})`);
    process.exit(0);
  }

  if (cmd === "search") {
    // parse --provider p (or --p p) out of the query
    let provider;
    const words = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--provider" || rest[i] === "-p") provider = rest[++i];
      else words.push(rest[i]);
    }
    const q = words.join(" ").trim();
    if (!q) {
      console.error("usage: search-mcp-hub search <query> [--provider cursor|codebuddy]");
      process.exit(1);
    }
    const { name, mod } = resolveProvider(provider);
    try {
      const r = await mod.search({ searchTerm: q, maxResults: 5 });
      if (r.answer) {
        console.log(r.answer);
        if (r.links && r.links.length) {
          console.log("\nSources:");
          for (const l of r.links) console.log(`- ${l.title} | ${l.url}`);
        }
      } else if (r.results) {
        for (const item of r.results) {
          console.log(`- ${item.title}\n  ${item.url}\n  ${item.snippet || ""}\n`);
        }
        if (r.total_results != null) console.log(`(${r.total_results} total)`);
      } else {
        console.log(JSON.stringify(r, null, 1));
      }
      process.exit(0);
    } catch (e) {
      console.error(`✗ [${name}] ${e.message}`);
      process.exit(1);
    }
  }

  if (cmd === "fetch") {
    const url = rest[0];
    if (!url) {
      console.error("usage: search-mcp-hub fetch <url>");
      process.exit(1);
    }
    try {
      const r = await codebuddy.fetchPage({ url, maxLength: 4000 });
      console.log(`# ${r.title || r.url}\n`);
      console.log(r.content);
      process.exit(0);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  }

  cliHelp();
}

function cliHelp() {
  console.log(`search-mcp-hub — one MCP server, multiple search providers

Usage:
  search-mcp-hub                             Start the MCP stdio server
  search-mcp-hub login <cursor|codebuddy>   Browser OAuth login
  search-mcp-hub status [provider]          Login state (all providers by default)
  search-mcp-hub use <cursor|codebuddy>      Set the default provider (persisted)
  search-mcp-hub search <q> [-p provider]    One-shot web search
  search-mcp-hub fetch <url>                 Fetch a page as markdown (codebuddy)
  search-mcp-hub help                        Show this help

Providers:
  cursor     Cursor agent-loop search — synthesized answers with sources
  codebuddy  Tencent CodeBuddy — fast link results, CN-friendly, domain/freshness filters

Config:
  SEARCH_HUB_PROVIDER           Default provider (env override; CLI "use" persists to ~/.search-mcp-hub/provider)
  CURSOR_API_KEY / CODEBUDDY_API_KEY    API keys (fallback when not logged in via OAuth)`);
  process.exit(0);
}

/* ---------------- entry ---------------- */

const argv = process.argv.slice(2);
const CLI_COMMANDS = new Set(["login", "status", "use", "search", "fetch", "help", "--help", "-h"]);
if (argv.length > 0 && CLI_COMMANDS.has(argv[0])) {
  cliMain(argv).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
} else {
  // MCP stdio mode — nothing else to start; stdin handler above is active
}
