const GROQ_API_KEY = process.env.GROQ_API_KEY;

const EDIT_KEYWORDS = [
  'edit', 'montage', 'amv', 'tribute', 'fmv', 'phonk', 'badass',
  'cinematic', 'highlight', 'clip', 'sick', 'clean', 'fire', 'cold',
  'اديت', 'مونتاج', 'تعديل',
];

const BAD_KEYWORDS = [
  'gameplay', 'walkthrough', 'tutorial', 'guide', 'how to', 'howto',
  'review', 'unboxing', 'reaction', 'stream', 'livestream', 'live stream',
  'sponsored', 'sponsor', 'ad ', ' ad', '#ad', 'promo', 'discount',
  'buy now', 'sale', 'giveaway', 'subscribe', 'follow me', 'new video',
  'part 1', 'part 2', 'episode', 'ep.', 'ep ', 'vlog', 'commentary',
  'explained', 'theory', 'analysis', 'news', 'update', 'patch',
  'تعليق', 'شرح', 'مباشر',
];

function scoreVideo(video) {
  const title = (video.title || '').toLowerCase();
  let score = 0;

  for (const kw of EDIT_KEYWORDS) {
    if (title.includes(kw)) score += 10;
  }

  for (const kw of BAD_KEYWORDS) {
    if (title.includes(kw)) score -= 20;
  }

  // Boost by engagement
  const likes = video.digg_count || 0;
  const plays = video.play_count || 0;
  score += Math.min(likes / 10000, 5);
  score += Math.min(plays / 100000, 3);

  return score;
}

async function verifyWithGroq(gameName, candidates) {
  if (!GROQ_API_KEY || candidates.length === 0) return candidates[0] || null;

  const list = candidates
    .slice(0, 5)
    .map((v, i) => `${i + 1}. "${v.title || '(no title)'}"`)
    .join('\n');

  const prompt = `You are filtering TikTok videos. The game is "${gameName}".

Here are video titles found by searching "${gameName} edit":
${list}

Which ONE video is most likely a fan-made cinematic edit or montage (with music, effects, impressive visuals) for this game?
Reject gameplay recordings, tutorials, reviews, ads, unrelated content, or vlogs.

Reply with ONLY the number (1-${Math.min(candidates.length, 5)}) of the best edit, or 0 if none qualify.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5,
        temperature: 0.1,
      }),
    });

    if (!res.ok) return candidates[0];

    const data = await res.json();
    const raw = data.choices[0].message.content.trim();
    const idx = parseInt(raw) - 1;

    if (idx >= 0 && idx < candidates.length) {
      console.log(`🤖 Groq اختار الفيديو رقم ${idx + 1}: "${candidates[idx].title}"`);
      return candidates[idx];
    }
    if (raw === '0') {
      console.log('🤖 Groq: لا يوجد edit مناسب في هذه النتائج');
      return null;
    }
    return candidates[0];
  } catch (err) {
    console.error(`⚠️ Groq verify error: ${err.message}`);
    return candidates[0];
  }
}

export async function searchTikTokEdit(gameName) {
  const query = encodeURIComponent(`${gameName} edit`);
  const url = `https://www.tikwm.com/api/feed/search?keywords=${query}&count=30&cursor=0&HD=0`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.tikwm.com/',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const videos = data?.data?.videos;

    if (!Array.isArray(videos) || videos.length === 0) {
      console.log(`⚠️ TikTok: لا توجد نتائج لـ "${gameName}"`);
      return null;
    }

    // Score and sort
    const scored = videos
      .filter(v => v?.play || v?.wmplay)
      .map(v => ({ ...v, _score: scoreVideo(v) }))
      .sort((a, b) => b._score - a._score);

    console.log(`🔍 TikTok: ${scored.length} فيديو، أعلى نتيجة: "${scored[0]?.title}" (${scored[0]?._score})`);

    // Take top 5 candidates with positive score
    const candidates = scored.filter(v => v._score > 0).slice(0, 5);

    if (candidates.length === 0) {
      console.log(`⚠️ TikTok: لا يوجد edit واضح، تجربة Groq على أعلى النتائج`);
      const fallback = await verifyWithGroq(gameName, scored.slice(0, 5));
      if (!fallback) return null;
      return downloadVideo(fallback);
    }

    // Let Groq pick the best from candidates
    const best = await verifyWithGroq(gameName, candidates);
    if (!best) {
      console.log(`⚠️ Groq رفض كل المرشحين`);
      return null;
    }

    return downloadVideo(best);
  } catch (err) {
    console.error(`❌ TikTok error for "${gameName}": ${err.message}`);
    return null;
  }
}

async function downloadVideo(video) {
  const playUrl = video?.play || video?.wmplay;
  if (!playUrl) return null;

  try {
    const videoRes = await fetch(playUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!videoRes.ok) throw new Error(`Download HTTP ${videoRes.status}`);

    const contentLength = videoRes.headers.get('content-length');
    const sizeBytes = contentLength ? parseInt(contentLength) : 0;

    if (sizeBytes > 24 * 1024 * 1024) {
      console.log(`⚠️ فيديو كبير جداً (${Math.round(sizeBytes / 1024 / 1024)}MB)، تخطي`);
      return null;
    }

    const buffer = Buffer.from(await videoRes.arrayBuffer());
    console.log(`✅ حُمّل مقطع: "${video.title}" — ${Math.round(buffer.length / 1024)}KB`);
    return { buffer, filename: 'edit.mp4' };
  } catch (err) {
    console.error(`❌ فشل تحميل الفيديو: ${err.message}`);
    return null;
  }
}
