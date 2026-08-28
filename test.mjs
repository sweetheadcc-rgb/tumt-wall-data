// 離線自檢：不打任何網路，全部餵假資料驗證解析邏輯。
// 執行：node test.mjs
import assert from 'node:assert/strict';
import { parseCsv, dedupeByGroup, parseChannelRef, parseRss, parseStreamsPage, resolveChannelId } from './fetch.mjs';

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

await test('頻道連結三種格式解析（/channel/、/@handle、/c/）', () => {
  assert.deepEqual(parseChannelRef('https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow'), {
    type: 'id',
    value: 'UCSJ4gkVC6NrvII8umztf0Ow',
  });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@NASA'), { type: 'handle', value: '@NASA' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/c/SomeChannel'), { type: 'custom', value: 'SomeChannel' });
});

await test('格式錯誤的頻道連結回傳 null，不拋例外', () => {
  assert.equal(parseChannelRef('not-a-valid-url'), null);
  assert.equal(parseChannelRef('https://example.com/foo'), null);
  assert.equal(parseChannelRef(''), null);
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

console.log('---');
if (failed) {
  console.log('存在失敗測試');
  process.exitCode = 1;
} else {
  console.log('OK');
}
