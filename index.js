const express = require("express");
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");

// Firebase初期化
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// LINE設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

const app = express();
app.use(cors());
app.use(express.json());

// ✅ 署名検証なし（テスト用）
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text.trim();

      if (text === "権限申請") {
        await db.collection("permissions").doc(userId).set({
          approved: false,
          requestedAt: new Date(),
        }, { merge: true });

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "権限申請を受け付けました（テストモード）。",
        });
      }
    }
  }
  res.status(200).send("OK (no signature validation)");
});

// 動作確認用
app.get("/", (req, res) => {
  res.send("LINE Permission Server is running 🚀 (No signature check)");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ================================
// 🔐 管理者ログイン機能付き 権限管理ページ
// ================================
const session = require("express-session");

// --- セッション設定 ---
app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || "secret-key",
    resave: false,
    saveUninitialized: false,
  })
);

// --- ログインページ表示 ---
app.get("/login", (req, res) => {
  res.send(`
    <h2>管理者ログイン</h2>
    <form method="POST" action="/login">
      <label>ユーザーID：</label><br>
      <input name="username" required><br><br>
      <label>パスワード：</label><br>
      <input type="password" name="password" required><br><br>
      <button type="submit">ログイン</button>
    </form>
  `);
});

// --- ログイン処理 ---
app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "pass123";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect("/admin");
  } else {
    res.send("<h3>ログイン失敗</h3><a href='/login'>戻る</a>");
  }
});

// --- ログアウト処理 ---
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// --- 管理画面 ---
app.get("/admin", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/login");

  const snapshot = await db.collection("permissions").get();
  const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  let html = `
    <h1>権限管理ページ（管理者）</h1>
    <a href="/logout">ログアウト</a>
    <table border="1" cellspacing="0" cellpadding="5">
      <tr><th>User ID</th><th>承認状態</th><th>操作</th></tr>
  `;

  for (const u of users) {
    html += `
      <tr>
        <td>${u.id}</td>
        <td>${u.approved ? "✅ 承認済み" : "❌ 未承認"}</td>
        <td>
          <form method="POST" action="/approve">
            <input type="hidden" name="id" value="${u.id}">
            <button>承認</button>
          </form>
          <form method="POST" action="/revoke">
            <input type="hidden" name="id" value="${u.id}">
            <button>解除</button>
          </form>
        </td>
      </tr>`;
  }

  html += "</table>";
  res.send(html);
});

app.post("/approve", express.urlencoded({ extended: true }), async (req, res) => {
  if (!req.session.loggedIn) return res.status(403).send("ログインが必要です");
  await db.collection("permissions").doc(req.body.id).update({ approved: true });
  res.redirect("/admin");
});

app.post("/revoke", express.urlencoded({ extended: true }), async (req, res) => {
  if (!req.session.loggedIn) return res.status(403).send("ログインが必要です");
  await db.collection("permissions").doc(req.body.id).update({ approved: false });
  res.redirect("/admin");
});
