// Threads 插件 主程式（隔離世界）：找貼文、插鈕、互動率、收錄、高流量、抄趨勢與觀看數。
(function () {
  'use strict';
  if (window.__tpContentLoaded) return;
  window.__tpContentLoaded = true;
  const LOG = '[Threads插件]';

  // ===== 所有選擇器與常數都在這裡；Threads 改版只改這裡 =====
  const SEL = {
    post: '[data-pressable-container="true"]',
    postLink: 'a[href*="/post/"]',
    postHref: /^\/@([^/]+)\/post\/([^/?#]+)/,
    authorLink: 'a[href^="/@"]',
    time: 'time[datetime]',
    textLeaf: '[dir="auto"]',
    actionTitle: 'svg title',
    titles: { like: ['讚', '收回讚'], reply: ['回覆', '已回覆'], repost: ['轉發'], share: ['分享'] },
    numberText: /^[\d,.]+\s*(萬|千|[KkMm])?$/,
    topicHeader: /^(超夯|精選|熱門)[：:]\s*(.+)$/,
    profileLink: 'a[aria-label="個人檔案"], [role="link"][aria-label="個人檔案"]',
    searchPath: /^\/search\/?$/,
    trendHeading: '最新趨勢話題',
    trendLink: 'a[href^="/search?q="]',
    trendCount: /([\d.]+\s*[千萬]?)\s*則貼文/,
    insightsPath: /^\/insights\/?$/,
    insightsCard: 'a[href^="/insights/post/"]',
    insightsHref: /^\/insights\/post\/([^/?#]+)/,
    viewsLabel: '觀看次數',
  };

  let settings = Object.assign({}, TP.DEFAULT_SETTINGS);
  let viewsMap = {};
  const savedSet = new Set();
  const hookStore = new Map();      // code -> 攔截到的貼文
  const rendered = new Map();       // code -> { el, post }
  const hotSent = new Set();
  const attempts = new WeakMap();
  const scrapedAt = {};             // path -> 上次抄錄時間
  const lastSent = { trends: '', views: '' };   // 上次送出的內容，避免重複匯出

  // ===== 與 background 溝通 =====
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) { console.debug(LOG, '訊息失敗', chrome.runtime.lastError.message); resolve(null); }
          else resolve(r);
        });
      } catch (e) { console.debug(LOG, '插件已重新載入，請重新整理頁面'); resolve(null); }
    });
  }

  async function loadState() {
    try {
      const st = await chrome.storage.local.get(['settings', 'saved', 'views']);
      settings = Object.assign({}, TP.DEFAULT_SETTINGS, st.settings || {});
      savedSet.clear(); Object.keys(st.saved || {}).forEach((c) => savedSet.add(c));
      viewsMap = st.views || {};
    } catch (e) { console.debug(LOG, '讀 storage 失敗', e.message); }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let rerender = false;
      if (changes.settings) { settings = Object.assign({}, TP.DEFAULT_SETTINGS, changes.settings.newValue || {}); rerender = true; }
      if (changes.saved) { savedSet.clear(); Object.keys(changes.saved.newValue || {}).forEach((c) => savedSet.add(c)); rerender = true; }
      if (changes.views) { viewsMap = changes.views.newValue || {}; rerender = true; }
      if (rerender) rerenderAll();
    });
  } catch (e) {}

  // ===== 讀一篇貼文 =====
  function leafText(el) { return (el.textContent || '').trim(); }

  function parsePost(el) {
    const link = el.querySelector(SEL.postLink);
    if (!link) return null;
    const m = (link.getAttribute('href') || '').match(SEL.postHref);
    if (!m) return null;
    const author = m[1], code = m[2];

    const found = {};
    const btns = {};
    for (const t of el.querySelectorAll(SEL.actionTitle)) {
      const name = leafText(t);
      let kind = null;
      for (const k in SEL.titles) if (SEL.titles[k].includes(name)) { kind = k; break; }
      if (!kind || kind in found) continue;
      const btn = t.closest('[role="button"]');
      if (!btn) continue;
      if (btn.closest(SEL.post) !== el) continue;   // 不要引用貼文的鈕
      const span = [...btn.querySelectorAll('span')].find((s) => s.children.length === 0 && SEL.numberText.test(leafText(s)));
      found[kind] = span ? TP.parseCount(leafText(span)) : 0;
      btns[kind] = btn;
    }
    if (!('like' in found) || !('reply' in found)) return null;

    // 動作列 = 讚鈕與分享鈕（或回覆鈕）的最近共同祖先
    const other = btns.share || btns.repost || btns.reply;
    let row = btns.like;
    while (row && row !== el && !row.contains(other)) row = row.parentElement;
    if (!row || row === el) row = btns.like.parentElement;

    const timeEl = link.querySelector(SEL.time) || el.querySelector(SEL.time);
    const posted_at = timeEl ? timeEl.getAttribute('datetime') : null;

    let topic = null;
    const lines = [];
    let passedTime = !timeEl;
    for (const leaf of el.querySelectorAll(SEL.textLeaf)) {
      if (leaf.querySelector(SEL.textLeaf)) continue;
      if (leaf.closest(SEL.post) !== el) continue;
      const txt = leafText(leaf);
      if (!txt) continue;
      if (!topic) { const tm = txt.match(SEL.topicHeader); if (tm) { topic = tm[2].trim(); continue; } }
      if (timeEl && (leaf.contains(timeEl) || timeEl.contains(leaf))) { passedTime = true; continue; }
      if (!passedTime) continue;
      if (row.contains(leaf) || leaf.closest('[role="button"]')) continue;
      if (leaf.closest(SEL.authorLink)) continue;
      if (SEL.numberText.test(txt)) break;
      lines.push(txt);
    }

    return {
      code, url: `https://www.threads.com/@${author}/post/${code}`, author, posted_at, topic,
      text: lines.join('\n'),
      likes: found.like || 0, replies: found.reply || 0, reposts: found.repost || 0, shares: found.share || 0,
      views: null, has_video: !!el.querySelector('video'), exact: false,
      _row: row,
    };
  }

  function finalPost(domPost) {
    const merged = TP.mergePost(domPost, hookStore.get(domPost.code));
    delete merged._row;
    if (settings.me && merged.author === settings.me && viewsMap[merged.code]) merged.views = viewsMap[merged.code].views;
    merged.ratios = (({ reply, repost, share }) => ({ reply, repost, share }))(TP.computeRatios(merged, settings));
    return merged;
  }

  // ===== 畫面 =====
  function ratioLabel(r) {
    if (r >= 10) return '×' + Math.round(r);
    return Math.round(r * 100) + '%';
  }

  function mkSpan(tp, text, cls, title) {
    const s = document.createElement('span');
    s.dataset.tp = tp; s.textContent = text;
    if (cls) s.className = cls;
    if (title) s.title = title;
    return s;
  }

  function renderBar(el, domPost) {
    const post = finalPost(domPost);
    const rt = TP.computeRatios(post, settings);
    let bar = el.__tpBar;
    if (!bar || !bar.isConnected) {
      bar = document.createElement('div');
      bar.dataset.tp = 'bar';
      domPost._row.insertAdjacentElement('afterend', bar);
      el.__tpBar = bar;
    }
    bar.innerHTML = '';

    // 互動率
    if (rt.level.reply === 'small') {
      bar.appendChild(mkSpan('ratio', '樣本小', 'tp-gray', `讚 ${post.likes} 篇，少於 ${settings.minLikes} 不算比例`));
    } else {
      bar.appendChild(mkSpan('ratio', '回覆率 ' + ratioLabel(rt.reply), 'tp-' + rt.level.reply, `回覆 ${post.replies} ÷ 讚 ${post.likes}`));
      bar.appendChild(mkSpan('ratio', '轉發率 ' + ratioLabel(rt.repost), 'tp-' + rt.level.repost, `轉發 ${post.reposts} ÷ 讚 ${post.likes}`));
      bar.appendChild(mkSpan('ratio', '分享率 ' + ratioLabel(rt.share), 'tp-' + rt.level.share, `分享 ${post.shares} ÷ 讚 ${post.likes}`));
    }
    if (!post.exact) bar.appendChild(mkSpan('ratio', '≈', 'tp-gray', '數字是畫面上的簡寫換算，還沒拿到精確值'));
    if (settings.me && post.author === settings.me) {
      if (post.views != null) bar.appendChild(mkSpan('views', '觀看 ' + TP.fmtInt(post.views), '', `來自洞察報告（${viewsMap[post.code] ? TP.fmtTaipei(viewsMap[post.code].seen_at) : ''}）`));
      else bar.appendChild(mkSpan('views', '觀看 —', '', '開洞察報告頁（左側「洞察報告」）更新'));
    }

    // 收錄鈕
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.tp = 'save';
    const on = savedSet.has(post.code);
    save.textContent = on ? '已收錄 ✓' : '收錄';
    save.classList.toggle('on', on);
    save.title = on ? '再按一次取消收錄' : '把這篇存進收錄清單';
    save.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const fresh = rendered.get(post.code);
      const latest = fresh ? finalPost(fresh.post) : post;
      let r;
      if (savedSet.has(post.code)) { savedSet.delete(post.code); r = await send({ type: 'unsave', code: post.code }); toast(r ? `已取消收錄（共 ${r.count} 篇）` : '取消失敗：插件沒回應，請重新整理頁面'); }
      else { savedSet.add(post.code); r = await send({ type: 'save', post: latest }); toast(r ? `已收錄 @${latest.author}（共 ${r.count} 篇），3 秒後匯出檔案` : '收錄失敗：插件沒回應，請重新整理頁面'); }
      renderBar(el, fresh ? fresh.post : domPost);
    });
    bar.appendChild(save);

    // 影片鈕
    if (post.has_video) {
      const vb = document.createElement('button');
      vb.type = 'button';
      vb.dataset.tp = 'video';
      const vids = post.videos || [];
      vb.textContent = vids.length > 1 ? `影片 ×${vids.length}` : '影片';
      if (!vids.length) { vb.disabled = true; vb.title = '還沒拿到影片網址，重新整理後再試'; }
      else {
        vb.title = '下載到 Chrome 下載資料夾/Threads影片/（只存本機）';
        vb.addEventListener('click', async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          let ok = 0;
          for (let i = 0; i < vids.length; i++) {
            const name = `Threads影片/${post.author}_${post.code}${vids.length > 1 ? '_' + (i + 1) : ''}.mp4`;
            const r = await send({ type: 'download', url: vids[i].url, filename: name });
            if (r && r.ok) ok++;
          }
          toast(ok ? `開始下載 ${ok} 段影片到 Threads影片/` : '下載失敗，看彈窗的錯誤訊息');
        });
      }
      bar.appendChild(vb);
    }

    rendered.set(post.code, { el, post: domPost });

    // 高流量：自動記
    if (TP.isHot(post, settings) && !hotSent.has(post.code)) {
      hotSent.add(post.code);
      send({ type: 'hot', post });
    }
  }

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.dataset.tp = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  function rerenderAll() {
    for (const [code, { el, post }] of rendered) {
      if (!el.isConnected) { rendered.delete(code); continue; }
      try { renderBar(el, post); } catch (e) { console.debug(LOG, '重畫失敗', code, e.message); }
    }
  }

  // ===== 頁面抄錄：搜尋頁趨勢話題、洞察報告觀看數 =====
  function leafSpans(root) { return [...root.querySelectorAll('span')].filter((s) => s.children.length === 0 && leafText(s)); }

  function scrapeTrends() {
    const heading = [...document.querySelectorAll('span, div, h2, h3')].find((e) => e.children.length === 0 && leafText(e) === SEL.trendHeading);
    if (!heading) return;
    let box = heading;
    for (let i = 0; i < 8 && box; i++) { box = box.parentElement; if (box && box.querySelectorAll(SEL.trendLink).length >= 5) break; }
    if (!box) return;
    const items = [];
    for (const a of box.querySelectorAll(SEL.trendLink)) {
      const spans = leafSpans(a).map(leafText);
      const countSpan = spans.find((t) => SEL.trendCount.test(t));
      if (!countSpan || spans.length < 2) continue;
      const cm = countSpan.match(SEL.trendCount);
      items.push({ title: spans[0], summary: spans[1], count: TP.parseCount(cm[1]), url: a.href, seen_at: new Date().toISOString() });
    }
    if (!items.length) return;
    const key = items.map((i) => i.title + '|' + i.count).join('\n');
    if (key === lastSent.trends) return;          // 內容沒變就不重送
    lastSent.trends = key;
    send({ type: 'trends', date: TP.todayTaipei(), items }).then((r) => r && console.debug(LOG, '趨勢話題', r.count, '條'));
  }

  function scrapeViews() {
    const items = {};
    for (const a of document.querySelectorAll(SEL.insightsCard)) {
      const m = (a.getAttribute('href') || '').match(SEL.insightsHref);
      if (!m) continue;
      const spans = leafSpans(a).map(leafText);
      const idx = spans.indexOf(SEL.viewsLabel);
      if (idx < 1) continue;
      const v = spans[idx - 1];
      if (!SEL.numberText.test(v)) continue;
      items[m[1]] = { views: TP.parseCount(v), seen_at: new Date().toISOString() };
    }
    if (!Object.keys(items).length) return;
    const key = Object.entries(items).map(([c, v]) => c + ':' + v.views).sort().join('\n');
    if (key === lastSent.views) return;           // 內容沒變就不重送
    lastSent.views = key;
    send({ type: 'views', items }).then((r) => r && console.debug(LOG, '觀看數', r.count, '篇'));
  }

  function scrapePages() {
    const path = location.pathname;
    const key = SEL.searchPath.test(path) ? 'search' : SEL.insightsPath.test(path) ? 'insights' : null;
    if (!key) return;
    const now = Date.now();
    if (scrapedAt[key] && now - scrapedAt[key] < 2000) return;
    scrapedAt[key] = now;
    try { if (key === 'search') scrapeTrends(); else scrapeViews(); } catch (e) { console.debug(LOG, '抄錄失敗', key, e.message); }
  }

  // ===== 掃描 =====
  let scanQueued = false, lastScan = 0;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    const wait = Math.max(0, 300 - (Date.now() - lastScan));
    setTimeout(() => { scanQueued = false; lastScan = Date.now(); scan(); }, wait);
  }

  function scan() {
    for (const el of document.querySelectorAll(SEL.post)) {
      if (el.dataset.tpSeen) continue;
      const n = (attempts.get(el) || 0) + 1;
      attempts.set(el, n);
      let post = null;
      try { post = parsePost(el); } catch (e) { console.debug(LOG, '讀貼文失敗', e.message); }
      if (!post) { if (n >= 5) el.dataset.tpSeen = 'skip'; continue; }
      el.dataset.tpSeen = post.code;
      try { renderBar(el, post); } catch (e) { console.debug(LOG, '插鈕失敗', e.message); }
    }
    detectMe();
    scrapePages();
  }

  function detectMe() {
    const a = document.querySelector(SEL.profileLink);
    if (!a) return;
    const m = (a.getAttribute('href') || '').match(/^\/@([^/?#]+)/);
    if (m && m[1] !== settings.me) { settings.me = m[1]; send({ type: 'setSettings', settings: { me: m[1] } }); }
  }

  // ===== page-hook 丟來的精確資料 =====
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'tp-posts' || !Array.isArray(e.data.posts)) return;
    let touched = 0;
    for (const p of e.data.posts) {
      if (!p || !p.code) continue;
      hookStore.set(p.code, p);
      const r = rendered.get(p.code);
      if (r && r.el.isConnected) { try { renderBar(r.el, r.post); touched++; } catch (err) {} }
    }
    console.debug(LOG, 'hook 貼文數', hookStore.size, '更新畫面', touched);
  });

  // ===== 啟動 =====
  (async function start() {
    await loadState();
    window.postMessage({ type: 'tp-request' }, window.location.origin);   // 跟 page-hook 要它已經攔到的
    scan();
    const mo = new MutationObserver(scheduleScan);
    mo.observe(document.body, { childList: true, subtree: true });
    setInterval(scrapePages, 3000);   // 搜尋頁、洞察報告內容是慢慢載的，定時補抄
    console.debug(LOG, 'content 已啟動');
  })();
})();
