import express from 'express';
import session from 'express-session';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getAllServers,
  getServer,
  createToken,
  getActiveToken,
  getLogs,
  resetWarnings,
  setServerActive,
  setCommandPermission,
  addAllowedUser,
  removeAllowedUser,
  getAllowedUsers,
  addLog,
  setDashboardChannel,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'QWPN';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '2005qwpnhamdan2005';
const SESSION_SECRET = process.env.SESSION_SECRET || 'steam-bot-dash-2025';

let discordClient = null;

export function startDashboard(client) {
  discordClient = client;

  const app = express();
  const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }));

  app.use(express.static(join(__dirname, '../dashboard/public')));

  app.get('/', (req, res) => {
    if (req.session.loggedIn) {
      res.redirect('/app.html');
    } else {
      res.redirect('/login.html');
    }
  });

  const requireAuth = (req, res, next) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'غير مصرح' });
    next();
  };

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
      req.session.loggedIn = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: DASHBOARD_USER });
  });

  app.get('/api/servers', requireAuth, (req, res) => {
    const servers = getAllServers();
    const enriched = servers.map(s => {
      const guild = discordClient?.guilds.cache.get(s.id);
      const activeToken = getActiveToken(s.id);
      return {
        ...s,
        member_count: guild?.memberCount || 0,
        online: !!guild,
        active_token: activeToken
          ? {
              expires_at: activeToken.expires_at,
              is_free_tier: activeToken.is_free_tier,
            }
          : null,
      };
    });
    res.json(enriched);
  });

  app.get('/api/servers/:id', requireAuth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const guild = discordClient?.guilds.cache.get(req.params.id);
    const activeToken = getActiveToken(req.params.id);
    const allowedUsers = getAllowedUsers(req.params.id);
    res.json({
      ...server,
      member_count: guild?.memberCount || 0,
      online: !!guild,
      active_token: activeToken || null,
      allowed_users: allowedUsers,
    });
  });

  app.post('/api/servers/:id/toggle', requireAuth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const newState = !server.is_active;
    setServerActive(req.params.id, newState);
    addLog(req.params.id, 'MANUAL_TOGGLE', `تم ${newState ? 'تفعيل' : 'تعطيل'} السيرفر يدوياً من الداشبورد`);
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      const ch = guild.channels.cache.get(server.dashboard_channel_id);
      ch?.send(`${newState ? '✅' : '🔒'} تم ${newState ? 'تفعيل' : 'تعطيل'} البوت يدوياً من قِبل صاحب البوت.`);
    }
    res.json({ ok: true, is_active: newState });
  });

  app.post('/api/servers/:id/token', requireAuth, (req, res) => {
    const { days = 0, hours = 0, minutes = 0, is_free_tier = false } = req.body;
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });

    const totalMs = (Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60) * 1000;
    if (totalMs <= 0) return res.status(400).json({ error: 'المدة يجب أن تكون أكبر من 0' });

    const expiresAt = new Date(Date.now() + totalMs).toISOString();
    const { token } = createToken(req.params.id, expiresAt, is_free_tier);

    addLog(req.params.id, 'TOKEN_CREATED', `توكن جديد — ينتهي: ${expiresAt} — free tier: ${is_free_tier}`);

    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      const ch = guild.channels.cache.get(server.dashboard_channel_id);
      const tierLabel = is_free_tier ? '🆓 مجاني' : '💎 مميز';
      const expiresDate = new Date(expiresAt).toLocaleString('ar-SA');
      ch?.send(
        `🔑 **تم إنشاء توكن جديد لهذا السيرفر**\n\n` +
        `\`\`\`${token}\`\`\`\n` +
        `📋 النوع: ${tierLabel}\n` +
        `⏰ ينتهي: ${expiresDate}\n\n` +
        `🚀 **للتفعيل، استخدم الأمر:**\n\`/active ${token}\``
      );
    }

    res.json({ ok: true, token, expires_at: expiresAt });
  });

  app.get('/api/servers/:id/logs', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logs = getLogs(req.params.id, limit);
    res.json(logs);
  });

  app.post('/api/servers/:id/reset-warnings', requireAuth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    resetWarnings(req.params.id);
    addLog(req.params.id, 'WARNINGS_RESET', 'تم إعادة ضبط عداد التحذيرات من الداشبورد');
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      const ch = guild.channels.cache.get(server.dashboard_channel_id);
      ch?.send('🔄 تم إعادة ضبط عداد التحذيرات من قِبل صاحب البوت.');
    }
    res.json({ ok: true });
  });

  app.post('/api/servers/:id/permission', requireAuth, (req, res) => {
    const { permission, user_ids = [] } = req.body;
    if (!['owner', 'everyone', 'specific'].includes(permission)) {
      return res.status(400).json({ error: 'نوع الصلاحية غير صحيح' });
    }
    setCommandPermission(req.params.id, permission);
    addLog(req.params.id, 'PERMISSION_CHANGED', `تغيير صلاحية الأوامر إلى: ${permission}`);
    res.json({ ok: true });
  });

  app.post('/api/servers/:id/allowed-users', requireAuth, (req, res) => {
    const { user_id, action } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });
    if (action === 'add') addAllowedUser(req.params.id, user_id);
    else if (action === 'remove') removeAllowedUser(req.params.id, user_id);
    else return res.status(400).json({ error: 'action غير صحيح' });
    res.json({ ok: true, users: getAllowedUsers(req.params.id) });
  });

  app.listen(PORT, () => {
    console.log(`🌐 الداشبورد يعمل على البورت ${PORT}`);
  });
}
