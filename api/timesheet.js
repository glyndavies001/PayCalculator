/**
 * Vercel Serverless Function — Timesheet Inbound Processor (Redis queue)
 * File: /api/timesheet.js
 */

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const QUEUE_KEY = 'vaulted_ts_queue';

function inferPayMonth(periodStr) {
  const match = periodStr.match(/to (\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month] = match;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[parseInt(month) - 1] + " " + year;
}

function isMonthlyTimesheet(periodStr) {
  if (!periodStr) return false;
  const match = periodStr.match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  if (!match) return false;
  return (new Date(match[2]) - new Date(match[1])) / (1000*60*60*24) >= 20;
}

function extractPeriod(subject) {
  const match = subject.match(/(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function extractTotalHours(body) {
  const match = body.match(/Total [Hh]ours?:\s*([\d]+h\s*[\d]+m)/i);
  return match ? match[1].trim() : null;
}

export default async function handler(req, res) {
  const secret = process.env.TIMESHEET_SECRET;

  if (req.method === "POST") {
    const { token, emailId, emailBody, emailSubject, emailDate } = req.body || {};
    if (!secret || token !== secret) return res.status(401).json({ error: "Unauthorised" });
    if (!emailBody) return res.status(400).json({ error: "No email body provided" });

    // Check if already in queue
    const queue = await redis.lrange(QUEUE_KEY, 0, -1);
    const parsed = queue.map(i => typeof i === 'string' ? JSON.parse(i) : i);
    if (parsed.find(q => q.emailId === emailId)) {
      return res.status(200).json({ status: "already_queued" });
    }

    const period    = extractPeriod(emailSubject || "");
    const totalHrs  = extractTotalHours(emailBody);
    const isMonthly = isMonthlyTimesheet(period);
    const payMonth  = period ? inferPayMonth(period) : null;

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 2000,
          messages: [{ role: "user", content:
`This is a JLI timesheet email. Extract every day row as a JSON array.
Return ONLY a JSON array, no other text:
[{"date":"DD/MM","day":"Mon","hours":"8h 15m","holiday":""}]

Rules:
- Include ALL rows including weekends, holidays, and zero-hour days
- "holiday" field: copy the EXACT text from the Holiday column. If empty or shows "-", use "" (empty string). Do NOT normalise — preserve whatever JLI put there
- Holiday rows have "-" for In/Out and "0h 00m" for hours — still include them
- Weekend rows with 0h 00m: include with hours "0h 00m"
- Use the hours column value exactly as shown

Email body:
${emailBody}` }],
        }),
      });

      const claudeData = await upstream.json();
      if (claudeData.error) throw new Error(claudeData.error.message);
      const text = claudeData.content.map(i => i.text || "").join("").replace(/```json|```/g, "").trim();
      const days = JSON.parse(text);

      const entry = {
        emailId,
        emailDate: emailDate || new Date().toISOString(),
        processedAt: new Date().toISOString(),
        days,
        meta: { isMonthly, period: period||"", payMonth: payMonth||"", totalHrs: totalHrs||"", subject: emailSubject||"" },
      };

      await redis.rpush(QUEUE_KEY, JSON.stringify(entry));
      const queueLength = await redis.llen(QUEUE_KEY);

      return res.status(200).json({ status: "queued", count: days.length, queueLength, isMonthly, period, payMonth });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Parse error" });
    }
  }

  // GET — return oldest item in queue
  if (req.method === "GET") {
    const { token } = req.query;
    if (!secret || token !== secret) return res.status(401).json({ error: "Unauthorised" });
    const item = await redis.lindex(QUEUE_KEY, 0);
    if (!item) return res.status(200).json({ status: "none" });
    const data = typeof item === 'string' ? JSON.parse(item) : item;
    const remaining = await redis.llen(QUEUE_KEY);
    return res.status(200).json({ status: "pending", data, remaining });
  }

  // DELETE — remove oldest item
  if (req.method === "DELETE") {
    const { token } = req.query;
    if (!secret || token !== secret) return res.status(401).json({ error: "Unauthorised" });
    await redis.lpop(QUEUE_KEY);
    const remaining = await redis.llen(QUEUE_KEY);
    return res.status(200).json({ status: "cleared", remaining });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
