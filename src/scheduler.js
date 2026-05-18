import { AttachmentBuilder } from 'discord.js';
import { searchGameRaw } from './search.js';
import { getTop50Games, getGameEmoji } from './groq.js';
import { searchTikTokEdit } from './tiktok.js';

const activeSchedulers = new Map();

export async function startScheduler(channel, intervalMinutes) {
  stopScheduler(channel.id);

  console.log(`⏰ جدولة نشر في #${channel.name} كل ${intervalMinutes} دقيقة`);

  let games = [];
  try {
    games = await getTop50Games();
  } catch (err) {
    console.error('❌ فشل جلب الألعاب:', err.message);
    await channel.send('❌ فشل في جلب قائمة الألعاب من Groq.');
    return;
  }

  if (!games.length) {
    await channel.send('❌ ما رجعت أي ألعاب من Groq.');
    return;
  }

  games = games.sort(() => Math.random() - 0.5);

  const state = { games, index: 0 };

  await postNextGame(channel, state);

  const intervalId = setInterval(async () => {
    await postNextGame(channel, state);
  }, intervalMinutes * 60 * 1000);

  state.intervalId = intervalId;
  activeSchedulers.set(channel.id, state);
}

export function stopScheduler(channelId) {
  const state = activeSchedulers.get(channelId);
  if (state) {
    clearInterval(state.intervalId);
    activeSchedulers.delete(channelId);
    return true;
  }
  return false;
}

export function isActive(channelId) {
  return activeSchedulers.has(channelId);
}

async function postNextGame(channel, state) {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const game = state.games[state.index % state.games.length];
    state.index++;

    if (state.index >= state.games.length) {
      state.games = state.games.sort(() => Math.random() - 0.5);
      state.index = 0;
    }

    console.log(`🎮 محاولة نشر: ${game}`);

    try {
      const account = await searchGameRaw(game);
      if (!account) {
        console.log(`⚠️ لا يوجد حساب للعبة: ${game}`);
        attempts++;
        continue;
      }

      const [emoji, tiktokData] = await Promise.all([
        getGameEmoji(game),
        searchTikTokEdit(game),
      ]);

      const text = `${emoji} **${game}**\n\n**name:** \`${account.username}\`\n**pass:** \`${account.password}\``;

      if (tiktokData?.buffer) {
        const attachment = new AttachmentBuilder(tiktokData.buffer, { name: tiktokData.filename });
        await channel.send({ content: text, files: [attachment] });
      } else {
        await channel.send({ content: text });
      }

      console.log(`✅ تم نشر: ${game}${tiktokData ? ' + مقطع TikTok' : ''}`);
      return;
    } catch (err) {
      console.error(`❌ خطأ في النشر: ${err.message}`);
      attempts++;
    }
  }

  console.log('❌ فشل إيجاد لعبة مناسبة بعد عدة محاولات');
}
