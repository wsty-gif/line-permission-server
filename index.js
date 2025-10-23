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
// 🛰️ Webhook（権限申請）
// ==============================
app.post("/webhook/:store", ensureStore, async (req, res) => {
  const events = req.body.events || [];
  const { store, lineClient, storeConf } = req;

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

          // 初期リッチメニュー設定（承認前）
          try {
            await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
          } catch (e) {
            console.error("リッチメニュー初期設定失敗:", e.originalError?.response?.data || e);
          }

          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: `権限申請を受け付けました。（${store}）`,
          });
        }
      }
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).send("NG");
  }
});

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
// 🧑‍💼 管理者画面（承認処理でリッチメニュー切替）
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
  const lineClient = req.lineClient;

  const results = [];
  for (const u of users) {
    let name = "（取得不可）";
    try {
      const p = await lineClient.getProfile(u.id);
      name = p.displayName;
    } catch {}
    results.push({ ...u, displayName: name });
  }

  res.send(`
  <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family:sans-serif; background:#f9fafb; padding:16px; }
    h1 { color:#2563eb; }
    table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; }
    th,td { padding:8px; border-bottom:1px solid #eee; }
    th { background:#2563eb; color:white; }
    button { background:#2563eb; color:white; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
  </style></head><body>
    <h1>${store} 権限管理</h1>
    <a href="/${store}/manual">📘マニュアル</a> | <a href="/logout">ログアウト</a>
    <table><tr><th>LINE名</th><th>User ID</th><th>状態</th><th>操作</th></tr>
    ${results.map(u => `
      <tr>
        <td>${u.displayName}</td>
        <td>${u.id}</td>
        <td>${u.approved ? "承認済み" : "未承認"}</td>
        <td>
          <form method="POST" action="/${store}/approve" style="display:inline">
            <input type="hidden" name="id" value="${u.id}">
            <button>承認</button>
          </form>
          <form method="POST" action="/${store}/revoke" style="display:inline">
            <input type="hidden" name="id" value="${u.id}">
            <button style="background:#dc2626;">解除</button>
          </form>
        </td>
      </tr>`).join("")}
    </table>
  </body></html>`);
});

app.post("/:store/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { store, lineClient, storeConf } = req;
  const userId = req.body.id;
  await db.collection("companies").doc(store).collection("permissions").doc(userId)
    .set({ approved: true }, { merge: true });

  // 🟩 承認時にリッチメニュー切り替え
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

  // 🟥 解除時にリッチメニューを初期に戻す
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
