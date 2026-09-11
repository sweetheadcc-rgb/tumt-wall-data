#!/usr/bin/env node
// 頻道牆資料抓取器。零 npm 依賴,只用 Node 內建 fetch/fs。
// 用法:
//   CSV_URL=<Google Form 發布 CSV 連結> node fetch.mjs   # 正式:從 CSV 讀頻道清單
//   node fetch.mjs                                        # 開發:讀本地 channels.csv fixture
// 可調環境變數(都有預設,平常不用碰):
//   FETCH_TIMEOUT_MS  單一 HTTP 請求逾時(預設 15000);YouTube 偶爾掛住,不設會拖死整個 Action
//   CONCURRENCY       同時處理幾個頻道(預設 4);每個頻道最多 3 個請求
// Twitch 頻道需要另外設定(見 README「Twitch 設定」):
//   TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET  缺任一,Twitch 頻道本輪略過,不影響 YouTube
// 輸出 channels.json 的格式見 README「輸出格式」。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'resolve-cache.json');
const OUTPUT_PATH = join(__dirname, 'channels.json');
const CSV_FIXTURE_PATH = join(__dirname, 'channels.csv');

export const SCHEMA_VERSION = 2;
export const REQUIRED_HEADERS = ['組名', '頻道連結'];
export const MAX_LATEST = 6;

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 15_000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(...args) {
  console.error('[fetch]', ...args);
}

// 所有對外請求走這裡:統一 UA 與逾時。逾時丟 TimeoutError,由呼叫端當一般失敗處理。
function httpGet(url, extraHeaders = {}) {
  return fetch(url, {
    headers: { 'User-Agent': UA, ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// 有限並行的 map:保持輸出順序 = 輸入順序。
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 共用:HTML entity unescape
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
// CSV:時間戳記,組名,頻道連結(Google Form 發布 CSV 格式)
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

// 標頭必須含「組名」與「頻道連結」(= Google 表單的題目名稱)。缺了就明確報錯,
// 而不是默默回空陣列讓頻道牆變空白——那種故障在課堂上最難查。
export function parseCsv(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '') // Google 匯出偶爾帶 BOM
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length) {
    throw new Error(
      `CSV 缺少必要欄位:${missing.join('、')}(實際標頭:${header.join(' | ') || '(空)'})。` +
        '請確認 Google 表單題目名稱與 README 一致,或 CSV_URL 指到的是「發布到網路 → CSV」連結。',
    );
  }
  const idxTime = header.indexOf('時間戳記');
  const idxGroup = header.indexOf('組名');
  const idxUrl = header.indexOf('頻道連結');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const group = (cols[idxGroup] ?? '').trim();
    const url = (cols[idxUrl] ?? '').trim();
    const timestamp = idxTime >= 0 ? (cols[idxTime] ?? '').trim() : '';
    if (!group || !url) continue;
    rows.push({ group, url, timestamp });
  }
  return rows;
}

// 同組多次提交取最新一筆。Google Form 依提交時間依序附加資料列,
// 故檔案內較後面的列即為較新的提交,直接以陣列順序覆寫即可。
export function dedupeByGroup(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.group, row);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 頻道連結解析:YouTube /channel/UC…、/@handle、/c/名稱、/user/名稱;
//              Twitch twitch.tv/<login>(含 m.twitch.tv、查詢字串、路徑後綴)。
// ---------------------------------------------------------------------------
const TWITCH_RESERVED_PATHS = new Set(['videos','directory','p','settings','downloads','jobs','turbo','search','subscriptions','clip','collections','events','moderator','popout','embed','login','signup','user','team','friends','inventory','drops','wallet','prime']);

export function parseChannelRef(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').replace(/^m\./i, '');

  if (host === 'youtube.com') {
    const path = u.pathname.replace(/\/+$/, '');
    let m = path.match(/^\/channel\/(UC[\w-]{5,})$/);
    if (m) return { platform: 'youtube', type: 'id', value: m[1] };
    m = path.match(/^\/@([\w.-]+)$/);
    if (m) return { platform: 'youtube', type: 'handle', value: `@${m[1]}` };
    m = path.match(/^\/c\/([\w.-]+)$/);
    if (m) return { platform: 'youtube', type: 'custom', value: m[1] };
    m = path.match(/^\/user\/([\w.-]+)$/);
    if (m) return { platform: 'youtube', type: 'user', value: m[1] };
    return null;
  }

  if (host === 'twitch.tv') {
    // 只取路徑第一段當 login(丟掉 /home 這類後綴、查詢字串已被 URL 解析拆掉)。
    const m = u.pathname.replace(/\/+$/, '').match(/^\/([^/]+)/);
    if (!m) return null;
    const login = m[1].toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(login)) return null;
    // 站內保留路徑（VOD、分類、設定頁）不是頻道；學生貼影片連結時要明確判為「無法解析」而非帳號不存在。
    if (TWITCH_RESERVED_PATHS.has(login)) return null;
    return { platform: 'twitch', value: login };
  }

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

  const res = await httpGet(pageUrl, { 'Accept-Language': 'en-US,en;q=0.9' });
  if (!res.ok) throw new Error(`resolve ${pageUrl} -> HTTP ${res.status}`);
  const html = await res.text();

  // 優先信 canonical / og:url——它們指向「這頁本身代表的頻道」。
  // 頁面內文第一個 "channelId" 常常是別的頻道(相關影片、推薦頻道等),
  // 用它當首選會把 @handle 解析到錯的頻道(實測 @NASA 誤解到 Learn With NASA)。
  let m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{5,})">/);
  if (!m) m = html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{5,})">/);
  if (!m) m = html.match(/"channelId":"(UC[\w-]{5,})"/);
  if (!m) throw new Error(`cannot resolve channelId from ${pageUrl}`);

  cache[cacheKey] = m[1];
  return m[1];
}

// ---------------------------------------------------------------------------
// RSS:https://www.youtube.com/feeds/videos.xml?channel_id=UC…
// ---------------------------------------------------------------------------
export function parseRss(xml) {
  const authorMatch = xml.match(/<author>\s*<name>([^<]*)<\/name>/);
  const channelName = authorMatch ? unescapeEntities(authorMatch[1]) : '';

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let em;
  while ((em = entryRe.exec(xml)) && entries.length < MAX_LATEST) {
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
  const res = await httpGet(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}

// ---------------------------------------------------------------------------
// live 偵測:https://www.youtube.com/channel/UC…/streams
//
// 規格原訂打 /channel/UC…/live 頁解析 player 回應裡的 videoDetails.isLive。
// 實測(2026-08-19)發現:GitHub Actions runner(美國資料中心 IP)打 /live 時,
// YouTube 對其 player 回應加上 playabilityStatus:"LOGIN_REQUIRED"("Sign in to
// confirm you're not a bot")反爬蟲擋板,videoDetails 物件因此被抽空
// videoId/isLive 等欄位;本機打同一支程式碼卻正常,導致同一份程式碼兩邊行為
// 不同——開播燈在正式環境永遠不亮。
//
// 改抓「直播」分頁 /streams:這是頻道瀏覽/列表端點,不吃 player 反爬蟲擋板,
// 本機與 GitHub Actions runner 實測皆正常(含用 NASA 真實 ISS 直播驗證正例)。
// 開播中的直播固定釘在該分頁最前面,縮圖疊加
// "badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE" 徽章;抓不到此徽章即未開播。
// startTimestamp 這個分頁本來就沒有,依規格保留欄位、抓不到填 null。
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
  const res = await httpGet(`https://www.youtube.com/channel/${channelId}/streams`, {
    'Accept-Language': 'en-US,en;q=0.9',
  });
  if (!res.ok) throw new Error(`streams HTTP ${res.status}`);
  const html = await res.text();
  return parseStreamsPage(html);
}

// ---------------------------------------------------------------------------
// Twitch:Helix API。零 npm 依賴,只用內建 fetch。
// 環境變數 TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET 缺任一,呼叫端(prepareTwitchContext)
// 會直接讓該輪 Twitch 頻道全部略過,不打任何 Twitch 端點——不可讓整輪失敗、不可影響 YouTube。
// ---------------------------------------------------------------------------
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

function twitchHeaders(clientId, token) {
  return { 'Client-Id': clientId, Authorization: `Bearer ${token}` };
}

// Helix 一次最多帶 100 個 login/user_id,超過就分批打。
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// App access token(client_credentials),一輪只拿一次,由 prepareTwitchContext 呼叫。
export async function fetchTwitchAppToken({ clientId, clientSecret }) {
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Twitch token HTTP ${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Twitch token 回應缺 access_token');
  return json.access_token;
}

// 批次查 login → { id, displayName, avatar }。login 找不到的不會出現在回傳的 Map 裡。
export async function fetchTwitchUsers(logins, { clientId, token }) {
  const map = new Map();
  for (const part of chunkArray(logins, 100)) {
    if (part.length === 0) continue;
    const qs = part.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    const res = await httpGet(`${TWITCH_API_BASE}/users?${qs}`, twitchHeaders(clientId, token));
    if (!res.ok) throw new Error(`Twitch users HTTP ${res.status}`);
    const json = await res.json();
    for (const u of json.data || []) {
      map.set(String(u.login).toLowerCase(), { id: u.id, displayName: u.display_name, avatar: u.profile_image_url });
    }
  }
  return map;
}

// 批次查目前在線的頻道:login → { title, viewers, startedAt, thumbnail }。不在線的不在回傳 Map 裡。
export async function fetchTwitchStreams(logins, { clientId, token }) {
  const map = new Map();
  for (const part of chunkArray(logins, 100)) {
    if (part.length === 0) continue;
    const qs = part.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const res = await httpGet(`${TWITCH_API_BASE}/streams?${qs}`, twitchHeaders(clientId, token));
    if (!res.ok) throw new Error(`Twitch streams HTTP ${res.status}`);
    const json = await res.json();
    for (const s of json.data || []) {
      map.set(String(s.user_login).toLowerCase(), {
        title: s.title,
        viewers: s.viewer_count,
        startedAt: s.started_at,
        thumbnail: String(s.thumbnail_url || '').replace('{width}x{height}', '640x360'),
      });
    }
  }
  return map;
}

// 單一頻道最近幾支 VOD(type=archive)。很多頻道關 VOD,回傳空陣列是正常情況,不是錯誤。
export async function fetchTwitchVideos(userId, { clientId, token }) {
  const res = await httpGet(
    `${TWITCH_API_BASE}/videos?user_id=${encodeURIComponent(userId)}&type=all&first=${MAX_LATEST}`,
    twitchHeaders(clientId, token),
  );
  if (!res.ok) throw new Error(`Twitch videos HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).slice(0, MAX_LATEST).map((v) => ({
    videoId: v.id,
    title: v.title,
    url: `https://www.twitch.tv/videos/${v.id}`,
    published: v.published_at || v.created_at || '',
    thumbnail: String(v.thumbnail_url || '').replace('%{width}','640').replace('%{height}','360'),
    kind: v.type || '',
  }));
}

// 一輪只跑一次的 Twitch 批次前置作業:拿 token → 批次查 users → 批次查 streams。
// 任何一步失敗都只影響 Twitch 這批(呼叫端把 ctx.error 當成每個 Twitch 頻道的失敗原因,
// 走既有的 stale/skipped 邏輯,不影響 YouTube)。streams 失敗則降級成「全部視為未開播」,
// 不算頻道失敗(比照 YouTube live 偵測失敗的容錯方式)。
export async function prepareTwitchContext(logins, options = {}) {
  const {
    env = process.env,
    cache = {},
    logger = log,
    getToken = fetchTwitchAppToken,
    getUsers = fetchTwitchUsers,
    getStreams = fetchTwitchStreams,
  } = options;

  const ctx = { usersByLogin: new Map(), streamsByLogin: new Map(), error: null, clientId: null, token: null };
  const uniqueLogins = [...new Set(logins)];
  if (uniqueLogins.length === 0) return ctx;

  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    ctx.error = 'TWITCH_CLIENT_ID/SECRET 未設定，Twitch 頻道本輪略過';
    logger(ctx.error);
    return ctx;
  }
  ctx.clientId = clientId;

  try {
    ctx.token = await getToken({ clientId, clientSecret });
  } catch (err) {
    ctx.error = `Twitch token 取得失敗: ${err.message}`;
    logger(ctx.error);
    return ctx;
  }

  try {
    ctx.usersByLogin = await getUsers(uniqueLogins, { clientId, token: ctx.token });
    // login→id 也快取(key 帶 twitch: 前綴),與 YouTube 的 resolve-cache 共用同一個檔案。
    for (const [loginKey, user] of ctx.usersByLogin) cache[`twitch:${loginKey}`] = user.id;
  } catch (err) {
    ctx.error = `Twitch users 查詢失敗: ${err.message}`;
    logger(ctx.error);
    return ctx;
  }

  try {
    ctx.streamsByLogin = await getStreams(uniqueLogins, { clientId, token: ctx.token });
  } catch (err) {
    logger(`Twitch streams 查詢失敗(不影響其餘資料,本輪視為全部未開播): ${err.message}`);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// 彙整:rows → channels(可注入 resolve/rss/live/twitch* 供離線測試)
//
// 每個頻道的結果三選一:
//   ok      本輪抓到 → stale:false、fetchedAt = 現在
//   stale   本輪失敗但上一輪有資料 → 沿用舊資料,stale:true、error = 本輪錯誤、fetchedAt 保留舊值
//           (前端可據此標「資料可能過時」,而不是把上一小時的影片當成最新)
//   skipped 本輪失敗且沒有舊資料 → 不進 channels,列在 skipped[] 供除錯
// live 偵測失敗不算頻道失敗(只影響開播燈),頻道仍為 ok、live=null。
// ---------------------------------------------------------------------------
export async function collectChannels(rows, options = {}) {
  const {
    cache = {},
    prev = { channels: [] },
    now = () => new Date().toISOString(),
    concurrency = CONCURRENCY,
    resolve = resolveChannelId,
    rss = fetchRss,
    live = fetchLive,
    logger = log,
    env = process.env,
    twitchToken = fetchTwitchAppToken,
    twitchUsers = fetchTwitchUsers,
    twitchStreams = fetchTwitchStreams,
    twitchVideos = fetchTwitchVideos,
  } = options;
  const prevByGroup = new Map((prev?.channels || []).map((c) => [c.group, c]));

  // 先把每一列的頻道連結解析好,順便收集 Twitch login 清單,一輪只跑一次 Twitch 前置批次查詢
  // (token → users → streams),不因為有多組 Twitch 頻道就重複打好幾次同樣的 Helix 端點。
  const parsed = rows.map((row) => ({ row, ref: parseChannelRef(row.url) }));
  const twitchLogins = parsed.filter((p) => p.ref?.platform === 'twitch').map((p) => p.ref.value);
  const twitchCtx = await prepareTwitchContext(twitchLogins, {
    env,
    cache,
    logger,
    getToken: twitchToken,
    getUsers: twitchUsers,
    getStreams: twitchStreams,
  });

  const results = await mapLimit(parsed, concurrency, async ({ row, ref }) => {
    const { group, url } = row;
    try {
      if (!ref) throw new Error(`無法解析頻道連結: ${url}`);

      if (ref.platform === 'twitch') {
        if (twitchCtx.error) throw new Error(twitchCtx.error);
        const login = ref.value;
        const user = twitchCtx.usersByLogin.get(login);
        if (!user) throw new Error('Twitch 帳號不存在或已改名');

        const streamInfo = twitchCtx.streamsByLogin.get(login) || null;
        const videos = await twitchVideos(user.id, { clientId: twitchCtx.clientId, token: twitchCtx.token }).catch(
          (err) => {
            logger(`${group}: Twitch VOD 抓取失敗(不影響其餘資料): ${err.message}`);
            return [];
          },
        );
        const channelUrl = `https://www.twitch.tv/${login}`;

        logger(`${group}: OK(twitch login=${login}, live=${streamInfo ? 'true' : 'false'}, latest=${videos.length})`);
        return {
          status: 'ok',
          channel: {
            group,
            platform: 'twitch',
            channelId: user.id,
            channelName: user.displayName,
            channelUrl,
            avatar: user.avatar,
            live: streamInfo
              ? { title: streamInfo.title, url: channelUrl, thumbnail: streamInfo.thumbnail, viewers: streamInfo.viewers, startedAt: streamInfo.startedAt }
              : null,
            latest: videos,
            fetchedAt: now(),
            stale: false,
          },
        };
      }

      const channelId = await resolve(ref, cache);
      const { channelName, entries } = await rss(channelId);
      const liveInfo = await live(channelId).catch((err) => {
        logger(`${group}: live 偵測失敗(不影響其餘資料): ${err.message}`);
        return null;
      });

      logger(`${group}: OK(channelId=${channelId}, live=${liveInfo ? 'true' : 'false'}, latest=${entries.length})`);
      return {
        status: 'ok',
        channel: {
          group,
          platform: 'youtube',
          channelId,
          channelName,
          channelUrl: `https://www.youtube.com/channel/${channelId}`,
          live: liveInfo,
          latest: entries,
          fetchedAt: now(),
          stale: false,
        },
      };
    } catch (err) {
      const old = prevByGroup.get(group);
      if (old) {
        logger(`${group}: 抓取失敗(${err.message}),沿用上一輪資料`);
        // eslint-disable-next-line no-unused-vars
        const { error: _prevError, ...keep } = old;
        return { status: 'stale', channel: { ...keep, stale: true, error: err.message } };
      }
      logger(`${group}: 抓取失敗(${err.message}),無上一輪資料可沿用,本輪跳過`);
      return { status: 'skipped', group, error: err.message };
    }
  });

  const channels = results.filter((r) => r.status !== 'skipped').map((r) => r.channel);
  const skipped = results.filter((r) => r.status === 'skipped').map(({ group, error }) => ({ group, error }));
  const stats = {
    total: rows.length,
    ok: results.filter((r) => r.status === 'ok').length,
    stale: results.filter((r) => r.status === 'stale').length,
    skipped: skipped.length,
  };
  return { channels, skipped, stats };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function loadCsvText() {
  const csvUrl = process.env.CSV_URL;
  if (csvUrl) {
    log('CSV_URL 有值,從遠端抓頻道清單');
    const res = await fetch(csvUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CSV_URL HTTP ${res.status}`);
    return res.text();
  }
  log('CSV_URL 未設定,讀本地 channels.csv fixture');
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
  log(`頻道清單:${rows.length} 組(逾時 ${FETCH_TIMEOUT_MS}ms、並行 ${CONCURRENCY})`);

  const cache = await loadJson(CACHE_PATH, {});
  const prev = await loadJson(OUTPUT_PATH, { channels: [] });

  const { channels, skipped, stats } = await collectChannels(rows, { cache, prev });

  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf-8');

  // 清單有東西卻一個都沒抓到(通常是 YouTube 整批擋、或網路壞)→ 不覆寫、以非零結束,
  // 讓 Action 亮紅而不是把頻道牆寫成空白。
  if (rows.length > 0 && channels.length === 0) {
    log(`fatal:${rows.length} 組全部失敗且無舊資料,保留原 channels.json 不覆寫`);
    for (const s of skipped) log(`  - ${s.group}: ${s.error}`);
    process.exitCode = 1;
    return;
  }

  const output = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), stats, skipped, channels };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  log(`完成:寫入 ${channels.length} 個頻道(ok=${stats.ok}, stale=${stats.stale}, skipped=${stats.skipped})`);
}

// 只有直接執行(node fetch.mjs)才跑 main;被 test.mjs import 時不跑。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('[fetch] fatal:', err);
    process.exitCode = 1;
  });
}
