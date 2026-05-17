import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { searchGame } from './search.js';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ DISCORD_TOKEN غير موجود');
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY غير موجود');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('steam')
    .setDescription('ابحث عن حساب Steam للعبة معينة')
    .addStringOption(option =>
      option.setName('game')
        .setDescription('اسم اللعبة اللي تبغاها')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

client.once('clientReady', async () => {
  console.log(`✅ البوت شغّال: ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log('⏳ جاري تسجيل الأوامر...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ تم تسجيل الأوامر بنجاح');
  } catch (err) {
    console.error('❌ خطأ في تسجيل الأوامر:', err.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'steam') return;

  const gameName = interaction.options.getString('game').trim();

  if (!gameName || gameName.length < 2) {
    await interaction.reply({ content: '❌ اكتب اسم اللعبة صح.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    console.log(`🎮 طلب جديد: "${gameName}" من ${interaction.user.tag}`);

    const result = await searchGame(gameName);

    if (!result) {
      await interaction.editReply({
        content: `❌ ما لقيت أي حساب لـ **${gameName}** بعد ${3} محاولات في قاعدة البيانات.`,
      });
      return;
    }

    if (result.length > 2000) {
      const chunks = splitMessage(result, 1900);
      await interaction.editReply({ content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] });
      }
    } else {
      await interaction.editReply({ content: result });
    }

  } catch (err) {
    console.error('❌ خطأ في البحث:', err.message);
    try {
      await interaction.editReply({ content: '❌ صار خطأ أثناء البحث، حاول مرة ثانية.' });
    } catch {}
  }
});

client.on('error', err => {
  console.error('❌ Discord client error:', err.message);
});

client.on('warn', msg => {
  console.warn('⚠️ Discord warn:', msg);
});

client.on('disconnect', () => {
  console.warn('⚠️ انقطع الاتصال، محاولة إعادة الاتصال...');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message);
});

client.login(token).catch(err => {
  console.error('❌ فشل تسجيل الدخول:', err.message);
  process.exit(1);
});

function splitMessage(text, maxLength) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }
    let cut = text.lastIndexOf('\n', maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  return chunks;
}
