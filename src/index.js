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
} from 'discord.js';
import { searchGame } from './search.js';
import { startScheduler, stopScheduler, trackedAdMessages } from './scheduler.js';
import { startDashboard } from './dashboard.js';
import {
  upsertServer,
  setDashboardChannel,
  setSetupChannel,
  setHereDefaultInterval,
  setCommandPermission,
  getServer,
  isServerAuthorized,
  shouldSendAd,
  isPaidPlan,
  addLog,
  getTokenByValue,
  getServerToken,
  activateToken,
  incrementWarning,
  incrementSteamUses,
  setServerActive,
  isUserAllowed,
  updateLastSeen,
  autoActivateFreeTier,
  getSteamLimitInfo,
  getHereMinInterval,
} from './db.js';

const token = process.env.DISCORD_TOKEN;
export const BOT_OWNER_ID = process.env.BOT_OWNER_DISCORD_ID || '';
const AD_INVITE = process.env.BOT_OWNER_SERVER_INVITE || 'https://discord.gg/example';

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
    .setDescription('يبدأ البوت ينشر حسابات Steam مع فيديو TikTok كل فترة')
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
async function canUseCommands(interaction) {
  if (!interaction.guild) return false;
  if (BOT_OWNER_ID && interaction.user.id === BOT_OWNER_ID) return true;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  const server = getServer(interaction.guildId);
  if (!server) return false;
  if (server.command_permission === 'everyone') return true;
  if (server.command_permission === 'specific') return isUserAllowed(interaction.guildId, interaction.user.id);
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

// ─── Settings Panel ────────────────────────────────────────────
async function sendSettingsPanel(channel, guildId, forceRefresh = false) {
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
        value: `الإعداد الحالي: **${permLabel(perm)}**\n${isPaid ? '✅ يمكنك التعديل' : '✅ يمكنك التعديل'}`,
        inline: false,
      },
      {
        name: `⏱️ الفترة الافتراضية لـ /here${isPaid ? '' : ' 🔒'}`,
        value: isPaid
          ? `الإعداد الحالي: **${defInterval > 0 ? defInterval + ' دقيقة' : 'غير محدد'}**\n` +
            (tokenMin > 0 ? `⚠️ توكنك يفرض حداً أدنى: ${tokenMin} دقيقة\n` : '') +
            `✅ يمكنك التعديل`
          : `الإعداد الحالي: **${defInterval > 0 ? defInterval + ' دقيقة' : 'غير محدد'}**\n🔒 **مقفل** — يحتاج توكن مدفوع للتعديل`,
        inline: false,
      },
      {
        name: '💡 كيف تستخدم البوت',
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
      value: `تواصل مع صاحب البوت للحصول على توكن وفتح كل الميزات.\n🔗 ${AD_INVITE}`,
      inline: false,
    });
  }

  // ── Select: permission (always enabled) ──
  const permRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup_perm_${guildId}`)
      .setPlaceholder('🔐 اختر من يقدر يستخدم الأوامر')
      .addOptions([
        { label: '👑 الأونر فقط', value: 'owner',    description: 'فقط صاحب السيرفر يقدر يستخدم الأوامر', default: perm === 'owner' },
        { label: '🌍 الجميع',    value: 'everyone', description: 'كل أعضاء السيرفر يقدرون يستخدمون الأوامر', default: perm === 'everyone' },
        { label: '👥 محددون',    value: 'specific', description: 'فقط المستخدمون المضافون في القائمة', default: perm === 'specific' },
      ])
  );

  // ── Select: here interval (locked on free tier) ──
  const intervalOptions = [
    { label: '🚫 بدون تحديد', value: '0',   description: 'يحدد المستخدم الفترة بنفسه مع /here' },
    { label: '5 دقائق',        value: '5',   description: 'نشر كل 5 دقائق' },
    { label: '10 دقائق',       value: '10',  description: 'نشر كل 10 دقائق' },
    { label: '15 دقائق',       value: '15',  description: 'نشر كل 15 دقيقة' },
    { label: '30 دقائق',       value: '30',  description: 'نشر كل 30 دقيقة' },
    { label: '60 دقيقة',       value: '60',  description: 'نشر كل ساعة' },
    { label: '120 دقيقة',      value: '120', description: 'نشر كل ساعتين' },
    { label: '180 دقيقة',      value: '180', description: 'نشر كل 3 ساعات' },
    { label: '360 دقيقة',      value: '360', description: 'نشر كل 6 ساعات' },
  ].map(o => ({ ...o, default: String(defInterval) === o.value }));

  const intervalRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup_interval_${guildId}`)
      .setPlaceholder(isPaid ? '⏱️ اختر الفترة الافتراضية لـ /here' : '🔒 مقفل — يحتاج توكن مدفوع')
      .setDisabled(!isPaid)
      .addOptions(intervalOptions)
  );

  try {
    // Delete old panel messages to keep channel clean
    const msgs = await channel.messages.fetch({ limit: 10 });
    const botMsgs = msgs.filter(m => m.author.id === client.user.id);
    if (botMsgs.size > 0) await channel.bulkDelete(botMsgs).catch(() => {});
  } catch {}

  await channel.send({ embeds: [embed], components: [permRow, intervalRow] });
}

// ─── DM Tutorial ──────────────────────────────────────────────
async function sendOwnerTutorial(owner, guildName, freeTierExpiry) {
  const expDate = new Date(freeTierExpiry).toLocaleDateString('ar-SA');
  const tutorial =
    `# 🎮 مرحباً بك في Steam Bot!\n\n` +
    `شكراً لإضافة البوت لسيرفر **${guildName}**! هذا شرح سريع لكل شيء:\n\n` +

    `## 🎉 الفترة المجانية\n` +
    `تحصل الآن على **يومين مجاناً** (تنتهي: ${expDate}).\n` +
    `بعدها تحتاج توكن مدفوع للاستمرار.\n\n` +

    `## 📋 الأوامر المتاحة\n` +
    `\`/steam <اسم اللعبة>\`\n` +
    `↳ يبحث عن حساب Steam للعبة ويرسله مباشرة في الشات\n\n` +
    `\`/here <دقائق>\`\n` +
    `↳ يبدأ نشر تلقائي لحسابات Steam مع مقاطع TikTok كل X دقيقة\n\n` +
    `\`/stophere\`\n` +
    `↳ يوقف النشر التلقائي في الروم الحالي\n\n` +
    `\`/active <التوكن>\`\n` +
    `↳ يفعّل توكن جديد للاستمرار بعد انتهاء الخطة\n\n` +
    `\`/setup\`\n` +
    `↳ ينشئ روم إعدادات خاص بك لضبط البوت\n\n` +

    `## ⚙️ إعداد البوت\n` +
    `اكتب \`/setup\` في أي روم وسيُنشئ البوت روماً خاصاً بك فيه:\n` +
    `• ضبط **من يقدر يستخدم الأوامر** (أونر / الجميع / محددون)\n` +
    `• ضبط **الفترة الافتراضية** لـ /here ← مقفل في النسخة المجانية\n\n` +

    `## 📢 نظام الإعلانات\n` +
    `في النسخة المجانية والتوكنات من نوع "Free" يُرفق إعلان مع كل رسالة Steam.\n` +
    `⚠️ **لا تحذف رسائل الإعلان!** حذفها يعطي تحذيراً وعند 6 تحذيرات يُوقف البوت تلقائياً.\n\n` +

    `## 🔑 كيف تحصل على توكن\n` +
    `تواصل مع صاحب البوت عبر هذا الرابط للحصول على توكن:\n` +
    `🔗 **${AD_INVITE}**\n\n` +
    `بعد الحصول عليه اكتب في أي روم: \`/active التوكن_هنا\`\n\n` +

    `## 📊 أنواع الخطط\n` +
    `**🆓 مجاني (يومين):** كل الأوامر متاحة + إعلان مع كل رسالة\n` +
    `**💎 مدفوع:** كل شيء + بدون إعلانات (حسب نوع التوكن) + ضبط كامل للإعدادات\n\n` +

    `إذا عندك أي سؤال تواصل معنا: ${AD_INVITE} 🙌`;

  try {
    await owner.send(tutorial);
  } catch (err) {
    console.error(`❌ فشل إرسال DM للأونر ${owner.user?.tag}:`, err.message);
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
  const freeTierExpiry = autoActivateFreeTier(guild.id, 2);
  addLog(guild.id, 'BOT_JOINED', `انضم البوت لسيرفر ${guild.name} — free tier لمدة يومين`);

  try {
    const owner = await guild.fetchOwner();

    // Create dashboard channel
    const dashChannel = await guild.channels.create({
      name: '🤖・dashboard',
      type: ChannelType.GuildText,
      topic: 'لوحة تحكم البوت — مرئية للأونر فقط',
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
      `🎉 **تم تفعيل البوت تلقائياً لمدة يومين مجاناً** (ينتهي: ${expiryDate})\n\n` +
      `⚙️ اكتب \`/setup\` في أي روم لإنشاء روم الإعدادات الخاص بك.\n` +
      `📬 تم إرسال شرح كامل للبوت بالخاص.`
    );

    // Send DM tutorial to owner
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
    let warnChannel = null;
    if (server?.dashboard_channel_id) warnChannel = guild.channels.cache.get(server.dashboard_channel_id);
    if (!warnChannel) warnChannel = message.channel;
    if (count < 6) {
      await warnChannel?.send(
        `⚠️ **تحذير ${count}/6**\n` +
        `تم حذف رسالة الإعلان المطلوبة.\n` +
        `عند ${6 - count} تحذير إضافي سيتوقف البوت.\n` +
        `📞 تواصل مع صاحب البوت لإعادة الضبط.`
      );
    } else {
      await warnChannel?.send(
        `🚫 **تحذير 6/6 — تم إيقاف البوت**\n` +
        `وصلت للحد الأقصى. تواصل مع صاحب البوت لإعادة التفعيل.`
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

  // ── Component Interactions (select menus in setup channel) ──
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;

    // Permission select
    if (customId.startsWith('setup_perm_')) {
      const targetGuildId = customId.replace('setup_perm_', '');
      if (interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ content: '🚫 هذا الإعداد للأونر فقط.', ephemeral: true });
      }
      const newPerm = interaction.values[0];
      setCommandPermission(targetGuildId, newPerm);
      addLog(targetGuildId, 'SETUP_PERM_CHANGED', `تغيير الصلاحية إلى: ${newPerm}`);
      await interaction.deferUpdate();
      const server = getServer(targetGuildId);
      if (server?.setup_channel_id) {
        const ch = interaction.guild?.channels.cache.get(server.setup_channel_id);
        if (ch) await sendSettingsPanel(ch, targetGuildId);
      }
      return;
    }

    // Interval select
    if (customId.startsWith('setup_interval_')) {
      const targetGuildId = customId.replace('setup_interval_', '');
      if (interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ content: '🚫 هذا الإعداد للأونر فقط.', ephemeral: true });
      }
      if (!isPaidPlan(targetGuildId)) {
        return interaction.reply({ content: '🔒 هذا الإعداد متاح للخطة المدفوعة فقط.', ephemeral: true });
      }
      const minutes = Number(interaction.values[0]);
      setHereDefaultInterval(targetGuildId, minutes);
      addLog(targetGuildId, 'SETUP_INTERVAL_CHANGED', `تغيير الفترة الافتراضية إلى: ${minutes} دقيقة`);
      await interaction.deferUpdate();
      const server = getServer(targetGuildId);
      if (server?.setup_channel_id) {
        const ch = interaction.guild?.channels.cache.get(server.setup_channel_id);
        if (ch) await sendSettingsPanel(ch, targetGuildId);
      }
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  updateLastSeen(guildId);

  // ── /setup ─────────────────────────────────────────────────────────
  if (commandName === 'setup') {
    if (interaction.user.id !== interaction.guild?.ownerId) {
      return interaction.reply({ content: '🚫 أمر /setup للأونر فقط.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const server = getServer(guildId);

    // Check if setup channel already exists
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
          {
            id: owner.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageMessages,
            ],
          },
        ],
      });

      setSetupChannel(guildId, setupChannel.id);
      addLog(guildId, 'SETUP_CHANNEL_CREATED', `تم إنشاء روم الإعدادات: ${setupChannel.id}`);
      await sendSettingsPanel(setupChannel, guildId);
      return interaction.editReply(`✅ تم إنشاء روم الإعدادات: ${setupChannel}`);
    } catch (err) {
      console.error('❌ خطأ في /setup:', err.message);
      return interaction.editReply('❌ فشل إنشاء روم الإعدادات. تأكد أن البوت يملك صلاحية إنشاء روم.');
    }
  }

  // ── /active ────────────────────────────────────────────────────────
  if (commandName === 'active') {
    const tokenValue = interaction.options.getString('token').trim();
    await interaction.deferReply({ ephemeral: true });
    const tokenRow = getTokenByValue(tokenValue);
    if (!tokenRow) return interaction.editReply('❌ التوكن غير صحيح أو معطّل.');
    if (new Date(tokenRow.expires_at) <= new Date()) return interaction.editReply('❌ انتهت صلاحية التوكن.');
    const activateResult = activateToken(tokenRow.id, guildId);
    if (!activateResult.ok) return interaction.editReply(`❌ ${activateResult.error}`);
    addLog(guildId, 'TOKEN_ACTIVATED', `تم تفعيل التوكن من ${interaction.user.tag}`);
    const expiresDate = new Date(tokenRow.expires_at).toLocaleDateString('ar-SA');
    const limits = [];
    if (tokenRow.here_min_interval > 0) limits.push(`⏱ حد /here: ${tokenRow.here_min_interval} دقيقة`);
    if (tokenRow.steam_limit > 0) limits.push(`🔍 حد /steam: ${tokenRow.steam_limit} استخدام`);
    const adNote = tokenRow.is_free_tier ? '\n📢 سيُرفق إعلان مع كل حساب Steam.' : '\n✅ بدون إعلانات.';
    await interaction.editReply(
      `✅ **تم تفعيل البوت بنجاح!**\n⏰ ينتهي: ${expiresDate}\n` +
      (limits.length ? limits.join('\n') + '\n' : '') + adNote +
      `\nيمكنك الآن استخدام \`/steam\` و \`/here\``
    );
    // Refresh settings panel if exists
    const server = getServer(guildId);
    if (server?.dashboard_channel_id) {
      const dash = interaction.guild?.channels.cache.get(server.dashboard_channel_id);
      await dash?.send(`✅ تم تفعيل التوكن بواسطة **${interaction.user.tag}** | ⏰ ينتهي: ${expiresDate}`);
    }
    if (server?.setup_channel_id) {
      const setupCh = interaction.guild?.channels.cache.get(server.setup_channel_id);
      if (setupCh) await sendSettingsPanel(setupCh, guildId);
    }
    return;
  }

  // ── Authorization check ────────────────────────────────────────────
  if (!isServerAuthorized(guildId)) {
    const server = getServer(guildId);
    const expiredFree = server?.free_tier_expires_at && new Date(server.free_tier_expires_at) <= new Date();
    return interaction.reply({
      content: expiredFree
        ? `⏰ **انتهت الفترة المجانية.**\nاستخدم \`/active TOKEN\` للاستمرار.\n🔗 ${AD_INVITE}`
        : `🔒 البوت غير مفعّل.\nاستخدم \`/active TOKEN\` للتفعيل.\n🔗 ${AD_INVITE}`,
      ephemeral: true,
    });
  }

  if (!(await canUseCommands(interaction))) {
    return interaction.reply({ content: '🚫 ليس لديك صلاحية استخدام الأوامر.', ephemeral: true });
  }

  // ── /steam ─────────────────────────────────────────────────────────
  if (commandName === 'steam') {
    const gameName = interaction.options.getString('game').trim();
    if (gameName.length < 2) return interaction.reply({ content: '❌ اكتب اسم اللعبة صح.', ephemeral: true });

    const { limit, uses } = getSteamLimitInfo(guildId);
    if (limit > 0 && uses >= limit) {
      return interaction.reply({
        content: `❌ **استنفذت الحد المسموح لـ /steam** (${limit} استخدام).\nتواصل مع صاحب البوت للحصول على توكن جديد.`,
        ephemeral: true,
      });
    }
    if (limit > 0) incrementSteamUses(guildId);

    await interaction.deferReply();
    try {
      const result = await searchGame(gameName);
      if (!result) return interaction.editReply(`❌ ما لقيت أي حساب لـ **${gameName}** بعد 3 محاولات.`);
      addLog(guildId, 'STEAM_SEARCH', `بحث عن: ${gameName} من ${interaction.user.tag}`);
      if (result.length > 2000) {
        const chunks = splitMessage(result, 1900);
        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i] });
      } else {
        await interaction.editReply({ content: result });
      }
      if (shouldSendAd(guildId)) {
        try {
          const adMsg = await interaction.channel.send(
            `📢 **هذه الحسابات مقدمة مجاناً من بوتنا**\n🔗 **انضم لسيرفرنا للمزيد:** ${AD_INVITE}`
          );
          trackedAdMessages.set(adMsg.id, guildId);
        } catch {}
      }
    } catch (err) {
      console.error('❌ خطأ في البحث:', err.message);
      try { await interaction.editReply('❌ صار خطأ أثناء البحث.'); } catch {}
    }
    return;
  }

  // ── /here ──────────────────────────────────────────────────────────
  if (commandName === 'here') {
    const server = getServer(guildId);
    const providedMin = interaction.options.getInteger('min');
    const defaultMin  = server?.here_default_interval || 0;
    const minutes = providedMin || defaultMin;

    if (!minutes || minutes < 1) {
      return interaction.reply({
        content:
          '❌ يجب تحديد الفترة الزمنية.\n' +
          'مثال: `/here 15`\n' +
          (isPaidPlan(guildId) ? 'أو قم بضبط الفترة الافتراضية من روم الإعدادات (/setup).' : ''),
        ephemeral: true,
      });
    }

    const hereMin = getHereMinInterval(guildId);
    if (hereMin > 0 && minutes < hereMin) {
      return interaction.reply({
        content: `❌ الحد الأدنى للفترة في توكنك هو **${hereMin} دقيقة**.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const sendAd = shouldSendAd(guildId);
      await startScheduler(interaction.channel, minutes, guildId, sendAd);
      addLog(guildId, 'SCHEDULER_START', `بدأ النشر التلقائي كل ${minutes} دقيقة`);
      const adNote = sendAd ? '\n📢 سيُرفق إعلان مع كل نشر.' : '';
      await interaction.editReply(
        `✅ البوت سينشر حساب Steam مع مقطع TikTok كل **${minutes}** دقيقة.` + adNote
      );
    } catch (err) {
      console.error('❌ خطأ في /here:', err.message);
      try { await interaction.editReply('❌ صار خطأ، حاول مرة ثانية.'); } catch {}
    }
    return;
  }

  // ── /stophere ──────────────────────────────────────────────────────
  if (commandName === 'stophere') {
    const stopped = stopScheduler(interaction.channel.id);
    if (stopped) {
      addLog(guildId, 'SCHEDULER_STOP', `أُوقف النشر التلقائي من ${interaction.user.tag}`);
      await interaction.reply({ content: '✅ تم إيقاف النشر التلقائي.', ephemeral: true });
    } else {
      await interaction.reply({ content: '⚠️ ما في نشر تلقائي شغّال في هذا الروم.', ephemeral: true });
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
