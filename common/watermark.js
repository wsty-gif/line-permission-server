// ウォーターマーク生成処理
export function applyWatermark(name) {
  const tile = document.getElementById("wmTile");
  if (!tile) return;

  function generate() {
    const now = new Date();
    const time =
      now.getFullYear() +
      "/" + (now.getMonth() + 1) +
      "/" + now.getDate() +
      " " + now.getHours() +
      ":" + String(now.getMinutes()).padStart(2, "0");

    const text = `${name}  ${time}`;

    // 文字を描画したキャンバスを生成
    const canvas = document.createElement("canvas");
    canvas.width = 260;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.15; // かなり薄く
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "#000";
    ctx.rotate(-25 * Math.PI / 180);
    ctx.fillText(text, -50, 120);

    // 背景に敷き詰め
    tile.style.backgroundImage = `url(${canvas.toDataURL()})`;
  }

  generate();
}
