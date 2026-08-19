#!/usr/bin/env node
// 頻道牆資料抓取器。零 npm 依賴，只用 Node 內建 fetch/fs。
// 用法：
//   CSV_URL=<Google Form 發布 CSV 連結> node fetch.mjs   # 正式：從 CSV 讀頻道清單
//   node fetch.mjs                                        # 開發：讀本地 channels.csv fixture
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'resolve-cache.json');
const OUTPUT_PATH = join(__dirname, 'channels.json');
const CSV_FIXTURE_PATH = join(__dirname, 'channels.csv');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(...args) {
  console.error('[fetch]', ...args);
}

// ---------------------------------------------------------------------------
// 共用：HTML entity unescape
// ---------------------------------------------------------------------------
function unescapeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// CSV：時間戳記,組名,頻道連結（Google Form 發布 CSV 格式）
// ---------------------------------------------------------------------------
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsv(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idxTime = header.indexOf('時間戳記');
  const idxGroup = header.indexOf('組名');
  const idxUrl = header.indexOf('頻道連結');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const group = (cols[idxGroup] ?? '').trim();
    const url = (cols[idxUrl] ?? '').trim();
    const timestamp = (cols[idxTime] ?? '').trim();
    if (!group || !url) continue;
    rows.push({ group, url, timestamp });
  }
  return rows;
}

// 同組多次提交取最新一筆。Google Form 依提交時間依序附加資料列，
// 故檔案內較後面的列即為較新的提交，直接以陣列順序覆寫即可。
export function dedupeByGroup(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.group, row);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 頻道連結解析：/channel/UC…、/@handle、/c/名稱、/user/名稱
// ---------------------------------------------------------------------------
export function parseChannelRef(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').replace(/^m\./i, '');
  if (host !== 'youtube.com') return null;

  const path = u.pathname.replace(/\/+$/, '');
  let m = path.match(/^\/channel\/(UC[\w-]{5,})$/);
  if (m) return { type: 'id', value: m[1] };
  m = path.match(/^\/@([\w.-]+)$/);
  if (m) return { type: 'handle', value: `@${m[1]}` };
  m = path.match(/^\/c\/([\w.-]+)$/);
  if (m) return { type: 'custom', value: m[1] };
  m = path.match(/^\/user\/([\w.-]+)$/);
  if (m) return { type: 'user', value: m[1] };
  return null;
}

export async function resolveChannelId(ref, cache) {
  if (ref.type === 'id') return ref.value;

  const cacheKey = `${ref.type}:${ref.value}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const pageUrl =
    ref.type === 'handle'
      ? `https://www.youtube.com/${ref.value}`
      : ref.type === 'custom'
        ? `https://www.youtube.com/c/${ref.value}`
        : `https://www.youtube.com/user/${ref.value}`;

  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`resolve ${pageUrl} -> HTTP ${res.status}`);
  const html = await res.text();

  // 優先信 canonical / og:url——它們指向「這頁本身代表的頻道」。
  // 頁面內文第一個 "channelId" 常常是別的頻道（相關影片、推薦頻道等），
  // 用它當首選會把 @handle 解析到錯的頻道（實測 @NASA 誤解到 Learn With NASA）。
  let m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{5,})">/);
  if (!m) m = html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{5,})">/);
  if (!m) m = html.match(/"channelId":"(UC[\w-]{5,})"/);
  if (!m) throw new Error(`cannot resolve channelId from ${pageUrl}`);

  cache[cacheKey] = m[1];
  return m[1];
}

// ---------------------------------------------------------------------------
// RSS：https://www.youtube.com/feeds/videos.xml?channel_id=UC…
// ---------------------------------------------------------------------------
export function parseRss(xml) {
  const authorMatch = xml.match(/<author>\s*<name>([^<]*)<\/name>/);
  const channelName = authorMatch ? unescapeEntities(authorMatch[1]) : '';

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let em;
  while ((em = entryRe.exec(xml)) && entries.length < 6) {
    const block = em[1];
    const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!videoId) continue;
    const title = (block.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const published = (block.match(/<published>([^<]*)<\/published>/) || [])[1] || '';
    entries.push({
      videoId,
      title: unescapeEntities(title),
      publishedAt: published,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return { channelName, entries };
}

export async function fetchRss(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}

// ---------------------------------------------------------------------------
// live 偵測：https://www.youtube.com/channel/UC…/streams
//
// 規格原訂打 /channel/UC…/live 頁解析 player 回應裡的 videoDetails.isLive。
// 實測（2026-08-19）發現：GitHub Actions runner（美國資料中心 IP）打 /live 時，
// YouTube 對其 player 回應加上 playabilityStatus:"LOGIN_REQUIRED"（"Sign in to
// confirm you're not a bot"）反爬蟲擋板，videoDetails 物件因此被抽空
// videoId/isLive 等欄位；本機打同一支程式碼卻正常，導致同一份程式碼兩邊行為
// 不同——開播燈在正式環境永遠不亮。
//
// 改抓「直播」分頁 /streams：這是頻道瀏覽／列表端點，不吃 player 反爬蟲擋板，
// 本機與 GitHub Actions runner 實測皆正常（含用 NASA 真實 ISS 直播驗證正例）。
// 開播中的直播固定釘在該分頁最前面，縮圖疊加
// "badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE" 徽章；抓不到此徽章即未開播。
// startTimestamp 這個分頁本來就沒有，依規格保留欄位、抓不到填 null。
// ---------------------------------------------------------------------------
export function parseStreamsPage(html) {
  const badgeIdx = html.indexOf('"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"');
  if (badgeIdx === -1) return null;

  const scope = html.slice(badgeIdx, badgeIdx + 6000);
  const videoId = (scope.match(/"animationActivationTargetId":"([\w-]{11})"/) || [])[1];
  if (!videoId) return null;

  const rawTitle = (
    scope.match(/"metadata":\{"lockupMetadataViewModel":\{"title":\{"content":"((?:\\.|[^"\\])*)"/) || []
  )[1];
  let title = '';
  if (rawTitle !== undefined) {
    try {
      title = JSON.parse(`"${rawTitle}"`);
    } catch {
      title = unescapeEntities(rawTitle);
    }
  }

  return {
    videoId,
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    startedAt: null,
  };
}

export async function fetchLive(channelId) {
  const res = await fetch(`https://www.youtube.com/channel/${channelId}/streams`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`streams HTTP ${res.status}`);
  const html = await res.text();
  return parseStreamsPage(html);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function loadCsvText() {
  const csvUrl = process.env.CSV_URL;
  if (csvUrl) {
    log('CSV_URL 有值，從遠端抓頻道清單');
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`CSV_URL HTTP ${res.status}`);
    return res.text();
  }
  log('CSV_URL 未設定，讀本地 channels.csv fixture');
  return readFile(CSV_FIXTURE_PATH, 'utf-8');
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

export async function main() {
  const csvText = await loadCsvText();
  const rows = dedupeByGroup(parseCsv(csvText));
  log(`頻道清單：${rows.length} 組`);

  const cache = await loadJson(CACHE_PATH, {});
  const prev = await loadJson(OUTPUT_PATH, { channels: [] });
  const prevByGroup = new Map((prev.channels || []).map((c) => [c.group, c]));

  const channels = [];
  for (const row of rows) {
    const { group, url } = row;
    try {
      const ref = parseChannelRef(url);
      if (!ref) throw new Error(`無法解析頻道連結: ${url}`);

      const channelId = await resolveChannelId(ref, cache);
      const { channelName, entries } = await fetchRss(channelId);
      const live = await fetchLive(channelId).catch((err) => {
        log(`${group}: live 偵測失敗（不影響其餘資料）: ${err.message}`);
        return null;
      });

      channels.push({
        group,
        channelId,
        channelName,
        channelUrl: `https://www.youtube.com/channel/${channelId}`,
        live,
        latest: entries,
      });
      log(`${group}: OK（channelId=${channelId}, live=${live ? 'true' : 'false'}, latest=${entries.length}）`);
    } catch (err) {
      log(`${group}: 抓取失敗（${err.message}）`);
      const old = prevByGroup.get(group);
      if (old) {
        log(`${group}: 沿用上一輪資料`);
        channels.push(old);
      } else {
        log(`${group}: 無上一輪資料可沿用，本輪跳過`);
      }
    }
  }

  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  const output = { updatedAt: new Date().toISOString(), channels };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  log(`完成：寫入 ${channels.length} 個頻道`);
}

// 只有直接執行（node fetch.mjs）才跑 main；被 test.mjs import 時不跑。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('[fetch] fatal:', err);
    process.exitCode = 1;
  });
}
