const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(messages, maxTokens = 400) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function getGameVariants(gameName) {
  const prompt = `You are a game search assistant. The user searched for: "${gameName}"

Generate a list of different ways this EXACT game title might appear in a database.
Rules:
- Keep variants at least 4 characters long
- Do NOT invent unrelated games
- Include: original name, with/without subtitle, common abbreviations (only if well-known like "GTA V", "RE4")
- Max 8 variants

Return ONLY the list, one per line, no numbers, no explanation.`;

  const raw = await callGroq([{ role: 'user', content: prompt }], 200);

  const variants = raw
    .split('\n')
    .map(v => v.trim().replace(/^[-•*]\s*/, ''))
    .filter(v => v.length >= 4 && v.length < 80);

  if (!variants.some(v => v.toLowerCase() === gameName.toLowerCase())) {
    variants.unshift(gameName);
  }

  return [...new Set(variants)];
}

export async function verifyAccounts(requestedGame, foundAccounts) {
  const accountsList = foundAccounts
    .map((a, i) => `${i + 1}. "${a.matchedGame ?? a.gameName}"`)
    .join('\n');

  const prompt = `The user searched for: "${requestedGame}"

These are the game titles found in the database:
${accountsList}

For each title, answer true if it is the SAME game as "${requestedGame}" (including bundles that contain it, alternate titles, remakes, or very close variants).
Answer false if it is a COMPLETELY DIFFERENT game with no relation.

Be strict. Different games in the same series (e.g. GTA IV vs GTA V) are false unless the user searched for the series name.

Reply with ONLY a JSON array of booleans matching the order above.
Example: [true, false, true]
No explanation, just the array.`;

  try {
    const raw = await callGroq([{ role: 'user', content: prompt }], 100);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return foundAccounts.map(() => false);
    const results = JSON.parse(match[0]);
    if (!Array.isArray(results)) return foundAccounts.map(() => false);
    return results.map(r => r === true);
  } catch {
    return foundAccounts.map(() => false);
  }
}

export async function getAlternativeNames(gameName, attempt) {
  const prompt = `The game "${gameName}" was not found in the database (attempt ${attempt}).

Suggest up to 6 alternative ways this game title might be stored:
- Shorter version (drop subtitle)
- Franchise name only (e.g. "Resident Evil" from "Resident Evil Village")
- With/without year or number
- Common alternative spelling

Rules:
- Min 4 characters each
- Do NOT suggest completely different games
- One per line, no numbering, no explanation`;

  const raw = await callGroq([{ role: 'user', content: prompt }], 120);

  return raw
    .split('\n')
    .map(v => v.trim().replace(/^[-•*]\s*/, ''))
    .filter(v => v.length >= 4 && v.length < 80);
}

export async function formatMultipleResults(requestedGame, accounts) {
  const emoji = await getGameEmoji(requestedGame);

  if (accounts.length === 1) {
    const a = accounts[0];
    const label = a.matchedGame ?? a.gameName;
    return `${emoji} **${label}**\n\n**Login:** \`${a.username}\`\n\n**Pass:** \`${a.password}\``;
  }

  const lines = accounts.map((a, i) => {
    const label = a.matchedGame ?? a.gameName;
    return `**[${i + 1}] ${label}**\n**Login:** \`${a.username}\`\n**Pass:** \`${a.password}\``;
  });

  return [
    `${emoji} **${requestedGame}** — وُجد ${accounts.length} حساب`,
    '',
    lines.join('\n\n'),
  ].join('\n');
}

export async function getGameEmoji(gameName) {
  const prompt = `Give me one single emoji that best represents the game "${gameName}". Reply with ONLY the emoji character, nothing else.`;
  try {
    const emoji = await callGroq([{ role: 'user', content: prompt }], 10);
    return emoji.trim().slice(0, 2) || '🎮';
  } catch {
    return '🎮';
  }
}

export async function getTop50Games() {
  const prompt = `List the 50 most popular PC/Steam games of all time. Include a mix of action, RPG, FPS, sports, adventure, and indie games.

Return ONLY the game names, one per line, no numbers, no bullets, no explanation, no extra symbols.`;

  const raw = await callGroq([{ role: 'user', content: prompt }], 1000);

  return raw
    .split('\n')
    .map(v => v.trim().replace(/^[-•*\d.)]+\s*/, ''))
    .filter(v => v.length >= 2 && v.length < 80);
}
