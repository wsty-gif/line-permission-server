const { Client, middleware } = require("@line/bot-sdk");
const admin = require("firebase-admin");

// Firebase 初期化（重複防止）
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// LINE設定（後で環境変数で設定します）
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// メイン処理
module.exports = [
  middleware(config),
  async (req, res) => {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userId = event.source.userId;
        const text = event.message.text.trim();

        // 「権限申請」と送信された場合
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
  },
];
