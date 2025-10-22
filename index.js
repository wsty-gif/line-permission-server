const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const lineHandler = require("./lineHandler");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// LINEのWebhookエンドポイント
app.post("/webhook", lineHandler);

// Firebase Functionsとして公開
exports.api = functions.region("asia-northeast1").https.onRequest(app);
