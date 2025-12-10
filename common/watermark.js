function addWatermark(userName, dateTime) {
  const text = `${userName} ／ ${dateTime}`;

  const watermark = document.createElement("div");
  watermark.innerText = text;

  Object.assign(watermark.style, {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: 9999,
    opacity: 0.12,
    color: "#000",
    fontSize: "18px",
    transform: "rotate(-30deg)",
    whiteSpace: "nowrap",
    backgroundImage: `
      linear-gradient(
        rgba(0,0,0,0.08) 1px, 
        transparent 1px
      )
    `,
    backgroundSize: "200px 150px",
  });

  document.body.appendChild(watermark);
}
