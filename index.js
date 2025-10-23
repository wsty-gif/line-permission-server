const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");
const session = require("express-session");

// ==============================
// 🔧 店舗ごとの設定（ここに追加していく）
// ==============================
const STORES = {
  storeA: {
    channelAccessToken: process.env.STORE_A_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_A_CHANNEL_SECRET,
    liffId: process.env.STORE_A_LIFF_ID,
    manualUrl: process.env.STORE_A_MANUAL_URL,
  },
  storeB: {
    channelAccessToken: process.env.STORE_B_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_B_CHANNEL_SECRET,
    liffId: process.env.STORE_B_LIFF_ID,
    manualUrl: process.env.STORE_B_MANUAL_URL,
  },
};

// LINEクライアントを店舗ごとに作成
const lineClients = {};
for (const [store, conf] of Object.entries(STORES)) {
  if (conf.channelAccessToken && conf.channelSecret) {
    lineClients[store] = new Client({
      channelAccessToken: conf.channelAccessToken,
      channelSecret: conf.channelSecret,
    });
  }
}

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
// 🚀 Express 基本設定
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
// 🧭 ミドルウェア（店舗確認）
// ==============================
function ensureStore(req, res, next) {
  const store = req.params.store;
  if (!store || !STORES[store]) {
    return res.status(404).send("店舗が存在しません。URLを確認してください。");
  }
  req.store = store;
  req.storeConf = STORES[store];
  req.lineClient = lineClients[store];
  next();
}

// ==============================
// 🛰️ Webhook（店舗別）
// ==============================
app.post("/webhook/:store", ensureStore, async (req, res) => {
  const events = req.body.events || [];
  const { store, lineClient } = req;

  try {
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userId = event.source.userId;
        const text = event.message.text.trim();

        if (text === "権限申請") {
          await db
            .collection("companies")
            .doc(store)
            .collection("permissions")
            .doc(userId)
            .set({ approved: false, requestedAt: new Date() }, { merge: true });

          if (lineClient) {
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `権限申請を受け付けました。（${store}）`,
            });
          }
        }
      }
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("NG");
  }
});

// ==============================
// 🔐 管理者ログイン（店舗別URL）
// ==============================
app.get("/:store/login", ensureStore, (req, res) => {
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${req.store} 管理者ログイン</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #f9fafb;
      color: #333;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 16px;
    }
    .login-container {
      background: white;
      padding: 28px 24px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      width: 100%;
      max-width: 360px;
      text-align: center;
    }
    h1 {
      color: #2563eb;
      font-size: 1.4rem;
      margin-bottom: 18px;
    }
    input {
      width: 100%;
      padding: 10px;
      margin: 8px 0;
      border-radius: 6px;
      border: 1px solid #d1d5db;
      font-size: 1rem;
    }
    button {
      width: 100%;
      background: #2563eb;
      color: white;
      border: none;
      padding: 10px;
      border-radius: 6px;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
  </style>
  </head><body>
    <div class="login-container">
      <h1>${req.store} 管理者ログイン</h1>
      <form method="POST" action="/${req.store}/login">
        <input type="text" name="user" placeholder="ユーザーID" required />
        <input type="password" name="pass" placeholder="パスワード" required />
        <button type="submit">ログイン</button>
      </form>
    </div>
  </body></html>
  `);
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

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ==============================
// 🧑‍💼 管理者ページ（モバイル対応）
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

  const users = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  const results = [];

  for (const u of users) {
    let displayName = "（取得不可）";
    try {
      if (req.lineClient) {
        const profile = await req.lineClient.getProfile(u.id);
        displayName = profile.displayName || displayName;
      }
    } catch {}
    results.push({ ...u, displayName });
  }

  const html = `
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${store} 権限管理</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; background:#f9fafb; margin:0; padding:16px; }
    h1 { color:#2563eb; text-align:center; }
    table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px;
            box-shadow:0 2px 6px rgba(0,0,0,.1); margin-top:12px; }
    th,td { padding:10px; text-align:left; font-size:.9rem; }
    th { background:#2563eb; color:white; }
    tr:nth-child(even){ background:#f1f5f9; }
    button { background:#2563eb; border:none; color:white; padding:6px 10px; border-radius:4px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
    @media (max-width:640px){
      table,thead,tbody,th,td,tr{display:block;width:100%;}
      th{display:none;}
      tr{margin-bottom:10px;background:white;border-radius:8px;padding:10px;}
      td{display:flex;justify-content:space-between;padding:6px 8px;}
      td::before{content:attr(data-label);font-weight:bold;color:#555;}
    }
  </style></head><body>
    <h1>${store} 権限管理</h1>
    <a href="/${store}/manual">📘 マニュアル確認</a> | <a href="/logout">ログアウト</a>
    <table><thead><tr><th>LINE名</th><th>User ID</th><th>状態</th><th>操作</th></tr></thead><tbody>
      ${results
        .map(
          u => `
        <tr>
          <td data-label="LINE名">${u.displayName}</td>
          <td data-label="User ID">${u.id}</td>
          <td data-label="状態">${u.approved ? "承認済み" : "未承認"}</td>
          <td data-label="操作">
            <form method="POST" action="/${store}/approve" style="display:inline">
              <input type="hidden" name="id" value="${u.id}">
              <button>承認</button>
            </form>
            <form method="POST" action="/${store}/revoke" style="display:inline">
              <input type="hidden" name="id" value="${u.id}">
              <button style="background:#dc2626;">解除</button>
            </form>
          </td>
        </tr>`
        )
        .join("")}
    </tbody></table></body></html>`;
  res.send(html);
});

app.post("/:store/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");
  await db.collection("companies").doc(req.store).collection("permissions").doc(req.body.id)
    .set({ approved: true }, { merge: true });
  res.redirect(`/${req.store}/admin`);
});

app.post("/:store/revoke", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");
  await db.collection("companies").doc(req.store).collection("permissions").doc(req.body.id)
    .set({ approved: false }, { merge: true });
  res.redirect(`/${req.store}/admin`);
});

// ==============================
// 📘 マニュアル（LIFF → Notion）
// ==============================
app.get("/:store/manual", ensureStore, (req, res) => {
  const { liffId } = req.storeConf;
  if (!liffId) return res.status(500).send("LIFF ID が未設定です。");
  res.send(`
  <!DOCTYPE html><html><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${req.store} マニュアル</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  </head><body>
  <p>LINEログイン中です...</p>
  <script>
  const liffId = "${liffId}";
  async function main(){
    await liff.init({liffId});
    if(!liff.isLoggedIn()){liff.login();return;}
    const p = await liff.getProfile();
    location.href = "/${req.store}/manual-check?userId=" + encodeURIComponent(p.userId);
  }
  main();
  </script>
  </body></html>`);
});

app.get("/:store/manual-check", ensureStore, async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send("ユーザー情報取得失敗");
  const doc = await db.collection("companies").doc(req.store).collection("permissions").doc(userId).get();
  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved) return res.status(403).send("管理者の承認待ちです。");
  return res.redirect(req.storeConf.manualUrl);
});

// ==============================
app.get("/", (req, res) =>
  res.send("OK。例: /storeA/login または /storeB/login を開いてください。")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
