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
  },
  storeB: {
    channelAccessToken: process.env.STORE_B_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_B_CHANNEL_SECRET,
    liffId: process.env.STORE_B_LIFF_ID,
    manualUrl: process.env.STORE_B_MANUAL_URL,
    richmenuBefore: process.env.STORE_B_RICHMENU_BEFORE,
    richmenuAfter: process.env.STORE_B_RICHMENU_AFTER,
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

// ==============================
// 🧑‍💼 管理者画面（リアルタイム検索対応）
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
    approved: d.data().approved
  }));

  // 🔽 HTML生成
  res.send(`
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family:'Segoe UI',sans-serif; background:#f9fafb; margin:0; padding:20px; }
    h1 { color:#2563eb; text-align:center; margin-bottom:10px; }
    .top-bar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
    .search-box { flex:1; display:flex; justify-content:center; margin-top:10px; }
    input[type="text"] {
      padding:8px; border:1px solid #ccc; border-radius:6px; width:90%; max-width:280px;
    }
    table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; }
    th,td { padding:10px; border-bottom:1px solid #eee; text-align:left; }
    th { background:#2563eb; color:white; font-weight:500; }
    tr:hover { background:#f3f4f6; }
    button { background:#2563eb; color:white; border:none; padding:6px 10px;
      border-radius:4px; cursor:pointer; font-size:13px; }
    button:hover { background:#1d4ed8; }
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
      <a href="/logout" style="color:#2563eb;text-decoration:none;">ログアウト</a>
    </div>

    <table id="userTable">
      <thead><tr><th>名前</th><th>状態</th><th>操作</th></tr></thead>
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
          ? users.filter(u => u.name.toLowerCase().includes(keyword))
          : users;
        render(filtered);
      });

      // 初期表示
      render(users);
    </script>
  </body></html>
  `);
});

// ==============================
// 🔄 承認・解除処理
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
// 📘 マニュアル表示（承認後Notionへ）
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

app.get("/:store/manual-check", ensureStore, async (req, res) => {
  const doc = await db.collection("companies").doc(req.store)
    .collection("permissions").doc(req.query.userId).get();
  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved) return res.status(403).send("承認待ちです。");
  res.redirect(req.storeConf.manualUrl);
});

// ==============================
// 🧾 権限申請フォーム
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
// 🕒 勤怠打刻（従業員画面）
// ==============================
app.get("/:store/attendance", ensureStore, (req, res) => {
  const { storeConf, store } = req;
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${store} 勤怠打刻</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body{font-family:sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
    .box{background:white;padding:24px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center;width:90%;max-width:340px;}
    h1{color:#2563eb;margin-bottom:20px;}
    button{width:100%;padding:12px;margin-top:10px;border:none;border-radius:8px;font-size:1rem;cursor:pointer;}
    .in{background:#16a34a;color:white;}
    .out{background:#dc2626;color:white;}
  </style></head><body>
  <div class="box">
    <h1>勤怠打刻</h1>
    <p id="username"></p>
    <button class="in" onclick="send('in')">出勤</button>
    <button class="out" onclick="send('out')">退勤</button>
  </div>
  <script>
    async function init(){
      await liff.init({liffId:"${storeConf.liffId}"});
      if(!liff.isLoggedIn()) return liff.login();
      const p = await liff.getProfile();
      document.getElementById("username").innerText = p.displayName + " さん";
      window.user = p;
    }

    async function send(type){
      const res = await fetch("/${store}/attendance/submit",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          userId:window.user.userId,
          name:window.user.displayName,
          type
        })
      });
      const text = await res.text();
      alert(text);
    }
    init();
  </script></body></html>
  `);
});

// ==============================
// 🧾 勤怠データ登録API
// ==============================
app.post("/:store/attendance/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, type } = req.body;
  const today = new Date().toISOString().split("T")[0]; // yyyy-mm-dd
  const docRef = db.collection("companies").doc(store).collection("attendance").doc(`${userId}_${today}`);
  const data = (await docRef.get()).data() || { userId, name, date: today };

  if (type === "in") data.clockIn = new Date();
  if (type === "out") data.clockOut = new Date();

  await docRef.set(data, { merge: true });
  res.send(type === "in" ? "出勤を記録しました。" : "退勤を記録しました。");
});

// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
