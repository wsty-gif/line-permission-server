const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");
const session = require("express-session");

// ==============================
// 🔥 Firebase初期化
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
// 💬 LINE設定
// ==============================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ==============================
// 🚀 Express設定
// ==============================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- セッション設定 ---
app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || "secret-key",
    resave: false,
    saveUninitialized: false,
  })
);

// ==============================
// 🌐 Webhook（署名検証なし）
// ==============================
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text.trim();

      if (text === "権限申請") {
        await db.collection("permissions").doc(userId).set(
          {
            approved: false,
            requestedAt: new Date(),
          },
          { merge: true }
        );

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "権限申請を受け付けました。",
        });
      }
    }
  }
  res.status(200).send("OK");
});

// ==============================
// 🔐 管理者ログイン画面（モバイル対応）
// ==============================
app.get("/login", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>管理者ログイン</title>
    <style>
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
        padding: 30px 24px;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        width: 100%;
        max-width: 380px;
        text-align: center;
        box-sizing: border-box;
      }
      h1 {
        font-size: 1.5rem;
        margin-bottom: 20px;
        color: #2563eb;
      }
      input {
        width: 100%;
        padding: 10px;
        margin: 8px 0;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        font-size: 1rem;
        box-sizing: border-box;
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
        margin-top: 12px;
      }
      button:hover {
        background: #1d4ed8;
      }
    </style>
  </head>
  <body>
    <div class="login-container">
      <h1>管理者ログイン</h1>
      <form method="POST" action="/login">
        <input type="text" name="user" placeholder="ユーザーID" required />
        <input type="password" name="pass" placeholder="パスワード" required />
        <button type="submit">ログイン</button>
      </form>
    </div>
  </body>
  </html>
  `);
});

// ==============================
// ✅ ログイン処理
// ==============================
app.post("/login", (req, res) => {
  const { user, pass } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "owner";
  const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect("/admin");
  } else {
    res.send("<h3>ログイン失敗</h3><a href='/login'>戻る</a>");
  }
});

// ==============================
// 🚪 ログアウト
// ==============================
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// ==============================
// 🧑‍💼 管理者ページ（モバイル対応＋余白調整）
// ==============================
app.get("/admin", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/login");

  const snapshot = await db.collection("permissions").get();
  const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const results = [];
  for (const u of users) {
    let displayName = "（取得不可）";
    try {
      const profile = await client.getProfile(u.id);
      displayName = profile.displayName || "（未設定）";
    } catch {}
    results.push({ ...u, displayName });
  }

  let html = `
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>権限管理</title>
    <style>
      body {
        font-family: 'Segoe UI', sans-serif;
        background: #f9fafb;
        color: #333;
        margin: 0;
        padding: 16px;
        box-sizing: border-box;
      }
      h1 {
        text-align: center;
        color: #2563eb;
      }
      .top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }
      .logout {
        color: #2563eb;
        text-decoration: none;
        font-weight: bold;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        border-radius: 8px;
        overflow: hidden;
      }
      th, td {
        padding: 10px;
        text-align: left;
        font-size: 0.9rem;
      }
      th {
        background: #2563eb;
        color: white;
      }
      tr:nth-child(even) {
        background: #f1f5f9;
      }
      button {
        background: #2563eb;
        border: none;
        color: white;
        padding: 6px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8rem;
      }
      button:hover {
        background: #1d4ed8;
      }
      .approved { color: #16a34a; font-weight: bold; }
      .pending { color: #dc2626; font-weight: bold; }

      @media (max-width: 600px) {
        body { padding: 10px; }
        table, thead, tbody, th, td, tr { display: block; width: 100%; }
        th { display: none; }
        tr { margin-bottom: 10px; background: #fff; border-radius: 8px; padding: 10px; }
        td { display: flex; justify-content: space-between; padding: 6px 8px; }
        td::before { content: attr(data-label); font-weight: bold; color: #555; }
      }
    </style>
  </head>
  <body>
    <div class="top-bar">
      <h1>権限管理ページ</h1>
      <a href="/logout" class="logout">ログアウト</a>
    </div>
    <table>
      <thead><tr><th>LINE名</th><th>User ID</th><th>承認状態</th><th>操作</th></tr></thead>
      <tbody>`;

  for (const u of results) {
    html += `
      <tr>
        <td data-label="LINE名">${u.displayName}</td>
        <td data-label="User ID">${u.id}</td>
        <td data-label="承認状態" class="${u.approved ? "approved" : "pending"}">
          ${u.approved ? "承認済み" : "未承認"}
        </td>
        <td data-label="操作">
          <form method="POST" action="/approve" style="display:inline">
            <input type="hidden" name="id" value="${u.id}">
            <button>承認</button>
          </form>
          <form method="POST" action="/revoke" style="display:inline">
            <input type="hidden" name="id" value="${u.id}">
            <button style="background:#dc2626;">解除</button>
          </form>
        </td>
      </tr>`;
  }

  html += `</tbody></table></body></html>`;
  res.send(html);
});

// ==============================
// ✅ 承認・解除API
// ==============================
app.post("/approve", async (req, res) => {
  if (!req.session.loggedIn) return res.status(403).send("ログインが必要です");
  await db.collection("permissions").doc(req.body.id).update({ approved: true });
  res.redirect("/admin");
});

app.post("/revoke", async (req, res) => {
  if (!req.session.loggedIn) return res.status(403).send("ログインが必要です");
  await db.collection("permissions").doc(req.body.id).update({ approved: false });
  res.redirect("/admin");
});

// ==============================
// 📘 社内マニュアル（Notionへ遷移）
// ==============================
app.get("/manual", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <title>社内マニュアル</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  </head>
  <body>
    <p>LINEログイン中です...</p>
    <script>
      const liffId = "${process.env.LIFF_ID}";
      async function main() {
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        const userId = profile.userId;
        window.location.href = "/manual-check?userId=" + encodeURIComponent(userId);
      }
      main();
    </script>
  </body>
  </html>
  `);
});

// ==============================
// 🔍 Firestore承認チェック → Notionへリダイレクト
// ==============================
app.get("/manual-check", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send("ユーザー情報が取得できません。");

  const doc = await db.collection("permissions").doc(userId).get();
  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved) return res.status(403).send("管理者の承認待ちです。");

  // ✅ Notionにリダイレクト（直接遷移）
  res.redirect("https://www.notion.so/LINE-25d7cbd19fa1808e9fa4df130ecb96e7");
});

// ==============================
// 🚀 サーバー起動
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
