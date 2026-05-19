import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { searchGame } from './search.js';
import { startScheduler, stopScheduler, trackedAdMessages } from './scheduler.js';
import { startDashboard } from './dashboard.js';
import {
  upsertServer,
  setDashboardChannel,
  getServer,
  isServerAuthorized,
  isFreeTierActive,
  shouldSendAd,
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
      o.setName('min').setDescription('كم دقيقة بين كل نشر').setRequired(true).setMinValue(1).setMaxValue(1440)
    ),
  new SlashCommandBuilder()
    .setName('stophere')
    .setDescription('يوقف النشر التلقائي في هذا الروم'),
  new SlashCommandBuilder()
    .setName('active')
    .setDescription('تفعيل البوت باستخدام التوكن')
    .addStringOption(o => o.setName('token').setDescription('التوكن').setRequired(true)),
].map(cmd => cmd.toJSON());

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
    const dashChannel = await guild.channels.create({
      name: '🤖・dashboard',
      type: ChannelType.GuildText,
      topic: 'لوحة تحكم البوت — مرئية للأونر فقط',
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: owner.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    setDashboardChannel(guild.id, dashChannel.id);
    const expiryDate = new Date(freeTierExpiry).toLocaleDateString('ar-SA');
    await dashChannel.send(
      `👋 مرحباً **${owner.user.username}**!\n\n` +
      `🎉 **تم تفعيل البوت تلقائياً لمدة يومين مجاناً** (ينتهي: ${expiryDate})\n\n` +
      `📋 **الأوامر المتاحة الآن:**\n` +
      `\`/steam <لعبة>\` — ابحث عن حساب Steam\n` +
      `\`/here <دقائق>\` — نشر تلقائي مع فيديو TikTok\n` +
      `\`/stophere\` — إيقاف النشر التلقائي\n\n` +
      `⚠️ **بعد انتهاء الفترة المجانية** ستحتاج توكن للاستمرار.\n` +
      `🔑 للتفعيل استخدم: \`/active TOKEN_HERE\`\n\n` +
      `📢 ملاحظة: سيُرفق إعلان مع كل حساب Steam يُنشر خلال الفترة المجانية.`
    );
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
        `عند ${6 - count} تحذير إضافي سيتوقف البوت عن العمل هنا.\n` +
        `📞 تواصل مع صاحب البوت لإعادة الضبط.`
      );
    } else {
      await warnChannel?.send(
        `🚫 **تحذير 6/6 — تم إيقاف البوت**\n` +
        `وصلت للحد الأقصى. البوت لن يعمل في هذا السيرفر.\n` +
        `تواصل مع صاحب البوت لإعادة التفعيل.`
      );
      setServerActive(guildId, false);
      stopScheduler(message.channelId);
      addLog(guildId, 'SERVER_DEACTIVATED', 'تم إيقاف السيرفر بسبب 6 تحذيرات');
    }
  } catch (err) {
    console.error('❌ خطأ في معالجة حذف الإعلان:', err.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId } = interaction;
  if (!guildId) return;

  updateLastSeen(guildId);

  // ── /active ────────────────────────────────────────────────────────
  if (commandName === 'active') {
    const tokenValue = interaction.options.getString('token').trim();
    await interaction.deferReply({ ephemeral: true });
    const tokenRow = getTokenByValue(tokenValue);
    if (!tokenRow) return interaction.editReply('❌ التوكن غير صحيح أو معطّل.');
    if (new Date(tokenRow.expires_at) <= new Date()) return interaction.editReply('❌ انتهت صلاحية التوكن. اطلب توكناً جديداً.');
    const activateResult = activateToken(tokenRow.id, guildId);
    if (!activateResult.ok) return interaction.editReply(`❌ ${activateResult.error}`);
    addLog(guildId, 'TOKEN_ACTIVATED', `تم تفعيل التوكن من ${interaction.user.tag}`);
    const expiresDate = new Date(tokenRow.expires_at).toLocaleDateString('ar-SA');
    const limits = [];
    if (tokenRow.here_min_interval > 0) limits.push(`⏱ حد /here: ${tokenRow.here_min_interval} دقيقة`);
    if (tokenRow.steam_limit > 0) limits.push(`🔍 حد /steam: ${tokenRow.steam_limit} استخدام`);
    const adNote = tokenRow.is_free_tier ? '\n📢 سيُرفق إعلان مع كل حساب Steam يُنشر.' : '';
    await interaction.editReply(
      `✅ **تم تفعيل البوت بنجاح!**\n` +
      `⏰ ينتهي: ${expiresDate}\n` +
      (limits.length ? limits.join('\n') + '\n' : '') +
      adNote +
      `\nيمكنك الآن استخدام \`/steam\` و \`/here\``
    );
    const server = getServer(guildId);
    if (server?.dashboard_channel_id) {
      const dash = interaction.guild?.channels.cache.get(server.dashboard_channel_id);
      await dash?.send(`✅ تم تفعيل التوكن بواسطة **${interaction.user.tag}** | ⏰ ينتهي: ${expiresDate}`);
    }
    return;
  }

  // ── Authorization check ────────────────────────────────────────────
  if (!isServerAuthorized(guildId)) {
    const server = getServer(guildId);
    const expiredFree = server?.free_tier_expires_at && new Date(server.free_tier_expires_at) <= new Date();
    return interaction.reply({
      content: expiredFree
        ? `⏰ **انتهت الفترة المجانية.**\nاستخدم \`/active TOKEN\` للاستمرار. تواصل مع صاحب البوت للحصول على توكن.`
        : `🔒 البوت غير مفعّل.\nاستخدم \`/active TOKEN\` بعد الحصول على توكن من صاحب البوت.`,
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
        content:
          `❌ **استنفذت الحد المسموح لـ /steam** (${limit} استخدام).\n` +
          `تواصل مع صاحب البوت للحصول على توكن جديد.`,
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
      // Send ad only if is_free_tier flag is set on token (or using free tier)
      if (shouldSendAd(guildId)) {
        try {
          const adText =
            `📢 **هذه الحسابات مقدمة مجاناً من بوتنا**\n` +
            `🔗 **انضم لسيرفرنا للمزيد:** ${AD_INVITE}`;
          const adMsg = await interaction.channel.send(adText);
          trackedAdMessages.set(adMsg.id, guildId);
        } catch {}
      }
    } catch (err) {
      console.error('❌ خطأ في البحث:', err.message);
      try { await interaction.editReply('❌ صار خطأ أثناء البحث.'); } catch {}
    }
  }

  // ── /here ──────────────────────────────────────────────────────────
  if (commandName === 'here') {
    const minutes = interaction.options.getInteger('min');
    const hereMin = getHereMinInterval(guildId);
    if (hereMin > 0 && minutes < hereMin) {
      return interaction.reply({
        content: `❌ الحد الأدنى للفترة في توكنك هو **${hereMin} دقيقة**.\nاختر قيمة أكبر من أو تساوي ${hereMin}.`,
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
