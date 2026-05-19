import express from 'express';
import session from 'express-session';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ChannelType } from 'discord.js';
import {
  getAllServers, getServer, createToken, getActiveToken,
  getLogs, resetWarnings, setServerActive, setCommandPermission,
  addAllowedUser, removeAllowedUser, getAllowedUsers, addLog,
  setDashboardChannel, setServerInviteLink,
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

  app.get('/', (req, res) =>
    res.redirect(req.session.loggedIn ? '/app.html' : '/login.html')
  );

  const auth = (req, res, next) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'غير مصرح' });
    next();
  };

  // ─── Auth ─────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
      req.session.loggedIn = true;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  });

  app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
  app.get('/api/me', auth, (req, res) => res.json({ username: DASHBOARD_USER }));

  // ─── Servers ──────────────────────────────────────────────────────
  app.get('/api/servers', auth, (req, res) => {
    const servers = getAllServers();
    const enriched = servers.map(s => {
      const guild = discordClient?.guilds.cache.get(s.id);
      const activeToken = getActiveToken(s.id);
      return {
        ...s,
        member_count: guild?.memberCount || 0,
        online: !!guild,
        active_token: activeToken ? {
          expires_at: activeToken.expires_at,
          is_free_tier: activeToken.is_free_tier,
          here_min_interval: activeToken.here_min_interval,
          steam_limit: activeToken.steam_limit,
          steam_uses: activeToken.steam_uses,
          invite_link: activeToken.invite_link,
        } : null,
      };
    });
    res.json(enriched);
  });

  app.get('/api/servers/:id', auth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const guild = discordClient?.guilds.cache.get(req.params.id);
    const activeToken = getActiveToken(req.params.id);
    res.json({
      ...server,
      member_count: guild?.memberCount || 0,
      online: !!guild,
      active_token: activeToken || null,
      allowed_users: getAllowedUsers(req.params.id),
    });
  });

  // Toggle active
  app.post('/api/servers/:id/toggle', auth, async (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const newState = !server.is_active;
    setServerActive(req.params.id, newState);
    addLog(req.params.id, 'MANUAL_TOGGLE', `تم ${newState ? 'تفعيل' : 'تعطيل'} السيرفر يدوياً`);
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      const ch = guild.channels.cache.get(server.dashboard_channel_id);
      ch?.send(`${newState ? '✅' : '🔒'} تم ${newState ? 'تفعيل' : 'تعطيل'} البوت يدوياً من لوحة التحكم.`);
    }
    res.json({ ok: true, is_active: newState });
  });

  // Generate token
  app.post('/api/servers/:id/token', auth, async (req, res) => {
    const { days = 0, hours = 0, minutes = 0, is_free_tier = false,
            invite_link = '', here_min_interval = 0, steam_limit = 0 } = req.body;
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const totalMs = (Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60) * 1000;
    if (totalMs <= 0) return res.status(400).json({ error: 'المدة يجب أن تكون أكبر من 0' });
    const expiresAt = new Date(Date.now() + totalMs).toISOString();
    const { token } = createToken(req.params.id, expiresAt, {
      isFreeTier: is_free_tier,
      inviteLink: invite_link,
      hereMinInterval: Number(here_min_interval),
      steamLimit: Number(steam_limit),
    });
    addLog(req.params.id, 'TOKEN_CREATED',
      `توكن جديد — ينتهي: ${expiresAt} — free: ${is_free_tier} — here_min: ${here_min_interval}د — steam_limit: ${steam_limit}`);
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      const ch = guild.channels.cache.get(server.dashboard_channel_id);
      const tierLabel = is_free_tier ? '🆓 مجاني' : '💎 مميز';
      const expiresDate = new Date(expiresAt).toLocaleString('ar-SA');
      const lines = [`🔑 **تم إنشاء توكن جديد**\n\`\`\`${token}\`\`\``, `📋 ${tierLabel} | ⏰ ${expiresDate}`];
      if (Number(here_min_interval) > 0) lines.push(`⏱ الحد الأدنى لـ /here: ${here_min_interval} دقيقة`);
      if (Number(steam_limit) > 0) lines.push(`🔍 حد /steam: ${steam_limit} استخدام`);
      lines.push(`\n🚀 استخدم: \`/active ${token}\``);
      ch?.send(lines.join('\n'));
    }
    res.json({ ok: true, token, expires_at: expiresAt });
  });

  // Logs
  app.get('/api/servers/:id/logs', auth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getLogs(req.params.id, limit));
  });

  // Reset warnings
  app.post('/api/servers/:id/reset-warnings', auth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    resetWarnings(req.params.id);
    addLog(req.params.id, 'WARNINGS_RESET', 'تم إعادة ضبط التحذيرات من الداشبورد');
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      guild.channels.cache.get(server.dashboard_channel_id)?.send('🔄 تم إعادة ضبط عداد التحذيرات من صاحب البوت.');
    }
    res.json({ ok: true });
  });

  // Permissions
  app.post('/api/servers/:id/permission', auth, (req, res) => {
    const { permission } = req.body;
    if (!['owner', 'everyone', 'specific'].includes(permission))
      return res.status(400).json({ error: 'نوع الصلاحية غير صحيح' });
    setCommandPermission(req.params.id, permission);
    addLog(req.params.id, 'PERMISSION_CHANGED', `تغيير الصلاحية: ${permission}`);
    res.json({ ok: true });
  });

  app.post('/api/servers/:id/allowed-users', auth, (req, res) => {
    const { user_id, action } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });
    if (action === 'add') addAllowedUser(req.params.id, user_id);
    else if (action === 'remove') removeAllowedUser(req.params.id, user_id);
    else return res.status(400).json({ error: 'action غير صحيح' });
    res.json({ ok: true, users: getAllowedUsers(req.params.id) });
  });

  // Invite link (set custom)
  app.post('/api/servers/:id/invite-link', auth, (req, res) => {
    const { link } = req.body;
    setServerInviteLink(req.params.id, link);
    addLog(req.params.id, 'INVITE_LINK_SET', `تم تحديث رابط الدعوة: ${link}`);
    res.json({ ok: true });
  });

  // Get/generate Discord invite to the server
  app.post('/api/servers/:id/get-invite', auth, async (req, res) => {
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'السيرفر غير متصل حالياً' });
    try {
      const channel = guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('CreateInstantInvite')
      );
      if (!channel) return res.status(403).json({ error: 'لا يوجد روم يمكن إنشاء دعوة منه' });
      const invite = await channel.createInvite({ maxAge: 86400, maxUses: 5, reason: 'طلب من الداشبورد' });
      addLog(req.params.id, 'INVITE_GENERATED', `تم إنشاء رابط دعوة: ${invite.url}`);
      res.json({ ok: true, invite_url: invite.url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Kick bot from server
  app.post('/api/servers/:id/kick', auth, async (req, res) => {
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'السيرفر غير متصل حالياً' });
    try {
      addLog(req.params.id, 'BOT_KICKED', 'تم إخراج البوت يدوياً من الداشبورد');
      await guild.leave();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE for real-time updates
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => {
      const servers = getAllServers().map(s => {
        const guild = discordClient?.guilds.cache.get(s.id);
        const activeToken = getActiveToken(s.id);
        return {
          id: s.id, name: s.name, icon: s.icon,
          is_active: s.is_active, warning_count: s.warning_count,
          command_permission: s.command_permission,
          member_count: guild?.memberCount || 0,
          online: !!guild,
          active_token: activeToken ? {
            expires_at: activeToken.expires_at,
            is_free_tier: activeToken.is_free_tier,
            here_min_interval: activeToken.here_min_interval,
            steam_limit: activeToken.steam_limit,
            steam_uses: activeToken.steam_uses,
          } : null,
        };
      });
      res.write(`data: ${JSON.stringify(servers)}\n\n`);
    };

    send();
    const interval = setInterval(send, 15000);
    req.on('close', () => clearInterval(interval));
  });

  app.listen(PORT, () => console.log(`🌐 الداشبورد على البورت ${PORT}`));
}
