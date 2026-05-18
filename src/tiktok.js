export async function searchTikTokEdit(gameName) {
  const query = encodeURIComponent(`${gameName} edit`);
  const url = `https://www.tikwm.com/api/feed/search?keywords=${query}&count=20&cursor=0&HD=1`;

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
    const video = sorted[0];

    const authorId = video?.author?.unique_id || video?.author_id;
    const videoId = video?.video_id || video?.id;

    if (!authorId || !videoId) return null;

    return `https://www.tiktok.com/@${authorId}/video/${videoId}`;
  } catch (err) {
    console.error(`❌ TikTok error for "${gameName}": ${err.message}`);
    return null;
  }
}
