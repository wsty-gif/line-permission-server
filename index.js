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

// ================================
// 📘 社内マニュアル（LIFFログイン対応版）
// ================================
app.get("/manual", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <title>社内マニュアルログイン</title>
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    </head>
    <body>
      <h2>LINEログイン中...</h2>
      <script>
        const liffId = "${process.env.LIFF_ID}";
        async function main() {
          try {
            await liff.init({ liffId });
            if (!liff.isLoggedIn()) {
              liff.login();
              return;
            }
            const profile = await liff.getProfile();
            const userId = profile.userId;
            // Firestoreチェックページへリダイレクト
            window.location.href = "/manual/check?userId=" + userId;
          } catch (err) {
            document.body.innerHTML = "<h3>LIFF初期化に失敗しました：" + err + "</h3>";
          }
        }
        main();
      </script>
    </body>
    </html>
  `);
});

// ================================
// 🔍 Firestore 承認チェック
// ================================
app.get("/manual/check", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).send("<h3>ユーザー情報を取得できませんでした。</h3>");
  }

  const doc = await db.collection("permissions").doc(userId).get();
  const data = doc.data();

  if (!data) {
    return res.status(404).send("<h3>権限申請が未登録です。LINEから「権限申請」と送信してください。</h3>");
  }

  if (!data.approved) {
    return res.status(403).send("<h3>管理者の承認待ちです。しばらくお待ちください。</h3>");
  }

  // ✅ 承認済みユーザー用マニュアル
  res.send(`
    <h1>📘 社内マニュアル</h1>
    <p>ようこそ、${userId} さん。</p>
    <ul>
      <li>① 業務開始手順</li>
      <li>② 勤怠報告とチェック</li>
      <li>③ 緊急時対応マニュアル</li>
    </ul>
    <p><small>※このページは承認済みユーザーのみ閲覧可能です。</small></p>
  `);
});
