// @ts-nocheck
// Vaulted ⇄ the smart plugs (Shelly) and the smart meter (Bright), read-only.
//
// Shelly: the Cloud Control API with the person's cloud key. A plug's switch:0 status has output
// (on/off), apower (watts now) and aenergy.total (Wh, the plug's own running total). The API allows
// one call a second per account.
// Bright: the Glowmarkt API with the person's Bright login: the house's electricity in kWh per
// half-hour, from the smart meter via the DCC, normally a day behind.
//
// POST …/energy {action:"status"}                          what the Energy page shows about the links, and the rate
// POST …/energy {action:"shelly_link", server, key}        save the Shelly key, find the plugs (two-step)
// POST …/energy {action:"shelly_add", id}                  add a plug by its Device ID (two-step)
// POST …/energy {action:"shelly_unlink"}                   forget the Shelly key; plugs and history kept (two-step)
// POST …/energy {action:"live"}                            read the plugs now (anyone in the household)
// POST …/energy {action:"bright_link", username, password} save the Bright login, read the last month (two-step)
// POST …/energy {action:"bright_sync"}                     read the house's last fortnight now (two-step)
// POST …/energy {action:"bright_unlink"}                   forget the Bright login; days kept (two-step)
// POST …/energy {action:"cron"} + x-cron-key               from the database scheduler, every 15 minutes
//
// People calls need their Supabase login (Authorization: Bearer <jwt>), checked with the Auth API.
// The energy is the owner's (Glyn's): anyone in the household (a profiles row) can see it with a normal
// sign-in; only the owner can change the links, with two-step.
// "Two-step" = the login's aal claim is aal2. The key and the login live in energy_links, which
// the app can't read. Vaulted never switches a plug: the only Shelly calls are reads.

const GLOW = "https://api.glowmarkt.com/api/v0-1/";
const GLOW_APP = "b0f1b774-a586-4f72-9edd-27ead8aa7a8d";   // Bright's own application id (public)
const LIVE_GAP_MS = 5000;          // the page can't make Shelly calls closer together than this
const BRIGHT_EVERY_MS = 3 * 3600000;
const BRIGHT_WINDOW_DAYS = 7;      // half-hourly reads are asked for a week at a time
const DAY = 86400000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const iso = ms => new Date(ms).toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));

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
const rpc = (fn, args) => db("POST", `rpc/${fn}`, args);
async function getLink(userId) { const rows = await db("GET", `energy_links?user_id=eq.${userId}&select=*`); return (rows && rows[0]) || null; }
const patchLink = (userId, patch) => db("PATCH", `energy_links?user_id=eq.${userId}`, { ...patch, updated_at: iso(Date.now()) }, "return=minimal");
const putLink = (userId, patch) => upsert("energy_links", [{ user_id: userId, ...patch, updated_at: iso(Date.now()) }], "user_id");
const devicesOf = userId => db("GET", `energy_devices?user_id=eq.${userId}&select=*&order=sort.asc,created_at.asc`);
export async function config() {
  const rows = await db("GET", "energy_config?select=key,value") || [];
  const c = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { cronKey: c.cron_key || "" };
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

// ── Shelly ──────────────────────────────────────────────────────────────────
export class ShellyError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
// The server from the Shelly app ("https://shelly-103-eu.shelly.cloud"), as a bare host, or null.
export function shellyHost(s) {
  const h = String(s || "").trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  return /^shelly-[a-z0-9-]{1,40}\.shelly\.cloud$/.test(h) ? h : null;
}
export const shellyKeyOk = k => /^[A-Za-z0-9+/=_-]{20,400}$/.test(String(k || ""));
export const shellyIdOk = id => /^[a-f0-9]{6,32}$/.test(String(id || ""));
export const shellyIdOf = s => String(s || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
// A plug's switch:0 status, or null when it isn't a metered switch.
export function switchOf(status) {
  const sw = status && status["switch:0"];
  if (!sw || typeof sw !== "object") return null;
  const total = num(sw.aenergy && sw.aenergy.total);
  if (total == null) return null;
  return { on: sw.output === true, watts: num(sw.apower) == null ? null : Math.round(num(sw.apower) * 10) / 10, totalWh: total };
}
let lastShellyAt = 0;
async function shellyFetch(url, init) {
  const wait = lastShellyAt + 1100 - Date.now();   // one call a second, per account (and per run)
  if (wait > 0) await sleep(wait);
  lastShellyAt = Date.now();
  let res;
  try { res = await fetch(url, init); } catch (_) { throw new ShellyError("network"); }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw new ShellyError("bad_key");
  if (res.status === 429 || /request limit/i.test(text)) throw new ShellyError("busy");
  if (body && body.isok === false) {
    const errs = JSON.stringify(body.errors || {});
    if (/wrong_auth_key|invalid_token|unauthori[sz]ed|bad.?key/i.test(errs)) throw new ShellyError("bad_key");
    if (/max_req|limit/i.test(errs)) throw new ShellyError("busy");
    if (/device_not_found/i.test(errs)) throw new ShellyError("not_found");
    throw new ShellyError("shelly", errs.slice(0, 120));
  }
  if (!res.ok) throw new ShellyError(res.status === 404 ? "not_found" : "shelly", `Shelly ${res.status}: ${text.slice(0, 120)}`);
  return body;
}
// Every device on the account with its status: {id: status}. Shelly's own web app uses this; it
// isn't in the documented v2 API, so finding the plugs falls back to adding them by Device ID.
async function shellyAll(link) {
  const body = await shellyFetch(`https://${link.shelly_server}/device/all_status`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ auth_key: link.shelly_key, show_info: "true", no_shared: "true" }).toString(),
  });
  const all = body && body.data && body.data.devices_status;
  if (!all || typeof all !== "object") throw new ShellyError("shelly", "no device list");
  return all;
}
// Up to 10 plugs' switch status from the documented v2 API: [{id, online, sw}].
async function shellyGet(link, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const body = await shellyFetch(`https://${link.shelly_server}/v2/devices/api/get?auth_key=${encodeURIComponent(link.shelly_key)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + 10), select: ["status"], pick: { status: ["switch:0"] } }),
    });
    for (const d of Array.isArray(body) ? body : []) {
      if (!d || !d.id) continue;
      out.push({ id: String(d.id).toLowerCase(), online: d.online === 1 || d.online === true, code: d.code || null, sw: switchOf(d.status) });
    }
  }
  return out;
}
// The plugs found on the account, newest name defaults: [{shelly_id, model, sw}].
export function plugsIn(all) {
  return Object.entries(all || {}).map(([id, st]) => ({
    shelly_id: String(id).toLowerCase(),
    model: (st && (st.code || (st._dev_info && st._dev_info.code))) || null,
    sw: switchOf(st),
  })).filter(p => p.sw);
}
const DEFAULT_NAMES = ["Plug 1", "Plug 2", "Plug 3", "Plug 4", "Plug 5", "Plug 6", "Plug 7", "Plug 8", "Plug 9", "Plug 10"];
async function addPlugs(userId, plugs) {
  const have = await devicesOf(userId) || [];
  const known = new Set(have.map(d => d.shelly_id));
  const fresh = plugs.filter(p => !known.has(p.shelly_id));
  if (!fresh.length) return 0;
  const names = new Set(have.map(d => d.name));
  const free = DEFAULT_NAMES.filter(n => !names.has(n));
  await db("POST", "energy_devices", fresh.map((p, i) => ({
    user_id: userId, shelly_id: p.shelly_id, model: p.model, name: free[i] || "Plug", sort: have.length + i,
  })), "return=minimal");
  return fresh.length;
}
// What people see as the Shelly problem: no internals.
function shellyProblem(e) {
  const c = e && e.code;
  if (c === "bad_key") return "Shelly didn't accept the key. It changes if you change your Shelly password: copy it again.";
  if (c === "busy") return "Shelly asked us to slow down; trying again soon.";
  if (c === "network") return "Couldn't reach Shelly.";
  if (/^db /.test(String((e && e.message) || ""))) return "Couldn't save to Vaulted's database.";
  return "Shelly didn't answer properly.";
}
// Read the person's plugs and keep what they say. Returns the plugs' rows as they are now.
async function readPlugs(userId, link) {
  const devices = (await devicesOf(userId) || []).filter(d => !d.hidden);
  if (!devices.length) { await patchLink(userId, { shelly_checked_at: iso(Date.now()), shelly_error: null }); return []; }
  try {
    const got = await shellyGet(link, devices.map(d => d.shelly_id));
    const byId = new Map(got.map(g => [g.id, g]));
    const at = iso(Date.now());
    for (const d of devices) {
      const g = byId.get(d.shelly_id);
      if (g && g.online && g.sw) await rpc("energy_ingest", { p_device: d.id, p_at: at, p_watts: g.sw.watts, p_total: g.sw.totalWh, p_on: g.sw.on });
      else if (d.online !== false) await db("PATCH", `energy_devices?id=eq.${d.id}`, { online: false }, "return=minimal");
    }
    await patchLink(userId, { shelly_checked_at: at, shelly_error: null });
  } catch (e) {
    console.error("energy: shelly read", e && e.message);
    await patchLink(userId, { shelly_checked_at: iso(Date.now()), shelly_error: shellyProblem(e) }).catch(() => {});
    if (e && e.code === "bad_key") throw e;
  }
  return devicesOf(userId);
}

// ── Bright (Glowmarkt) ──────────────────────────────────────────────────────
export class BrightError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function glow(path, { token, method = "GET", body, params } = {}) {
  const url = new URL(GLOW + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json", applicationId: GLOW_APP, ...(token ? { token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) { throw new BrightError("network"); }
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw new BrightError("signin");
  if (res.status === 429) throw new BrightError("busy");
  if (!res.ok) throw new BrightError("bright", `Bright ${res.status}: ${text.slice(0, 120)}`);
  return j;
}
async function glowAuth(username, password) {
  let j;
  try { j = await glow("auth", { method: "POST", body: { username, password } }); }
  catch (e) { if (e.code === "bright") throw new BrightError("signin"); throw e; }
  if (!j || j.valid === false || !j.token) throw new BrightError("signin");
  const exp = num(j.exp) ? num(j.exp) * 1000 : Date.now() + 6 * DAY;
  return { token: j.token, exp };
}
// A working token for the link, signing in again when it's near its end (they last about a week).
async function brightToken(userId, link) {
  const exp = link.bright_token_exp ? Date.parse(link.bright_token_exp) : 0;
  if (link.bright_token && exp - Date.now() > 3600000) return link.bright_token;
  const t = await glowAuth(link.bright_user, link.bright_pass);
  await patchLink(userId, { bright_token: t.token, bright_token_exp: iso(t.exp) });
  link.bright_token = t.token; link.bright_token_exp = iso(t.exp);
  return t.token;
}
// The smart meter's electricity use (kWh), from the person's virtual entities.
async function brightResource(token) {
  const ves = await glow("virtualentity", { token });
  for (const ve of Array.isArray(ves) ? ves : []) {
    const inline = Array.isArray(ve.resources) ? ve.resources : null;
    const list = inline && inline.some(r => r && r.classifier) ? inline
      : ((await glow(`virtualentity/${ve.veId}/resources`, { token })) || {}).resources || [];
    const r = list.find(x => x && x.classifier === "electricity.consumption");
    if (r && r.resourceId) return r.resourceId;
  }
  return null;
}
const ukDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
export const ukDayOf = ms => ukDay.format(new Date(ms));
// The moment a UK day ("YYYY-MM-DD") starts: midnight GMT, or 23:00 the day before in summer.
export function ukMidnight(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  for (const h of [0, -1]) { const t = Date.UTC(y, m - 1, d, h); if (ukDayOf(t) === day && ukDayOf(t - 1) !== day) return t; }
  return Date.UTC(y, m - 1, d);
}
const glowTime = ms => new Date(ms).toISOString().slice(0, 19);
// Half-hours [[unix seconds, kWh | null], …] -> UK days [{day, kwh, halves}] (missing ones skipped).
export function brightDays(data) {
  const days = new Map();
  for (const row of Array.isArray(data) ? data : []) {
    if (!Array.isArray(row) || row[1] == null || !isFinite(Number(row[1])) || !isFinite(Number(row[0]))) continue;
    const d = ukDayOf(Number(row[0]) * 1000);
    const x = days.get(d) || { day: d, kwh: 0, halves: 0 };
    x.kwh += Number(row[1]); x.halves += 1;
    days.set(d, x);
  }
  return [...days.values()].map(x => ({ ...x, kwh: Math.round(x.kwh * 1000) / 1000 })).sort((a, b) => a.day.localeCompare(b.day));
}
// Read the house's half-hours since `fromMs`, a week at a time, and keep the UK days.
async function readHouse(userId, link, fromMs) {
  const token = await brightToken(userId, link);
  let resource = link.bright_resource;
  if (!resource) {
    resource = await brightResource(token);
    if (!resource) throw new BrightError("no_meter");
    await patchLink(userId, { bright_resource: resource });
  }
  let kept = 0;
  const now = Date.now();
  for (let from = fromMs; from < now; from += BRIGHT_WINDOW_DAYS * DAY) {
    const to = Math.min(now, from + BRIGHT_WINDOW_DAYS * DAY);
    const j = await glow(`resource/${resource}/readings`, { token, params: { from: glowTime(from), to: glowTime(to), period: "PT30M", offset: 0, function: "sum", nulls: 1 } });
    const days = brightDays(j && j.data);
    if (days.length) kept += Number(await rpc("energy_house_put", { p_user: userId, p_days: days })) || 0;
  }
  return kept;
}
function brightProblem(e) {
  const c = e && e.code;
  if (c === "signin") return "Bright didn't accept the login. If you've changed your Bright password, connect again.";
  if (c === "no_meter") return "Bright hasn't found your smart meter yet. It can take a couple of days after you sign up.";
  if (c === "busy") return "Bright asked us to slow down; trying again later.";
  if (c === "network") return "Couldn't reach Bright.";
  if (/^db /.test(String((e && e.message) || ""))) return "Couldn't save to Vaulted's database.";
  return "Bright didn't answer properly.";
}
async function syncHouse(userId, link, days) {
  const at = iso(Date.now());
  try {
    // From the start of a UK day, so the first day read is a whole one.
    const kept = await readHouse(userId, link, ukMidnight(ukDayOf(Date.now() - days * DAY)));
    await patchLink(userId, { bright_checked_at: at, bright_error: null });
    return { ok: true, kept };
  } catch (e) {
    console.error("energy: bright read", e && e.message);
    await patchLink(userId, { bright_checked_at: at, bright_error: brightProblem(e) }).catch(() => {});
    return { ok: false, error: (e && e.code) || "bright" };
  }
}

// ── The scheduler ───────────────────────────────────────────────────────────
async function cron() {
  const links = await db("GET", "energy_links?or=(shelly_key.not.is.null,bright_user.not.is.null)&select=*") || [];
  const results = [];
  for (const link of links) {
    const r = { user: link.user_id.slice(0, 8) };
    if (link.shelly_key && link.shelly_server) {
      try { await readPlugs(link.user_id, link); r.shelly = "ok"; } catch (e) { r.shelly = (e && e.code) || "error"; }
    }
    const checked = link.bright_checked_at ? Date.parse(link.bright_checked_at) : 0;
    if (link.bright_user && link.bright_pass && Date.now() - checked >= BRIGHT_EVERY_MS - 60000) {
      r.bright = (await syncHouse(link.user_id, link, 3)).ok ? "ok" : "error";
    }
    results.push(r);
  }
  return { checked: links.length, results };
}

// ── Requests ────────────────────────────────────────────────────────────────
const publicDevice = d => ({ id: d.id, shelly_id: d.shelly_id, name: d.name, icon: d.icon, model: d.model, sort: d.sort, hidden: d.hidden,
  online: d.online, is_on: d.is_on, watts: d.watts, total_wh: d.total_wh, read_at: d.read_at });

// The electricity unit rate (pence per kWh) and VAT from the owner's energy policy, worked out as the app
// does, so everyone in the household sees costs without reading the policy itself.
export function rateFrom(policies) {
  for (const p of policies || []) {
    const ds = (Array.isArray(p.details) ? p.details : []).filter(d => d && d.label && d.value);
    const rateD = ds.find(d => /electric/i.test(d.label) && /unit/i.test(d.label)) || ds.find(d => /unit rate/i.test(d.label) && !/gas/i.test(d.label));
    if (!rateD) continue;
    const v = String(rateD.value);
    const pm = v.match(/(\d+(?:\.\d+)?)\s*p\b/i), gm = v.match(/£\s*(\d+(?:\.\d+)?)/);
    const pence = pm ? Number(pm[1]) : gm ? Number(gm[1]) * 100 : null;
    if (!pence || !isFinite(pence) || pence <= 0 || pence > 200) continue;
    const vatD = ds.find(d => /electric/i.test(d.label) && /vat/i.test(d.label));
    const vm = vatD && String(vatD.value).match(/(\d+(?:\.\d+)?)\s*%/);
    return { pence, vat: vm ? Number(vm[1]) : 0, from: p.provider || p.name || "the energy policy" };
  }
  return null;
}
async function rateOf(userId) {
  if (!userId) return null;
  const rows = await db("GET", `policies?user_id=eq.${userId}&kind=eq.energy&archived=eq.false&select=provider,name,details`).catch(() => null);
  return rateFrom(rows || []);
}

export async function handler(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true });
  try {
    const body = await req.json().catch(() => ({}));

    if (body.action === "cron") {   // the database scheduler, not a person
      const cfg = await config();
      if (!cfg.cronKey || !sameText(req.headers.get("x-cron-key") || "", cfg.cronKey)) return json({ error: "forbidden" }, 403);
      return json(await cron());
    }

    const user = await caller(req);
    if (!user) return json({ error: "signin" }, 401);

    // Whose energy this is: the owner's. Others in the household can look, not change anything.
    const me = (await db("GET", `profiles?id=eq.${user.id}&select=id,role`)) || [];
    if (!me.length) return json({ error: "forbidden" }, 403);
    const isOwner = me[0].role === "owner";
    const ownerId = isOwner ? user.id : ((((await db("GET", "profiles?role=eq.owner&select=id&limit=1")) || [])[0]) || {}).id || null;

    if (body.action === "status") {   // no readings and no secrets here
      const link = ownerId ? await getLink(ownerId) : null;
      return json({
        twoStep: user.aal === "aal2", owner: ownerId, canManage: isOwner, rate: await rateOf(ownerId),
        shelly: { linked: !!(link && link.shelly_key), server: link && link.shelly_key ? link.shelly_server : null,
          checkedAt: (link && link.shelly_checked_at) || null, problem: (link && link.shelly_key && link.shelly_error) || null },
        bright: { linked: !!(link && link.bright_user), user: isOwner && link && link.bright_user ? link.bright_user : null,
          checkedAt: (link && link.bright_checked_at) || null, problem: (link && link.bright_user && link.bright_error) || null },
      });
    }

    if (body.action === "live") {
      if (!ownerId) return json({ linked: false, devices: [] });
      const link = await getLink(ownerId);
      if (!link || !link.shelly_key) return json({ linked: false, devices: ((await devicesOf(ownerId)) || []).map(publicDevice) });
      const last = link.shelly_checked_at ? Date.parse(link.shelly_checked_at) : 0;
      let rows;
      if (Date.now() - last < LIVE_GAP_MS) rows = await devicesOf(ownerId);
      else {
        try { rows = await readPlugs(ownerId, link); }
        catch (e) { return json({ error: e.code || "shelly", problem: shellyProblem(e), devices: ((await devicesOf(ownerId)) || []).map(publicDevice) }); }
      }
      const fresh = await getLink(ownerId);
      return json({ linked: true, checkedAt: fresh && fresh.shelly_checked_at, problem: (fresh && fresh.shelly_error) || null, devices: (rows || []).map(publicDevice) });
    }

    if (!isOwner) return json({ error: "owner_only" }, 403);
    if (user.aal !== "aal2") return json({ error: "two_step" }, 403);

    if (body.action === "shelly_link") {
      const host = shellyHost(body.server), k = String(body.key || "").trim();
      if (!host) return json({ error: "bad_server" }, 400);
      if (!shellyKeyOk(k)) return json({ error: "bad_key" }, 400);
      const link = { shelly_server: host, shelly_key: k };
      let plugs = null;
      try { plugs = plugsIn(await shellyAll(link)); }
      catch (e) {
        if (e.code === "bad_key") return json({ error: "bad_key" }, 400);
        if (e.code === "busy") return json({ error: "busy" }, 429);
        if (e.code === "network") return json({ error: "shelly_down" }, 502);
        plugs = null;   // couldn't list them: add them by Device ID instead
      }
      const stamp = iso(Date.now());
      await putLink(user.id, { shelly_server: host, shelly_key: k, shelly_linked_at: stamp, shelly_error: null });
      const added = plugs ? await addPlugs(user.id, plugs) : 0;
      if (plugs && plugs.length) await readPlugs(user.id, link).catch(() => {});
      return json({ linked: true, listed: !!plugs, found: plugs ? plugs.length : 0, added, devices: ((await devicesOf(user.id)) || []).map(publicDevice) });
    }

    if (body.action === "shelly_add") {
      const link = await getLink(user.id);
      if (!link || !link.shelly_key) return json({ error: "not_linked" }, 400);
      const id = shellyIdOf(body.id);
      if (!shellyIdOk(id)) return json({ error: "bad_id" }, 400);
      let got;
      try { got = await shellyGet(link, [id]); }
      catch (e) { return json({ error: e.code === "not_found" ? "not_found" : e.code === "bad_key" ? "bad_key" : e.code === "busy" ? "busy" : "shelly_down" }, 400); }
      const g = got.find(x => x.id === id);
      if (!g) return json({ error: "not_found" }, 400);
      if (g.online && !g.sw) return json({ error: "not_a_meter" }, 400);
      const added = await addPlugs(user.id, [{ shelly_id: id, model: g.code, sw: g.sw }]);
      await readPlugs(user.id, link).catch(() => {});
      return json({ added, devices: ((await devicesOf(user.id)) || []).map(publicDevice) });
    }

    if (body.action === "shelly_unlink") {
      await patchLink(user.id, { shelly_server: null, shelly_key: null, shelly_linked_at: null, shelly_checked_at: null, shelly_error: null });
      return json({ linked: false });
    }

    if (body.action === "bright_link") {
      const username = String(body.username || "").trim(), password = String(body.password || "");
      if (!/^\S+@\S+\.\S+$/.test(username) || username.length > 200) return json({ error: "bad_user" }, 400);
      if (!password || password.length > 200) return json({ error: "bad_password" }, 400);
      let t;
      try { t = await glowAuth(username, password); }
      catch (e) { return json({ error: e.code === "signin" ? "bright_signin" : "bright_down" }, 400); }
      let resource = null;
      try { resource = await brightResource(t.token); } catch (_) { /* tried again on the next read */ }
      const stamp = iso(Date.now());
      await putLink(user.id, { bright_user: username, bright_pass: password, bright_token: t.token, bright_token_exp: iso(t.exp),
        bright_resource: resource, bright_linked_at: stamp, bright_error: resource ? null : brightProblem(new BrightError("no_meter")) });
      if (!resource) return json({ linked: true, meter: false });
      const link = await getLink(user.id);
      const r = await syncHouse(user.id, link, 35);
      return json({ linked: true, meter: true, kept: r.kept || 0, error: r.ok ? null : r.error });
    }

    if (body.action === "bright_sync") {
      const link = await getLink(user.id);
      if (!link || !link.bright_user) return json({ error: "not_linked" }, 400);
      return json(await syncHouse(user.id, link, 14));
    }

    if (body.action === "bright_unlink") {
      await patchLink(user.id, { bright_user: null, bright_pass: null, bright_token: null, bright_token_exp: null, bright_resource: null,
        bright_linked_at: null, bright_checked_at: null, bright_error: null });
      return json({ linked: false });
    }

    return json({ error: "action" }, 400);
  } catch (e) {
    console.error("energy:", e && e.message);
    return json({ error: "server" }, 500);
  }
}
