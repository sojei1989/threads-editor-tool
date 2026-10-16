# Threads 網頁 DOM 與資料來源調查（2026-10-16，threads.com，已登入）

## 貼文容器（動態、個人頁、貼文內頁、搜尋結果都一樣）
- 容器：`[data-pressable-container="true"]`
- 貼文連結：容器內 `a[href*="/post/"]`，格式 `/@帳號/post/代碼`；同一個 `<a>` 裡有 `<time datetime="ISO">`
- 作者：容器內第一個 `a[href^="/@"]`
- 內文：`[dir="auto"]` 葉節點；順序是「主題標頭（例如『超夯：特斯拉』）、帳號、時間、內文段落…、數字」。內文＝介於時間與第一個數字之間的 `[dir="auto"]`
- 動作列：四顆 `div[role="button"]`，各含 `svg > title`，文字分別是
  - 讚：`讚` 或 `收回讚`（已按讚時）
  - 回覆：`回覆` 或 `已回覆`
  - 轉發：`轉發`
  - 分享：`分享`
  - 數字在該按鈕內的葉 `span`（`^[\d,.]+[萬KkM]?$`）；數字 0 時沒有 span
  - 「萬」格式例：`3.5 萬`（有空格）、`1,226`
- 影片：`<video>` 的 src 是 `blob:`，DOM 拿不到下載網址
- 圖片：`img[alt]`，大頭貼 alt 是「xxx的大頭貼照」

## 觀看數
- 別人的貼文：動態與個人頁都沒有。**影片貼文的內頁**頁首有「6.5 萬次瀏覽」（在容器外、頁面頂端，y≈47px）
- 自己的貼文：動態、個人頁、內頁都沒有；在 `/insights` 洞察報告頁「最新貼文」清單有：每張卡片是 `a[href="/insights/post/代碼"]`，葉 span 依序＝內文摘要、讚、回覆、轉發、分享、觀看數、「觀看次數」字樣；沒數據時是「—」

## GraphQL（XHR `POST /api/graphql`，回應 10 萬字以上）
每則貼文物件（有 `like_count` 和 `code` 的物件）：
- `pk`、`id`、`code`（＝網址代碼）、`taken_at`（秒）、`like_count`、`has_liked`、`media_type`（2＝影片）、`caption.text`、`user.username`
- `text_post_app_info.direct_reply_count`、`.repost_count`、`.quote_count`、`.reshare_count`（＝頁面上的「分享」）、`.tag_header`
- `video_versions[]`：`{type:101|102|103, width, height, url}`，url 是 `instagram.*.fbcdn.net/....mp4?...` 直連，可下載；`is_dash_eligible`、`video_dash_manifest`
- `carousel_media[]` 多圖／多片
- 沒有別人貼文的 view_count／play_count（只有 `like_and_view_counts_disabled`、`public_view_count_card_attachment_info: null`）
- content script 在隔離世界讀不到 XHR 回應，要用 `world: "MAIN"` 的 script 掛 `XMLHttpRequest.prototype.open` 的 `loadend`，再 `postMessage` 給 content script

## 搜尋頁 `/search`
- 「最新趨勢話題」：AI 整理的話題清單約 15 條，每條是 `a[role=link][href^="/search?q="]`，葉 span 依序＝標題、一句摘要、「· 827 則貼文」（數字格式 `827`、`1 千`、`4 千`、`1 萬`）
- 上方興趣標籤列（AI Threads、台股…）也是 `/search?q=` 連結
- 動態裡貼文上方的「超夯：特斯拉」是主題標頭（`tag_header`）

## 已裝的其他插件（要避開）
- KOL Radar：`[data-kolr-injected]`，在自己貼文旁插「互動率：73.37%」藍標
- 某字彙插件：`[data-jk-vocab]`，在搜尋頁「追蹤建議」插「存進字彙庫」鈕

## 帳號
- Jeff：`/@sojei1989`
