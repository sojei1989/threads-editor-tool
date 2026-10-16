// Threads 插件 service worker：存檔（chrome.storage.local）、匯出到 ~/Downloads/Threads收錄/、影片下載。
importScripts('lib.js');
const LOG = '[Threads插件]';
const KEYS = ['saved', 'hot', 'trends', 'views', 'settings'];
const HOT_MAX = 500;

// ===== storage =====
async function getAll() {
  const st = await chrome.storage.local.get(KEYS);
  return {
    saved: st.saved || {}, hot: st.hot || {}, trends: st.trends || {}, views: st.views || {},
    settings: Object.assign({}, TP.DEFAULT_SETTINGS, st.settings || {}),
  };
}
async function ensureDefaults() {
  const st = await chrome.storage.local.get(['settings']);
  await chrome.storage.local.set({ settings: Object.assign({}, TP.DEFAULT_SETTINGS, st.settings || {}) });
}
chrome.runtime.onInstalled.addListener(ensureDefaults);
chrome.runtime.onStartup.addListener(ensureDefaults);

// ===== 匯出 =====
const dirty = new Set();
let timer = null;
function markDirty(name) { dirty.add(name); clearTimeout(timer); timer = setTimeout(exportDirty, 3000); }

function dataUrl(str, mime) { return `data:${mime};charset=utf-8,` + encodeURIComponent(str); }
const lastContent = {};   // filename -> 上次匯出的內容（去掉時間戳），沒變就不再下載
function stripTime(str) { return str.replace(/"exported_at":\s*"[^"]*"/, '').replace(/^# Threads 收錄（插件匯出，[^）]*）/, ''); }
function download(filename, str, mime) {
  const body = stripTime(str);
  if (lastContent[filename] === body) return Promise.resolve(true);
  lastContent[filename] = body;
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl(str, mime), filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '下載失敗';
        console.warn(LOG, '匯出失敗', filename, msg);
        chrome.storage.local.set({ lastError: `${filename}：${msg}（${new Date().toLocaleString('zh-TW')}）` });
        resolve(false);
      } else {
        chrome.downloads.search({ id }, (items) => {
          const f = items && items[0] && items[0].filename;
          if (f) chrome.storage.local.set({ lastPath: f.replace(/[\\/][^\\/]+$/, '') });
        });
        resolve(true);
      }
    });
  });
}

function sortBySaved(obj) {
  return Object.values(obj).sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
}

async function exportDirty() {
  const names = [...dirty]; dirty.clear();
  const st = await getAll();
  const now = new Date().toISOString();
  for (const n of names) {
    try {
      if (n === 'saved') {
        const posts = sortBySaved(st.saved);
        await download('Threads收錄/收錄.json', JSON.stringify({ exported_at: now, count: posts.length, posts }, null, 1), 'application/json');
        await download('Threads收錄/收錄.md', TP.postsToMarkdown(posts, now), 'text/markdown');
      } else if (n === 'hot') {
        const posts = sortBySaved(st.hot);
        await download('Threads收錄/高流量.json', JSON.stringify({ exported_at: now, count: posts.length, posts }, null, 1), 'application/json');
      } else if (n === 'trends') {
        await download('Threads收錄/趨勢話題.json', JSON.stringify({ exported_at: now, days: st.trends }, null, 1), 'application/json');
      } else if (n === 'views') {
        await download('Threads收錄/觀看數.json', JSON.stringify({ exported_at: now, posts: st.views }, null, 1), 'application/json');
      }
    } catch (e) { console.warn(LOG, '匯出例外', n, e.message); }
  }
  await chrome.storage.local.set({ lastExport: now });
}
async function exportAll() { ['saved', 'hot', 'trends', 'views'].forEach((n) => dirty.add(n)); clearTimeout(timer); await exportDirty(); }

// ===== 訊息 =====
const handlers = {
  async save({ post }) {
    const st = await getAll();
    const prev = st.saved[post.code];
    st.saved[post.code] = Object.assign({}, prev || {}, post, { saved_at: (prev && prev.saved_at) || new Date().toISOString(), note: (prev && prev.note) || post.note || '' });
    await chrome.storage.local.set({ saved: st.saved });
    markDirty('saved');
    return { ok: true, count: Object.keys(st.saved).length };
  },
  async unsave({ code }) {
    const st = await getAll();
    delete st.saved[code];
    await chrome.storage.local.set({ saved: st.saved });
    markDirty('saved');
    return { ok: true, count: Object.keys(st.saved).length };
  },
  async hot({ post }) {
    const st = await getAll();
    const prev = st.hot[post.code];
    st.hot[post.code] = Object.assign({}, prev || {}, post, { saved_at: (prev && prev.saved_at) || new Date().toISOString() });
    const codes = Object.keys(st.hot);
    if (codes.length > HOT_MAX) {
      const sorted = sortBySaved(st.hot);
      for (const p of sorted.slice(HOT_MAX)) delete st.hot[p.code];
    }
    await chrome.storage.local.set({ hot: st.hot });
    markDirty('hot');
    return { ok: true };
  },
  async trends({ date, items }) {
    const st = await getAll();
    st.trends[date] = items;
    await chrome.storage.local.set({ trends: st.trends });
    markDirty('trends');
    return { ok: true, count: items.length };
  },
  async views({ items }) {
    const st = await getAll();
    Object.assign(st.views, items);
    await chrome.storage.local.set({ views: st.views });
    markDirty('views');
    return { ok: true, count: Object.keys(items).length };
  },
  async getSettings() { return (await getAll()).settings; },
  async setSettings({ settings }) {
    const st = await getAll();
    const next = Object.assign({}, st.settings, settings || {});
    await chrome.storage.local.set({ settings: next });
    return next;
  },
  async getViews() { return (await getAll()).views; },
  async download({ url, filename }) {
    return new Promise((resolve) => {
      chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id == null) {
          const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '下載失敗';
          chrome.storage.local.set({ lastError: `${filename}：${msg}` });
          resolve({ ok: false, error: msg });
        } else resolve({ ok: true, id });
      });
    });
  },
  async export() { await exportAll(); return { ok: true }; },
  async summary() {
    const st = await getAll();
    const today = TP.todayTaipei();
    const saved = sortBySaved(st.saved);
    const hotToday = Object.values(st.hot).filter((p) => TP.todayTaipei(new Date(p.saved_at || 0)) === today).length;
    const extra = await chrome.storage.local.get(['lastError', 'lastExport', 'lastPath']);
    return {
      savedCount: saved.length, recent: saved.slice(0, 5),
      hotToday, hotTotal: Object.keys(st.hot).length,
      trendsToday: (st.trends[today] || []).length,
      viewsCount: Object.keys(st.views).length,
      settings: st.settings, lastError: extra.lastError || '', lastExport: extra.lastExport || '', lastPath: extra.lastPath || '',
    };
  },
  async clearError() { await chrome.storage.local.remove('lastError'); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) { sendResponse({ ok: false, error: '未知訊息 ' + (msg && msg.type) }); return false; }
  h(msg).then(sendResponse).catch((e) => { console.warn(LOG, msg.type, e.message); sendResponse({ ok: false, error: e.message }); });
  return true;
});
