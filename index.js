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

// ==============================
// 🧑‍💼 管理者画面（権限管理・名前リアルタイム検索）
// ==============================
app.get("/:store/admin", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  const snapshot = await db
    .collection("companies")
    .doc(store)
    .collection("permissions")
    .get();

  const users = snapshot.docs.map(d => ({
    id: d.id,
    name: d.data().name || "（未入力）",
    approved: d.data().approved,
  }));

  res.send(`
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; background:#f9fafb; margin:0; padding:20px; }
    h1 { color:#2563eb; margin-bottom:8px; text-align:center; }
    .top-bar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
    .search-box { flex:1; display:flex; justify-content:center; margin-top:10px; }
    input[type="text"] {
      padding:8px; border:1px solid #ccc; border-radius:6px; width:90%; max-width:280px;
    }
    table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; }
    th,td { padding:10px; border-bottom:1px solid #eee; text-align:left; }
    th { background:#2563eb; color:white; font-weight:500; }
    tr:hover { background:#f3f4f6; }
    button {
      background:#2563eb; color:white; border:none; padding:6px 10px;
      border-radius:4px; cursor:pointer; font-size:13px;
    }
    button:hover { background:#1d4ed8; }
    .link-btn { text-decoration:none; color:#2563eb; font-size:14px; margin-left:8px; }
    @media(max-width:600px){
      table,thead,tbody,tr,th,td{display:block;}
      th{display:none;}
      tr{margin-bottom:10px; background:white; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1);}
      td{display:flex; justify-content:space-between; padding:8px;}
      td::before{content:attr(data-label); font-weight:bold; color:#555;}
    }
  </style>
  </head><body>
    <h1>${store} 権限管理</h1>
    <div class="top-bar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="名前で検索...">
      </div>
      <div>
        <a href="/${store}/admin/attendance" class="link-btn">🕒 勤怠管理</a>
        <a href="/logout" class="link-btn">ログアウト</a>
      </div>
    </div>

    <table id="userTable">
      <thead>
        <tr><th>名前</th><th>状態</th><th>操作</th></tr>
      </thead>
      <tbody id="userBody"></tbody>
    </table>

    <script>
      const users = ${JSON.stringify(users)};
      const tbody = document.getElementById("userBody");
      const input = document.getElementById("searchInput");

      function render(list){
        tbody.innerHTML = list.map(u => \`
          <tr>
            <td data-label="名前">\${u.name}</td>
            <td data-label="状態">\${u.approved ? "✅ 承認済み" : "⏳ 未承認"}</td>
            <td data-label="操作">
              <form method="POST" action="/${store}/approve" style="display:inline">
                <input type="hidden" name="id" value="\${u.id}">
                <button>承認</button>
              </form>
              <form method="POST" action="/${store}/revoke" style="display:inline">
                <input type="hidden" name="id" value="\${u.id}">
                <button style="background:#dc2626;">解除</button>
              </form>
            </td>
          </tr>\`).join("");
      }

      input.addEventListener("input", e=>{
        const keyword = e.target.value.trim().toLowerCase();
        const filtered = keyword
          ? users.filter(u => (u.name || "").toLowerCase().includes(keyword))
          : users;
        render(filtered);
      });

      render(users);
    </script>
  </body></html>
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
// 🕒 従業員用：勤怠打刻 + 月別一覧
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
      body {
        font-family: sans-serif;
        background: #f9fafb;
        padding: 16px;
      }
      .card {
        background: #fff;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        max-width: 520px;
        margin: 0 auto;
      }
      h1 {
        font-size: 1.2rem;
        text-align: center;
        margin-bottom: 12px;
        color: #111827;
      }
      #status {
        text-align:center;
        margin-bottom: 12px;
        color:#4b5563;
        font-size: .9rem;
      }

      .today-box {
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 16px;
      }
      .today-title {
        font-size: .9rem;
        margin-bottom: 8px;
        color:#374151;
      }
      .grid-2x2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .action-card {
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 10px;
        text-align: center;
        background: #fff;
      }
      .action-title {
        font-size: .9rem;
        margin-bottom: 4px;
        color:#111827;
      }
      .action-time {
        font-size: .9rem;
        color:#6b7280;
        min-height: 1.2em;
      }
      .action-btn {
        margin-top: 6px;
        width: 100%;
        padding: 8px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: .9rem;
        color: #fff;
      }
      .btn-in { background:#16a34a; }
      .btn-out { background:#dc2626; }
      .btn-break-start { background:#6b7280; }
      .btn-break-end { background:#2563eb; }
      .action-btn:disabled {
        opacity:.4;
        cursor:default;
      }

      .month-row {
        display:flex;
        align-items:center;
        gap:8px;
        margin-top: 8px;
        margin-bottom: 4px;
        font-size: .9rem;
      }
      .month-row label {
        white-space:nowrap;
        color:#4b5563;
      }
      .month-row input[type="month"] {
        flex:1;
        padding:6px;
        border-radius:6px;
        border:1px solid #d1d5db;
      }

      .table-wrapper {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        margin-top: 8px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: white;
        font-size: 0.8rem;
        min-width: 640px;
      }
      th, td {
        border: 1px solid #e5e7eb;
        padding: 6px;
        text-align: center;
        white-space: nowrap;
      }
      th {
        background: #2563eb;
        color: white;
        position: sticky;
        top: 0;
      }
      tr:nth-child(even) {
        background: #f9fafb;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${store} 勤怠管理</h1>
      <div id="status">LINEログイン中...</div>

      <!-- 今日の打刻 -->
      <div class="today-box">
        <div class="today-title" id="todayLabel">今日の打刻</div>
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
      </div>

      <!-- 対象月選択 -->
      <div class="month-row">
        <label for="monthSelect">対象月</label>
        <input type="month" id="monthSelect">
      </div>

      <!-- 勤怠一覧 -->
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>日付</th>
              <th>出勤</th>
              <th>退勤</th>
              <th>休憩開始</th>
              <th>休憩終了</th>
            </tr>
          </thead>
          <tbody id="recordsBody"></tbody>
        </table>
      </div>
    </div>

    <script>
      let userId, name;
      // 今日の状態を保持（ボタン制御 & 時刻表示に利用）
      let currentState = {
        date: null,
        clockIn: null,
        clockOut: null,
        breakStart: null,
        breakEnd: null,
      };

      function getTodayDateKey() {
        // JSTの今日を "YYYY-M-D" 形式で取得（Firestoreの date と合わせる）
        const now = new Date();
        const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const y = jst.getFullYear();
        const m = jst.getMonth() + 1;
        const d = jst.getDate();
        return y + "-" + m + "-" + d;
      }

      function timeLabelFromFull(full) {
        // "YYYY/MM/DD HH:MM:SS" → "HH:MM"
        if (!full) return "--:--";
        const parts = full.split(" ");
        if (parts.length < 2) return "--:--";
        return parts[1].slice(0,5);
      }

      function applyStateToButtonsAndLabels() {
        // ボタン有効/無効
        document.getElementById("btnIn").disabled = !!currentState.clockIn;
        document.getElementById("btnBreakStart").disabled = !currentState.clockIn || !!currentState.breakStart;
        document.getElementById("btnBreakEnd").disabled = !currentState.breakStart || !!currentState.breakEnd;
        document.getElementById("btnOut").disabled = !currentState.clockIn || !!currentState.clockOut;

        // ラベル（--:-- or HH:MM）
        document.getElementById("timeIn").innerText = timeLabelFromFull(currentState.clockIn);
        document.getElementById("timeBreakStart").innerText = timeLabelFromFull(currentState.breakStart);
        document.getElementById("timeBreakEnd").innerText = timeLabelFromFull(currentState.breakEnd);
        document.getElementById("timeOut").innerText = timeLabelFromFull(currentState.clockOut);
      }

      async function main() {
        try {
          await liff.init({ liffId: "${storeConf.liffId}" });
          if (!liff.isLoggedIn()) return liff.login();

          const p = await liff.getProfile();
          userId = p.userId;
          name = p.displayName;

          // ✅ DOMがロードされてから代入
          const statusEl = document.getElementById("status");
          if (statusEl) {
            statusEl.innerText = name + " さんログイン中";
          } else {
            console.warn("status 要素が見つかりませんでした。");
          }

          initMonthSelector();
          await loadRecords();
        } catch (e) {
          console.error(e);
          document.getElementById("status").innerText = "LIFF初期化に失敗しました: " + e.message;
        }
      }

      function initMonthSelector() {
        const monthInput = document.getElementById("monthSelect");

        // ✅ JST時間に変換
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC → JST

        // ✅ yyyy-MM 形式を抽出
        const ym = jst.toISOString().slice(0, 7); // 例: "2025-11"

        monthInput.value = ym;
        monthInput.addEventListener("change", loadRecords);
      }

      // 送信共通処理
      async function sendAction(action) {
        if (!userId) {
          alert("LINEログイン情報が取得できていません。");
          return;
        }
        const res = await fetch("/${store}/attendance/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, name, action }),
        });
        const msg = await res.text();
        alert(msg);

        // JST現在時刻をボタン下に即反映させる
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const dateStr = jst.toLocaleDateString("ja-JP");
        const timeStr = jst.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const fullStr = dateStr + " " + timeStr;

        const todayKey = getTodayDateKey();
        currentState.date = todayKey;

        if (action === "clockIn") currentState.clockIn = fullStr;
        if (action === "breakStart") currentState.breakStart = fullStr;
        if (action === "breakEnd") currentState.breakEnd = fullStr;
        if (action === "clockOut") currentState.clockOut = fullStr;

        applyStateToButtonsAndLabels();
        await loadRecords(); // 一覧も更新
      }

      document.addEventListener("click", function(e){
        if(e.target.id === "btnIn") sendAction("clockIn");
        if(e.target.id === "btnBreakStart") sendAction("breakStart");
        if(e.target.id === "btnBreakEnd") sendAction("breakEnd");
        if(e.target.id === "btnOut") sendAction("clockOut");
      });

      async function loadRecords() {
        if (!userId) return;
        const month = document.getElementById("monthSelect").value;
        const res = await fetch("/${store}/attendance/records?userId=" + encodeURIComponent(userId) + "&month=" + encodeURIComponent(month));
        const data = await res.json();

        // 一覧表示（サーバー側は JST で "YYYY/MM/DD HH:MM:SS" を返す想定）
        const tbody = document.getElementById("recordsBody");
        tbody.innerHTML = data.map(function(r){
          return "<tr>"
            + "<td>" + (r.date || "-") + "</td>"
            + "<td>" + (r.clockIn || "-") + "</td>"
            + "<td>" + (r.clockOut || "-") + "</td>"
            + "<td>" + (r.breakStart || "-") + "</td>"
            + "<td>" + (r.breakEnd || "-") + "</td>"
            + "</tr>";
        }).join("");

        // 今日のレコードがあれば currentState に反映
        const today = new Date().toISOString().split("T")[0];
        // 今日の日付キー（例: "2025-11-07"）
        const todayKey = getTodayDateKey();

        // Firestoreのdateが「/」区切りでも対応
        const todayData = data.find(r => r.date.replace(/\//g, "-") === todayKey);

        if (todayData) {
          document.getElementById("inTime").innerText = todayData?.clockIn?.split(" ")[1]?.slice(0,5) || "--:--";
          document.getElementById("outTime").innerText = todayData?.clockOut?.split(" ")[1]?.slice(0,5) || "--:--";
          document.getElementById("breakStartTime").innerText = todayData?.breakStart?.split(" ")[1]?.slice(0,5) || "--:--";
          document.getElementById("breakEndTime").innerText = todayData?.breakEnd?.split(" ")[1]?.slice(0,5) || "--:--";
        }
        else {
          currentState = {
            date: todayKey,
            clockIn: null,
            clockOut: null,
            breakStart: null,
            breakEnd: null,
          };
        }
        applyStateToButtonsAndLabels();
      }

      main();
    </script>
  </body>
  </html>
  `);
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
// 📅 勤怠打刻（JST対応版）
app.post("/:store/attendance/submit", ensureStore, async (req, res) => {
  const { store } = req;
  const { userId, name, action } = req.body;

  if (!userId || !name || !action) {
    return res.status(400).send("パラメータ不足です。");
  }

  try {
    // ① まず「今この瞬間」の絶対時刻（UTCベース）だけを取る
    const now = new Date();

    // ② JSTの日付文字列だけが欲しいので、
    //    9時間足した「JST相当」のDateから YYYY-MM-DD を作る
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const currentDate = jstNow.toISOString().split("T")[0]; // 例: "2025-11-06"

    // ③ Firestoreの保存先: /companies/{store}/attendance/{userId}/days/{currentDate}
    const ref = db.collection("companies").doc(store)
      .collection("attendance")
      .doc(userId)
      .collection("days")
      .doc(currentDate);

    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};

    const updated = {
      ...data,
      name,
      userId,
      date: currentDate,
    };

    // ④ 二重打刻チェック（今までのロジックそのままでOK）
    if (action === "clockIn" && updated.clockIn) {
      return res.status(400).send("すでに出勤打刻されています。");
    }
    if (action === "clockOut" && updated.clockOut) {
      return res.status(400).send("すでに退勤打刻されています。");
    }
    if (action === "breakStart" && updated.breakStart && !updated.breakEnd) {
      return res.status(400).send("すでに休憩開始済みです。");
    }
    if (action === "breakEnd" && updated.breakEnd) {
      return res.status(400).send("すでに休憩終了済みです。");
    }

    // ⑤ ここが一番大事：
    //    Firestoreには UTC の「now」をそのまま Timestamp として保存する
    const ts = admin.firestore.Timestamp.fromDate(now);
    updated[action] = ts;

    await ref.set(updated, { merge: true });

    res.send(`「${action}」を記録しました。`);
  } catch (e) {
    console.error("勤怠保存エラー:", e);
    res.status(500).send("勤怠保存中にエラーが発生しました。");
  }
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
      button { padding:6px 12px; border:none; border-radius:6px; cursor:pointer; color:white; }
      .blue { background:#2563eb; }
      .green { background:#16a34a; }
      .red { background:#dc2626; }
      table { width:100%; border-collapse:collapse; margin-top:12px; background:white; border-radius:8px; overflow:hidden; }
      th,td { padding:8px; border-bottom:1px solid #eee; text-align:center; font-size:14px; white-space:nowrap; }
      th { background:#2563eb; color:white; }
      .summary { text-align:right; margin-top:10px; }
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; padding:20px; border-radius:8px; max-width:320px; width:90%; }
      .table-wrapper { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      @media(max-width:600px){
        table,thead,tbody,tr,th,td{display:block;}
        th{display:none;}
        tr{margin-bottom:8px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.1);}
        td{display:flex; justify-content:space-between; padding:6px;}
        td::before{content:attr(data-label); font-weight:bold; color:#555;}
      }
    </style>
  </head>
  <body>
    <h1>${store} 勤怠管理</h1>

    <div>
      <label>対象月：</label>
      <input type="month" id="monthSelect">
      <label>スタッフ：</label>
      <select id="staffSelect"></select>
      <button class="blue" onclick="loadRecords()">表示</button>
    </div>

    <div class="summary" id="summary"></div>

    <div class="table-wrapper">
      <table id="records">
        <thead>
          <tr>
            <th>日付</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>休憩開始</th>
            <th>休憩終了</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- 修正モーダル -->
    <div id="modal" class="modal">
      <div class="modal-content">
        <h3>時刻修正</h3>
        <input type="hidden" id="editDate">
        出勤:<input type="time" id="editIn"><br>
        休憩開始:<input type="time" id="editBreakStart"><br>
        休憩終了:<input type="time" id="editBreakEnd"><br>
        退勤:<input type="time" id="editOut"><br>
        <button class="green" onclick="saveEdit()">更新</button>
        <button class="red" onclick="closeModal()">閉じる</button>
      </div>
    </div>

    <script>
      const store = "${store}";
      let records = [];

      async function init() {
        const now = new Date();
        const monthInput = document.getElementById("monthSelect");
        const ym = now.toISOString().slice(0, 7);
        monthInput.value = ym;
        await loadStaff();
      }

      async function loadStaff() {
        const res = await fetch("/${store}/admin/staff");
        const staff = await res.json();
        const sel = document.getElementById("staffSelect");
        staff.forEach(s=>{
          const opt = document.createElement("option");
          opt.value = s.id;
          opt.text = s.name;
          sel.appendChild(opt);
        });
      }

      function formatDateTime(ts) {
        if (!ts) return "";
        const d = ts.seconds
          ? new Date(ts.seconds * 1000)
          : new Date(ts); // どちらでも対応
        return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      }


      async function loadRecords(){
        const userId = document.getElementById("staffSelect").value;
        const month = document.getElementById("monthSelect").value;
        if(!userId) return alert("スタッフを選択してください。");

        const res = await fetch("/${store}/admin/attendance/records?userId="+userId+"&month="+month);
        records = await res.json();

        const tbody = document.querySelector("#records tbody");
        if(records.length===0){
          tbody.innerHTML = "<tr><td colspan='6'>該当データなし</td></tr>";
          document.getElementById("summary").innerText="";
          return;
        }

        tbody.innerHTML = records.map(r=>\`
          <tr>
            <td data-label="日付">\${r.date}</td>
            <td data-label="出勤">\${r.clockIn?formatDateTime(r.clockIn):"-"}</td>
            <td data-label="退勤">\${r.clockOut?formatDateTime(r.clockOut):"-"}</td>
            <td data-label="休憩開始">\${r.breakStart?formatDateTime(r.breakStart):"-"}</td>
            <td data-label="休憩終了">\${r.breakEnd?formatDateTime(r.breakEnd):"-"}</td>
            <td data-label="操作"><button class='blue' onclick='openModal("\${r.date}")'>修正</button></td>
          </tr>\`).join("");

        const worked = records.filter(r=>r.clockIn && r.clockOut);
        document.getElementById("summary").innerText = "総勤務日数: "+worked.length+"日";
      }

      function openModal(date){
        const r = records.find(x=>x.date===date);
        document.getElementById("editDate").value = date;
        document.getElementById("editIn").value = r.clockInTime || "";
        document.getElementById("editBreakStart").value = r.breakStartTime || "";
        document.getElementById("editBreakEnd").value = r.breakEndTime || "";
        document.getElementById("editOut").value = r.clockOutTime || "";
        document.getElementById("modal").style.display="flex";
      }

      function closeModal(){ document.getElementById("modal").style.display="none"; }

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

// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
