// Floating compose window (New Message / Reply / Forward / Draft).
import { api, esc, fileSize, longDate, displayName, store, errText, rememberContacts } from "./api.js";
import { icon } from "./icons.js";
import { toast, showMenu, dialog } from "./ui.js";

let current = null; // active compose controller
let avatarFn = null; // (person) => avatar HTML, provided by the app
let pendingSend = null; // a sent message waiting out its Undo Send window: { run, undo }

/** Send a message that's waiting in the outbox right away (e.g. the app is closing). */
export const hasPendingSend = () => !!pendingSend;
export async function flushPendingSend() {
  if (pendingSend) await pendingSend.run();
}

/** The "Sending… Undo Send" bar at the bottom left, like iCloud Mail. */
function showOutbox(seconds, onUndo) {
  document.querySelector(".send-pending")?.remove();
  const bar = document.createElement("div");
  bar.className = "send-pending";
  bar.innerHTML = `<div class="sp-row">${icon("sent")}<span class="sp-label">Sending…</span><button class="sp-undo">Undo Send</button></div><div class="sp-progress"><div></div></div>`;
  bar.querySelector(".sp-progress div").style.animationDuration = seconds + "s";
  bar.querySelector(".sp-undo").addEventListener("click", onUndo);
  document.body.appendChild(bar);
  return () => {
    bar.classList.add("leaving");
    setTimeout(() => bar.remove(), 180);
  };
}
// Ctrl+Z undoes a pending send.
document.addEventListener("keydown", (e) => {
  if (pendingSend && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|TEXTAREA/.test(e.target.tagName) && !e.target.isContentEditable) {
    e.preventDefault();
    e.stopPropagation();
    pendingSend.undo();
  }
}, true);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function parseAddr(raw) {
  const s = raw.trim().replace(/[,;]$/, "").trim();
  if (!s) return null;
  const m = s.match(/^(.*)<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() };
  return { name: "", email: s };
}
const fmtAddr = (p) => (p.name ? `"${p.name.replace(/"/g, "")}" <${p.email}>` : p.email);
const angle = (id) => (id ? (id.startsWith("<") ? id : `<${id}>`) : null);


function suggestions(q, exclude) {
  q = q.toLowerCase();
  if (!q) return [];
  const c = Object.values(store.get("contacts", {}));
  return c
    .filter((p) => !exclude.has(p.email.toLowerCase()) && (p.email.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.n || 0) - (a.n || 0))
    .slice(0, 8);
}

function stripForQuote(html, allowRemote) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, link, meta, title").forEach((n) => n.remove());
  if (!allowRemote) doc.querySelectorAll("img").forEach((img) => /^https?:/i.test(img.getAttribute("src") || "") && img.remove());
  return doc.body.innerHTML;
}

/** Field with address tokens. */
class TokenField {
  constructor(container, initial = []) {
    this.el = container;
    this.tokens = [];
    this.wrap = container.querySelector(".tokens");
    this.input = container.querySelector("input");
    this.sugEl = null;
    this.sugIdx = 0;
    initial.forEach((p) => this.add(p));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("input", () => this.showSuggest());
    this.input.addEventListener("blur", () => setTimeout(() => { this.commit(); this.hideSuggest(); }, 150));
    this.input.addEventListener("paste", (e) => {
      const t = e.clipboardData.getData("text");
      if (/[,;\n]/.test(t)) {
        e.preventDefault();
        t.split(/[,;\n]+/).forEach((x) => { const p = parseAddr(x); if (p) this.add(p); });
      }
    });
    this.el.addEventListener("mousedown", (e) => { if (e.target === this.el || e.target === this.wrap) { e.preventDefault(); this.input.focus(); } });
  }
  add(p) {
    if (!p?.email) return;
    if (this.tokens.some((t) => t.email.toLowerCase() === p.email.toLowerCase())) return;
    this.tokens.push(p);
    const t = document.createElement("span");
    t.className = "token" + (EMAIL_RE.test(p.email) ? "" : " invalid");
    t.title = p.email;
    t.innerHTML = `<span>${esc(p.name || p.email)}</span>`;
    t.tabIndex = -1;
    t.addEventListener("click", () => { this.wrap.querySelectorAll(".token.sel").forEach((x) => x.classList.remove("sel")); t.classList.add("sel"); t.focus(); });
    t.addEventListener("dblclick", () => { this.remove(p, t); this.input.value = fmtAddr(p); this.input.focus(); });
    t.addEventListener("keydown", (e) => { if (e.key === "Backspace" || e.key === "Delete") { this.remove(p, t); this.input.focus(); } });
    this.wrap.insertBefore(t, this.input);
    this.onChange?.();
  }
  remove(p, el) {
    this.tokens = this.tokens.filter((x) => x !== p);
    el.remove();
    this.onChange?.();
  }
  commit() {
    const v = this.input.value;
    if (!v.trim()) return;
    v.split(/[,;]+/).forEach((x) => { const p = parseAddr(x); if (p) this.add(p); });
    this.input.value = "";
  }
  onKey(e) {
    if (this.sugEl) {
      const items = this.sugEl.querySelectorAll(".mi");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.sugIdx = (this.sugIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((m, i) => m.classList.toggle("active", i === this.sugIdx));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && items.length) {
        e.preventDefault();
        items[this.sugIdx].dispatchEvent(new MouseEvent("mousedown"));
        return;
      }
      if (e.key === "Escape") { e.stopPropagation(); this.hideSuggest(); return; }
    }
    if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === "Tab" && this.input.value.trim())) {
      if (this.input.value.trim()) { e.preventDefault(); this.commit(); }
    } else if (e.key === "Backspace" && !this.input.value && this.tokens.length) {
      const last = this.wrap.querySelectorAll(".token");
      this.remove(this.tokens[this.tokens.length - 1], last[last.length - 1]);
    }
  }
  showSuggest() {
    const ex = new Set(this.tokens.map((t) => t.email.toLowerCase()));
    const list = suggestions(this.input.value.trim(), ex);
    this.hideSuggest();
    if (!list.length) return;
    const el = document.createElement("div");
    el.className = "menu suggest";
    this.sugIdx = 0;
    list.forEach((p, i) => {
      const mi = document.createElement("div");
      mi.className = "mi" + (i === 0 ? " active" : "");
      mi.innerHTML = `${avatarFn?.(p) || ""}<div class="st"><div class="sn">${esc(p.name || p.email)}</div>${p.name ? `<div class="se">${esc(p.email)}</div>` : ""}</div>`;
      mi.addEventListener("mousedown", (ev) => { ev.preventDefault(); this.add(p); this.input.value = ""; this.hideSuggest(); this.input.focus(); });
      el.appendChild(mi);
    });
    this.wrap.appendChild(el);
    this.sugEl = el;
  }
  hideSuggest() { this.sugEl?.remove(); this.sugEl = null; }
  values() { this.commit(); return this.tokens.map(fmtAddr); }
  invalid() { return this.tokens.filter((t) => !EMAIL_RE.test(t.email)); }
}

/**
 * opts: { mode: "new"|"reply"|"replyAll"|"forward"|"draft", source?: MessageDetail, to?: [Person],
 *         account: AccountInfo (the From), accounts: AccountInfo[], allowRemote: bool, onDone?: () => void }
 */
export function openCompose(opts) {
  const { mode = "new", source } = opts;
  if (current) {
    // This draft is already open: just bring its window forward.
    if (mode === "draft" && source && current.editing(source)) { current.restore(); return; }
    if (current.isDirty()) {
      current.restore();
      toast("Finish or close the message you're writing first.");
      return;
    }
    // Its latest version is already in Drafts (autosaved); say so instead of leaving it silently.
    if (current.hasDraft()) toast("Saved to Drafts.");
    current.close(false);
  }
  avatarFn = opts.avatar || avatarFn;
  const accounts = opts.accounts?.length ? opts.accounts : [opts.account];
  let from = opts.account || accounts[0];
  // All of the user's own addresses (left out of Reply All).
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  const me = from.email.toLowerCase();
  let to = opts.to || [], cc = [], bcc = [], subject = "", body = "<div><br></div>", inReplyTo = null, references = [];
  let draftUid = null;
  const openedDraft = mode === "draft" ? source?.uid : null;
  const sig = opts.signature?.trim() ? `<div><br></div><div class="pm-signature">${esc(opts.signature.trim()).split("\n").join("<br>")}</div>` : "";
  if (mode === "new") body = `<div><br></div>${sig}`;

  if (source && (mode === "reply" || mode === "replyAll")) {
    const sender = source.replyTo?.length ? source.replyTo : [source.from];
    to = sender.filter((p) => p.email);
    if (mode === "replyAll") {
      const seen = new Set([...mine, ...to.map((p) => p.email.toLowerCase())]);
      for (const p of [...source.to, ...source.cc]) {
        const k = p.email.toLowerCase();
        if (!seen.has(k)) { seen.add(k); (p === source.to.find((x) => x === p) ? to : cc).push(p); }
      }
    }
    // If replying to our own sent message, reply to its recipients instead. A note sent only
    // to yourself has no one else: then the reply goes to you again.
    if (to.length && to.every((p) => mine.has(p.email.toLowerCase())) && source.to.length) {
      const others = source.to.filter((p) => !mine.has(p.email.toLowerCase()));
      if (others.length) to = others;
    }
    subject = /^re:/i.test(source.subject) ? source.subject : `Re: ${source.subject}`;
    inReplyTo = angle(source.messageId);
    references = [...(source.references || []).map(angle), angle(source.messageId)].filter(Boolean);
    const who = esc(source.from.name ? `${source.from.name} <${source.from.email}>` : source.from.email);
    const when = new Date(source.date).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/, (\d+:)/, ", at $1");
    body = `<div><br></div>${sig}<div><br></div><div>On ${esc(when)}, ${who} wrote:</div><div><br></div><blockquote type="cite">${stripForQuote(source.html, opts.allowRemote)}</blockquote>`;
  } else if (source && mode === "forward") {
    subject = /^fwd?:/i.test(source.subject) ? source.subject : `Fwd: ${source.subject}`;
    const line = (k, v) => `<div><b>${k}:</b> ${esc(v)}</div>`;
    const fmtP = (ps) => ps.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
    body = `<div><br></div>${sig}<div><br></div><div>Begin forwarded message:</div><div><br></div><blockquote type="cite">${line("From", fmtP([source.from]))}${line("Subject", source.subject)}${line("Date", longDate(source.date))}${line("To", fmtP(source.to))}${source.cc.length ? line("Cc", fmtP(source.cc)) : ""}<div><br></div>${stripForQuote(source.html, opts.allowRemote)}</blockquote>`;
  } else if (source && mode === "draft") {
    to = source.to.filter((p) => !(p.email.toLowerCase() === me && source.to.length === 1 && !source.subject));
    cc = source.cc;
    bcc = source.bcc || [];
    subject = source.subject;
    body = stripForQuote(source.html, true);
    draftUid = source.uid;
    // Keep the reply's threading headers, so the sent message still joins its conversation.
    inReplyTo = angle(source.inReplyTo);
    references = (source.references || []).map(angle).filter(Boolean);
  }

  const root = document.getElementById("compose-root");
  const el = document.createElement("div");
  el.className = "compose";
  el.innerHTML = `
    <div class="compose-head">
      <div class="t">${esc(subject || "New Message")}</div>
      <span class="status"></span>
      <button class="tb-btn" data-a="discard" title="Delete Draft">${icon("trash")}</button>
      <button class="tb-btn" data-a="min" title="Minimize">${icon("minimize")}</button>
      <button class="tb-btn" data-a="expand" title="Full Screen">${icon("expand")}</button>
      <button class="tb-btn" data-a="close" title="Close">${icon("xmark")}</button>
      <button class="send-btn" data-a="send" title="Send (Ctrl+Enter)">${icon("sent")}Send</button>
    </div>
    <div class="compose-fields">
      <div class="cfield" data-f="to"><label>To:</label><div class="tokens"><input type="text" spellcheck="false"></div><button class="ccbcc" data-a="ccbcc">Cc/Bcc</button></div>
      <div class="cfield" data-f="cc" hidden><label>Cc:</label><div class="tokens"><input type="text" spellcheck="false"></div></div>
      <div class="cfield" data-f="bcc" hidden><label>Bcc:</label><div class="tokens"><input type="text" spellcheck="false"></div></div>
      <div class="cfield"><label>Subject:</label><input type="text" data-f="subject" value="${esc(subject)}" spellcheck="true"></div>
      <div class="cfield"><label>From:</label>${accounts.length > 1 && mode !== "draft"
        ? `<select class="from-select" data-f="from">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === from.id ? "selected" : ""}>${esc(a.senderName ? `${a.senderName} <${a.email}>` : a.email)}</option>`).join("")}</select>`
        : `<div class="from-val">${esc(from.senderName ? `${from.senderName} <${from.email}>` : from.email)}</div>`}</div>
    </div>
    <div class="fmt-bar">
      <button class="tb-btn" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button class="tb-btn" data-cmd="italic" title="Italic (Ctrl+I)"><i style="font-family:Georgia,serif">I</i></button>
      <button class="tb-btn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
      <button class="tb-btn" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
      <div class="tb-sep"></div>
      <button class="tb-btn" data-a="size" title="Text Size">${icon("textFormat")}</button>
      <button class="tb-btn" data-cmd="insertUnorderedList" title="Bulleted List">${icon("listBullet")}</button>
      <button class="tb-btn" data-cmd="insertOrderedList" title="Numbered List">${icon("listNumber")}</button>
      <button class="tb-btn" data-a="link" title="Insert Link">${icon("link")}</button>
      <div class="tb-sep"></div>
      <button class="tb-btn" data-a="attach" title="Attach Files">${icon("paperclip")}</button>
    </div>
    <div class="compose-body"><div class="editor" contenteditable="true" spellcheck="true">${body}</div></div>
    <div class="compose-atts"></div>`;
  root.appendChild(el);

  const $ = (s) => el.querySelector(s);
  const editor = $(".editor");
  const status = $(".status");
  const fTo = new TokenField($('[data-f="to"]'), to);
  const fCc = new TokenField($('[data-f="cc"]'), cc);
  const fBcc = new TokenField($('[data-f="bcc"]'), bcc);
  const subjEl = $('[data-f="subject"]');
  // Switching the From account (only for new messages, replies and forwards).
  $(".from-select")?.addEventListener("change", (e) => {
    from = accounts.find((a) => a.id === e.target.value) || from;
    markDirty();
  });
  let attachments = [];
  let dirty = false, sending = false, saving = null, closed = false, savedHere = false;
  if (cc.length || bcc.length) $('[data-f="cc"]').hidden = $('[data-f="bcc"]').hidden = false;

  const markDirty = () => { dirty = true; status.textContent = ""; };
  [fTo, fCc, fBcc].forEach((f) => (f.onChange = markDirty));
  subjEl.addEventListener("input", () => { markDirty(); $(".compose-head .t").textContent = subjEl.value || "New Message"; });
  editor.addEventListener("input", markDirty);

  const renderAtts = () => {
    $(".compose-atts").innerHTML = attachments
      .map((a, i) => `<div class="att${a.staging ? " staging" : ""}"><div class="ficon">${esc((a.name.split(".").pop() || "").slice(0, 4))}</div><div class="info"><div class="n">${esc(a.name)}</div><div class="s">${fileSize(a.size)}</div></div>${a.staging ? `<span class="spinner"></span>` : `<button class="x" data-i="${i}">${icon("xmark")}</button>`}</div>`)
      .join("");
    $(".compose-atts").querySelectorAll(".x").forEach((b) => (b.onclick = () => { attachments.splice(+b.dataset.i, 1); renderAtts(); markDirty(); }));
  };

  const message = () => {
    const html = `<html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;">${editor.innerHTML}</body></html>`;
    return {
      to: fTo.values(), cc: fCc.values(), bcc: fBcc.values(),
      subject: subjEl.value, html, text: editor.innerText,
      attachments: attachments.filter((a) => a.path).map((a) => ({ name: a.name, path: a.path })),
      inReplyTo, references, draftUid,
    };
  };
  const isEmpty = () => !fTo.tokens.length && !fCc.tokens.length && !subjEl.value.trim() && !editor.innerText.trim() && !attachments.length;
  // What the message looked like when opened (or last saved). A draft is only saved when
  // the content really differs: an "input" event alone (a stray key that changed nothing,
  // text typed and deleted again, the browser tidying the editor) isn't an edit.
  const snapshot = () => JSON.stringify([fTo.values(), fCc.values(), fBcc.values(), subjEl.value, editor.innerHTML, attachments.map((a) => a.path), from.id]);
  let saved = "";
  const changed = () => snapshot() !== saved;
  const needsSave = () => dirty && changed() && !isEmpty();

  async function saveDraft(quiet = true, reason = "autosave") {
    if (saving) return saving; // one save at a time; callers can wait for it
    if (sending || closed && quiet) return;
    status.textContent = "Saving…";
    saving = (async () => {
      try {
        // Files still being copied in go into the draft too; saving without them would
        // replace a draft that has its attachments with one that doesn't.
        while (attachments.some((a) => a.staging)) await Promise.all(attachments.filter((a) => a.staging).map((a) => a.ready));
        const snap = snapshot();
        const uid = await api.saveDraft(from.id, message());
        api.logEvent("draft", `saved (${reason}, ${mode})`);
        draftUid = uid ?? null;
        savedHere = true;
        saved = snap;
        dirty = false;
        status.textContent = "Draft saved";
        opts.onDone?.("draft");
      } catch (e) {
        status.textContent = "";
        if (!quiet) toast("Couldn't save draft: " + errText(e), { error: true });
      } finally {
        saving = null;
      }
    })();
    return saving;
  }
  const autosave = setInterval(() => { if (needsSave()) saveDraft(); }, 30000);

  /** Delete this message's copy in Drafts, waiting for a save in progress so its copy goes too. */
  async function discardSaved() {
    if (saving) await saving.catch(() => {});
    if (!draftUid) return;
    const uid = draftUid;
    draftUid = null;
    try {
      await api.discardDraft(from.id, uid);
      opts.onDone?.("draftDeleted", { account: from.id, uid });
    } catch {}
  }

  async function send() {
    const all = [...fTo.values(), ...fCc.values(), ...fBcc.values()];
    const bad = [...fTo.invalid(), ...fCc.invalid(), ...fBcc.invalid()];
    if (!all.length) { toast("Add at least one recipient.", { error: true }); fTo.input.focus(); return; }
    if (bad.length) { toast(`"${bad[0].email}" is not a valid email address.`, { error: true }); return; }
    if (!subjEl.value.trim()) {
      const r = await dialog({ title: "This message has no subject.", message: "Do you want to send it anyway?", ok: "Send" });
      if (!r) return;
    }
    if (saving) await saving;
    // Files still being copied in from a drop go with the message.
    while (attachments.some((a) => a.staging)) await Promise.all(attachments.filter((a) => a.staging).map((a) => a.ready));
    if (pendingSend) await pendingSend.run(); // one message in the outbox at a time
    sending = true;
    const btn = $('[data-a="send"]');
    btn.disabled = true;
    const msg = message();
    const account = from.id;
    const people = [...fTo.tokens, ...fCc.tokens, ...fBcc.tokens];
    const delay = Math.max(0, +opts.undoDelay || 0);

    const reallySend = async () => {
      try {
        const messageId = await api.send(account, msg);
        rememberContacts(people);
        if (opts.source?.uid && (mode === "reply" || mode === "replyAll")) api.setFlag(opts.source.account, opts.source.folder, [opts.source.uid], "answered", true).catch(() => {});
        close(false);
        toast("Message sent.");
        opts.onDone?.("sent", { messageId, message: msg, account });
      } catch (e) {
        // Didn't go out: bring the message back so nothing is lost.
        sending = false;
        btn.disabled = false;
        status.textContent = "";
        reshow();
        toast(errText(e), { error: true, duration: 8000 });
      }
    };
    if (!delay) {
      status.textContent = "Sending…";
      return reallySend();
    }

    // Like iCloud Mail: the window goes away, the message waits in the outbox and can be taken back.
    el.hidden = true;
    if (current?.el === el) current = null;
    let timer = null;
    let hideBar = null;
    const entry = {
      run: async () => {
        if (pendingSend !== entry) return;
        pendingSend = null;
        clearTimeout(timer);
        hideBar();
        await reallySend();
      },
      undo: () => {
        if (pendingSend !== entry) return;
        pendingSend = null;
        clearTimeout(timer);
        hideBar();
        sending = false;
        btn.disabled = false;
        reshow();
        editor.focus();
      },
    };
    pendingSend = entry;
    hideBar = showOutbox(delay, entry.undo);
    timer = setTimeout(entry.run, delay * 1000);
  }

  /** Show this window again (after Undo Send or a failed send), making room if another is open. */
  function reshow() {
    if (current && current.el !== el) {
      if (current.isDirty()) current.close(true, "make-room");
      else current.close(false);
    }
    el.hidden = false;
    el.classList.remove("minimized");
    applyPos();
    setButtons();
    current = handle();
  }

  /** What the rest of the app can ask of the open window. */
  function handle() {
    return {
      el, close,
      isDirty: needsSave,
      // Saved something to Drafts while open (not just a draft opened and left unchanged).
      hasDraft: () => savedHere && !!draftUid,
      // Is this window editing that draft (as opened, or its latest saved copy)?
      editing: (s) => s.account === from.id && (s.uid === openedDraft || s.uid === draftUid),
      restore: () => morph(() => el.classList.remove("minimized")),
    };
  }

  function close(saveIfNeeded = true, reason = "close") {
    if (closed) return;
    if (saveIfNeeded && (needsSave() || (saving && !isEmpty()))) {
      // Wait for a save already under way, then save whatever changed after it started.
      (async () => {
        if (saving) await saving;
        if (needsSave()) await saveDraft(false, reason);
        if (draftUid) toast("Saved to Drafts.");
      })();
    } else if (saveIfNeeded && isEmpty()) {
      // Everything was erased: don't leave an earlier autosaved copy behind in Drafts.
      discardSaved();
    }
    closed = true;
    clearInterval(autosave);
    window.removeEventListener("resize", onResize);
    el.remove();
    if (current?.el === el) current = null;
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a],[data-cmd]");
    if (!b) return;
    if (b.dataset.cmd) {
      editor.focus();
      document.execCommand(b.dataset.cmd);
      markDirty();
      return;
    }
    switch (b.dataset.a) {
      case "send": send(); break;
      case "close": close(true); break;
      case "min": morph(() => { el.classList.toggle("minimized"); el.classList.remove("expanded"); }); break;
      case "expand": morph(() => { el.classList.toggle("expanded"); el.classList.remove("minimized"); }); break;
      case "ccbcc": $('[data-f="cc"]').hidden = $('[data-f="bcc"]').hidden = false; fCc.input.focus(); break;
      case "discard": {
        dirty = false;
        close(false);
        discardSaved();
        break;
      }
      case "attach": {
        const files = await api.pickFiles();
        if (files.length) { attachments.push(...files); renderAtts(); markDirty(); }
        break;
      }
      case "link": {
        const sel = window.getSelection();
        const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        const r = await dialog({ title: "Add Link", fields: [{ id: "url", placeholder: "https://example.com", value: "https://" }], ok: "Add" });
        if (r?.url && r.url !== "https://") {
          editor.focus();
          if (range) { sel.removeAllRanges(); sel.addRange(range); }
          if (range && !range.collapsed) document.execCommand("createLink", false, r.url);
          else document.execCommand("insertHTML", false, `<a href="${esc(r.url)}">${esc(r.url)}</a>`);
          markDirty();
        }
        break;
      }
      case "size": {
        const rect = b.getBoundingClientRect();
        const set = (n) => () => { editor.focus(); document.execCommand("fontSize", false, n); markDirty(); };
        showMenu([
          { label: "Small", action: set(2) },
          { label: "Medium", action: set(3) },
          { label: "Large", action: set(5) },
          { label: "Extra Large", action: set(6) },
        ], rect);
        break;
      }
    }
  });
  el.querySelector(".fmt-bar").addEventListener("mousedown", (e) => e.preventDefault());
  $(".compose-body").addEventListener("mousedown", (e) => { if (e.target.classList.contains("compose-body")) { e.preventDefault(); editor.focus(); } });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.key === "Escape" && !e.defaultPrevented) close(true);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveDraft(false, "ctrl+s"); }
  });
  $(".compose-head").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) morph(() => el.classList.toggle("minimized")); });

  // ---- Moving the window, and smooth size changes ----------------------------
  // Dragged somewhere (not expanded): its spot inside the app, kept on screen.
  let pos = null;
  const clampPos = (p) => {
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(Math.min(Math.max(0, p.left), Math.max(0, window.innerWidth - r.width))),
      top: Math.round(Math.min(Math.max(0, p.top), Math.max(0, window.innerHeight - r.height))),
    };
  };
  const applyPos = () => {
    // Minimized always docks at the bottom right; the dragged spot is kept for Maximize.
    const free = pos && !el.classList.contains("expanded") && !el.classList.contains("minimized");
    el.style.left = free ? `${pos.left}px` : "";
    el.style.top = free ? `${pos.top}px` : "";
    el.style.right = free ? "auto" : "";
    el.style.bottom = free ? "auto" : "";
  };
  // Header buttons say what they'll do now.
  const setButtons = () => {
    const min = el.classList.contains("minimized"), full = el.classList.contains("expanded");
    const mb = $('.compose-head [data-a="min"]'), eb = $('.compose-head [data-a="expand"]');
    if (mb) { mb.innerHTML = icon(min ? "maximize" : "minimize"); mb.title = min ? "Maximize" : "Minimize"; }
    if (eb) { eb.innerHTML = icon(full ? "collapse" : "expand"); eb.title = full ? "Exit Full Screen" : "Full Screen"; }
  };
  // The opening rise plays once; it must not replay when leaving full screen.
  el.addEventListener("animationend", () => el.classList.add("opened"), { once: true });
  // Change the window's state (expand / collapse / minimize) and glide from the old
  // size and place to the new one.
  function morph(change) {
    const from = el.getBoundingClientRect();
    const fromRadius = getComputedStyle(el).borderRadius;
    el.getAnimations().forEach((a) => a.cancel());
    el.classList.add("opened");
    change();
    if (pos && !el.classList.contains("expanded") && !el.classList.contains("minimized")) pos = clampPos(pos);
    applyPos();
    setButtons();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.getBoundingClientRect();
    const toRadius = getComputedStyle(el).borderRadius;
    const frame = (r, radius) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: "auto", bottom: "auto", marginLeft: "0px", transform: "none", borderRadius: radius });
    el.animate([frame(from, fromRadius), frame(to, toRadius)], { duration: 280, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  }
  const head = $(".compose-head");
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input") || el.classList.contains("expanded") || el.classList.contains("minimized")) return;
    const start = { x: e.clientX, y: e.clientY };
    const r = el.getBoundingClientRect();
    let moving = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moving) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moving = true;
        el.getAnimations().forEach((a) => a.cancel());
        el.classList.add("dragging", "floating");
        head.setPointerCapture(e.pointerId);
      }
      pos = clampPos({ left: r.left + dx, top: r.top + dy });
      applyPos();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });
  // Files dragged in from Explorer: the window greys out with a hint, and a drop attaches them.
  const dropHint = document.createElement("div");
  dropHint.className = "compose-drop";
  dropHint.innerHTML = `<div class="compose-drop-hint">${icon("paperclip")}<span>Drop files to attach</span></div>`;
  el.appendChild(dropHint);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  let depth = 0;
  const dropOff = () => { depth = 0; el.classList.remove("drop-ready"); };
  el.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) {
      if (el.classList.contains("minimized")) current?.restore?.();
      el.classList.add("drop-ready");
    }
  });
  el.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) dropOff(); });
  el.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropOff();
    const items = [...e.dataTransfer.items].filter((it) => it.kind === "file");
    let folders = 0;
    for (const it of items) {
      if (it.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
      const file = it.getAsFile();
      if (!file) continue;
      // The chip shows at once; the copy finishes in the background.
      const a = { name: file.name, size: file.size, staging: true };
      a.ready = api.stageAttachment(file).then(
        (picked) => { Object.assign(a, picked, { staging: false }); renderAtts(); markDirty(); },
        (err) => { attachments.splice(attachments.indexOf(a), 1); renderAtts(); toast(`Couldn't attach ${file.name}: ${errText(err)}`, { error: true }); },
      );
      attachments.push(a);
    }
    if (folders) toast(folders === 1 ? "Folders can't be attached." : `${folders} folders were skipped: folders can't be attached.`);
    renderAtts();
  });

  // The app window got smaller: keep the compose window inside it.
  const onResize = () => { if (pos && el.isConnected) { pos = clampPos(pos); applyPos(); } };
  window.addEventListener("resize", onResize);

  current = handle();

  // A resumed draft brings its attachments: they're copied out of the saved draft and show
  // as "loading" chips meanwhile (Send waits for them, like files dropped in).
  if (mode === "draft" && source?.attachments?.length) {
    const pending = source.attachments.map((a) => ({ name: a.name || "attachment", size: a.size || 0, staging: true }));
    const ready = api.stageMessageAttachments(source.account, source.folder, source.uid).then(
      (files) => {
        pending.forEach((a, i) => (files[i] ? Object.assign(a, files[i], { staging: false }) : attachments.splice(attachments.indexOf(a), 1)));
        renderAtts();
        // Loading them isn't an edit; they're part of how the draft was saved.
        if (!dirty) saved = snapshot();
      },
      (err) => {
        pending.forEach((a) => attachments.splice(attachments.indexOf(a), 1));
        renderAtts();
        // Keep the original draft (with its attachments) instead of replacing it with a copy that lacks them.
        draftUid = null;
        toast(`Couldn't load this draft's attachments: ${errText(err)}. The original draft stays in Drafts.`, { error: true, duration: 8000 });
      },
    );
    pending.forEach((a) => (a.ready = ready));
    attachments.push(...pending);
    renderAtts();
  }

  // Baseline for "changed?" (again after a frame, once the editor has settled its HTML).
  saved = snapshot();
  requestAnimationFrame(() => { if (!dirty) saved = snapshot(); });
  if (mode === "reply" || mode === "replyAll" || (mode === "draft" && fTo.tokens.length)) {
    editor.focus();
    const r = document.createRange();
    r.setStart(editor, 0);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  } else {
    fTo.input.focus();
  }
}

export const composeOpen = () => !!current;
