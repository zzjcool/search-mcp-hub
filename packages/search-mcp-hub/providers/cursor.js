#!/usr/bin/env node
/**
 * Cursor provider — web search via Cursor's agent-loop protocol.
 *
 * Wraps cursor-protocol.js (RunSSE + BidiAppend pure protocol client, reverse-engineered
 * from cursor-agent 2026.10.01, verified end-to-end). Search runs the real server-side
 * agent loop with web_search_enabled — no cursor-agent binary involved.
 *
 * Auth: API key (CURSOR_API_KEY env or ~/.cursor-search-mcp/key → exchange_user_api_key)
 * or browser OAuth (loginDeepControl PKCE device flow), token cached at
 * ~/.cursor-search-mcp/auth.json with automatic refresh.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const proto = require("./cursor-protocol.js");

const STATE_DIR = process.env.CURSOR_SEARCH_STATE_DIR || path.join(os.homedir(), ".cursor-search-mcp");
const TOKEN_FILE = path.join(STATE_DIR, "auth.json");

/* ---------------- auth status (local, no network) ---------------- */

function tokenExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof p.exp === "number" ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

function hasApiKey() {
  if (process.env.CURSOR_API_KEY) return true;
  try {
    return Boolean(fs.readFileSync(path.join(STATE_DIR, "key"), "utf8").trim());
  } catch {
    return false;
  }
}

/**
 * Local auth status (no network). One of:
 *   ok (valid token or API key) | none
 */
function authStatus() {
  if (hasApiKey()) return { state: "api-key" };
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (d.accessToken) {
      const exp = tokenExp(d.accessToken);
      if (exp !== null && exp > Date.now() + 60_000) return { state: "ok" };
    }
  } catch {}
  return { state: "none" };
}

/* ---------------- provider API (unified surface) ---------------- */

/**
 * Web search. args: {searchTerm|query, maxResults?}
 * Runs a fresh server-side agent-loop session and returns the synthesized answer
 * plus deduplicated source links.
 */
async function search(args) {
  const q = (args.searchTerm || args.query || "").trim();
  if (!q) throw new Error("searchTerm required");
  const r = await proto.runSearch(q);
  const n = args.maxResults || 5;
  const seen = new Set();
  const links = [];
  for (const ref of r.references) {
    for (const u of ref.urls) {
      if (!seen.has(u.url)) {
        seen.add(u.url);
        links.push(u);
      }
    }
  }
  return {
    query: q,
    provider: "cursor",
    answer: r.answer,
    links: links.slice(0, n * 3),
    link_count: links.length,
  };
}

/** Fetch is not supported by the Cursor provider (no standalone fetch API). */
async function fetchPage() {
  throw new Error("cursor provider does not support web_fetch (use codebuddy)");
}

/** Verify credentials end-to-end (forces token exchange/validation). */
async function verify() {
  const { fresh } = await proto.ensureToken();
  return { fresh };
}

/**
 * Start browser OAuth. Returns {uuid, loginUrl, expiresInMin}.
 * Complete with waitLogin(uuid, timeoutMs).
 */
function startLogin() {
  return proto.startOAuthLogin();
}

/** Poll for OAuth completion; resolves when the token is cached. */
async function waitLogin(uuid, timeoutMs) {
  return proto.pollOAuthLogin(uuid, { timeoutMs: timeoutMs || 15 * 60_000 });
}

module.exports = {
  API_BASE: proto.API_BASE,
  STATE_DIR,
  authStatus,
  search,
  fetchPage,
  verify,
  startLogin,
  waitLogin,
};
