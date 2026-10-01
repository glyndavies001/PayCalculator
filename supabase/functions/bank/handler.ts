// @ts-nocheck
// Vaulted ⇄ Monzo, read-only: accounts, balances, pots and transactions for the app's payday
// check, "what's really left" and the pots on the Move tab.
//
// GET  …/bank/callback?code=…&state=…      Monzo sends the person back here after the email link
// POST …/bank/hook/<secret>                Monzo's webhook for a new transaction (fetched again from
//                                          Monzo; what the webhook says is never stored as sent)
// POST …/bank {action:"status"}            what the app's Bank section shows (no bank data, no secrets)
// POST …/bank {action:"config", clientId, clientSecret}   save the Monzo keys (the owner, two-step)
// POST …/bank {action:"link"}              the Monzo sign-in address for the caller (two-step)
// POST …/bank {action:"sync"}              accounts, balances, pots and transactions (two-step)
// POST …/bank {action:"unlink"}            forget the caller's link and bank data (two-step)
// POST …/bank {action:"cron"|"cron_pending"} + x-cron-key   from the database scheduler
//
// People calls need their Supabase login (Authorization: Bearer <jwt>), checked with the Auth API.
// "Two-step" = the login's aal claim is aal2. Keys and tokens live in bank_config and bank_links,
// which the app can't read. Vaulted never moves money: the only Monzo calls are reads, webhook
// registration, and the token and logout endpoints.

export const APP_URL = "https://pay-calculator-iota.vercel.app";
const MONZO_AUTH = "https://auth.monzo.com/";
const MONZO_API = "https://api.monzo.com";
const STATE_MINUTES = 20;                       // a sign-in must finish within this
const RETAIL = ["uk_retail", "uk_retail_joint"];  // personal and joint current accounts
const RECENT_DAYS = 89;                         // after the first five minutes Monzo serves 90 days
const OVERLAP_DAYS = 7;                         // re-read the last week (pending payments settle)
const PAGE = 100;                               // Monzo's largest page
const LOCK_MINUTES = 3;
const DAY = 86400000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const backToApp = result => new Response(null, { status: 302, headers: { Location: `${APP_URL}/?bank=${result}` } });
const iso = ms => new Date(ms).toISOString();
const enc = encodeURIComponent;
const cut = (s, n = 140) => (s == null || s === "" ? null : String(s).slice(0, n));
const pence = v => (v == null || !isFinite(Number(v)) ? null : Math.round(Number(v)));

export class Dead extends Error {}           // the link has run out: relink
export class NeedsApproval extends Error {}  // Monzo wants the person to approve in its app

// ── Supabase (service key) ──────────────────────────────────────────────────
function key(kind) {
  const env = globalThis.Deno.env;
  try { const all = JSON.parse(env.get(kind === "secret" ? "SUPABASE_SECRET_KEYS" : "SUPABASE_PUBLISHABLE_KEYS") || "{}"); if (all.default) return all.default; } catch (_) { /* fall back */ }
  return env.get(kind === "secret" ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_ANON_KEY");
}
const base = () => globalThis.Deno.env.get("SUPABASE_URL");
function adminHeaders(extra = {}) {
  const k = key("secret");
  const h = { apikey: k, "Content-Type": "application/json", ...extra };
  if (k && k.startsWith("eyJ")) h.Authorization = `Bearer ${k}`;   // legacy JWT keys also go in Authorization
  return h;
}
async function db(method, path, body, prefer) {
  const res = await fetch(`${base()}/rest/v1/${path}`, { method, headers: adminHeaders(prefer ? { Prefer: prefer } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const upsert = (table, rows, onConflict) => db("POST", `${table}?on_conflict=${onConflict}`, rows, "resolution=merge-duplicates,return=minimal");
async function getLink(userId) { const rows = await db("GET", `bank_links?user_id=eq.${userId}&select=*`); return rows && rows[0]; }
const patchLink = (userId, patch) => db("PATCH", `bank_links?user_id=eq.${userId}`, patch, "return=minimal");
async function forgetData(userId) {
  for (const t of ["bank_pot_history", "bank_transactions", "bank_pots", "bank_accounts"]) await db("DELETE", `${t}?user_id=eq.${userId}`, null, "return=minimal");
}

export async function config() {
  const rows = await db("GET", "bank_config?select=key,value") || [];
  const c = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { id: c.monzo_client_id || "", secret: c.monzo_client_secret || "", hook: c.hook_secret || "", cronKey: c.cron_key || "", owner: c.owner_id || "" };
}
const ready = cfg => !!(cfg.id && cfg.secret);
export const redirectUri = () => `${base()}/functions/v1/bank/callback`;
const hookBase = () => `${base()}/functions/v1/bank/hook/`;
const hookUrl = cfg => hookBase() + cfg.hook;

export function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Same text, compared without leaking where they differ.
export function sameText(a, b) {
  a = String(a); b = String(b);
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function jwtClaims(jwt) {
  try {
    const p = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(p + "===".slice((p.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch (_) { return null; }
}
// Who is calling: their Supabase login, checked by the Auth API. aal2 = they've done two-step.
async function caller(req) {
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt || !jwt.startsWith("eyJ")) return null;
  const res = await fetch(`${base()}/auth/v1/user`, { headers: { apikey: key("publishable"), Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (!u || !u.id) return null;
  const c = jwtClaims(jwt) || {};
  return { id: u.id, aal: c.sub === u.id && c.aal === "aal2" ? "aal2" : "aal1" };
}
// Only the owner (a fixed user id kept server-side) can set the Monzo keys.
const isOwner = (cfg, user) => !!cfg.owner && user.id === cfg.owner;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// What people see in "Last problem": no database or Monzo internals.
function problemText(e) {
  const m = String((e && e.message) || e || "");
  if (/429/.test(m)) return "Monzo asked us to slow down; trying again later";
  if (/^db /.test(m)) return "Couldn't save to Vaulted's database";
  if (/token refresh/.test(m)) return "Couldn't renew the Monzo sign-in";
  return "Couldn't reach Monzo";
}

// ── Monzo ───────────────────────────────────────────────────────────────────
export async function tokenRequest(params) {
  const res = await fetch(`${MONZO_API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: data || {} };
}
// One call to Monzo. params: [[name, value], …] (a list, so expand[] can repeat).
async function mz(token, method, path, params = []) {
  const url = new URL(MONZO_API + path);
  let body;
  if (method === "GET" || method === "DELETE") for (const [k, v] of params) url.searchParams.append(k, v);
  else body = new URLSearchParams(params).toString();
  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, code: String((data && data.code) || ""), data: data || {} };
}
// A usable access token, refreshed when it's (nearly) out. null = the link has run out.
// Monzo's refresh tokens work once, so refreshing happens under a per-person lock; anyone
// else waiting picks up the new token instead of spending the old one.
const fresh = l => !!(l && l.access_token && l.access_expires && Date.parse(l.access_expires) > Date.now() + 60000);
async function accessToken(link, cfg, force = false) {
  if (!force && fresh(link)) return link.access_token;
  const had = link.access_token;
  for (let attempt = 0; attempt < 24; attempt++) {
    const stamp = iso(Date.now());
    const got = await db("PATCH", `bank_links?user_id=eq.${link.user_id}&or=(refresh_lock.is.null,refresh_lock.lt.${enc(iso(Date.now() - 30000))})`, { refresh_lock: stamp }, "return=representation");
    if (Array.isArray(got) && got.length === 1) {
      try {
        const cur = got[0];
        Object.assign(link, cur);
        if (cur.access_token && cur.access_token !== had && fresh(cur)) return cur.access_token;   // someone just renewed it
        if (!cur.refresh_token) return null;
        const r = await tokenRequest({ grant_type: "refresh_token", client_id: cfg.id, client_secret: cfg.secret, refresh_token: cur.refresh_token });
        if (!r.ok) {
          const why = String((r.data && (r.data.code || r.data.error)) || "");
          if ((r.status === 400 || r.status === 401) && /refresh|grant|expired|revoked/i.test(why)) return null;   // Monzo says it's no longer valid
          throw new Error(`token refresh ${r.status} ${why}`.trim());
        }
        const patch = { access_token: r.data.access_token, access_expires: iso(Date.now() + (Number(r.data.expires_in) || 21600) * 1000) };
        if (r.data.refresh_token) patch.refresh_token = r.data.refresh_token;
        await patchLink(link.user_id, patch);
        Object.assign(link, patch);
        return patch.access_token;
      } finally {
        await db("PATCH", `bank_links?user_id=eq.${link.user_id}&refresh_lock=eq.${enc(stamp)}`, { refresh_lock: null }, "return=minimal").catch(() => {});
      }
    }
    await sleep(500);   // someone else is renewing it: wait for theirs
    const cur = await getLink(link.user_id);
    if (!cur) return null;
    if (cur.access_token && cur.access_token !== had && fresh(cur)) { Object.assign(link, cur); return cur.access_token; }
  }
  throw new Error("token refresh busy");
}
// A Monzo call with the person's token: refreshed once on 401.
async function call(link, cfg, method, path, params) {
  let token = await accessToken(link, cfg);
  if (!token) throw new Dead("link expired");
  let r = await mz(token, method, path, params);
  if (r.status === 401) {
    token = await accessToken(link, cfg, true);
    if (!token) throw new Dead("link expired");
    r = await mz(token, method, path, params);
    if (r.status === 401) throw new Dead("link expired");
  }
  if (r.status === 429) throw new Error("Monzo asked us to slow down (429)");
  return r;
}

// A Monzo transaction as stored: only what the app uses.
export function rowOfTx(userId, t, stamp) {
  const m = t.merchant && typeof t.merchant === "object" ? t.merchant : null;
  const meta = t.metadata && typeof t.metadata === "object" ? t.metadata : {};
  return {
    user_id: userId, tx_id: String(t.id), account_id: String(t.account_id), created: t.created, settled: t.settled || null,
    amount: pence(t.amount) || 0, currency: cut(t.currency, 8) || "GBP",
    description: cut(t.description), merchant: m ? cut(m.name) : null,
    merchant_id: m ? cut(m.group_id || m.id, 80) : (typeof t.merchant === "string" ? cut(t.merchant, 80) : null),
    counterparty: t.counterparty && t.counterparty.name ? cut(t.counterparty.name) : null,
    category: cut(t.category, 40), scheme: cut(t.scheme, 40),
    pot_id: cut(meta.pot_id, 80), dd_id: cut(meta.bacs_direct_debit_instruction_id || meta.mandate_id, 80),
    include_in_spending: t.include_in_spending !== false, updated_at: stamp,
  };
}
const keepTx = (t, accountId) => t && t.id && t.created && !t.decline_reason && (!t.account_id || t.account_id === accountId);

// An account's balance and pots, saved. `a` needs an id; type and description are saved when given.
async function refreshAccount(link, cfg, a, stamp) {
  const b = await call(link, cfg, "GET", "/balance", [["account_id", a.id]]);
  if (b.status === 403) throw new NeedsApproval(b.code);
  if (!b.ok) throw new Error(`balance ${b.status} ${b.code}`);
  const row = { user_id: link.user_id, account_id: a.id, balance: pence(b.data.balance), total_balance: pence(b.data.total_balance),
    spend_today: pence(b.data.spend_today), currency: cut(b.data.currency, 8) || "GBP", updated_at: stamp };
  if (a.type) Object.assign(row, { type: a.type, description: cut(a.description), closed: !!a.closed });
  await upsert("bank_accounts", [row], "user_id,account_id");
  const p = await call(link, cfg, "GET", "/pots", [["current_account_id", a.id]]);
  if (p.status === 403) throw new NeedsApproval(p.code);
  if (!p.ok) return;
  const pots = ((p.data && p.data.pots) || []).filter(x => x && x.id).map(x => ({
    user_id: link.user_id, pot_id: String(x.id), account_id: a.id, name: cut(x.name, 80) || "Pot", balance: pence(x.balance),
    goal_amount: pence(x.goal_amount), currency: cut(x.currency, 8) || "GBP", deleted: !!x.deleted, updated_at: stamp,
  }));
  if (pots.length) await upsert("bank_pots", pots, "user_id,pot_id");
}

// Transactions for one account, oldest first. since = a time, or null for everything (Monzo only
// allows that in the first five minutes after approval; `refused` says it said no).
async function pullTx(link, cfg, accountId, since, before) {
  const list = [];
  let cursor = since;
  for (let page = 0; page < 300; page++) {
    const params = [["account_id", accountId], ["limit", String(PAGE)], ["expand[]", "merchant"]];
    if (cursor) params.push(["since", cursor]);
    if (before) params.push(["before", before]);
    const r = await call(link, cfg, "GET", "/transactions", params);
    if (r.status === 403) {
      if (since === null) return { list, refused: true };
      throw new NeedsApproval(r.code);
    }
    if (!r.ok) throw new Error(`transactions ${r.status} ${r.code}`);
    const got = ((r.data && r.data.transactions) || []).filter(t => t && t.id);
    list.push(...got);
    if (got.length < PAGE) break;
    const newest = got.reduce((a, t) => (!a || String(t.created) > String(a.created) ? t : a), null);
    if (!newest || newest.id === cursor) break;
    cursor = newest.id;
  }
  return { list, refused: false };
}

// One webhook per account, pointing here; stale ones of ours (an old address) are removed.
async function ensureHooks(link, cfg, accountIds, check) {
  const have = { ...(link.webhook_ids || {}) };
  const out = {};
  const want = hookUrl(cfg);
  for (const id of accountIds) {
    if (have[id] && !check) { out[id] = have[id]; continue; }
    const r = await call(link, cfg, "GET", "/webhooks", [["account_id", id]]);
    if (!r.ok) { if (have[id]) out[id] = have[id]; continue; }
    const list = (r.data && r.data.webhooks) || [];
    for (const w of list) if (w && w.id && w.url !== want && String(w.url || "").startsWith(hookBase())) await call(link, cfg, "DELETE", `/webhooks/${w.id}`);
    let hook = list.find(w => w && w.url === want);
    if (!hook) {
      const c = await call(link, cfg, "POST", "/webhooks", [["account_id", id], ["url", want]]);
      if (c.ok && c.data && c.data.webhook) hook = c.data.webhook;
    }
    if (hook && hook.id) out[id] = hook.id;
  }
  return out;
}

// Only one sync per person at a time (the app polls while the scheduler may also be at it).
// Returns the lock's stamp, or null if someone else holds it.
async function takeLock(userId) {
  const now = Date.now(), stamp = iso(now);
  const rows = await db("PATCH", `bank_links?user_id=eq.${userId}&or=(sync_lock.is.null,sync_lock.lt.${enc(iso(now - LOCK_MINUTES * 60000))})`, { sync_lock: stamp }, "return=representation");
  return Array.isArray(rows) && rows.length === 1 ? stamp : null;
}
const releaseLock = (userId, stamp) => db("PATCH", `bank_links?user_id=eq.${userId}&sync_lock=eq.${enc(stamp)}`, { sync_lock: null }, "return=minimal");

// Everything for one person. The first sync after approval takes the full history.
export async function syncUser(userId, cfg, opts = {}) {
  let link = await getLink(userId);
  if (!link || !link.refresh_token) return { linked: false };
  if (link.status === "reauth") return { linked: true, status: "reauth" };
  const lock = await takeLock(userId);
  if (!lock) return { linked: true, status: "busy" };
  try {
    link = await getLink(userId);   // latest tokens
    const acc = await call(link, cfg, "GET", "/accounts");
    if (acc.status === 403) throw new NeedsApproval(acc.code);
    if (!acc.ok) throw new Error(`accounts ${acc.status} ${acc.code}`);
    const accounts = ((acc.data && acc.data.accounts) || []).filter(a => a && a.id && RETAIL.includes(a.type) && !a.closed);
    const stamp = iso(Date.now());
    const full = !link.full_history;
    let added = 0, from = null, historyDone = true;
    const save = async (a, list, seen) => {
      const rows = list.filter(t => keepTx(t, a.id) && !seen.has(t.id) && seen.add(t.id)).map(t => rowOfTx(userId, { ...t, account_id: a.id }, stamp));
      for (let i = 0; i < rows.length; i += 500) await upsert("bank_transactions", rows.slice(i, i + 500), "user_id,tx_id");
      added += rows.length;
      for (const r of rows) if (!from || r.created < from) from = r.created;
    };
    for (const a of accounts) {
      await refreshAccount(link, cfg, a, stamp);
      const floor = Date.now() - RECENT_DAYS * DAY;
      const seen = new Set();   // each transaction counted once per account
      if (full) {
        // The last 89 days first (what the app needs), then everything older while Monzo
        // still allows it (only in the first five minutes after approval).
        await save(a, (await pullTx(link, cfg, a.id, iso(floor))).list, seen);
        try {
          const old = await pullTx(link, cfg, a.id, null, iso(floor + DAY));
          await save(a, old.list, seen);
        } catch (e) {
          if (e instanceof Dead || e instanceof NeedsApproval) throw e;
          historyDone = false;   // try the old history again next time (if still allowed)
          console.error("history", String(e.message || e));
        }
      } else {
        const latest = await db("GET", `bank_transactions?user_id=eq.${userId}&account_id=eq.${enc(a.id)}&select=created&order=created.desc&limit=1`);
        const last = latest && latest[0] ? Date.parse(latest[0].created) : 0;
        await save(a, (await pullTx(link, cfg, a.id, iso(Math.max(floor, last ? last - OVERLAP_DAYS * DAY : floor)))).list, seen);
      }
    }
    const hooks = await ensureHooks(link, cfg, accounts.map(a => a.id), full || !!opts.checkHooks);
    const open = new Set(accounts.map(a => a.id));
    const known = await db("GET", `bank_accounts?user_id=eq.${userId}&select=account_id,closed`) || [];
    for (const k of known) if (!open.has(k.account_id) && !k.closed) await db("PATCH", `bank_accounts?user_id=eq.${userId}&account_id=eq.${enc(k.account_id)}`, { closed: true }, "return=minimal");
    const personal = ((acc.data && acc.data.accounts) || []).find(a => a && a.type === "uk_retail" && !a.closed) || accounts[0];
    const owner = personal && Array.isArray(personal.owners) && personal.owners.find(o => o && (!link.monzo_user_id || o.user_id === link.monzo_user_id));
    const patch = { status: "ok", last_sync_at: stamp, last_error: null, webhook_ids: hooks };
    if (owner && (owner.preferred_name || owner.preferred_first_name)) patch.monzo_name = cut(owner.preferred_name || owner.preferred_first_name, 80);
    if (full && historyDone) patch.full_history = true;
    if (link.status !== "ok" || !link.approved_at) patch.approved_at = stamp;
    await patchLink(userId, patch);
    return { linked: true, status: "ok", accounts: accounts.length, added, fullHistory: full, from };
  } catch (e) {
    if (e instanceof Dead) { await patchLink(userId, { status: "reauth", last_error: "The link has run out" }); return { linked: true, status: "reauth" }; }
    if (e instanceof NeedsApproval) { await patchLink(userId, { status: "approve", last_error: null }); return { linked: true, status: "approve" }; }
    await patchLink(userId, { last_error: problemText(e) }).catch(() => {});
    throw e;
  } finally {
    await releaseLock(userId, lock).catch(() => {});
  }
}

// ── Monzo's webhook: a new transaction on one of the linked accounts ──────
// Monzo can send the webhook before the payment can be read back, so a miss is tried again in the
// background (after 15 s, 45 s and 105 s); after that the account's last two days are read
// instead, so anything Monzo lists by then is saved. Tests shorten the waits.
export const hookTiming = { waits: [15000, 30000, 60000] };
function background(p) {
  const rt = globalThis.EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
  else p.catch(() => {});
}
const hookProblem = e => (e instanceof Dead ? "link expired" : e instanceof NeedsApproval ? "needs approval" : String((e && e.message) || e));
// The webhook's payment, read back from Monzo and saved, then the balance. 0 = done, else Monzo's status.
async function saveHookTx(link, cfg, t) {
  const r = await call(link, cfg, "GET", `/transactions/${t.id}`, [["expand[]", "merchant"]]);
  if (!r.ok) return r.status || 1;
  const stamp = iso(Date.now());
  const tx = r.data && r.data.transaction;
  if (tx && tx.id === t.id && tx.account_id === t.account_id && keepTx(tx, t.account_id)) await upsert("bank_transactions", [rowOfTx(link.user_id, tx, stamp)], "user_id,tx_id");
  await refreshAccount(link, cfg, { id: t.account_id }, stamp);
  return 0;
}
async function retryHookTx(userId, cfg, t) {
  const usable = async () => { const l = await getLink(userId); return l && l.status === "ok" && l.refresh_token ? l : null; };
  for (const wait of hookTiming.waits) {
    await sleep(wait);
    const link = await usable();
    if (!link) return;
    try { if ((await saveHookTx(link, cfg, t)) === 0) return; }
    catch (e) { console.error("hook retry", hookProblem(e)); return; }
  }
  const link = await usable();
  if (!link) return;
  try {
    const stamp = iso(Date.now());
    const { list } = await pullTx(link, cfg, t.account_id, iso(Date.now() - 2 * DAY));
    const rows = list.filter(x => keepTx(x, t.account_id)).map(x => rowOfTx(userId, { ...x, account_id: t.account_id }, stamp));
    if (rows.length) await upsert("bank_transactions", rows, "user_id,tx_id");
    await refreshAccount(link, cfg, { id: t.account_id }, stamp);
    console.error("hook", list.some(x => x && x.id === t.id) ? "payment found by reading the account instead" : "payment still not listed by Monzo");
  } catch (e) { console.error("hook list", hookProblem(e)); }
}
export async function hook(req, cfg, secret) {
  if (!cfg.hook || !sameText(secret, cfg.hook)) return new Response("Not found", { status: 404, headers: CORS });
  const body = await req.json().catch(() => null);
  const t = body && body.type === "transaction.created" && body.data;
  if (!t || !/^tx_[A-Za-z0-9]+$/.test(String(t.id || "")) || !/^acc_[A-Za-z0-9]+$/.test(String(t.account_id || "")) || !ready(cfg)) return json({ ok: true });
  const owners = await db("GET", `bank_accounts?account_id=eq.${enc(t.account_id)}&select=user_id`) || [];
  for (const { user_id } of owners) {
    const link = await getLink(user_id);
    if (!link || link.status !== "ok" || !link.refresh_token) continue;
    try {
      const miss = await saveHookTx(link, cfg, { id: t.id, account_id: t.account_id });
      if (miss) {
        console.error("hook", `Monzo couldn't give the payment yet (${miss}); trying again shortly`);
        background(retryHookTx(user_id, cfg, { id: t.id, account_id: t.account_id }));
      }
    } catch (e) {
      console.error("hook", hookProblem(e));
    }
  }
  return json({ ok: true });
}

// ── The scheduler: every minute while someone is approving; once a day for everyone ──
export async function cron(cfg, pendingOnly) {
  const q = pendingOnly
    ? `bank_links?status=eq.approve&authorised_at=gt.${enc(iso(Date.now() - STATE_MINUTES * 60000))}&refresh_token=not.is.null&select=user_id`
    : "bank_links?status=in.(ok,approve)&refresh_token=not.is.null&select=user_id";
  const rows = await db("GET", q) || [];
  const results = [];
  for (const { user_id } of rows) {
    try { const r = await syncUser(user_id, cfg, { checkHooks: !pendingOnly }); results.push(r.status || "none"); }
    catch (e) { results.push("error"); console.error("cron", String(e.message || e)); }
  }
  return { checked: rows.length, results };
}

// ── Monzo sends the person back here ─────────────────────────────────────
async function callback(url, cfg) {
  const state = url.searchParams.get("state") || "";
  if (!state) return backToApp("error");
  const rows = await db("GET", `bank_links?pending_state=eq.${enc(state)}&select=*`);
  const link = rows && rows[0];
  if (!link) return backToApp("expired");
  const userId = link.user_id;
  const used = await db("PATCH", `bank_links?user_id=eq.${userId}&pending_state=eq.${enc(state)}`, { pending_state: null, pending_at: null }, "return=representation");
  if (!Array.isArray(used) || used.length !== 1) return backToApp("expired");   // single use
  if (!link.pending_at || Date.now() - Date.parse(link.pending_at) > STATE_MINUTES * 60000) return backToApp("expired");
  if (url.searchParams.get("error")) return backToApp("cancelled");
  const code = url.searchParams.get("code");
  if (!code || !ready(cfg)) return backToApp("error");
  const r = await tokenRequest({ grant_type: "authorization_code", client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirectUri(), code });
  if (!r.ok || !r.data.access_token) { await patchLink(userId, { last_error: `Monzo sign-in failed (${r.status})` }); return backToApp("error"); }
  if (!r.data.refresh_token) return backToApp("noconf");   // a non-confidential client: it would stop after six hours
  const now = Date.now();
  const taken = await db("GET", `bank_links?monzo_user_id=eq.${enc(String(r.data.user_id || ""))}&user_id=neq.${userId}&select=user_id`);
  if (Array.isArray(taken) && taken.length) {   // already linked to the other person's Vaulted
    await fetch(`${MONZO_API}/oauth2/logout`, { method: "POST", headers: { Authorization: `Bearer ${r.data.access_token}` } }).catch(() => {});
    return backToApp("in_use");
  }
  const sameMonzo = !link.monzo_user_id || link.monzo_user_id === r.data.user_id;
  if (!sameMonzo) await forgetData(userId);
  await patchLink(userId, {
    access_token: r.data.access_token, refresh_token: r.data.refresh_token,
    access_expires: iso(now + (Number(r.data.expires_in) || 21600) * 1000),
    monzo_user_id: cut(r.data.user_id, 80), status: "approve", authorised_at: iso(now), last_error: null,
    linked_at: link.linked_at || iso(now),
    ...(sameMonzo ? {} : { full_history: false, approved_at: null, webhook_ids: null, monzo_name: null }),
  });
  return backToApp("approve");
}

export async function handler(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    const cfg = await config();
    const hookPath = url.pathname.match(/\/hook\/([A-Za-z0-9_-]{16,})\/?$/);
    if (hookPath) return req.method === "POST" ? await hook(req, cfg, hookPath[1]) : new Response("Not found", { status: 404, headers: CORS });
    if (req.method === "GET") {
      if (/\/callback\/?$/.test(url.pathname)) return await callback(url, cfg);
      return json({ ok: true });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await req.json().catch(() => ({}));

    if (body.action === "cron" || body.action === "cron_pending") {   // the database scheduler, not a person
      if (!cfg.cronKey || !sameText(req.headers.get("x-cron-key") || "", cfg.cronKey)) return json({ error: "forbidden" }, 403);
      if (!ready(cfg)) return json({ checked: 0, results: [] });
      return json(await cron(cfg, body.action === "cron_pending"));
    }

    const user = await caller(req);
    if (!user) return json({ error: "signin" }, 401);

    if (body.action === "status") {   // no bank data here, so no two-step needed
      const link = await getLink(user.id);
      const linked = !!(link && link.refresh_token);
      return json({
        configured: ready(cfg), canConfigure: isOwner(cfg, user), twoStep: user.aal === "aal2",
        linked, status: linked ? link.status || null : null,
        lastSync: linked ? link.last_sync_at || null : null, approvedAt: linked ? link.approved_at || null : null,
        authorisedAt: linked ? link.authorised_at || null : null, problem: linked && link.last_error ? String(link.last_error).slice(0, 120) : null,
        monzoName: linked ? link.monzo_name || null : null,
        redirect: redirectUri(),
      });
    }

    if (user.aal !== "aal2") return json({ error: "two_step" }, 403);

    if (body.action === "config") {
      if (!isOwner(cfg, user)) return json({ error: "forbidden" }, 403);
      const id = String(body.clientId || "").trim(), secret = String(body.clientSecret || "").trim();
      if (!/^oauth2client_[A-Za-z0-9_-]{4,100}$/.test(id)) return json({ error: "bad_client_id" }, 400);
      if (!secret || secret.length > 400 || /\s/.test(secret)) return json({ error: "bad_secret" }, 400);
      if (/^mnzpub/i.test(secret)) return json({ error: "not_confidential" }, 400);
      const stamp = iso(Date.now());
      const rows = [{ key: "monzo_client_id", value: id, updated_at: stamp }, { key: "monzo_client_secret", value: secret, updated_at: stamp }];
      if (!cfg.hook) rows.push({ key: "hook_secret", value: randomToken(), updated_at: stamp });
      if (!cfg.cronKey) rows.push({ key: "cron_key", value: randomToken(), updated_at: stamp });
      await upsert("bank_config", rows, "key");
      if (cfg.id && cfg.id !== id) await db("PATCH", "bank_links?refresh_token=not.is.null", { status: "reauth", last_error: "New Monzo keys: link again" }, "return=minimal");
      return json({ configured: true });
    }
    if (body.action === "link") {
      if (!ready(cfg)) return json({ error: "not_configured" });
      const state = randomToken();
      await upsert("bank_links", [{ user_id: user.id, pending_state: state, pending_at: iso(Date.now()) }], "user_id");
      const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: redirectUri(), response_type: "code", state });
      return json({ url: `${MONZO_AUTH}?${q}` });
    }
    if (body.action === "sync") {
      if (!ready(cfg)) return json({ linked: false, error: "not_configured" });
      return json(await syncUser(user.id, cfg));
    }
    if (body.action === "unlink") {
      for (let i = 0; i < 20 && !(await takeLock(user.id)) && (await getLink(user.id)); i++) await sleep(500);   // let a running sync finish
      const link = await getLink(user.id);
      if (link && link.refresh_token && ready(cfg)) {
        try {   // tidy up at Monzo; forget it here whatever happens
          // A joint account's webhook is shared with the other person if they've linked too: leave theirs.
          const shared = new Set(((await db("GET", `bank_accounts?user_id=neq.${user.id}&select=account_id`)) || []).map(r => r.account_id));
          for (const [acc, id] of Object.entries(link.webhook_ids || {})) if (!shared.has(acc)) await call(link, cfg, "DELETE", `/webhooks/${id}`);
          const token = await accessToken(link, cfg);
          if (token) await fetch(`${MONZO_API}/oauth2/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        } catch (_) { /* already gone at Monzo */ }
      }
      await forgetData(user.id);
      await db("DELETE", `bank_links?user_id=eq.${user.id}`, null, "return=minimal");
      return json({ linked: false });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(String(e && e.message || e));
    if (req.method === "GET") return backToApp("error");
    return json({ error: "server" }, 500);
  }
}
