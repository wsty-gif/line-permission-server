require("dotenv").config();
const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");
const session = require("express-session");
// ファイル先頭付近に追記
const { Parser } = require('json2csv');

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
      .btn-edit {
        background:#3b82f6;
        color:white;
        border:none;
        padding:4px 6px;
        border-radius:4px;
        cursor:pointer;
      }
      .btn-edit:hover { background:#2563eb; }
    </style>

  </head>
  <body>
    <h1>${store} 管理画面</h1>

    <!-- ✅ ボタン群 -->
    <div class="nav">
      <a href="/${store}/admin/attendance">勤怠管理</a>
      <a href="/${store}/admin/fix">打刻修正依頼</a>
      <a href="/${store}/admin/settings">店舗設定</a>
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

      function editStaff(userId) {
        window.location.href = "/" + store + "/admin/staff/" + userId + "/edit";
      }

      function renderTable(data) {
        const tbody = document.getElementById("staffBody");
        if (!data.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">該当するスタッフがいません</td></tr>';
          return;
        }

      tbody.innerHTML = data.map(s => {
        return (
          '<tr>' +
            '<td onclick="viewAttendance(&quot;' + s.id + '&quot;)">' + s.name + '</td>' +
            '<td>' + (s.approved ? "✅ 承認済み" : "⏳ 承認待ち") + '</td>' +
            '<td><button class="btn-approve" onclick="event.stopPropagation(); updateStatus(&quot;' + s.id + '&quot;, true)">承認</button></td>' +
            '<td><button class="btn-revoke" onclick="event.stopPropagation(); updateStatus(&quot;' + s.id + '&quot;, false)">解除</button></td>' +
            '<td><button class="btn-delete" onclick="event.stopPropagation(); deleteStaff(&quot;' + s.id + '&quot;)">削除</button></td>' +
          '</tr>'
        );
      }).join("");

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

app.get("/:store/admin/staff/:userId/edit", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params } = req;
  const userId = params.userId;

  const doc = await db.collection("companies").doc(store)
    .collection("permissions").doc(userId).get();

  const data = doc.data() || {};

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>スタッフ編集</title>
      <style>
        body { font-family:sans-serif; padding:20px; background:#f9fafb; }
        .box { background:white; padding:20px; border-radius:10px; max-width:400px; margin:auto; }
        input, select { width:100%; padding:8px; margin:8px 0; border:1px solid #ccc; border-radius:6px; }
        button { padding:10px; width:100%; border:none; background:#2563eb; color:white; border-radius:6px; font-size:1rem; cursor:pointer; }
        button:hover { background:#1d4ed8; }
      </style>
    </head>
    <body>
      <h2>スタッフ情報編集</h2>

      <div class="box">
        <form method="POST" action="/${store}/admin/staff/${userId}/edit">
          <label>雇用区分</label>
          <select name="employmentType">
            <option value="アルバイト" ${data.employmentType==="アルバイト"?"selected":""}>アルバイト</option>
            <option value="パート" ${data.employmentType==="パート"?"selected":""}>パート</option>
            <option value="正社員" ${data.employmentType==="正社員"?"selected":""}>正社員</option>
          </select>

          <label>基本時給</label>
          <input type="number" name="hourlyWage" value="${data.hourlyWage || ""}" required>

          <label>深夜時給</label>
          <input type="number" name="nightWage" value="${data.nightWage || ""}">

          <label>交通費（1日）</label>
          <input type="number" name="transport" value="${data.transport || ""}">

          <button>保存する</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post("/:store/admin/staff/:userId/edit", ensureStore, async (req, res) => {
  const { store, params, body } = req;
  const userId = params.userId;

  await db.collection("companies").doc(store)
    .collection("permissions").doc(userId)
    .set({
      employmentType: body.employmentType,
      hourlyWage: Number(body.hourlyWage),
      nightWage: Number(body.nightWage),
      transport: Number(body.transport)
    }, { merge:true });

  res.send(`
    <html><body style="text-align:center;padding-top:40px;font-family:sans-serif;">
      <h3>保存しました</h3>
      <a href="/${store}/admin">← 管理画面へ戻る</a>
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
      document.addEventListener("DOMContentLoaded", async () => {
        try {
          await liff.init({ liffId: "${storeConf.liffId}" });

          // ✅ 未ログインならログイン処理（redirectUri指定しない）
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }

          // ✅ ログイン済みならフォームをそのまま表示し、userIdをセット
          const profile = await liff.getProfile();
          document.getElementById("userId").value = profile.userId;
          document.getElementById("name").focus();
        } catch (err) {
          console.error("LIFF初期化エラー:", err);
          document.body.innerHTML =
            "<h3>LIFF初期化に失敗しました。<br>" + err.message + "</h3>";
        }
      });
    </script>
  </body>
  </html>`);
});

app.post("/:store/apply/submit", ensureStore, async (req, res) => {
  const { store, lineClient, storeConf } = req;
  const { userId, name } = req.body;

  if (!userId || !name)
    return res.status(400).send("名前またはLINE情報が取得できませんでした。");

  try {
    await db.collection("companies").doc(store).collection("permissions").doc(userId)
      .set({ name, approved: false, requestedAt: new Date() }, { merge: true });

    // 🔹 申請直後に BEFORE メニューを設定
    if (storeConf.richmenuBefore) {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
    }

    res.send(`
    <html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body{font-family:sans-serif;text-align:center;padding-top:30vh;}h2{color:#16a34a;}</style></head>
    <body><h2>申請を受け付けました！</h2><p>管理者の承認をお待ちください。</p></body></html>`);
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
      .btn-fix {
        display: block;
        width: 100%;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 14px;
        font-size: 1rem;
        font-weight: bold;
        text-align: center;
        margin-top: 20px;
        cursor: pointer;
        transition: background 0.2s, transform 0.1s;
      }
      .btn-fix:hover {
        background: #1e40af;
        transform: translateY(-2px);
      }
      .btn-fix:active {
        background: #1d4ed8;
        transform: translateY(0);
      }

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

      <button id="btnFix" class="btn-fix">打刻修正を申請する</button>

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

        <label>修正後の日付・時間</label>
        <div class="time-grid">
          <div>
            <input type="date" id="newDateIn" placeholder="出勤日" />
            <input type="time" id="newClockIn" placeholder="出勤" />
          </div>
          <div>
            <input type="date" id="newDateOut" placeholder="退勤日" />
            <input type="time" id="newClockOut" placeholder="退勤" />
          </div>
          <div>
            <input type="date" id="newDateBreakStart" placeholder="休憩開始日" />
            <input type="time" id="newBreakStart" placeholder="休憩開始" />
          </div>
          <div>
            <input type="date" id="newDateBreakEnd" placeholder="休憩終了日" />
            <input type="time" id="newBreakEnd" placeholder="休憩終了" />
          </div>
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
        try {
          await liff.init({ liffId: "${storeConf.liffId}" });

          // ✅ location.pathname が /manual の場合のみ manual処理に進む
          if (location.pathname.includes("/manual")) return;

          if (!liff.isLoggedIn()) {
            // ✅ manualではない画面のみでログイン誘導
            liff.login({ redirectUri: location.href });
            return;
          }

          const p = await liff.getProfile();
          userId = p.userId;
          name = p.displayName;
          document.getElementById("status").innerText = name + " さんログイン中";

          initMonthSelector();
          await loadRecords();
        } catch (e) {
          console.error("LIFF初期化エラー:", e);
          document.getElementById("status").innerText = "ログインエラーが発生しました";
        }
      }

      function timeOnly(str){ if(!str)return "--:--"; const p=String(str).split(" "); return p.length>1?p[1].slice(0,5):str.slice(-5); }
      function getTodayKey(){ const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); return jst.toISOString().slice(0,10); }
      function initMonthSelector(){ const m=document.getElementById("monthSelect"); const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); m.value=jst.toISOString().slice(0,7); m.addEventListener("change",loadRecords); }

      async function sendAction(action, skipReload = false) {
        let message = "";

        switch (action) {
          case "clockIn":
            message = "出勤を記録しました。";
            break;
          case "clockOut":
            message = "退勤を記録しました。";
            break;
          case "breakStart":
            message = "休憩を開始しました。";
            break;
          case "breakEnd":
            message = "休憩を終了しました。";
            break;
          default:
            message = "打刻を記録しました。";
        }

        try {
          const res = await fetch("/${store}/attendance/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, name, action })
          });

          const text = await res.text();
          console.log("送信結果:", text);

          if (text.includes("打刻を記録しました")) {
            showToast(message); // ✅ 上中央に表示
          } else {
            showToast("エラー: " + text);
          }

          if (!skipReload) loadRecords();

        } catch (error) {
          console.error(error);
          showToast("通信エラーが発生しました。");
        }
      }

      document.addEventListener("DOMContentLoaded", () => {


        const btnFix = document.getElementById("btnFix");
        if (btnFix) {
          btnFix.onclick = () => {
            window.location.href = "/${store}/attendance/fix";
          };
        }

        document.getElementById("btnIn").onclick = () => sendAction("clockIn");
        // 退勤ボタン押下
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

      async function submitRequest() {
        const date = document.getElementById("reqDate").value;
        const msg = document.getElementById("reqMessage").value;
        const newData = {
          clockIn: document.getElementById("newClockIn").value,
          clockOut: document.getElementById("newClockOut").value,
          breakStart: document.getElementById("newBreakStart").value,
          breakEnd: document.getElementById("newBreakEnd").value
        };

        if (!date || !msg) {
          alert("対象日と理由を入力してください。");
          return;
        }

        await fetch("/${store}/attendance/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            name,
            date,
            message: msg,
            after: newData,
          }),
        });

        alert("修正申請を送信しました。");
        closeModal();

        // 🔹 Firestoreから最新ステータスを再取得して反映
        await loadRequests();
      }

      async function loadRecords() {
        const month = document.getElementById("monthSelect").value;
        const res = await fetch("/${store}/attendance/records?userId=" + userId + "&month=" + month);
        const data = await res.json();
        allRecords = data;

        // テーブル描画
        const tbody = document.getElementById("recordsBody");
        tbody.innerHTML = data.map(r =>
          "<tr><td>" + (r.date || "--") + "</td><td>" +
          (r.clockIn || "--:--") + "</td><td>" +
          (r.clockOut || "--:--") + "</td><td>" +
          (r.breakStart || "--:--") + "</td><td>" +
          (r.breakEnd || "--:--") + "</td></tr>"
        ).join("");

        const today = getTodayKey();
        const todayData = data.find(r => r.date === today);
        const latestRecord = data[data.length - 1]; // 一番新しい勤務

        // 🔹 まだ退勤していない勤務がある場合
        if (latestRecord && !latestRecord.clockOut) {
          // 出勤ボタンは押せない・退勤ボタンだけ押せる
          document.getElementById("btnIn").disabled = true;
          document.getElementById("btnOut").disabled = false;

          // ボタン内の時刻は「未退勤のその勤務」の内容を表示
          document.getElementById("timeIn").innerText         = timeOnly(latestRecord.clockIn);
          document.getElementById("timeBreakStart").innerText = timeOnly(latestRecord.breakStart);
          document.getElementById("timeBreakEnd").innerText   = timeOnly(latestRecord.breakEnd);
          document.getElementById("timeOut").innerText        = "--:--";
        } else {
          // 🔹 すべて退勤済み or まだ一度も出勤していない → 通常状態
          document.getElementById("btnIn").disabled = false;
          document.getElementById("btnOut").disabled = true;

          // 今日分のデータだけ反映（なければ "--:--"）
          document.getElementById("timeIn").innerText         = timeOnly(todayData?.clockIn);
          document.getElementById("timeOut").innerText        = timeOnly(todayData?.clockOut);
          document.getElementById("timeBreakStart").innerText = timeOnly(todayData?.breakStart);
          document.getElementById("timeBreakEnd").innerText   = timeOnly(todayData?.breakEnd);
        }
      }

      function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.style.display = "block";

        // 少しフェードイン効果
        toast.style.transition = "opacity 0.3s ease";
        toast.style.opacity = "1";

        // 3秒後にフェードアウト
        setTimeout(() => {
          toast.style.transition = "opacity 0.5s ease";
          toast.style.opacity = "0";
          setTimeout(() => {
            toast.style.display = "none";
          }, 500);
        }, 2500);
      }

      main();
    </script>
    <div id="toast" style="
      display:none;
      position:fixed;
      top:30px;
      left:50%;
      transform:translateX(-50%);
      background:rgba(50,50,50,0.9);
      color:#fff;
      padding:12px 24px;
      border-radius:8px;
      font-size:15px;
      box-shadow:0 3px 10px rgba(0,0,0,0.2);
      z-index:9999;
      opacity:0.9;
      backdrop-filter:blur(4px);
    "></div>

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

app.get("/:store/attendance/requests", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.query;
  if (!userId) return res.status(400).send("userId missing");

  try {
    const snapshot = await db
      .collection(`companies/${store}/attendanceRequests`)
      .where("userId", "==", userId)
      .get();

    const requests = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(requests);
  } catch (err) {
    console.error("attendance/requests Error:", err);
    res.status(500).send("Internal Server Error");
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

app.post("/:store/attendance/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, action } = req.body;

  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jstNow.setSeconds(0, 0);

  const formattedTime = jstNow.getFullYear() + "/" +
    (jstNow.getMonth() + 1) + "/" +
    jstNow.getDate() + " " +
    String(jstNow.getHours()).padStart(2, "0") + ":" +
    String(jstNow.getMinutes()).padStart(2, "0");

  const recordsRef = db.collection("companies").doc(store)
    .collection("attendance").doc(userId)
    .collection("records");

  // 🔹 直近の勤務データを取得
  const snapshot = await recordsRef.orderBy("date", "desc").limit(1).get();
  const latestData = !snapshot.empty ? snapshot.docs[0].data() : null;

  let workDate;

  if (action === "clockOut" && latestData) {
    // ⏰ 前日の出勤データに退勤登録
    workDate = latestData.date;
  } else {
    workDate = jstNow.toISOString().split("T")[0];
  }

  const ref = recordsRef.doc(workDate);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};

  // 🔹 退勤漏れ補正
  if (action === "clockIn" && latestData && !latestData.clockOut) {
    await recordsRef.doc(latestData.date).update({ clockOut: formattedTime });
    console.log(`自動退勤処理: ${latestData.date}`);
  }

  if (action === "clockIn" && data.clockIn) return res.send("すでに出勤済みです。");
  if (action === "breakStart" && (!data.clockIn || data.breakStart)) return res.send("休憩開始は出勤後のみです。");
  if (action === "breakEnd" && (!data.breakStart || data.breakEnd)) return res.send("休憩終了は休憩開始後のみです。");
  if (action === "clockOut" && data.clockOut) return res.send("すでに退勤済みです。");

  if (action === "clockIn") data.clockIn = formattedTime;
  if (action === "breakStart") data.breakStart = formattedTime;
  if (action === "breakEnd") data.breakEnd = formattedTime;
  if (action === "clockOut") data.clockOut = formattedTime;

  data.userId = userId;
  data.name = name;
  data.date = workDate;

  await ref.set(data, { merge: true });

  res.send("打刻を記録しました（日跨ぎ対応＋前日退勤補正）");
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

  <div style="text-align:center; margin-top:24px;">
    <button onclick="location.href='/${store}/admin'" 
      style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
      ← TOPに戻る
    </button>
  </div>

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

      function renderTable(list) {
        const tbody = document.querySelector("#records tbody");

        if (!list.length) {
          tbody.innerHTML = "<tr><td colspan='6'>該当データがありません</td></tr>";
          document.getElementById("summary").textContent = "";
          return;
        }

        // ★ テンプレートリテラルをやめて、文字列連結で HTML を生成
        let html = "";
        list.forEach(function (r) {
          html +=
            "<tr>" +
              "<td>" + (r.date || "") + "</td>" +
              "<td>" + (r.name || "未登録") + "</td>" +
              "<td>" + (r.clockIn || "--:--") + "</td>" +
              "<td>" + (r.clockOut || "--:--") + "</td>" +
              "<td>" + (r.breakStart || "--:--") + "</td>" +
              "<td>" + (r.breakEnd || "--:--") + "</td>" +
            "</tr>";
        });

        tbody.innerHTML = html;

        const workDays = list.filter(function (r) {
          return r.clockIn && r.clockOut;
        }).length;

        document.getElementById("summary").textContent =
          "勤務日数：" + workDays + "日";
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

      async function saveEdit() {
        const id = document.getElementById("editId").value; 
        const [userId, date] = id.split("_"); // ← FirestoreのIDから取得（安全）

        const inT = document.getElementById("editIn").value;
        const outT = document.getElementById("editOut").value;

        if (inT && outT && inT > outT) {
          alert("出勤時間は退勤時間より前にしてください。");
          return;
        }

        const body = {
          userId,
          date,
          clockIn: inT,
          clockOut: outT,
        };

        const res = await fetch("/${store}/admin/attendance/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });   // ← ★ ここの括弧が必要！


        alert(await res.text());
        closeModal();
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
  // もし Timestamp 型なら toDate() を使う
  if (ts && typeof ts.toDate === "function") {
    const date = ts.toDate();
    return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  }

  // もし文字列ならそのまま（例: "2025/11/10 19:05"）
  if (typeof ts === "string") {
    return ts;
  }

  return "--:--";
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

      .top-bar {
        position: sticky;   /* スクロールしても上部に固定 */
        top: 0;
        display: flex;
        justify-content: flex-end;
        background: #f9fafb; /* 背景と同じ色 */
        padding: 8px 0;
        z-index: 100; /* モーダルより上に出るように */
      }
      .btn-back {
        background: #6b7280;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.2s;
      }
      .btn-back:hover {
        background: #4b5563;
      }
    </style>
  </head>
  <body>
    <div class="container">
    <div class="top-bar">
      <button class="btn-back" onclick="history.back()">← 戻る</button>
    </div>
<h1>打刻時間修正申請</h1>
<div id="status" style="text-align:center; margin-bottom:10px; color:#4b5563;"></div>
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

        <label>修正後の日時</label>
        <div class="time-grid">
          <div>
            <label>出勤</label>
            <input type="datetime-local" id="newClockIn" />
          </div>
          <div>
            <label>退勤</label>
            <input type="datetime-local" id="newClockOut" />
          </div>
          <div>
            <label>休憩開始</label>
            <input type="datetime-local" id="newBreakStart" />
          </div>
          <div>
            <label>休憩終了</label>
            <input type="datetime-local" id="newBreakEnd" />
          </div>
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
      let userId, name; // ← 関数の外に宣言（★重要）
      let allRecords = [];
      let allRequests = [];

      async function main() {
        await liff.init({ liffId: "${storeConf.liffId}" });
        if (!liff.isLoggedIn()) return liff.login();

        const profile = await liff.getProfile();
        userId = profile.userId;     // ← constを外し、上のグローバル変数に代入
        name = profile.displayName;

        document.getElementById("status").innerText = name + " さん";
        await loadRecords();
        await loadRequests();        // ← 引数不要（グローバル変数から参照）
      }

      async function loadRecords() {
        const now = new Date();
        const ym = now.toISOString().slice(0, 7);
        const res = await fetch("/${store}/attendance/records?userId=" + userId + "&month=" + ym);
        allRecords = await res.json();
      }

      // 🔹 Firestoreのstatusをリアルタイムで取得するように変更
      // Firestoreから申請データを取得して一覧に反映
      async function loadRequests() {
        if (!userId) {
          console.error("userIdが未定義です。");
          return;
        }

        const res = await fetch("/${store}/attendance/requests?userId=" + encodeURIComponent(userId));
        if (!res.ok) throw new Error("データ取得に失敗しました");
        const data = await res.json();

        allRequests = data.map((r) => ({
          ...r,
          status: r.status || "承認待ち"
        }));

        renderRequestTable();
      }

      function renderRequestTable() {
        const tbody = document.getElementById("requestBody");
        if (!allRequests.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="empty">申請はありません</td></tr>';
          return;
        }

        const formatDateTime = (value) => {
          if (!value) return "--:--";

          // 🔹 before側（例: "2025/11/8 15:42:22" → "2025/11/8 15:42"）
          if (value.includes("/")) {
            // 「:秒」以降を削除（空白やミリ秒があっても対応）
            return value.replace(/:(\d{2})(\.\d+)?\s*$/, "");
          }

          // 🔹 after側（例: "2025-11-08T15:43" → "2025/11/08 15:43"）
          if (value.includes("T")) {
            const [date, time] = value.split("T");
            return date.replace(/-/g, "/") + " " + time.slice(0, 5);
          }

          return value;
        };


        // 🔹 バッククォートではなく通常文字列連結に変更して構文エラー回避
        let html = "";
        allRequests.forEach((r) => {
          const before = r.before || {};
          const after = r.after || {};
          const statusClass =
            r.status === "承認" ? "approved" :
            r.status === "却下" ? "rejected" : "waiting";
          const statusText = r.status || "承認待ち";

          html +=
            "<tr>" +
              "<td>" +
                "出勤: " + formatDateTime(before.clockIn) + " → <span class='new-time'>" + formatDateTime(after.clockIn) + "</span><br/>" +
                "退勤: " + formatDateTime(before.clockOut) + " → <span class='new-time'>" + formatDateTime(after.clockOut) + "</span><br/>" +
                "休憩開始: " + formatDateTime(before.breakStart) + " → <span class='new-time'>" + formatDateTime(after.breakStart) + "</span><br/>" +
                "休憩終了: " + formatDateTime(before.breakEnd) + " → <span class='new-time'>" + formatDateTime(after.breakEnd) + "</span>" +
              "</td>" +
              "<td>" + (r.message || "") + "</td>" +
              "<td><span class='status " + statusClass + "'>" + statusText + "</span></td>" +
            "</tr>";
        });

        tbody.innerHTML = html;
      }

      document.getElementById("btnNew").onclick = () => {
        document.getElementById("modal").style.display = "flex";
        document.querySelector(".top-bar").style.display = "none"; // ← 戻るボタンを隠す
      };

      function closeModal() {
        document.getElementById("modal").style.display = "none";
        document.querySelector(".top-bar").style.display = "flex"; // ← 再表示する
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

// ==============================
// ✅ スタッフ承認・解除API（リッチメニュー切替対応）
// ==============================
app.post("/:store/admin/update-staff", ensureStore, async (req, res) => {
  const { store, lineClient, storeConf } = req;
  const { userId, approve } = req.body;

  try {
    const ref = db.collection("companies").doc(store).collection("permissions").doc(userId);
    await ref.set({ approved: approve }, { merge: true });

    // 🔹 リッチメニュー切り替え処理
    if (approve && storeConf.richmenuAfter) {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuAfter);
      console.log(`✅ ${userId} → AFTERメニューに切り替え`);
      await lineClient.pushMessage(userId, {
        type: "text",
        text: "✅ 管理者により承認されました。メニューが更新されました。",
      });
    } else if (!approve && storeConf.richmenuBefore) {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
      console.log(`↩️ ${userId} → BEFOREメニューに戻しました`);
      await lineClient.pushMessage(userId, {
        type: "text",
        text: "⚠️ 管理者により承認が解除されました。",
      });
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ 承認/解除処理エラー:", err);
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
// 🧾 管理者用 打刻修正依頼一覧ページ（デザイン改良版）
// ==============================
app.get("/:store/admin/fix", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store } = req.params;

  // ✅ クエリで「承認待ちのみ」フラグ取得
  const onlyWaiting = req.query.waiting === "1";

  // Firestoreから修正申請データ取得
  const snap = await db.collection("companies").doc(store)
    .collection("attendanceRequests")
    .orderBy("createdAt", "desc")
    .get();

  const requests = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    createdAt: d.data().createdAt
      ? d.data().createdAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "未記録"
  }));

  // 承認待ち件数カウント
  const waitingCount = requests.filter(r => r.status === "承認待ち").length;

  // ✅ フィルタ済みリスト（承認待ちのみ or 全件）
  const filtered = onlyWaiting
    ? requests.filter(r => r.status === "承認待ち")
    : requests;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${store} 打刻修正依頼</title>
    <style>
      body { font-family: 'Noto Sans JP', sans-serif; background:#f9fafb; margin:0; padding:20px; }
      h1 { color:#2563eb; margin-bottom:6px; }
      .notice { color:#dc2626; margin-bottom:20px; font-size:14px; }

      .container {
        background:white;
        border-radius:12px;
        padding:16px;
        box-shadow:0 2px 6px rgba(0,0,0,0.1);
        overflow-x:auto;
      }

      .header-row {
        display:flex;
        justify-content:space-between;
        align-items:center;
        flex-wrap:wrap;
        margin-bottom:12px;
      }

      .header-row h2 {
        margin:0;
        font-size:16px;
        color:#111827;
      }

      /* 🔹 承認待ちのみ スイッチ */
      .filter-toggle {
        display:flex;
        align-items:center;
        gap:6px;
        font-size:13px;
        color:#374151;
      }
      .filter-toggle input {
        width:40px;
        height:20px;
      }

      button {
        border:none;
        border-radius:6px;
        padding:6px 12px;
        cursor:pointer;
        font-size:13px;
      }

      .btn-approve { background:#16a34a; color:white; }
      .btn-reject { background:#dc2626; color:white; }

      table {
        width:100%;
        border-collapse:collapse;
        min-width:800px;
        font-size:14px;
      }

      th, td {
        padding:10px;
        border-bottom:1px solid #e5e7eb;
        text-align:center;
        vertical-align:middle;
      }

      th {
        background:#f3f4f6;
        color:#374151;
        font-weight:600;
      }

      tr:hover { background:#f9fafb; }

      .status {
        border-radius:12px;
        padding:4px 10px;
        font-size:12px;
        font-weight:600;
        display:inline-block;
      }

      .waiting { background:#fef3c7; color:#92400e; }
      .approved { background:#dcfce7; color:#166534; }
      .rejected { background:#fee2e2; color:#991b1b; }

      .new-time { color:#16a34a; font-weight:bold; }

      @media(max-width:600px){
        th, td { font-size:12px; padding:6px; }
        button { font-size:12px; padding:4px 8px; }
      }
    </style>
  </head>
  <body>
    <div style="text-align:center; margin-bottom:12px;">
      <button onclick="location.href='/${store}/admin'"
        style="background:#6b7280; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer;">
        ← TOPに戻る
      </button>
    </div>

    <h1>打刻時間修正申請</h1>
    <div class="notice">承認待ちの申請が${waitingCount}件あります</div>

    <div class="container">
      <div class="header-row">
        <h2>修正申請一覧</h2>
        <!-- 🔹 承認待ちのみスイッチ -->
        <label class="filter-toggle">
          <input type="checkbox" id="onlyWaiting" ${onlyWaiting ? "checked" : ""} onchange="toggleWaiting()">
          承認待ちのみ
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>申請者</th>
            <th>日付</th>
            <th>修正内容</th>
            <th>理由</th>
            <th>ステータス</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${
            filtered.length
              ? filtered.map(r => `
                <tr>
                  <td>${r.name || "未登録"}<br><small style="color:#dc2626;">${r.status || "承認待ち"}</small></td>
                  <td>${r.date || "-"}</td>
                  <td style="text-align:left;">
                    出勤: ${r.before?.clockIn || "--:--"} → <span class="new-time">${r.after?.clockIn || "--:--"}</span><br>
                    退勤: ${r.before?.clockOut || "--:--"} → <span class="new-time">${r.after?.clockOut || "--:--"}</span><br>
                    休憩開始: ${r.before?.breakStart || "--:--"} → <span class="new-time">${r.after?.breakStart || "--:--"}</span><br>
                    休憩終了: ${r.before?.breakEnd || "--:--"} → <span class="new-time">${r.after?.breakEnd || "--:--"}</span>
                  </td>
                  <td>${r.message || ""}</td>
                  <td>
                    <span class="status ${
                      r.status === "承認" ? "approved" :
                      r.status === "却下" ? "rejected" : "waiting"
                    }">
                      ${r.status || "承認待ち"}
                    </span>
                  </td>
                  <td>
                    <button class="btn-approve" onclick="updateStatus('${r.id}','承認')">✔</button>
                    <button class="btn-reject" onclick="updateStatus('${r.id}','却下')">✖</button>
                  </td>
                </tr>
              `).join("")
              : `<tr><td colspan="6" style="color:#9ca3af;">申請はありません</td></tr>`
          }
        </tbody>
      </table>
    </div>

    <script>
      // 🔹 承認／却下処理（既存と同じ）
      async function updateStatus(id, status) {
        if (!confirm("この申請を" + status + "にしますか？")) return;
        await fetch("/${store}/admin/fix/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status })
        });
        alert("更新しました");
        location.reload();
      }

      // 🔹 「承認待ちのみ」トグル → クエリ付けてリロード
      function toggleWaiting() {
        const cb = document.getElementById("onlyWaiting");
        const url = new URL(location.href);
        if (cb.checked) {
          url.searchParams.set("waiting", "1");
        } else {
          url.searchParams.delete("waiting");
        }
        location.href = url.toString();
      }
    </script>
  </body>
  </html>
  `);
});



app.post("/:store/admin/fix/update", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { id, status } = req.body;

  try {
    await db.collection("companies").doc(store)
      .collection("attendanceRequests").doc(id)
      .update({
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ update fix error:", err);
    res.status(500).json({ error: "更新に失敗しました" });
  }
});

app.post("/:store/admin/attendance/fix/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store) {
    return res.status(403).send("権限がありません。");
  }

  const { store } = req;
  const { requestId } = req.body;

  // ① 修正申請ドキュメント取得
  const reqRef = db.collection("companies")
    .doc(store)
    .collection("attendanceFixRequests")
    .doc(requestId);

  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    return res.status(404).send("修正申請が見つかりません。");
  }

  const reqData = reqSnap.data();

  // ② 勤怠本体（attendance）の該当日のドキュメントを更新する

  const userId = reqData.userId;
  const date = reqData.date; // "2025-11-06" など

  // 勤怠ドキュメントIDは「userId_日付」で保存している前提
  const attendanceId = `${userId}_${date}`;

  const attendanceRef = db.collection("companies")
    .doc(store)
    .collection("attendance")
    .doc(attendanceId);

  const attendanceSnap = await attendanceRef.get();
  const current = attendanceSnap.exists ? attendanceSnap.data() : {
    userId,
    name: reqData.name || "",
    date,
  };

  // after(修正後) から、入力されている項目だけを拾って上書き
  const updatedFields = {};
  const after = reqData.after || {};

  // ★ここは、実際にリクエストに保存しているフィールド名に合わせてください
  if (after.clockIn) {
    updatedFields.clockIn = after.clockIn;           // 例: "2025/11/6 21:00:00"
  }
  if (after.clockOut) {
    updatedFields.clockOut = after.clockOut;
  }
  if (after.breakStart) {
    updatedFields.breakStart = after.breakStart;
  }
  if (after.breakEnd) {
    updatedFields.breakEnd = after.breakEnd;
  }

  // 勤怠データ更新（merge: true で既存フィールドとマージ）
  await attendanceRef.set(
    {
      ...current,
      ...updatedFields,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // ③ 修正申請のステータス更新（承認済み）
  await reqRef.update({
    status: "approved",
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ④ 画面に戻る（必要に応じてURLは調整）
  res.redirect(`/${store}/admin/attendance/fix`);
});

// ==============================
// ⚙️ 店舗設定メニュー（修正版：給与集計ボタン付き）
// ==============================
app.get("/:store/admin/settings", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store) {
    return res.redirect(`/${req.store}/login`);
  }

  const store = req.store;

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 店舗設定メニュー</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:40px; text-align:center; }
      h1 { color:#2563eb; margin-bottom:10px; }
      p  { color:#6b7280; margin-bottom:24px; }
      .wrap { display:flex; flex-direction:column; align-items:center; gap:14px; }
      a.btn {
        display:inline-block; width:280px; padding:12px 0;
        background:#2563eb; color:#fff; border-radius:8px; text-decoration:none;
        transition:background .2s;
      }
      a.btn:hover { background:#1d4ed8; }
      .back { margin-top:24px; }
      .back a { color:#6b7280; text-decoration:none; }
      .back a:hover { text-decoration:underline; }
    </style>
  </head>
  <body>
  <div style="text-align:center; margin-top:24px;">
    <button onclick="location.href='/${store}/admin'" 
      style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
      ← 管理TOPに戻る
    </button>
  </div>
    <h1>店舗設定メニュー</h1>
    <div class="wrap">
      <a class="btn" href="/${store}/admin/settings/general">📋 店舗共通設定</a>
      <a class="btn" href="/${store}/admin/settings/employment">👥 雇用区分別設定</a>
      <a class="btn" href="/${store}/admin/settings/staff">🧑‍💼 従業員個別設定</a>
      <a class="btn" href="/${store}/admin/payroll">💰 給与自動集計</a>
    </div>
  </body></html>`);
});

app.post("/:store/admin/settings", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const settings = {
    regularHours: Number(req.body.regularHours) || 8,
    nightStart: req.body.nightStart || "22:00",
    dateChange: req.body.dateChange || "05:00",
    closingDay: Number(req.body.closingDay) || 25,
    updatedAt: new Date(),
  };
  await db.collection("companies").doc(store)
    .collection("config").doc("settings").set(settings, { merge: true });

  res.redirect(`/${store}/admin/settings`);
});


// ==============================
// 👥 雇用区分別設定画面
// ==============================
app.get("/:store/admin/contract", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snap = await db.collection("companies").doc(store)
    .collection("config").doc("contractSettings").get();
  const data = snap.exists ? snap.data() : {};

  const types = ["fulltime", "parttime", "contract"];
  const labels = { fulltime: "正社員", parttime: "アルバイト", contract: "契約社員" };

  const input = t => {
    const val = data[t] || {};
    return `
      <h3>${labels[t]}</h3>
      <label>基本時給／月給</label>
      <input type="number" step="1" name="${t}_basePay" value="${val.basePay || 0}">
      <label>残業割増率（%）</label>
      <input type="number" name="${t}_overtimeRate" value="${val.overtimeRate || 25}">
      <label>深夜割増率（%）</label>
      <input type="number" name="${t}_nightRate" value="${val.nightRate || 25}">
      <label>休日出勤割増率（%）</label>
      <input type="number" name="${t}_holidayRate" value="${val.holidayRate || 35}">
      <hr style="margin:20px 0;">
    `;
  };

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 雇用区分別設定</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:24px; }
      h1 { color:#2563eb; text-align:center; }
      form { background:#fff; max-width:520px; margin:0 auto; padding:20px; border-radius:10px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
      label { display:block; margin-top:8px; font-weight:bold; }
      input { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; }
      button { width:100%; margin-top:20px; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; }
      button:hover { background:#1d4ed8; }
      .link { text-align:center; margin-top:20px; }
      h3 { margin-top:20px; color:#374151; border-left:4px solid #2563eb; padding-left:6px; }
    </style>
  </head>
  <body>
    <h1>${store} 雇用区分別設定</h1>
    <form method="POST" action="/${store}/admin/contract">
      ${types.map(t => input(t)).join("")}
      <button type="submit">保存する</button>
    </form>

    <div class="link">
      <a href="/${store}/admin/settings">← 店舗共通設定へ戻る</a>
    </div>
  </body>
  </html>
  `);
});

app.post("/:store/admin/contract", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const types = ["fulltime", "parttime", "contract"];

  const obj = {};
  types.forEach(t => {
    obj[t] = {
      basePay: Number(req.body[`${t}_basePay`]) || 0,
      overtimeRate: Number(req.body[`${t}_overtimeRate`]) || 25,
      nightRate: Number(req.body[`${t}_nightRate`]) || 25,
      holidayRate: Number(req.body[`${t}_holidayRate`]) || 35,
    };
  });

  await db.collection("companies").doc(store)
    .collection("config").doc("contractSettings").set(obj, { merge: true });

  res.redirect(`/${store}/admin/contract`);
});


app.post("/:store/admin/settings/save", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const data = req.body;

  await db.collection("companies").doc(store)
    .collection("settings").doc("general")
    .set(data, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
    <h2 style="color:#16a34a;">✅ 保存しました！</h2>
    <a href="/${store}/admin/settings">← 戻る</a>
    </body></html>
  `);
});

// ==============================
// 👥 雇用区分別設定（安定版・最低限）
// ==============================
app.get("/:store/admin/settings/employment", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // 設定対象区分
  const types = [
    { key: "fulltime", label: "正社員" },
    { key: "parttime", label: "アルバイト" },
    { key: "contract", label: "業務委託" },
  ];

  // Firestoreから設定取得
  const settings = {};
  for (const t of types) {
    const doc = await db
      .collection("companies")
      .doc(store)
      .collection("settings")
      .doc("employment_" + t.key)
      .get();
    settings[t.key] = doc.exists ? doc.data() : {};
  }

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 雇用区分別設定</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:24px; }
      h1 { color:#2563eb; text-align:center; margin-bottom:24px; }
      .back-btn { text-align:center; margin-bottom:16px; }
      .back-btn a { background:#2563eb; color:#fff; padding:8px 16px; border-radius:6px; text-decoration:none; }
      .tabs { display:flex; justify-content:center; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
      .tab { padding:10px 18px; border-radius:8px; background:#e5e7eb; cursor:pointer; }
      .tab.active { background:#2563eb; color:white; }
      .panel { display:none; }
      .panel.active { display:block; animation:fadeIn 0.3s; }
      @keyframes fadeIn { from{opacity:0;} to{opacity:1;} }
      form { background:white; padding:20px; border-radius:8px; max-width:460px; margin:0 auto; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
      label { display:block; margin-top:10px; font-weight:600; }
      input { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; margin-top:4px; }
      button { margin-top:18px; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; width:100%; }
      button:hover { background:#1d4ed8; }
    </style>
  </head>
  <body>

    <div class="back-btn">
      <a href="/${store}/admin/settings">← 店舗設定メニューに戻る</a>
    </div>

    <h1>👥 雇用区分別設定</h1>

    <div class="tabs">
      ${types.map((t,i)=>`<div class="tab ${i===0?"active":""}" data-tab="${t.key}">${t.label}</div>`).join("")}
    </div>

    ${types.map((t,i)=>`
      <div id="${t.key}" class="panel ${i===0?"active":""}">
        <form method="POST" action="/${store}/admin/settings/employment/save/${t.key}">
          <h2 style="text-align:center;color:#374151;">${t.label}</h2>
          <label>基本給（時給・月給）</label>
          <input type="number" name="basePay" value="${settings[t.key].basePay || ""}" placeholder="例：1100">
          
          <label>残業割増率（%）</label>
          <input type="number" name="overtimeRate" value="${settings[t.key].overtimeRate || 25}">
          
          <label>深夜手当時間帯</label>
          <input type="text" name="nightHours" value="${settings[t.key].nightHours || "22:00〜5:00"}">
          
          <label>休日割増率（%）</label>
          <input type="number" name="holidayRate" value="${settings[t.key].holidayRate || 35}">
          
          <button type="submit">保存</button>
        </form>
      </div>
    `).join("")}

    <script>
      document.querySelectorAll(".tab").forEach(tab=>{
        tab.addEventListener("click",()=>{
          document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
          document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
          tab.classList.add("active");
          document.getElementById(tab.dataset.tab).classList.add("active");
        });
      });
    </script>

  </body></html>
  `);
});

app.post("/:store/admin/settings/employment/save/:type", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const { type } = req.params;

  const data = {
    basePay: Number(req.body.basePay) || 0,
    overtimeRate: Number(req.body.overtimeRate) || 25,
    nightHours: req.body.nightHours || "22:00〜5:00",
    holidayRate: Number(req.body.holidayRate) || 35,
    updatedAt: new Date(),
  };

  await db.collection("companies")
    .doc(store)
    .collection("settings")
    .doc("employment_" + type)
    .set(data, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
      <h2 style="color:#16a34a;">✅ ${type} の設定を保存しました</h2>
      <a href="/${store}/admin/settings/employment" style="color:#2563eb;">← 雇用区分別設定に戻る</a>
    </body></html>
  `);
});

app.get("/:store/admin/settings/general", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  const doc = await db
    .collection("companies").doc(store)
    .collection("settings").doc("storeGeneral")
    .get();

  const data = doc.exists ? doc.data() : {};

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 給与計算ルール</title>

    <style>
      body {
        font-family: 'Noto Sans JP', sans-serif;
        background: #f3f4f6;
        margin: 0;
        padding: 20px;
      }

      .container {
        max-width: 760px;
        margin: 0 auto;
        background: white;
        padding: 28px;
        border-radius: 12px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.08);
      }

      h1 {
        font-size: 20px;
        font-weight: 700;
        margin-bottom: 18px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 2px solid #e5e7eb;
        padding-bottom: 8px;
      }

      .row {
        margin-bottom: 18px;
      }

      label {
        font-weight: 700;
        font-size: 14px;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      label small {
        font-weight: 400;
        font-size: 12px;
        color: #6b7280;
      }

      input {
        width: 100%;
        padding: 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 15px;
      }

      /* 深夜時間帯 */
      .time-range {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .time-range input[type=time] {
        flex: 1;
        cursor: pointer;
        position: relative;
        z-index: 10;
      }

      .time-range span {
        pointer-events: none;
        font-weight: bold;
      }

      .save-btn {
        width: 100%;
        margin-top: 28px;
        padding: 13px;
        font-size: 16px;
        background: #6366f1;
        color: white;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }

      .save-btn:hover {
        background: #4f46e5;
      }

      .back {
        margin-bottom: 14px;
        text-align: center;
      }

      .back a {
        color: #2563eb;
        text-decoration: none;
        font-size: 14px;
      }
    </style>
  </head>

  <body>
    <div style="text-align:center; margin-top:24px;">
      <button onclick="location.href='/${store}/admin/settings'" 
        style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
        ← 店舗設定に戻る
      </button>
    </div>

    <div class="container">
      <h1>📋 給与計算ルール</h1>

      <form method="POST" action="/${store}/admin/settings/general/save">

        <!-- 残業単価倍率 -->
        <div class="row">
          <label>
            残業単価倍率
            <small>例: 1.25倍 = 時給×125%</small>
          </label>
          <input type="number" step="0.01" name="overtimeRate" value="${data.overtimeRate || 1.25}">
        </div>

        <!-- 深夜割増倍率 -->
        <div class="row">
          <label>
            深夜割増倍率
            <small>例: 1.25倍 = 時給×125%</small>
          </label>
          <input type="number" step="0.01" name="nightRate" value="${data.nightRate || 1.25}">
        </div>

        <!-- 深夜時間帯 -->
        <div class="row">
          <label>
            深夜時間帯（開始〜終了）
          </label>
          <div class="time-range">
            <input type="time" name="nightStart" value="${data.nightStart || '22:00'}">
            <span>〜</span>
            <input type="time" name="nightEnd" value="${data.nightEnd || '05:00'}">
          </div>
        </div>

        <!-- 休日割増倍率 -->
        <div class="row">
          <label>
            休日割増倍率
            <small>例: 1.35倍 = 時給×135%</small>
          </label>
          <input type="number" step="0.01" name="holidayRate" value="${data.holidayRate || 1.35}">
        </div>

        <!-- 締め日 -->
        <div class="row">
          <label>
            締め日（◯日締め）
            <small>例: 25 → 25日締め</small>
          </label>
          <input type="number" name="closingDay" value="${data.closingDay || ''}" placeholder="25">
        </div>

        <button class="save-btn">💾 設定を保存</button>

      </form>
    </div>

  </body>
  </html>
  `);
});



app.post("/:store/admin/settings/general/save", ensureStore, async (req, res) => {
  const store = req.store;

  const data = {
    overtimeRate: Number(req.body.overtimeRate),
    nightRate: Number(req.body.nightRate),
    nightStart: req.body.nightStart,
    nightEnd: req.body.nightEnd,
    holidayRate: Number(req.body.holidayRate),
    closingDay: Number(req.body.closingDay),  // ← 修正
    updatedAt: new Date(),
  };

  await db.collection("companies")
    .doc(store)
    .collection("settings")
    .doc("storeGeneral")
    .set(data, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
      <h2 style="color:#16a34a;">✅ 設定を保存しました</h2>
      <a href="/${store}/admin/settings/general" style="color:#2563eb;">← 戻る</a>
    </body></html>
  `);
});

app.get("/:store/admin/settings/staff", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // Firestore 従業員（承認済）のみ取得
  const snap = await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .where("approved", "==", true)
    .get();

  const staff = snap.docs.map(doc => ({
    userId: doc.id,
    ...doc.data(),
  }));

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>従業員個別設定</title>

    <style>
      body {
        font-family: "Noto Sans JP", sans-serif;
        background:#f3f4f6;
        padding:20px;
      }
      h1 {
        text-align:center;
        font-size:22px;
        margin-bottom:20px;
      }
      table {
        width:100%;
        border-collapse:collapse;
        background:white;
        border-radius:10px;
        overflow:hidden;
      }
      th, td {
        padding:12px;
        border-bottom:1px solid #e5e7eb;
        text-align:left;
        font-size:15px;
      }
      th {
        background:#eef2ff;
        font-weight:bold;
      }
      .edit-btn {
        background:#2563eb;
        color:white;
        padding:6px 12px;
        border-radius:6px;
        border:none;
        font-size:14px;
        cursor:pointer;
      }
      .edit-btn:hover {
        background:#1d4ed8;
      }

      /* ===== モーダル ===== */
      .modal-bg {
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.4);
        display: none;
        justify-content: center;
        align-items: center;
        padding: 0;
        z-index: 9999;
      }
      /* ===== モーダル本体 ===== */
      .modal-box {
        background: white;
        width: 90%;                /* スマホで絶対に収まる幅 */
        max-width: 420px;          /* タブレット・PC 用の上限 */
        
        max-height: 90vh;          /* 画面からはみ出さない */
        overflow-y: auto;          /* 高さが溢れたら縦スクロール */
        
        padding: 20px;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);

        position: relative;
        top: 0; left: 0;
        right: 0; bottom: 0;
        margin: auto;              /* 常にど真ん中へ */
      }
      .modal-title {
        font-size:20px;
        font-weight:bold;
        margin-bottom:14px;
        text-align:center;
      }
      .type-buttons {
        display:flex;
        justify-content:space-between;
        margin-bottom:16px;
      }
      .type-btn {
        flex:1;
        margin:0 4px;
        background:#e5e7eb;
        padding:10px;
        border-radius:8px;
        text-align:center;
        cursor:pointer;
        font-size:15px;
      }
      .type-btn.active {
        background:#2563eb;
        color:white;
      }
      label {
        font-size:15px;
        margin-top:10px;
        display:block;
      }
      input {
        width:100%;
        padding:10px;
        font-size:16px;
        margin-top:6px;
        border:1px solid #d1d5db;
        border-radius:8px;
      }
      .modal-actions {
        margin-top:16px;
        display:flex;
        justify-content:space-between;
      }
      .save-btn {
        background:#16a34a;
        color:white;
        padding:10px 16px;
        border-radius:8px;
        font-size:16px;
        border:none;
        width:48%;
      }
      .close-btn {
        background:#dc2626;
        color:white;
        padding:10px 16px;
        border-radius:8px;
        font-size:16px;
        border:none;
        width:48%;
      }
      

      .table-scroll {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      table.staff-table {
        min-width: 600px;   /* ← 横スクロール強制 */
        border-collapse: collapse;
        width: 100%;
      }

      table.staff-table th, table.staff-table td {
        padding: 6px 10px !important;
        border-bottom: 1px solid #ddd;
        white-space: nowrap; /* ← 横に伸ばす */
        text-align: center;
      }

      .btn-edit {
        background:#3b82f6;
        border:none;
        color:#fff;
        padding:4px 8px;
        border-radius:6px;
        cursor:pointer;
      }
    </style>
  </head>

  <body>
    <div style="text-align:center; margin-top:24px;">
      <button onclick="location.href='/${store}/admin/settings'" 
        style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
        ← 店舗設定に戻る
      </button>
    </div>
    <h1>👤 従業員個別設定</h1>

    <!-- 👇 ここからテーブル全体を差し替え -->

    <div class="table-scroll">
      <table class="staff-table">
        <thead>
          <tr>
            <th>編集</th>
            <th>名前</th>
            <th>雇用区分</th>
            <th>給料</th>
          </tr>
        </thead>
        <tbody>
          ${staff.map(s => `
            <tr>
              <!-- 編集ボタン -->
              <td>
                <button class="edit-btn"
                  onclick="openEdit(
                    '${s.userId}',
                    '${s.name || ""}',
                    '${s.employmentType || ""}',
                    '${jsonForHtml(s.salary || {})}'
                  )">
                  編集
                </button>
              </td>

              <!-- 名前 -->
              <td>${s.name || "未登録"}</td>

              <!-- 雇用区分 -->
              <td>${s.employmentType || "未設定"}</td>

              <!-- 給料 -->
              <td>
                ${
                  s.salary
                    ? s.employmentType === "正社員"
                      ? "月給 " + (s.salary.monthly || "未設定")
                    : s.employmentType === "アルバイト"
                      ? "時給 " + (s.salary.hourly || "未設定")
                    : s.employmentType === "業務委託"
                      ? "日給 " + (s.salary.daily || "未設定")
                    : "—"
                  : "—"
                }
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <!-- ===== モーダル ===== -->
    <div id="modal" class="modal-bg">
      <div class="modal-box">
        <div id="modalTitle" class="modal-title"></div>

        <div class="type-buttons">
          <div class="type-btn" id="btn正社員" onclick="selectType('正社員')">正社員</div>
          <div class="type-btn" id="btnアルバイト" onclick="selectType('アルバイト')">アルバイト</div>
          <div class="type-btn" id="btn業務委託" onclick="selectType('業務委託')">業務委託</div>
        </div>

        <div id="salaryArea"></div>

        <div class="modal-actions">
          <button class="save-btn" onclick="saveStaff()">保存</button>
          <button class="close-btn" onclick="closeModal()">閉じる</button>
        </div>
      </div>
    </div>

    <script>
      const store = "${store}";
      let editUserId = null;
      let selectedType = "";


      function openEdit(id, name, type, salaryJson) {
        const salary = JSON.parse(salaryJson);

        console.log("編集開始:", id, name, type, salary);
        editUserId = id;

        document.getElementById("modalTitle").innerText =
          name + " さんの設定";

        selectedType = type || "";
        highlightTypeButton();

        renderSalaryInput(salary);

        document.getElementById("modal").style.display = "flex";
      }

      function closeModal() {
        document.getElementById("modal").style.display = "none";
      }

      function highlightTypeButton() {
        ["正社員","アルバイト","業務委託"].forEach(t => {
          document.getElementById("btn" + t).classList.remove("active");
        });

        if (selectedType) {
          document.getElementById("btn" + selectedType).classList.add("active");
        }
      }

      function selectType(type) {
        selectedType = type;
        highlightTypeButton();
        renderSalaryInput({});
      }

      function renderSalaryInput(salary) {
        const area = document.getElementById("salaryArea");

        if (selectedType === "正社員") {
          area.innerHTML = \`
            <label>月額固定給（円）</label>
            <input id="salaryInput" type="number" value="\${salary.monthly || ""}">
          \`;
        } else if (selectedType === "アルバイト") {
          area.innerHTML = \`
            <label>時給単価（円）</label>
            <input id="salaryInput" type="number" value="\${salary.hourly || ""}">
          \`;
        } else if (selectedType === "業務委託") {
          area.innerHTML = \`
            <label>日給単価（円）</label>
            <input id="salaryInput" type="number" value="\${salary.daily || ""}">
          \`;
        } else {
          area.innerHTML = "";
        }
      }

      async function saveStaff() {
        const value = document.getElementById("salaryInput")?.value || "";

        await fetch("/${store}/admin/settings/staff/save", {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({
            userId: editUserId,
            employmentType: selectedType,
            value
          })
        });

        alert("保存しました");
        location.reload();
      }
    </script>

  </body>
  </html>
  `);
});


app.post("/:store/admin/settings/staff/type", ensureStore, async (req, res) => {
  const store = req.store;
  const { userId, type } = req.body;

  await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .set({ employmentType: type }, { merge: true });

  res.json({ status: "ok" });
});

app.post("/:store/admin/settings/staff/salary", ensureStore, async (req, res) => {
  const store = req.store;
  const { userId, value } = req.body;

  const doc = await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .get();

  const type = doc.data().employmentType;

  let salary = {};

  if (type === "正社員") salary = { monthly: Number(value) };
  if (type === "アルバイト") salary = { hourly: Number(value) };
  if (type === "業務委託") salary = { daily: Number(value) };

  await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .set({ salary }, { merge: true });

  res.json({ status: "ok" });
});

// HTML属性に安全に JSON を埋め込むためのヘルパー（サーバー側）
function jsonForHtml(obj) {
  return JSON.stringify(obj || {})
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;"); // ダブルクォートだけ HTML エスケープ
}

// ==============================
// ✏️ 個別編集ページ
// ==============================
app.get("/:store/admin/settings/staff/:id", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params } = req;
  const staffId = params.id;

  // 🔹 基本データ取得（members）
  const memberDoc = await db
    .collection("companies")
    .doc(store)
    .collection("members")
    .doc(staffId)
    .get();
  const member = memberDoc.exists ? memberDoc.data() : {};

  // 🔹 個別設定（settings/staff/{id}）
  const configDoc = await db
    .collection("companies")
    .doc(store)
    .collection("settings")
    .doc("staff_" + staffId)
    .get();
  const conf = configDoc.exists ? configDoc.data() : {};

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${member.name || "従業員"} の設定</title>
  <style>
    body { font-family:sans-serif; background:#f9fafb; padding:20px; }
    h1 { text-align:center; color:#2563eb; }
    form { background:#fff; padding:20px; border-radius:8px; max-width:700px; margin:0 auto; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
    label { display:block; margin-top:12px; font-weight:600; }
    input, select { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; margin-top:4px; }
    button { margin-top:20px; background:#2563eb; color:white; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
    a { display:block; text-align:center; margin-top:20px; color:#2563eb; text-decoration:none; }
  </style></head><body>

    <h1>${member.name || "従業員"} の個別設定</h1>

    <form method="POST" action="/${store}/admin/settings/staff/save/${staffId}">
      <label>雇用区分</label>
      <select name="employmentType">
        <option value="">選択してください</option>
        <option value="正社員" ${member.employmentType === "正社員" ? "selected" : ""}>正社員</option>
        <option value="アルバイト" ${member.employmentType === "アルバイト" ? "selected" : ""}>アルバイト</option>
        <option value="業務委託" ${member.employmentType === "業務委託" ? "selected" : ""}>業務委託</option>
        <option value="パート" ${member.employmentType === "パート" ? "selected" : ""}>パート</option>
      </select>

      <label>個別基本時給／月給</label>
      <input type="text" name="basePay" value="${conf.basePay || ""}" placeholder="例：時給1200円、月給28万円など">

      <label>個別残業割増率（％）</label>
      <input type="number" name="overtimeRate" value="${conf.overtimeRate || ""}" placeholder="例：25">

      <label>個別深夜手当時間帯</label>
      <input type="text" name="nightHours" value="${conf.nightHours || ""}" placeholder="例：22:00〜5:00">

      <label>個別休日出勤割増率（％）</label>
      <input type="number" name="holidayRate" value="${conf.holidayRate || ""}" placeholder="例：35">

      <label>勤続／役職手当ルール</label>
      <input type="text" name="bonusRule" value="${conf.bonusRule || ""}" placeholder="例：1年ごとに＋5000円">

      <button type="submit">保存</button>
    </form>

    <a href="/${store}/admin/settings/staff">← 従業員一覧に戻る</a>
  </body></html>
  `);
});

// =====================================
// ✅ 従業員個別設定 保存API（雇用区分＋給料）
// =====================================
app.post("/:store/admin/settings/staff/save", ensureStore, express.json(), async (req, res) => {
  try {
    const { store } = req;
    const { userId, employmentType, value } = req.body;

    if (!userId) {
      return res.status(400).send("userId がありません");
    }

    // 給料データを Firestore 用に変換
    let salaryData = {};

    if (employmentType === "正社員") {
      salaryData = { monthly: Number(value) || null };
    } else if (employmentType === "アルバイト") {
      salaryData = { hourly: Number(value) || null };
    } else if (employmentType === "業務委託") {
      salaryData = { daily: Number(value) || null };
    }

    // Firestore 更新
    await db.collection("companies")
      .doc(store)
      .collection("permissions")
      .doc(userId)
      .set(
        {
          employmentType: employmentType || null,
          salary: salaryData,
          updatedAt: new Date()
        },
        { merge: true }
      );

    return res.status(200).send("OK");
  } catch (err) {
    console.error("従業員設定保存エラー:", err);
    return res.status(500).send("保存に失敗しました");
  }
});

// ==============================
// 💾 個別設定保存
// ==============================
app.post("/:store/admin/settings/staff/save/:id", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params, body } = req;
  const staffId = params.id;

  // 🔹 雇用区分は members にも反映
  await db.collection("companies").doc(store).collection("members").doc(staffId)
    .set({ employmentType: body.employmentType }, { merge: true });

  // 🔹 個別設定を保存
  await db.collection("companies").doc(store)
    .collection("settings")
    .doc("staff_" + staffId)
    .set(body, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
      <h2 style="color:#16a34a;">✅ ${staffId} の設定を保存しました</h2>
      <a href="/${store}/admin/settings/staff">← 従業員一覧へ戻る</a>
    </body></html>
  `);
});

// ==============================
// 👤 従業員個別設定（ボタン＋画面）
// ==============================

// 🔹 管理TOPにボタンを追加
// （管理TOP HTML内のナビ部分に以下のボタンを追加してください）
// <a href="/${store}/admin/employees">従業員設定</a>

// 🔹 ルート定義
app.get("/:store/admin/employees", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snap = await db.collection("companies").doc(store).collection("employees").get();
  const employees = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 従業員設定</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
      h1 { text-align:center; color:#2563eb; margin-bottom:20px; }
      table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; }
      th,td { padding:10px; border-bottom:1px solid #eee; text-align:center; font-size:14px; }
      th { background:#2563eb; color:white; }
      tr:nth-child(even){background:#f3f4f6;}
      button { background:#2563eb; color:white; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
      button:hover { background:#1e40af; }
      .add { margin-bottom:16px; display:block; background:#16a34a; }
    </style>
  </head>
  <body>
    <h1>${store} 従業員設定</h1>
    <button class="add" onclick="location.href='/${store}/admin/employees/new'">＋ 従業員を追加</button>

    <table>
      <thead>
        <tr><th>名前</th><th>雇用区分</th><th>時給</th><th>交通費</th><th>備考</th><th>操作</th></tr>
      </thead>
      <tbody>
        ${employees.map(e => `
          <tr>
            <td>${e.name || "未登録"}</td>
            <td>${e.contractType || "-"}</td>
            <td>${e.hourly || 0}</td>
            <td>${e.commuteAllowance || 0}</td>
            <td>${e.note || ""}</td>
            <td><button onclick="location.href='/${store}/admin/employees/edit?id=${e.id}'">編集</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div style="text-align:center;margin-top:20px;">
      <a href="/${store}/admin" style="color:#2563eb;">← 管理TOPへ戻る</a>
    </div>
  </body>
  </html>
  `);
});


// 🔹 従業員追加・編集画面
app.get("/:store/admin/employees/:mode", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const { mode } = req.params;
  const id = req.query.id;
  let emp = {};
  if (id) {
    const doc = await db.collection("companies").doc(store).collection("employees").doc(id).get();
    emp = doc.exists ? doc.data() : {};
  }

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${store} 従業員${mode === "new" ? "追加" : "編集"}</title>
  <style>
    body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
    h1 { color:#2563eb; text-align:center; margin-bottom:16px; }
    form { background:white; padding:20px; border-radius:8px; max-width:400px; margin:0 auto; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
    label { display:block; margin-top:12px; font-weight:bold; }
    input, select, textarea { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; font-size:14px; }
    button { margin-top:16px; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; width:100%; }
    button:hover { background:#1e40af; }
  </style>
  </head>
  <body>
    <h1>${store} 従業員${mode === "new" ? "追加" : "編集"}</h1>
    <form method="POST" action="/${store}/admin/employees/save">
      <input type="hidden" name="id" value="${id || ""}">
      <label>氏名</label>
      <input type="text" name="name" value="${emp.name || ""}" required>

      <label>雇用区分</label>
      <select name="contractType">
        <option value="">選択してください</option>
        <option value="fulltime" ${emp.contractType==="fulltime"?"selected":""}>正社員</option>
        <option value="parttime" ${emp.contractType==="parttime"?"selected":""}>アルバイト</option>
        <option value="contract" ${emp.contractType==="contract"?"selected":""}>契約社員</option>
      </select>

      <label>基本時給／月給</label>
      <input type="number" name="hourly" step="1" value="${emp.hourly || ""}" placeholder="例：1100">

      <label>交通費（定額）</label>
      <input type="number" name="commuteAllowance" step="1" value="${emp.commuteAllowance || ""}" placeholder="例：5000">

      <label>備考</label>
      <textarea name="note">${emp.note || ""}</textarea>

      <button type="submit">保存する</button>
    </form>

    <div style="text-align:center;margin-top:16px;">
      <a href="/${store}/admin/employees" style="color:#2563eb;">← 一覧に戻る</a>
    </div>
  </body></html>
  `);
});


// 🔹 保存処理
app.post("/:store/admin/employees/save", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const { id, name, contractType, hourly, commuteAllowance, note } = req.body;
  const data = {
    name,
    contractType,
    hourly: Number(hourly) || 0,
    commuteAllowance: Number(commuteAllowance) || 0,
    note: note || "",
    updatedAt: new Date(),
  };

  const ref = db.collection("companies").doc(store).collection("employees");
  if (id) await ref.doc(id).set(data, { merge: true });
  else await ref.add(data);

  res.redirect(`/${store}/admin/employees`);
});

// ==============================
// 💰 給与自動集計（統合版）
// ==============================
app.get("/:store/admin/payroll", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // --- 各種設定を読み込み ---
  const settingsRef = db.collection("companies").doc(store).collection("settings");
  const general = (await settingsRef.doc("storeGeneral").get()).data() || {};
  const fulltime = (await settingsRef.doc("employment_fulltime").get()).data() || {};
  const parttime = (await settingsRef.doc("employment_parttime").get()).data() || {};
  const contract = (await settingsRef.doc("employment_contract").get()).data() || {};

  const employmentMap = { fulltime, parttime, contract };

  // --- 店舗共通設定値 ---
  const regularHours = general.regularHours || 8;
  const nightStart = general.nightStart || "22:00";
  const closingDay = general.closingDay || 25;

  // --- 対象期間（例：前月26日〜今月25日） ---
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), closingDay);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  start.setDate(closingDay + 1);

  // --- 従業員リスト取得 ---
  const empSnap = await db.collection("companies").doc(store).collection("employees").get();
  const employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const results = [];

  for (const emp of employees) {
    const type = emp.contractType || "parttime";
    const empSetting = employmentMap[type] || {};
    const hourly = emp.hourly || empSetting.basePay || 0;
    const overtimeRate = empSetting.overtimeRate || 25;
    const holidayRate = empSetting.holidayRate || 35;

    // --- 勤怠データ取得 ---
    const attSnap = await db.collection("companies").doc(store)
      .collection("attendance").doc(emp.id).collection("records")
      .where("date", ">=", start.toISOString().split("T")[0])
      .where("date", "<=", end.toISOString().split("T")[0])
      .get();

    let totalWork = 0, overtime = 0, holiday = 0, night = 0;

    attSnap.docs.forEach(doc => {
      const d = doc.data();
      const [inH, inM] = (d.clockIn || "00:00").split(":").map(Number);
      const [outH, outM] = (d.clockOut || "00:00").split(":").map(Number);
      let workHours = ((outH * 60 + outM) - (inH * 60 + inM)) / 60 - (d.restHours || 0);

      if (workHours < 0) workHours = 0;
      totalWork += workHours;

      // 残業
      if (workHours > regularHours) overtime += workHours - regularHours;

      // 深夜時間（22:00〜翌5:00）
      if (outH >= 22 || outH < 5) {
        const nightH = outH >= 22 ? outH - 22 : outH + 2; // 簡易計算
        night += nightH;
      }

      // 休日勤務
      if (d.type === "休日") holiday += workHours;
    });

    // --- 給与計算 ---
    const basePay = totalWork * hourly;
    const overPay = overtime * hourly * (overtimeRate / 100);
    const nightPay = night * hourly * 0.25; // 深夜は法定25%
    const holidayPay = holiday * hourly * (holidayRate / 100);

    const total = Math.round(basePay + overPay + nightPay + holidayPay);

    results.push({
      name: emp.name,
      type,
      totalWork: totalWork.toFixed(1),
      overtime: overtime.toFixed(1),
      night: night.toFixed(1),
      holiday: holiday.toFixed(1),
      hourly,
      total,
    });
  }

  // --- 結果表示 ---
  res.send(`
  <!DOCTYPE html>
  <html lang="ja"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${store} 給与集計</title>
  <style>
    body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
    h1 { color:#2563eb; text-align:center; margin-bottom:20px; }
    table { width:100%; border-collapse:collapse; background:white; }
    th,td { border:1px solid #ccc; padding:8px; text-align:center; }
    th { background:#2563eb; color:white; }
    tr:nth-child(even){background:#f3f4f6;}
    .back { text-align:center; margin-top:20px; }
    .back a { color:#2563eb; text-decoration:none; }
    .back a:hover { text-decoration:underline; }
  </style>
  </head><body>
    <div class="back" style="margin-top:30px;">
      <a href="/${store}/admin/settings">← 店舗設定メニューへ戻る</a><br><br>
      <a href="/${store}/admin/payroll/export"
        style="display:inline-block;margin-top:10px;background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">
        💾 CSVでダウンロード
      </a>
    </div>

    <h1>${store} 給与自動集計結果</h1>
    <p style="text-align:center;">期間：${start.toLocaleDateString()}〜${end.toLocaleDateString()}</p>

    <table>
      <thead>
        <tr><th>氏名</th><th>区分</th><th>勤務時間</th><th>残業</th><th>深夜</th><th>休日</th><th>時給</th><th>支給額</th></tr>
      </thead>
      <tbody>
        ${results.map(r => `
        <tr>
          <td>${r.name}</td>
          <td>${r.type}</td>
          <td>${r.totalWork}</td>
          <td>${r.overtime}</td>
          <td>${r.night}</td>
          <td>${r.holiday}</td>
          <td>¥${r.hourly.toLocaleString()}</td>
          <td><b>¥${r.total.toLocaleString()}</b></td>
        </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="back">
      <a href="/${store}/admin/settings">← 店舗設定メニューへ戻る</a>
    </div>

  </body></html>`);
});

// ==============================
// 💾 給与CSV出力
// ==============================
app.get("/:store/admin/payroll/export", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // --- 設定値の取得 ---
  const settingsRef = db.collection("companies").doc(store).collection("settings");
  const general = (await settingsRef.doc("storeGeneral").get()).data() || {};
  const fulltime = (await settingsRef.doc("employment_fulltime").get()).data() || {};
  const parttime = (await settingsRef.doc("employment_parttime").get()).data() || {};
  const contract = (await settingsRef.doc("employment_contract").get()).data() || {};
  const employmentMap = { fulltime, parttime, contract };
  const regularHours = general.regularHours || 8;
  const closingDay = general.closingDay || 25;

  // --- 対象期間 ---
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), closingDay);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  start.setDate(closingDay + 1);

  // --- 従業員リスト取得 ---
  const empSnap = await db.collection("companies").doc(store).collection("employees").get();
  const employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const rows = [];

  for (const emp of employees) {
    const type = emp.contractType || "parttime";
    const empSetting = employmentMap[type] || {};
    const hourly = emp.hourly || empSetting.basePay || 0;
    const overtimeRate = empSetting.overtimeRate || 25;
    const holidayRate = empSetting.holidayRate || 35;

    // --- 勤怠データ取得 ---
    const attSnap = await db.collection("companies").doc(store)
      .collection("attendance").doc(emp.id).collection("records")
      .where("date", ">=", start.toISOString().split("T")[0])
      .where("date", "<=", end.toISOString().split("T")[0])
      .get();

    let totalWork = 0, overtime = 0, holiday = 0, night = 0;

    attSnap.docs.forEach(doc => {
      const d = doc.data();
      const [inH, inM] = (d.clockIn || "00:00").split(":").map(Number);
      const [outH, outM] = (d.clockOut || "00:00").split(":").map(Number);
      let workHours = ((outH * 60 + outM) - (inH * 60 + inM)) / 60 - (d.restHours || 0);
      if (workHours < 0) workHours = 0;
      totalWork += workHours;
      if (workHours > regularHours) overtime += workHours - regularHours;
      if (outH >= 22 || outH < 5) night += (outH >= 22 ? outH - 22 : outH + 2);
      if (d.type === "休日") holiday += workHours;
    });

    const basePay = totalWork * hourly;
    const overPay = overtime * hourly * (overtimeRate / 100);
    const nightPay = night * hourly * 0.25;
    const holidayPay = holiday * hourly * (holidayRate / 100);
    const total = Math.round(basePay + overPay + nightPay + holidayPay);

    rows.push({
      名前: emp.name,
      区分: type,
      勤務時間: totalWork.toFixed(1),
      残業: overtime.toFixed(1),
      深夜: night.toFixed(1),
      休日: holiday.toFixed(1),
      時給: hourly,
      支給額: total,
    });
  }

  // --- CSV生成 ---
  const parser = new Parser();
  const csv = parser.parse(rows);

  res.setHeader('Content-Disposition', `attachment; filename="${store}_給与集計_${now.getFullYear()}-${now.getMonth()+1}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
  res.send('\uFEFF' + csv); // Excelで文字化け防止
});

// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
