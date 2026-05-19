import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'bot.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT,
    icon TEXT,
    joined_at TEXT,
    dashboard_channel_id TEXT,
    is_active INTEGER DEFAULT 0,
    command_permission TEXT DEFAULT 'owner',
    warning_count INTEGER DEFAULT 0,
    active_token_id TEXT,
    invite_link TEXT,
    last_seen TEXT,
    free_tier_expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE,
    expires_at TEXT,
    here_min_interval INTEGER DEFAULT 0,
    steam_limit INTEGER DEFAULT 0,
    label TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS server_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT,
    token_id TEXT,
    activated_at TEXT,
    steam_uses INTEGER DEFAULT 0,
    UNIQUE(server_id, token_id)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT,
    action TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS allowed_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT,
    user_id TEXT,
    UNIQUE(server_id, user_id)
  );
`);

function addColIfMissing(table, col, type) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
}
addColIfMissing('servers', 'free_tier_expires_at', 'TEXT');
addColIfMissing('servers', 'invite_link', 'TEXT');
addColIfMissing('servers', 'last_seen', 'TEXT');
addColIfMissing('tokens', 'label', 'TEXT');
addColIfMissing('tokens', 'here_min_interval', 'INTEGER DEFAULT 0');
addColIfMissing('tokens', 'steam_limit', 'INTEGER DEFAULT 0');

// ─── Servers ──────────────────────────────────────────────────
export function getServer(guildId) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(guildId);
}

export function getAllServers() {
  return db.prepare('SELECT * FROM servers ORDER BY joined_at DESC').all();
}

export function upsertServer(guildId, name, icon) {
  const existing = getServer(guildId);
  const now = new Date().toISOString();
  if (!existing) {
    db.prepare('INSERT INTO servers (id, name, icon, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(guildId, name, icon || null, now, now);
  } else {
    db.prepare('UPDATE servers SET name = ?, icon = ?, last_seen = ? WHERE id = ?')
      .run(name, icon || null, now, guildId);
  }
}

export function autoActivateFreeTier(guildId, days = 2) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE servers SET free_tier_expires_at = ? WHERE id = ?').run(expiresAt, guildId);
  return expiresAt;
}

export function setDashboardChannel(guildId, channelId) {
  db.prepare('UPDATE servers SET dashboard_channel_id = ? WHERE id = ?').run(channelId, guildId);
}

export function setServerActive(guildId, isActive) {
  db.prepare('UPDATE servers SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, guildId);
}

export function setCommandPermission(guildId, permission) {
  db.prepare('UPDATE servers SET command_permission = ? WHERE id = ?').run(permission, guildId);
}

export function setServerInviteLink(guildId, link) {
  db.prepare('UPDATE servers SET invite_link = ? WHERE id = ?').run(link || null, guildId);
}

export function updateLastSeen(guildId) {
  db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), guildId);
}

export function incrementWarning(guildId) {
  db.prepare('UPDATE servers SET warning_count = warning_count + 1 WHERE id = ?').run(guildId);
  return db.prepare('SELECT warning_count FROM servers WHERE id = ?').get(guildId)?.warning_count || 0;
}

export function resetWarnings(guildId) {
  db.prepare('UPDATE servers SET warning_count = 0 WHERE id = ?').run(guildId);
}

export function removeServer(guildId) {
  db.prepare('DELETE FROM servers WHERE id = ?').run(guildId);
}

// ─── Tokens (Global — not bound to a specific server) ─────────
export function createToken({ label = '', expiresAt, hereMinInterval = 0, steamLimit = 0 }) {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  db.prepare(
    `INSERT INTO tokens (id, token, expires_at, here_min_interval, steam_limit, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, token, expiresAt, hereMinInterval || 0, steamLimit || 0, label || '', new Date().toISOString());
  return { id, token };
}

export function getAllTokens() {
  return db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all();
}

export function getTokenByValue(tokenValue) {
  return db.prepare('SELECT * FROM tokens WHERE token = ?').get(tokenValue);
}

export function getServerToken(guildId) {
  return db.prepare(`
    SELECT t.*, st.activated_at, st.steam_uses AS server_steam_uses, st.id AS st_id
    FROM server_tokens st
    JOIN tokens t ON t.id = st.token_id
    WHERE st.server_id = ? AND t.expires_at > ?
    ORDER BY st.activated_at DESC LIMIT 1
  `).get(guildId, new Date().toISOString());
}

export function activateToken(tokenId, guildId) {
  const existing = db.prepare(
    'SELECT server_id FROM server_tokens WHERE token_id = ? LIMIT 1'
  ).get(tokenId);
  if (existing && existing.server_id !== guildId) {
    return { ok: false, error: 'هذا التوكن مستخدم بالفعل من سيرفر آخر.' };
  }
  db.prepare(
    'INSERT OR REPLACE INTO server_tokens (server_id, token_id, activated_at, steam_uses) VALUES (?, ?, ?, 0)'
  ).run(guildId, tokenId, new Date().toISOString());
  db.prepare('UPDATE servers SET active_token_id = ?, is_active = 1 WHERE id = ?').run(tokenId, guildId);
  return { ok: true };
}

export function incrementSteamUses(guildId) {
  const st = db.prepare(`
    SELECT st.id FROM server_tokens st
    JOIN tokens t ON t.id = st.token_id
    WHERE st.server_id = ? AND t.expires_at > ?
    ORDER BY st.activated_at DESC LIMIT 1
  `).get(guildId, new Date().toISOString());
  if (st) {
    db.prepare('UPDATE server_tokens SET steam_uses = steam_uses + 1 WHERE id = ?').run(st.id);
  }
}

export function isServerAuthorized(guildId) {
  const server = getServer(guildId);
  if (!server) return false;
  const token = getServerToken(guildId);
  if (token) return true;
  if (server.free_tier_expires_at && new Date(server.free_tier_expires_at) > new Date()) return true;
  return false;
}

export function isFreeTierActive(guildId) {
  const server = getServer(guildId);
  if (!server) return false;
  const token = getServerToken(guildId);
  if (token) return false;
  return !!(server.free_tier_expires_at && new Date(server.free_tier_expires_at) > new Date());
}

export function getSteamLimitInfo(guildId) {
  const st = db.prepare(`
    SELECT t.steam_limit, st.steam_uses FROM server_tokens st
    JOIN tokens t ON t.id = st.token_id
    WHERE st.server_id = ? AND t.expires_at > ?
    ORDER BY st.activated_at DESC LIMIT 1
  `).get(guildId, new Date().toISOString());
  return { limit: st?.steam_limit || 0, uses: st?.steam_uses || 0 };
}

export function getHereMinInterval(guildId) {
  const token = getServerToken(guildId);
  return token?.here_min_interval || 0;
}

// ─── Logs ─────────────────────────────────────────────────────
export function addLog(serverId, action, details) {
  db.prepare('INSERT INTO logs (server_id, action, details) VALUES (?, ?, ?)').run(serverId, action, details || '');
}

export function getLogs(serverId, limit = 50) {
  return db.prepare('SELECT * FROM logs WHERE server_id = ? ORDER BY id DESC LIMIT ?').all(serverId, limit);
}

// ─── Allowed Users ────────────────────────────────────────────
export function isUserAllowed(guildId, userId) {
  return !!db.prepare('SELECT 1 FROM allowed_users WHERE server_id = ? AND user_id = ?').get(guildId, userId);
}

export function addAllowedUser(guildId, userId) {
  db.prepare('INSERT OR IGNORE INTO allowed_users (server_id, user_id) VALUES (?, ?)').run(guildId, userId);
}

export function removeAllowedUser(guildId, userId) {
  db.prepare('DELETE FROM allowed_users WHERE server_id = ? AND user_id = ?').run(guildId, userId);
}

export function getAllowedUsers(guildId) {
  return db.prepare('SELECT user_id FROM allowed_users WHERE server_id = ?').all(guildId).map(r => r.user_id);
}
