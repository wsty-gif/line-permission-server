const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const cors = require("cors");

// --- Firebase初期化 ---
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

// --- LINE設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// --- Expressアプリ ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Webhookエンドポイント ---
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
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
          text: "権限申請を受け付けました。管理者の承認をお待ちください。",
        });
      }
    }
  }
  res.status(200).end();
});

// --- 動作確認用 ---
app.get("/", (req, res) => {
  res.send("LINE Permission Server is running 🚀");
});

// --- ポート設定 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
