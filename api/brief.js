const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const SYS = `You are Feedmatch.ai, a preparation tool for conscious professional communication on LinkedIn.
Your goal is to help the user THINK before they open LinkedIn, not to generate content for them.
Use web search to find REAL current discussions from the PAST 7 DAYS.

RESPOND ONLY WITH VALID JSON. No markdown. No HTML tags. No citation tags of any kind.

Structure:
{
  "trends": [{ "title": "...", "summary": "2-3 sentences plain text", "angles": ["genuine perspective 1", "genuine perspective 2"], "searchQueries": ["topic keyword query"] }],
  "people": [same structure],
  "articles": [same structure],
  "voices": [same structure]
}

CRITICAL RULES:
- Exactly 2 items per section (not more, not less)
- "angles" = 2 genuine talking points that help the user find THEIR OWN perspective (not generic templates). 10-20 words each.
- "searchQueries" = 1-2 LinkedIn content search queries using ONLY topic keywords, never person names
- For "people" section: searchQueries must be TOPIC keywords only, NEVER include the person's name
- ALL text must be plain text. NO citation tags. NO HTML. NO markdown. This is critical.
- Real names, real topics, real current discussions. No emoji.

REMINDER: Your entire response must be a single valid JSON object. Nothing before or after it.`;

// Simple in-memory rate limiter: 5 briefs per IP per hour
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 5;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length <= maxRequests;
}

async function callAnthropic(messages, apiKey) {
  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYS,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });
  return response.json();
}

// Log usage to Airtable - fire and forget, never blocks response
async function logToAirtable(email, niche) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableId = process.env.AIRTABLE_TABLE_ID;
  if (!token || !baseId || !tableId) return;
  try {
    await fetch(`${AIRTABLE_API}/${baseId}/${tableId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: {
          Email: email || 'unknown',
          Niche: niche,
          Date: new Date().toISOString().split('T')[0],
        },
      }),
    });
  } catch (err) {
    console.error('Airtable log error:', err);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. You can generate up to 5 briefs per hour.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

  const { niche, email } = req.body;
  if (!niche || typeof niche !== 'string' || niche.trim().length < 2) {
    return res.status(400).json({ error: 'Niche is required.' });
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const prompt = `Generate a Preparation Brief for LinkedIn niche: "${niche.trim()}". Today: ${today}. Search web for latest trends, people, articles, voices from past 7 days. Focus on discussions where someone with genuine expertise might have a real perspective to contribute. Remember: exactly 2 items per section, include genuine perspective angles, topic-only searchQueries, plain text only.`;

  try {
    let messages = [{ role: 'user', content: prompt }];
    let finalText = '';
    let searches = 0;

    for (let i = 0; i < 7; i++) {
      const data = await callAnthropic(messages, apiKey);
      if (data.error) {
      const msg = data.error.type === 'rate_limit_error'
        ? 'Too many requests. Wait a minute and try again.'
        : data.error.message;
      return res.status(500).json({ error: msg });
    }

      const content = data.content || [];
      content.forEach(block => { if (block.type === 'text') finalText += block.text; });

      const toolUses = content.filter(b => b.type === 'tool_use');
      if (data.stop_reason === 'end_turn' || !toolUses.length) break;

      searches += toolUses.length;
      messages = [
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: toolUses.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Done.' })) },
      ];
    }

    // Log to Airtable after successful generation (non-blocking)
    logToAirtable(email, niche.trim());

    return res.status(200).json({ text: finalText, searches });
  } catch (err) {
    console.error('Brief generation error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
