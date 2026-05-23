import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
} from 'discord.js';
import { searchGame } from './search.js';
import { startScheduler, stopScheduler, trackedAdMessages } from './scheduler.js';
import { startDashboard } from './dashboard.js';
import {
  upsertServer, setDashboardChannel, setSetupChannel,
  setHereDefaultInterval, setCommandPermission,
  getServer, isServerAuthorized, shouldSendAd, isPaidPlan,
  addLog, getTokenByValue, getServerToken, activateToken,
  incrementWarning, incrementSteamUses, incrementFreeTierSteamUses,
  setServerActive, isUserAllowed, updateLastSeen,
  autoActivateFreeTier, getSteamLimitInfo, getHereMinInterval,
  getSetting, getAllowedUsers, addAllowedUser, removeAllowedUser,
  addAllowedRole, removeAllowedRole, getAllowedRoles, isRoleAllowed,
} from './db.js';

const token = process.env.DISCORD_TOKEN;
export const BOT_OWNER_ID = process.env.BOT_OWNER_DISCORD_ID || '';

if (!token) { console.error('❌ DISCORD_TOKEN غير موجود'); process.exit(1); }
if (!process.env.GROQ_API_KEY) { console.error('❌ GROQ_API_KEY غير موجود'); process.exit(1); }

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const commands = [
  new SlashCommandBuilder()
    .setName('steam')
    .setDescription('ابحث عن حساب Steam للعبة معينة')
    .addStringOption(o => o.setName('game').setDescription('اسم اللعبة').setRequired(true)),
  new SlashCommandBuilder()
    .setName('here')
    .setDescription('يبدأ البوت ينشر حسابات Steam كل فترة')
    .addIntegerOption(o =>
      o.setName('min').setDescription('كم دقيقة بين كل نشر (اتركه فارغاً لاستخدام الافتراضي)')
        .setRequired(false).setMinValue(1).setMaxValue(1440)
    ),
  new SlashCommandBuilder()
    .setName('stophere')
    .setDescription('يوقف النشر التلقائي في هذا الروم'),
  new SlashCommandBuilder()
    .setName('active')
    .setDescription('تفعيل البوت باستخدام التوكن')
    .addStringOption(o => o.setName('token').setDescription('التوكن').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('ينشئ روم إعدادات البوت الخاص بسيرفرك (للأونر فقط)'),
].map(cmd => cmd.toJSON());

// ─── Helpers ──────────────────────────────────────────────────
function adInvite() { return getSetting('ad_invite', process.env.BOT_OWNER_SERVER_INVITE || 'https://discord.gg/example'); }

async function canUseCommands(interaction) {
  if (!interaction.guild) return false;
  if (BOT_OWNER_ID && interaction.user.id === BOT_OWNER_ID) return true;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  const server = getServer(interaction.guildId);
  if (!server) return false;
  if (server.command_permission === 'everyone') return true;
  if (server.command_permission === 'specific') {
      if (isUserAllowed(interaction.guildId, interaction.user.id)) return true;
      const roles = getAllowedRoles(interaction.guildId);
      if (roles.length > 0 && interaction.member) {
        for (const r of roles) {
          if (interaction.member.roles?.cache?.has(r.role_id)) return true;
        }
      }
      return false;
    }
    return false;
  }

function planLabel(guildId) {
  const server = getServer(guildId);
  const paid = isPaidPlan(guildId);
  if (paid) {
    const tok = getServerToken(guildId);
    const exp = new Date(tok.expires_at).toLocaleDateString('ar-SA');
    return { text: `✅ مدفوع — ينتهي ${exp}`, isPaid: true };
  }
  if (server?.free_tier_expires_at && new Date(server.free_tier_expires_at) > new Date()) {
    const exp = new Date(server.free_tier_expires_at).toLocaleDateString('ar-SA');
    return { text: `🆓 مجاني — ينتهي ${exp}`, isPaid: false };
  }
  return { text: '❌ منتهي — يحتاج توكن جديد', isPaid: false };
}

function permLabel(p) {
  if (p === 'everyone') return '🌍 الجميع';
  if (p === 'specific') return '👥 مستخدمون محددون';
  return '👑 الأونر فقط';
}

// ─── Specific Permission Panel ─────────────────────────────────
  async function sendSpecificPermPanel(channel, guildId) {
    const allowedUsers = getAllowedUsers(guildId);
    const allowedRoles = getAllowedRoles(guildId);

    const usersText = allowedUsers.length
      ? allowedUsers.map(u => `<@${u.user_id}>`).join(' ')
      : 'لا يوجد مستخدمون مضافون';
    const rolesText = allowedRoles.length
      ? allowedRoles.map(r => `<@&${r.role_id}>`).join(' ')
      : 'لا توجد رولات مضافة';

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('👥 إدارة الصلاحيات المحددة')
      .setDescription(
        'اختر المستخدمين أو الرولات اللي تقدر تستخدم أوامر البوت.\n' +
        '> الأونر يقدر يستخدم الأوامر دائماً.'
      )
      .addFields(
        { name: '👤 المستخدمون المسموح لهم', value: usersText, inline: false },
        { name: '🎭 الرولات المسموح بها', value: rolesText, inline: false }
      )
      .setTimestamp();

    const components = [];

    components.push(new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`setup_add_users_${guildId}`)
        .setPlaceholder('➕ اختر مستخدمين لإضافتهم')
        .setMinValues(1).setMaxValues(10)
    ));

    components.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`setup_add_roles_${guildId}`)
        .setPlaceholder('➕ اختر رولات لإضافتها')
        .setMinValues(1).setMaxValues(10)
    ));

    if (allowedUsers.length > 0) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup_remove_user_${guildId}`)
          .setPlaceholder('❌ اختر مستخدماً لإزالته')
          .setMinValues(1).setMaxValues(1)
          .addOptions(allowedUsers.slice(0, 25).map(u => ({
            label: `إزالة: ${u.user_id}`,
            value: u.user_id,
          })))
      ));
    }

    if (allowedRoles.length > 0) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup_remove_role_${guildId}`)
          .setPlaceholder('❌ اختر رولاً لإزالته')
          .setMinValues(1).setMaxValues(1)
          .addOptions(allowedRoles.slice(0, 25).map(r => ({
            label: `إزالة رول: ${r.role_id}`,
            value: r.role_id,
          })))
      ));
    }

    try {
      const msgs = await channel.messages.fetch({ limit: 10 });
      const old = msgs.filter(m => m.author.id === client.user.id && m.embeds?.[0]?.title === '👥 إدارة الصلاحيات المحددة');
      for (const m of old.values()) await m.delete().catch(() => {});
    } catch {}

    await channel.send({ embeds: [embed], components });
  }

  // ─── Settings Panel ────────────────────────────────────────────
async function sendSettingsPanel(channel, guildId) {
  const server = getServer(guildId);
  const plan   = planLabel(guildId);
  const isPaid = plan.isPaid;
  const perm   = server?.command_permission || 'owner';
  const defInterval = server?.here_default_interval || 0;
  const tokenMin    = getHereMinInterval(guildId);

  const embed = new EmbedBuilder()
    .setColor(isPaid ? 0x22c55e : 0xf59e0b)
    .setTitle('⚙️ إعدادات البوت')
    .setDescription(`**الخطة:** ${plan.text}`)
    .addFields(
      {
        name: '🔐 من يقدر يستخدم الأوامر',
        value: `الإعداد الحالي: **${permLabel(perm)}**\n✅ يمكنك التعديل دائماً`,
        inline: false,
      },
      {
        name: `⏱️ الفترة الافتراضية لـ /here${isPaid ? '' : ' 🔒'}`,
        value: isPaid
          ? `الإعداد الحالي: **${defInterval > 0 ? defInterval + ' دقيقة' : 'غير محدد'}**\n` +
            (tokenMin > 0 ? `⚠️ توكنك يفرض حداً أدنى: ${tokenMin} دقيقة\n` : '') +
            `✅ يمكنك التعديل`
          : `الإعداد الحالي: **${defInterval > 0 ? defInterval + ' دقيقة' : 'غير محدد'}**\n🔒 **مقفل** — يحتاج توكن مدفوع`,
        inline: false,
      },
      {
        name: '💡 الأوامر',
        value:
          '`/steam <لعبة>` — ابحث عن حساب Steam\n' +
          '`/here [دقائق]` — نشر تلقائي\n' +
          '`/stophere` — إيقاف النشر\n' +
          '`/active <توكن>` — تفعيل توكن جديد',
        inline: false,
      }
    )
    .setFooter({ text: 'آخر تحديث' })
    .setTimestamp();

  if (!isPaid) {
    embed.addFields({
      name: '🛒 ترقية للخطة المدفوعة',
      value: `تواصل مع صاحب البوت للحصول على توكن.\n🔗 ${adInvite()}`,
      inline: false,
    });
  }

  const permRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup_perm_${guildId}`)
      .setPlaceholder('🔐 اختر من يقدر يستخدم الأوامر')
      .addOptions([
        { label: '👑 الأونر فقط',  value: 'owner',    description: 'فقط صاحب السيرفر', default: perm === 'owner' },
        { label: '🌍 الجميع',      value: 'everyone', description: 'كل الأعضاء',        default: perm === 'everyone' },
        { label: '👥 محددون',      value: 'specific', description: 'قائمة محددة',        default: perm === 'specific' },
      ])
  );

  const intervalOptions = [
    { label: '🚫 بدون تحديد',  value: '0' },
    { label: '5 دقائق',         value: '5' },
    { label: '10 دقائق',        value: '10' },
    { label: '15 دقيقة',        value: '15' },
    { label: '30 دقيقة',        value: '30' },
    { label: '60 دقيقة',        value: '60' },
    { label: '120 دقيقة',       value: '120' },
    { label: '180 دقيقة',       value: '180' },
    { label: '360 دقيقة',       value: '360' },
  ].map(o => ({ ...o, default: String(defInterval) === o.value }));

  const intervalRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup_interval_${guildId}`)
      .setPlaceholder(isPaid ? '⏱️ اختر الفترة الافتراضية' : '🔒 مقفل — يحتاج توكن مدفوع')
      .setDisabled(!isPaid)
      .addOptions(intervalOptions)
  );

  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    const botMsgs = msgs.filter(m => m.author.id === client.user.id);
    if (botMsgs.size > 0) await channel.bulkDelete(botMsgs).catch(() => {});
  } catch {}

  await channel.send({ embeds: [embed], components: [permRow, intervalRow] });
}

// ─── DM Tutorial ──────────────────────────────────────────────
async function sendOwnerTutorial(owner, guildName, freeTierExpiry) {
  const enabled = getSetting('dm_tutorial_enabled', '1');
  if (enabled !== '1') return;

  const days    = getSetting('free_tier_days', '2');
  const expDate = new Date(freeTierExpiry).toLocaleDateString('ar-SA');
  const invite  = adInvite();

  let text = getSetting('dm_tutorial_text', '');
  if (!text) return;

  text = text
    .replace(/\{guild\}/g,  guildName)
    .replace(/\{expiry\}/g, expDate)
    .replace(/\{days\}/g,   days)
    .replace(/\{invite\}/g, invite);

  try {
    await owner.send(text);
  } catch (err) {
    console.error(`❌ فشل إرسال DM للأونر ${owner.user?.tag || owner.tag}:`, err.message);
  }
}

// ─── Events ───────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ البوت شغّال: ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ تم تسجيل الأوامر');
  } catch (err) {
    console.error('❌ خطأ في تسجيل الأوامر:', err.message);
  }
  for (const guild of client.guilds.cache.values()) {
    upsertServer(guild.id, guild.name, guild.icon);
  }
  startDashboard(client);
});

client.on('guildCreate', async guild => {
  console.log(`📥 انضم للسيرفر: ${guild.name} (${guild.id})`);
  upsertServer(guild.id, guild.name, guild.icon);
  const freeTierDays = Number(getSetting('free_tier_days', '2'));
  const freeTierExpiry = autoActivateFreeTier(guild.id, freeTierDays);
  addLog(guild.id, 'BOT_JOINED', `انضم البوت لسيرفر ${guild.name} — free tier ${freeTierDays} يوم`);

  try {
    const owner = await guild.fetchOwner();
    const dashChannel = await guild.channels.create({
      name: '🤖・dashboard',
      type: ChannelType.GuildText,
      topic: 'لوحة تحكم البوت',
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    setDashboardChannel(guild.id, dashChannel.id);
    const expiryDate = new Date(freeTierExpiry).toLocaleDateString('ar-SA');
    await dashChannel.send(
      `👋 مرحباً **${owner.user.username}**!\n\n` +
      `🎉 **تم تفعيل البوت تلقائياً لمدة ${freeTierDays} يوم** (ينتهي: ${expiryDate})\n\n` +
      `⚙️ اكتب \`/setup\` في أي روم لإنشاء روم الإعدادات الخاص بك.\n` +
      `📬 تم إرسال شرح كامل للبوت بالخاص.`
    );
    await sendOwnerTutorial(owner, guild.name, freeTierExpiry);
  } catch (err) {
    console.error(`❌ خطأ في إعداد سيرفر ${guild.name}:`, err.message);
  }
});

client.on('guildDelete', guild => {
  console.log(`📤 غادر السيرفر: ${guild.name}`);
  addLog(guild.id, 'BOT_LEFT', `غادر البوت سيرفر ${guild.name}`);
});

client.on('messageDelete', async message => {
  if (!message.guildId) return;
  if (!trackedAdMessages.has(message.id)) return;
  const guildId = trackedAdMessages.get(message.id);
  trackedAdMessages.delete(message.id);
  const count = incrementWarning(guildId);
  addLog(guildId, 'AD_DELETED', `تم حذف رسالة الإعلان — التحذير ${count}/6`);
  const server = getServer(guildId);
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    let warnChannel = server?.dashboard_channel_id
      ? guild.channels.cache.get(server.dashboard_channel_id)
      : message.channel;
    if (!warnChannel) warnChannel = message.channel;
    if (count < 6) {
      await warnChannel?.send(
        `⚠️ **تحذير ${count}/6** — تم حذف رسالة الإعلان.\n` +
        `بعد ${6 - count} تحذير إضافي سيتوقف البوت.`
      );
    } else {
      await warnChannel?.send(
        `🚫 **تحذير 6/6 — تم إيقاف البوت**\nتواصل مع صاحب البوت لإعادة التفعيل.`
      );
      setServerActive(guildId, false);
      stopScheduler(message.channelId);
      addLog(guildId, 'SERVER_DEACTIVATED', 'تم إيقاف السيرفر بسبب 6 تحذيرات');
    }
  } catch (err) {
    console.error('❌ خطأ في معالجة حذف الإعلان:', err.message);
  }
});

// ─── Interactions ─────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  const { guildId } = interaction;
  if (!guildId) return;

  // ── Select menus ────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;

    if (id.startsWith('setup_perm_')) {
      const tGid = id.replace('setup_perm_', '');
      if (interaction.user.id !== interaction.guild?.ownerId)
        return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
      setCommandPermission(tGid, interaction.values[0]);
      addLog(tGid, 'SETUP_PERM_CHANGED', `تغيير الصلاحية: ${interaction.values[0]}`);
      await interaction.deferUpdate();
      const s = getServer(tGid);
      if (s?.setup_channel_id) {
        const ch = interaction.guild?.channels.cache.get(s.setup_channel_id);
        if (ch) {
            await sendSettingsPanel(ch, tGid);
            if (interaction.values[0] === 'specific') {
              await sendSpecificPermPanel(ch, tGid);
            }
          }
        }
        return;
      }

      if (id.startsWith('setup_interval_')) {
      const tGid = id.replace('setup_interval_', '');
      if (interaction.user.id !== interaction.guild?.ownerId)
        return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
      if (!isPaidPlan(tGid))
        return interaction.reply({ content: '🔒 يحتاج توكن مدفوع.', ephemeral: true });
      setHereDefaultInterval(tGid, Number(interaction.values[0]));
      addLog(tGid, 'SETUP_INTERVAL_CHANGED', `تغيير الفترة الافتراضية: ${interaction.values[0]} دقيقة`);
      await interaction.deferUpdate();
      const s = getServer(tGid);
      if (s?.setup_channel_id) {
        const ch = interaction.guild?.channels.cache.get(s.setup_channel_id);
        if (ch) await sendSettingsPanel(ch, tGid);
      }
      return;
      }

      if (id.startsWith('setup_remove_user_')) {
        const tGid = id.replace('setup_remove_user_', '');
        if (interaction.user.id !== interaction.guild?.ownerId)
          return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
        removeAllowedUser(tGid, interaction.values[0]);
        addLog(tGid, 'ALLOWED_USER_REMOVED', `إزالة مستخدم: ${interaction.values[0]}`);
        await interaction.deferUpdate();
        const sRU = getServer(tGid);
        if (sRU?.setup_channel_id) {
          const ch = interaction.guild?.channels.cache.get(sRU.setup_channel_id);
          if (ch) await sendSpecificPermPanel(ch, tGid);
        }
        return;
      }

      if (id.startsWith('setup_remove_role_')) {
        const tGid = id.replace('setup_remove_role_', '');
        if (interaction.user.id !== interaction.guild?.ownerId)
          return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
        removeAllowedRole(tGid, interaction.values[0]);
        addLog(tGid, 'ALLOWED_ROLE_REMOVED', `إزالة رول: ${interaction.values[0]}`);
        await interaction.deferUpdate();
        const sRR = getServer(tGid);
        if (sRR?.setup_channel_id) {
          const ch = interaction.guild?.channels.cache.get(sRR.setup_channel_id);
          if (ch) await sendSpecificPermPanel(ch, tGid);
        }
        return;
      }

      return;
    }

    // ── User Select Menu ──────────────────────────────────────────
    if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith('setup_add_users_')) {
        const tGid = id.replace('setup_add_users_', '');
        if (interaction.user.id !== interaction.guild?.ownerId)
          return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
        for (const userId of interaction.values) addAllowedUser(tGid, userId);
        addLog(tGid, 'ALLOWED_USERS_ADDED', `إضافة مستخدمين: ${interaction.values.join(', ')}`);
        await interaction.deferUpdate();
        const sAU = getServer(tGid);
        if (sAU?.setup_channel_id) {
          const ch = interaction.guild?.channels.cache.get(sAU.setup_channel_id);
          if (ch) await sendSpecificPermPanel(ch, tGid);
        }
      }
      return;
    }

    // ── Role Select Menu ──────────────────────────────────────────
    if (interaction.isRoleSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith('setup_add_roles_')) {
        const tGid = id.replace('setup_add_roles_', '');
        if (interaction.user.id !== interaction.guild?.ownerId)
          return interaction.reply({ content: '🚫 للأونر فقط.', ephemeral: true });
        for (const roleId of interaction.values) addAllowedRole(tGid, roleId);
        addLog(tGid, 'ALLOWED_ROLES_ADDED', `إضافة رولات: ${interaction.values.join(', ')}`);
        await interaction.deferUpdate();
        const sAR = getServer(tGid);
        if (sAR?.setup_channel_id) {
          const ch = interaction.guild?.channels.cache.get(sAR.setup_channel_id);
          if (ch) await sendSpecificPermPanel(ch, tGid);
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  updateLastSeen(guildId);

  // ── /setup ──────────────────────────────────────────────────
  if (commandName === 'setup') {
    if (interaction.user.id !== interaction.guild?.ownerId)
      return interaction.reply({ content: '🚫 أمر /setup للأونر فقط.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const server = getServer(guildId);
    if (server?.setup_channel_id) {
      const existing = interaction.guild.channels.cache.get(server.setup_channel_id);
      if (existing) {
        await sendSettingsPanel(existing, guildId);
        return interaction.editReply(`✅ تم تحديث روم الإعدادات: ${existing}`);
      }
    }
    try {
      const owner = await interaction.guild.fetchOwner();
      const setupChannel = await interaction.guild.channels.create({
        name: '⚙️・bot-settings',
        type: ChannelType.GuildText,
        topic: 'إعدادات البوت — للأونر فقط',
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
        ],
      });
      setSetupChannel(guildId, setupChannel.id);
      addLog(guildId, 'SETUP_CHANNEL_CREATED', `${setupChannel.id}`);
      await sendSettingsPanel(setupChannel, guildId);
      return interaction.editReply(`✅ تم إنشاء روم الإعدادات: ${setupChannel}`);
    } catch (err) {
      console.error('❌ خطأ في /setup:', err.message);
      return interaction.editReply('❌ فشل إنشاء الروم. تأكد من صلاحيات البوت.');
    }
  }

  // ── /active ─────────────────────────────────────────────────
  if (commandName === 'active') {
    const tokenValue = interaction.options.getString('token').trim();
    await interaction.deferReply({ ephemeral: true });
    const tokenRow = getTokenByValue(tokenValue);
    if (!tokenRow) return interaction.editReply('❌ التوكن غير صحيح أو معطّل.');
    if (new Date(tokenRow.expires_at) <= new Date()) return interaction.editReply('❌ انتهت صلاحية التوكن.');
    const result = activateToken(tokenRow.id, guildId);
    if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
    addLog(guildId, 'TOKEN_ACTIVATED', `تم تفعيل التوكن من ${interaction.user.tag}`);
    const expiresDate = new Date(tokenRow.expires_at).toLocaleDateString('ar-SA');
    const limits = [];
    if (tokenRow.here_min_interval > 0) limits.push(`⏱ حد /here: ${tokenRow.here_min_interval} دقيقة`);
    if (tokenRow.steam_limit > 0) limits.push(`🔍 حد /steam: ${tokenRow.steam_limit} استخدام`);
    await interaction.editReply(
      `✅ **تم تفعيل البوت!**\n⏰ ينتهي: ${expiresDate}\n` +
      (limits.length ? limits.join('\n') + '\n' : '') +
      (tokenRow.is_free_tier ? '📢 سيُرفق إعلان مع كل حساب Steam.' : '✅ بدون إعلانات.')
    );
    const s = getServer(guildId);
    if (s?.dashboard_channel_id) {
      interaction.guild?.channels.cache.get(s.dashboard_channel_id)
        ?.send(`✅ تم تفعيل التوكن بواسطة **${interaction.user.tag}** | ⏰ ينتهي: ${expiresDate}`);
    }
    if (s?.setup_channel_id) {
      const ch = interaction.guild?.channels.cache.get(s.setup_channel_id);
      if (ch) await sendSettingsPanel(ch, guildId);
    }
    return;
  }

  // ── Authorization ────────────────────────────────────────────
  if (!isServerAuthorized(guildId)) {
    const server = getServer(guildId);
    const expired = server?.free_tier_expires_at && new Date(server.free_tier_expires_at) <= new Date();
    return interaction.reply({
      content: expired
        ? `⏰ **انتهت الفترة المجانية.**\nاستخدم \`/active TOKEN\` للاستمرار.\n🔗 ${adInvite()}`
        : `🔒 البوت غير مفعّل.\nاستخدم \`/active TOKEN\`.\n🔗 ${adInvite()}`,
      ephemeral: true,
    });
  }

  if (!(await canUseCommands(interaction)))
    return interaction.reply({ content: '🚫 ليس لديك صلاحية.', ephemeral: true });

  // ── /steam ───────────────────────────────────────────────────
  if (commandName === 'steam') {
    const gameName = interaction.options.getString('game').trim();
    if (gameName.length < 2)
      return interaction.reply({ content: '❌ اكتب اسم اللعبة صح.', ephemeral: true });

    const { limit, uses, source } = getSteamLimitInfo(guildId);
    if (limit > 0 && uses >= limit) {
      return interaction.reply({
        content: `❌ **استنفذت الحد المسموح لـ /steam** (${limit} استخدام).\nتواصل مع صاحب البوت للحصول على توكن.\n🔗 ${adInvite()}`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();
    try {
      const result = await searchGame(gameName);
      if (!result)
        return interaction.editReply(`❌ ما لقيت حساب لـ **${gameName}** بعد 3 محاولات.`);

      if (source === 'token') incrementSteamUses(guildId);
      else incrementFreeTierSteamUses(guildId);

      addLog(guildId, 'STEAM_SEARCH', `بحث: ${gameName} من ${interaction.user.tag}`);

      if (result.length > 2000) {
        const chunks = splitMessage(result, 1900);
        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i] });
      } else {
        await interaction.editReply({ content: result });
      }

      if (shouldSendAd(guildId)) {
        try {
          const adTemplate = getSetting('ad_message', '📢 **هذه الحسابات مجانية من بوتنا**\n🔗 {invite}');
          const adText = adTemplate.replace(/\{invite\}/g, adInvite());
          const adMsg = await interaction.channel.send(adText);
          trackedAdMessages.set(adMsg.id, guildId);
        } catch {}
      }
    } catch (err) {
      console.error('❌ خطأ في البحث:', err.message);
      try { await interaction.editReply('❌ صار خطأ أثناء البحث.'); } catch {}
    }
    return;
  }

  // ── /here ────────────────────────────────────────────────────
  if (commandName === 'here') {
    const server = getServer(guildId);
    const providedMin = interaction.options.getInteger('min');
    const defaultMin  = server?.here_default_interval || 0;
    const minutes     = providedMin || defaultMin;

    if (!minutes || minutes < 1) {
      return interaction.reply({
        content:
          '❌ يجب تحديد الفترة الزمنية.\nمثال: `/here 15`\n' +
          (isPaidPlan(guildId) ? 'أو اضبط الفترة الافتراضية من `/setup`.' : ''),
        ephemeral: true,
      });
    }

    const hereMin = getHereMinInterval(guildId);
    if (hereMin > 0 && minutes < hereMin) {
      return interaction.reply({
        content: `❌ الحد الأدنى للفترة هو **${hereMin} دقيقة**.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const sendAd = shouldSendAd(guildId);
      await startScheduler(interaction.channel, minutes, guildId, sendAd);
      addLog(guildId, 'SCHEDULER_START', `نشر تلقائي كل ${minutes} دقيقة`);
      await interaction.editReply(
        `✅ البوت سينشر حساب Steam كل **${minutes}** دقيقة.` +
        (sendAd ? '\n📢 سيُرفق إعلان مع كل نشر.' : '')
      );
    } catch (err) {
      console.error('❌ خطأ في /here:', err.message);
      try { await interaction.editReply('❌ صار خطأ، حاول مرة ثانية.'); } catch {}
    }
    return;
  }

  // ── /stophere ────────────────────────────────────────────────
  if (commandName === 'stophere') {
    const stopped = stopScheduler(interaction.channel.id);
    if (stopped) {
      addLog(guildId, 'SCHEDULER_STOP', `أوقف النشر ${interaction.user.tag}`);
      await interaction.reply({ content: '✅ تم إيقاف النشر التلقائي.', ephemeral: true });
    } else {
      await interaction.reply({ content: '⚠️ ما في نشر تلقائي شغّال هنا.', ephemeral: true });
    }
    return;
  }
});

client.on('error', err => console.error('❌ Discord client error:', err.message));
process.on('unhandledRejection', r => console.error('❌ unhandledRejection:', r));
process.on('uncaughtException', err => console.error('❌ uncaughtException:', err.message));

client.login(token).catch(err => { console.error('❌ فشل تسجيل الدخول:', err.message); process.exit(1); });

function splitMessage(text, maxLength) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) { chunks.push(text); break; }
    let cut = text.lastIndexOf('\n', maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  return chunks;
}
