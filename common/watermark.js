// ============================
//  透かし（ウォーターマーク）共通スクリプト
// ============================

// Firebase を使用して権限申請名（permissions.name）を取得する
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.8/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.6.8/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------------------------------------------------------
// 共通：ウォーターマークテキスト生成
// ---------------------------------------------------------
function generateTile(text) {
  const canvas = document.createElement("canvas");
  const w = 260, h = 160;
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  ctx.font = "bold 20px 'Noto Sans JP', sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.15)";   // ← 普段は薄く、編集すると浮き出る
  ctx.textAlign = "center";

  ctx.translate(w / 2, h / 2);
  ctx.rotate(-25 * Math.PI / 180);
  ctx.fillText(text, 0, 0);

  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------
// LIFF 初期化 → Firestore → ウォーターマーク生成
// ---------------------------------------------------------
async function initWatermark() {
  try {
    // HTML 側で window.LIFF_ID と window.STORE を埋め込む（後述）
    await liff.init({ liffId: window.LIFF_ID });

    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    const profile = await liff.getProfile();
    const userId = profile.userId;

    // Firestore の権限申請データから「名前」を取得
    const ref = doc(db, "companies", window.STORE, "permissions", userId);
    const snap = await getDoc(ref);

    let username = profile.displayName;
    if (snap.exists()) {
      username = snap.data().name || username;
    }

    const timestamp = new Date().toLocaleString("ja-JP");
    const wmText = `社外秘 ${username} / ${timestamp}`;

    // タイル背景をセット
    const wm = document.getElementById("wmTile");
    wm.style.backgroundImage = `url('${generateTile(wmText)}')`;

  } catch (e) {
    console.error("ウォーターマーク初期化エラー:", e);
  }
}

document.addEventListener("DOMContentLoaded", initWatermark);
