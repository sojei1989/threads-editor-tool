function send(msg) { return new Promise((r) => chrome.runtime.sendMessage(msg, r)); }
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await send({ type: 'summary' });
  if (!s) return;
  $('savedCount').textContent = s.savedCount;
  $('hotToday').textContent = s.hotToday;
  $('trendsToday').textContent = s.trendsToday;
  $('lastExport').textContent = s.lastExport ? '上次匯出 ' + new Date(s.lastExport).toLocaleString('zh-TW', { hour12: false }) : '尚未匯出';
  if (s.lastPath) $('pathHint').textContent = '檔案在 ' + s.lastPath + '/（收錄.json、收錄.md、高流量.json、趨勢話題.json、觀看數.json），改了會自動覆寫。';
  const err = $('err');
  if (s.lastError) { err.textContent = '匯出或下載失敗：' + s.lastError + '\n（點這裡清除）'; err.style.display = 'block'; }
  else err.style.display = 'none';
  const ul = $('recent'); ul.innerHTML = '';
  for (const p of s.recent) {
    const li = document.createElement('li');
    const a = document.createElement('a'); a.href = p.url; a.target = '_blank';
    a.innerHTML = `<small>@${p.author} · 讚 ${p.likes} 回覆 ${p.replies}</small><br>`;
    a.appendChild(document.createTextNode((p.text || '').replace(/\s+/g, ' ').slice(0, 30) || '（無文字）'));
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '刪';
    del.onclick = async () => { await send({ type: 'unsave', code: p.code }); refresh(); };
    li.appendChild(a); li.appendChild(del); ul.appendChild(li);
  }
  for (const input of document.querySelectorAll('#settings input')) {
    const v = s.settings[input.dataset.k];
    input.value = v == null ? '' : v;
  }
}

$('export').onclick = async () => { $('export').disabled = true; await send({ type: 'export' }); $('export').disabled = false; refresh(); };
$('err').onclick = async () => { await send({ type: 'clearError' }); refresh(); };
$('saveSettings').onclick = async () => {
  const settings = {};
  for (const input of document.querySelectorAll('#settings input')) {
    const k = input.dataset.k;
    settings[k] = input.type === 'number' ? Number(input.value) : input.value.trim().replace(/^@/, '');
  }
  await send({ type: 'setSettings', settings });
  refresh();
};
refresh();
