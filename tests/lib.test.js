const test = require('node:test');
const assert = require('node:assert');
const TP = require('../lib.js');

test('parseCount', () => {
  assert.equal(TP.parseCount('1,226'), 1226);
  assert.equal(TP.parseCount('3.5 萬'), 35000);
  assert.equal(TP.parseCount('1 千'), 1000);
  assert.equal(TP.parseCount('1.2K'), 1200);
  assert.equal(TP.parseCount('2M'), 2000000);
  assert.equal(TP.parseCount(''), 0);
  assert.equal(TP.parseCount(null), 0);
  assert.equal(TP.parseCount('—'), 0);
});

test('computeRatios 標色', () => {
  const s = TP.DEFAULT_SETTINGS;
  const r = TP.computeRatios({ likes: 1000, replies: 89, reposts: 26, shares: 1583 }, s);
  assert.ok(Math.abs(r.reply - 0.089) < 1e-6);
  assert.equal(r.level.reply, 'green');
  assert.equal(r.level.repost, 'yellow');
  assert.equal(r.level.share, 'green');
  const small = TP.computeRatios({ likes: 5, replies: 1, reposts: 0, shares: 0 }, s);
  assert.equal(small.level.reply, 'small');
  const zero = TP.computeRatios({ likes: 0, replies: 0, reposts: 0, shares: 0 }, s);
  assert.equal(zero.reply, 0);
});

test('mergePost', () => {
  const dom = { code: 'A', likes: 35000, replies: 400, reposts: 0, shares: 0, text: '畫面', exact: false };
  const hook = { code: 'A', likes: 35123, replies: 412, reposts: 3, shares: 9, text: '完整', videos: [{ url: 'u', width: 720, height: 1280 }] };
  const m = TP.mergePost(dom, hook);
  assert.equal(m.likes, 35123); assert.equal(m.text, '完整'); assert.equal(m.exact, true); assert.equal(m.has_video, true);
  const n = TP.mergePost(dom, null);
  assert.equal(n.likes, 35000); assert.equal(n.exact, false);
  assert.equal(TP.mergePost(dom, { code: 'A', text: '' }).text, '畫面');
});

test('isHot', () => {
  const s = TP.DEFAULT_SETTINGS;
  assert.equal(TP.isHot({ likes: 1000, replies: 0 }, s), true);
  assert.equal(TP.isHot({ likes: 10, replies: 100 }, s), true);
  assert.equal(TP.isHot({ likes: 999, replies: 99 }, s), false);
});

test('extractPostsFromGraphql', () => {
  const json = { data: { feed: { edges: [{ node: { thread_items: [{ post: {
    pk: '1', code: 'DeiVj3iiP-a', like_count: 1239, taken_at: 1792115951,
    caption: { text: '最新' }, user: { username: 'joman_electric' },
    text_post_app_info: { direct_reply_count: 89, repost_count: 26, reshare_count: 1583, quote_count: 0, tag_header: { display_text: '特斯拉' } },
    video_versions: [{ type: 101, width: 720, height: 1280, url: 'https://x/a.mp4' }, { type: 102, width: 480, height: 854, url: 'https://x/b.mp4' }]
  } }] } }] } } };
  const posts = TP.extractPostsFromGraphql(json);
  assert.equal(posts.length, 1);
  const p = posts[0];
  assert.equal(p.code, 'DeiVj3iiP-a'); assert.equal(p.author, 'joman_electric');
  assert.equal(p.likes, 1239); assert.equal(p.replies, 89); assert.equal(p.reposts, 26); assert.equal(p.shares, 1583);
  assert.equal(p.url, 'https://www.threads.com/@joman_electric/post/DeiVj3iiP-a');
  assert.equal(p.posted_at, new Date(1792115951 * 1000).toISOString());
  assert.equal(p.text, '最新');
  assert.equal(p.videos.length, 1); assert.equal(p.videos[0].url, 'https://x/a.mp4'); assert.equal(p.has_video, true);
  assert.equal(p.exact, true);
});

test('extractPostsFromGraphql 多段影片與無影片', () => {
  const json = { items: [
    { code: 'B', like_count: 1, user: { username: 'u' }, caption: null, text_post_app_info: {},
      carousel_media: [
        { video_versions: [{ width: 100, url: 'c1' }] },
        { image_versions2: {} },
        { video_versions: [{ width: 50, url: 'c2s' }, { width: 300, url: 'c2' }] },
      ] },
    { code: 'C', like_count: 2, user: { username: 'v' }, caption: { text: 'x' }, text_post_app_info: { direct_reply_count: 0 } },
    { foo: 'bar', like_count: 3 },
  ] };
  const posts = TP.extractPostsFromGraphql(json);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].videos.map(v => v.url), ['c1', 'c2']);
  assert.equal(posts[1].videos.length, 0); assert.equal(posts[1].has_video, false);
  assert.equal(posts[0].text, '');
});

test('postsToMarkdown', () => {
  const md = TP.postsToMarkdown([{ code: 'A', url: 'https://www.threads.com/@u/post/A', author: 'u', posted_at: '2026-10-16T01:19:11.000Z', topic: '特斯拉', text: '第一行\n第二行', likes: 1239, replies: 89, reposts: 26, shares: 1583, ratios: { reply: 0.072, repost: 0.021, share: 1.28 }, saved_at: '2026-10-16T02:40:00.000Z' }], '2026-10-16T02:41:00.000Z');
  assert.match(md, /^# Threads 收錄（插件匯出，2026-10-16 10:41）/);
  assert.match(md, /## @u · 2026-10-16 09:19 · 讚 1,239 回覆 89 轉發 26 分享 1,583 · 回覆率 7% 轉發率 2% 分享率 128%/);
  assert.match(md, /https:\/\/www\.threads\.com\/@u\/post\/A/);
  assert.match(md, /主題：特斯拉｜收錄：2026-10-16 10:40/);
  assert.match(md, /> 第一行\n> 第二行/);
  const md2 = TP.postsToMarkdown([{ code: 'B', url: 'x', author: 'v', posted_at: null, topic: null, text: '', likes: 0, replies: 0, reposts: 0, shares: 0, ratios: { reply: 0, repost: 0, share: 0 }, saved_at: '2026-10-16T02:40:00.000Z' }], '2026-10-16T02:41:00.000Z');
  assert.match(md2, /## @v · — · 讚 0/);
  assert.match(md2, /收錄：2026-10-16 10:40/);
  assert.doesNotMatch(md2, /主題：/);
});
