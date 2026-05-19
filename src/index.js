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
  isFreeTierServer,
  addLog,
  getTokenByValue,
  getActiveToken,
  activateToken,
  incrementWarning,
  incrementSteamUses,
  setServerActive,
  isUserAllowed,
  updateLastSeen,
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
    .addStringOption(o => o.setName('token').setDescription('التوكن المُرسَل لروم الداشبورد').setRequired(true)),
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
  addLog(guild.id, 'BOT_JOINED', `انضم البوت لسيرفر ${guild.name}`);
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
    await dashChannel.send(
      `👋 مرحباً **${owner.user.username}**!\n\n` +
      `🤖 البوت وصل لسيرفرك. للبدء تحتاج **توكن تفعيل** من صاحب البوت.\n\n` +
      `📋 **الأوامر المتاحة بعد التفعيل:**\n` +
      `\`/steam <لعبة>\` — ابحث عن حساب Steam\n` +
      `\`/here <دقائق>\` — نشر تلقائي مع فيديو TikTok\n` +
      `\`/stophere\` — إيقاف النشر التلقائي\n\n` +
      `🔑 **للتفعيل:** استخدم الأمر:\n\`/active TOKEN_HERE\``
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

  updateLastSeen(guildId).catch(() => {});

  // ── /active ────────────────────────────────────────────────────────
  if (commandName === 'active') {
    const tokenValue = interaction.options.getString('token').trim();
    await interaction.deferReply({ ephemeral: true });
    const tokenRow = getTokenByValue(tokenValue);
    if (!tokenRow) return interaction.editReply('❌ التوكن غير صحيح.');
    if (tokenRow.server_id !== guildId) return interaction.editReply('❌ هذا التوكن غير مخصص لهذا السيرفر.');
    if (new Date(tokenRow.expires_at) <= new Date()) return interaction.editReply('❌ انتهت صلاحية التوكن. اطلب توكناً جديداً.');
    activateToken(tokenRow.id, guildId);
    addLog(guildId, 'TOKEN_ACTIVATED', `تم تفعيل التوكن من ${interaction.user.tag}`);
    const tierLabel = tokenRow.is_free_tier ? '🆓 مجاني (إعلانات)' : '💎 مميز';
    const expiresDate = new Date(tokenRow.expires_at).toLocaleDateString('ar-SA');
    const limits = [];
    if (tokenRow.here_min_interval > 0) limits.push(`⏱ حد /here: ${tokenRow.here_min_interval} دقيقة`);
    if (tokenRow.steam_limit > 0) limits.push(`🔍 حد /steam: ${tokenRow.steam_limit} استخدام`);
    await interaction.editReply(
      `✅ **تم تفعيل البوت بنجاح!**\n` +
      `📋 النوع: ${tierLabel} | ⏰ ينتهي: ${expiresDate}\n` +
      (limits.length ? limits.join('\n') + '\n' : '') +
      `\nيمكنك الآن استخدام \`/steam\` و \`/here\``
    );
    const server = getServer(guildId);
    if (server?.dashboard_channel_id) {
      const dash = interaction.guild?.channels.cache.get(server.dashboard_channel_id);
      await dash?.send(`✅ تم تفعيل البوت بواسطة **${interaction.user.tag}** | ${tierLabel} | ينتهي: ${expiresDate}`);
    }
    return;
  }

  // ── Authorization check ────────────────────────────────────────────
  if (!isServerAuthorized(guildId)) {
    return interaction.reply({
      content: '🔒 البوت غير مفعّل.\nاستخدم `/active TOKEN` بعد الحصول على توكن من صاحب البوت.',
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

    const activeToken = getActiveToken(guildId);
    if (activeToken && activeToken.steam_limit > 0) {
      if (activeToken.steam_uses >= activeToken.steam_limit) {
        return interaction.reply({
          content:
            `❌ **استنفذت الحد المسموح لـ /steam** (${activeToken.steam_limit} استخدام).\n` +
            `تواصل مع صاحب البوت للحصول على توكن جديد.`,
          ephemeral: true,
        });
      }
      incrementSteamUses(activeToken.id);
    }

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
    } catch (err) {
      console.error('❌ خطأ في البحث:', err.message);
      try { await interaction.editReply('❌ صار خطأ أثناء البحث.'); } catch {}
    }
  }

  // ── /here ──────────────────────────────────────────────────────────
  if (commandName === 'here') {
    const minutes = interaction.options.getInteger('min');
    const activeToken = getActiveToken(guildId);
    if (activeToken && activeToken.here_min_interval > 0 && minutes < activeToken.here_min_interval) {
      return interaction.reply({
        content: `❌ الحد الأدنى للفترة في توكنك هو **${activeToken.here_min_interval} دقيقة**.\nاختر قيمة أكبر من أو تساوي ${activeToken.here_min_interval}.`,
        ephemeral: true,
      });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const freeTier = isFreeTierServer(guildId);
      await startScheduler(interaction.channel, minutes, guildId, freeTier);
      addLog(guildId, 'SCHEDULER_START', `بدأ النشر التلقائي كل ${minutes} دقيقة`);
      await interaction.editReply(
        `✅ البوت سينشر حساب Steam مع مقطع TikTok كل **${minutes}** دقيقة.` +
        (freeTier ? '\n🆓 النسخة المجانية: سيُرفق إعلان مع كل نشر.' : '')
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
