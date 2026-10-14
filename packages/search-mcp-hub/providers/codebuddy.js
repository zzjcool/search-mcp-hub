#!/usr/bin/env node
/**
 * CodeBuddy provider — web search / web fetch via Tencent CodeBuddy's agenttool API.
 *
 * Extracted from codebuddy-search-mcp v1.5.0 (protocol-verified against CLI v2.160.0):
 *   POST /agenttool/v1/search    {query, type:"text2text", max_results, ...}
 *   POST /agenttool/v1/webfetch  {url, format:"markdown", ...}
 *
 * Auth (OAuth first, API key fallback):
 *   - OAuth state: reads the CodeBuddy CLI's own auth file (FileAuthenticationStorage),
 *     refreshes via POST /v2/plugin/auth/token/refresh on expiry (7-day refresh window).
 *   - Full browser login flow (reverse-engineered from CLI createSession):
 *     POST /v2/plugin/auth/state → open authUrl in browser → poll GET /v2/plugin/auth/token
 *     → GET /v2/plugin/account → write the CLI's auth file (CLI watcher picks it up).
 *   - API key: CODEBUDDY_API_KEY env or ~/.codebuddy-search-mcp/key.
 *
 * State dir: ~/.codebuddy-search-mcp (env CODEBUDDY_SEARCH_STATE_DIR)
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exec } = require("node:child_process");

const API_BASE =
  process.env.CODEBUDDY_API_BASE ||
  (process.env.CODEBUDDY_INTERNET_ENVIRONMENT === "international"
    ? "https://www.codebuddy.ai"
    : "https://copilot.tencent.com");
const CLI_VERSION = process.env.CODEBUDDY_CLI_VERSION || "2.160.0";
const STATE_DIR =
  process.env.CODEBUDDY_SEARCH_STATE_DIR || path.join(os.homedir(), ".codebuddy-search-mcp");
const KEY_FILE = path.join(STATE_DIR, "key");
const FRESHNESS_RE = /^(?:d(?:[1-9]|[12]\d|30)?|m(?:[1-9]|1[0-2])?|y[1-5]?)$/;

/* ---------------- OAuth state (shared with the CodeBuddy CLI) ---------------- */

function oauthDir() {
  if (process.env.CODEBUDDY_AUTH_DIR) return process.env.CODEBUDDY_AUTH_DIR;
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library/Application Support/CodeBuddyExtension/Data/Public/auth");
  if (process.platform === "win32")
    return path.join(os.homedir(), "AppData/Local/CodeBuddyExtension/Data/Public/auth");
  return path.join(os.homedir(), ".local/share/CodeBuddyExtension/Data/Public/auth");
}

function readOauthInfo() {
  try {
    const files = fs
      .readdirSync(oauthDir())
      .filter((f) => f.endsWith(".info") && !/\.\d{4}-\d{2}-\d{2}T/.test(f)); // skip timestamped backups
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(oauthDir(), f), "utf8"));
        if (d?.auth?.accessToken) return { file: path.join(oauthDir(), f), data: d };
      } catch {}
    }
  } catch {}
  return null;
}

function writeOauthInfo(file, data) {
  try {
    const tmp = file + ".mcp-tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file); // atomic; the CLI's watcher syncs external edits
    return true;
  } catch {
    return false;
  }
}

/* ---------------- Browser login flow (reverse-engineered from CLI createSession) ---------------- */

const AUTH_ID = process.env.CODEBUDDY_AUTH_ID || "Tencent-Cloud.coding-copilot";
const LOGIN_POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_TOKEN_PENDING = 11217; // "login ing..."

function noAuthHeaders() {
  return {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function readLoginEnvelopeCode(body) {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.code === "number") return body.code;
  const n = body.response?.data?.code ?? body.response?.code;
  return typeof n === "number" ? n : undefined;
}

async function restCall(method, apiPath, { headers = {}, timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
        ...headers,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: ctl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`), {
        status: res.status,
      });
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full OAuth browser login (equivalent to `codebuddy login`):
 * auth/state → open browser → poll auth/token (pending=11217) → account → write CLI auth file.
 */
async function browserLogin({ onAuthUrl } = {}) {
  const stateResp = await restCall("POST", "/v2/plugin/auth/state?platform=CLI", {
    headers: noAuthHeaders(),
  });
  const st = stateResp?.data?.data || stateResp?.data;
  if (!st?.state || !st?.authUrl) {
    throw new Error(`auth/state unexpected response: ${JSON.stringify(stateResp).slice(0, 300)}`);
  }

  if (onAuthUrl) onAuthUrl(st.authUrl);
  openBrowser(st.authUrl);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let auth;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS));
    let resp;
    try {
      resp = await restCall("GET", `/v2/plugin/auth/token?state=${encodeURIComponent(st.state)}`, {
        headers: noAuthHeaders(),
      });
    } catch {
      continue; // transient network error — keep polling
    }
    const d = resp?.data?.data ?? resp?.data;
    if (d && typeof d.accessToken === "string" && d.accessToken) {
      auth = d;
      break;
    }
    const code = readLoginEnvelopeCode(resp) ?? readLoginEnvelopeCode(d);
    if (code !== LOGIN_TOKEN_PENDING && code !== 0) {
      throw new Error(`login poll failed code=${code}: ${resp?.msg || "unknown"}`);
    }
  }
  if (!auth) throw new Error(`login timeout (no browser authorization within ${LOGIN_TIMEOUT_MS / 1000}s)`);

  auth.lastRefreshTime = Date.now();
  if (!auth.expiresAt && auth.expiresIn) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
  if (!auth.refreshExpiresAt && auth.refreshExpiresIn)
    auth.refreshExpiresAt = Date.now() + auth.refreshExpiresIn * 1000;

  let account = {};
  try {
    const accResp = await restCall("GET", "/v2/plugin/account", {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(auth.domain ? { "X-Domain": auth.domain } : {}),
      },
    });
    account = accResp?.data?.data || accResp?.data || {};
  } catch {}

  const target = path.join(oauthDir(), `${AUTH_ID}.info`);
  const info = { account, auth, accounts: [account] };
  fs.mkdirSync(oauthDir(), { recursive: true });
  if (!writeOauthInfo(target, info)) throw new Error(`failed to write auth file: ${target}`);
  return { account: account.nickname || account.uid || "unknown", authUrl: st.authUrl };
}

/** Refresh an expired OAuth token (reverse-engineered CLI refreshSession). */
async function refreshOauth(info) {
  const a = info.data.auth;
  if (!a.refreshToken) throw new Error("OAuth refreshToken missing — run login again");
  if (a.refreshExpiresAt && a.refreshExpiresAt < Date.now())
    throw new Error(
      `OAuth refresh token expired at ${new Date(a.refreshExpiresAt).toISOString()} — run login again`
    );
  const res = await fetch(`${API_BASE}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Token": a.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      ...(a.domain ? { "X-Domain": a.domain } : {}),
      "User-Agent": `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
    },
    body: "{}",
  });
  const j = await res.json().catch(() => ({}));
  const auth = j?.data?.data || j?.data;
  if (!res.ok || !auth?.accessToken) {
    throw new Error(`refresh failed (HTTP ${res.status}): ${j?.msg || j?.error_msg || JSON.stringify(j).slice(0, 200)}`);
  }
  auth.lastRefreshTime = Date.now();
  if (!auth.expiresAt && auth.expiresIn) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
  if (!auth.refreshExpiresAt && auth.refreshExpiresIn)
    auth.refreshExpiresAt = Date.now() + auth.refreshExpiresIn * 1000;
  info.data.auth = auth;
  writeOauthInfo(info.file, info.data);
  return auth;
}

/* ---------------- API key ---------------- */

function readApiKey() {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Resolve Bearer: OAuth first (valid or refreshable), else API key. */
async function resolveBearer() {
  const info = readOauthInfo();
  if (info) {
    const a = info.data.auth;
    if (a.expiresAt > Date.now() + 60_000) return { token: a.accessToken, source: "oauth" };
    try {
      const fresh = await refreshOauth(info);
      return { token: fresh.accessToken, source: "oauth-refreshed" };
    } catch (e) {
      const key = readApiKey();
      if (key) return { token: key, source: `api-key (OAuth unavailable: ${e.message})` };
      throw e;
    }
  }
  const key = readApiKey();
  if (key) return { token: key, source: "api-key" };
  throw new Error(
    "no credentials: run `search-mcp-hub login codebuddy` (browser OAuth), or set CODEBUDDY_API_KEY / ~/.codebuddy-search-mcp/key"
  );
}

/* ---------------- API calls ---------------- */

async function apiCall(apiPath, body, timeoutMs = 25_000, bearer = null) {
  const { token, source } = bearer ?? (await resolveBearer());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}${apiPath}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout (${timeoutMs / 1000}s): ${apiPath}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw new Error(`401: invalid credentials (${source}). Run login again or configure an API key.`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON response: ${text.slice(0, 200)}`);
  }
  if (data.code) {
    throw new Error(`API error code=${data.code}: ${data.msg || "unknown"}`);
  }
  return data;
}

/* ---------------- Provider API (unified surface) ---------------- */

/**
 * Local auth status (no network). One of:
 *   ok | refreshable | expired | api-key | none
 */
function authStatus() {
  const info = readOauthInfo();
  const key = readApiKey();
  const now = Date.now();
  if (info) {
    const a = info.data.auth;
    const account = info.data.account?.nickname || info.data.account?.uid || "unknown";
    if (a.expiresAt > now + 60_000)
      return { state: "ok", account, access_until: a.expiresAt, refresh_until: a.refreshExpiresAt };
    if (!a.refreshExpiresAt || a.refreshExpiresAt > now)
      return { state: "refreshable", account, access_until: a.expiresAt, refresh_until: a.refreshExpiresAt };
    return { state: "expired", account, access_until: a.expiresAt, refresh_until: a.refreshExpiresAt };
  }
  if (key) return { state: "api-key" };
  return { state: "none" };
}

/**
 * Web search. args: {query, maxResults, allowedDomains?, blockedDomains?, freshness?}
 * Returns {query, provider, total_results, response_time_ms, results:[{title,url,snippet,favicon?}]}
 */
async function search(args) {
  const query = (args.query || args.searchTerm || "").trim();
  if (!query || query.length < 2) throw new Error("query required (min 2 chars)");
  const body = {
    query,
    type: "text2text",
    max_results: Math.min(Math.max(args.maxResults || 5, 1), 10),
  };
  if (Array.isArray(args.allowedDomains) && args.allowedDomains.length)
    body.allowed_domains = args.allowedDomains;
  if (Array.isArray(args.blockedDomains) && args.blockedDomains.length)
    body.blocked_domains = args.blockedDomains;
  if (args.freshness) {
    if (!FRESHNESS_RE.test(args.freshness)) {
      throw new Error('freshness format: "d"/"d1".."d30"/"m"/"m1".."m12"/"y"/"y1".."y5"');
    }
    body.freshness = args.freshness;
  }
  const d = await apiCall("/agenttool/v1/search", body);
  const results = (d.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.snippet || "",
    favicon: r.favicon || undefined,
  }));
  return {
    query,
    provider: d.provider ?? "",
    total_results: d.total_results ?? results.length,
    response_time_ms: d.response_time_ms ?? null,
    results,
  };
}

/**
 * Fetch a page as markdown. args: {url, maxLength?, prompt?}
 * Returns {url, title, content_type, content}
 */
async function fetchPage(args) {
  if (!args.url) throw new Error("url required");
  const body = {
    url: args.url,
    format: "markdown",
    prompt: args.prompt || "extract the main content",
    timeout: 20,
    max_length: Math.min(Math.max(args.maxLength || 4000, 500), 20000),
  };
  const d = await apiCall("/agenttool/v1/webfetch", body, 40_000);
  let content = d.content || "";
  if (args.maxLength && content.length > args.maxLength)
    content = content.slice(0, args.maxLength) + "\n…[truncated]";
  return {
    url: d.url || args.url,
    title: d.title || "",
    content_type: d.content_type || "",
    content,
  };
}

module.exports = {
  API_BASE,
  STATE_DIR,
  authStatus,
  browserLogin,
  resolveBearer,
  readApiKey,
  search,
  fetchPage,
};
