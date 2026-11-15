// Vercel serverless function: writes a partner launch brief with Claude.
// Needs the ANTHROPIC_API_KEY environment variable. Optional: ANTHROPIC_MODEL, DAILY_LIMIT.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 60);
let day = "", count = 0;
const perIp = new Map();

const ASSETS = {
  "Full launch": {
    oa: ["Launch blog post (platform blog)", "Social post (platform's LinkedIn)", "Co-hosted webinar", "Case study plan (platform customer stories page)"],
    pt: ["Approved messaging and boilerplate (internal, partner marketing and comms)", "Suggested social post (partner's LinkedIn)", "Suggested customer email (partner's customer list)", "Sales kit (internal, partner's account managers)"]
  },
  "Standard launch": {
    oa: ["Launch blog post (platform blog)", "Social post (platform's LinkedIn)", "Webinar"],
    pt: ["Approved messaging and boilerplate (internal)", "Suggested social post (partner's LinkedIn)", "Sales kit (internal, partner's account managers)"]
  },
  "Light launch": {
    oa: ["Short announcement (platform help center or changelog)", "Social post (platform's LinkedIn)"],
    pt: ["Approved messaging and boilerplate (internal)", "Sales one-liner and FAQ (internal, partner's account managers)"]
  }
};

const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(503).json({ error: "Not configured." }); return; }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; count = 0; perIp.clear(); }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  if (count >= DAILY_LIMIT || (perIp.get(ip) || 0) >= 8) { res.status(429).json({ error: "Daily limit reached." }); return; }
  count++; perIp.set(ip, (perIp.get(ip) || 0) + 1);

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const plat = clean(b.plat, 40), name = clean(b.name, 40), cust = clean(b.cust, 60);
  const typeLabel = clean(b.typeLabel, 30), tierName = clean(b.tierName, 30);
  if (!plat || !name) { res.status(400).json({ error: "Missing platform or partner." }); return; }
  const assets = ASSETS[tierName] || ASSETS["Standard launch"];
  const isChat = /chatgpt/i.test(plat);

  const system = `You are a senior partner marketing manager at an ads platform. You write partner launch briefs: the positioning, ready-to-send launch copy for both companies, post-launch adoption plays, and a scorecard.

Voice rules:
- Platform-voice copy is plain, calm and specific. Use verbs like help, support, make it easier. No hype, no superlatives, no exclamation marks. Sentence-case headlines.
- Partner-voice copy is suggested copy the partner adapts. It can be warmer and more direct, speaking to the partner's own customers.
- Lead with what the integration lets customers do inside the tool they already use. Never invent statistics, customer names, prices or results. Use placeholders like [brand] where needed.
- Measurement and data are always described as aggregate reporting. Never imply ads are targeted using private conversations or personal data.${isChat ? "\n- For ChatGPT Ads, include the principles where natural: ChatGPT's answers stay independent, conversations stay private, advertisers receive aggregate reporting." : ""}
- Write every draft as it would read on launch day (for example "Starting today..."), because these are drafts prepared ahead of launch. Do not hedge with "planning" or "will". The page labels the brief as a draft.
- Each "angle" is the creative idea behind the asset (the insight or framing), not an operational tip.

Always respond by calling the write_brief tool exactly once with the full brief. Use this shape:
{
 "line": "one-sentence positioning, under 25 words",
 "why": ["benefit 1", "benefit 2", "benefit 3"],
 "groups": [
  {"key": "oa", "items": [{"name": "asset name", "for": "channel · account", "when": "timing", "hook": "headline or hook", "angle": "creative angle, one or two sentences", "drafts": [["label", "draft text"]]}]},
  {"key": "pt", "items": [ same shape ]}
 ],
 "plays": [["Offer|In product|Hands-on|New features", "short title", "one or two sentences"]],
 "score": [["Adoption", [["metric", "definition", "day 30 target", "day 90 target", "owner team"]]], ["Revenue", [...]], ["Enablement", [...]]],
 "rules": [["", "Scale it", "if condition", "then action"], ["fix", "Fix it", "if", "then"], ["down", "Step down", "if", "then"]]
}
Use "\\n" for line breaks inside drafts. Keep each draft under 70 words and each angle to one sentence. Exactly 4 plays. 2 to 3 metrics per score group; targets can be counts or percentages and are illustrative.`;

  const user = `Platform: ${plat}
Partner: ${name}
Partner's customers: ${cust || "their customers"}
Partner type: ${typeLabel}
Launch size: ${tierName}

Assets published by ${plat} (group "oa"), in this order: ${assets.oa.join("; ")}.
Partner launch kit sent to ${name} (group "pt"), in this order: ${assets.pt.join("; ")}.
The sales kit should include the pitch, who to call first, and answers to the three questions customers will ask.`;

  const tool = {
    name: "write_brief",
    description: "Return the finished partner launch brief.",
    input_schema: {
      type: "object",
      properties: {
        line: { type: "string" },
        why: { type: "array", items: { type: "string" } },
        groups: { type: "array", items: { type: "object", properties: {
          key: { type: "string", enum: ["oa", "pt"] },
          items: { type: "array", items: { type: "object", properties: {
            name: { type: "string" }, for: { type: "string" }, when: { type: "string" },
            hook: { type: "string" }, angle: { type: "string" },
            drafts: { type: "array", items: { type: "array", items: { type: "string" } } }
          }, required: ["name", "for", "when", "hook", "angle", "drafts"] } }
        }, required: ["key", "items"] } },
        plays: { type: "array", items: { type: "array", items: { type: "string" } } },
        score: { type: "array", items: { type: "array" } },
        rules: { type: "array", items: { type: "array", items: { type: "string" } } }
      },
      required: ["line", "why", "groups", "plays", "score", "rules"]
    }
  };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 10000, system, tools: [tool], tool_choice: { type: "auto" }, messages: [{ role: "user", content: user }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { res.status(502).json({ error: "Model request failed.", detail: (j.error && j.error.message) || r.status }); return; }
    const block = (j.content || []).find(c => c.type === "tool_use");
    let data = block && block.input;
    if (!data) { try { const txt = (j.content || []).filter(c => c.type === "text").map(c => c.text).join(""); data = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); } catch (e) {} }
    if (!data || !data.groups || !data.plays || !data.score || !data.rules) { res.status(502).json({ error: "Could not write the brief.", detail: j.stop_reason || "no tool output" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "Could not write the brief.", detail: String(e && e.message || e).slice(0, 200) });
  }
};

module.exports.config = { maxDuration: 60 };
