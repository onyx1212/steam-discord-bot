import { loadAccounts } from './loader.js';
import { getGameVariants, getAlternativeNames, formatMultipleResults } from './groq.js';


const MAX_RETRIES = 3;

export async function searchGame(requestedGame) {
  const accounts = loadAccounts();
  const allTriedVariants = new Set();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let variants;

    if (attempt === 1) {
      variants = await getGameVariants(requestedGame);
    } else {
      variants = await getAlternativeNames(requestedGame, attempt - 1);
    }

    const newVariants = variants.filter(v => !allTriedVariants.has(v.toLowerCase()));
    newVariants.forEach(v => allTriedVariants.add(v.toLowerCase()));

    console.log(`🔄 محاولة ${attempt}/${MAX_RETRIES} — المتغيرات: ${newVariants.join(' | ')}`);

    const exactMatches = findAccounts(accounts, newVariants, 'exact');

    if (exactMatches.length > 0) {
      console.log(`✅ تطابق مباشر: ${exactMatches.length} حساب`);
      return await formatMultipleResults(requestedGame, exactMatches);
    }

    const partialMatches = findAccounts(accounts, newVariants, 'partial');

    if (partialMatches.length > 0) {
      console.log(`🔍 تطابق جزئي: ${partialMatches.length} — جاري الفلترة...`);
      const filtered = filterByRelevance(requestedGame, partialMatches);
      if (filtered.length > 0) {
        console.log(`✅ بعد الفلترة: ${filtered.length} حساب`);
        return await formatMultipleResults(requestedGame, filtered);
      }
      console.log(`⚠️ كل التطابقات الجزئية لها علاقة ضعيفة، إعادة المحاولة...`);
    } else {
      console.log(`❌ المحاولة ${attempt}: لا نتائج`);
    }
  }

  console.log(`❌ لم يُعثر على نتيجة`);
  return null;
}

export async function searchGameRaw(requestedGame) {
  const accounts = loadAccounts();
  const allTriedVariants = new Set();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let variants;

    if (attempt === 1) {
      variants = await getGameVariants(requestedGame);
    } else {
      variants = await getAlternativeNames(requestedGame, attempt - 1);
    }

    const newVariants = variants.filter(v => !allTriedVariants.has(v.toLowerCase()));
    newVariants.forEach(v => allTriedVariants.add(v.toLowerCase()));

    const exactMatches = findAccounts(accounts, newVariants, 'exact');
    if (exactMatches.length > 0) return exactMatches[0];

    const partialMatches = findAccounts(accounts, newVariants, 'partial');
    if (partialMatches.length > 0) {
      const filtered = filterByRelevance(requestedGame, partialMatches);
      if (filtered.length > 0) return filtered[0];
    }
  }

  return null;
}

function findAccounts(accounts, variants, mode) {
  const results = [];
  const seenKeys = new Set();

  const cleanedVariants = variants
    .map(v => v.trim().toLowerCase())
    .filter(v => v.length >= 3);

  for (const account of accounts) {
    for (const gameLine of account.games) {
      const gameLineLower = gameLine.toLowerCase();
      const matchedVariant = cleanedVariants.find(v => {
        if (mode === 'exact') {
          return gameLineLower === v;
        } else {
          return gameLineContains(gameLineLower, v);
        }
      });

      if (matchedVariant) {
        const key = `${account.username}:${account.password}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({ ...account, matchedGame: gameLine, matchedVariant });
        }
        break;
      }
    }
  }

  return results;
}

function gameLineContains(gameLine, variant) {
  const idx = gameLine.indexOf(variant);
  if (idx === -1) return false;

  const before = idx === 0 ? null : gameLine[idx - 1];
  const after = idx + variant.length >= gameLine.length ? null : gameLine[idx + variant.length];
  const isBoundary = c => c === null || /[\s\-:,.()\[\]\/™®]/.test(c);

  return isBoundary(before) && isBoundary(after);
}

function filterByRelevance(requestedGame, accounts) {
  const reqLower = requestedGame.toLowerCase();
  const reqWords = reqLower.split(/\s+/).filter(w => w.length >= 3);

  return accounts.filter(account => {
    const gameLower = account.matchedGame.toLowerCase();

    const wordOverlap = reqWords.filter(w => gameLower.includes(w)).length;
    const overlapRatio = reqWords.length > 0 ? wordOverlap / reqWords.length : 0;

    if (overlapRatio >= 0.5) return true;

    if (gameLower.includes(reqLower) || reqLower.includes(gameLower)) return true;

    return false;
  });
}
