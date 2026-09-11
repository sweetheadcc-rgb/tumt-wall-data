// 離線自檢：不打任何網路，全部餵假資料驗證解析邏輯。
// 執行：node test.mjs
import assert from 'node:assert/strict';
import { parseCsv, dedupeByGroup, parseChannelRef, parseRss, parseStreamsPage, resolveChannelId, collectChannels, mapLimit } from './fetch.mjs';

let failed = false;

async function test(name, fn) {
  try {
    await fn();
    console.log(`OK   - ${name}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL - ${name}`);
    console.error(err);
  }
}

await test('CSV 基本解析', () => {
  const csv = '時間戳記,組名,頻道連結\n2026/8/19 9:00:00,夜市巡航隊,https://www.youtube.com/channel/UCabcdefghij1234567890\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, '夜市巡航隊');
  assert.equal(rows[0].url, 'https://www.youtube.com/channel/UCabcdefghij1234567890');
});

await test('CSV 空字串 / 只有標頭不炸，回傳空陣列', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('時間戳記,組名,頻道連結\n'), []);
});

await test('CSV 同組多次提交，取最新一筆（陣列後段覆寫前段）', () => {
  const csv = [
    '時間戳記,組名,頻道連結',
    '2026/8/18 20:00:00,深夜巡航隊,https://www.youtube.com/channel/UColdoldoldold000000000',
    '2026/8/19 09:00:00,深夜巡航隊,https://www.youtube.com/channel/UCnewnewnewnew111111111',
  ].join('\n');
  const rows = dedupeByGroup(parseCsv(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://www.youtube.com/channel/UCnewnewnewnew111111111');
});

await test('頻道連結三種格式解析（/channel/、/@handle、/c/），附 platform:youtube', () => {
  assert.deepEqual(parseChannelRef('https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow'), {
    platform: 'youtube',
    type: 'id',
    value: 'UCSJ4gkVC6NrvII8umztf0Ow',
  });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@NASA'), { platform: 'youtube', type: 'handle', value: '@NASA' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/c/SomeChannel'), { platform: 'youtube', type: 'custom', value: 'SomeChannel' });
});

await test('格式錯誤的頻道連結回傳 null，不拋例外', () => {
  assert.equal(parseChannelRef('not-a-valid-url'), null);
  assert.equal(parseChannelRef('https://example.com/foo'), null);
  assert.equal(parseChannelRef(''), null);
});

await test('Twitch 頻道連結五種變體解析，皆回傳 platform:twitch、login 轉小寫', () => {
  assert.deepEqual(parseChannelRef('https://twitch.tv/simon_tw'), { platform: 'twitch', value: 'simon_tw' });
  assert.deepEqual(parseChannelRef('https://www.twitch.tv/Simon_TW'), { platform: 'twitch', value: 'simon_tw' });
  assert.deepEqual(parseChannelRef('https://m.twitch.tv/simon_tw/home?tt_content=channel'), {
    platform: 'twitch',
    value: 'simon_tw',
  });
  assert.deepEqual(parseChannelRef('https://www.twitch.tv/simon_tw?sr=a'), { platform: 'twitch', value: 'simon_tw' });
  assert.deepEqual(parseChannelRef('https://twitch.tv/simon_tw/'), { platform: 'twitch', value: 'simon_tw' });
});

await test('Twitch 站內保留路徑（VOD、分類、設定頁）回傳 null，不當成 login', () => {
  for (const u of ['https://www.twitch.tv/videos/123456789', 'https://twitch.tv/directory/category/just-chatting', 'https://www.twitch.tv/settings/profile', 'https://m.twitch.tv/downloads'])
    assert.equal(parseChannelRef(u), null, u);
});

await test('Twitch login 不合法（含連字號、太短）回傳 null', () => {
  assert.equal(parseChannelRef('https://twitch.tv/a-b'), null);
  assert.equal(parseChannelRef('https://twitch.tv/ab'), null);
});

await test('RSS 解析：抽出 videoId/title/publishedAt，並做 entity unescape', () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <author><name>測試頻道 &amp; Co</name></author>
  <entry>
    <yt:videoId>abcdefghijk</yt:videoId>
    <title>標題 &lt;test&gt;</title>
    <published>2026-08-19T09:00:00+00:00</published>
  </entry>
</feed>`;
  const { channelName, entries } = parseRss(xml);
  assert.equal(channelName, '測試頻道 & Co');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, 'abcdefghijk');
  assert.equal(entries[0].title, '標題 <test>');
  assert.equal(entries[0].publishedAt, '2026-08-19T09:00:00+00:00');
  assert.equal(entries[0].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(entries[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
});

await test('RSS 解析：最多取 6 部影片', () => {
  const entryBlock = (id) => `<entry><yt:videoId>${id}</yt:videoId><title>t</title><published>2026-08-19T00:00:00Z</published></entry>`;
  const xml = `<feed>${Array.from({ length: 9 }, (_, i) => entryBlock(`vid${i}abcdef`.slice(0, 11))).join('')}</feed>`;
  const { entries } = parseRss(xml);
  assert.equal(entries.length, 6);
});

// live 偵測改抓 /streams 分頁（原因見 fetch.mjs 內註解：/live 頁的 player 回應在
// GitHub Actions runner 上被 YouTube 反爬蟲擋板 LOGIN_REQUIRED 抽空欄位，
// /streams 分頁不受影響，2026-08-19 已用 runner 實跑＋NASA 真實直播驗證）。
await test('streams 分頁：LIVE 徽章時判定為直播中，抽出 videoId/title', () => {
  const html = [
    '"overlays":[{"thumbnailBottomOverlayViewModel":{"badges":[{"thumbnailBadgeViewModel":{',
    '"icon":{"sources":[{"clientResource":{"imageName":"LIVE"}}]},"text":"LIVE",',
    '"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE",',
    '"animationActivationTargetId":"xyz12345678"}}]}}],',
    '"metadata":{"lockupMetadataViewModel":{"title":{"content":"正在直播中 \\u0026 test"},"metadata":{}}}',
  ].join('');
  const live = parseStreamsPage(html);
  assert.ok(live, 'expected live object, got null');
  assert.equal(live.videoId, 'xyz12345678');
  assert.equal(live.title, '正在直播中 & test');
  assert.equal(live.url, 'https://www.youtube.com/watch?v=xyz12345678');
  assert.equal(live.startedAt, null);
});

await test('streams 分頁：沒有 LIVE 徽章時判定為未直播（回傳 null）', () => {
  const html = '<html><body>這個頻道 streams 分頁沒有直播中的內容，只有舊影片列表</body></html>';
  assert.equal(parseStreamsPage(html), null);
});

await test('streams 分頁：有 LIVE 徽章但抓不到 videoId 時保守回傳 null', () => {
  const html = '"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE","text":"LIVE"';
  assert.equal(parseStreamsPage(html), null);
});

await test('resolveChannelId：canonical 優先於內文第一個 channelId（防 @handle 誤解析回歸）', async () => {
  // 實測回歸案例：@NASA 頁面內文第一個 "channelId" 是別的頻道（Learn With NASA），
  // 正確答案在 <link rel="canonical">。這條測試假造同時含「錯的第一個 channelId」
  // 與「正確 canonical」的 HTML，斷言一定取 canonical，不取內文第一個。
  const fakeHtml = [
    '<html><head>',
    '<link rel="canonical" href="https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ">',
    '</head><body>',
    '<script>{"channelId":"UC9SM7V7J1pAhPabOUST01fw","context":"related video sidebar"}</script>',
    '</body></html>',
  ].join('\n');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => fakeHtml });
  try {
    const cache = {};
    const id = await resolveChannelId({ type: 'handle', value: '@NASA' }, cache);
    assert.equal(id, 'UCLA_DiR1FfKNvjuUpBHmylQ');
    assert.equal(cache['handle:@NASA'], 'UCLA_DiR1FfKNvjuUpBHmylQ');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('resolveChannelId：抓不到 canonical/og:url 才後備用內文第一個 channelId', async () => {
  const fakeHtml = '<html><body><script>{"channelId":"UCfallbackfallback0000"}</script></body></html>';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => fakeHtml });
  try {
    const id = await resolveChannelId({ type: 'handle', value: '@NoCanonical' }, {});
    assert.equal(id, 'UCfallbackfallback0000');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('CSV 標頭缺「組名」或「頻道連結」→ 明確報錯(不默默回空陣列)', () => {
  assert.throws(() => parseCsv('時間戳記,隊名,YouTube\n1,a,b\n'), /缺少必要欄位:組名、頻道連結/);
  assert.throws(() => parseCsv('組名,連結\nx,y\n'), /實際標頭:組名 \| 連結/);
});

await test('CSV 帶 BOM、無時間戳記欄也能解析', () => {
  const rows = parseCsv('﻿組名,頻道連結\n夜市隊,https://www.youtube.com/channel/UCabcdefghij1234567890\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, '夜市隊');
  assert.equal(rows[0].timestamp, '');
});

await test('mapLimit:保持輸入順序、並行上限生效', async () => {
  let inFlight = 0, peak = 0;
  const out = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return ms;
  });
  assert.deepEqual(out, [30, 10, 20, 5]);
  assert.equal(peak, 2);
});

// collectChannels 離線測試:把 resolve/rss/live 三個網路相依全部注入假函式。
const ID = (n) => `UC${String(n).padStart(22, '0')}`;
const rowsFixture = [
  { group: 'A隊', url: `https://www.youtube.com/channel/${ID(1)}` },
  { group: 'B隊', url: 'https://www.youtube.com/@bteam' },
  { group: 'C隊', url: 'not a url' },
  { group: 'D隊', url: `https://www.youtube.com/channel/${ID(4)}` },
];
const fakeRss = async (id) => ({ channelName: `頻道${id.slice(-1)}`, entries: [{ videoId: 'v' + id.slice(-1) }] });
const silent = () => {};

await test('collectChannels:正常路徑 → ok、stale:false、fetchedAt、stats', async () => {
  const cache = {};
  const { channels, skipped, stats } = await collectChannels(rowsFixture.slice(0, 1), {
    cache, now: () => 'T1', resolve: async (ref) => ref.value, rss: fakeRss, live: async () => null, logger: silent,
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].group, 'A隊');
  assert.equal(channels[0].channelName, '頻道1');
  assert.equal(channels[0].fetchedAt, 'T1');
  assert.equal(channels[0].stale, false);
  assert.equal(channels[0].live, null);
  assert.deepEqual(skipped, []);
  assert.deepEqual(stats, { total: 1, ok: 1, stale: 0, skipped: 0 });
});

await test('collectChannels:抓失敗但有上一輪 → 沿用舊資料並標 stale:true + error;保留舊 fetchedAt', async () => {
  const prev = { channels: [{ group: 'A隊', channelId: ID(1), channelName: '舊名', latest: [], live: null, fetchedAt: 'T0', stale: false }] };
  const { channels, stats } = await collectChannels(rowsFixture.slice(0, 1), {
    prev, now: () => 'T1', resolve: async (ref) => ref.value, rss: async () => { throw new Error('RSS HTTP 503'); }, live: async () => null, logger: silent,
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].channelName, '舊名');
  assert.equal(channels[0].stale, true);
  assert.equal(channels[0].error, 'RSS HTTP 503');
  assert.equal(channels[0].fetchedAt, 'T0');
  assert.deepEqual(stats, { total: 1, ok: 0, stale: 1, skipped: 0 });
});

await test('collectChannels:抓失敗且無上一輪 → 不進 channels、列在 skipped', async () => {
  const { channels, skipped, stats } = await collectChannels([rowsFixture[2]], {
    resolve: async (ref) => ref.value, rss: fakeRss, live: async () => null, logger: silent,
  });
  assert.equal(channels.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].group, 'C隊');
  assert.match(skipped[0].error, /無法解析頻道連結/);
  assert.deepEqual(stats, { total: 1, ok: 0, stale: 0, skipped: 1 });
});

await test('collectChannels:live 偵測失敗不算頻道失敗(仍 ok、live=null)', async () => {
  const { channels, stats } = await collectChannels(rowsFixture.slice(0, 1), {
    resolve: async (ref) => ref.value, rss: fakeRss, live: async () => { throw new Error('streams HTTP 429'); }, logger: silent,
  });
  assert.equal(channels[0].stale, false);
  assert.equal(channels[0].live, null);
  assert.equal(stats.ok, 1);
});

await test('collectChannels:並行下輸出順序 = CSV 順序;stale 後再次成功會清掉 error', async () => {
  const prev = { channels: [{ group: 'B隊', channelId: ID(2), channelName: '舊B', latest: [], live: null, fetchedAt: 'T0', stale: true, error: '上次壞掉' }] };
  const resolve = async (ref) => (ref.type === 'handle' ? ID(2) : ref.value);
  const rss = async (id) => { await new Promise((r) => setTimeout(r, id.endsWith('1') ? 30 : 1)); return fakeRss(id); };
  const { channels, skipped } = await collectChannels(rowsFixture, { prev, concurrency: 3, now: () => 'T1', resolve, rss, live: async () => null, logger: silent });
  assert.deepEqual(channels.map((c) => c.group), ['A隊', 'B隊', 'D隊']);
  assert.deepEqual(skipped.map((s) => s.group), ['C隊']);
  const b = channels[1];
  assert.equal(b.stale, false);
  assert.equal(b.fetchedAt, 'T1');
  assert.equal('error' in b, false);
});

// ---------------------------------------------------------------------------
// Twitch 離線測試:Helix users/streams/videos 全部注入假函式,不打真網路。
// ---------------------------------------------------------------------------
const twitchRow = (group, login) => ({ group, url: `https://twitch.tv/${login}` });
const fakeTwitchToken = async ({ clientId, clientSecret }) => {
  assert.equal(clientId, 'cid');
  assert.equal(clientSecret, 'csecret');
  return 'fake-app-token';
};
const twitchEnvOk = { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' };

await test('collectChannels:Twitch 在線頻道 → live 含 title/url/thumbnail/viewers/startedAt，latest 用 published 欄位', async () => {
  const cache = {};
  const fakeUsers = async (logins) => {
    const map = new Map();
    for (const l of logins) if (l === 'tteam') map.set(l, { id: 'TW1', displayName: 'T隊直播間', avatar: 'https://static/av.png' });
    return map;
  };
  const fakeStreams = async () => new Map([['tteam', { title: '在線標題', viewers: 88, startedAt: '2026-09-11T08:00:00Z', thumbnail: 'https://static/640x360.jpg' }]]);
  const fakeVideos = async (userId) => {
    assert.equal(userId, 'TW1');
    return [{ videoId: 'v1', title: '上次直播', url: 'https://www.twitch.tv/videos/v1', published: '2026-09-10T00:00:00Z' }];
  };
  const { channels } = await collectChannels([twitchRow('T隊', 'tteam')], {
    cache, env: twitchEnvOk, now: () => 'T1', logger: silent,
    twitchToken: fakeTwitchToken, twitchUsers: fakeUsers, twitchStreams: fakeStreams, twitchVideos: fakeVideos,
  });
  assert.equal(channels.length, 1);
  const c = channels[0];
  assert.equal(c.platform, 'twitch');
  assert.equal(c.channelId, 'TW1');
  assert.equal(c.channelName, 'T隊直播間');
  assert.equal(c.channelUrl, 'https://www.twitch.tv/tteam');
  assert.equal(c.avatar, 'https://static/av.png');
  assert.deepEqual(c.live, { title: '在線標題', url: 'https://www.twitch.tv/tteam', thumbnail: 'https://static/640x360.jpg', viewers: 88, startedAt: '2026-09-11T08:00:00Z' });
  assert.deepEqual(c.latest, [{ videoId: 'v1', title: '上次直播', url: 'https://www.twitch.tv/videos/v1', published: '2026-09-10T00:00:00Z' }]);
  assert.equal(c.stale, false);
});

await test('collectChannels:Twitch 離線頻道(streams 查無) → live:null，VOD 關閉時 latest 空陣列也算正常', async () => {
  const fakeUsers = async () => new Map([['offteam', { id: 'TW2', displayName: '離線隊', avatar: 'a' }]]);
  const fakeStreams = async () => new Map(); // 沒人在線
  const fakeVideos = async () => []; // VOD 關閉
  const { channels, stats } = await collectChannels([twitchRow('離線隊', 'offteam')], {
    env: twitchEnvOk, logger: silent,
    twitchToken: fakeTwitchToken, twitchUsers: fakeUsers, twitchStreams: fakeStreams, twitchVideos: fakeVideos,
  });
  assert.equal(channels[0].live, null);
  assert.deepEqual(channels[0].latest, []);
  assert.equal(stats.ok, 1);
});

await test('collectChannels:Twitch login 在 users 查無 → error「Twitch 帳號不存在或已改名」,無舊資料則 skipped', async () => {
  const fakeUsers = async () => new Map(); // 查無此人
  const { channels, skipped } = await collectChannels([twitchRow('改名隊', 'renamed')], {
    env: twitchEnvOk, logger: silent,
    twitchToken: fakeTwitchToken, twitchUsers: fakeUsers, twitchStreams: async () => new Map(), twitchVideos: async () => [],
  });
  assert.equal(channels.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /Twitch 帳號不存在或已改名/);
});

await test('collectChannels:缺 TWITCH_CLIENT_ID/SECRET → Twitch 組略過(skipped),YouTube 組照常抓', async () => {
  const rows = [{ group: 'Y隊', url: `https://www.youtube.com/channel/${ID(9)}` }, twitchRow('T隊', 'tteam')];
  const { channels, skipped, stats } = await collectChannels(rows, {
    env: {}, // 沒有 TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
    resolve: async (ref) => ref.value, rss: fakeRss, live: async () => null, logger: silent,
  });
  assert.deepEqual(channels.map((c) => c.group), ['Y隊']);
  assert.equal(channels[0].platform, 'youtube');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].group, 'T隊');
  assert.match(skipped[0].error, /TWITCH_CLIENT_ID\/SECRET 未設定/);
  assert.deepEqual(stats, { total: 2, ok: 1, stale: 0, skipped: 1 });
});

await test('collectChannels:缺 secrets 但 Twitch 組有上一輪資料 → 沿用並標 stale:true(不影響 YouTube)', async () => {
  const prev = { channels: [{ group: 'T隊', platform: 'twitch', channelId: 'TW1', channelName: '舊名', channelUrl: 'https://www.twitch.tv/tteam', avatar: 'a', live: null, latest: [], fetchedAt: 'T0', stale: false }] };
  const { channels } = await collectChannels([twitchRow('T隊', 'tteam')], { prev, env: {}, logger: silent });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].stale, true);
  assert.match(channels[0].error, /TWITCH_CLIENT_ID\/SECRET 未設定/);
  assert.equal(channels[0].channelName, '舊名');
});

await test('resolve-cache:成功解析 Twitch login 後,cache 寫入帶 twitch: 前綴的 login→id', async () => {
  const cache = {};
  const fakeUsers = async () => new Map([['cacheteam', { id: 'TW9', displayName: 'X', avatar: 'a' }]]);
  await collectChannels([twitchRow('快取隊', 'cacheteam')], {
    cache, env: twitchEnvOk, logger: silent,
    twitchToken: fakeTwitchToken, twitchUsers: fakeUsers, twitchStreams: async () => new Map(), twitchVideos: async () => [],
  });
  assert.equal(cache['twitch:cacheteam'], 'TW9');
});

console.log('---');
if (failed) {
  console.log('存在失敗測試');
  process.exitCode = 1;
} else {
  console.log('OK');
}
