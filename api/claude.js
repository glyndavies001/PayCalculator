/**
 * Vercel Serverless Function — Anthropic API Proxy
 * File: /api/claude.js
 *
 * The Anthropic key lives ONLY in the server env var ANTHROPIC_API_KEY.
 * Requests must carry a valid Supabase login token (Authorization: Bearer <token>),
 * so only signed-in accounts can use the proxy — no one can spend the key by
 * hitting the URL directly.
 *
 * Only Vaulted's own models and request fields are passed on, and max_tokens is capped. Every
 * billed request is logged in ai_usage with what it cost (for the Claude credit reminder), using the
 * caller's own token. If a newer model turns a request down for something only it checks (an
 * unknown model name, a thinking or effort setting), it's tried once more on Claude Sonnet 4.6 so
 * reading keeps working; the x-vaulted-model header says which model answered.
 */

import { createClient } from "@supabase/supabase-js";

// Public Supabase project values (the anon key is safe to expose — same as the client).
const SUPABASE_URL = "https://yfbarahnwcrwewtpithb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ItUAbr04KIijWuO-JWgDNg_J5YCwaqK";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The models Vaulted uses, with their list prices in US dollars per million tokens [input, output].
const PRICES = {
  "claude-sonnet-5-5": [2, 10],   // payslips and timesheets
  "claude-opus-5-5": [4, 20],     // policy documents
  "claude-sonnet-4-6": [3, 15],   // the fallback, and phones still on an older Vaulted
};
const FALLBACK = "claude-sonnet-4-6";
const MAX_TOKENS = 16000;
const FIELDS = ["model", "max_tokens", "messages", "system", "thinking", "output_config", "stop_sequences"];
const SOURCES = ["payslip", "timesheet", "policy", "check"];

// What a request cost, from the usage Claude sends back (thinking is billed as output).
function costOf(model, u) {
  const p = PRICES[model];
  if (!p || !u) return 0;
  const cacheRead = /-5-5$/.test(model) ? 0.05 : 0.1;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * cacheRead;
  return (input * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
}
const errText = data => {
  const e = data && data.error;
  return String((e && (e.message || (typeof e === "string" ? e : ""))) || "");
};
const isCreditError = data => /credit balance/i.test(errText(data));
// Turned down for a reason Sonnet 4.6 wouldn't have: an unknown model, a thinking/effort setting, or
// the model being overloaded.
const worthFallback = (status, data) => !isCreditError(data) &&
  (status === 404 || status === 529 || (status === 400 && /model|thinking|effort|output_config|between_tools/i.test(errText(data))));

async function callClaude(apiKey, body) {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await upstream.json(); }
  catch (e) { data = { type: "error", error: { type: "api_error", message: "Claude sent back something unreadable (" + upstream.status + ")" } }; }
  return { status: upstream.status, data };
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Require a valid Supabase login token.
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Unauthorised — login required" });
  }
  let userId;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: "Unauthorised — invalid session" });
    }
    userId = data.user.id;
  } catch (e) {
    return res.status(401).json({ error: "Unauthorised — auth check failed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured on server" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const asked = String(body.model || "");
  if (!PRICES[asked]) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Vaulted doesn't use the model " + (asked || "(none)") } });
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "No messages" } });
  }
  const send = {};
  FIELDS.forEach(k => { if (body[k] !== undefined) send[k] = body[k]; });
  send.max_tokens = Math.min(MAX_TOKENS, Math.max(1, parseInt(body.max_tokens, 10) || 1024));

  let model = asked;
  let out;
  try {
    out = await callClaude(apiKey, send);
    if (asked !== FALLBACK && worthFallback(out.status, out.data)) {
      console.warn("claude: " + asked + " turned the request down (" + out.status + ": " + errText(out.data).slice(0, 200) + "), trying " + FALLBACK);
      const { thinking, output_config, ...rest } = send;
      model = FALLBACK;
      out = await callClaude(apiKey, { ...rest, model: FALLBACK });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || "Proxy error" });
  }

  // Log what it cost. Never let this stop the answer getting back.
  const usage = out.data && out.data.usage;
  if (usage || isCreditError(out.data)) {
    const src = String(req.headers["x-vaulted-source"] || "");
    try {
      const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: "Bearer " + token } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await asUser.from("ai_usage").insert({
        user_id: userId,
        source: SOURCES.includes(src) ? src : "other",
        model,
        asked_model: asked,
        input_tokens: (usage && usage.input_tokens) || 0,
        output_tokens: (usage && usage.output_tokens) || 0,
        cost_usd: Math.round(costOf(model, usage) * 1e6) / 1e6,
        error: usage ? null : "credit",
      });
      if (error) console.warn("claude: couldn't log usage: " + error.message);
    } catch (e) {
      console.warn("claude: couldn't log usage: " + (e && e.message));
    }
  }

  res.setHeader("x-vaulted-model", model);
  return res.status(out.status).json(out.data);
}
