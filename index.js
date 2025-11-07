require("dotenv").config();
const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");
const session = require("express-session");

const STORES = {
  storeA: {
    channelAccessToken: process.env.STORE_A_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_A_CHANNEL_SECRET,
    liffId: process.env.STORE_A_LIFF_ID,
    manualUrl: process.env.STORE_A_MANUAL_URL,
    richmenuBefore: process.env.STORE_A_RICHMENU_BEFORE,
    richmenuAfter: process.env.STORE_A_RICHMENU_AFTER,
    manualUrls: {
      line: process.env.STORE_A_MANUAL_URL_LINE,
      todo: process.env.STORE_A_MANUAL_URL_TODO,
      default: process.env.STORE_A_MANUAL_URL_DEFAULT,
    },
  },
  nice_sweets: {
    channelAccessToken: process.env.STORE_B_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_B_CHANNEL_SECRET,
    liffId: process.env.STORE_B_LIFF_ID,
    richmenuBefore: process.env.STORE_B_RICHMENU_BEFORE,
    richmenuAfter: process.env.STORE_B_RICHMENU_AFTER,

    // ✅ ここを追加（複数URL対応）
    manualUrls: {
      line: process.env.STORE_B_MANUAL_URL_LINE,
      todo: process.env.STORE_B_MANUAL_URL_TODO,
      default: process.env.STORE_B_MANUAL_URL_DEFAULT,
    },
  },
};

// ==============================
// 🔥 Firebase 初期化
// ==============================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

// ==============================
// ⚙️ Express設定
// ==============================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || "secret-key",
    resave: false,
    saveUninitialized: false,
  })
);

// ==============================
// 🚀 LINEクライアント初期化
// ==============================
const lineClients = {};
for (const [store, conf] of Object.entries(STORES)) {
  lineClients[store] = new Client({
    channelAccessToken: conf.channelAccessToken,
    channelSecret: conf.channelSecret,
  });
}

// ==============================
// 🧭 店舗確認ミドルウェア
// ==============================
function ensureStore(req, res, next) {
  const store = req.params.store;
  if (!store || !STORES[store]) return res.status(404).send("店舗が存在しません。");
  req.store = store;
  req.storeConf = STORES[store];
  req.lineClient = lineClients[store];
  next();
}

// ==============================
// 🔐 管理者ログイン
// ==============================
app.get("/:store/login", ensureStore, (req, res) => {
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${req.store} 管理者ログイン</title>
  <style>
    body { font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; background:#f9fafb; margin:0; }
    .box { background:white; padding:24px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.1); width:100%; max-width:360px; }
    h1 { color:#2563eb; text-align:center; }
    input { width:100%; margin:8px 0; padding:8px; border:1px solid #ccc; border-radius:6px; }
    button { width:100%; padding:10px; background:#2563eb; color:white; border:none; border-radius:6px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
  </style></head><body>
    <div class="box">
      <h1>${req.store} 管理者ログイン</h1>
      <form method="POST" action="/${req.store}/login">
        <input type="text" name="user" placeholder="ユーザーID" required>
        <input type="password" name="pass" placeholder="パスワード" required>
        <button>ログイン</button>
      </form>
    </div>
  </body></html>`);
});

app.post("/:store/login", ensureStore, (req, res) => {
  const { user, pass } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "owner";
  const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.loggedIn = true;
    req.session.store = req.store;
    res.redirect(`/${req.store}/admin`);
  } else {
    res.send("<h3>ログイン失敗</h3><a href='javascript:history.back()'>戻る</a>");
  }
});

// 🔓 ログアウト
app.get("/logout", (req, res) => {
  const store = req.session?.store || "storeA";
  req.session.destroy(() => {
    res.redirect(`/${store}/login`);
  });
});

app.get("/:store/admin", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 管理者TOP</title>
    <style>
      body {
        font-family: 'Noto Sans JP', sans-serif;
        background:#f9fafb;
        margin:0;
        padding:20px;
      }
      h1 {
        text-align:center;
        color:#2563eb;
        margin-bottom:20px;
      }
      .nav {
        display:flex;
        justify-content:center;
        gap:10px;
        flex-wrap:wrap;
        margin-bottom:16px;
      }
      .nav a {
        background:#2563eb;
        color:white;
        text-decoration:none;
        padding:10px 18px;
        border-radius:6px;
        transition:background 0.2s;
      }
      .nav a:hover {
        background:#1e40af;
      }
      .filters {
        display:flex;
        justify-content:center;
        align-items:center;
        gap:12px;
        flex-wrap:wrap;
        margin-top:10px;
      }
      input[type="text"] {
        padding:8px;
        border:1px solid #ccc;
        border-radius:6px;
        width:200px;
      }
      .switch {
        position:relative;
        display:inline-block;
        width:46px;
        height:24px;
      }
      .switch input { display:none; }
      .slider {
        position:absolute;
        cursor:pointer;
        top:0; left:0;
        right:0; bottom:0;
        background-color:#ccc;
        border-radius:24px;
        transition:.3s;
      }
      .slider:before {
        position:absolute;
        content:"";
        height:18px;
        width:18px;
        left:3px;
        bottom:3px;
        background-color:white;
        border-radius:50%;
        transition:.3s;
      }
      input:checked + .slider {
        background-color:#2563eb;
      }
      input:checked + .slider:before {
        transform:translateX(22px);
      }
      table {
        width:95%;
        margin:20px auto;
        border-collapse:collapse;
        background:white;
        border-radius:8px;
        overflow:hidden;
        font-size:14px;
      }
      th, td {
        padding:8px;
        border-bottom:1px solid #eee;
        text-align:center;
      }
      th {
        background:#2563eb;
        color:white;
      }
      tr:nth-child(even){ background:#f9fafb; }
      tr:hover {
        background:#e0f2fe;
        cursor:pointer;
      }
      button {
        padding:4px 8px;
        border:none;
        border-radius:4px;
        cursor:pointer;
        color:white;
      }
      .btn-approve { background:#16a34a; }
      .btn-revoke { background:#f59e0b; }
      .btn-delete { background:#dc2626; }
      .empty { color:#6b7280; padding:12px; }
      footer {
        margin-top:30px;
        text-align:center;
        color:#6b7280;
        font-size:13px;
      }
    </style>
  </head>
  <body>
    <h1>${store} 管理画面</h1>

    <!-- ✅ ボタン群 -->
    <div class="nav">
      <a href="/${store}/admin/attendance">勤怠管理</a>
      <a href="/${store}/admin/fix">打刻修正依頼</a>
    </div>

    <!-- ✅ 検索・フィルタ -->
    <div class="filters">
      <input type="text" id="searchInput" placeholder="名前で検索..." />
      <label>
        <span style="font-size:14px;">承認済みのみ</span>
        <label class="switch">
          <input type="checkbox" id="approvedOnly">
          <span class="slider"></span>
        </label>
      </label>
    </div>

    <!-- ✅ スタッフ一覧 -->
    <table id="staffTable">
      <thead>
        <tr><th>名前</th><th>承認状態</th><th>承認</th><th>解除</th><th>削除</th></tr>
      </thead>
      <tbody id="staffBody"><tr><td colspan="5" class="empty">読み込み中...</td></tr></tbody>
    </table>

    <footer>© ${new Date().getFullYear()} ${store} 管理システム</footer>

    <script>
      const store = "${store}";
      let timer = null;
      let staffData = [];

      document.addEventListener("DOMContentLoaded", async () => {
        await loadStaff();
        document.getElementById("searchInput").addEventListener("input", handleSearch);
        document.getElementById("approvedOnly").addEventListener("change", renderFiltered);
      });

      function handleSearch(e) {
        clearTimeout(timer);
        timer = setTimeout(() => renderFiltered(), 300);
      }

      async function loadStaff() {
        const tbody = document.getElementById("staffBody");
        tbody.innerHTML = '<tr><td colspan="5" class="empty">読み込み中...</td></tr>';
        try {
          const res = await fetch(\`/${store}/admin/search-staff\`);
          staffData = await res.json();
          renderFiltered();
        } catch (err) {
          console.error(err);
          tbody.innerHTML = '<tr><td colspan="5" class="empty">データ取得に失敗しました</td></tr>';
        }
      }

      function renderFiltered() {
        const keyword = document.getElementById("searchInput").value;
        const approvedOnly = document.getElementById("approvedOnly").checked;
        const filtered = staffData.filter(s =>
          s.name.includes(keyword) && (!approvedOnly || s.approved)
        );
        renderTable(filtered);
      }

      function renderTable(data) {
        const tbody = document.getElementById("staffBody");
        if (!data.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">該当するスタッフがいません</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(s => \`
          <tr onclick="viewAttendance('\${s.id}')">
            <td>\${s.name}</td>
            <td>\${s.approved ? "✅ 承認済み" : "⏳ 承認待ち"}</td>
            <td><button class="btn-approve" onclick="event.stopPropagation(); updateStatus('\${s.id}', true)">承認</button></td>
            <td><button class="btn-revoke" onclick="event.stopPropagation(); updateStatus('\${s.id}', false)">解除</button></td>
            <td><button class="btn-delete" onclick="event.stopPropagation(); deleteStaff('\${s.id}')">削除</button></td>
          </tr>\`
        ).join("");
      }

      function viewAttendance(userId) {
        window.location.href = \`/${store}/admin/attendance?userId=\${userId}\`;
      }

      async function updateStatus(userId, approve) {
        if(!confirm(approve ? "このスタッフを承認しますか？" : "承認を解除しますか？")) return;
        await fetch(\`/${store}/admin/update-staff\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, approve })
        });
        await loadStaff();
      }

      async function deleteStaff(userId) {
        if(!confirm("このスタッフを削除しますか？")) return;
        await fetch(\`/${store}/admin/delete-staff\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId })
        });
        await loadStaff();
      }
    </script>
  </body>
  </html>
  `);
});


// ==============================
// 🔄 承認・解除処理（リッチメニュー切り替え）
// ==============================
app.post("/:store/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { store, lineClient, storeConf } = req;
  const userId = req.body.id;
  await db.collection("companies").doc(store).collection("permissions").doc(userId)
    .set({ approved: true }, { merge: true });

  try {
    await lineClient.linkRichMenuToUser(userId, storeConf.richmenuAfter);
  } catch (e) {
    console.error("リッチメニュー切替失敗:", e.originalError?.response?.data || e);
  }

  res.redirect(`/${store}/admin`);
});

app.post("/:store/revoke", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { store, lineClient, storeConf } = req;
  const userId = req.body.id;
  await db.collection("companies").doc(store).collection("permissions").doc(userId)
    .set({ approved: false }, { merge: true });

  try {
    await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
  } catch (e) {
    console.error("初期リッチメニュー戻し失敗:", e.originalError?.response?.data || e);
  }

  res.redirect(`/${store}/admin`);
});

// ==============================
// 📘 マニュアル表示（承認後 Notion へ）
// ==============================
app.get("/:store/manual", ensureStore, (req, res) => {
  const { liffId } = req.storeConf;
  res.send(`
  <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  </head><body><p>LINEログイン中です...</p>
  <script>
    const liffId="${liffId}";
    async function main(){
      await liff.init({liffId});
      if(!liff.isLoggedIn()) return liff.login();
      const p=await liff.getProfile();
      location.href="/${req.store}/manual-check?userId="+encodeURIComponent(p.userId);
    }
    main();
  </script></body></html>`);
});

// 📘 マニュアル表示（カードタイプに対応、未承認はメッセージ表示）
app.get("/:store/manual-check", ensureStore, async (req, res) => {
  const { type, userId } = req.query;
  const { store, storeConf } = req;

  // 1️⃣ userIdが無ければ LIFFでログイン → userIdを取得
  if (!userId) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
      </head>
      <body><p>LINEログイン中...</p>
      <script>
        async function main(){
          try {
            await liff.init({ liffId: "${storeConf.liffId}" });
            if(!liff.isLoggedIn()) return liff.login();
            const p = await liff.getProfile();
            const q = new URLSearchParams(location.search);
            q.set("userId", p.userId);
            location.href = location.pathname + "?" + q.toString();
          } catch(e){
            document.body.innerHTML = "<h3>LIFF初期化に失敗しました：" + e.message + "</h3>";
          }
        }
        main();
      </script>
      </body>
      </html>
    `);
  }

  // 2️⃣ Firestoreの承認確認
  const doc = await db.collection("companies").doc(store)
    .collection("permissions").doc(userId).get();

  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved)
    return res.status(403).send("<h3>承認待ちです。<br>管理者の承認をお待ちください。</h3>");

  // 3️⃣ typeパラメータ別にURLをenvから読み込み
  const urls = storeConf.manualUrls || {};
  // 3️⃣ typeパラメータ別にURLをenvから読み込み
  let redirectUrl;

  // ✅ 単一URL（storeAなど）対応を追加
  if (storeConf.manualUrls) {
    // 複数マニュアル対応（storeBなど）
    const urls = storeConf.manualUrls;
    redirectUrl =
      (type === "line" && urls.line) ||
      (type === "todo" && urls.todo) ||
      urls.default;
  } else if (storeConf.manualUrl) {
    // ✅ 単一マニュアル対応（storeAなど）
    redirectUrl = storeConf.manualUrl;
  }

  // URLが設定されていない場合のエラーハンドリング
  if (!redirectUrl) {
    return res
      .status(404)
      .send("<h3>マニュアルURLが設定されていません。</h3>");
  }

  // 4️⃣ 承認済みなら対象Notionマニュアルへリダイレクト
  res.redirect(redirectUrl);

});


// ==============================
// 🧾 権限申請フォーム（LIFF）
// ==============================
app.get("/:store/apply", ensureStore, (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${store} 権限申請</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body { font-family: 'Segoe UI', sans-serif; background:#f9fafb; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
      .form-box { background:#fff; padding:24px; border-radius:12px; box-shadow:0 2px 10px rgba(0,0,0,0.1); width:90%; max-width:360px; text-align:center; }
      h1 { color:#2563eb; margin-bottom:16px; font-size:1.4rem; }
      input { width:100%; padding:10px; margin-bottom:12px; border-radius:6px; border:1px solid #d1d5db; font-size:1rem; }
      button { width:100%; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; font-size:1rem; cursor:pointer; }
      button:hover { background:#1d4ed8; }
    </style>
  </head>
  <body>
    <div class="form-box">
      <h1>${store} 権限申請</h1>
      <form id="applyForm" method="POST" action="/${store}/apply/submit">
        <input type="hidden" name="userId" id="userId">
        <input type="text" name="name" id="name" placeholder="名前を入力" required>
        <button type="submit">申請</button>
      </form>
    </div>
    <script>
      async function initLiff() {
        try {
          await liff.init({ liffId: "${storeConf.liffId}" });
          if (!liff.isLoggedIn()) { liff.login(); return; }
          const profile = await liff.getProfile();
          document.getElementById("userId").value = profile.userId;
        } catch (err) {
          alert("LIFF初期化に失敗しました: " + err.message);
        }
      }
      initLiff();
    </script>
  </body>
  </html>`);
});

app.post("/:store/apply/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name } = req.body;

  if (!userId || !name)
    return res.status(400).send("名前またはLINE情報が取得できませんでした。");

  try {
    await db.collection("companies").doc(store).collection("permissions").doc(userId)
      .set({ name, approved: false, requestedAt: new Date() }, { merge: true });

    res.send(`
    <html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
    body { font-family:sans-serif; background:#f9fafb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .box { background:#fff; padding:24px; border-radius:10px; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,0.1); max-width:360px; }
    h2 { color:#16a34a; }
    </style></head><body>
    <div class="box">
        <h2>申請を受け付けました！</h2>
        <p>管理者の承認をお待ちください。</p>
    </div>
    </body></html>`);
  } catch (error) {
    console.error("Firestore保存失敗:", error);
    res.status(500).send("申請処理中にエラーが発生しました。");
  }
});
// ==============================
// 🕒 従業員勤怠打刻画面（修正申請付き）
// ==============================
// ==============================
// 🕒 従業員勤怠打刻画面（修正申請＋UI改良版）
// ==============================
app.get("/:store/attendance", ensureStore, (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${store} 勤怠打刻</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body { font-family: sans-serif; background: #f9fafb; padding: 16px; margin:0; }
      .card { background:white; border-radius:8px; padding:16px; box-shadow:0 2px 8px rgba(0,0,0,0.1); max-width:480px; margin:16px auto; }
      h1 { color:#2563eb; text-align:center; margin-top:0; }
      #status { text-align:center; margin-bottom:12px; color:#4b5563; }

      .grid-2x2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .action-card { background:#f3f4f6; border-radius:8px; padding:8px; text-align:center; }
      .action-title { font-size:0.9rem; margin-bottom:4px; }
      .action-time { font-size:1.1rem; font-weight:bold; margin-bottom:4px; }
      .action-btn { width:100%; padding:6px 0; border:none; border-radius:6px; color:white; font-size:0.9rem; cursor:pointer; }
      .btn-in { background:#16a34a; }
      .btn-out { background:#dc2626; }
      .btn-break-start { background:#f59e0b; }
      .btn-break-end { background:#2563eb; }
      .btn-request { background:#6b7280; margin-top:10px; width:100%; }

      .filter-row { margin-top:16px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .filter-row label { font-size:0.9rem; }
      input[type="month"] { padding:4px 6px; border-radius:6px; border:1px solid #d1d5db; }

      /* ✅ 横スクロール対応 */
      .table-wrapper { width:100%; overflow-x:auto; margin-top:12px; -webkit-overflow-scrolling:touch; }
      table { width:100%; border-collapse:collapse; background:white; font-size:13px; min-width:700px; }
      th, td { border:1px solid #e5e7eb; padding:6px; text-align:center; white-space:nowrap; }
      th { background-color:#2563eb; color:white; }
      tr:nth-child(even){ background:#f9fafb; }

      /* ✅ モーダル */
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; padding:20px; border-radius:8px; width:90%; max-width:400px; max-height:80%; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
      .modal-content h3 { margin:0; color:#2563eb; text-align:center; }
      .modal-content input, .modal-content textarea { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; }
      .modal-content textarea { height:80px; resize:none; }
      .time-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .btn-send { background:#2563eb; color:white; border:none; border-radius:6px; padding:8px; cursor:pointer; }
      .btn-close { background:#dc2626; color:white; border:none; border-radius:6px; padding:8px; cursor:pointer; }
      .current-record { background:#f3f4f6; border-radius:6px; padding:8px; font-size:14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${store} 勤怠管理</h1>
      <div id="status">LINEログイン中...</div>

      <div class="grid-2x2">
        <div class="action-card">
          <div class="action-title">出勤</div>
          <div class="action-time" id="timeIn">--:--</div>
          <button id="btnIn" class="action-btn btn-in">出勤</button>
        </div>
        <div class="action-card">
          <div class="action-title">退勤</div>
          <div class="action-time" id="timeOut">--:--</div>
          <button id="btnOut" class="action-btn btn-out">退勤</button>
        </div>
        <div class="action-card">
          <div class="action-title">休憩開始</div>
          <div class="action-time" id="timeBreakStart">--:--</div>
          <button id="btnBreakStart" class="action-btn btn-break-start">休憩開始</button>
        </div>
        <div class="action-card">
          <div class="action-title">休憩終了</div>
          <div class="action-time" id="timeBreakEnd">--:--</div>
          <button id="btnBreakEnd" class="action-btn btn-break-end">休憩終了</button>
        </div>
      </div>

      <button id="btnFix" class="btn-request">打刻修正申請</button>

      <div class="filter-row">
        <label for="monthSelect">対象月</label>
        <input type="month" id="monthSelect">
      </div>

      <div class="table-wrapper">
        <table id="recordsTable">
          <thead>
            <tr>
              <th>日付</th><th>出勤</th><th>退勤</th><th>休憩開始</th><th>休憩終了</th>
            </tr>
          </thead>
          <tbody id="recordsBody"></tbody>
        </table>
      </div>
    </div>

    <!-- ✅ 修正申請モーダル -->
    <div id="modal" class="modal">
      <div class="modal-content">
        <h3>打刻時間修正申請</h3>

        <label>修正対象日</label>
        <input type="date" id="reqDate" />

        <div class="current-record" id="currentRecord">現在の記録: データ取得中...</div>

        <label>修正後の時間</label>
        <div class="time-grid">
          <input type="time" id="newClockIn" placeholder="出勤" />
          <input type="time" id="newClockOut" placeholder="退勤" />
          <input type="time" id="newBreakStart" placeholder="休憩開始" />
          <input type="time" id="newBreakEnd" placeholder="休憩終了" />
        </div>

        <label>修正理由</label>
        <textarea id="reqMessage" placeholder="打刻を忘れた、誤って打刻した等の理由を記載してください"></textarea>

        <div style="display:flex; gap:10px; justify-content:space-between;">
          <button class="btn-close" onclick="closeModal()">キャンセル</button>
          <button class="btn-send" onclick="submitRequest()">申請</button>
        </div>
      </div>
    </div>

    <script>
      let userId, name, allRecords = [];

      async function main() {
        await liff.init({ liffId: "${storeConf.liffId}" });
        if (!liff.isLoggedIn()) return liff.login();
        const p = await liff.getProfile();
        userId = p.userId; name = p.displayName;
        document.getElementById("status").innerText = name + " さんログイン中";
        initMonthSelector();
        await loadRecords();
      }

      function timeOnly(str){ if(!str)return "--:--"; const p=String(str).split(" "); return p.length>1?p[1].slice(0,5):str.slice(-5); }
      function getTodayKey(){ const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); return jst.toISOString().slice(0,10); }
      function initMonthSelector(){ const m=document.getElementById("monthSelect"); const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); m.value=jst.toISOString().slice(0,7); m.addEventListener("change",loadRecords); }

      async function sendAction(action){
        await fetch("/${store}/attendance/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId,name,action})});
        loadRecords();
      }

      document.addEventListener("DOMContentLoaded", () => {


        const btnFix = document.getElementById("btnFix");
        if (btnFix) {
          btnFix.onclick = () => {
            window.location.href = "/${store}/attendance/fix";
          };
        }

        document.getElementById("btnIn").onclick = () => sendAction("clockIn");
        document.getElementById("btnOut").onclick = () => sendAction("clockOut");
        document.getElementById("btnBreakStart").onclick = () => sendAction("breakStart");
        document.getElementById("btnBreakEnd").onclick = () => sendAction("breakEnd");
      });




      function closeModal() {
        document.getElementById("modal").style.display = "none";
      }

      function openModal(){
        const modal=document.getElementById("modal");
        modal.style.display="flex";
        const today=getTodayKey();
        const record=allRecords.find(r=>r.date===today);
        const recText = record
          ? \`出勤:\${record.clockIn||"--"} 退勤:\${record.clockOut||"--"} 休憩開始:\${record.breakStart||"--"} 休憩終了:\${record.breakEnd||"--"}\`
          : "記録がありません";
        document.getElementById("currentRecord").innerText = "現在の記録: " + recText;
        document.getElementById("reqDate").value = today;
      }

      async function submitRequest(){
        const date=document.getElementById("reqDate").value;
        const msg=document.getElementById("reqMessage").value;
        const newData={
          clockIn:document.getElementById("newClockIn").value,
          clockOut:document.getElementById("newClockOut").value,
          breakStart:document.getElementById("newBreakStart").value,
          breakEnd:document.getElementById("newBreakEnd").value
        };
        if(!date||!msg)return alert("日付と理由を入力してください。");
        await fetch("/${store}/attendance/request",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({userId,name,date,message:msg,newData})
        });
        alert("修正申請を送信しました。");
        closeModal();
      }

      async function loadRecords(){
        const month=document.getElementById("monthSelect").value;
        const res=await fetch("/${store}/attendance/records?userId="+userId+"&month="+month);
        const data=await res.json();
        allRecords=data;
        const tbody=document.getElementById("recordsBody");
        tbody.innerHTML=data.map(r=>"<tr><td>"+(r.date||"--")+"</td><td>"+(r.clockIn||"--:--")+"</td><td>"+(r.clockOut||"--:--")+"</td><td>"+(r.breakStart||"--:--")+"</td><td>"+(r.breakEnd||"--:--")+"</td></tr>").join("");

        const today=getTodayKey();
        const todayData=data.find(r=>r.date===today);
        document.getElementById("timeIn").innerText=timeOnly(todayData?.clockIn);
        document.getElementById("timeOut").innerText=timeOnly(todayData?.clockOut);
        document.getElementById("timeBreakStart").innerText=timeOnly(todayData?.breakStart);
        document.getElementById("timeBreakEnd").innerText=timeOnly(todayData?.breakEnd);
      }

      main();
    </script>
  </body>
  </html>
  `);
});

// 🔹 店舗ごとに修正申請を保存
app.post("/:store/attendance/request", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, date, message, before, after } = req.body;

  try {
    const ref = db.collection("companies")
      .doc(store)
      .collection("attendanceRequests");

    await ref.add({
      userId,
      name,
      date,
      message,
      before,
      after,
      status: "承認待ち",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ Error saving attendance request:", err);
    res.status(500).json({ error: "保存に失敗しました。" });
  }
});


// 🔹 店舗ごとに修正申請を取得
app.get("/:store/attendance/requests", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.query;

  try {
    if (!userId) return res.status(400).json({ error: "userIdが必要です。" });

    const ref = db.collection("companies")
      .doc(store)
      .collection("attendanceRequests");

    let snap;
    try {
      snap = await ref
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .get();
    } catch (err) {
      console.warn("⚠️ orderBy失敗 → fallback (createdAtなし)");
      snap = await ref.where("userId", "==", userId).get();
    }

    const data = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(data);
  } catch (err) {
    console.error("❌ /attendance/requests error:", err);
    res.status(500).json({ error: "データ取得に失敗しました: " + err.message });
  }
});




// 出退勤ステータス取得
app.get("/:store/attendance/status", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const doc = await db.collection("companies").doc(store)
    .collection("attendance").doc(`${userId}_${today}`).get();
  res.json(doc.exists ? doc.data() : {});
});

// 🧾 打刻処理（日本時間対応版）
// 🧾 打刻処理（修正版）
// 🧾 打刻処理（日本時間で正確に保存）
app.post("/:store/attendance/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, action } = req.body;

  // ✅ JSTでの日付文字列（勤怠1日単位のキー用）
  const now = new Date(); // ← UTCベースで取得（これが重要）
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentDate = jstNow.toISOString().split("T")[0]; // "YYYY-MM-DD"

  // Firestore参照
  const ref = db.collection("companies").doc(store)
    .collection("attendance").doc(userId)
    .collection("records").doc(currentDate);

  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};

  // ✅ Firestore Timestamp は「UTCのまま」保存する
  const ts = admin.firestore.Timestamp.fromDate(now);

  // 二重打刻チェック
  if (action === "clockIn" && data.clockIn) return res.send("すでに出勤済みです。");
  if (action === "breakStart" && (!data.clockIn || data.breakStart)) return res.send("休憩開始は出勤後のみです。");
  if (action === "breakEnd" && (!data.breakStart || data.breakEnd)) return res.send("休憩終了は休憩開始後のみです。");
  if (action === "clockOut" && data.clockOut) return res.send("すでに退勤済みです。");

  // 各アクションに対応
  if (action === "clockIn") data.clockIn = ts;
  if (action === "breakStart") data.breakStart = ts;
  if (action === "breakEnd") data.breakEnd = ts;
  if (action === "clockOut") data.clockOut = ts;

  data.userId = userId;
  data.name = name;
  data.date = currentDate;

  await ref.set(data, { merge: true });

  res.send("打刻を記録しました（JST表示対応）");
});
app.get("/:store/admin/attendance", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 勤怠管理</title>
    <style>
      body { font-family:sans-serif; background:#f9fafb; margin:0; padding:16px; }
      h1 { color:#2563eb; text-align:center; }
      select, input { padding:6px; border:1px solid #ccc; border-radius:6px; margin:4px; }
      table { width:100%; border-collapse:collapse; margin-top:12px; background:white; border-radius:8px; overflow:hidden; }
      th,td { padding:8px; border-bottom:1px solid #eee; text-align:center; font-size:14px; white-space:nowrap; }
      th { background:#2563eb; color:white; }
      .summary { text-align:right; margin-top:10px; }
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; padding:20px; border-radius:8px; max-width:320px; width:90%; }
      .table-wrapper { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    </style>
  </head>
  <body>
    <h1>${store} 勤怠管理</h1>

    <div>
      <label>対象月：</label>
      <input type="month" id="monthSelect">
      <label>スタッフ：</label>
      <select id="staffSelect"></select>
    </div>

    <div class="summary" id="summary"></div>

    <div class="table-wrapper">
      <table id="records">
        <thead>
          <tr>
            <th>日付</th>
            <th>名前</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>休憩開始</th>
            <th>休憩終了</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <script>
      const store = "${store}";
      let allStaff = [], allRecords = [];

      async function init() {
        const now = new Date();
        document.getElementById("monthSelect").value = now.toISOString().slice(0, 7);
        await loadStaff();
        await loadRecords(); // 初期表示＝全てのスタッフ
      }

      async function loadStaff() {
        const res = await fetch("/${store}/admin/staff");
        allStaff = await res.json();
        const sel = document.getElementById("staffSelect");
        sel.innerHTML = '<option value="">全て</option>' + allStaff.map(s => 
          \`<option value="\${s.id}">\${s.name}</option>\`
        ).join("");
        sel.onchange = loadRecords;
      }

      // ✅ Firestore Timestamp対応版
      function formatTime(ts){
        if(!ts) return "--:--";
        try{
          if(ts._seconds) return new Date(ts._seconds * 1000).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Tokyo"});
          if(typeof ts === "string" && ts.includes("T")) return new Date(ts).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Tokyo"});
          return String(ts).slice(0,5);
        }catch{ return "--:--"; }
      }

      async function loadRecords(){
        const selectedId = document.getElementById("staffSelect").value;
        const month = document.getElementById("monthSelect").value;

        const res = await fetch("/${store}/admin/all-attendance?month=" + month);
        allRecords = await res.json();

        const filtered = selectedId 
          ? allRecords.filter(r => r.userId === selectedId) 
          : allRecords;

        renderTable(filtered);
      }

      function renderTable(list){
        const tbody = document.querySelector("#records tbody");
        if(!list.length){
          tbody.innerHTML = "<tr><td colspan='6'>該当データがありません</td></tr>";
          document.getElementById("summary").textContent = "";
          return;
        }

        tbody.innerHTML = list.map(r => \`
          <tr>
            <td>\${r.date}</td>
            <td>\${r.name || "未登録"}</td>
            <td>\${formatTime(r.clockIn)}</td>
            <td>\${formatTime(r.clockOut)}</td>
            <td>\${formatTime(r.breakStart)}</td>
            <td>\${formatTime(r.breakEnd)}</td>
          </tr>\`
        ).join("");

        const workDays = list.filter(r => r.clockIn && r.clockOut).length;
        document.getElementById("summary").textContent = "勤務日数：" + workDays + "日";
      }

      init();
    </script>
  </body>
  </html>
  `);
});


// ==============================
// ⏱ 管理者勤怠修正API（出勤＞退勤のバリデーション付き）
// ==============================
app.post("/:store/admin/attendance/update", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { userId, date, clockIn, clockOut } = req.body;
  const store = req.store;

  // 入力チェック
  if (clockIn && clockOut) {
    const inTime = new Date(`${date}T${clockIn}:00+09:00`);
    const outTime = new Date(`${date}T${clockOut}:00+09:00`);
    if (inTime > outTime) {
      return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2 style="color:#dc2626;">エラー</h2>
        <p>出勤時間が退勤時間より後になっています。</p>
        <a href="/${store}/admin/attendance" style="color:#2563eb;">← 戻る</a>
      </body></html>
      `);
    }
  }

  // Firestore更新
  const docRef = db.collection("companies").doc(store)
    .collection("attendance").doc(`${userId}_${date}`);

  const updates = {};
  if (clockIn) updates.clockIn = new Date(`${date}T${clockIn}:00+09:00`);
  if (clockOut) updates.clockOut = new Date(`${date}T${clockOut}:00+09:00`);

  await docRef.set(updates, { merge: true });
  res.redirect(`/${store}/admin/attendance`);
});

// 毎朝9時に自動実行される処理（Render Cron Jobsで設定）
app.get("/cron/attendance-alert/:store", ensureStore, async (req, res) => {
  const { store, lineClient } = req;
  const yesterday = new Date(Date.now() - 86400000);
  const ymd = yesterday.toISOString().split("T")[0];

  const snapshot = await db.collection("companies").doc(store)
    .collection("attendance")
    .where("date", "==", ymd)
    .get();

  const missing = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!data.clockIn || !data.clockOut) {
      missing.push({ name: data.name, userId: data.userId });
    }
  });

  if (missing.length > 0) {
    // 管理者に通知
    const names = missing.map(m => m.name).join("、");
    await lineClient.broadcast({
      type: "text",
      text: `【${store}】昨日(${ymd})の打刻漏れ：${names}`,
    });

    // 各本人にも通知
    for (const m of missing) {
      await lineClient.pushMessage(m.userId, {
        type: "text",
        text: `昨日(${ymd})の出退勤打刻が確認できませんでした。ご確認ください。`,
      });
    }
  }

  res.send(`✅ ${missing.length}件の打刻漏れを通知しました`);
});

// ✅ 全スタッフの勤怠データ取得（管理者用）
app.get("/:store/admin/all-attendance", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { month } = req.query;
  const results = [];

  const staffDocs = await db.collection("companies").doc(store).collection("permissions")
    .where("approved", "==", true).get();

  for (const doc of staffDocs.docs) {
    const userId = doc.id;
    const name = doc.data().name || "未登録";
    const snap = await db.collection("companies").doc(store)
      .collection("attendance").doc(userId).collection("records").get();

    snap.forEach(r => {
      const d = r.data();
      if (d.date && d.date.startsWith(month)) {
        results.push({ userId, name, ...d });
      }
    });
  }

  res.json(results);
});


// ==============================
// 🕒 管理者勤怠管理画面（改良版）
// ==============================
app.get("/:store/attendance-admin", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snapshot = await db.collection("companies").doc(store).collection("attendance").get();
  const records = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  const staffList = [...new Set(records.map(r => r.name))].filter(Boolean);
  const jsonData = JSON.stringify(records);

  res.send(`
  <!DOCTYPE html><html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${store} 勤怠管理</title>
    <style>
      body { font-family:'Segoe UI',sans-serif; background:#f8fafb; margin:0; padding:16px; color:#333; }
      h1 { color:#14532d; margin-bottom:16px; text-align:center; }
      .filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; justify-content:center; }
      .filter-box { background:#fff; padding:10px 14px; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,0.1); }
      .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-bottom:16px; }
      .card { background:#fff; border-radius:12px; box-shadow:0 1px 6px rgba(0,0,0,0.1); padding:12px; text-align:center; }
      .card h2 { margin:4px 0; color:#14532d; font-size:1.6em; }
      table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; table-layout:fixed; }
      th,td { padding:10px; border-bottom:1px solid #eee; text-align:center; word-wrap:break-word; }
      th { background:#14532d; color:white; font-weight:600; }
      button { background:#16a34a; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.9em; }
      button:hover { background:#15803d; }
      dialog input{margin-bottom:10px;width:100%;box-sizing:border-box;}
      @media(max-width:600px){
        th,td{font-size:13px;padding:6px;}
        table{font-size:13px;}
      }
    </style>
  </head>
  <body>
    <h1>${store} 勤怠管理</h1>

    <div class="filters">
      <div class="filter-box">
        <label>対象月：</label>
        <input type="month" id="month" value="${new Date().toISOString().slice(0,7)}" />
      </div>
      <div class="filter-box">
        <label>スタッフ：</label>
        <select id="staff">
          <option value="">全スタッフ</option>
          ${staffList.map(n => `<option>${n}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div>総勤務日数</div><h2 id="daysCount">0</h2></div>
      <div class="card"><div>総勤務時間</div><h2 id="totalHours">0h</h2></div>
    </div>

    <table id="attendanceTable">
      <thead><tr><th>日付</th><th>スタッフ</th><th>出勤</th><th>退勤</th><th>実働</th><th>操作</th></tr></thead>
      <tbody></tbody>
    </table>

    <dialog id="editModal">
      <form method="dialog" style="padding:20px;">
        <h3>出退勤時間修正</h3>
        <input type="hidden" id="editId">
        <div><label>出勤：</label><input type="time" id="editIn" required></div>
        <div><label>退勤：</label><input type="time" id="editOut" required></div>
        <div style="margin-top:10px;">
          <button type="button" onclick="saveEdit()">更新</button>
          <button type="button" onclick="closeModal()">閉じる</button>
        </div>
      </form>
    </dialog>

    <script>
      const records = ${jsonData};
      const tableBody = document.querySelector('#attendanceTable tbody');
      const monthInput = document.getElementById('month');
      const staffSelect = document.getElementById('staff');
      const daysCount = document.getElementById('daysCount');
      const totalHours = document.getElementById('totalHours');

      function formatDateShort(dateStr){
        const d = new Date(dateStr);
        return \`\${d.getMonth()+1}/\${d.getDate()}\`;
      }

      function formatDate(ts){
        if(!ts) return '-';
        const d = new Date(ts._seconds * 1000);
        const options = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' };
        return d.toLocaleTimeString('ja-JP', options);
      }

      function calcHours(clockIn, clockOut){
        if(!clockIn || !clockOut) return 0;
        const start = new Date(clockIn._seconds * 1000);
        const end = new Date(clockOut._seconds * 1000);
        const diff = (end - start) / (1000 * 60 * 60);
        return Math.floor(diff); // 小数切り捨て
      }

      function render(){
        const selectedMonth = monthInput.value;
        const selectedStaff = staffSelect.value;
        const filtered = records.filter(r => {
          return (!selectedStaff || r.name === selectedStaff) &&
                 (!selectedMonth || r.date.startsWith(selectedMonth));
        });

        let total = 0;
        tableBody.innerHTML = filtered.map(r => {
          const h = calcHours(r.clockIn, r.clockOut);
          total += h;
          return \`<tr>
            <td>\${formatDateShort(r.date)}</td>
            <td>\${r.name || '未登録'}</td>
            <td>\${formatDate(r.clockIn)}</td>
            <td>\${formatDate(r.clockOut)}</td>
            <td>\${h}h</td>
            <td><button onclick="editRecord('\${r.id}','\${r.name}','\${r.date}','\${formatDate(r.clockIn)}','\${formatDate(r.clockOut)}')">修正</button></td>
          </tr>\`;
        }).join('');

        daysCount.textContent = filtered.length;
        totalHours.textContent = total + 'h';
      }

      monthInput.addEventListener('change', render);
      staffSelect.addEventListener('change', render);
      render();

      function editRecord(id,name,date,inT,outT){
        const m=document.getElementById('editModal');
        document.getElementById('editId').value=id;
        document.getElementById('editIn').value=inT||'';
        document.getElementById('editOut').value=outT||'';
        m.showModal();
      }

      async function saveEdit(){
        const userId = document.getElementById("staffSelect").value;
        const date = document.getElementById("editDate").value;
        const inT = document.getElementById("editIn").value;
        const outT = document.getElementById("editOut").value;
        if(inT && outT && inT>outT){ alert("出勤時間は退勤時間より前にしてください。"); return; }

        const body = {
          userId, date,
          clockIn: inT, clockOut: outT,
          breakStart: document.getElementById("editBreakStart").value,
          breakEnd: document.getElementById("editBreakEnd").value
        };
        const res = await fetch("/${store}/admin/attendance/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        alert(await res.text());
        closeModal();
        loadRecords();
      }

      // ✅ DOM読み込み後に初期化
      document.addEventListener("DOMContentLoaded", () => {
        loadRecords();
      });
    </script>

  </body></html>
  `);
});


// 🔄 勤怠修正API（Firestore Timestamp更新対応）
app.post("/:store/attendance-admin/update", ensureStore, async (req, res) => {
  const { id, clockIn, clockOut } = req.body;
  const [userId, date] = id.split("_");
  const store = req.store;

  const ci = admin.firestore.Timestamp.fromDate(new Date(clockIn));
  const co = admin.firestore.Timestamp.fromDate(new Date(clockOut));

  if (ci.toMillis() >= co.toMillis()) {
    return res.status(400).send("退勤時刻は出勤より後にしてください。");
  }

  await db.collection("companies").doc(store).collection("attendance").doc(id).update({
    clockIn: ci,
    clockOut: co,
  });

  res.send("更新しました");
});

// 出勤ボタン処理
app.post("/:store/attendance/clockIn", ensureStore, async (req, res) => {
  const { userId, name, date } = req.body;
  const store = req.store;
  const docRef = db.collection("companies").doc(store).collection("attendance").doc(`${userId}_${date}`);
  const doc = await docRef.get();

  if (doc.exists && doc.data().clockIn) {
    return res.send("⚠️ すでに出勤打刻済みです。");
  }

  await docRef.set(
    {
      userId,
      name,
      date,
      clockIn: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
  res.send("✅ 出勤を記録しました。");
});

// 退勤ボタン処理
app.post("/:store/attendance/clockOut", ensureStore, async (req, res) => {
  const { userId, date } = req.body;
  const store = req.store;
  const docRef = db.collection("companies").doc(store).collection("attendance").doc(`${userId}_${date}`);
  const doc = await docRef.get();

  if (!doc.exists || !doc.data().clockIn) {
    return res.send("⚠️ 出勤打刻がありません。");
  }
  if (doc.data().clockOut) {
    return res.send("⚠️ すでに退勤打刻済みです。");
  }

  await docRef.update({
    clockOut: admin.firestore.Timestamp.now(),
  });
  res.send("✅ 退勤を記録しました。");
});

// 📅 月別一覧取得
// 勤怠一覧取得API
app.get("/:store/attendance/records", ensureStore, async (req, res) => {
  const { userId, month } = req.query;
  const store = req.store;

  if (!userId || !month) {
    return res.status(400).send("userId と month は必須です");
  }

  try {
    const snap = await db
      .collection("companies")
      .doc(store)
      .collection("attendance")
      .doc(userId)
      .collection("records")
      .orderBy("date", "asc")
      .get();

    const records = snap.docs
      .map(doc => {
        const d = doc.data();
        return {
          date: d.date,
          clockIn: d.clockIn ? formatDate(d.clockIn) : null,
          clockOut: d.clockOut ? formatDate(d.clockOut) : null,
          breakStart: d.breakStart ? formatDate(d.breakStart) : null,
          breakEnd: d.breakEnd ? formatDate(d.breakEnd) : null,
        };
      })
      .filter(r => r.date && r.date.startsWith(month)); // 対象月のみ表示

    res.json(records);
  } catch (e) {
    console.error("❌ 勤怠データ取得エラー:", e);
    res.status(500).send("データ取得に失敗しました");
  }
});

function formatDate(ts) {
  const date = ts.toDate();
  return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}


// 承認済みスタッフ一覧
app.get("/:store/admin/staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const docs = await db.collection("companies").doc(store).collection("permissions")
    .where("approved","==",true).get();
  res.json(docs.docs.map(d=>({ id:d.id, name:d.data().name })));
});

// 勤怠一覧取得
app.get("/:store/admin/attendance/records", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, month } = req.query;
  if(!userId)return res.json([]);
  const col = db.collection("companies").doc(store).collection("attendance").doc(userId).collection("records");
  const snap = await col.get();
  const list = snap.docs.map(d=>d.data())
    .filter(r=>r.date.startsWith(month))
    .map(r=>({
      date:r.date,
      clockIn:r.clockIn?r.clockIn.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      breakStart:r.breakStart?r.breakStart.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      breakEnd:r.breakEnd?r.breakEnd.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      clockOut:r.clockOut?r.clockOut.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
    }));
  res.json(list);
});

// 勤怠修正
app.post("/:store/admin/attendance/update", ensureStore, async (req,res)=>{
  const { store } = req.params;
  const { userId, date, clockIn, clockOut, breakStart, breakEnd } = req.body;
  const ref = db.collection("companies").doc(store).collection("attendance").doc(userId).collection("records").doc(date);

  const times = {clockIn,clockOut,breakStart,breakEnd};
  for(const k in times){
    if(times[k]) times[k] = admin.firestore.Timestamp.fromDate(new Date(date+"T"+times[k]+":00+09:00"));
  }

  await ref.set(times,{merge:true});
  res.send("勤怠を更新しました。");
});

app.get("/:store/manual-view", ensureStore, async (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} マニュアル閲覧</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
        background: #f9fafb;
        height: 100vh;
        display: flex;
        flex-direction: column;
      }
      header {
        background: #2563eb;
        color: white;
        text-align: center;
        padding: 10px;
        font-size: 18px;
        font-weight: bold;
      }
      iframe {
        flex: 1;
        width: 100%;
        border: none;
      }
      /* 黒画面オーバーレイ */
      #blackout {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 1);
        z-index: 9999;
        display: none;
      }
      #blackout p {
        color: white;
        text-align: center;
        margin-top: 40vh;
        font-size: 20px;
      }
    </style>
  </head>
  <body>
    <header>${store} マニュアル</header>

    <!-- Notion 埋め込み -->
    <iframe src="${storeConf.manualUrl}" id="notionFrame" allowfullscreen></iframe>

    <!-- オーバーレイ -->
    <div id="blackout">
      <p>マニュアルを保護中...</p>
    </div>

    <script>
      async function main() {
        await liff.init({ liffId: "${storeConf.liffId}" });
        if (!liff.isLoggedIn()) liff.login();

        // visibilitychange イベントで黒画面を切り替え
        document.addEventListener("visibilitychange", () => {
          const overlay = document.getElementById("blackout");
          if (document.hidden) {
            // アプリを離れた瞬間に黒画面ON
            overlay.style.display = "block";
          } else {
            // アプリに戻ったら解除
            overlay.style.display = "none";
          }
        });

        // スマホ画面を閉じたりスリープした場合にも対応
        window.addEventListener("pagehide", () => {
          document.getElementById("blackout").style.display = "block";
        });
        window.addEventListener("pageshow", () => {
          document.getElementById("blackout").style.display = "none";
        });
      }

      main();
    </script>
  </body>
  </html>
  `);
});
// 🛠 打刻修正申請ページ// 🛠 打刻修正申請ページ
// 🛠 打刻修正申請ページ
app.get("/:store/attendance/fix", ensureStore, async (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${store} 打刻修正申請</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body { font-family:sans-serif; background:#f9fafb; margin:0; padding:20px; color:#333; }
      .container { max-width:600px; margin:auto; }
      h1 { font-size:20px; color:#111; margin-bottom:16px; }
      .card { background:#fff; border-radius:12px; box-shadow:0 1px 4px rgba(0,0,0,0.08); padding:20px; }
      .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
      .card-header h2 { font-size:16px; font-weight:bold; margin:0; }
      .btn-new { background:#111827; color:white; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:4px; }
      .btn-new:hover { background:#1f2937; }
      table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
      th,td { padding:8px; text-align:left; border-bottom:1px solid #e5e7eb; vertical-align:top; }
      th { color:#374151; font-weight:600; }
      td { color:#4b5563; line-height:1.5; }
      .empty { text-align:center; padding:16px; color:#9ca3af; }
      .btn-back { background:#9ca3af; color:white; border:none; border-radius:6px; padding:8px 16px; cursor:pointer; font-size:13px; margin-top:16px; display:block; margin-left:auto; }
      .status { display:inline-block; padding:2px 8px; border-radius:6px; font-size:12px; }
      .waiting { background:#fef3c7; color:#92400e; }

      /* モーダル */
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; border-radius:12px; padding:20px; width:90%; max-width:400px; max-height:90%; overflow-y:auto; }
      .modal-content h3 { text-align:center; margin-bottom:12px; font-size:16px; color:#111; }
      label { display:block; margin-top:10px; font-weight:bold; font-size:13px; }
      input, textarea { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:8px; margin-top:4px; font-size:13px; }
      textarea { height:80px; resize:none; }
      .time-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px; }
      .btn-row { display:flex; justify-content:space-between; margin-top:16px; }
      .btn-cancel { background:#9ca3af; color:white; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; }
      .btn-send { background:#2563eb; color:white; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; }
      .current-record { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:8px; margin-top:8px; font-size:13px; color:#374151; line-height:1.6; }
      .new-time { color:#16a34a; font-weight:bold; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>打刻時間修正申請</h1>
      <div class="card">
        <div class="card-header">
          <h2>修正申請一覧</h2>
          <button class="btn-new" id="btnNew">＋ 新規申請</button>
        </div>
        <table id="requestTable">
          <thead>
            <tr><th>修正内容</th><th>理由</th><th>ステータス</th></tr>
          </thead>
          <tbody id="requestBody">
            <tr><td colspan="3" class="empty">申請はありません</td></tr>
          </tbody>
        </table>
      </div>
      <button class="btn-back" onclick="history.back()">戻る</button>
    </div>

    <!-- 修正申請モーダル -->
    <div id="modal" class="modal">
      <div class="modal-content">
        <h3>打刻時間修正申請</h3>

        <label>修正対象日</label>
        <input type="date" id="reqDate" onchange="loadCurrentRecord()">

        <div class="current-record" id="currentRecord">
          現在の記録:<br>出勤: --:--　退勤: --:--<br>休憩開始: --:--　休憩終了: --:--
        </div>

        <label>修正後の時刻</label>
        <div class="time-grid">
          <div><small>出勤</small><input type="time" id="newClockIn"></div>
          <div><small>退勤</small><input type="time" id="newClockOut"></div>
          <div><small>休憩開始</small><input type="time" id="newBreakStart"></div>
          <div><small>休憩終了</small><input type="time" id="newBreakEnd"></div>
        </div>

        <label>修正理由</label>
        <textarea id="reqMessage" placeholder="打刻を忘れた、誤って打刻した等の理由を記載してください"></textarea>

        <div class="btn-row">
          <button class="btn-cancel" onclick="closeModal()">キャンセル</button>
          <button class="btn-send" onclick="submitFix()">申請</button>
        </div>
      </div>
    </div>

    <script>
      let userId, name, allRecords = [], allRequests = [];

      async function main() {
        await liff.init({ liffId: "${storeConf.liffId}" });
        if (!liff.isLoggedIn()) return liff.login();
        const p = await liff.getProfile();
        userId = p.userId;
        name = p.displayName;
        await loadRecords();
        await loadRequests();
      }

      async function loadRecords() {
        const now = new Date();
        const ym = now.toISOString().slice(0, 7);
        const res = await fetch("/${store}/attendance/records?userId=" + userId + "&month=" + ym);
        allRecords = await res.json();
      }

      async function loadRequests() {
        const res = await fetch("/${store}/attendance/requests?userId=" + userId);
        allRequests = await res.json();
        renderRequestTable();
      }

      function renderRequestTable() {
        const tbody = document.getElementById("requestBody");
        if (!allRequests.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="empty">申請はありません</td></tr>';
          return;
        }

        tbody.innerHTML = allRequests.map(function(r) {
          const before = r.before || {};
          const after = r.after || {};

          return (
            '<tr>' +
              '<td>' +
                '出勤: ' + (before.clockIn || "--:--") + ' → <span class="new-time">' + (after.clockIn || "--:--") + '</span><br/>' +
                '退勤: ' + (before.clockOut || "--:--") + ' → <span class="new-time">' + (after.clockOut || "--:--") + '</span><br/>' +
                '休憩開始: ' + (before.breakStart || "--:--") + ' → <span class="new-time">' + (after.breakStart || "--:--") + '</span><br/>' +
                '休憩終了: ' + (before.breakEnd || "--:--") + ' → <span class="new-time">' + (after.breakEnd || "--:--") + '</span>' +
              '</td>' +
              '<td>' + (r.message || "") + '</td>' +
              '<td><span class="status waiting">承認待ち</span></td>' +
            '</tr>'
          );
        }).join("");
      }

      document.getElementById("btnNew").onclick = () => {
        document.getElementById("modal").style.display = "flex";
      };

      function closeModal() {
        document.getElementById("modal").style.display = "none";
      }

      function loadCurrentRecord() {
        const date = document.getElementById("reqDate").value;
        const record = allRecords.find(r => r.date === date);
        const currentRecord = document.getElementById("currentRecord");

        if (record) {
          currentRecord.innerHTML = 
            "現在の記録:<br>" +
            "出勤: " + (record.clockIn || "--:--") + "　退勤: " + (record.clockOut || "--:--") + "<br>" +
            "休憩開始: " + (record.breakStart || "--:--") + "　休憩終了: " + (record.breakEnd || "--:--");
        } else {
          currentRecord.innerHTML = "現在の記録:<br>出勤: --:--　退勤: --:--<br>休憩開始: --:--　休憩終了: --:--";
        }
      }

      async function submitFix() {
        const date = document.getElementById("reqDate").value;
        const message = document.getElementById("reqMessage").value;
        const newData = {
          clockIn: document.getElementById("newClockIn").value,
          clockOut: document.getElementById("newClockOut").value,
          breakStart: document.getElementById("newBreakStart").value,
          breakEnd: document.getElementById("newBreakEnd").value
        };
        if (!date || !message) return alert("日付と理由を入力してください。");

        const before = allRecords.find(r => r.date === date) || {};
        const payload = { userId, name, date, message, before, after: newData };

        await fetch("/${store}/attendance/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        // ローカルにも即反映
        allRequests.unshift({ before, after: newData, message, status: "承認待ち" });
        renderRequestTable();
        closeModal();
      }

      main();
    </script>
  </body>
  </html>
  `);
});

// 🔍 スタッフ検索API（初期表示＋フィルタ対応）
app.get("/:store/admin/search-staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { keyword = "" } = req.query;

  try {
    const snap = await db.collection("companies").doc(store)
      .collection("permissions")
      .get();

    const result = snap.docs
      .map(doc => ({
        id: doc.id,
        name: doc.data().name || "未登録",
        approved: doc.data().approved || false
      }))
      .filter(s => s.name.includes(keyword));

    res.json(result);
  } catch (err) {
    console.error("❌ search-staff error:", err);
    res.status(500).json({ error: "検索に失敗しました。" });
  }
});

// ✅ 承認/解除 更新API
app.post("/:store/admin/update-staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, approve } = req.body;
  try {
    await db.collection("companies").doc(store)
      .collection("permissions").doc(userId)
      .update({ approved: approve });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ update-staff error:", err);
    res.status(500).json({ error: "更新に失敗しました。" });
  }
});

// 🗑 スタッフ削除API
app.post("/:store/admin/delete-staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.body;
  try {
    await db.collection("companies").doc(store)
      .collection("permissions").doc(userId).delete();
    res.json({ success: true });
  } catch (err) {
    console.error("❌ delete-staff error:", err);
    res.status(500).json({ error: "削除に失敗しました。" });
  }
});



// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
