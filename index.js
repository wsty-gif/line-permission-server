// =============================
// ES Module 用の import に統一
// =============================
import "dotenv/config";
import express from "express";
import { Client } from "@line/bot-sdk";
import admin from "firebase-admin";
import cors from "cors";
import session from "express-session";
import { Parser } from "json2csv";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";

import fs from "fs";
import path from "path";
// ESM 用 __dirname 再定義
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORES = {
  storeA: {
    channelAccessToken: process.env.STORE_A_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_A_CHANNEL_SECRET,
    liffId: process.env.STORE_A_LIFF_ID,
    manualUrl: process.env.STORE_A_MANUAL_URL,
    richmenuBefore: process.env.STORE_A_RICHMENU_BEFORE,
    richmenuAfter: process.env.STORE_A_RICHMENU_AFTER,
    manualUrls: {
      line: process.env.STORE_A_MANUAL_URL_LINE,
      todo: process.env.STORE_A_MANUAL_URL_TODO,
      default: process.env.STORE_A_MANUAL_URL_DEFAULT,
    },
    manualTitles: {
      line: process.env.STORE_A_MANUAL_TITLE_LINE,
      todo: process.env.STORE_A_MANUAL_TITLE_TODO,
      default: process.env.STORE_A_MANUAL_TITLE_DEFAULT,
    },
  },
  nice_sweets: {
    channelAccessToken: process.env.STORE_B_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.STORE_B_CHANNEL_SECRET,
    liffId: process.env.STORE_B_LIFF_ID,
    richmenuBefore: process.env.STORE_B_RICHMENU_BEFORE,
    richmenuAfter: process.env.STORE_B_RICHMENU_AFTER,

    // ✅ ここを追加（複数URL対応）
    manualUrls: {
      line: process.env.STORE_B_MANUAL_URL_LINE,
      todo: process.env.STORE_B_MANUAL_URL_TODO,
      default: process.env.STORE_B_MANUAL_URL_DEFAULT,
    },
    manualTitles: {
      line: process.env.STORE_B_MANUAL_TITLE_LINE,
      todo: process.env.STORE_B_MANUAL_TITLE_TODO,
      default: process.env.STORE_B_MANUAL_TITLE_DEFAULT,
    },
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
app.use("/manuals", express.static(path.join(process.cwd(), "manuals")));
// manuals の静的ファイル提供を store ごとに設定
app.use("/:store/manuals", (req, res, next) => {
  const store = req.params.store;
  const dirPath = path.join(process.cwd(), "manuals", store);
  express.static(dirPath)(req, res, next);
});


// apply は権限チェックを通さずアクセス許可
app.get("/:store/apply", (req, res, next) => next());
app.post("/:store/apply/submit", (req, res, next) => next());

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
// 💰 給与計算ユーティリティ（あなたのDB構造対応版）
// ==============================

// "2025/11/25 18:24" などを Date に変換
function parseDT(str) {
  if (!str) return null;
  const s = str.replace(/-/g, "/");
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function diffMin(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}

// 1 勤務分を計算（総時間・休憩・深夜）
function calcOneWork(work, general) {
  const clockIn = parseDT(work.clockIn);
  const clockOut = parseDT(work.clockOut);
  const breakStart = parseDT(work.breakStart);
  const breakEnd = parseDT(work.breakEnd);

  const total = diffMin(clockIn, clockOut);
  const breakMin = diffMin(breakStart, breakEnd);
  const working = Math.max(0, total - breakMin);

  // 深夜（22:00-05:00）
  const nightStart = general.nightStart || "22:00"; // ex. "22:00"
  const nightEnd = general.nightEnd || "05:00";

  function toMin(hhmm) {
    const [h, m] = hhmm.split(":").map(n => parseInt(n));
    return h * 60 + m;
  }

  const ns = toMin(nightStart);
  const ne = toMin(nightEnd);

  let nightMinutes = 0;

  if (clockIn && clockOut) {
    const s = clockIn.getHours() * 60 + clockIn.getMinutes();
    const e = clockOut.getHours() * 60 + clockOut.getMinutes();

    // 深夜帯 intersects (簡易ロジック)
    if (!(e <= ns && s >= ne)) {
      const startInt = Math.max(s, ns);
      const endInt = Math.min(e, ne);
      if (endInt > startInt) nightMinutes += endInt - startInt;
    }
  }
  return { working, nightMinutes };
}

// 日ごと合計
function calcDaily(works, general) {
  let total = 0;
  let night = 0;

  works.forEach(w => {
    const r = calcOneWork(w, general);
    total += r.working;
    night += r.nightMinutes;
  });

  const otThreshold = 8 * 60; // 1 日 8 時間
  const overtime = total > otThreshold ? total - otThreshold : 0;
  const normal = total - overtime;

  return { normal, overtime, night };
}

// 締め日 → 期間計算
function getPeriod(monthStr, closingDay) {
  const [y, m] = monthStr.split("-").map(n => parseInt(n));

  const close = Number(closingDay || 25);

  const end = new Date(y, m - 1, close);
  const start = new Date(y, m - 2, close + 1);

  const pad = n => (n < 10 ? "0" + n : n);

  return {
    startDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    endDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
  };
}

// ▼ 給与計算メイン
async function calcPayroll(db, store, userId, period) {
  // 店舗設定
  const generalSnap = await db
    .collection("companies")
    .doc(store)
    .collection("settings")
    .doc("storeGeneral")
    .get();
  const general = generalSnap.exists ? generalSnap.data() : {};

  // スタッフ設定
  const staffSnap = await db
    .collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .get();
  const staff = staffSnap.exists ? staffSnap.data() : {};

  const hourly = staff.salary?.hourly || general.defaultHourlyWage || 0;
  const monthly = staff.salary?.monthly || 0;
  const nightRate = general.nightRate || 1.25;
  const overtimeRate = general.overtimeRate || 1.25;

  // 勤怠取得
  const attendanceRef = db
    .collection("companies")
    .doc(store)
    .collection("attendance")
    .doc(userId)
    .collection("records");

  const snap = await attendanceRef
    .where("date", ">=", period.startDate)
    .where("date", "<=", period.endDate)
    .get();

  let totalNormal = 0;
  let totalOver = 0;
  let totalNight = 0;

  const daily = [];

  snap.forEach(doc => {
    const d = doc.data();
    const r = calcDaily(d.works || [], general);

    totalNormal += r.normal;
    totalOver += r.overtime;
    totalNight += r.night;

    daily.push({ date: d.date, ...r });
  });

  // 給与計算
  const perMin = hourly / 60;

  const normalPay = Math.round(totalNormal * perMin);
  const overtimePay = Math.round(totalOver * perMin * (overtimeRate - 1));
  const nightPay = Math.round(totalNight * perMin * (nightRate - 1));

  const totalPay =
    (staff.employmentType === "正社員" ? monthly : 0) +
    normalPay + overtimePay + nightPay;

  return {
    userId,
    name: staff.name,
    employmentType: staff.employmentType,
    hourly,
    monthly,
    totalNormal,
    totalOver,
    totalNight,
    normalPay,
    overtimePay,
    nightPay,
    totalPay,
    daily
  };
}

app.get("/:store/login", ensureStore, (req, res) => {
  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <title>${req.store} 管理者ログイン</title>

  <style>
    body {
      font-family: 'Noto Sans JP', sans-serif;
      background: #f3f4f6;
      margin: 0;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }

    .login-card {
      background: white;
      padding: 32px 28px;
      border-radius: 16px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(5px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    h1 {
      text-align: center;
      color: #2563eb;
      font-size: 20px;
      margin-bottom: 22px;
    }

    form {
      margin: 0;
    }

    /* スマホズーム防止 + 幅ぴったりに揃える */
    input, button {
      font-size: 16px !important;
      width: 100%;
      box-sizing: border-box; /* ← これでボタンと入力欄の幅が揃う */
    }

    .login-input {
      padding: 14px;
      margin-bottom: 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #f9fafb;
      transition: 0.2s;
      display: block;
    }

    .login-input:focus {
      border-color: #2563eb;
      outline: none;
      background: white;
      box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
    }

    .login-btn {
      padding: 14px;
      margin-top: 8px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
      transition: background 0.2s;
      display: block;
    }

    .login-btn:hover {
      background: #1d4ed8;
    }
  </style>

  </head><body>

    <div class="login-card">
      <h1>${req.store} 管理者ログイン</h1>

      <form method="POST" action="/${req.store}/login">
        <input type="text" name="user" placeholder="ユーザーID" required class="login-input">
        <input type="password" name="pass" placeholder="パスワード" required class="login-input">
        <button class="login-btn">ログイン</button>
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
    res.send(`
    <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ログイン失敗</title>

    <style>
      body {
        font-family: 'Noto Sans JP', sans-serif;
        background: #f3f4f6;
        margin: 0;
        height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 16px;
      }

      .card {
        background: white;
        padding: 32px 28px;
        border-radius: 14px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.1);
        text-align: center;
        max-width: 360px;
        width: 100%;
        animation: fadeIn 0.25s ease;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .title {
        font-size: 22px;
        font-weight: 700;
        color: #dc2626;
        margin-bottom: 18px;
      }

      .msg {
        font-size: 15px;
        color: #6b7280;
        margin-bottom: 26px;
      }

      .back-btn {
        display: inline-block;
        padding: 12px 24px;
        background: #2563eb;
        color: white;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 600;
        transition: background 0.2s;
      }

      .back-btn:hover {
        background: #1d4ed8;
      }
    </style>

    </head><body>
      <div class="card">
        <div class="title">ログイン失敗</div>
        <div class="msg">ユーザーID または パスワードが違います。</div>
        <a href="javascript:history.back()" class="back-btn">← 戻る</a>
      </div>
    </body></html>
    `);
  }
});


// 🔓 ログアウト
app.get("/logout", (req, res) => {
  const store = req.session?.store || "storeA";
  req.session.destroy(() => {
    res.redirect(`/${store}/login`);
  });
});

app.get("/:store/admin", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 管理者TOP</title>
    <style>
      body {
        font-family: 'Noto Sans JP', sans-serif;
        background:#f9fafb;
        margin:0;
        padding:20px;
      }
      h1 {
        text-align:center;
        color:#2563eb;
        margin-bottom:20px;
      }
      .nav {
        display:flex;
        justify-content:center;
        gap:10px;
        flex-wrap:wrap;
        margin-bottom:16px;
      }
      .nav a {
        background:#2563eb;
        color:white;
        text-decoration:none;
        padding:10px 18px;
        border-radius:6px;
        transition:background 0.2s;
      }
      .nav a:hover {
        background:#1e40af;
      }
      .filters {
        display:flex;
        justify-content:center;
        align-items:center;
        gap:12px;
        flex-wrap:wrap;
        margin-top:10px;
      }
      input[type="text"] {
        padding:8px;
        border:1px solid #ccc;
        border-radius:6px;
        width:200px;
      }
      .switch {
        position:relative;
        display:inline-block;
        width:46px;
        height:24px;
      }
      .switch input { display:none; }
      .slider {
        position:absolute;
        cursor:pointer;
        top:0; left:0;
        right:0; bottom:0;
        background-color:#ccc;
        border-radius:24px;
        transition:.3s;
      }
      .slider:before {
        position:absolute;
        content:"";
        height:18px;
        width:18px;
        left:3px;
        bottom:3px;
        background-color:white;
        border-radius:50%;
        transition:.3s;
      }
      input:checked + .slider {
        background-color:#2563eb;
      }
      input:checked + .slider:before {
        transform:translateX(22px);
      }
      table {
        width:95%;
        margin:20px auto;
        border-collapse:collapse;
        background:white;
        border-radius:8px;
        overflow:hidden;
        font-size:14px;
      }
      th, td {
        padding:8px;
        border-bottom:1px solid #eee;
        text-align:center;
      }
      th {
        background:#2563eb;
        color:white;
      }
      tr:nth-child(even){ background:#f9fafb; }
      tr:hover {
        background:#e0f2fe;
        cursor:pointer;
      }
      button {
        padding:4px 8px;
        border:none;
        border-radius:4px;
        cursor:pointer;
        color:white;
      }
      .btn-approve { background:#16a34a; }
      .btn-revoke { background:#f59e0b; }
      .btn-delete { background:#dc2626; }
      .empty { color:#6b7280; padding:12px; }
      footer {
        margin-top:30px;
        text-align:center;
        color:#6b7280;
        font-size:13px;
      }
      .btn-edit {
        background:#3b82f6;
        color:white;
        border:none;
        padding:4px 6px;
        border-radius:4px;
        cursor:pointer;
      }
      .btn-edit:hover { background:#2563eb; }
      .pagination {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        margin-top: 20px;
      }

      .page-numbers {
        display: flex;
        gap: 4px;
      }

      .page-num {
        padding: 6px 10px;
        border: 1px solid #ccc;
        cursor: pointer;
        border-radius: 4px;
        font-size: 14px;
        background: #f7f7f7;
      }

      .page-num.active {
        background: #000;
        color: #fff;
        border-color: #000;
      }

      .p-btn {
        padding: 6px 12px;
        border: 1px solid #ddd;
        background: #fff;
        cursor: pointer;
        border-radius: 4px;
        color: #333;
      }

      .p-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-search {
        padding:6px 12px;
        margin-left:8px;
        background:#2563eb;
        color:white;
        border:none;
        border-radius:4px;
        cursor:pointer;
      }
      .btn-clear {
        padding:6px 12px;
        margin-left:4px;
        background:#e5e7eb;
        color:#333;
        border:none;
        border-radius:4px;
        cursor:pointer;
      }
      /* === 検索行を横並びに === */
      .search-row {
        display: flex;
        align-items: center;
        gap: 8px;              /* ボタンとの隙間 */
        margin-bottom: 10px;
      }

      #searchInput {
        flex: 1;               /* 検索欄を広く */
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid #ccc;
      }

      /* 検索ボタン */
      .search-btn {
        background: #2563eb;
        color: white;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        cursor: pointer;
      }

      /* クリアボタン */
      .clear-btn {
        background: #e5e7eb;
        color: #333;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        cursor: pointer;
      }
      /* 承認済みのみ + スイッチ を横並び中央揃え */
      .approve-filter {
        display: flex;
        align-items: center;   /* ← これが中央揃えの本体 */
        gap: 10px;
        margin-bottom: 10px;
      }

      /* テキストの位置調整 */
      .approve-label {
        font-size: 14px;
        color: #333;
      }

    </style>

  </head>
  <body>
    <h1>${store} 管理画面</h1>

    <!-- ✅ ボタン群 -->
    <div class="nav">
      <!-- 
        <a href="/${store}/admin/attendance">勤怠管理</a>
        <a href="/${store}/admin/fix">打刻修正依頼</a>
        <a href="/${store}/admin/settings">店舗設定</a>
      -->
      <a href="/${store}/admin/manual-logs"
        style="display:block;margin-top:20px;padding:12px;
                background:#2563eb;color:white;border-radius:8px;
                text-align:center;text-decoration:none;">
        マニュアル閲覧ログ
      </a>
    </div>

    <!-- ✅ 検索・フィルタ -->
    <div class="filters">
      <div class="search-row">
        <input type="text" id="searchInput" placeholder="名前で検索…">
        
        <button id="searchBtn" class="search-btn">検索</button>
        <button id="clearBtn" class="clear-btn">クリア</button>
      </div>

      <div class="approve-filter">
        <span class="approve-label">承認済みのみ</span>
        <label class="switch">
          <input type="checkbox" id="approvedOnly">
          <span class="slider"></span>
        </label>
      </div>

    </div>

    <!-- ✅ スタッフ一覧 -->
    <table id="staffTable">
      <thead>
        <tr><th>名前</th><th>承認状態</th><th>承認</th><th>解除</th><th>削除</th></tr>
      </thead>
      <tbody id="staffBody"><tr><td colspan="5" class="empty">読み込み中...</td></tr></tbody>
    </table>

    <div id="pagination" class="pagination">
      <button id="prevPage" class="p-btn">前へ</button>

      <div id="pageNumbers" class="page-numbers"></div>

      <button id="nextPage" class="p-btn">次へ</button>
    </div>


    <footer>© ${new Date().getFullYear()} ${store} 管理システム</footer>

    <script>
      const store = "${store}";
      let timer = null;
      let staffData = [];

      document.addEventListener("DOMContentLoaded", async () => {
        await loadStaff();
        document.getElementById("approvedOnly").addEventListener("change", renderFiltered);
      });

      let currentOffset = 0;
      const limit = 20;

      // ページ読み込み
      async function loadStaff(offset = 0, isSearch = false) {
        const keyword = document.getElementById("searchInput").value;

        const url =
          "/" + store + "/admin/search-staff"
          + "?limit=" + limit
          + "&offset=" + offset
          + "&keyword=" + encodeURIComponent(keyword);

        const res = await fetch(url);
        const json = await res.json();

        staffData = json.data;
        currentOffset = offset;

        renderFiltered();
        updatePagination(json.nextOffset, json.total);
      }


      function updatePagination(nextOffset, totalItems) {
        const totalPages = Math.ceil(totalItems / limit);
        const currentPage = (currentOffset / limit) + 1;

        // ＜ 前のページへ ボタン制御
        const prevBtn = document.getElementById("prevPage");
        prevBtn.disabled = currentPage === 1;
        prevBtn.onclick = () => {
          if (currentPage > 1) loadStaff((currentPage - 2) * limit);
        };

        // ＞ 次のページへ ボタン制御
        const nextBtn = document.getElementById("nextPage");
        nextBtn.disabled = currentPage >= totalPages;
        nextBtn.onclick = () => {
          if (currentPage < totalPages) loadStaff(currentPage * limit);
        };

        // --- ページ番号の描画 ---
        const pageArea = document.getElementById("pageNumbers");
        pageArea.innerHTML = "";

        //「…」を表示する境界（例：1,2,3,4,…84）
        const pagesToShow = [];

        if (totalPages <= 7) {
          // 全部表示（1〜7ページ以内）
          for (let i = 1; i <= totalPages; i++) pagesToShow.push(i);
        } else {
          pagesToShow.push(1);
          if (currentPage > 3) pagesToShow.push("...");

          const start = Math.max(2, currentPage - 1);
          const end   = Math.min(totalPages - 1, currentPage + 1);

          for (let i = start; i <= end; i++) pagesToShow.push(i);

          if (currentPage < totalPages - 2) pagesToShow.push("...");
          pagesToShow.push(totalPages);
        }

        // 要素生成
        pagesToShow.forEach(p => {
          const div = document.createElement("div");

          if (p === "...") {
            div.textContent = "...";
            div.className = "page-num";
            div.style.cursor = "default";
          } else {
            div.textContent = p;
            div.className = "page-num" + (p === currentPage ? " active" : "");

            div.onclick = () => {
              loadStaff((p - 1) * limit);
            };
          }
          pageArea.appendChild(div);
        });
      }

      document.getElementById("searchBtn").addEventListener("click", () => {
        currentOffset = 0;
        loadStaff(0, true);
      });

      document.getElementById("clearBtn").addEventListener("click", () => {
        document.getElementById("searchInput").value = "";
        currentOffset = 0;
        loadStaff(0, true);
      });

      function renderFiltered() {
        const keyword = document.getElementById("searchInput").value;
        const approvedOnly = document.getElementById("approvedOnly").checked;
        const filtered = staffData.filter(s =>
          s.name.includes(keyword) && (!approvedOnly || s.approved)
        );
        renderTable(filtered);
      }

      function editStaff(userId) {
        window.location.href = "/" + store + "/admin/staff/" + userId + "/edit";
      }

      function renderTable(data) {
        const tbody = document.getElementById("staffBody");
        if (!data.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">該当するスタッフがいません</td></tr>';
          return;
        }

      tbody.innerHTML = data.map(s => {
        return (
          '<tr>' +
            <!-- '<td onclick="viewAttendance(&quot;' + s.id + '&quot;)">' + s.name + '</td>' + -->
            '<td>' + s.name + '</td>' + 
            '<td>' + (s.approved ? "✅ 承認済み" : "⏳ 承認待ち") + '</td>' +
            '<td><button class="btn-approve" onclick="event.stopPropagation(); updateStatus(&quot;' + s.id + '&quot;, true)">承認</button></td>' +
            '<td><button class="btn-revoke" onclick="event.stopPropagation(); updateStatus(&quot;' + s.id + '&quot;, false)">解除</button></td>' +
            '<td><button class="btn-delete" onclick="event.stopPropagation(); deleteStaff(&quot;' + s.id + '&quot;)">削除</button></td>' +
          '</tr>'
        );
      }).join("");

      }


      function viewAttendance(userId) {
        window.location.href = \`/${store}/admin/attendance?userId=\${userId}\`;
      }

      async function updateStatus(userId, approve) {
        if(!confirm(approve ? "このスタッフを承認しますか？" : "承認を解除しますか？")) return;
        await fetch(\`/${store}/admin/update-staff\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, approve })
        });
        await loadStaff();
      }

      async function deleteStaff(userId) {
        if(!confirm("このスタッフを削除しますか？")) return;
        await fetch(\`/${store}/admin/delete-staff\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId })
        });
        await loadStaff();
      }
    </script>
  </body>
  </html>
  `);
});

app.get("/:store/admin/staff/:userId/edit", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params } = req;
  const userId = params.userId;

  const doc = await db.collection("companies").doc(store)
    .collection("permissions").doc(userId).get();

  const data = doc.data() || {};

  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>スタッフ編集</title>
      <style>
        body { font-family:sans-serif; padding:20px; background:#f9fafb; }
        .box { background:white; padding:20px; border-radius:10px; max-width:400px; margin:auto; }
        input, select { width:100%; padding:8px; margin:8px 0; border:1px solid #ccc; border-radius:6px; }
        button { padding:10px; width:100%; border:none; background:#2563eb; color:white; border-radius:6px; font-size:1rem; cursor:pointer; }
        button:hover { background:#1d4ed8; }
      </style>
    </head>
    <body>
      <h2>スタッフ情報編集</h2>

      <div class="box">
        <form method="POST" action="/${store}/admin/staff/${userId}/edit">
          <label>雇用区分</label>
          <select name="employmentType">
            <option value="アルバイト" ${data.employmentType==="アルバイト"?"selected":""}>アルバイト</option>
            <option value="パート" ${data.employmentType==="パート"?"selected":""}>パート</option>
            <option value="正社員" ${data.employmentType==="正社員"?"selected":""}>正社員</option>
          </select>

          <label>基本時給</label>
          <input type="number" name="hourlyWage" value="${data.hourlyWage || ""}" required>

          <label>深夜時給</label>
          <input type="number" name="nightWage" value="${data.nightWage || ""}">

          <label>交通費（1日）</label>
          <input type="number" name="transport" value="${data.transport || ""}">

          <button>保存する</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post("/:store/admin/staff/:userId/edit", ensureStore, async (req, res) => {
  const { store, params, body } = req;
  const userId = params.userId;

  await db.collection("companies").doc(store)
    .collection("permissions").doc(userId)
    .set({
      employmentType: body.employmentType,
      hourlyWage: Number(body.hourlyWage),
      nightWage: Number(body.nightWage),
      transport: Number(body.transport)
    }, { merge:true });

  res.send(`
    <html><body style="text-align:center;padding-top:40px;font-family:sans-serif;">
      <h3>保存しました</h3>
      <a href="/${store}/admin">← 管理画面へ戻る</a>
    </body></html>
  `);
});

// ==============================
// 🔄 承認・解除処理（リッチメニュー切り替え）
// ==============================
app.post("/:store/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { store, lineClient, storeConf } = req;
  const userId = req.body.id;
  await db.collection("companies").doc(store).collection("permissions").doc(userId)
    .set({ approved: true }, { merge: true });

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

  try {
    await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
  } catch (e) {
    console.error("初期リッチメニュー戻し失敗:", e.originalError?.response?.data || e);
  }

  res.redirect(`/${store}/admin`);
});

app.get("/:store/manual", ensureStore, (req, res) => {
  const { store, storeConf } = req;
  const { type } = req.query; // ?type=todo など

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${store} マニュアル</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  </head>
  <body>
    <p>LINEログイン中です...</p>
    <script>
      const liffId = "${storeConf.liffId}";
      const store  = "${store}";
      const type   = "${type || ""}";

      async function main() {
        try {
          await liff.init({ liffId });
          if (!liff.isLoggedIn()) {
            return liff.login({ redirectUri: location.href });
          }
          const p = await liff.getProfile();

          const params = new URLSearchParams();
          params.set("userId", p.userId);
          if (type) params.set("type", type);

          // ✅ 権限チェック + HTML表示をするルートへ
          location.href = "/" + store + "/manual-check?" + params.toString();
        } catch (e) {
          document.body.innerHTML =
            "<h3>LIFF初期化に失敗しました：" + e.message + "</h3>";
        }
      }
      main();
    </script>
  </body>
  </html>
  `);
});




app.get("/:store/manual-check", ensureStore, async (req, res) => {
  const { store } = req;
  const { type, userId } = req.query;

  if (!userId) return res.status(400).send("userId がありません（LIFFを経由してください）");

  const doc = await db.collection("companies").doc(store)
    .collection("permissions").doc(userId).get();

  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved)
    return res.status(403).send("承認待ちです。");

  // --- ログ保存（権限申請時の名前を取得して保存） ---
  const userDoc = await db
    .collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .get();

  const userName = userDoc.exists ? (userDoc.data().name || "名前未登録") : "名前未登録";

  // type を取得
  const title = req.query.type || "default";

  // --- マニュアルタイトルを .env から取得 ---
  const manualTitle =
    req.storeConf.manualTitles[title] ||
    req.storeConf.manualTitles.default ||
    "マニュアル";

await db
  .collection("companies")
  .doc(store)
  .collection("manualViews")
  .add({
    name: userName,
    title: manualTitle,
    viewedAt: admin.firestore.Timestamp.now()
  });



  // ★ manual-view を必ず経由させる（静的URLは公開しない）
  return res.redirect(`/${store}/manual-view?userId=${userId}&type=${type}`);
});




// ============================================
// 🔐 毎回権限をチェックしてマニュアルに飛ばす中継ページ
// ============================================
// app.get("/:store/manual-redirect", ensureStore, async (req, res) => {
//   const store = req.store;
//   const url = req.query.url;
//   const userId = req.query.userId;

//   if (!url || !userId) {
//     return res.status(400).send("必要なパラメータが不足しています。");
//   }

//   // Firestore権限チェック
//   const doc = await db
//     .collection("companies")
//     .doc(store)
//     .collection("permissions")
//     .doc(userId)
//     .get();

//   if (!doc.exists || !doc.data().approved) {
//     return res.status(403).send(`
//       <h2>権限がありません</h2>
//       <p>管理者が権限を外した可能性があります。</p>
//     `);
//   }

//   // OK → 本物のNotionに飛ばす
//   res.redirect(url);
// });

app.get("/:store/manual-render", ensureStore, async (req, res) => {
  const { store, storeConf } = req;
  const { type, userId } = req.query;

  if (!userId) return res.status(400).send("userId missing");

  // Firestore 権限チェック（ブラウザからでも防ぐ）
  const doc = await db.collection("companies").doc(store)
    .collection("permissions").doc(userId).get();

  if (!doc.exists) return res.status(404).send("権限申請が未登録です。");
  if (!doc.data().approved) return res.status(403).send("承認待ちです。");

  // 生URL選択（storeConf の構造に完全対応）
  const urls = storeConf.manualUrls || {};
  const targetUrl =
    (type && urls[type]) ||
    urls.default ||
    storeConf.manualUrl;

  if (!targetUrl) return res.status(404).send("マニュアルURLが設定されていません。");

  try {
    const upstream = await fetch(targetUrl);
    const html = await upstream.text();

    // cheerio 初期化
    const $ = cheerio.load(html);

    // 🔥 Notion のスクリプトを完全削除
    $("script").remove();

    // 🔥 Notion の meta / link にある CSP も削除
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('link[rel="preconnect"]').remove();

    // 本文抽出（改良版）
    let content =
      $(".notion-page-content").html() ||
      $("main .notion-page-content").html() ||
      $("article").html() ||
      $(".notion-text").html() ||
      $("main").html() ||
      $("body").html();

    if (!content || content.trim() === "") {
      content = "<p>本文の抽出に失敗しました。</p>";
    }

    // 画像の proxy 化
    const $$ = cheerio.load(content);
    $$("img").each((i, el) => {
      let src = $$(el).attr("src");
      if (!src) return;

      // ① "storeA/1.png" など相対パス → /{store}/manuals/{元のパス}
      if (!src.startsWith("http")) {
        src = "/" + store + "/manuals/" + src.replace(/^\//, "");
      }

      $$(el).attr("src", src);
    });

    content = $$.html();

    // ★ ここを返す
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <style>
    body { font-family: sans-serif; padding: 20px; line-height: 1.6; }
    img { max-width: 100%; height: auto; }
    </style>
    </head>
    <body>
    ${content}
    </body>
    </html>
    `);


  } catch (e) {
    console.error("manual-render error:", e);
    res.status(500).send("マニュアルの取得中にエラーが発生しました。");
  }
});


app.get("/manual-asset", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url missing");

  try {
    const upstream = await fetch(url);
    res.setHeader("Content-Type", upstream.headers.get("content-type"));
    upstream.body.pipe(res);
  } catch {
    res.status(500).send("asset fetch error");
  }
});


app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url missing");

  const upstream = await fetch(url);
  const contentType = upstream.headers.get("content-type");
  res.setHeader("Content-Type", contentType);

  upstream.body.pipe(res);
});

// ==============================
// 🧾 権限申請フォーム（完全版 LIFF）
// ==============================
app.get("/:store/apply", ensureStore, (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 権限申請</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>

    <style>
      body { 
        font-family: sans-serif; background:#f9fafb; 
        display:flex; justify-content:center; align-items:center; 
        height:100vh; margin:0;
      }
      .box {
        background:white; padding:24px; border-radius:12px; 
        box-shadow:0 2px 10px rgba(0,0,0,0.1); width:90%; 
        max-width:360px; text-align:center;
      }
      h1 { font-size:1.4rem; color:#2563eb; margin-bottom:16px; }
      input {
        width:100%; padding:10px; font-size:1rem;
        border:1px solid #ccc; border-radius:6px;
        margin-bottom:12px;
      }
      button {
        width:100%; padding:10px; font-size:1rem;
        background:#2563eb; color:white;
        border:none; border-radius:6px; cursor:pointer;
      }
      button:hover { background:#1e40af; }
    </style>
  </head>

  <body>
    <div class="box">
      <h1>${store} 権限申請</h1>
      <form id="applyForm" method="POST" action="/${store}/apply/submit">
        <input type="hidden" id="userId" name="userId" />
        <input type="text" id="name" name="name" placeholder="名前を入力" required />
        <button type="submit">申請する</button>
      </form>
    </div>

    <script>
    document.addEventListener("DOMContentLoaded", async () => {
      try {
        await liff.init({ liffId: "${storeConf.liffId}" });

        // LINEアプリ外でのログインは redirectUri を付けない
        if (!liff.isLoggedIn()) {
          liff.login({
            redirectUri: window.location.href   // ← apply に戻るようにする
          });
          return;
        }

        const profile = await liff.getProfile();
        document.getElementById("userId").value = profile.userId;

      } catch (e) {
        document.body.innerHTML =
          "<div style='padding:20px;'>LIFF初期化エラー<br>" + e.message + "</div>";
      }
    });
    </script>

  </body>
  </html>
  `);
});


app.post("/:store/apply/submit", ensureStore, async (req, res) => {
  const { store, lineClient, storeConf } = req;
  const { userId, name } = req.body;

  if (!userId || !name)
    return res.status(400).send("名前またはLINE情報が取得できませんでした。");

  await db.collection("companies").doc(store)
    .collection("permissions").doc(userId)
    .set(
      { name, approved: false, requestedAt: new Date() },
      { merge: true }
    );

  // 初期リッチメニュー設定
  if (storeConf.richmenuBefore) {
    await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
  }

  res.send(`
    <html><body style="text-align:center; padding-top:30vh;">
      <h2>申請を受け付けました！</h2>
      <p>管理者の承認をお待ちください。</p>
    </body></html>
  `);
});


// ==============================
// 🕒 従業員勤怠打刻画面（修正申請付き）
// ==============================
// ==============================
// 🕒 従業員勤怠打刻画面（修正申請＋UI改良版）
// ==============================
app.get("/:store/attendance", ensureStore, (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${store} 勤怠打刻</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body { font-family: sans-serif; background: #f9fafb; padding: 16px; margin:0; }
      .card { background:white; border-radius:8px; padding:16px; box-shadow:0 2px 8px rgba(0,0,0,0.1); max-width:480px; margin:16px auto; }
      h1 { color:#2563eb; text-align:center; margin-top:0; }
      #status { text-align:center; margin-bottom:12px; color:#4b5563; }

      .grid-2x2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .action-card { background:#f3f4f6; border-radius:8px; padding:8px; text-align:center; }
      .action-title { font-size:0.9rem; margin-bottom:4px; }
      .action-time { font-size:1.1rem; font-weight:bold; margin-bottom:4px; }
      .action-btn { width:100%; padding:6px 0; border:none; border-radius:6px; color:white; font-size:0.9rem; cursor:pointer; }
      .btn-in { background:#16a34a; }
      .btn-out { background:#dc2626; }
      .btn-break-start { background:#f59e0b; }
      .btn-break-end { background:#2563eb; }
      .btn-fix {
        display: block;
        width: 100%;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 14px;
        font-size: 1rem;
        font-weight: bold;
        text-align: center;
        margin-top: 20px;
        cursor: pointer;
        transition: background 0.2s, transform 0.1s;
      }
      .btn-fix:hover {
        background: #1e40af;
        transform: translateY(-2px);
      }
      .btn-fix:active {
        background: #1d4ed8;
        transform: translateY(0);
      }

      .filter-row { margin-top:16px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .filter-row label { font-size:0.9rem; }
      input[type="month"] { padding:4px 6px; border-radius:6px; border:1px solid #d1d5db; }

      /* ✅ 横スクロール対応 */
      .table-wrapper { width:100%; overflow-x:auto; margin-top:12px; -webkit-overflow-scrolling:touch; }
      table { width:100%; border-collapse:collapse; background:white; font-size:13px; min-width:700px; }
      th, td { border:1px solid #e5e7eb; padding:6px; text-align:center; white-space:nowrap; }
      th { background-color:#2563eb; color:white; }
      tr:nth-child(even){ background:#f9fafb; }

      /* ✅ モーダル */
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; padding:20px; border-radius:8px; width:90%; max-width:400px; max-height:80%; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
      .modal-content h3 { margin:0; color:#2563eb; text-align:center; }
      .modal-content input, .modal-content textarea { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; }
      .modal-content textarea { height:80px; resize:none; }
      .time-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .btn-send { background:#2563eb; color:white; border:none; border-radius:6px; padding:8px; cursor:pointer; }
      .btn-close { background:#dc2626; color:white; border:none; border-radius:6px; padding:8px; cursor:pointer; }
      .current-record { background:#f3f4f6; border-radius:6px; padding:8px; font-size:14px; }
      /* 🔵 モーダル背景 */
      .modal {
        display:none;
        position:fixed;
        top:0; left:0;
        width:100%; height:100%;
        background:rgba(0,0,0,0.4);
        align-items:center;
        justify-content:center;
        z-index:1000;
      }

      /* 🔵 モーダルボックス */
      .modal-content {
        background:white;
        width:90%;
        max-width:420px;
        padding:24px;
        border-radius:12px;
        box-shadow:0 4px 12px rgba(0,0,0,0.2);
      }

      /* タイトル */
      .modal-title {
        text-align:center;
        margin-bottom:20px;
        font-size:18px;
        color:#2563eb;
      }

      /* ラベル＋入力 */
      .form-group {
        margin-bottom:16px;
      }

      .form-group label {
        font-size:14px;
        color:#374151;
        display:block;
        margin-bottom:6px;
      }

      .row {
        display:flex;
        gap:8px;
        margin-bottom:10px;
      }

      .input-date,
      .input-time,
      .input-textarea {
        width:100%;
        padding:10px;
        border:1px solid #d1d5db;
        border-radius:6px;
        font-size:14px;
      }

      /* 現在の記録 */
      .current-record {
        background:#f3f4f6;
        padding:10px;
        border-radius:6px;
        margin-bottom:16px;
        font-size:14px;
      }

      /* ボタン */
      .modal-buttons {
        display:flex;
        justify-content:space-between;
        margin-top:20px;
      }

      .btn-save {
        background:#2563eb;
        color:white;
        padding:10px 20px;
        border:none;
        border-radius:8px;
        cursor:pointer;
        font-size:14px;
        flex:1;
        margin-right:8px;
      }

      .btn-close {
        background:#dc2626;
        color:white;
        padding:10px 20px;
        border:none;
        border-radius:8px;
        cursor:pointer;
        font-size:14px;
        flex:1;
        margin-left:8px;
      }

      .btn-save:hover { background:#1d4ed8; }
      .btn-close:hover { background:#b91c1c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${store} 勤怠管理</h1>
      <div id="status">LINEログイン中...</div>

      <div class="grid-2x2">
        <div class="action-card">
          <div class="action-title">出勤</div>
          <div class="action-time" id="timeIn">--:--</div>
          <button id="btnIn" class="action-btn btn-in">出勤</button>
        </div>
        <div class="action-card">
          <div class="action-title">退勤</div>
          <div class="action-time" id="timeOut">--:--</div>
          <button id="btnOut" class="action-btn btn-out">退勤</button>
        </div>
        <div class="action-card">
          <div class="action-title">休憩開始</div>
          <div class="action-time" id="timeBreakStart">--:--</div>
          <button id="btnBreakStart" class="action-btn btn-break-start">休憩開始</button>
        </div>
        <div class="action-card">
          <div class="action-title">休憩終了</div>
          <div class="action-time" id="timeBreakEnd">--:--</div>
          <button id="btnBreakEnd" class="action-btn btn-break-end">休憩終了</button>
        </div>
      </div>

      <button id="btnFix" class="btn-fix">打刻修正を申請する</button>

      <div class="filter-row">
        <label for="monthSelect">対象月</label>
        <input type="month" id="monthSelect">
      </div>

      <div class="table-wrapper">
        <table id="recordsTable">
          <thead>
            <tr>
              <th>日付</th><th>出勤</th><th>退勤</th><th>休憩開始</th><th>休憩終了</th>
            </tr>
          </thead>
          <tbody id="recordsBody"></tbody>
        </table>
      </div>
    </div>

    <!-- ✅ 修正申請モーダル -->
    <!-- 🔵 打刻修正申請モーダル（統一デザイン） -->
    <div id="modal" class="modal">
      <div class="modal-content">

        <h3 class="modal-title">打刻時間修正申請</h3>

        <!-- 修正対象日 -->
        <div class="form-group">
          <label>修正対象日</label>
          <input type="date" id="reqDate" class="input-date">
        </div>

        <!-- 現在の記録 -->
        <div class="current-record" id="currentRecord">
          現在の記録: データ取得中...
        </div>

        <!-- 修正後 -->
        <div class="form-group">
          <label>修正後の日付・時間</label>

          <div class="row">
            <input type="date" id="newDateIn" class="input-date">
            <input type="time" id="newClockIn" class="input-time">
          </div>

          <div class="row">
            <input type="date" id="newDateOut" class="input-date">
            <input type="time" id="newClockOut" class="input-time">
          </div>

          <div class="row">
            <input type="date" id="newDateBreakStart" class="input-date">
            <input type="time" id="newBreakStart" class="input-time">
          </div>

          <div class="row">
            <input type="date" id="newDateBreakEnd" class="input-date">
            <input type="time" id="newBreakEnd" class="input-time">
          </div>
        </div>

        <!-- 修正理由 -->
        <div class="form-group">
          <label>修正理由</label>
          <textarea id="reqMessage" class="input-textarea"
            placeholder="打刻忘れ・誤打刻などの理由を記載してください"></textarea>
        </div>

        <!-- ボタン -->
        <div class="modal-buttons">
          <button class="btn-save" onclick="submitRequest()">申請</button>
          <button class="btn-close" onclick="closeModal()">閉じる</button>
        </div>

      </div>
    </div>



    <script>
      let userId, name, allRecords = [];
      const STORE = "${store}";


      async function main() {
        try {
          await liff.init({ liffId: "${storeConf.liffId}" });

          // ✅ location.pathname が /manual の場合のみ manual処理に進む
          if (location.pathname.includes("/manual")) return;

          if (!liff.isLoggedIn()) {
            const redirect = location.origin + "/" + STORE + "/attendance";
            liff.login({ redirectUri: redirect });
            return;
          }

          const p = await liff.getProfile();
          userId = p.userId;
          name = p.displayName;
          document.getElementById("status").innerText = name + " さんログイン中";

          initMonthSelector();
          await loadRecords();
        } catch (e) {
          console.error("LIFF初期化エラー:", e);
          document.getElementById("status").innerText = "ログインエラーが発生しました";
        }
      }

      function timeOnly(str){ if(!str)return "--:--"; const p=String(str).split(" "); return p.length>1?p[1].slice(0,5):str.slice(-5); }
      function getTodayKey(){ const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); return jst.toISOString().slice(0,10); }
      function initMonthSelector(){ const m=document.getElementById("monthSelect"); const jst=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); m.value=jst.toISOString().slice(0,7); m.addEventListener("change",loadRecords); }

      async function sendAction(action, skipReload = false) {
        let message = "";

        switch (action) {
          case "clockIn":
            message = "出勤を記録しました。";
            break;
          case "clockOut":
            message = "退勤を記録しました。";
            break;
          case "breakStart":
            message = "休憩を開始しました。";
            break;
          case "breakEnd":
            message = "休憩を終了しました。";
            break;
          default:
            message = "打刻を記録しました。";
        }

        try {
          const res = await fetch("/${store}/attendance/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, name, action })
          });

          const text = await res.text();
          console.log("送信結果:", text);

          if (text.includes("打刻を記録しました")) {
            showToast(message); // ✅ 上中央に表示
          } else {
            showToast("エラー: " + text);
          }
          if (action === "clockOut") {
            document.getElementById("timeIn").innerText = "--:--";
            document.getElementById("timeOut").innerText = "--:--";
            document.getElementById("timeBreakStart").innerText = "--:--";
            document.getElementById("timeBreakEnd").innerText = "--:--";

            document.getElementById("btnIn").disabled = false;
            document.getElementById("btnOut").disabled = true;
          }
          if (!skipReload) loadRecords();

        } catch (error) {
          console.error(error);
          showToast("通信エラーが発生しました。");
        }
      }

      document.addEventListener("DOMContentLoaded", () => {


        const btnFix = document.getElementById("btnFix");
        if (btnFix) {
          btnFix.onclick = () => {
            window.location.href = "/${store}/attendance/fix";
          };
        }

        document.getElementById("btnIn").onclick = () => sendAction("clockIn");
        // 退勤ボタン押下
        document.getElementById("btnOut").onclick = () => sendAction("clockOut");
        document.getElementById("btnBreakStart").onclick = () => sendAction("breakStart");
        document.getElementById("btnBreakEnd").onclick = () => sendAction("breakEnd");
      });




      function closeModal() {
        document.getElementById("modal").style.display = "none";
      }

      function openModal(){
        const modal=document.getElementById("modal");
        modal.style.display="flex";
        const today=getTodayKey();
        const record=allRecords.find(r=>r.date===today);
        const recText = record
          ? \`出勤:\${record.clockIn||"--"} 退勤:\${record.clockOut||"--"} 休憩開始:\${record.breakStart||"--"} 休憩終了:\${record.breakEnd||"--"}\`
          : "記録がありません";
        document.getElementById("currentRecord").innerText = "現在の記録: " + recText;
        document.getElementById("reqDate").value = today;
      }
function mergeDT(date, time) {
  if (!date || !time) return "";
  // YYYY-MM-DD → YYYY/MM/DD
  const d = date.replace(/-/g, "/");
  return d + " " + time;   // T を入れない
}

async function submitRequest() {
  const date = document.getElementById("reqDate").value;
  const msg = document.getElementById("reqMessage").value;

  const after = {
    clockIn:     mergeDT(document.getElementById("newDateIn").value, document.getElementById("newClockIn").value),
    clockOut:    mergeDT(document.getElementById("newDateOut").value, document.getElementById("newClockOut").value),
    breakStart:  mergeDT(document.getElementById("newDateBreakStart").value, document.getElementById("newBreakStart").value),
    breakEnd:    mergeDT(document.getElementById("newDateBreakEnd").value, document.getElementById("newBreakEnd").value)
  };

  await fetch("/" + STORE + "/attendance/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      name,
      date,
      message: msg,
      after
    }),
  });

  alert("修正申請を送信しました。");
  closeModal();
}

  async function loadRecords() {
    const month = document.getElementById("monthSelect").value;

    const res = await fetch(
      "/${store}/attendance/records?userId=" + userId + "&month=" + month
    );
    const data = await res.json();
    allRecords = data;

    // テーブル描画
    const tbody = document.getElementById("recordsBody");
    tbody.innerHTML = data
      .map(function (r) {
        let works = r.works || [];
        let first = works[0] || {};
        let last = works[works.length - 1] || {};

        let breakStarts = works.map(w => timeOnly(w.breakStart)).join("<br>");
        let breakEnds   = works.map(w => timeOnly(w.breakEnd)).join("<br>");

        return (
          "<tr>" +
            "<td>" + (r.date || "--") + "</td>" +
            "<td>" + timeOnly(first.clockIn) + "</td>" +
            "<td>" + timeOnly(last.clockOut) + "</td>" +
            "<td>" + breakStarts + "</td>" +
            "<td>" + breakEnds + "</td>" +
          "</tr>"
        );
      })
      .join("");

    // ここから下が「ボタンに最新勤務を反映する処理」
    const today = getTodayKey();
    const todayRecord = data.find(r => r.date === today);

    let latestWork = null;

    if (todayRecord && todayRecord.works && todayRecord.works.length > 0) {
      latestWork = todayRecord.works[todayRecord.works.length - 1];
    }

    if (latestWork && !latestWork.clockOut) {
      // 出勤済み・未退勤
      document.getElementById("btnIn").disabled = true;
      document.getElementById("btnOut").disabled = false;

      document.getElementById("timeIn").innerText         = timeOnly(latestWork.clockIn);
      document.getElementById("timeBreakStart").innerText = timeOnly(latestWork.breakStart);
      document.getElementById("timeBreakEnd").innerText   = timeOnly(latestWork.breakEnd);
      document.getElementById("timeOut").innerText        = "--:--";

    } else {
      // 退勤済み or 勤務なし
      document.getElementById("btnIn").disabled = false;
      document.getElementById("btnOut").disabled = true;

      document.getElementById("timeIn").innerText         = timeOnly(latestWork ? latestWork.clockIn : null);
      document.getElementById("timeOut").innerText        = timeOnly(latestWork ? latestWork.clockOut : null);
      document.getElementById("timeBreakStart").innerText = timeOnly(latestWork ? latestWork.breakStart : null);
      document.getElementById("timeBreakEnd").innerText   = timeOnly(latestWork ? latestWork.breakEnd : null);
    }
  }

      function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.style.display = "block";

        // 少しフェードイン効果
        toast.style.transition = "opacity 0.3s ease";
        toast.style.opacity = "1";

        // 3秒後にフェードアウト
        setTimeout(() => {
          toast.style.transition = "opacity 0.5s ease";
          toast.style.opacity = "0";
          setTimeout(() => {
            toast.style.display = "none";
          }, 500);
        }, 2500);
      }

      main();
    </script>
    <div id="toast" style="
      display:none;
      position:fixed;
      top:30px;
      left:50%;
      transform:translateX(-50%);
      background:rgba(50,50,50,0.9);
      color:#fff;
      padding:12px 24px;
      border-radius:8px;
      font-size:15px;
      box-shadow:0 3px 10px rgba(0,0,0,0.2);
      z-index:9999;
      opacity:0.9;
      backdrop-filter:blur(4px);
    "></div>

  </body>
  </html>
  `);
});

// 🔹 店舗ごとに修正申請を保存
app.post("/:store/attendance/request", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, date, message, before, after } = req.body;

  try {
    const ref = db.collection("companies")
      .doc(store)
      .collection("attendanceRequests");

    await ref.add({
      userId,
      name,
      date,
      message,
      before,
      after,
      status: "承認待ち",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ Error saving attendance request:", err);
    res.status(500).json({ error: "保存に失敗しました。" });
  }
});

app.get("/:store/attendance/requests", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.query;
  if (!userId) return res.status(400).send("userId missing");

  try {
    const snapshot = await db
      .collection(`companies/${store}/attendanceRequests`)
      .where("userId", "==", userId)
      .get();

    const requests = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(requests);
  } catch (err) {
    console.error("attendance/requests Error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// 出退勤ステータス取得
app.get("/:store/attendance/status", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const doc = await db.collection("companies").doc(store)
    .collection("attendance").doc(`${userId}_${today}`).get();
  res.json(doc.exists ? doc.data() : {});
});

app.post("/:store/attendance/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, name, action } = req.body;

  // 現在の JST 時刻
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setSeconds(0, 0);

  const dateKey = jst.toISOString().split("T")[0]; // YYYY-MM-DD
  const timeString =
    jst.getFullYear() + "/" +
    (jst.getMonth() + 1) + "/" +
    jst.getDate() + " " +
    String(jst.getHours()).padStart(2, "0") + ":" +
    String(jst.getMinutes()).padStart(2, "0");

  const dayRef = db.collection("companies").doc(store)
    .collection("attendance").doc(userId)
    .collection("records").doc(dateKey);

  let daySnap = await dayRef.get();
  let dayData = daySnap.exists ? daySnap.data() : { works: [] };

  // 直近の勤務（配列 works の最後）
  let works = dayData.works || [];
  let current = works.length ? works[works.length - 1] : null;

  // 🔹 退勤済み or 勤務がない → 新しい勤務を追加
  if (!current || current.clockOut) {
    if (action !== "clockIn") {
      return res.send("まず出勤を押してください。");
    }

    works.push({
      clockIn: timeString,
      breakStart: "",
      breakEnd: "",
      clockOut: ""
    });
  } else {
    // 🔹 退勤していない勤務がある → その勤務に追加
    if (action === "clockIn") {
      return res.send("すでに出勤中です。退勤を押してください。");
    }
    if (action === "breakStart") {
      if (current.breakStart && !current.breakEnd)
        return res.send("すでに休憩中です。");
      current.breakStart = timeString;
    }
    if (action === "breakEnd") {
      if (!current.breakStart)
        return res.send("休憩開始を押してください。");
      current.breakEnd = timeString;
    }
    if (action === "clockOut") {
      current.clockOut = timeString;
    }

    works[works.length - 1] = current;
  }

  // 書き戻し
  await dayRef.set({ date: dateKey, userId, name, works });

  res.send("打刻しました（複数勤務対応版）");
});


app.get("/:store/admin/attendance", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 勤怠管理</title>
    <style>
      body { font-family:sans-serif; background:#f9fafb; margin:0; padding:16px; }
      h1 { color:#2563eb; text-align:center; }
      select, input { padding:6px; border:1px solid #ccc; border-radius:6px; margin:4px; }
      table { width:100%; border-collapse:collapse; margin-top:12px; background:white; border-radius:8px; overflow:hidden; }
      th,td { padding:8px; border-bottom:1px solid #eee; text-align:center; font-size:14px; white-space:nowrap; }
      th { background:#2563eb; color:white; }
      .summary { text-align:right; margin-top:10px; }
      .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items:center; justify-content:center; }
      .modal-content { background:white; padding:20px; border-radius:8px; max-width:320px; width:90%; }
      .table-wrapper { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      .modal {
        display:none;
        position:fixed;
        top:0; left:0;
        width:100%; height:100%;
        background:rgba(0,0,0,0.4);
        align-items:center;
        justify-content:center;
        z-index:1000;
      }

      .modal-content {
        background:white;
        width:90%;
        max-width:420px;
        padding:24px;
        border-radius:12px;
        box-shadow:0 4px 12px rgba(0,0,0,0.2);
      }

      .modal-title {
        text-align:center;
        margin-bottom:20px;
        font-size:18px;
        color:#2563eb;
      }

      .form-group {
        margin-bottom:16px;
      }

      .form-group label {
        font-size:14px;
        color:#374151;
        display:block;
        margin-bottom:4px;
      }

      .row {
        display:flex;
        gap:8px;
      }

      .input-date, .input-time {
        width:100%;
        padding:8px;
        border:1px solid #d1d5db;
        border-radius:6px;
        font-size:14px;
      }

      .modal-buttons {
        display:flex;
        justify-content:space-between;
        margin-top:24px;
      }

      .btn-save {
        background:#2563eb;
        color:white;
        padding:10px 20px;
        border:none;
        border-radius:6px;
        cursor:pointer;
        font-size:14px;
        flex:1;
        margin-right:8px;
      }

      .btn-close {
        background:#dc2626;
        color:white;
        padding:10px 20px;
        border:none;
        border-radius:6px;
        cursor:pointer;
        font-size:14px;
        flex:1;
        margin-left:8px;
      }

      .btn-save:hover {
        background:#1d4ed8;
      }

      .btn-close:hover {
        background:#b91c1c;
      }
    </style>
  </head>

  <div style="text-align:center; margin-top:24px;">
    <button onclick="location.href='/${store}/admin'" 
      style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
      ← TOPに戻る
    </button>
  </div>

  <body>
    <h1>${store} 勤怠管理</h1>

    <div>
      <label>対象月：</label>
      <input type="month" id="monthSelect">
      <label>スタッフ：</label>
      <select id="staffSelect"></select>
    </div>

    <div class="summary" id="summary"></div>

    <div class="table-wrapper">
      <table id="records">
        <thead>
          <tr>
            <th>時刻修正</th>
            <th>日付</th>
            <th>名前</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>休憩開始</th>
            <th>休憩終了</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

<div id="editModal" class="modal">
  <div class="modal-content">

    <!-- ★ これが無かったためエラーが発生していました！ -->
    <input type="hidden" id="editUserId">

    <h3 class="modal-title">勤怠修正</h3>

    <div class="form-group">
      <label>レコード日付</label>
      <input type="date" id="editBaseDate" class="input-date">
    </div>

    <div class="form-group">
      <label>出勤</label>
      <div class="row">
        <input type="date" id="editClockInDate" class="input-date">
        <input type="time" id="editClockIn" class="input-time">
      </div>
    </div>

    <div class="form-group">
      <label>退勤</label>
      <div class="row">
        <input type="date" id="editClockOutDate" class="input-date">
        <input type="time" id="editClockOut" class="input-time">
      </div>
    </div>

    <div class="form-group">
      <label>休憩開始</label>
      <div class="row">
        <input type="date" id="editBreakStartDate" class="input-date">
        <input type="time" id="editBreakStart" class="input-time">
      </div>
    </div>

    <div class="form-group">
      <label>休憩終了</label>
      <div class="row">
        <input type="date" id="editBreakEndDate" class="input-date">
        <input type="time" id="editBreakEnd" class="input-time">
      </div>
    </div>

    <div class="modal-buttons">
      <button class="btn-save" onclick="saveEdit()">保存する</button>
      <button class="btn-close" onclick="closeEditModal()">閉じる</button>
    </div>

  </div>
</div>




    <script>
      const store = "${store}";
      let allStaff = [], allRecords = [];

      async function init() {
        const now = new Date();
        document.getElementById("monthSelect").value = now.toISOString().slice(0, 7);
        await loadStaff();
        await loadRecords(); // 初期表示＝全てのスタッフ
      }
      document.getElementById("monthSelect").addEventListener("change", loadRecords);

      async function loadStaff() {
        const res = await fetch("/${store}/admin/staff");
        allStaff = await res.json();
        const sel = document.getElementById("staffSelect");
        sel.innerHTML = '<option value="">全て</option>' + allStaff.map(s => 
          \`<option value="\${s.id}">\${s.name}</option>\`
        ).join("");
        sel.onchange = loadRecords;
      }

      // ✅ Firestore Timestamp対応版
      function formatTime(ts){
        if(!ts) return "--:--";
        try{
          if(ts._seconds) return new Date(ts._seconds * 1000).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Tokyo"});
          if(typeof ts === "string" && ts.includes("T")) return new Date(ts).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Tokyo"});
          return String(ts).slice(0,5);
        }catch{ return "--:--"; }
      }

      async function loadRecords(){
        const selectedId = document.getElementById("staffSelect").value;
        const month = document.getElementById("monthSelect").value;

        const res = await fetch("/${store}/admin/all-attendance?month=" + month);
        allRecords = await res.json();

        const filtered = selectedId 
          ? allRecords.filter(r => r.userId === selectedId) 
          : allRecords;

        renderTable(filtered);
      }

      function renderTable(list) {
        const tbody = document.querySelector("#records tbody");

        if (!list.length) {
          tbody.innerHTML = "<tr><td colspan='6'>該当データがありません</td></tr>";
          document.getElementById("summary").textContent = "";
          return;
        }

        // ★ テンプレートリテラルをやめて、文字列連結で HTML を生成
        let html = "";
        list.forEach(function (r) {
          html +=
            "<tr>" +
              "<td><button class='btn-edit' style='background:#3b82f6;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;' data-user='" + r.userId + "' data-date='" + r.date + "' onclick='handleEditClick(this)'>修正</button></td>" +
              "<td>" + (r.date || "") + "</td>" +
              "<td>" + (r.name || "未登録") + "</td>" +
              "<td>" + (r.clockIn || "--:--") + "</td>" +
              "<td>" + (r.clockOut || "--:--") + "</td>" +
              "<td>" + (r.breakStart || "--:--") + "</td>" +
              "<td>" + (r.breakEnd || "--:--") + "</td>" +
            "</tr>";

        });

        tbody.innerHTML = html;

        const workDays = list.filter(function (r) {
          return r.clockIn && r.clockOut;
        }).length;

        document.getElementById("summary").textContent =
          "勤務日数：" + workDays + "日";
      }

function openEditModal(userId, date) {
  document.getElementById("editUserId").value = userId;

  // レコード本体の日付（ベース日付）
  var baseDateInput = document.getElementById("editBaseDate");
  if (baseDateInput) {
    baseDateInput.value = date; // ここは "2025-11-13" 形式が入っている想定
  }

  // 既存データを検索
  var rec = allRecords.find(function (r) {
    return r.userId === userId && r.date === date;
  });

  // "2025/11/13" や "2025-11-13" → "2025-11-13" に正規化
  function normalizeDateString(d) {
    if (!d) return "";
    // まず - を / に揃えてから分解
    d = String(d).replace(/-/g, "/");
    var parts = d.split("/");
    if (parts.length !== 3) return "";
    var Y = parts[0];
    var M = parts[1];
    var D = parts[2];

    // ゼロ埋め
    M = ("0" + M).slice(-2);
    D = ("0" + D).slice(-2);

    // 🔴 ここをテンプレートリテラルではなく文字列連結に変更
    return Y + "-" + M + "-" + D;
  }

  // 日付＋時刻の文字列を input[type=date], input[type=time] にセット
  function setDT(dateInputId, timeInputId, dt) {
    var dateEl = document.getElementById(dateInputId);
    var timeEl = document.getElementById(timeInputId);

    if (!dateEl || !timeEl) return;
    if (!dt) {
      dateEl.value = "";
      timeEl.value = "";
      return;
    }

    dt = String(dt).trim();
    var d = "";
    var t = "";

    var parts = dt.split(" ");
    if (parts.length === 2) {
      d = parts[0];
      t = parts[1];
    } else {
      // 念のための保険
      if (dt.indexOf("/") >= 0 || dt.indexOf("-") >= 0) {
        d = dt;
      } else {
        t = dt;
      }
    }

    if (d) {
      var normalized = normalizeDateString(d);
      if (normalized) {
        dateEl.value = normalized;  // 例: 2025-11-13
      }
    }

    if (t) {
      timeEl.value = t.slice(0, 5); // "09:31:20" → "09:31"
    }
  }

  // DBに "2025/11/13 09:31" が入っている場合でも正しくセットされる
  setDT("editClockInDate",    "editClockIn",    rec && rec.clockIn);
  setDT("editClockOutDate",   "editClockOut",   rec && rec.clockOut);
  setDT("editBreakStartDate", "editBreakStart", rec && rec.breakStart);
  setDT("editBreakEndDate",   "editBreakEnd",   rec && rec.breakEnd);

  document.getElementById("editModal").style.display = "flex";
}






      function handleEditClick(btn) {
        const userId = btn.getAttribute("data-user");
        const date = btn.getAttribute("data-date");
        openEditModal(userId, date);
      }

      function closeEditModal() {
        document.getElementById("editModal").style.display = "none";
      }

async function saveEdit() {

  function merge(d, t) {
    if (!d || !t) return "";
    return d + " " + t;
  }

  const body = {
    userId: document.getElementById("editUserId").value,

    oldDate: document.getElementById("editBaseDate").value,
    newDate: document.getElementById("editBaseDate").value,

    clockIn: merge(
      document.getElementById("editClockInDate").value,
      document.getElementById("editClockIn").value
    ),
    clockOut: merge(
      document.getElementById("editClockOutDate").value,
      document.getElementById("editClockOut").value
    ),
    breakStart: merge(
      document.getElementById("editBreakStartDate").value,
      document.getElementById("editBreakStart").value
    ),
    breakEnd: merge(
      document.getElementById("editBreakEndDate").value,
      document.getElementById("editBreakEnd").value
    ),
  };

  const res = await fetch("/storeA/admin/attendance/update-full", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });

  alert(await res.text());
  closeEditModal();
  loadRecords();
}


      init();
    </script>
  </body>
  </html>
  `);
});


// ==============================
// ⏱ 管理者勤怠修正API（出勤＞退勤のバリデーション付き）
// ==============================
app.post("/:store/admin/attendance/update", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { userId, date, clockIn, clockOut } = req.body;
  const store = req.store;

  // 入力チェック
  if (clockIn && clockOut) {
    const inTime = new Date(`${date}T${clockIn}:00+09:00`);
    const outTime = new Date(`${date}T${clockOut}:00+09:00`);
    if (inTime > outTime) {
      return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2 style="color:#dc2626;">エラー</h2>
        <p>出勤時間が退勤時間より後になっています。</p>
        <a href="/${store}/admin/attendance" style="color:#2563eb;">← 戻る</a>
      </body></html>
      `);
    }
  }

  // Firestore更新
  const docRef = db.collection("companies").doc(store)
    .collection("attendance").doc(`${userId}_${date}`);

  const updates = {};
  if (clockIn) updates.clockIn = new Date(`${date}T${clockIn}:00+09:00`);
  if (clockOut) updates.clockOut = new Date(`${date}T${clockOut}:00+09:00`);

  await docRef.set(updates, { merge: true });
  res.redirect(`/${store}/admin/attendance`);
});

// 毎朝9時に自動実行される処理（Render Cron Jobsで設定）
app.get("/cron/attendance-alert/:store", ensureStore, async (req, res) => {
  const { store, lineClient } = req;
  const yesterday = new Date(Date.now() - 86400000);
  const ymd = yesterday.toISOString().split("T")[0];

  const snapshot = await db.collection("companies").doc(store)
    .collection("attendance")
    .where("date", "==", ymd)
    .get();

  const missing = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!data.clockIn || !data.clockOut) {
      missing.push({ name: data.name, userId: data.userId });
    }
  });

  if (missing.length > 0) {
    // 管理者に通知
    const names = missing.map(m => m.name).join("、");
    await lineClient.broadcast({
      type: "text",
      text: `【${store}】昨日(${ymd})の打刻漏れ：${names}`,
    });

    // 各本人にも通知
    for (const m of missing) {
      await lineClient.pushMessage(m.userId, {
        type: "text",
        text: `昨日(${ymd})の出退勤打刻が確認できませんでした。ご確認ください。`,
      });
    }
  }

  res.send(`✅ ${missing.length}件の打刻漏れを通知しました`);
});

// ✅ 全スタッフの勤怠データ取得（管理者用）
app.get("/:store/admin/all-attendance", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { month } = req.query;
  const results = [];

  const staffDocs = await db.collection("companies").doc(store).collection("permissions")
    .where("approved", "==", true).get();

  for (const doc of staffDocs.docs) {
    const userId = doc.id;
    const name = doc.data().name || "未登録";
    const snap = await db.collection("companies").doc(store)
      .collection("attendance").doc(userId).collection("records").get();

    snap.forEach(r => {
      const d = r.data();
      if (d.date && d.date.startsWith(month)) {
        results.push({ userId, name, ...d });
      }
    });
  }

  res.json(results);
});


// ==============================
// 🕒 管理者勤怠管理画面（改良版）
// ==============================
app.get("/:store/attendance-admin", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snapshot = await db.collection("companies").doc(store).collection("attendance").get();
  const records = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  const staffList = [...new Set(records.map(r => r.name))].filter(Boolean);
  const jsonData = JSON.stringify(records);

  res.send(`
  <!DOCTYPE html><html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${store} 勤怠管理</title>
    <style>
      body { font-family:'Segoe UI',sans-serif; background:#f8fafb; margin:0; padding:16px; color:#333; }
      h1 { color:#14532d; margin-bottom:16px; text-align:center; }
      .filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; justify-content:center; }
      .filter-box { background:#fff; padding:10px 14px; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,0.1); }
      .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-bottom:16px; }
      .card { background:#fff; border-radius:12px; box-shadow:0 1px 6px rgba(0,0,0,0.1); padding:12px; text-align:center; }
      .card h2 { margin:4px 0; color:#14532d; font-size:1.6em; }
      table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; table-layout:fixed; }
      th,td { padding:10px; border-bottom:1px solid #eee; text-align:center; word-wrap:break-word; }
      th { background:#14532d; color:white; font-weight:600; }
      button { background:#16a34a; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.9em; }
      button:hover { background:#15803d; }
      dialog input{margin-bottom:10px;width:100%;box-sizing:border-box;}
      @media(max-width:600px){
        th,td{font-size:13px;padding:6px;}
        table{font-size:13px;}
      }
    </style>
  </head>
  <body>
    <h1>${store} 勤怠管理</h1>

    <div class="filters">
      <div class="filter-box">
        <label>対象月：</label>
        <input type="month" id="month" value="${new Date().toISOString().slice(0,7)}" />
      </div>
      <div class="filter-box">
        <label>スタッフ：</label>
        <select id="staff">
          <option value="">全スタッフ</option>
          ${staffList.map(n => `<option>${n}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div>総勤務日数</div><h2 id="daysCount">0</h2></div>
      <div class="card"><div>総勤務時間</div><h2 id="totalHours">0h</h2></div>
    </div>

    <table id="attendanceTable">
      <thead><tr><th>日付</th><th>スタッフ</th><th>出勤</th><th>退勤</th><th>実働</th><th>操作</th></tr></thead>
      <tbody></tbody>
    </table>

    <dialog id="editModal">
      <form method="dialog" style="padding:20px;">
        <h3>出退勤時間修正</h3>
        <input type="hidden" id="editId">
        <div><label>出勤：</label><input type="time" id="editIn" required></div>
        <div><label>退勤：</label><input type="time" id="editOut" required></div>
        <div style="margin-top:10px;">
          <button type="button" onclick="saveEdit()">更新</button>
          <button type="button" onclick="closeModal()">閉じる</button>
        </div>
      </form>
    </dialog>

    <script>
      const records = ${jsonData};
      const tableBody = document.querySelector('#attendanceTable tbody');
      const monthInput = document.getElementById('month');
      const staffSelect = document.getElementById('staff');
      const daysCount = document.getElementById('daysCount');
      const totalHours = document.getElementById('totalHours');

      function formatDateShort(dateStr){
        const d = new Date(dateStr);
        return \`\${d.getMonth()+1}/\${d.getDate()}\`;
      }

      function formatDate(ts){
        if(!ts) return '-';
        const d = new Date(ts._seconds * 1000);
        const options = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' };
        return d.toLocaleTimeString('ja-JP', options);
      }

      function calcHours(clockIn, clockOut){
        if(!clockIn || !clockOut) return 0;
        const start = new Date(clockIn._seconds * 1000);
        const end = new Date(clockOut._seconds * 1000);
        const diff = (end - start) / (1000 * 60 * 60);
        return Math.floor(diff); // 小数切り捨て
      }

      function render(){
        const selectedMonth = monthInput.value;
        const selectedStaff = staffSelect.value;
        const filtered = records.filter(r => {
          return (!selectedStaff || r.name === selectedStaff) &&
                 (!selectedMonth || r.date.startsWith(selectedMonth));
        });

        let total = 0;
        tableBody.innerHTML = filtered.map(r => {
          const h = calcHours(r.clockIn, r.clockOut);
          total += h;
          return \`<tr>
            <td>\${formatDateShort(r.date)}</td>
            <td>\${r.name || '未登録'}</td>
            <td>\${formatDate(r.clockIn)}</td>
            <td>\${formatDate(r.clockOut)}</td>
            <td>\${h}h</td>
            <td><button onclick="editRecord('\${r.id}','\${r.name}','\${r.date}','\${formatDate(r.clockIn)}','\${formatDate(r.clockOut)}')">修正</button></td>
          </tr>\`;
        }).join('');

        daysCount.textContent = filtered.length;
        totalHours.textContent = total + 'h';
      }

      monthInput.addEventListener('change', render);
      staffSelect.addEventListener('change', render);
      render();

      function editRecord(id,name,date,inT,outT){
        const m=document.getElementById('editModal');
        document.getElementById('editId').value=id;
        document.getElementById('editIn').value=inT||'';
        document.getElementById('editOut').value=outT||'';
        m.showModal();
      }

      async function saveEdit() {
        const id = document.getElementById("editId").value; 
        const [userId, date] = id.split("_"); // ← FirestoreのIDから取得（安全）

        const inT = document.getElementById("editIn").value;
        const outT = document.getElementById("editOut").value;

        if (inT && outT && inT > outT) {
          alert("出勤時間は退勤時間より前にしてください。");
          return;
        }

        const body = {
          userId,
          date,
          clockIn: inT,
          clockOut: outT,
        };

        const res = await fetch("/${store}/admin/attendance/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });   // ← ★ ここの括弧が必要！


        alert(await res.text());
        closeModal();
      }


      // ✅ DOM読み込み後に初期化
      document.addEventListener("DOMContentLoaded", () => {
        loadRecords();
      });
    </script>

  </body></html>
  `);
});


// 🔄 勤怠修正API（Firestore Timestamp更新対応）
app.post("/:store/attendance-admin/update", ensureStore, async (req, res) => {
  const { id, clockIn, clockOut } = req.body;
  const [userId, date] = id.split("_");
  const store = req.store;

  const ci = admin.firestore.Timestamp.fromDate(new Date(clockIn));
  const co = admin.firestore.Timestamp.fromDate(new Date(clockOut));

  if (ci.toMillis() >= co.toMillis()) {
    return res.status(400).send("退勤時刻は出勤より後にしてください。");
  }

  await db.collection("companies").doc(store).collection("attendance").doc(id).update({
    clockIn: ci,
    clockOut: co,
  });

  res.send("更新しました");
});

// 出勤ボタン処理
app.post("/:store/attendance/clockIn", ensureStore, async (req, res) => {
  const { userId, name, date } = req.body;
  const store = req.store;
  const docRef = db.collection("companies").doc(store).collection("attendance").doc(`${userId}_${date}`);
  const doc = await docRef.get();

  if (doc.exists && doc.data().clockIn) {
    return res.send("⚠️ すでに出勤打刻済みです。");
  }

  await docRef.set(
    {
      userId,
      name,
      date,
      clockIn: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
  res.send("✅ 出勤を記録しました。");
});

// 退勤ボタン処理
app.post("/:store/attendance/clockOut", ensureStore, async (req, res) => {
  const { userId, date } = req.body;
  const store = req.store;
  const docRef = db.collection("companies").doc(store).collection("attendance").doc(`${userId}_${date}`);
  const doc = await docRef.get();

  if (!doc.exists || !doc.data().clockIn) {
    return res.send("⚠️ 出勤打刻がありません。");
  }
  if (doc.data().clockOut) {
    return res.send("⚠️ すでに退勤打刻済みです。");
  }

  await docRef.update({
    clockOut: admin.firestore.Timestamp.now(),
  });
  res.send("✅ 退勤を記録しました。");
});

// 複数勤務対応版（最新の works を代表値として返す）
app.get("/:store/attendance/records", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, month } = req.query;

  if (!userId || !month) return res.status(400).json([]);

  const [y, m] = month.split("-");
  const prefix = `${y}-${m.padStart(2, "0")}-`;

  const snapshot = await db
    .collection("companies")
    .doc(store)
    .collection("attendance")
    .doc(userId)
    .collection("records")
    .get();

  let list = [];

  snapshot.forEach(doc => {
    const d = doc.id; // "2025-11-25"
    if (!d.startsWith(prefix)) return;

    const data = doc.data();
    const works = data.works || [];

    // 代表値は「その日の最後の勤務」
    const last = works[works.length - 1] || {};

    list.push({
      date: d,
      works,
      // 表示用代表値
      clockIn: works[0]?.clockIn || "",
      clockOut: last.clockOut || "",
      breakStart: works.map(w => w.breakStart).filter(x => x).join(", "),
      breakEnd: works.map(w => w.breakEnd).filter(x => x).join(", ")
    });
  });

  // 日付昇順
  list.sort((a, b) => a.date.localeCompare(b.date));

  res.json(list);
});


function formatDate(ts) {
  // もし Timestamp 型なら toDate() を使う
  if (ts && typeof ts.toDate === "function") {
    const date = ts.toDate();
    return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  }

  // もし文字列ならそのまま（例: "2025/11/10 19:05"）
  if (typeof ts === "string") {
    return ts;
  }

  return "--:--";
}

// 承認済みスタッフ一覧
app.get("/:store/admin/staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const docs = await db.collection("companies").doc(store).collection("permissions")
    .where("approved","==",true).get();
  res.json(docs.docs.map(d=>({ id:d.id, name:d.data().name })));
});

// 勤怠一覧取得
app.get("/:store/admin/attendance/records", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, month } = req.query;
  if(!userId)return res.json([]);
  const col = db.collection("companies").doc(store).collection("attendance").doc(userId).collection("records");
  const snap = await col.get();
  const list = snap.docs.map(d=>d.data())
    .filter(r=>r.date.startsWith(month))
    .map(r=>({
      date:r.date,
      clockIn:r.clockIn?r.clockIn.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      breakStart:r.breakStart?r.breakStart.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      breakEnd:r.breakEnd?r.breakEnd.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
      clockOut:r.clockOut?r.clockOut.toDate().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}):null,
    }));
  res.json(list);
});

// 勤怠修正
app.post("/:store/admin/attendance/update", ensureStore, async (req,res)=>{
  const { store } = req.params;
  const { userId, date, clockIn, clockOut, breakStart, breakEnd } = req.body;
  const ref = db.collection("companies").doc(store).collection("attendance").doc(userId).collection("records").doc(date);

  const times = {clockIn,clockOut,breakStart,breakEnd};
  for(const k in times){
    if(times[k]) times[k] = admin.firestore.Timestamp.fromDate(new Date(date+"T"+times[k]+":00+09:00"));
  }

  await ref.set(times,{merge:true});
  res.send("勤怠を更新しました。");
});


app.get("/:store/manual-view", ensureStore, async (req, res) => {
  const { store, storeConf } = req;   // ★ storeConf も使う
  const { userId, type } = req.query;

  // 1️⃣ userId チェック
  if (!userId) {
    return res
      .status(400)
      .send("userId がありません（LIFFを経由してください）");
  }

  // 2️⃣ Firestore で権限チェック
  const permDoc = await db
    .collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .get();

  if (!permDoc.exists) {
    return res
      .status(404)
      .send("権限申請が未登録です。");
  }

  if (!permDoc.data().approved) {
    // ✅ 承認されていない → マニュアルは見せない
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>マニュアル閲覧権限なし</title>
      </head>
      <body>
        <h3>承認待ちです。</h3>
        <p>管理者に権限付与を依頼してください。</p>
      </body>
      </html>
    `);
  }

  // 3️⃣ 表示する Notion URL とタイトルを決定
  const urls   = storeConf.manualUrls   || {};
  const titles = storeConf.manualTitles || {};

  const targetUrl =
    (type && urls[type]) ||
    urls.default ||
    storeConf.manualUrl;         // 万一のフォールバック

  if (!targetUrl) {
    return res.status(404).send("マニュアルURLが設定されていません。");
  }

  const manualTitle =
    (type && titles[type]) ||
    titles.default ||
    "マニュアル";

  const encoded = encodeURIComponent(targetUrl);

  // 4️⃣ proxy 経由の iframe で Notion 公式ビューを埋め込む
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${manualTitle}</title>
      <style>
        html, body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: #f3f4f6;
          overflow: hidden;
        }
        .frame-wrap {
          position: fixed;
          inset: 0;
        }
        iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: #fff;
        }
      </style>
    </head>
    <body>
      <div class="frame-wrap">
        <iframe src="/proxy?url=${encoded}" allowfullscreen></iframe>
      </div>
    </body>
    </html>
  `);
});


// 🛠 打刻修正申請ページ// 🛠 打刻修正申請ページ
// 🛠 打刻修正申請ページ
app.get("/:store/attendance/fix", ensureStore, async (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${store} 打刻修正申請</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body { font-family:sans-serif; background:#f9fafb; margin:0; padding:20px; color:#333; }
      .container { max-width:600px; margin:auto; }
      h1 { font-size:20px; color:#111; margin-bottom:16px; }
      .card { background:#fff; border-radius:12px; box-shadow:0 1px 4px rgba(0,0,0,0.08); padding:20px; }
      .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
      .card-header h2 { font-size:16px; font-weight:bold; margin:0; }
      .btn-new { background:#111827; color:white; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:4px; }
      .btn-new:hover { background:#1f2937; }
      table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
      th,td { padding:8px; text-align:left; border-bottom:1px solid #e5e7eb; vertical-align:top; }
      th { color:#374151; font-weight:600; }
      td { color:#4b5563; line-height:1.5; }
      .empty { text-align:center; padding:16px; color:#9ca3af; }
      .btn-back { background:#9ca3af; color:white; border:none; border-radius:6px; padding:8px 16px; cursor:pointer; font-size:13px; margin-top:16px; display:block; margin-left:auto; }
      .status { display:inline-block; padding:2px 8px; border-radius:6px; font-size:12px; }
      .waiting { background:#fef3c7; color:#92400e; }

      /* モーダル */
/* ===== モーダル基礎 ===== */
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.5);
  justify-content: center;
  align-items: center;
  z-index: 9999;
}

.modal-content {
  background: #fff;
  padding: 24px;
  width: 90%;
  max-width: 420px;
  border-radius: 12px;
  box-shadow: 0 0 20px rgba(0,0,0,0.2);
}

/* ===== タイトル ===== */
.modal-title {
  text-align: center;
  margin-bottom: 20px;
  font-size: 20px;
  color: #111;
  font-weight: 600;
}

/* ===== フォーム要素 ===== */
.form-group {
  margin-bottom: 18px;
}

.label {
  font-size: 14px;
  color: #333;
  margin-bottom: 6px;
}

.input {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 14px;
  background: #f8f8f8;
}

/* ===== 2列グリッド ===== */
.grid-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field-block label {
  font-size: 13px;
  margin-bottom: 4px;
  display: block;
}

.textarea {
  height: 80px;
  resize: vertical;
}

/* ===== 現在記録 ===== */
.current-record {
  background: #f1f5f9;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
  line-height: 1.5;
}

/* ===== ボタン ===== */
.btn-row {
  display: flex;
  justify-content: space-between;
  margin-top: 20px;
}

.btn-cancel {
  padding: 10px 16px;
  background: #e5e7eb;
  border: none;
  border-radius: 8px;
  font-size: 14px;
}

.btn-send {
  padding: 10px 16px;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
}

    </style>
  </head>
  <body>
    <div class="container">
    <div class="top-bar">
      <button class="btn-back" onclick="history.back()">← 戻る</button>
    </div>
<h1>打刻時間修正申請</h1>
<div id="status" style="text-align:center; margin-bottom:10px; color:#4b5563;"></div>
      <div class="card">
        <div class="card-header">
          <h2>修正申請一覧</h2>
          <button class="btn-new" id="btnNew">＋ 新規申請</button>
        </div>
        <table id="requestTable">
          <thead>
            <tr><th>修正内容</th><th>理由</th><th>ステータス</th></tr>
          </thead>
          <tbody id="requestBody">
            <tr><td colspan="3" class="empty">申請はありません</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 修正申請モーダル -->
<div id="modal" class="modal">
  <div class="modal-content">

    <h3 class="modal-title">打刻時間修正申請</h3>

    <div class="form-group">
      <label>修正対象日</label>
      <input type="date" id="reqDate" onchange="loadCurrentRecord()" class="input">
    </div>

    <div id="currentRecord" class="current-record">
      現在の記録:<br>
      出勤: --:--<br>退勤: --:--<br>
      休憩開始: --:--<br>休憩終了: --:--
    </div>

    <div class="form-group">
      <label>修正後の日時</label>

      <div class="grid-2col">

        <div class="field-block">
          <label>出勤</label>
          <input type="datetime-local" id="newClockIn" class="input">
        </div>

        <div class="field-block">
          <label>退勤</label>
          <input type="datetime-local" id="newClockOut" class="input">
        </div>

        <div class="field-block">
          <label>休憩開始</label>
          <input type="datetime-local" id="newBreakStart" class="input">
        </div>

        <div class="field-block">
          <label>休憩終了</label>
          <input type="datetime-local" id="newBreakEnd" class="input">
        </div>

      </div>
    </div>

    <div class="form-group">
      <label>修正理由</label>
      <textarea id="reqMessage" class="input textarea"
        placeholder="打刻を忘れた、誤って打刻した等の理由を記載してください"></textarea>
    </div>

    <div class="btn-row">
      <button class="btn-cancel" onclick="closeModal()">キャンセル</button>
      <button class="btn-send" onclick="submitFix()">申請</button>
    </div>

  </div>
</div>


    <script>
      let userId, name; // ← 関数の外に宣言（★重要）
      let allRecords = [];
      let allRequests = [];

      async function main() {
        await liff.init({ liffId: "${storeConf.liffId}" });
        if (!liff.isLoggedIn()) return liff.login();

        const profile = await liff.getProfile();
        userId = profile.userId;     // ← constを外し、上のグローバル変数に代入
        name = profile.displayName;

        document.getElementById("status").innerText = name + " さん";
        await loadRecords();
        await loadRequests();        // ← 引数不要（グローバル変数から参照）
      }

      async function loadRecords() {
        const now = new Date();
        const ym = now.toISOString().slice(0, 7);
        const res = await fetch("/${store}/attendance/records?userId=" + userId + "&month=" + ym);
        allRecords = await res.json();
      }

      // 🔹 Firestoreのstatusをリアルタイムで取得するように変更
      // Firestoreから申請データを取得して一覧に反映
      async function loadRequests() {
        if (!userId) {
          console.error("userIdが未定義です。");
          return;
        }

        const res = await fetch("/${store}/attendance/requests?userId=" + encodeURIComponent(userId));
        if (!res.ok) throw new Error("データ取得に失敗しました");
        const data = await res.json();

        allRequests = data.map((r) => ({
          ...r,
          status: r.status || "承認待ち"
        }));

        renderRequestTable();
      }

      function renderRequestTable() {
        const tbody = document.getElementById("requestBody");
        if (!allRequests.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="empty">申請はありません</td></tr>';
          return;
        }

        const formatDateTime = (value) => {
          if (!value) return "--:--";

          // 🔹 before側（例: "2025/11/8 15:42:22" → "2025/11/8 15:42"）
          if (value.includes("/")) {
            // 「:秒」以降を削除（空白やミリ秒があっても対応）
            return value.replace(/:(\d{2})(\.\d+)?\s*$/, "");
          }

          // 🔹 after側（例: "2025-11-08T15:43" → "2025/11/08 15:43"）
          if (value.includes("T")) {
            const [date, time] = value.split("T");
            return date.replace(/-/g, "/") + " " + time.slice(0, 5);
          }

          return value;
        };


        // 🔹 バッククォートではなく通常文字列連結に変更して構文エラー回避
        let html = "";
        allRequests.forEach((r) => {
          const before = r.before || {};
          const after = r.after || {};
          const statusClass =
            r.status === "承認" ? "approved" :
            r.status === "却下" ? "rejected" : "waiting";
          const statusText = r.status || "承認待ち";

          html +=
            "<tr>" +
              "<td>" +
                "出勤: " + formatDateTime(before.clockIn) + " → <span class='new-time'>" + formatDateTime(after.clockIn) + "</span><br/>" +
                "退勤: " + formatDateTime(before.clockOut) + " → <span class='new-time'>" + formatDateTime(after.clockOut) + "</span><br/>" +
                "休憩開始: " + formatDateTime(before.breakStart) + " → <span class='new-time'>" + formatDateTime(after.breakStart) + "</span><br/>" +
                "休憩終了: " + formatDateTime(before.breakEnd) + " → <span class='new-time'>" + formatDateTime(after.breakEnd) + "</span>" +
              "</td>" +
              "<td>" + (r.message || "") + "</td>" +
              "<td><span class='status " + statusClass + "'>" + statusText + "</span></td>" +
            "</tr>";
        });

        tbody.innerHTML = html;
      }

      document.getElementById("btnNew").onclick = () => {
        document.getElementById("modal").style.display = "flex";
        document.querySelector(".top-bar").style.display = "none"; // ← 戻るボタンを隠す
      };

      function closeModal() {
        document.getElementById("modal").style.display = "none";
        document.querySelector(".top-bar").style.display = "flex"; // ← 再表示する
      }


      function loadCurrentRecord() {
        const date = document.getElementById("reqDate").value;
        const record = allRecords.find(r => r.date === date);
        const currentRecord = document.getElementById("currentRecord");

        if (record) {
          currentRecord.innerHTML = 
            "現在の記録:<br>" +
            "出勤: " + (record.clockIn || "--:--") + "<br>" + "退勤: " + (record.clockOut || "--:--") + "<br>" +
            "休憩開始: " + (record.breakStart || "--:--") + "<br>" + "休憩終了: " + (record.breakEnd || "--:--");
        } else {
          currentRecord.innerHTML = "現在の記録:<br>出勤: --:--<br>退勤: --:--<br>休憩開始: --:--<br>休憩終了: --:--";
        }
      }
      // 🔧 従業員入力値を "YYYY/MM/DD HH:mm" に変換
      function formatNewTime(date, time) {
        if (!date || !time) return "";
        // 例: 2025-11-17 → 2025/11/17
        var d = String(date).replace(/-/g, "/");
        return d + " " + time;   // ← ここをテンプレートリテラルではなく連結に
      }
      function normalizeTimeInput(value) {
        if (!value) return "";
        // 2025-11-17T16:55 → 16:55
        if (value.includes("T")) return value.split("T")[1].slice(0,5);
        // 16:55 の場合はそのまま
        return value;
      }


      async function submitFix() {
        const date = document.getElementById("reqDate").value;
        const message = document.getElementById("reqMessage").value;
        const baseDate = document.getElementById("reqDate").value;

        const newData = {
          clockIn:    formatNewTime(baseDate, normalizeTimeInput(document.getElementById("newClockIn").value)),
          clockOut:   formatNewTime(baseDate, normalizeTimeInput(document.getElementById("newClockOut").value)),
          breakStart: formatNewTime(baseDate, normalizeTimeInput(document.getElementById("newBreakStart").value)),
          breakEnd:   formatNewTime(baseDate, normalizeTimeInput(document.getElementById("newBreakEnd").value)),
        };


        if (!date || !message) return alert("日付と理由を入力してください。");

        const before = allRecords.find(r => r.date === date) || {};
        const payload = { userId, name, date, message, before, after: newData };

        await fetch("/${store}/attendance/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        // ローカルにも即反映
        allRequests.unshift({ before, after: newData, message, status: "承認待ち" });
        renderRequestTable();
        closeModal();
      }

      main();
    </script>
  </body>
  </html>
  `);
});

app.get("/:store/admin/search-staff", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { keyword = "", limit = 20, offset = 0 } = req.query;

  try {
    const snap = await db.collection("companies")
      .doc(store)
      .collection("permissions")
      .get();

    // ① 全件取得
    let allStaff = snap.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name || "未登録",
      approved: doc.data().approved || false
    }));

    // ② 全件検索
    if (keyword) {
      allStaff = allStaff.filter(s => s.name.includes(keyword));
    }

    const total = allStaff.length;

    // ③ ページネーション
    const start = Number(offset);
    const end   = start + Number(limit);
    const data  = allStaff.slice(start, end);

    res.json({
      data,
      total,
      nextOffset: end < total ? end : null
    });

  } catch (err) {
    console.error("❌ search-staff error:", err);
    res.status(500).json({ error: "検索に失敗しました。" });
  }
});

// ==============================
// ✅ スタッフ承認・解除API（リッチメニュー切替対応）
// ==============================
app.post("/:store/admin/update-staff", ensureStore, async (req, res) => {
  const { store, lineClient, storeConf } = req;
  const { userId, approve } = req.body;

  try {
    const ref = db.collection("companies").doc(store).collection("permissions").doc(userId);
    await ref.set({ approved: approve }, { merge: true });

    // 🔹 リッチメニュー切り替え処理
    if (approve && storeConf.richmenuAfter) {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuAfter);
      console.log(`✅ ${userId} → AFTERメニューに切り替え`);
      await lineClient.pushMessage(userId, {
        type: "text",
        text: "✅ 管理者により承認されました。メニューが更新されました。",
      });
    } else if (!approve && storeConf.richmenuBefore) {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
      console.log(`↩️ ${userId} → BEFOREメニューに戻しました`);
      await lineClient.pushMessage(userId, {
        type: "text",
        text: "⚠️ 管理者により承認が解除されました。",
      });
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ 承認/解除処理エラー:", err);
    res.status(500).json({ error: "更新に失敗しました。" });
  }
});


// 🗑 スタッフ削除API
// app.post("/:store/admin/delete-staff", ensureStore, async (req, res) => {
//   const { store } = req.params;
//   const { userId } = req.body;
//   try {
//     await db.collection("companies").doc(store)
//       .collection("permissions").doc(userId).delete();
//     res.json({ success: true });
//   } catch (err) {
//     console.error("❌ delete-staff error:", err);
//     res.status(500).json({ error: "削除に失敗しました。" });
//   }
// });
app.post("/:store/admin/delete-staff", ensureStore, async (req, res) => {
  const { store, storeConf, lineClient } = req;
  const { userId } = req.body;

  try {
    // ① Firestore の権限フラグを false に変更（安全対策）
    await db.collection("companies").doc(store)
      .collection("permissions").doc(userId)
      .set({ approved: false }, { merge: true });

    // ② リッチメニューを BEFORE に戻す（権限剥奪）
    try {
      await lineClient.linkRichMenuToUser(userId, storeConf.richmenuBefore);
      console.log(`🔄 ${userId} → BEFOREリッチメニューへ戻しました`);
    } catch (e) {
      console.error("❌ リッチメニュー戻しエラー:", e.originalError?.response?.data || e);
      // リッチメニューだけ失敗しても処理は継続する
    }

    // ③ Firestore でスタッフ権限情報を削除
    await db.collection("companies").doc(store)
      .collection("permissions").doc(userId).delete();

    console.log(`🗑 権限データ削除: ${userId}`);

    // ④ 正常応答
    res.json({ success: true });

  } catch (err) {
    console.error("❌ delete-staff error:", err);
    res.status(500).json({ error: "削除に失敗しました。" });
  }
});
// ==============================
// 🧾 管理者用 打刻修正依頼一覧ページ（デザイン改良版）
// ==============================
app.get("/:store/admin/fix", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store } = req.params;

  // ✅ クエリで「承認待ちのみ」フラグ取得
  const onlyWaiting = req.query.waiting === "1";

  // Firestoreから修正申請データ取得
  const snap = await db.collection("companies").doc(store)
    .collection("attendanceRequests")
    .orderBy("createdAt", "desc")
    .get();

  const requests = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    createdAt: d.data().createdAt
      ? d.data().createdAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "未記録"
  }));

  // 承認待ち件数カウント
  const waitingCount = requests.filter(r => r.status === "承認待ち").length;

  // ✅ フィルタ済みリスト（承認待ちのみ or 全件）
  const filtered = onlyWaiting
    ? requests.filter(r => r.status === "承認待ち")
    : requests;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${store} 打刻修正依頼</title>
    <style>
      body { font-family: 'Noto Sans JP', sans-serif; background:#f9fafb; margin:0; padding:20px; }
      h1 { color:#2563eb; margin-bottom:6px; }
      .notice { color:#dc2626; margin-bottom:20px; font-size:14px; }

      .container {
        background:white;
        border-radius:12px;
        padding:16px;
        box-shadow:0 2px 6px rgba(0,0,0,0.1);
        overflow-x:auto;
      }

      .header-row {
        display:flex;
        justify-content:space-between;
        align-items:center;
        flex-wrap:wrap;
        margin-bottom:12px;
      }

      .header-row h2 {
        margin:0;
        font-size:16px;
        color:#111827;
      }

      /* 🔹 承認待ちのみ スイッチ */
      .filter-toggle {
        display:flex;
        align-items:center;
        gap:6px;
        font-size:13px;
        color:#374151;
      }
      .filter-toggle input {
        width:40px;
        height:20px;
      }

      button {
        border:none;
        border-radius:6px;
        padding:6px 12px;
        cursor:pointer;
        font-size:13px;
      }

      .btn-approve { background:#16a34a; color:white; }
      .btn-reject { background:#dc2626; color:white; }

      table {
        width:100%;
        border-collapse:collapse;
        min-width:800px;
        font-size:14px;
      }

      th, td {
        padding:10px;
        border-bottom:1px solid #e5e7eb;
        text-align:center;
        vertical-align:middle;
      }

      th {
        background:#f3f4f6;
        color:#374151;
        font-weight:600;
      }

      tr:hover { background:#f9fafb; }

      .status {
        border-radius:12px;
        padding:4px 10px;
        font-size:12px;
        font-weight:600;
        display:inline-block;
      }

      .waiting { background:#fef3c7; color:#92400e; }
      .approved { background:#dcfce7; color:#166534; }
      .rejected { background:#fee2e2; color:#991b1b; }

      .new-time { color:#16a34a; font-weight:bold; }

      @media(max-width:600px){
        th, td { font-size:12px; padding:6px; }
        button { font-size:12px; padding:4px 8px; }
      }
    </style>
  </head>
  <body>
    <div style="text-align:center; margin-bottom:12px;">
      <button onclick="location.href='/${store}/admin'"
        style="background:#6b7280; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer;">
        ← TOPに戻る
      </button>
    </div>

    <h1>打刻時間修正申請</h1>
    <div class="notice">承認待ちの申請が${waitingCount}件あります</div>

    <div class="container">
      <div class="header-row">
        <h2>修正申請一覧</h2>
        <!-- 🔹 承認待ちのみスイッチ -->
        <label class="filter-toggle">
          <input type="checkbox" id="onlyWaiting" ${onlyWaiting ? "checked" : ""} onchange="toggleWaiting()">
          承認待ちのみ
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>申請者</th>
            <th>日付</th>
            <th>修正内容</th>
            <th>理由</th>
            <th>ステータス</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${
            filtered.length
              ? filtered.map(r => `
                <tr>
                  <td>${r.name || "未登録"}<br><small style="color:#dc2626;">${r.status || "承認待ち"}</small></td>
                  <td>${r.date || "-"}</td>
                  <td style="text-align:left;">
                    出勤: ${r.before?.clockIn || "--:--"} →
                      <span class="new-time">${r.after?.clockIn || r.before?.clockIn || "--:--"}</span><br>

                    退勤: ${r.before?.clockOut || "--:--"} →
                      <span class="new-time">${r.after?.clockOut || r.before?.clockOut || "--:--"}</span><br>

                    休憩開始: ${r.before?.breakStart || "--:--"} →
                      <span class="new-time">${r.after?.breakStart || r.before?.breakStart || "--:--"}</span><br>

                    休憩終了: ${r.before?.breakEnd || "--:--"} →
                      <span class="new-time">${r.after?.breakEnd || r.before?.breakEnd || "--:--"}</span>
                  </td>
                  <td>${r.message || ""}</td>
                  <td>
                    <span class="status ${
                      r.status === "承認" ? "approved" :
                      r.status === "却下" ? "rejected" : "waiting"
                    }">
                      ${r.status || "承認待ち"}
                    </span>
                  </td>
                  <td>
                    <button class="btn-approve" onclick="updateStatus('${r.id}','承認')">✔</button>
                    <button class="btn-reject" onclick="updateStatus('${r.id}','却下')">✖</button>
                  </td>
                </tr>
              `).join("")
              : `<tr><td colspan="6" style="color:#9ca3af;">申請はありません</td></tr>`
          }
        </tbody>
      </table>
    </div>

    <script>
      // 🔹 承認／却下処理（既存と同じ）
      async function updateStatus(id, status) {
        if (!confirm("この申請を" + status + "にしますか？")) return;
        await fetch("/${store}/admin/fix/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status })
        });
        alert("更新しました");
        location.reload();
      }

      // 🔹 「承認待ちのみ」トグル → クエリ付けてリロード
      function toggleWaiting() {
        const cb = document.getElementById("onlyWaiting");
        const url = new URL(location.href);
        if (cb.checked) {
          url.searchParams.set("waiting", "1");
        } else {
          url.searchParams.delete("waiting");
        }
        location.href = url.toString();
      }
    </script>
  </body>
  </html>
  `);
});

app.post("/:store/admin/fix/update", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.status(403).send("権限がありません。");

  const { store } = req.params;
  const { id, status } = req.body;

  try {
    const reqRef = db
      .collection("companies")
      .doc(store)
      .collection("attendanceRequests")
      .doc(id);

    const snap = await reqRef.get();
    if (!snap.exists) return res.status(404).send("リクエストが存在しません。");

    const data = snap.data();

    const userId = data.userId;
    const date = data.date;
    const before = data.before || {};
    const after = data.after || {};

    // ★ ここで T 形式を除去する変換
    function normalize(v) {
      if (!v) return "";
      if (v.includes("T")) {
        // "2025-11-13T09:36" → "2025/11/13 09:36"
        const [d, t] = v.split("T");
        const parts = d.split("-");
        return `${parts[0]}/${parts[1]}/${parts[2]} ${t}`;
      }
      return v; // もともと "/" 形式ならそのまま
    }

    // === 勤怠ドキュメント ===
    const recRef = db
      .collection("companies")
      .doc(store)
      .collection("attendance")
      .doc(userId)
      .collection("records")
      .doc(date);

    let updateData = {};

    if (status === "承認") {
      const updates = {};

      // after の値が空なら上書きしない
      if (after.clockIn) updates.clockIn = after.clockIn;
      if (after.clockOut) updates.clockOut = after.clockOut;
      if (after.breakStart) updates.breakStart = after.breakStart;
      if (after.breakEnd) updates.breakEnd = after.breakEnd;

      await recRef.set(updates, { merge: true });
    } else if (status === "却下") {
      // ★ before を正規化して保存
      updateData = {
        clockIn:     normalize(before.clockIn),
        clockOut:    normalize(before.clockOut),
        breakStart:  normalize(before.breakStart),
        breakEnd:    normalize(before.breakEnd),
      };
    }

    // 保存
    await recRef.set(
      {
        ...updateData,
        userId: userId,
        name: data.name,
        date: date,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    // 修正申請のステータス更新
    await reqRef.set(
      {
        status: status,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ 修正/更新 エラー:", e);
    res.status(500).send("修正処理に失敗しました");
  }
});



app.post("/:store/admin/attendance/fix/approve", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store) {
    return res.status(403).send("権限がありません。");
  }

  const { store } = req;
  const { requestId } = req.body;

  // ① 修正申請ドキュメント取得
  const reqRef = db.collection("companies")
    .doc(store)
    .collection("attendanceFixRequests")
    .doc(requestId);

  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    return res.status(404).send("修正申請が見つかりません。");
  }

  const reqData = reqSnap.data();

  // ② 勤怠本体（attendance）の該当日のドキュメントを更新する

  const userId = reqData.userId;
  const date = reqData.date; // "2025-11-06" など

  // 勤怠ドキュメントIDは「userId_日付」で保存している前提
  const attendanceId = `${userId}_${date}`;

  const attendanceRef = db.collection("companies")
    .doc(store)
    .collection("attendance")
    .doc(attendanceId);

  const attendanceSnap = await attendanceRef.get();
  const current = attendanceSnap.exists ? attendanceSnap.data() : {
    userId,
    name: reqData.name || "",
    date,
  };

  // after(修正後) から、入力されている項目だけを拾って上書き
  const updatedFields = {};
  const after = reqData.after || {};

  // ★ここは、実際にリクエストに保存しているフィールド名に合わせてください
  if (after.clockIn) {
    updatedFields.clockIn = after.clockIn;           // 例: "2025/11/6 21:00:00"
  }
  if (after.clockOut) {
    updatedFields.clockOut = after.clockOut;
  }
  if (after.breakStart) {
    updatedFields.breakStart = after.breakStart;
  }
  if (after.breakEnd) {
    updatedFields.breakEnd = after.breakEnd;
  }

  // 勤怠データ更新（merge: true で既存フィールドとマージ）
  await attendanceRef.set(
    {
      ...current,
      ...updatedFields,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // ③ 修正申請のステータス更新（承認済み）
  await reqRef.update({
    status: "approved",
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ④ 画面に戻る（必要に応じてURLは調整）
  res.redirect(`/${store}/admin/attendance/fix`);
});

// ==============================
// ⚙️ 店舗設定メニュー（修正版：給与集計ボタン付き）
// ==============================
app.get("/:store/admin/settings", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store) {
    return res.redirect(`/${req.store}/login`);
  }

  const store = req.store;

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${store} 店舗設定メニュー</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:40px; text-align:center; }
      h1 { color:#2563eb; margin-bottom:10px; }
      p  { color:#6b7280; margin-bottom:24px; }
      .wrap { display:flex; flex-direction:column; align-items:center; gap:14px; }
      a.btn {
        display:inline-block; width:280px; padding:12px 0;
        background:#2563eb; color:#fff; border-radius:8px; text-decoration:none;
        transition:background .2s;
      }
      a.btn:hover { background:#1d4ed8; }
      .back { margin-top:24px; }
      .back a { color:#6b7280; text-decoration:none; }
      .back a:hover { text-decoration:underline; }
    </style>
  </head>
  <body>
  <div style="text-align:center; margin-top:24px;">
    <button onclick="location.href='/${store}/admin'" 
      style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
      ← 管理TOPに戻る
    </button>
  </div>
    <h1>店舗設定メニュー</h1>
    <div class="wrap">
      <a class="btn" href="/${store}/admin/settings/general">店舗共通設定</a>
      <a class="btn" href="/${store}/admin/settings/staff">従業員個別設定</a>
      <a class="btn" href="/${store}/admin/payroll">給与自動集計</a>
    </div>
  </body></html>`);
});

app.post("/:store/admin/settings", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const settings = {
    regularHours: Number(req.body.regularHours) || 8,
    nightStart: req.body.nightStart || "22:00",
    dateChange: req.body.dateChange || "05:00",
    closingDay: Number(req.body.closingDay) || 25,
    updatedAt: new Date(),
  };
  await db.collection("companies").doc(store)
    .collection("config").doc("settings").set(settings, { merge: true });

  res.redirect(`/${store}/admin/settings`);
});


// ==============================
// 👥 雇用区分別設定画面
// ==============================
app.get("/:store/admin/contract", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snap = await db.collection("companies").doc(store)
    .collection("config").doc("contractSettings").get();
  const data = snap.exists ? snap.data() : {};

  const types = ["fulltime", "parttime", "contract"];
  const labels = { fulltime: "正社員", parttime: "アルバイト", contract: "契約社員" };

  const input = t => {
    const val = data[t] || {};
    return `
      <h3>${labels[t]}</h3>
      <label>基本時給／月給</label>
      <input type="number" step="1" name="${t}_basePay" value="${val.basePay || 0}">
      <label>残業割増率（%）</label>
      <input type="number" name="${t}_overtimeRate" value="${val.overtimeRate || 25}">
      <label>深夜割増率（%）</label>
      <input type="number" name="${t}_nightRate" value="${val.nightRate || 25}">
      <label>休日出勤割増率（%）</label>
      <input type="number" name="${t}_holidayRate" value="${val.holidayRate || 35}">
      <hr style="margin:20px 0;">
    `;
  };

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 雇用区分別設定</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:24px; }
      h1 { color:#2563eb; text-align:center; }
      form { background:#fff; max-width:520px; margin:0 auto; padding:20px; border-radius:10px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
      label { display:block; margin-top:8px; font-weight:bold; }
      input { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; }
      button { width:100%; margin-top:20px; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; }
      button:hover { background:#1d4ed8; }
      .link { text-align:center; margin-top:20px; }
      h3 { margin-top:20px; color:#374151; border-left:4px solid #2563eb; padding-left:6px; }
    </style>
  </head>
  <body>
    <h1>${store} 雇用区分別設定</h1>
    <form method="POST" action="/${store}/admin/contract">
      ${types.map(t => input(t)).join("")}
      <button type="submit">保存する</button>
    </form>

    <div class="link">
      <a href="/${store}/admin/settings">← 店舗共通設定へ戻る</a>
    </div>
  </body>
  </html>
  `);
});

app.post("/:store/admin/contract", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const types = ["fulltime", "parttime", "contract"];

  const obj = {};
  types.forEach(t => {
    obj[t] = {
      basePay: Number(req.body[`${t}_basePay`]) || 0,
      overtimeRate: Number(req.body[`${t}_overtimeRate`]) || 25,
      nightRate: Number(req.body[`${t}_nightRate`]) || 25,
      // holidayRate: Number(req.body[`${t}_holidayRate`]) || 35,
    };
  });

  await db.collection("companies").doc(store)
    .collection("config").doc("contractSettings").set(obj, { merge: true });

  res.redirect(`/${store}/admin/contract`);
});


app.post("/:store/admin/settings/save", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const data = req.body;

  await db.collection("companies").doc(store)
    .collection("settings").doc("general")
    .set(data, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
    <h2 style="color:#16a34a;">✅ 保存しました！</h2>
    <a href="/${store}/admin/settings">← 戻る</a>
    </body></html>
  `);
});

app.get("/:store/admin/settings/general", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  const doc = await db
    .collection("companies").doc(store)
    .collection("settings").doc("storeGeneral")
    .get();

  const data = doc.exists ? doc.data() : {};

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 給与計算ルール</title>

    <style>
      body {
        font-family: 'Noto Sans JP', sans-serif;
        background: #f3f4f6;
        margin: 0;
        padding: 20px;
      }

      .container {
        max-width: 760px;
        margin: 0 auto;
        background: white;
        padding: 28px;
        border-radius: 12px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.08);
      }

      h1 {
        font-size: 20px;
        font-weight: 700;
        margin-bottom: 18px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 2px solid #e5e7eb;
        padding-bottom: 8px;
      }

      .row {
        margin-bottom: 18px;
      }

      label {
        font-weight: 700;
        font-size: 14px;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      label small {
        font-weight: 400;
        font-size: 12px;
        color: #6b7280;
      }

      input {
        width: 100%;
        padding: 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 15px;
      }

      /* 深夜時間帯 */
      .time-range {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .time-range input[type=time] {
        flex: 1;
        cursor: pointer;
        position: relative;
        z-index: 10;
      }

      .time-range span {
        pointer-events: none;
        font-weight: bold;
      }

      .save-btn {
        width: 100%;
        margin-top: 28px;
        padding: 13px;
        font-size: 16px;
        background: #6366f1;
        color: white;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }

      .save-btn:hover {
        background: #4f46e5;
      }

      .back {
        margin-bottom: 14px;
        text-align: center;
      }

      .back a {
        color: #2563eb;
        text-decoration: none;
        font-size: 14px;
      }
    </style>
  </head>

  <body>
    <div style="text-align:center; margin-top:24px; margin-bottom:24px;">
      <button
        onclick="location.href='/${store}/admin/settings'"
        style="background:#6b7280; color:white; border:none;
              border-radius:8px; padding:10px 20px; font-size:14px;
              cursor:pointer; margin-bottom:24px;">
        ← 店舗設定に戻る
      </button>
    </div>

    <div class="container">
      <h1>店舗共通設定</h1>

      <form method="POST" action="/${store}/admin/settings/general/save">

        <!-- 残業単価倍率 -->
        <div class="row">
          <label>
            残業単価倍率
            <small>例: 1.25倍 = 時給×125%</small>
          </label>
          <input type="number" step="0.01" name="overtimeRate" value="${data.overtimeRate || 1.25}">
        </div>

        <!-- 深夜割増倍率 -->
        <div class="row">
          <label>
            深夜割増倍率
            <small>例: 1.25倍 = 時給×125%</small>
          </label>
          <input type="number" step="0.01" name="nightRate" value="${data.nightRate || 1.25}">
        </div>

        <!-- 深夜時間帯 -->
        <div class="row">
          <label>
            深夜時間帯（開始〜終了）
          </label>
          <div class="time-range">
            <input type="time" name="nightStart" value="${data.nightStart || '22:00'}">
            <span>〜</span>
            <input type="time" name="nightEnd" value="${data.nightEnd || '05:00'}">
          </div>
        </div>

        <!-- 休日割増倍率 -->
        <div class="row">
          <label>
            休日割増倍率
            <small>例: 1.35倍 = 時給×135%</small>
          </label>
          <input type="number" step="0.01" name="holidayRate" value="${data.holidayRate || 1.35}">
        </div>

        <!-- 締め日 -->
        <div class="row">
          <label>
            締め日（◯日締め）
            <small>例: 25 → 25日締め</small>
          </label>
          <input type="number" name="closingDay" value="${data.closingDay || ''}" placeholder="25">
        </div>

        <button class="save-btn">💾 設定を保存</button>

      </form>
    </div>

  </body>
  </html>
  `);
});



app.post("/:store/admin/settings/general/save", ensureStore, async (req, res) => {
  const store = req.store;

  const data = {
    overtimeRate: Number(req.body.overtimeRate),
    nightRate: Number(req.body.nightRate),
    nightStart: req.body.nightStart,
    nightEnd: req.body.nightEnd,
    // holidayRate: Number(req.body.holidayRate),
    closingDay: Number(req.body.closingDay),  // ← 修正
    updatedAt: new Date(),
  };

  await db.collection("companies")
    .doc(store)
    .collection("settings")
    .doc("storeGeneral")
    .set(data, { merge: true });

  res.send(`
    <html>
    <body style="
        font-family: 'Noto Sans JP', sans-serif;
        text-align: center;
        padding-top: 30vh;
        background: #f9fafb;
    ">
      <h2 style="
          color:#16a34a;
          font-size: 28px;
          margin-bottom: 24px;
          font-weight: 700;
      ">
        ✅ 設定を保存しました
      </h2>

      <a href="/${store}/admin/settings/general" style="
          display: inline-block;
          font-size: 20px;
          padding: 12px 28px;
          background: #2563eb;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          box-shadow: 0 3px 10px rgba(0,0,0,0.15);
      ">
        ← 戻る
      </a>
    </body>
    </html>
  `);

});

app.get("/:store/admin/settings/staff", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // Firestore 従業員（承認済）のみ取得
  const snap = await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .where("approved", "==", true)
    .get();

  const staff = snap.docs.map(doc => ({
    userId: doc.id,
    ...doc.data(),
  }));

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>従業員個別設定</title>

    <style>
      body {
        font-family: "Noto Sans JP", sans-serif;
        background:#f3f4f6;
        padding:20px;
      }
      h1 {
        text-align:center;
        font-size:22px;
        margin-bottom:20px;
      }
      table {
        width:100%;
        border-collapse:collapse;
        background:white;
        border-radius:10px;
        overflow:hidden;
      }
      th, td {
        padding:12px;
        border-bottom:1px solid #e5e7eb;
        text-align:left;
        font-size:15px;
      }
      th {
        background:#eef2ff;
        font-weight:bold;
      }
      .edit-btn {
        background:#2563eb;
        color:white;
        padding:6px 12px;
        border-radius:6px;
        border:none;
        font-size:14px;
        cursor:pointer;
      }
      .edit-btn:hover {
        background:#1d4ed8;
      }

      /* ===== モーダル ===== */
      .modal-bg {
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.4);
        display: none;
        justify-content: center;
        align-items: center;
        padding: 0;
        z-index: 9999;
      }
      /* ===== モーダル本体 ===== */
      .modal-box {
        background: white;
        width: 90%;                /* スマホで絶対に収まる幅 */
        max-width: 420px;          /* タブレット・PC 用の上限 */
        
        max-height: 90vh;          /* 画面からはみ出さない */
        overflow-y: auto;          /* 高さが溢れたら縦スクロール */
        
        padding: 20px;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);

        position: relative;
        top: 0; left: 0;
        right: 0; bottom: 0;
        margin: auto;              /* 常にど真ん中へ */
      }
      .modal-title {
        font-size:20px;
        font-weight:bold;
        margin-bottom:14px;
        text-align:center;
      }
      .type-buttons {
        display:flex;
        justify-content:space-between;
        margin-bottom:16px;
      }
      .type-btn {
        flex:1;
        margin:0 4px;
        background:#e5e7eb;
        padding:10px;
        border-radius:8px;
        text-align:center;
        cursor:pointer;
        font-size:15px;
      }
      .type-btn.active {
        background:#2563eb;
        color:white;
      }
      label {
        font-size:15px;
        margin-top:10px;
        display:block;
      }
      input {
        width:100%;
        padding:10px;
        font-size:16px;
        margin-top:6px;
        border:1px solid #d1d5db;
        border-radius:8px;
      }
      .modal-actions {
        margin-top:16px;
        display:flex;
        justify-content:space-between;
      }
      .save-btn {
        background:#16a34a;
        color:white;
        padding:10px 16px;
        border-radius:8px;
        font-size:16px;
        border:none;
        width:48%;
      }
      .close-btn {
        background:#dc2626;
        color:white;
        padding:10px 16px;
        border-radius:8px;
        font-size:16px;
        border:none;
        width:48%;
      }
      

      .table-scroll {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      table.staff-table {
        min-width: 600px;   /* ← 横スクロール強制 */
        border-collapse: collapse;
        width: 100%;
      }

      table.staff-table th, table.staff-table td {
        padding: 6px 10px !important;
        border-bottom: 1px solid #ddd;
        white-space: nowrap; /* ← 横に伸ばす */
        text-align: center;
      }

      .btn-edit {
        background:#3b82f6;
        border:none;
        color:#fff;
        padding:4px 8px;
        border-radius:6px;
        cursor:pointer;
      }
    </style>
  </head>

  <body>
    <div style="text-align:center; margin-top:24px;">
      <button onclick="location.href='/${store}/admin/settings'" 
        style="background:#6b7280; color:white; border:none; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer;">
        ← 店舗設定に戻る
      </button>
    </div>
    <h1>従業員個別設定</h1>

    <!-- 👇 ここからテーブル全体を差し替え -->

    <div class="table-scroll">
      <table class="staff-table">
        <thead>
          <tr>
            <th>編集</th>
            <th>名前</th>
            <th>雇用区分</th>
            <th>給料</th>
          </tr>
        </thead>
        <tbody>
          ${staff.map(s => `
            <tr>
              <!-- 編集ボタン -->
              <td>
                <button class="edit-btn"
                  onclick="openEdit(
                    '${s.userId}',
                    '${s.name || ""}',
                    '${s.employmentType || ""}',
                    '${jsonForHtml(s.salary || {})}'
                  )">
                  編集
                </button>
              </td>

              <!-- 名前 -->
              <td>${s.name || "未登録"}</td>

              <!-- 雇用区分 -->
              <td>${s.employmentType || "未設定"}</td>

              <!-- 給料 -->
              <td>
                ${
                  s.salary
                    ? s.employmentType === "正社員"
                      ? "月給 " + (s.salary.monthly || "未設定")
                    : s.employmentType === "アルバイト"
                      ? "時給 " + (s.salary.hourly || "未設定")
                    : s.employmentType === "業務委託"
                      ? "日給 " + (s.salary.daily || "未設定")
                    : "—"
                  : "—"
                }
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <!-- ===== モーダル ===== -->
    <div id="modal" class="modal-bg">
      <div class="modal-box">
        <div id="modalTitle" class="modal-title"></div>

        <div class="type-buttons">
          <div class="type-btn" id="btn正社員" onclick="selectType('正社員')">正社員</div>
          <div class="type-btn" id="btnアルバイト" onclick="selectType('アルバイト')">アルバイト</div>
          <div class="type-btn" id="btn業務委託" onclick="selectType('業務委託')">業務委託</div>
        </div>

        <div id="salaryArea"></div>

        <div class="modal-actions">
          <button class="save-btn" onclick="saveStaff()">保存</button>
          <button class="close-btn" onclick="closeModal()">閉じる</button>
        </div>
      </div>
    </div>

    <script>
      const store = "${store}";
      let editUserId = null;
      let selectedType = "";


      function openEdit(id, name, type, salaryJson) {
        const salary = JSON.parse(salaryJson);

        console.log("編集開始:", id, name, type, salary);
        editUserId = id;

        document.getElementById("modalTitle").innerText =
          name + " さんの設定";

        selectedType = type || "";
        highlightTypeButton();

        renderSalaryInput(salary);

        document.getElementById("modal").style.display = "flex";
      }

      function closeModal() {
        document.getElementById("modal").style.display = "none";
      }

      function highlightTypeButton() {
        ["正社員","アルバイト","業務委託"].forEach(t => {
          document.getElementById("btn" + t).classList.remove("active");
        });

        if (selectedType) {
          document.getElementById("btn" + selectedType).classList.add("active");
        }
      }

      function selectType(type) {
        selectedType = type;
        highlightTypeButton();
        renderSalaryInput({});
      }

      function renderSalaryInput(salary) {
        const area = document.getElementById("salaryArea");

        if (selectedType === "正社員") {
          area.innerHTML = \`
            <label>月額固定給（円）</label>
            <input id="salaryInput" type="number" value="\${salary.monthly || ""}">
          \`;
        } else if (selectedType === "アルバイト") {
          area.innerHTML = \`
            <label>時給単価（円）</label>
            <input id="salaryInput" type="number" value="\${salary.hourly || ""}">
          \`;
        } else if (selectedType === "業務委託") {
          area.innerHTML = \`
            <label>日給単価（円）</label>
            <input id="salaryInput" type="number" value="\${salary.daily || ""}">
          \`;
        } else {
          area.innerHTML = "";
        }
      }

      async function saveStaff() {
        const value = document.getElementById("salaryInput")?.value || "";

        await fetch("/${store}/admin/settings/staff/save", {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({
            userId: editUserId,
            employmentType: selectedType,
            value
          })
        });

        alert("保存しました");
        location.reload();
      }
    </script>

  </body>
  </html>
  `);
});


app.post("/:store/admin/settings/staff/type", ensureStore, async (req, res) => {
  const store = req.store;
  const { userId, type } = req.body;

  await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .set({ employmentType: type }, { merge: true });

  res.json({ status: "ok" });
});

app.post("/:store/admin/settings/staff/salary", ensureStore, async (req, res) => {
  const store = req.store;
  const { userId, value } = req.body;

  const doc = await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .get();

  const type = doc.data().employmentType;

  let salary = {};

  if (type === "正社員") salary = { monthly: Number(value) };
  if (type === "アルバイト") salary = { hourly: Number(value) };
  if (type === "業務委託") salary = { daily: Number(value) };

  await db.collection("companies")
    .doc(store)
    .collection("permissions")
    .doc(userId)
    .set({ salary }, { merge: true });

  res.json({ status: "ok" });
});

// HTML属性に安全に JSON を埋め込むためのヘルパー（サーバー側）
function jsonForHtml(obj) {
  return JSON.stringify(obj || {})
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;"); // ダブルクォートだけ HTML エスケープ
}

// ==============================
// ✏️ 個別編集ページ
// ==============================
app.get("/:store/admin/settings/staff/:id", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params } = req;
  const staffId = params.id;

  // 🔹 基本データ取得（members）
  const memberDoc = await db
    .collection("companies")
    .doc(store)
    .collection("members")
    .doc(staffId)
    .get();
  const member = memberDoc.exists ? memberDoc.data() : {};

  // 🔹 個別設定（settings/staff/{id}）
  const configDoc = await db
    .collection("companies")
    .doc(store)
    .collection("settings")
    .doc("staff_" + staffId)
    .get();
  const conf = configDoc.exists ? configDoc.data() : {};

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${member.name || "従業員"} の設定</title>
  <style>
    body { font-family:sans-serif; background:#f9fafb; padding:20px; }
    h1 { text-align:center; color:#2563eb; }
    form { background:#fff; padding:20px; border-radius:8px; max-width:700px; margin:0 auto; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
    label { display:block; margin-top:12px; font-weight:600; }
    input, select { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; margin-top:4px; }
    button { margin-top:20px; background:#2563eb; color:white; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
    a { display:block; text-align:center; margin-top:20px; color:#2563eb; text-decoration:none; }
  </style></head><body>

    <h1>${member.name || "従業員"} の個別設定</h1>

    <form method="POST" action="/${store}/admin/settings/staff/save/${staffId}">
      <label>雇用区分</label>
      <select name="employmentType">
        <option value="">選択してください</option>
        <option value="正社員" ${member.employmentType === "正社員" ? "selected" : ""}>正社員</option>
        <option value="アルバイト" ${member.employmentType === "アルバイト" ? "selected" : ""}>アルバイト</option>
        <option value="業務委託" ${member.employmentType === "業務委託" ? "selected" : ""}>業務委託</option>
        <option value="パート" ${member.employmentType === "パート" ? "selected" : ""}>パート</option>
      </select>

      <label>個別基本時給／月給</label>
      <input type="text" name="basePay" value="${conf.basePay || ""}" placeholder="例：時給1200円、月給28万円など">

      <label>個別残業割増率（％）</label>
      <input type="number" name="overtimeRate" value="${conf.overtimeRate || ""}" placeholder="例：25">

      <label>個別深夜手当時間帯</label>
      <input type="text" name="nightHours" value="${conf.nightHours || ""}" placeholder="例：22:00〜5:00">

      <label>個別休日出勤割増率（％）</label>
      <input type="number" name="holidayRate" value="${conf.holidayRate || ""}" placeholder="例：35">

      <label>勤続／役職手当ルール</label>
      <input type="text" name="bonusRule" value="${conf.bonusRule || ""}" placeholder="例：1年ごとに＋5000円">

      <button type="submit">保存</button>
    </form>

    <a href="/${store}/admin/settings/staff">← 従業員一覧に戻る</a>
  </body></html>
  `);
});

// =====================================
// ✅ 従業員個別設定 保存API（雇用区分＋給料）
// =====================================
app.post("/:store/admin/settings/staff/save", ensureStore, express.json(), async (req, res) => {
  try {
    const { store } = req;
    const { userId, employmentType, value } = req.body;

    if (!userId) {
      return res.status(400).send("userId がありません");
    }

    // 給料データを Firestore 用に変換
    let salaryData = {};

    if (employmentType === "正社員") {
      salaryData = { monthly: Number(value) || null };
    } else if (employmentType === "アルバイト") {
      salaryData = { hourly: Number(value) || null };
    } else if (employmentType === "業務委託") {
      salaryData = { daily: Number(value) || null };
    }

    // Firestore 更新
    await db.collection("companies")
      .doc(store)
      .collection("permissions")
      .doc(userId)
      .set(
        {
          employmentType: employmentType || null,
          salary: salaryData,
          updatedAt: new Date()
        },
        { merge: true }
      );

    return res.status(200).send("OK");
  } catch (err) {
    console.error("従業員設定保存エラー:", err);
    return res.status(500).send("保存に失敗しました");
  }
});

// ==============================
// 💾 個別設定保存
// ==============================
app.post("/:store/admin/settings/staff/save/:id", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const { store, params, body } = req;
  const staffId = params.id;

  // 🔹 雇用区分は members にも反映
  await db.collection("companies").doc(store).collection("members").doc(staffId)
    .set({ employmentType: body.employmentType }, { merge: true });

  // 🔹 個別設定を保存
  await db.collection("companies").doc(store)
    .collection("settings")
    .doc("staff_" + staffId)
    .set(body, { merge: true });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding-top:30vh;">
      <h2 style="color:#16a34a;">✅ ${staffId} の設定を保存しました</h2>
      <a href="/${store}/admin/settings/staff">← 従業員一覧へ戻る</a>
    </body></html>
  `);
});

// ==============================
// 👤 従業員個別設定（ボタン＋画面）
// ==============================

// 🔹 管理TOPにボタンを追加
// （管理TOP HTML内のナビ部分に以下のボタンを追加してください）
// <a href="/${store}/admin/employees">従業員設定</a>

// 🔹 ルート定義
app.get("/:store/admin/employees", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const snap = await db.collection("companies").doc(store).collection("employees").get();
  const employees = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} 従業員設定</title>
    <style>
      body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
      h1 { text-align:center; color:#2563eb; margin-bottom:20px; }
      table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; }
      th,td { padding:10px; border-bottom:1px solid #eee; text-align:center; font-size:14px; }
      th { background:#2563eb; color:white; }
      tr:nth-child(even){background:#f3f4f6;}
      button { background:#2563eb; color:white; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
      button:hover { background:#1e40af; }
      .add { margin-bottom:16px; display:block; background:#16a34a; }
    </style>
  </head>
  <body>
    <h1>${store} 従業員設定</h1>
    <button class="add" onclick="location.href='/${store}/admin/employees/new'">＋ 従業員を追加</button>

    <table>
      <thead>
        <tr><th>名前</th><th>雇用区分</th><th>時給</th><th>交通費</th><th>備考</th><th>操作</th></tr>
      </thead>
      <tbody>
        ${employees.map(e => `
          <tr>
            <td>${e.name || "未登録"}</td>
            <td>${e.contractType || "-"}</td>
            <td>${e.hourly || 0}</td>
            <td>${e.commuteAllowance || 0}</td>
            <td>${e.note || ""}</td>
            <td><button onclick="location.href='/${store}/admin/employees/edit?id=${e.id}'">編集</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div style="text-align:center;margin-top:20px;">
      <a href="/${store}/admin" style="color:#2563eb;">← 管理TOPへ戻る</a>
    </div>
  </body>
  </html>
  `);
});


// 🔹 従業員追加・編集画面
app.get("/:store/admin/employees/:mode", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;
  const { mode } = req.params;
  const id = req.query.id;
  let emp = {};
  if (id) {
    const doc = await db.collection("companies").doc(store).collection("employees").doc(id).get();
    emp = doc.exists ? doc.data() : {};
  }

  res.send(`
  <!DOCTYPE html><html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${store} 従業員${mode === "new" ? "追加" : "編集"}</title>
  <style>
    body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
    h1 { color:#2563eb; text-align:center; margin-bottom:16px; }
    form { background:white; padding:20px; border-radius:8px; max-width:400px; margin:0 auto; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
    label { display:block; margin-top:12px; font-weight:bold; }
    input, select, textarea { width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; font-size:14px; }
    button { margin-top:16px; background:#2563eb; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; width:100%; }
    button:hover { background:#1e40af; }
  </style>
  </head>
  <body>
    <h1>${store} 従業員${mode === "new" ? "追加" : "編集"}</h1>
    <form method="POST" action="/${store}/admin/employees/save">
      <input type="hidden" name="id" value="${id || ""}">
      <label>氏名</label>
      <input type="text" name="name" value="${emp.name || ""}" required>

      <label>雇用区分</label>
      <select name="contractType">
        <option value="">選択してください</option>
        <option value="fulltime" ${emp.contractType==="fulltime"?"selected":""}>正社員</option>
        <option value="parttime" ${emp.contractType==="parttime"?"selected":""}>アルバイト</option>
        <option value="contract" ${emp.contractType==="contract"?"selected":""}>契約社員</option>
      </select>

      <label>基本時給／月給</label>
      <input type="number" name="hourly" step="1" value="${emp.hourly || ""}" placeholder="例：1100">

      <label>交通費（定額）</label>
      <input type="number" name="commuteAllowance" step="1" value="${emp.commuteAllowance || ""}" placeholder="例：5000">

      <label>備考</label>
      <textarea name="note">${emp.note || ""}</textarea>

      <button type="submit">保存する</button>
    </form>

    <div style="text-align:center;margin-top:16px;">
      <a href="/${store}/admin/employees" style="color:#2563eb;">← 一覧に戻る</a>
    </div>
  </body></html>
  `);
});


// 🔹 保存処理
app.post("/:store/admin/employees/save", ensureStore, express.urlencoded({ extended: true }), async (req, res) => {
  const store = req.store;
  const { id, name, contractType, hourly, commuteAllowance, note } = req.body;
  const data = {
    name,
    contractType,
    hourly: Number(hourly) || 0,
    commuteAllowance: Number(commuteAllowance) || 0,
    note: note || "",
    updatedAt: new Date(),
  };

  const ref = db.collection("companies").doc(store).collection("employees");
  if (id) await ref.doc(id).set(data, { merge: true });
  else await ref.add(data);

  res.redirect(`/${store}/admin/employees`);
});

// ==============================
// 💰 給与自動集計（統合版）
// ==============================
app.get("/:store/admin/payroll", ensureStore, async (req, res) => {
  if (!req.session.loggedIn || req.session.store !== req.store)
    return res.redirect(`/${req.store}/login`);

  const store = req.store;

  // --- 各種設定を読み込み ---
  const settingsRef = db.collection("companies").doc(store).collection("settings");
  const general = (await settingsRef.doc("storeGeneral").get()).data() || {};
  const fulltime = (await settingsRef.doc("employment_fulltime").get()).data() || {};
  const parttime = (await settingsRef.doc("employment_parttime").get()).data() || {};
  const contract = (await settingsRef.doc("employment_contract").get()).data() || {};

  const employmentMap = { fulltime, parttime, contract };

  // --- 店舗共通設定値 ---
  const regularHours = general.regularHours || 8;
  const nightStart = general.nightStart || "22:00";
  const closingDay = general.closingDay || 25;

  // --- 対象期間（例：前月26日〜今月25日） ---
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), closingDay);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  start.setDate(closingDay + 1);

  // --- 従業員リスト取得 ---
  const empSnap = await db.collection("companies").doc(store).collection("employees").get();
  const employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const results = [];

  for (const emp of employees) {
    const type = emp.contractType || "parttime";
    const empSetting = employmentMap[type] || {};
    const hourly = emp.hourly || empSetting.basePay || 0;
    const overtimeRate = empSetting.overtimeRate || 25;
    const holidayRate = empSetting.holidayRate || 35;

    // --- 勤怠データ取得 ---
    const attSnap = await db.collection("companies").doc(store)
      .collection("attendance").doc(emp.id).collection("records")
      .where("date", ">=", start.toISOString().split("T")[0])
      .where("date", "<=", end.toISOString().split("T")[0])
      .get();

    let totalWork = 0, overtime = 0, holiday = 0, night = 0;

    attSnap.docs.forEach(doc => {
      const d = doc.data();
      const [inH, inM] = (d.clockIn || "00:00").split(":").map(Number);
      const [outH, outM] = (d.clockOut || "00:00").split(":").map(Number);
      let workHours = ((outH * 60 + outM) - (inH * 60 + inM)) / 60 - (d.restHours || 0);

      if (workHours < 0) workHours = 0;
      totalWork += workHours;

      // 残業
      if (workHours > regularHours) overtime += workHours - regularHours;

      // 深夜時間（22:00〜翌5:00）
      if (outH >= 22 || outH < 5) {
        const nightH = outH >= 22 ? outH - 22 : outH + 2; // 簡易計算
        night += nightH;
      }

      // 休日勤務
      if (d.type === "休日") holiday += workHours;
    });

    // --- 給与計算 ---
    const basePay = totalWork * hourly;
    const overPay = overtime * hourly * (overtimeRate / 100);
    const nightPay = night * hourly * 0.25; // 深夜は法定25%
    const holidayPay = holiday * hourly * (holidayRate / 100);

    const total = Math.round(basePay + overPay + nightPay + holidayPay);

    results.push({
      name: emp.name,
      type,
      totalWork: totalWork.toFixed(1),
      overtime: overtime.toFixed(1),
      night: night.toFixed(1),
      holiday: holiday.toFixed(1),
      hourly,
      total,
    });
  }

  // --- 結果表示 ---
  res.send(`
  <!DOCTYPE html>
  <html lang="ja"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${store} 給与集計</title>
  <style>
    body { font-family:'Noto Sans JP',sans-serif; background:#f9fafb; padding:20px; }
    h1 { color:#2563eb; text-align:center; margin-bottom:20px; }
    table { width:100%; border-collapse:collapse; background:white; }
    th,td { border:1px solid #ccc; padding:8px; text-align:center; }
    th { background:#2563eb; color:white; }
    tr:nth-child(even){background:#f3f4f6;}
    .back { text-align:center; margin-top:20px; }
    .back a { color:#2563eb; text-decoration:none; }
    .back a:hover { text-decoration:underline; }
  </style>
  </head><body>
    <div class="back" style="margin-top:30px;">
      <a href="/${store}/admin/settings">← 店舗設定メニューへ戻る</a><br><br>
      <a href="/${store}/admin/payroll/export"
        style="display:inline-block;margin-top:10px;background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">
        💾 CSVでダウンロード
      </a>
    </div>

    <h1>${store} 給与自動集計結果</h1>
    <p style="text-align:center;">期間：${start.toLocaleDateString()}〜${end.toLocaleDateString()}</p>

    <table>
      <thead>
        <tr><th>氏名</th><th>区分</th><th>勤務時間</th><th>残業</th><th>深夜</th><th>休日</th><th>時給</th><th>支給額</th></tr>
      </thead>
      <tbody>
        ${results.map(r => `
        <tr>
          <td>${r.name}</td>
          <td>${r.type}</td>
          <td>${r.totalWork}</td>
          <td>${r.overtime}</td>
          <td>${r.night}</td>
          <td>${r.holiday}</td>
          <td>¥${r.hourly.toLocaleString()}</td>
          <td><b>¥${r.total.toLocaleString()}</b></td>
        </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="back">
      <a href="/${store}/admin/settings">← 店舗設定メニューへ戻る</a>
    </div>

  </body></html>`);
});

app.get("/:store/admin/payroll/export", ensureStore, async (req, res) => {
  try {
    const { store } = req;

    const general = (await db.collection("companies").doc(store)
      .collection("settings").doc("storeGeneral").get()).data();

    const usersSnap = await db.collection("companies").doc(store)
      .collection("permissions").get();

    let results = [];

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const userId = userDoc.id;

      const attendanceSnap = await db.collection("companies").doc(store)
        .collection("attendance").doc(userId)
        .collection("records")
        .get();

      let totalHours = 0;

      attendanceSnap.forEach(day => {
        const data = day.data();
        if (!data.works || data.works.length === 0) return;

        data.works.forEach(w => {
          const start = new Date(w.clockIn);
          const end = new Date(w.clockOut);
          if (!isNaN(start) && !isNaN(end)) {
            totalHours += (end - start) / (1000 * 60 * 60);
          }
        });
      });

      results.push({
        userId,
        name: user.name || "",
        totalHours: totalHours.toFixed(2),
        totalPay: "", // あとで計算用
        normalHours: "",
        nightHours: "",
        overtimeHours: "",
      });
    }

    // ここが今回のエラー原因！
    if (results.length === 0) {
      return res.status(200).send(`
        <html><body>
          <h2>給与データがありません</h2>
          <p>集計対象の勤怠データが0件です。</p>
          <a href="/${store}/admin/settings">←戻る</a>
        </body></html>
      `);
    }

    // 必ず fields を指定
    const fields = [
      "userId",
      "name",
      "totalHours",
      "totalPay",
      "normalHours",
      "nightHours",
      "overtimeHours",
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(results);

    res.header("Content-Type", "text/csv");
    res.attachment("payroll.csv");
    res.send(csv);

  } catch (err) {
    console.error("❌ Payroll export error:", err);
    res.status(500).send("給与集計時にエラーが発生しました");
  }
});

app.post("/:store/admin/attendance/update-full", ensureStore, async (req, res) => {
  try {
    const { store } = req.params;
    const { userId, oldDate, newDate, clockIn, clockOut, breakStart, breakEnd } = req.body;

    const baseRef = db.collection("companies").doc(store)
      .collection("attendance").doc(userId).collection("records");

    // 🔹 日付が変わった場合 → レコード移動
    if (oldDate !== newDate) {
      const oldRef = baseRef.doc(oldDate);
      const newRef = baseRef.doc(newDate);

      const oldSnap = await oldRef.get();
      if (oldSnap.exists) {
        await newRef.set({ ...oldSnap.data(), date:newDate }, { merge: true });
        await oldRef.delete();
      }
    }

    // 🔹 新しい日付へデータ上書き
    await baseRef.doc(newDate).set({
      clockIn,
      clockOut,
      breakStart,
      breakEnd,
      userId,
      date: newDate,
      updatedAt: new Date()
    }, { merge: true });

    res.send("勤怠データを更新しました");
  }
  catch (err) {
    console.error(err);
    res.status(500).send("更新中にエラーが発生しました");
  }
});


// 勤怠修正申請を承認 → attendance に反映
app.post("/:store/admin/fix/approve", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { requestId } = req.body;

  const reqRef = db.collection("companies")
    .doc(store)
    .collection("attendanceRequests")
    .doc(requestId);

  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) return res.status(404).send("申請が見つかりません");

  const data = reqDoc.data();
  const userId = data.userId;
  const date = data.date;
  const after = data.after;  // ← 修正後の値（T形式）

  // attendance の保存先
  const attRef = db.collection("companies")
    .doc(store)
    .collection("attendance")
    .doc(userId)
    .collection("records")
    .doc(date);

  // Firestore 保存形式に合わせて T を "/"区切りに変換
  const toDisplayFormat = t => {
    // 2025-11-13T09:31 → 2025/11/13 09:31
    if (!t) return null;
    return t.replace("T", " ").replace(/-/g, "/");
  };

  const fixed = {
    clockIn:    toDisplayFormat(after.clockIn),
    clockOut:   toDisplayFormat(after.clockOut),
    breakStart: toDisplayFormat(after.breakStart),
    breakEnd:   toDisplayFormat(after.breakEnd),
    updatedAt: new Date()
  };

  await attRef.set(fixed, { merge: true });

  // 申請の状態を「承認済」に更新
  await reqRef.update({
    status: "承認",
    updatedAt: new Date()
  });

  res.send("勤怠データを更新し、申請を承認しました");
});

app.get("/:store/admin/manual-logs", ensureStore, async (req, res) => {
  const { store } = req;

  // ページネーション設定
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  // Firestore: companies/{store}/manualViews
  const snapshot = await db
    .collection("companies")
    .doc(store)
    .collection("manualViews")
    .orderBy("viewedAt", "desc")
    .get();

  const allLogs = snapshot.docs.map((doc) => doc.data());
  const total = allLogs.length;

  // 対象ページのデータを抽出
  const logs = allLogs.slice(offset, offset + limit);

  // テーブル行生成
  let rows = logs
    .map(
      (l) => `
      <tr>
        <td>${l.name || "名前未登録"}</td>
        <td>${l.title || "マニュアル名不明"}</td>
        <td>${new Date(l.viewedAt.toDate().getTime() + 9 * 60 * 60 * 1000).toLocaleString("ja-JP")}</td>
      </tr>
    `
    )
    .join("");

  if (!rows) {
    rows = "<tr><td colspan='3'>まだ閲覧ログがありません</td></tr>";
  }

  // ページ数
  const totalPages = Math.ceil(total / limit);

  // ページネーション（必要な場合のみ表示）
  let pagination = "";
  if (totalPages > 1) {
    pagination = `
      <div class="pagination">
        ${
          page > 1
            ? `<a href="/${store}/admin/manual-logs?page=${page - 1}" class="page-btn">前へ</a>`
            : ""
        }
        <span class="page-info">Page ${page} / ${totalPages}</span>
        ${
          page < totalPages
            ? `<a href="/${store}/admin/manual-logs?page=${page + 1}" class="page-btn">次へ</a>`
            : ""
        }
      </div>
    `;
  }

  // HTML
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>マニュアル閲覧ログ</title>
      <style>
        body { font-family:sans-serif; padding:20px; background:#f9fafb; }

        .header-row {
          display:flex;
          justify-content:space-between;
          align-items:center;
          margin-bottom:20px;
          flex-wrap:nowrap;
        }

        .header-title {
          font-size:20px;
          font-weight:700;
          white-space:nowrap;
        }

        .top-btn {
          background:#2563eb;
          color:white;
          padding:8px 14px;
          border-radius:6px;
          text-decoration:none;
          font-size:14px;
          white-space:nowrap;
        }

        /* テーブル */
        .table-wrapper {
          overflow-x:auto;
          border-radius:8px;
          border:1px solid #e5e7eb;
          background:white;
        }

        table {
          width:100%;
          border-collapse:collapse;
          min-width:600px;
        }

        th, td {
          padding:8px;
          border-bottom:1px solid #eee;
          text-align:center;
          white-space:nowrap;
          font-size:14px;
        }

        th { background:#2563eb; color:white; }

        /* ページネーション */
        .pagination {
          display:flex;
          justify-content:center;
          align-items:center;
          gap:10px;
          margin-top:20px;
        }

        .page-btn {
          background:#2563eb;
          color:white;
          padding:6px 12px;
          border-radius:6px;
          text-decoration:none;
          font-size:14px;
        }

        .page-info {
          font-size:14px;
        }
      </style>
    </head>
    <body>
      <div class="header-row">
        <div class="header-title">マニュアル閲覧ログ</div>
        <a href="/${store}/admin" class="top-btn">← 管理TOPへ戻る</a>
      </div>

      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>マニュアル名</th>
              <th>閲覧日時</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      ${pagination}

    </body>
    </html>
  `);
});

function calculateWorkTimes(works, storeSettings, staffSettings) {

  let totalMinutes = 0;
  let nightMinutes = 0;
  let overtimeMinutes = 0;

  for (const w of works) {
    const start = new Date(w.clockIn);
    const end   = new Date(w.clockOut);
    const breakStart = w.breakStart ? new Date(w.breakStart) : null;
    const breakEnd   = w.breakEnd   ? new Date(w.breakEnd)   : null;

    let workMinutes = (end - start) / 60000;

    // 休憩控除
    if (breakStart && breakEnd) {
      workMinutes -= (breakEnd - breakStart) / 60000;
    }

    // 深夜時間 → 22:00〜5:00 を計算
    nightMinutes += calcNightMinutes(start, end);

    totalMinutes += workMinutes;
  }

  // 残業（例：8時間超）
  if (totalMinutes > storeSettings.standardMinutes) {
    overtimeMinutes = totalMinutes - storeSettings.standardMinutes;
  }

  return { totalMinutes, nightMinutes, overtimeMinutes };
}

function calcSalary(times, staff, store) {

  const baseWage = staff.hourlyWage;
  const nightWage = staff.nightWage || Math.floor(baseWage * store.nightRate);
  const overtimeWage = Math.floor(baseWage * store.overtimeRate);

  const normalMinutes  = times.totalMinutes - times.nightMinutes - times.overtimeMinutes;

  const normalPay  = (normalMinutes  / 60) * baseWage;
  const nightPay   = (times.nightMinutes / 60) * nightWage;
  const overtimePay= (times.overtimeMinutes / 60) * overtimeWage;

  return {
    normalPay,
    nightPay,
    overtimePay,
    transport: staff.transport,
    total: normalPay + nightPay + overtimePay + staff.transport
  };
}

app.get("/:store/admin/payroll/json", ensureStore, async (req, res) => {
  try {
    const { store } = req;
    const userId = req.query.userId;
    const month = req.query.month;

    if (!userId || !month)
      return res.status(400).json({ error: "userId と month が必要です" });

    // 店舗設定から締め日取得
    const storeGeneralSnap = await db
      .collection("companies")
      .doc(store)
      .collection("settings")
      .doc("storeGeneral")
      .get();

    const closingDay = storeGeneralSnap.exists
      ? storeGeneralSnap.data().closingDay
      : 25;

    const period = getPeriod(month, closingDay);

    const result = await calcPayroll(db, store, userId, period);

    res.json(result);
  } catch (e) {
    console.error("payroll error:", e);
    res.status(500).json({ error: "給与計算エラー" });
  }
});

app.post("/:store/shift/submit", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, date, shift } = req.body;

  try {
    await db.collection("companies").doc(store)
      .collection("shifts").doc(`${userId}_${date}`)
      .set({ userId, date, shift });

    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: "保存に失敗しました" });
  }
});

// ==============================
// 👇 シフト取得API（各スタッフ用）
// ==============================
app.get("/:store/shift/records", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, month } = req.query; // month: "2025-11"

  if (!userId || !month) {
    return res.status(400).json({ error: "userId と month は必須です" });
  }

  const start = month + "-01";
  const end = month + "-31";

  try {
    const snap = await db
      .collection("companies")
      .doc(store)
      .collection("shifts")
      .where("userId", "==", userId)
      .where("date", ">=", start)
      .where("date", "<=", end)
      .get();

    const data = snap.docs.map((doc) => doc.data());
    res.json(data);
  } catch (e) {
    console.error("shift/records error:", e);
    res.status(500).json({ error: "データ取得に失敗しました" });
  }
});

// ==============================
// 👇 シフト保存API（各スタッフ用）
// ==============================
app.post("/:store/shift/save", ensureStore, async (req, res) => {
  const { store } = req.params;
  const { userId, date, shifts } = req.body;

  if (!userId || !date || !Array.isArray(shifts)) {
    return res.status(400).json({ error: "userId / date / shifts が不正です" });
  }

  try {
    const docId = `${userId}_${date}`;
    await db
      .collection("companies")
      .doc(store)
      .collection("shifts")
      .doc(docId)
      .set(
        {
          userId,
          date,
          shifts: shifts.map((s) => ({
            start: s.start || "",
            end: s.end || ""
          }))
        },
        { merge: true }
      );

    res.json({ status: "ok" });
  } catch (e) {
    console.error("shift/save error:", e);
    res.status(500).json({ error: "保存に失敗しました" });
  }
});

// ==============================
// 🗓 シフト管理画面（スタッフ自分用）
// ==============================
app.get("/:store/shift", ensureStore, (req, res) => {
  const { store, storeConf } = req;

  res.send(`
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${store} シフト管理</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Noto Sans JP", sans-serif;
        margin: 0;
        padding: 0;
        background: #f3f4f6;
      }
      .layout {
        max-width: 1100px;
        margin: 0 auto;
        padding: 16px;
      }
      h1 {
        text-align: center;
        color: #2563eb;
        margin-bottom: 8px;
      }
      #userStatus {
        text-align: center;
        color: #6b7280;
        font-size: 14px;
        margin-bottom: 16px;
      }

      .toolbar {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .toolbar button {
        border: none;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        background: #2563eb;
        color: white;
        font-size: 13px;
      }
      .toolbar input[type="month"] {
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        font-size: 14px;
      }

      .main {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
        gap: 16px;
      }
      @media (max-width: 800px) {
        .main {
          grid-template-columns: 1fr;
        }
      }

      /* カレンダー */
      .calendar {
        background: white;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.08);
        padding: 12px;
      }
      .calendar table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 12px;
      }
      .calendar th,
      .calendar td {
        border: 1px solid #e5e7eb;
        padding: 4px;
        vertical-align: top;
        height: 70px;
      }
      .calendar th {
        background: #eff6ff;
        color: #2563eb;
        text-align: center;
        font-weight: 600;
      }
      .day-cell {
        cursor: pointer;
        position: relative;
      }
      .day-num {
        font-size: 11px;
        font-weight: 600;
        color: #4b5563;
      }
      .today .day-num {
        background: #2563eb;
        color: white;
        border-radius: 999px;
        padding: 2px 6px;
      }
      .has-shift {
        background: #ecfeff;
      }
      .shift-chip {
        margin-top: 4px;
        display: inline-block;
        padding: 2px 4px;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
      }
      .selected-day {
        outline: 2px solid #2563eb;
        outline-offset: -2px;
      }

      /* 日別詳細 */
      .detail {
        background: white;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.08);
        padding: 16px;
      }
      .detail-title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 4px;
        color: #111827;
      }
      .detail-sub {
        font-size: 13px;
        color: #6b7280;
        margin-bottom: 12px;
      }
      .shift-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 12px;
      }
      .shift-row {
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 8px;
        background: #f9fafb;
      }
      .shift-row-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 13px;
        margin-bottom: 6px;
      }
      .shift-row-header button {
        border: none;
        background: none;
        color: #dc2626;
        font-size: 12px;
        cursor: pointer;
      }
      .shift-row-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 6px;
      }
      .shift-row-body label {
        font-size: 12px;
        color: #4b5563;
        display: block;
        margin-bottom: 2px;
      }
      .shift-row-body input[type="time"] {
        width: 100%;
        padding: 4px 6px;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        font-size: 13px;
      }

      /* ドラッグ用スライダー（start / end） */
      .slider-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        align-items: center;
        margin-top: 4px;
      }
      .slider-row input[type="range"] {
        width: 100%;
      }
      .slider-label {
        font-size: 11px;
        color: #6b7280;
      }

      .detail-buttons {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .btn-primary {
        border: none;
        background: #2563eb;
        color: white;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
      }
      .btn-secondary {
        border: none;
        background: #e5e7eb;
        color: #374151;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
      }

      /* トースト */
      #toast {
        display: none;
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15,23,42,0.9);
        color: #f9fafb;
        padding: 10px 18px;
        border-radius: 999px;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(15,23,42,0.4);
        z-index: 9999;
        opacity: 0;
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <h1>${store} シフト管理</h1>
      <div id="userStatus">LINEログイン中...</div>

      <div class="toolbar">
        <button id="prevMonthBtn">◀ 前月</button>
        <input type="month" id="monthInput" />
        <button id="nextMonthBtn">次月 ▶</button>
      </div>

      <div class="main">
        <!-- カレンダー -->
        <div class="calendar">
          <table>
            <thead>
              <tr>
                <th>日</th><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th>土</th>
              </tr>
            </thead>
            <tbody id="calendarBody"></tbody>
          </table>
        </div>

        <!-- 日別詳細 -->
        <div class="detail">
          <div class="detail-title" id="detailDateLabel">日付を選択してください</div>
          <div class="detail-sub" id="detailSubLabel"></div>

          <div class="shift-list" id="shiftList"></div>

          <div class="detail-buttons">
            <button class="btn-secondary" id="addShiftBtn">＋ シフトを追加</button>
            <button class="btn-primary" id="saveShiftBtn">この日のシフトを保存</button>
          </div>
        </div>
      </div>
    </div>

    <div id="toast"></div>

    <script>
      const STORE = "${store}";
      const LIFF_ID = "${storeConf.liffId}";

      let userId = null;
      let userName = "";
      let currentMonth = null; // "YYYY-MM"
      let shiftsMap = {}; // { "YYYY-MM-DD": [{start,end}, ...] }
      let selectedDate = null; // "YYYY-MM-DD"

      // ========= ユーティリティ =========
      function showToast(msg) {
        const t = document.getElementById("toast");
        t.textContent = msg;
        t.style.display = "block";
        t.style.transition = "none";
        t.style.opacity = "1";
        setTimeout(() => {
          t.style.transition = "opacity 0.4s";
          t.style.opacity = "0";
          setTimeout(() => {
            t.style.display = "none";
          }, 400);
        }, 2000);
      }

      function toDateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2,"0");
        const day = String(d.getDate()).padStart(2,"0");
        return y + "-" + m + "-" + day;
      }

      function getTodayKey() {
        const now = new Date();
        const jst = new Date(now.getTime() + 9*60*60*1000);
        return toDateKey(jst);
      }

      function minToTimeStr(min) {
        const h = Math.floor(min/60);
        const m = min % 60;
        return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
      }

      function timeStrToMin(str) {
        if (!str) return 0;
        const [h,m] = str.split(":").map(n => parseInt(n));
        return h*60 + m;
      }

      // ========= カレンダー描画 =========
      function buildCalendar(year, month) { // month: 0-11
        const body = document.getElementById("calendarBody");
        body.innerHTML = "";

        const first = new Date(year, month, 1);
        const firstDay = first.getDay(); // 0:日
        const daysInMonth = new Date(year, month+1, 0).getDate();
        const todayKey = getTodayKey();

        let dateCounter = 1;
        for (let row = 0; row < 6; row++) {
          let tr = document.createElement("tr");
          for (let col = 0; col < 7; col++) {
            let td = document.createElement("td");
            td.classList.add("day-cell");

            if (row === 0 && col < firstDay || dateCounter > daysInMonth) {
              td.innerHTML = "";
            } else {
              const d = new Date(year, month, dateCounter);
              const dateKey = toDateKey(d);

              const wrapper = document.createElement("div");
              const dayNum = document.createElement("div");
              dayNum.className = "day-num";
              dayNum.textContent = dateCounter;

              if (dateKey === todayKey) {
                td.classList.add("today");
              }

              const shifts = shiftsMap[dateKey] || [];
              if (shifts.length > 0) {
                td.classList.add("has-shift");
                const chip = document.createElement("div");
                chip.className = "shift-chip";
                chip.textContent = shifts
                  .map(s => (s.start || "") + "-" + (s.end || ""))
                  .join(" / ");
                wrapper.appendChild(chip);
              }

              wrapper.insertBefore(dayNum, wrapper.firstChild);
              td.appendChild(wrapper);

              td.dataset.date = dateKey;
              td.onclick = () => selectDate(dateKey);
              if (selectedDate === dateKey) {
                td.classList.add("selected-day");
              }

              dateCounter++;
            }

            tr.appendChild(td);
          }
          body.appendChild(tr);
        }
      }

      function refreshCalendar() {
        const [y,m] = currentMonth.split("-").map(n => parseInt(n));
        buildCalendar(y, m-1);
      }

      // ========= 日別詳細 =========
      function renderDetail() {
        const list = document.getElementById("shiftList");
        const label = document.getElementById("detailDateLabel");
        const sub = document.getElementById("detailSubLabel");

        if (!selectedDate) {
          label.textContent = "日付を選択してください";
          sub.textContent = "";
          list.innerHTML = "";
          return;
        }

        label.textContent = selectedDate;
        sub.textContent = userName + " さんのシフト";

        const shifts = shiftsMap[selectedDate] || [];
        list.innerHTML = "";

        shifts.forEach((shift, idx) => {
          const row = document.createElement("div");
          row.className = "shift-row";

          const header = document.createElement("div");
          header.className = "shift-row-header";
          header.innerHTML = \`
            <span>シフト \${idx+1}</span>
            <button type="button">削除</button>
          \`;
          header.querySelector("button").onclick = () => {
            shifts.splice(idx,1);
            shiftsMap[selectedDate] = shifts;
            renderDetail();
            refreshCalendar();
          };

          const body = document.createElement("div");
          body.className = "shift-row-body";
          body.innerHTML = \`
            <div>
              <label>開始</label>
              <input type="time" value="\${shift.start || ""}" />
            </div>
            <div>
              <label>終了</label>
              <input type="time" value="\${shift.end || ""}" />
            </div>
          \`;

          const startInput = body.querySelectorAll("input")[0];
          const endInput = body.querySelectorAll("input")[1];

          // スライダー行（ドラッグで編集）
          const sliderRow = document.createElement("div");
          sliderRow.className = "slider-row";
          sliderRow.innerHTML = \`
            <div>
              <div class="slider-label">ドラッグで開始時刻</div>
              <input type="range" min="0" max="1440" step="15" />
            </div>
            <div>
              <div class="slider-label">ドラッグで終了時刻</div>
              <input type="range" min="0" max="1440" step="15" />
            </div>
          \`;

          const startSlider = sliderRow.querySelectorAll("input[type=range]")[0];
          const endSlider = sliderRow.querySelectorAll("input[type=range]")[1];

          // 初期値
          startSlider.value = timeStrToMin(shift.start || "09:00");
          endSlider.value   = timeStrToMin(shift.end   || "18:00");

          // 入力→スライダー反映
          startInput.onchange = () => {
            const v = timeStrToMin(startInput.value);
            startSlider.value = v;
            shift.start = startInput.value;
            shiftsMap[selectedDate] = shifts;
            refreshCalendar();
          };
          endInput.onchange = () => {
            const v = timeStrToMin(endInput.value);
            endSlider.value = v;
            shift.end = endInput.value;
            shiftsMap[selectedDate] = shifts;
            refreshCalendar();
          };

          // スライダー→入力反映（ドラッグで編集）
          startSlider.oninput = () => {
            const t = minToTimeStr(parseInt(startSlider.value));
            startInput.value = t;
            shift.start = t;
            shiftsMap[selectedDate] = shifts;
            refreshCalendar();
          };
          endSlider.oninput = () => {
            const t = minToTimeStr(parseInt(endSlider.value));
            endInput.value = t;
            shift.end = t;
            shiftsMap[selectedDate] = shifts;
            refreshCalendar();
          };

          row.appendChild(header);
          row.appendChild(body);
          row.appendChild(sliderRow);
          list.appendChild(row);
        });

        if (shifts.length === 0) {
          list.innerHTML = "<div style='font-size:13px; color:#9ca3af;'>シフトが未登録です。「＋ シフトを追加」から登録してください。</div>";
        }
      }

      function selectDate(dateKey) {
        selectedDate = dateKey;
        renderDetail();
        refreshCalendar();
      }

      function addShift() {
        if (!selectedDate) {
          showToast("先にカレンダーから日付を選択してください");
          return;
        }
        const arr = shiftsMap[selectedDate] || [];
        arr.push({ start: "09:00", end: "18:00" });
        shiftsMap[selectedDate] = arr;
        renderDetail();
        refreshCalendar();
      }

      async function saveShifts() {
        if (!selectedDate) {
          showToast("日付が選択されていません");
          return;
        }
        const shifts = shiftsMap[selectedDate] || [];

        try {
          const res = await fetch("/" + STORE + "/shift/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId,
              date: selectedDate,
              shifts
            })
          });
          const json = await res.json();
          if (json.status === "ok") {
            showToast("シフトを保存しました");
          } else {
            showToast("保存に失敗しました");
            console.error(json);
          }
        } catch (e) {
          console.error(e);
          showToast("通信エラーが発生しました");
        }
      }

      async function loadShifts() {
        if (!userId || !currentMonth) return;

        try {
          const res = await fetch("/" + STORE + "/shift/records?userId=" + userId + "&month=" + currentMonth);
          const data = await res.json();
          shiftsMap = {};
          data.forEach((row) => {
            shiftsMap[row.date] = row.shifts || [];
          });
          refreshCalendar();
          renderDetail();
        } catch (e) {
          console.error(e);
          showToast("シフト取得に失敗しました");
        }
      }

      // ========= 初期化 =========
      async function main() {
        try {
          await liff.init({ liffId: LIFF_ID });
          if (!liff.isLoggedIn()) {
            return liff.login({ redirectUri: window.location.href });
          }
          const profile = await liff.getProfile();
          userId = profile.userId;
          userName = profile.displayName || "";
          document.getElementById("userStatus").textContent =
            userName + " さんでログイン中";

          // 月の初期値（JST）
          const now = new Date();
          const jst = new Date(now.getTime() + 9*60*60*1000);
          const y = jst.getFullYear();
          const m = String(jst.getMonth() + 1).padStart(2,"0");
          currentMonth = y + "-" + m;

          const monthInput = document.getElementById("monthInput");
          monthInput.value = currentMonth;

          monthInput.onchange = () => {
            currentMonth = monthInput.value;
            loadShifts();
          };

          document.getElementById("prevMonthBtn").onclick = () => {
            const [yy, mm] = currentMonth.split("-").map(n => parseInt(n));
            const dt = new Date(yy, mm - 2, 1); // 1ヶ月前
            const ny = dt.getFullYear();
            const nm = String(dt.getMonth() + 1).padStart(2,"0");
            currentMonth = ny + "-" + nm;
            monthInput.value = currentMonth;
            loadShifts();
          };
          document.getElementById("nextMonthBtn").onclick = () => {
            const [yy, mm] = currentMonth.split("-").map(n => parseInt(n));
            const dt = new Date(yy, mm, 1); // 1ヶ月後
            const ny = dt.getFullYear();
            const nm = String(dt.getMonth() + 1).padStart(2,"0");
            currentMonth = ny + "-" + nm;
            monthInput.value = currentMonth;
            loadShifts();
          };

          document.getElementById("addShiftBtn").onclick = addShift;
          document.getElementById("saveShiftBtn").onclick = saveShifts;

          // 初期カレンダー描画 & データ読み込み
          const [iy, im] = currentMonth.split("-").map(n => parseInt(n));
          buildCalendar(iy, im-1);

          // 今日を選択しておく
          selectedDate = getTodayKey();
          renderDetail();

          await loadShifts();
        } catch (e) {
          console.error("LIFF 初期化エラー:", e);
          document.getElementById("userStatus").textContent =
            "LIFF 初期化エラー: " + e.message;
        }
      }

      document.addEventListener("DOMContentLoaded", main);
    </script>
  </body>
  </html>
  `);
});

// ==============================
// Render 無料プランのスリープ対策（Health Check）
// ==============================
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ==============================
// Render keep-alive（4分ごとに自分自身へ ping）
// ==============================
setInterval(() => {
  fetch("https://line-permission-server.onrender.com/health")
    .then(() => console.log("KeepAlive: OK"))
    .catch(() => console.log("KeepAlive: NG"));
}, 4 * 60 * 1000); // 4分ごと

// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
