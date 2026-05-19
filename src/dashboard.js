import express from 'express';
import session from 'express-session';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ChannelType } from 'discord.js';
import {
  getAllServers, getServer, createToken, getAllTokens, getServerToken,
  getLogs, getRecentLogsAll, resetWarnings, setServerActive, setCommandPermission,
  addAllowedUser, removeAllowedUser, getAllowedUsers, addLog,
  setDashboardChannel, setServerInviteLink, autoActivateFreeTier,
  deleteToken, setTokenDisabled,
  getSetting, setSetting, getAllSettings,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin1234';
const SESSION_SECRET = process.env.SESSION_SECRET || 'steam-bot-dash-2025';

let discordClient = null;

export function startDashboard(client) {
  discordClient = client;

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '500kb' }));
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

  // ─── Stats ────────────────────────────────────────────────────────
  app.get('/api/stats', auth, (req, res) => {
    const servers  = getAllServers();
    const tokens   = getAllTokens();
    const now      = new Date();
    const online   = servers.filter(s => discordClient?.guilds.cache.has(s.id)).length;
    const paid     = servers.filter(s => {
      const t = getServerToken(s.id); return !!t;
    }).length;
    const freeTier = servers.filter(s =>
      !getServerToken(s.id) && s.free_tier_expires_at && new Date(s.free_tier_expires_at) > now
    ).length;
    const expiring = servers.filter(s => {
      const t = getServerToken(s.id);
      if (t) { const ms = new Date(t.expires_at) - now; return ms > 0 && ms < 3 * 86400000; }
      if (s.free_tier_expires_at) { const ms = new Date(s.free_tier_expires_at) - now; return ms > 0 && ms < 86400000; }
      return false;
    }).length;
    const warned   = servers.filter(s => s.warning_count >= 3).length;
    const tokensOk = tokens.filter(t => !t.disabled && new Date(t.expires_at) > now && !t.used_by_server_id).length;

    res.json({
      total_servers: servers.length,
      online,
      paid,
      free_tier: freeTier,
      inactive: servers.length - paid - freeTier,
      expiring_soon: expiring,
      warning_servers: warned,
      total_tokens: tokens.length,
      tokens_available: tokensOk,
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  // ─── Recent Activity (all servers) ────────────────────────────────
  app.get('/api/activity', auth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const logs  = getRecentLogsAll(limit);
    const servers = getAllServers();
    const nameMap = Object.fromEntries(servers.map(s => [s.id, s.name]));
    res.json(logs.map(l => ({ ...l, server_name: nameMap[l.server_id] || l.server_id })));
  });

  // ─── Servers ──────────────────────────────────────────────────────
  app.get('/api/servers', auth, (req, res) => {
    const servers = getAllServers();
    const enriched = servers.map(s => enrichServer(s));
    res.json(enriched);
  });

  function enrichServer(s) {
    const guild = discordClient?.guilds.cache.get(s.id);
    const activeToken = getServerToken(s.id);
    const freeTierActive = !activeToken && s.free_tier_expires_at && new Date(s.free_tier_expires_at) > new Date();
    return {
      ...s,
      member_count: guild?.memberCount || 0,
      online: !!guild,
      free_tier_active: freeTierActive,
      active_token: activeToken ? {
        expires_at: activeToken.expires_at,
        here_min_interval: activeToken.here_min_interval,
        steam_limit: activeToken.steam_limit,
        server_steam_uses: activeToken.server_steam_uses,
        label: activeToken.label,
        is_free_tier: activeToken.is_free_tier,
      } : null,
    };
  }

  app.get('/api/servers/:id', auth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    res.json({ ...enrichServer(server), allowed_users: getAllowedUsers(req.params.id) });
  });

  app.post('/api/servers/:id/toggle', auth, async (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const newState = !server.is_active;
    setServerActive(req.params.id, newState);
    addLog(req.params.id, 'MANUAL_TOGGLE', `تم ${newState ? 'تفعيل' : 'تعطيل'} السيرفر يدوياً`);
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      guild.channels.cache.get(server.dashboard_channel_id)
        ?.send(`${newState ? '✅' : '🔒'} تم ${newState ? 'تفعيل' : 'تعطيل'} البوت يدوياً من لوحة التحكم.`);
    }
    res.json({ ok: true, is_active: newState });
  });

  app.post('/api/servers/:id/extend-free', auth, async (req, res) => {
    const { days } = req.body;
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const d = Number(days) || Number(getSetting('free_tier_days', '2'));
    const expiresAt = autoActivateFreeTier(req.params.id, d);
    addLog(req.params.id, 'FREE_TIER_EXTENDED', `تم تمديد الفترة المجانية ${d} يوم`);
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      guild.channels.cache.get(server.dashboard_channel_id)
        ?.send(`🎁 تم تمديد الفترة المجانية حتى ${new Date(expiresAt).toLocaleDateString('ar-SA')}`);
    }
    res.json({ ok: true, free_tier_expires_at: expiresAt });
  });

  app.get('/api/servers/:id/logs', auth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(getLogs(req.params.id, limit));
  });

  app.post('/api/servers/:id/reset-warnings', auth, (req, res) => {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    resetWarnings(req.params.id);
    setServerActive(req.params.id, true);
    addLog(req.params.id, 'WARNINGS_RESET', 'تم إعادة ضبط التحذيرات من الداشبورد');
    const guild = discordClient?.guilds.cache.get(req.params.id);
    if (guild && server.dashboard_channel_id) {
      guild.channels.cache.get(server.dashboard_channel_id)
        ?.send('🔄 تم إعادة ضبط عداد التحذيرات وإعادة تفعيل البوت.');
    }
    res.json({ ok: true });
  });

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

  app.post('/api/servers/:id/invite-link', auth, (req, res) => {
    const { link } = req.body;
    setServerInviteLink(req.params.id, link);
    addLog(req.params.id, 'INVITE_LINK_SET', `تم تحديث رابط الدعوة: ${link}`);
    res.json({ ok: true });
  });

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

  // ─── Broadcast ────────────────────────────────────────────────────
  app.post('/api/broadcast', auth, async (req, res) => {
    const { message, target = 'all' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'الرسالة فارغة' });
    const servers = getAllServers();
    let sent = 0, failed = 0;
    for (const s of servers) {
      if (target === 'paid' && !getServerToken(s.id)) continue;
      if (target === 'free' && getServerToken(s.id)) continue;
      const guild = discordClient?.guilds.cache.get(s.id);
      if (!guild || !s.dashboard_channel_id) { failed++; continue; }
      const ch = guild.channels.cache.get(s.dashboard_channel_id);
      if (!ch) { failed++; continue; }
      try { await ch.send(message); sent++; }
      catch { failed++; }
    }
    addLog('SYSTEM', 'BROADCAST_SENT', `تم إرسال رسالة جماعية — وصل: ${sent} فشل: ${failed}`);
    res.json({ ok: true, sent, failed });
  });

  // ─── Tokens (Global) ──────────────────────────────────────────────
  app.get('/api/tokens', auth, (req, res) => res.json(getAllTokens()));

  app.post('/api/tokens', auth, (req, res) => {
    const { days = 0, hours = 0, minutes = 0, label = '',
            here_min_interval = 0, steam_limit = 0, is_free_tier = false } = req.body;
    const totalMs = (Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60) * 1000;
    if (totalMs <= 0) return res.status(400).json({ error: 'المدة يجب أن تكون أكبر من 0' });
    const expiresAt = new Date(Date.now() + totalMs).toISOString();
    const { token } = createToken({
      label, expiresAt,
      hereMinInterval: Number(here_min_interval),
      steamLimit: Number(steam_limit),
      isFreeTier: !!is_free_tier,
    });
    addLog('SYSTEM', 'TOKEN_CREATED',
      `توكن جديد [${label || 'بدون تسمية'}]${is_free_tier ? ' [Free]' : ''} — ينتهي: ${expiresAt}`);
    res.json({ ok: true, token, expires_at: expiresAt });
  });

  app.delete('/api/tokens/:id', auth, (req, res) => {
    deleteToken(req.params.id);
    addLog('SYSTEM', 'TOKEN_DELETED', `تم حذف توكن: ${req.params.id}`);
    res.json({ ok: true });
  });

  app.post('/api/tokens/:id/toggle', auth, (req, res) => {
    const tokens = getAllTokens();
    const t = tokens.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'التوكن غير موجود' });
    const newDisabled = !t.disabled;
    setTokenDisabled(req.params.id, newDisabled);
    addLog('SYSTEM', newDisabled ? 'TOKEN_DISABLED' : 'TOKEN_ENABLED',
      `تم ${newDisabled ? 'تعطيل' : 'تفعيل'} التوكن: ${t.label || req.params.id}`);
    res.json({ ok: true, disabled: newDisabled });
  });

  app.post('/api/tokens/send', auth, async (req, res) => {
    const { token, server_id } = req.body;
    if (!token || !server_id) return res.status(400).json({ error: 'token و server_id مطلوبان' });
    const server = getServer(server_id);
    if (!server) return res.status(404).json({ error: 'السيرفر غير موجود' });
    const guild = discordClient?.guilds.cache.get(server_id);
    if (!guild || !server.dashboard_channel_id) return res.status(404).json({ error: 'روم الداشبورد غير متاح' });
    const ch = guild.channels.cache.get(server.dashboard_channel_id);
    if (!ch) return res.status(404).json({ error: 'الروم غير موجود' });
    await ch.send(
      `🔑 **توكن تفعيل جديد**\n\`\`\`${token}\`\`\`\n🚀 استخدم الأمر: \`/active ${token}\``
    );
    addLog(server_id, 'TOKEN_SENT', 'تم إرسال توكن للسيرفر');
    res.json({ ok: true });
  });

  // ─── Bot Settings ─────────────────────────────────────────────────
  app.get('/api/settings', auth, (req, res) => {
    res.json(getAllSettings());
  });

  app.post('/api/settings', auth, (req, res) => {
    const allowed = [
      'free_tier_days', 'free_tier_here_min', 'free_tier_steam_limit',
      'ad_invite', 'ad_message', 'dm_tutorial_enabled', 'dm_tutorial_text',
    ];
    const body = req.body;
    const updated = [];
    for (const key of allowed) {
      if (key in body) {
        setSetting(key, body[key]);
        updated.push(key);
      }
    }
    if (updated.length === 0) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    addLog('SYSTEM', 'SETTINGS_UPDATED', `تحديث الإعدادات: ${updated.join(', ')}`);
    res.json({ ok: true, updated });
  });

  // ─── SSE real-time updates ─────────────────────────────────────────
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => {
      try {
        const servers = getAllServers().map(s => {
          const guild = discordClient?.guilds.cache.get(s.id);
          const activeToken = getServerToken(s.id);
          const freeTierActive = !activeToken && s.free_tier_expires_at && new Date(s.free_tier_expires_at) > new Date();
          return {
            id: s.id, name: s.name, icon: s.icon,
            is_active: s.is_active, warning_count: s.warning_count,
            command_permission: s.command_permission,
            free_tier_expires_at: s.free_tier_expires_at,
            free_tier_active: freeTierActive,
            member_count: guild?.memberCount || 0,
            online: !!guild,
            active_token: activeToken ? {
              expires_at: activeToken.expires_at,
              here_min_interval: activeToken.here_min_interval,
              steam_limit: activeToken.steam_limit,
              server_steam_uses: activeToken.server_steam_uses,
              label: activeToken.label,
              is_free_tier: activeToken.is_free_tier,
            } : null,
          };
        });
        res.write(`data: ${JSON.stringify(servers)}\n\n`);
      } catch {}
    };

    send();
    const interval = setInterval(send, 15000);
    req.on('close', () => clearInterval(interval));
  });

  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 الداشبورد شغّال على البورت ${PORT}`);
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || `localhost:${PORT}`;
    console.log(`🔗 الرابط: https://${domain}`);
  });
}
