// Finger signature pad on a <canvas>. Keeps the drawing as a PNG data URL.

export function setupSig(canvas, { get, set }) {
  const dpr = window.devicePixelRatio || 1;
  let ctx;

  function size() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1d2420";
    ctx.fillStyle = "#1d2420";
    const v = get();
    if (v) {
      const im = new Image();
      im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height);
      im.src = v;
    }
  }
  size();

  let drawing = false, last = null, dirty = false;
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.onpointerdown = (e) => {
    drawing = true;
    dirty = true;
    last = pt(e);
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    const p = pt(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    if (drawing && dirty) set(canvas.toDataURL("image/png"));
    drawing = false;
  };

  // Redraw at the new size when the phone rotates.
  let w = canvas.getBoundingClientRect().width;
  const ro = new ResizeObserver(() => {
    const nw = canvas.getBoundingClientRect().width;
    if (nw && Math.abs(nw - w) > 1) { w = nw; size(); }
  });
  ro.observe(canvas);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      set(null);
    },
    destroy() { ro.disconnect(); },
  };
}
