/**
 * Vercel Serverless Function — Anthropic API Proxy
 * File: /api/claude.js
 *
 * The Anthropic key lives ONLY in the server env var ANTHROPIC_API_KEY.
 * Requests must carry a valid Supabase login token (Authorization: Bearer <token>),
 * so only signed-in accounts can use the proxy — no one can spend the key by
 * hitting the URL directly.
 */

import { createClient } from "@supabase/supabase-js";

// Public Supabase project values (the anon key is safe to expose — same as the client).
const SUPABASE_URL = "https://yfbarahnwcrwewtpithb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ItUAbr04KIijWuO-JWgDNg_J5YCwaqK";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: "Unauthorised — invalid session" });
    }
  } catch (e) {
    return res.status(401).json({ error: "Unauthorised — auth check failed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured on server" });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Proxy error" });
  }
}
