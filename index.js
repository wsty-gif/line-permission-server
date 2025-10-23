const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");
const session = require("express-session");

// ==============================
// 🔧 店舗ごとの設定（環境変数ベース）
//    ここに店舗を追加してください（storeA, storeB など）
// ==============================
const STORES = {
  storeA: {
    channelAccessToken: process.env.STORE_A_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_A_CHANNEL_SECRET,
    liffId: process.env.STORE_A_LIFF_ID,
    manualUrl: process.env.STORE_A_MANUAL_URL, // Notion公開URL
  },
  storeB: {
    channelAccessToken: process.env.STORE_B_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_B_CHANNEL_SECRET,
    liffId: process.env.STORE_B_LIFF_ID,
    manualUrl: process.env.STORE_B_MANUAL_URL,
  },
  // 追加：storeC, storeD …
};

// LINEクライアントを店舗ごとに用意
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
// 🧭 ユーティリティ
// ==============================
function ensureStore(req, res, next) {
  const store = req.params.store;
  if (!store || !STORES[store]) {
    return res.status(404).send("店舗が存在しません。URL を確認してください。");
  }
  req.store = store;
  req.storeConf = STORES[store];
  req.lineClient = lineClients[store];
  return next();
}

// ==============================
// 🛰️ Webhook（店舗別エンドポイント）
// ※ 本番は署名検証を入れるのが推奨だが、まずは動作優先で省略
// ==============================
app.post("/webhook/:store", ensureStore, async (req, res) => {
  const events = req.body.events || [];
  const store = req.store;

  try {
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userId = event.source.userId;
        const text = (event.message.text || "").trim();

        // 例：「権限申請」だけで登録。文言拡張はここで分岐可能（例：役割）
        if (text === "権限申請") {
          await db
            .collection("companies")
            .doc(store)
            .collection("permissions")
            .doc(userId)
            .set(
              { approved: false, requestedAt: new Date() },
              { merge: true }
            );

          if (req.lineClient) {
            await req.lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `権限申請を受け付けました。（店舗: ${store}）`,
            });
          }
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
// 🔐 管理者ログイン（共通）
// ==============================
app.get("/login", (req, res) => {
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>管理者ログイン</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', sans-serif;
        background: #f9fafb; color: #333;
        display: flex; align-items: center; justify-content: center;
        height: 100vh; margin: 0; padding: 16px;
      }
      .login-container {
        background: #fff; padding: 28px 22px; border-radius: 12px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        width: 100%; max-width: 380px; text-align: center;
      }
      h1 { font-size: 1.5rem; margin-bottom: 18px; color: #2563eb; }
      input, select {
        width: 100%; padding: 10px; margin: 8px 0;
        border-radius: 6px; border: 1px solid #d1d5db; font-size: 1rem;
      }
      button {
        width: 100%; background: #2563eb; color: #fff; border: none;
        padding: 10px; border-radius: 6px; font-size: 1rem; cursor: pointer; margin-top: 12px;
      }
      button:hover { background: #1d4ed8; }
      .hint { font-size: .85rem; color:#555; margin-top:8px; }
    </style>
  </head><body>
    <div class="login-container">
      <h1>管理者ログイン</h1>
      <form method="POST" action="/login">
        <select name="store" required>
          <option value="" disabled selected>店舗を選択</option>
          ${Object.keys(STORES).map(s => `<option value="${s}">${s}</option>`).join("")}
        </select>
        <input type="text" name="user" placeholder="ユーザーID（共通）" required />
        <input type="password" name="pass" placeholder="パスワード（共通）" required />
        <button type="submit">ログイン</button>
      </form>
      <div class="hint">※ ログイン情報は全店舗共通。店舗選択で表示対象が切り替わります。</div>
    </div>
  </body></html>
  `);
});

app.post("/login", (req, res) => {
  const { user, pass, store } = req.body;
  if (!store || !STORES[store]) return res.status(400).send("店舗を選択してください。");

  const ADMIN_USER = process.env.ADMIN_USER || "owner";
  const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.loggedIn = true;
    req.session.store = store;
    return res.redirect(`/${store}/admin`);
  }
  res.send("<h3>ログイン失敗</h3><a href='/login'>戻る</a>");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ==============================
// 🧑‍💼 管理者ページ（店舗別、一覧はその店舗のみ）
// ==============================
app.get("/:store/admin", ensureStore, async (req, res) => {
  // ログイン必須＋ログイン時に選択した店舗のみ閲覧可
  if (!req.session.loggedIn) return res.redirect("/login");
  if (req.session.store !== req.store) {
    return res.status(403).send("選択した店舗とログイン済み店舗が一致しません。ログアウトして選び直してください。");
  }

  const store = req.store;
  const snapshot = await db
    .collection("companies")
    .doc(store)
    .collection("permissions")
    .get();

  const users = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // LINE表示名取得（失敗時は「取得不可」）
  const results = [];
  for (const u of users) {
    let displayName = "（取得不可）";
    try {
      if (req.lineClient) {
        const p = await req.lineClient.getProfile(u.id);
        displayName = p.displayName || displayName;
      }
    } catch {}
    results.push({ ...u, displayName });
  }

  // シンプル＋モバイル対応
  const html = `
  <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>権限管理（${store}）</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Segoe UI', sans-serif; background:#f9fafb; color:#333; margin:0; padding:16px; }
      .top { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
      h1 { margin:0; color:#2563eb; font-size:1.4rem; }
      .actions a { color:#2563eb; text-decoration:none; font-weight:bold; }
      table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden;
              box-shadow:0 2px 6px rgba(0,0,0,.1); margin-top:12px; }
      th, td { padding:10px; text-align:left; font-size:.95rem; }
      th { background:#2563eb; color:#fff; }
      tr:nth-child(even) { background:#f1f5f9; }
      button { background:#2563eb; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:.85rem; }
      button:hover { background:#1d4ed8; }
      .approved { color:#16a34a; font-weight:bold; }
      .pending { color:#dc2626; font-weight:bold; }
      @media (max-width: 640px) {
        table, thead, tbody, th, td, tr { display:block; width:100%; }
        th { display:none; }
        tr { margin-bottom:10px; background:#fff; border-radius:8px; padding:10px; }
        td { display:flex; justify-content:space-between; padding:6px 8px; }
        td::before { content: attr(data-label); font-weight:bold; color:#555; }
      }
    </style>
  </head><body>
    <div class="top">
      <h1>権限管理（${store}）</h1>
      <div class="actions">
        <a href="/${store}/manual">📘 マニュアル確認</a>　|　
        <a href="/logout">ログアウト</a>
      </div>
    </div>
    <table>
      <thead><tr><th>LINE名</th><th>User ID</th><th>状態</th><th>操作</th></tr></thead>
      <tbody>
        ${results.map(u => `
          <tr>
            <td data-label="LINE名">${u.displayName}</td>
            <td data-label="User ID">${u.id}</td>
            <td data-label="状態" class="${u.approved ? "approved" : "pending"}">
              ${u.approved ? "承認済み" : "未承認"}
            </td>
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
          </tr>
        `).join("")}
      </tbody>
    </table>
  </body></html>
  `;
  res.send(html);
});

// 承認・解除（店舗別）
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
// 📘 マニュアル（店舗別：LIFF→承認チェック→Notionへ遷移）
// ==============================
app.get("/:store/manual", ensureStore, (req, res) => {
  const { liffId } = req.storeConf;
  if (!liffId) return res.status(500).send("LIFF ID が未設定です。");
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>社内マニュアル（${req.store}）</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  </head><body>
    <p>LINEログイン中です...</p>
    <script>
      const liffId = "${liffId}";
      async function main() {
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) { liff.login(); return; }
        const profile = await liff.getProfile();
        const userId = profile.userId;
        location.href = "/${encodeURIComponent(req.store)}/manual-check?userId=" + encodeURIComponent(userId);
      }
      main();
    </script>
  </body></html>
  `);
});

app.get("/:store/manual-check", ensureStore, async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send("ユーザー情報が取得できません。");

  const doc = await db.collection("companies").doc(req.store).collection("permissions").doc(userId).get();
  if (!doc.exists) return res.status(404).send("権限申請が未登録です。LINEで「権限申請」と送信してください。");
  const { approved } = doc.data();
  if (!approved) return res.status(403).send("管理者の承認待ちです。");

  const manualUrl = req.storeConf.manualUrl;
  if (!manualUrl) return res.status(500).send("この店舗のマニュアルURLが未設定です。");
  return res.redirect(manualUrl); // ← 直接 Notion へ遷移
});

// ルート
app.get("/", (_req, res) => {
  res.send("OK /login から開始してください。");
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
