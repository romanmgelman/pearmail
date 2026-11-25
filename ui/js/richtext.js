// Rich-text signature: cleaning pasted / stored HTML down to simple formatting,
// and the small formatting bar shared by the Settings signature editor.
import { esc } from "./api.js";
import { icon } from "./icons.js";
import { showMenu, dialog } from "./ui.js";

const KEEP = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "BR", "DIV", "P", "SPAN", "FONT", "A", "UL", "OL", "LI"]);
const DROP = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "META", "LINK", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH", "NOSCRIPT"]);
const SAFE_URL = /^(https?:|mailto:)/i;

/** Keep only simple formatting (bold, italics, underline, strikethrough, size, links, lists). */
export function cleanSignatureHtml(html) {
  const t = document.createElement("template");
  t.innerHTML = String(html || "");
  const walk = (parent) => {
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) continue;
      if (n.nodeType !== Node.ELEMENT_NODE) { n.remove(); continue; }
      if (DROP.has(n.tagName)) { n.remove(); continue; }
      walk(n);
      if (!KEEP.has(n.tagName)) { n.replaceWith(...n.childNodes); continue; }
      for (const a of [...n.attributes]) {
        const ok = (n.tagName === "A" && a.name === "href" && SAFE_URL.test(a.value.trim()))
          || (n.tagName === "FONT" && a.name === "size" && /^[1-7]$/.test(a.value));
        if (!ok) n.removeAttribute(a.name);
      }
    }
  };
  walk(t.content);
  const div = document.createElement("div");
  div.appendChild(t.content);
  return div.innerHTML;
}

/** A stored signature as HTML. Older signatures were plain text: keep their line breaks. */
export function signatureToHtml(sig) {
  const s = String(sig || "").trim();
  if (!s) return "";
  if (!/<[a-z][^>]*>/i.test(s)) return esc(s).split("\n").join("<br>");
  return cleanSignatureHtml(s);
}

/** Does the signature have anything visible? */
export function signatureIsEmpty(sig) {
  const div = document.createElement("div");
  div.innerHTML = signatureToHtml(sig);
  return !div.textContent.trim();
}

export const fmtBarHtml = () => `
  <button type="button" class="tb-btn" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
  <button type="button" class="tb-btn" data-cmd="italic" title="Italic (Ctrl+I)"><i style="font-family:Georgia,serif">I</i></button>
  <button type="button" class="tb-btn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
  <button type="button" class="tb-btn" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
  <div class="tb-sep"></div>
  <button type="button" class="tb-btn" data-a="size" title="Text Size">${icon("textFormat")}</button>
  <button type="button" class="tb-btn" data-a="link" title="Insert Link">${icon("link")}</button>`;

/** Wire a formatting bar to a contenteditable editor. Returns a function that unhooks it. */
export function attachFmtBar(bar, editor) {
  const btns = [...bar.querySelectorAll("[data-cmd]")];
  const sync = () => {
    const sel = document.getSelection();
    const inEditor = !!sel?.anchorNode && editor.contains(sel.anchorNode);
    for (const b of btns) {
      let on = false;
      if (inEditor) { try { on = document.queryCommandState(b.dataset.cmd); } catch {} }
      b.classList.toggle("on", on);
    }
  };
  document.addEventListener("selectionchange", sync);
  bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection in the editor
  bar.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a],[data-cmd]");
    if (!b) return;
    if (b.dataset.cmd) { editor.focus(); document.execCommand(b.dataset.cmd); sync(); return; }
    if (b.dataset.a === "size") {
      const set = (n) => () => { editor.focus(); document.execCommand("fontSize", false, n); };
      showMenu([
        { label: "Small", action: set(2) },
        { label: "Medium", action: set(3) },
        { label: "Large", action: set(5) },
        { label: "Extra Large", action: set(6) },
      ], b.getBoundingClientRect());
    } else if (b.dataset.a === "link") {
      const sel = window.getSelection();
      const range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      const r = await dialog({ title: "Add Link", fields: [{ id: "url", placeholder: "https://example.com", value: "https://" }], ok: "Add" });
      if (r?.url && r.url !== "https://") {
        const url = /^(https?:|mailto:)/i.test(r.url) ? r.url : `https://${r.url}`;
        editor.focus();
        if (range) { sel.removeAllRanges(); sel.addRange(range); }
        if (range && !range.collapsed) document.execCommand("createLink", false, url);
        else document.execCommand("insertHTML", false, `<a href="${esc(url)}">${esc(url)}</a>`);
      }
    }
  });
  // Pasting from a web page or Word keeps only simple formatting.
  editor.addEventListener("paste", (e) => {
    const html = e.clipboardData?.getData("text/html");
    const text = e.clipboardData?.getData("text/plain");
    if (!html && !text) return;
    e.preventDefault();
    document.execCommand("insertHTML", false, html ? cleanSignatureHtml(html) : esc(text).split(/\r?\n/).join("<br>"));
  });
  return () => document.removeEventListener("selectionchange", sync);
}
