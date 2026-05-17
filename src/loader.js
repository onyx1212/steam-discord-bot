import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedAccounts = null;

const DATA_FILES = ['pitfall.json', 'steamfree.json', 'result.json'];

const USERNAME_KEYS = ['login', 'acc', 'email', 'mail', 'user', 'account', 'id', 'логин'];
const PASSWORD_KEYS = ['pass', 'password', 'пароль'];

export function loadAccounts() {
  if (cachedAccounts) return cachedAccounts;

  const accounts = [];

  for (const filename of DATA_FILES) {
    const filePath = join(__dirname, '../data', filename);
    let raw;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`⚠️ تعذّر قراءة: ${filename}`);
      continue;
    }

    const messages = raw.messages || [];
    let fileCount = 0;

    for (const msg of messages) {
      const text = extractText(msg.text);
      if (!text) continue;

      const parsed = parseMessage(text);
      if (parsed) {
        accounts.push({ ...parsed, source: filename });
        fileCount++;
      }
    }

    console.log(`📂 ${filename}: ${fileCount} حساب`);
  }

  console.log(`📦 المجموع: ${accounts.length} حساب`);
  cachedAccounts = accounts;
  return accounts;
}

function extractText(textField) {
  if (!textField) return null;
  if (typeof textField === 'string') return textField;
  if (Array.isArray(textField)) {
    return textField.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return null;
}

function cleanLine(line) {
  return line
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/~~[^~]+~~/g, '')
    .trim();
}

function isUserLabel(line) {
  const l = line.toLowerCase();
  return USERNAME_KEYS.some(k => l === k || l.startsWith(k + ':') || l.startsWith(k + ' '));
}

function isPassLabel(line) {
  const l = line.toLowerCase();
  return PASSWORD_KEYS.some(k => l === k || l.startsWith(k + ':') || l.startsWith(k + ' '));
}

function extractInlineValue(line, keywords) {
  const l = line.toLowerCase();
  for (const kw of keywords) {
    if (l.startsWith(kw)) {
      const rest = line.slice(kw.length).replace(/^[\s:]+/, '').trim();
      if (rest.length > 0) return rest;
    }
  }
  return null;
}

function isJunkLine(line) {
  const l = line.toLowerCase();
  return (
    line.length > 120 ||
    l.startsWith('http') ||
    l.includes('@') ||
    /^(giveaway|react|winner|dm me|lets |want |we are|free on|buy|sell|💝|⚡|✨|💠|🌟)/i.test(l) ||
    /^(guys|gmm|hello|hi |hey )/i.test(l)
  );
}

function parseMessage(rawText) {
  const lines = rawText
    .replace(/Логин:/gi, 'Login:')
    .replace(/Пароль:/gi, 'Pass:')
    .split('\n')
    .map(cleanLine)
    .filter(l => l.length > 0);

  if (lines.length < 2) return null;

  let username = null;
  let password = null;
  const gameLines = [];
  let credentialSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1] ? cleanLine(lines[i + 1]) : null;

    const isUser = isUserLabel(line);
    const isPass = isPassLabel(line);

    if (isUser || isPass) {
      credentialSectionStarted = true;

      if (isUser && !username) {
        const inline = extractInlineValue(line, USERNAME_KEYS);
        if (inline && inline.length < 120 && !inline.startsWith('http')) {
          username = inline;
        } else if (nextLine && nextLine.length < 120 && !nextLine.startsWith('http') && !isUserLabel(nextLine) && !isPassLabel(nextLine)) {
          username = nextLine;
          i++;
        }
      }

      if (isPass && !password) {
        const inline = extractInlineValue(line, PASSWORD_KEYS);
        if (inline && inline.length < 200) {
          password = inline;
        } else if (nextLine && nextLine.length < 200 && !isUserLabel(nextLine) && !isPassLabel(nextLine)) {
          password = nextLine;
          i++;
        }
      }
    } else if (!credentialSectionStarted && !isJunkLine(line) && line.length >= 2) {
      gameLines.push(line);
    }
  }

  if (!username || !password) return null;
  if (username === password) return null;
  if (gameLines.length === 0) return null;

  return {
    games: gameLines,
    gameName: gameLines[0],
    username,
    password,
  };
}
