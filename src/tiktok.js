export async function searchTikTokEdit(gameName) {
  const query = encodeURIComponent(`${gameName} edit`);
  const url = `https://www.tikwm.com/api/feed/search?keywords=${query}&count=20&cursor=0&HD=0`;

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

    if (!Array.isArray(videos) || videos.length === 0) return null;

    const sorted = [...videos].sort((a, b) => (b.play_count || 0) - (a.play_count || 0));

    for (const video of sorted) {
      const playUrl = video?.play || video?.wmplay;
      if (!playUrl) continue;

      try {
        const videoRes = await fetch(playUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (!videoRes.ok) continue;

        const contentLength = videoRes.headers.get('content-length');
        const sizeBytes = contentLength ? parseInt(contentLength) : 0;

        if (sizeBytes > 24 * 1024 * 1024) {
          console.log(`⚠️ فيديو كبير جداً (${Math.round(sizeBytes / 1024 / 1024)}MB)، جاري تجربة التالي...`);
          continue;
        }

        const buffer = Buffer.from(await videoRes.arrayBuffer());
        console.log(`✅ حُمّل مقطع TikTok: ${Math.round(buffer.length / 1024)}KB`);
        return { buffer, filename: 'edit.mp4' };
      } catch (downloadErr) {
        console.error(`⚠️ فشل تحميل المقطع: ${downloadErr.message}`);
        continue;
      }
    }

    return null;
  } catch (err) {
    console.error(`❌ TikTok error for "${gameName}": ${err.message}`);
    return null;
  }
}
