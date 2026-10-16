// Threads 插件 純函式（無 DOM、無 chrome API）。瀏覽器下掛 globalThis.TP，Node 下 module.exports。
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    replyGreen: 0.05, replyYellow: 0.02,
    repostGreen: 0.03, repostYellow: 0.01,
    shareGreen: 0.5, shareYellow: 0.2,
    minLikes: 20,
    hotLikes: 1000, hotReplies: 100,
    me: '',
  };

  // "1,226"→1226、"3.5 萬"→35000、"1 千"→1000、"1.2K"→1200、"2M"→2000000；空、null、"—"→0
  function parseCount(text) {
    if (text == null) return 0;
    const s = String(text).replace(/,/g, '').trim();
    const m = s.match(/^([\d.]+)\s*(萬|千|[KkMm])?$/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const unit = m[2] || '';
    const mul = unit === '萬' ? 10000 : unit === '千' ? 1000 : /k/i.test(unit) ? 1000 : /m/i.test(unit) ? 1000000 : 1;
    return Math.round(n * mul);
  }

  function levelOf(ratio, green, yellow) {
    if (ratio >= green) return 'green';
    if (ratio >= yellow) return 'yellow';
    return 'gray';
  }

  // 回覆率、轉發率、分享率都是 ÷ 讚；讚 < minLikes 全標 'small'
  function computeRatios(post, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const likes = Number(post.likes) || 0;
    const div = (n) => (likes > 0 ? (Number(n) || 0) / likes : 0);
    const reply = div(post.replies), repost = div(post.reposts), share = div(post.shares);
    const small = likes < s.minLikes;
    return {
      reply, repost, share,
      level: {
        reply: small ? 'small' : levelOf(reply, s.replyGreen, s.replyYellow),
        repost: small ? 'small' : levelOf(repost, s.repostGreen, s.repostYellow),
        share: small ? 'small' : levelOf(share, s.shareGreen, s.shareYellow),
      },
    };
  }

  // 攔截到的精確資料蓋過畫面讀的
  function mergePost(domPost, hookPost) {
    const out = Object.assign({}, domPost);
    if (!hookPost) { out.exact = !!out.exact; out.has_video = !!out.has_video; return out; }
    for (const k of ['likes', 'replies', 'reposts', 'shares']) {
      if (typeof hookPost[k] === 'number') out[k] = hookPost[k];
    }
    if (hookPost.text) out.text = hookPost.text;
    if (hookPost.posted_at) out.posted_at = hookPost.posted_at;
    if (hookPost.topic && !out.topic) out.topic = hookPost.topic;
    if (hookPost.author && !out.author) out.author = hookPost.author;
    if (hookPost.url && !out.url) out.url = hookPost.url;
    if (Array.isArray(hookPost.videos)) out.videos = hookPost.videos;
    out.has_video = !!(out.has_video || (out.videos && out.videos.length));
    out.exact = true;
    return out;
  }

  function isHot(post, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    return (Number(post.likes) || 0) >= s.hotLikes || (Number(post.replies) || 0) >= s.hotReplies;
  }

  function bestVideo(versions) {
    if (!Array.isArray(versions) || !versions.length) return null;
    let best = null;
    for (const v of versions) {
      if (!v || !v.url) continue;
      if (!best || (Number(v.width) || 0) > (Number(best.width) || 0)) best = v;
    }
    return best ? { url: best.url, width: Number(best.width) || 0, height: Number(best.height) || 0 } : null;
  }

  function postFromGraphql(o) {
    const tp = o.text_post_app_info || {};
    const user = o.user || {};
    const author = user.username || '';
    const code = String(o.code);
    const videos = [];
    if (Array.isArray(o.carousel_media) && o.carousel_media.length) {
      for (const m of o.carousel_media) { const v = bestVideo(m && m.video_versions); if (v) videos.push(v); }
    } else {
      const v = bestVideo(o.video_versions); if (v) videos.push(v);
    }
    let topic = null;
    if (tp.tag_header && typeof tp.tag_header === 'object') {
      const t = tp.tag_header.display_text || tp.tag_header.text || tp.tag_header.title;
      if (typeof t === 'string') topic = t.replace(/^(超夯|精選|熱門)[：:]\s*/, '');
    }
    return {
      code,
      url: author ? `https://www.threads.com/@${author}/post/${code}` : `https://www.threads.com/post/${code}`,
      author,
      posted_at: o.taken_at ? new Date(Number(o.taken_at) * 1000).toISOString() : null,
      topic,
      text: (o.caption && typeof o.caption.text === 'string') ? o.caption.text : '',
      likes: Number(o.like_count) || 0,
      replies: Number(tp.direct_reply_count) || 0,
      reposts: Number(tp.repost_count) || 0,
      shares: Number(tp.reshare_count) || 0,
      views: null,
      has_video: videos.length > 0,
      videos,
      exact: true,
    };
  }

  // 深走訪 GraphQL 回應，找所有「有 like_count 和 code 和 user」的物件
  function extractPostsFromGraphql(json) {
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 40) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if ('like_count' in o && 'code' in o && o.code) {
        if (!seen.has(o.code)) { seen.add(o.code); out.push(postFromGraphql(o)); }
        return;
      }
      for (const k in o) walk(o[k], depth + 1);
    };
    walk(json, 0);
    return out;
  }

  function fmtInt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function fmtPct(r) { return Math.round((Number(r) || 0) * 100) + '%'; }
  // ISO → 台北時間 "2026-10-16 09:19"
  function fmtTaipei(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
  }
  function todayTaipei(d) {
    return fmtTaipei((d || new Date()).toISOString()).slice(0, 10);
  }

  // 收錄.md：給 threads-funnel 步驟 1 讀
  function postsToMarkdown(posts, exportedAt) {
    const lines = [`# Threads 收錄（插件匯出，${fmtTaipei(exportedAt || new Date().toISOString())}）`, ''];
    for (const p of posts) {
      const r = p.ratios || computeRatios(p, DEFAULT_SETTINGS);
      lines.push(`## @${p.author || '?'} · ${fmtTaipei(p.posted_at)} · 讚 ${fmtInt(p.likes)} 回覆 ${fmtInt(p.replies)} 轉發 ${fmtInt(p.reposts)} 分享 ${fmtInt(p.shares)} · 回覆率 ${fmtPct(r.reply)} 轉發率 ${fmtPct(r.repost)} 分享率 ${fmtPct(r.share)}`);
      lines.push(p.url || '');
      const meta = [];
      if (p.topic) meta.push(`主題：${p.topic}`);
      if (p.views != null) meta.push(`觀看：${fmtInt(p.views)}`);
      meta.push(`收錄：${fmtTaipei(p.saved_at)}`);
      lines.push(meta.join('｜'));
      if (p.note) lines.push(`備註：${p.note}`);
      const text = (p.text || '').trim();
      if (text) lines.push(text.split('\n').map((l) => '> ' + l).join('\n'));
      lines.push('');
    }
    return lines.join('\n');
  }

  const TP = { DEFAULT_SETTINGS, parseCount, levelOf, computeRatios, mergePost, isHot, extractPostsFromGraphql, postsToMarkdown, fmtInt, fmtPct, fmtTaipei, todayTaipei };
  if (typeof module !== 'undefined' && module.exports) module.exports = TP;
  root.TP = TP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
