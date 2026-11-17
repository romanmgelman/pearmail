// Clean PDF previews: white pages on the viewer's dark backdrop, drawn with the bundled
// pdf.js (ui/vendor/pdfjs). No toolbar or other viewer chrome. Text stays selectable.

let lib = null;
const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;

/** pdf.js, loaded the first time a PDF is shown (keeps it out of startup). */
async function pdfjs() {
  if (!lib) {
    lib = await import("../vendor/pdfjs/pdf.min.js");
    lib.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.js";
  }
  return lib;
}

async function open(buf) {
  const p = await pdfjs();
  return p.getDocument({
    // pdf.js takes ownership of (detaches) the buffer it's given: hand it a copy.
    data: new Uint8Array(buf.slice(0)),
    isEvalSupported: false,
    cMapUrl: VENDOR + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: VENDOR + "standard_fonts/",
  }).promise;
}

const MAX_WIDTH = 900; // pages read like paper, not stretched across a wide window
const GAP = 16;

/**
 * Show a PDF in `stage`. Pages are laid out up front at their real proportions and
 * drawn as they scroll near view; far-away pages drop their pixels again.
 * `onPage(current, total)` reports the page in view. Returns a cleanup function.
 */
export async function renderPdf(stage, buf, { onPage, alive = () => true } = {}) {
  const doc = await open(buf);
  const p = await pdfjs();
  if (!alive()) { doc.destroy(); return () => {}; } // the viewer moved on meanwhile
  const scroll = document.createElement("div");
  scroll.className = "pdf-scroll";
  scroll.tabIndex = 0;
  stage.replaceChildren(scroll);

  // Page sizes (in PDF points at scale 1).
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const v = pg.getViewport({ scale: 1 });
    sizes.push({ w: v.width, h: v.height });
  }
  let zoom = 1;
  const fitScale = (s) => Math.min(MAX_WIDTH, scroll.clientWidth - 2 * GAP) / s.w;
  const pages = sizes.map((s, i) => {
    const el = document.createElement("div");
    el.className = "pdf-page";
    el.dataset.page = i + 1;
    scroll.appendChild(el);
    return { el, size: s, drawn: 0, task: null, text: null };
  });

  const layout = () => {
    for (const pg of pages) {
      const scale = fitScale(pg.size) * zoom;
      pg.scale = scale;
      pg.el.style.width = Math.floor(pg.size.w * scale) + "px";
      pg.el.style.height = Math.floor(pg.size.h * scale) + "px";
      pg.el.style.setProperty("--scale-factor", scale);
    }
  };

  const clear = (pg) => {
    pg.task?.cancel();
    pg.task = null;
    pg.text?.cancel?.();
    pg.text = null;
    pg.el.replaceChildren();
    pg.drawn = 0;
  };

  const draw = async (pg) => {
    if (pg.drawn === pg.scale || pg.task) return;
    const want = pg.scale;
    const page = await doc.getPage(+pg.el.dataset.page);
    const viewport = page.getViewport({ scale: want });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    pg.task = task;
    try {
      await task.promise;
    } catch {
      if (pg.task === task) pg.task = null;
      return; // cancelled (scrolled away or zoomed)
    }
    if (pg.task !== task) return;
    pg.task = null;
    const textDiv = document.createElement("div");
    textDiv.className = "textLayer";
    pg.el.replaceChildren(canvas, textDiv);
    pg.drawn = want;
    try {
      pg.text = new p.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      await pg.text.render();
    } catch {}
  };

  const near = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const pg = pages[+e.target.dataset.page - 1];
        if (e.isIntersecting) { near.add(pg); draw(pg); }
        else { near.delete(pg); clear(pg); }
      }
    },
    { root: scroll, rootMargin: "150% 0px" },
  );
  layout();
  pages.forEach((pg) => io.observe(pg.el));

  // The page in view: the one crossing the middle of the column.
  const current = () => {
    const mid = scroll.scrollTop + scroll.clientHeight / 2;
    let n = 1;
    for (const pg of pages) if (pg.el.offsetTop <= mid) n = +pg.el.dataset.page;
    return n;
  };
  let last = 0;
  const report = () => { const n = current(); if (n !== last) { last = n; onPage?.(n, pages.length); } };
  scroll.addEventListener("scroll", report, { passive: true });
  report();

  // Ctrl+wheel / Ctrl+= / Ctrl+- zoom; Ctrl+0 back to fit. Keeps the same spot in view.
  const setZoom = (z) => {
    z = Math.min(3, Math.max(0.5, z));
    if (z === zoom) return;
    const ratio = scroll.scrollTop / Math.max(1, scroll.scrollHeight);
    zoom = z;
    layout();
    scroll.scrollTop = ratio * scroll.scrollHeight;
    for (const pg of near) { clear(pg); draw(pg); }
  };
  scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  const onKey = (e) => {
    if (!e.ctrlKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(zoom * 1.2); }
    if (e.key === "-") { e.preventDefault(); setZoom(zoom / 1.2); }
    if (e.key === "0") { e.preventDefault(); setZoom(1); }
  };
  document.addEventListener("keydown", onKey, true);

  // The window got resized: pages fit the new width.
  let width = scroll.clientWidth;
  const ro = new ResizeObserver(() => {
    if (scroll.clientWidth === width) return;
    width = scroll.clientWidth;
    layout();
    for (const pg of near) { clear(pg); draw(pg); }
  });
  ro.observe(scroll);
  scroll.focus({ preventScroll: true });

  return () => {
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("keydown", onKey, true);
    pages.forEach(clear);
    doc.destroy();
  };
}

/** First page of a PDF as a PNG data URL, `width` px wide (for attachment tiles). */
export async function pdfThumbnail(buf, width = 360) {
  const doc = await open(buf);
  try {
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / v1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    doc.destroy();
  }
}
