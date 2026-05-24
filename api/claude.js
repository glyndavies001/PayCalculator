/**
 * Vercel Serverless Function — Anthropic API Proxy
 * File: /api/claude.js
 *
 * Deploy instructions:
 *   1. Add this file to your project at api/claude.js
 *   2. In Vercel dashboard → Settings → Environment Variables:
 *      ANTHROPIC_API_KEY = sk-ant-...
 *   3. All fetch calls in App.js already point to "/api/claude"
 *
 * The key is NEVER sent to the browser.
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
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

    // Mirror the upstream status code
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Proxy error" });
  }
}
