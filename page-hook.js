// 跑在 Threads 頁面主世界（world: MAIN）：偷聽 Threads 自己的 GraphQL 回應，把貼文資料丟給 content.js。
(function () {
  'use strict';
  if (window.__tpHooked) return;
  window.__tpHooked = true;
  const LOG = '[Threads插件]';
  const lib = window.TP;
  if (!lib) { console.warn(LOG, 'page-hook：找不到 lib'); return; }

  // 自己留一份：content.js 比較晚載入，啟動時會來要
  const store = new Map();
  function emit(posts) { window.postMessage({ type: 'tp-posts', posts }, window.location.origin); }

  function handle(url, text) {
    try {
      if (!text || text.length < 2000) return;
      if (!/\/api\/graphql|\/graphql\/query/.test(String(url))) return;
      if (text.indexOf('like_count') < 0) return;
      const json = JSON.parse(text);
      const posts = lib.extractPostsFromGraphql(json);
      if (!posts.length) return;
      for (const p of posts) store.set(p.code, p);
      emit(posts);
    } catch (e) {
      console.debug(LOG, 'hook 解析失敗', e && e.message);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'tp-request') return;
    if (store.size) emit([...store.values()]);
  });

  // 第一頁的貼文不走 XHR，嵌在 <script type="application/json" data-sjs> 裡；頁面載入時與之後新加的都讀
  const seenScripts = new WeakSet();
  function scanSjs() {
    for (const sc of document.querySelectorAll('script[type="application/json"][data-sjs]')) {
      if (seenScripts.has(sc)) continue;
      seenScripts.add(sc);
      try {
        const text = sc.textContent || '';
        if (text.indexOf('like_count') < 0) continue;
        const posts = lib.extractPostsFromGraphql(JSON.parse(text));
        if (!posts.length) continue;
        for (const p of posts) store.set(p.code, p);
        emit(posts);
        console.debug(LOG, '內嵌 JSON 貼文', posts.length);
      } catch (e) { console.debug(LOG, '內嵌 JSON 解析失敗', e && e.message); }
    }
  }
  let sjsTimer = null;
  const sjsObserver = new MutationObserver(() => { clearTimeout(sjsTimer); sjsTimer = setTimeout(scanSjs, 200); });
  sjsObserver.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanSjs); else scanSjs();

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__tpUrl = String(url || '');
      this.addEventListener('loadend', function () {
        try { if (this.responseType === '' || this.responseType === 'text') handle(this.__tpUrl, this.responseText); } catch (e) {}
      });
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/api\/graphql|\/graphql\/query/.test(url)) {
          res.clone().text().then((t) => handle(url, t)).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }
  console.debug(LOG, 'page-hook 已掛上');
})();
