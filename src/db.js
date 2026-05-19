import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'bot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    server_id TEXT,
    token TEXT UNIQUE,
    expires_at TEXT,
    is_free_tier INTEGER DEFAULT 0,
    invite_link TEXT,
    here_min_interval INTEGER DEFAULT 0,
    steam_limit INTEGER DEFAULT 0,
    steam_uses INTEGER DEFAULT 0,
    created_at TEXT,
    is_activated INTEGER DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id)
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

// Migrations for existing databases
function migrate() {
  const tokenCols = db.prepare('PRAGMA table_info(tokens)').all().map(c => c.name);
  if (!tokenCols.includes('here_min_interval'))
    db.exec('ALTER TABLE tokens ADD COLUMN here_min_interval INTEGER DEFAULT 0');
  if (!tokenCols.includes('steam_limit'))
    db.exec('ALTER TABLE tokens ADD COLUMN steam_limit INTEGER DEFAULT 0');
  if (!tokenCols.includes('steam_uses'))
    db.exec('ALTER TABLE tokens ADD COLUMN steam_uses INTEGER DEFAULT 0');
  if (!tokenCols.includes('invite_link'))
    db.exec('ALTER TABLE tokens ADD COLUMN invite_link TEXT');

  const serverCols = db.prepare('PRAGMA table_info(servers)').all().map(c => c.name);
  if (!serverCols.includes('invite_link'))
    db.exec('ALTER TABLE servers ADD COLUMN invite_link TEXT');
  if (!serverCols.includes('last_seen'))
    db.exec('ALTER TABLE servers ADD COLUMN last_seen TEXT');
}
migrate();

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
    db.prepare(
      'INSERT INTO servers (id, name, icon, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)'
    ).run(guildId, name, icon || null, now, now);
  } else {
    db.prepare('UPDATE servers SET name = ?, icon = ?, last_seen = ? WHERE id = ?')
      .run(name, icon || null, now, guildId);
  }
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

// ─── Tokens ───────────────────────────────────────────────────
export function createToken(serverId, expiresAt, { isFreeTier, inviteLink, hereMinInterval, steamLimit }) {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  db.prepare(
    `INSERT INTO tokens (id, server_id, token, expires_at, is_free_tier, invite_link, here_min_interval, steam_limit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, serverId, token, expiresAt,
    isFreeTier ? 1 : 0,
    inviteLink || null,
    hereMinInterval || 0,
    steamLimit || 0,
    new Date().toISOString()
  );
  return { id, token };
}

export function getTokenByValue(tokenValue) {
  return db.prepare('SELECT * FROM tokens WHERE token = ?').get(tokenValue);
}

export function getActiveToken(guildId) {
  return db.prepare(
    `SELECT * FROM tokens WHERE server_id = ? AND is_activated = 1 AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(guildId, new Date().toISOString());
}

export function activateToken(tokenId, guildId) {
  db.prepare('UPDATE tokens SET is_activated = 1 WHERE id = ?').run(tokenId);
  db.prepare('UPDATE servers SET active_token_id = ?, is_active = 0 WHERE id = ?').run(tokenId, guildId);
}

export function incrementSteamUses(tokenId) {
  db.prepare('UPDATE tokens SET steam_uses = steam_uses + 1 WHERE id = ?').run(tokenId);
}

export function isServerAuthorized(guildId) {
  const server = getServer(guildId);
  if (!server) return false;
  if (server.is_active) return true;
  const token = getActiveToken(guildId);
  return !!(token && new Date(token.expires_at) > new Date());
}

export function isFreeTierServer(guildId) {
  const server = getServer(guildId);
  if (!server) return false;
  if (server.is_active) return false;
  const token = getActiveToken(guildId);
  if (token && new Date(token.expires_at) > new Date()) {
    return token.is_free_tier === 1;
  }
  return false;
}

export function getFreeTierInviteLink(guildId) {
  const token = getActiveToken(guildId);
  return token?.invite_link || process.env.BOT_OWNER_SERVER_INVITE || null;
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
