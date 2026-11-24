import { api, listen, openUrl, esc, initials, displayName, listDate, longDate, fileSize, store, errText, dateGroup, notify, appWindow, rememberContacts } from "./api.js";
import { icon, ROLE_ICON } from "./icons.js";
import { buildThreads, threadSeedIds, normSubject } from "./threads.js";
import { showMenu, closeMenu, toast, dialog, isMenuOpen, dragReorder } from "./ui.js";
import { renderPdf, pdfThumbnail } from "./pdfview.js";
// Loaded on demand (lazy) so startup only parses what the first screen needs.
let composeMod = null;
const loadCompose = () => import("./compose.js").then((m) => (composeMod = m));
const loadDark = () => import("./darkmode.js");
const loadAccountsUi = () => import("./accounts-ui.js");
const composeOpen = () => !!composeMod?.composeOpen();

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const PREFETCH = 30;

/*
 * Views ("state.folder") are string keys:
 *   "u:inbox" | "u:vip" | "u:flagged"   unified across all accounts
 *   "<accountId>|<folder path>"         one account's folder
 * Messages carry { account, folder, uid, id }; `id` is unique across accounts.
 */
const U_INBOX = "u:inbox", U_VIP = "u:vip", U_FLAGGED = "u:flagged";
const UNIFIED_FOLDER = { [U_INBOX]: "INBOX", [U_VIP]: "__vip__", [U_FLAGGED]: "__flagged__" };
const isUnified = (v = state.folder) => v.startsWith("u:");
const fkey = (acct, path) => `${acct}|${path}`;
const keyAcct = (v = state.folder) => (isUnified(v) ? null : v.slice(0, v.indexOf("|")));
const keyPath = (v = state.folder) => (isUnified(v) ? null : v.slice(v.indexOf("|") + 1));
const realFolder = (p) => (p === "__vip__" || p === "__flagged__" ? "INBOX" : p);

const state = {
  accounts: [], // [{id, email, name, provider, auth}]
  folders: {}, // accountId -> Folder[]
  folder: U_INBOX,
  bridges: [], // cached Sent messages: link conversations in other folders (never shown)
  messages: [],
  total: 0,
  hasMore: false,
  cursors: {}, // `${account}\u0001${folder}` -> { offset, hasMore, total }
  loadingMore: false,
  listToken: 0,
  selected: new Set(), // message ids
  anchor: null,
  detail: null, // the focused message in the reading pane
  conv: null, // the conversation shown in the reading pane (see openConversation)
  detailToken: 0,
  expandedThreads: new Set(), // conversation keys expanded in the list
  threadCache: new Map(), // conversation members found on the server (Sent, Archive…)
  filter: "all",
  query: "",
  showHeaders: false,
  collapsedGroups: new Set(),
  lightOverride: new Set(), // messages the user switched to the original (light) look
  darkOverride: new Set(), // messages switched to dark while "Dark mode for messages" is off
  darkInLight: new Set(), // messages switched to dark while the app itself is light
  plainKeys: new Set(),
  pendingFlags: new Map(), // read/flag changes the server may not show yet (see withPendingFlags)
  virtualUnread: { vip: 0, flagged: 0 }, // unread in the VIP and Flagged mailboxes // messages known to be plain text (their cards follow the app's look)
  offline: false,
  photos: {}, // lowercase email -> contact photo (data URL)
  needsAuth: new Set(), // account ids whose password / sign-in stopped working
  // Messages removed in the UI (move/delete) that the server may still list: id -> { committed, at }.
  removing: new Map(),
};

const DEFAULTS = {
  theme: "system",
  previewLines: 2,
  remoteMode: "always", // always | trusted
  darkMessages: true,
  groupByDate: true,
  sortOrder: "newest", // list order: "newest" or "oldest" first
  listAvatars: true,
  markReadOnOpen: true,
  conversations: true,
  undoSendDelay: 10, // seconds a sent message waits so it can be taken back (0 = off)
  notifications: true,
  runInBackground: false, // closing the window keeps Pear Mail in the notification area
  autoUpdate: true, // look for new versions on GitHub (and download them, verified) once a day
  trayNoticeShown: false, // the one-time "running in the background" toast
  zoom: 100,
  signature: "",
  sidebarHidden: false,
  listWidth: 372,
  collapsedSections: {},
  accountColors: {}, // account id → palette index (stays put when accounts are reordered)
};
const settings = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, store.get(k, v)]));
// Migrate the old on/off remote setting.
if (store.get("loadRemote", null) === false && store.get("remoteMode", null) === null) settings.remoteMode = "always";
const saveSetting = (k, v) => { settings[k] = v; store.set(k, v); };
// Contact photos arrived in v0.4: turn list avatars on once for everyone (still switchable in Settings).
if (!store.get("avatarsV2", false)) { store.set("avatarsV2", true); settings.listAvatars = true; store.set("listAvatars", true); }

const vips = () => store.get("vips", []);
const trusted = () => store.get("trustedSenders", []);
const isVipPerson = (p) => !!p?.email && vips().includes(p.email.toLowerCase());
/** Blocked senders (lowercase addresses): their inbox mail is moved to Trash. */
const blocked = () => store.get("blockedSenders", []);
const isBlockedPerson = (p) => !!p?.email && blocked().includes(p.email.toLowerCase());
const sweeping = new Set(); // ids being moved to Trash right now (a refresh can see them again meanwhile)
/** The little badge shown right after a VIP's name. */
const vipBadge = () => `<span class="vip-badge" title="VIP">${icon("vip")}VIP</span>`;
/** After a blocked sender's name (their mail ends up in Trash: this says why). */
const blockedBadge = () => `<span class="blocked-badge" title="You blocked this sender">${icon("block")}Blocked</span>`;
const draftBadge = () => `<span class="draft-badge" title="Draft: not sent yet">${icon("drafts")}Draft</span>`;
const remoteOkMessages = () => store.get("remoteOkMessages", []);

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */
const multi = () => state.accounts.length > 1;
const acctById = (id) => state.accounts.find((a) => a.id === id);
const ACCOUNT_COLORS = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68"];
/** Each account keeps its color for good: new accounts get the first unused one. */
function acctColor(id) {
  const map = settings.accountColors;
  if (map[id] === undefined) {
    const next = { ...map };
    // Seed in the current order, so colors from before this setting existed don't change.
    for (const a of state.accounts.some((a) => a.id === id) ? state.accounts : [{ id }]) {
      if (next[a.id] !== undefined) continue;
      const used = new Set(Object.values(next));
      let i = 0;
      while (used.has(i)) i++;
      next[a.id] = i;
    }
    saveSetting("accountColors", next);
  }
  return ACCOUNT_COLORS[settings.accountColors[id] % ACCOUNT_COLORS.length];
}
const acctLabel = (a) => a?.name || a?.email || "Account";
const PROVIDER_NAMES = { icloud: "iCloud", gmail: "Gmail", yahoo: "Yahoo", outlook: "Outlook.com", aol: "AOL", fastmail: "Fastmail", zoho: "Zoho", gmx: "GMX", other: "IMAP" };

/* ------------------------------------------------------------------ */
/* Theme & chrome                                                      */
/* ------------------------------------------------------------------ */
function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  const app = $("app");
  app.classList.toggle("sidebar-hidden", settings.sidebarHidden);
  app.classList.toggle("preview-0", settings.previewLines === 0);
  app.classList.toggle("list-avatars", settings.listAvatars);
  app.style.setProperty("--preview-lines", settings.previewLines || 1);
  root.style.setProperty("--list-w", settings.listWidth + "px");
  root.classList.toggle("is-dark", darkActive());
  const tb = $("btn-theme");
  if (tb) {
    const dark = darkActive();
    tb.setAttribute("aria-checked", String(dark));
    tb.classList.toggle("on", dark);
    tb.title = `${dark ? "Dark" : "Light"} mode${settings.theme === "system" ? " (automatic)" : ""}. Click to switch.`;
  }
  // Keep the Settings switches (if open) in sync.
  const auto = document.querySelector('.settings [name="themeAuto"]');
  if (auto) {
    auto.checked = settings.theme === "system";
    const dk = document.querySelector('.settings [name="themeDark"]');
    dk.checked = darkActive();
    dk.disabled = settings.theme === "system";
    dk.closest(".toggle-row").classList.toggle("disabled", dk.disabled);
  }
}

const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const darkActive = () => settings.theme === "dark" || (settings.theme === "system" && systemDark());

/** Native title bar + WebView color scheme. Done after the crossfade, never during it. */
function syncNativeTheme() {
  try { appWindow().setTheme(settings.theme === "system" ? null : settings.theme); } catch {}
  // The window's own background (seen as it opens, before the page paints, and at the
  // edges while resizing) matches the look, so a light app never starts dark.
  const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const bg = dark ? "#0f0f11" : "#ffffff";
  try { appWindow().setBackgroundColor(bg).catch(() => {}); } catch {}
  try { window.__TAURI__.webview.getCurrentWebview().setBackgroundColor(bg).catch(() => {}); } catch {}
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => settings.theme === "system" && syncNativeTheme());

let themeTimer = null;
/**
 * Record the choice immediately; the visual switch starts after `delay` ms so a
 * slider can finish sliding first (the slider then looks the same before and after
 * the crossfade, so it never crossfades itself).
 */
function setTheme(t, delay = 0) {
  saveSetting("theme", t);
  clearTimeout(themeTimer);
  themeTimer = setTimeout(themeTransition, delay);
}

/**
 * Smoothly switch the app between light and dark: colors fade (CSS transitions),
 * and the open message is recolored in place, no reload.
 *
 * This deliberately doesn't use View Transitions (document.startViewTransition): in
 * WebView2 they occasionally crashed the page's renderer process (a Chromium CHECK)
 * when the window had been idle, leaving the "Something went wrong" page.
 */
let themeAnimTimer = null;
let lastThemeLog = 0;
function themeTransition(change) {
  // Breadcrumb for the diagnostic log, in case a page crash ever follows a switch.
  if (Date.now() - lastThemeLog > 10_000) {
    lastThemeLog = Date.now();
    api.logEvent("theme", "switched light/dark");
  }
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce) root.classList.add("theme-anim");
  change?.();
  applySettings();
  updateReaderTheme(false).catch((e) => console.warn(e));
  clearTimeout(themeAnimTimer);
  themeAnimTimer = setTimeout(() => { root.classList.remove("theme-anim"); syncNativeTheme(); }, reduce ? 0 : 450);
}

/** Sidebar switch: flip between light and dark (leaves Automatic). */
function toggleDark() {
  const next = darkActive() ? "light" : "dark";
  // Slide the knob first (plain CSS transition), then crossfade the app.
  const tb = $("btn-theme");
  tb?.classList.toggle("on", next === "dark");
  tb?.setAttribute("aria-checked", String(next === "dark"));
  setTheme(next, 240);
}

function isDark() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return bg.startsWith("#") && parseInt(bg.slice(1, 3), 16) < 0x80;
}

function fillStaticIcons() {
  $("btn-hide-sidebar").innerHTML = icon("sidebar");
  $("btn-show-sidebar").innerHTML = icon("sidebar");
  $("btn-refresh").innerHTML = icon("refresh");
  $("brand-pear").innerHTML = icon("pearSolid");
  $("btn-theme").innerHTML = `<span class="ts-icon ts-sun">${icon("sun")}</span><span class="ts-icon ts-moon">${icon("moon")}</span><span class="knob"></span>`;
  $("btn-filter").innerHTML = icon("filter");
  $("btn-compose").innerHTML = icon("compose");
  $("search-icon").innerHTML = icon("search");
  $("search-clear").innerHTML = icon("xmark");
  $("acct-gear").innerHTML = icon("more");
  $("acct-gear").firstElementChild.style.color = "var(--text-2)";
}

/* ------------------------------------------------------------------ */
/* First launch: add an account                                        */
/* ------------------------------------------------------------------ */
async function showSignIn() {
  splashDone();
  $("app").hidden = true;
  $("signin").hidden = false;
  setTitle("Pear Mail");
  const { addAccountFlow } = await loadAccountsUi();
  addAccountFlow($("signin-host"), {
    heading: "Welcome to Pear Mail",
    onAdded: (acct) => start([acct]),
  });
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */
// ---- Startup splash ----
const bootStarted = performance.now();
let splashGone = false;
function splashDone() {
  if (splashGone) return;
  splashGone = true;
  const wait = Math.max(0, 800 - (performance.now() - bootStarted)); // let the icon register
  setTimeout(() => {
    const s = document.getElementById("splash");
    if (!s) return;
    s.classList.add("hide");
    setTimeout(() => s.remove(), 600);
  }, wait);
}

async function boot() {
  setTimeout(splashDone, 3500); // never keep the splash up for long, even offline
  // Started at Windows sign-in "in the background": no window, just the tray icon.
  const hidden = await api.startedHidden().catch(() => false);
  api.setRunInBackground(settings.runInBackground || hidden).catch(() => {});
  fillStaticIcons();
  applySettings();
  syncNativeTheme();
  // The window starts hidden while its saved size/position is restored; show it now that the
  // page is running. (Hidden windows may not paint, so don't wait for a frame; the window's
  // background is already the splash's dark color, so nothing flashes.)
  if (!hidden) (async () => { try { const w = appWindow(); await w.show(); await w.setFocus(); } catch {} })();
  try {
    const accounts = await api.restore();
    if (accounts?.length) return start(accounts);
  } catch {}
  showSignIn();
}

/** Map a saved view key (including ones from the single-account version) to a valid view. */
function restoreView(saved) {
  if (!saved) return U_INBOX;
  if (saved.startsWith("u:")) return saved;
  if (saved === "INBOX") return U_INBOX;
  if (saved === "__vip__") return U_VIP;
  if (saved === "__flagged__") return U_FLAGGED;
  if (!saved.includes("|")) return fkey(state.accounts[0].id, saved); // old single-account path
  return acctById(keyAcct(saved)) ? saved : U_INBOX;
}

/** Cache the newest Sent messages of each account in the background (for conversations). */
async function syncSentMail() {
  await loadBridges(); // what's cached already, so counts are right before the sync finishes
  for (const a of state.accounts) {
    try { await api.syncRecent(a.id, "sent", 400); } catch {}
  }
  await loadBridges();
}

/** Cached Sent mail of every account, used to link conversations (see buildThreads). */
async function loadBridges() {
  const pages = await Promise.all(state.accounts.map((a) => {
    const sent = byRole("sent", a.id)?.path;
    return sent ? api.cachedMessages(a.id, sent, { limit: 400 }).catch(() => null) : null;
  }));
  const next = pages.flatMap((p) => p?.messages || []);
  const sig = (list) => list.map((m) => m.id).join(",");
  if (sig(next) === sig(state.bridges)) return;
  state.bridges = next;
  if (convOn()) renderList({ animate: false });
}
setInterval(() => { if (state.accounts.length) syncSentMail(); }, 15 * 60 * 1000);

async function start(accounts) {
  state.accounts = accounts;
  setTimeout(syncSentMail, 4000);
  $("signin").hidden = true;
  $("app").hidden = false;
  await loadContactPhotos();
  paintAccount();
  state.folder = restoreView(store.get("lastFolder", null));
  // Instant start from the disk cache, then sync with the servers.
  await Promise.all(state.accounts.map(async (a) => {
    try {
      const cached = await api.cachedFolders(a.id);
      if (cached?.length) state.folders[a.id] = cached;
    } catch {}
  }));
  if (!isUnified() && state.folders[keyAcct()]?.length && !folderInfo(state.folder)) state.folder = U_INBOX;
  updateTitle();
  renderSidebar();
  renderReader();
  loadFolders();
  loadList();
  $("list").focus();
  // Warm up the lazily-loaded modules once the first screen is up.
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => { loadCompose(); loadDark(); }, { timeout: 4000 });
}

function paintAccount() {
  const a = state.accounts[0];
  if (!a) return;
  const av = $("acct-avatar");
  const photo = state.photos[a.email.toLowerCase()];
  av.classList.toggle("photo", !!photo);
  if (photo) { av.innerHTML = `<img src="${photo}" alt="">`; av.style.background = ""; }
  else { av.textContent = initials({ name: a.name, email: a.email }); av.style.background = ""; }
  $("account-btn").classList.toggle("needs-auth", state.needsAuth.size > 0);
  if (multi()) {
    $("acct-name").textContent = `${state.accounts.length} Accounts`;
    $("acct-email").textContent = state.accounts.map((x) => x.email).join(", ");
  } else {
    $("acct-name").textContent = a.name || a.email;
    $("acct-email").textContent = a.email;
  }
}

function setTitle(t) {
  try { appWindow().setTitle(t); } catch {}
}
const inboxUnread = () => state.accounts.reduce((n, a) => n + (byRole("inbox", a.id)?.unread || 0), 0);
function updateTitle() {
  const n = inboxUnread();
  setTitle(n ? `Inbox (${n}) – Pear Mail` : "Pear Mail");
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */
async function loadFolders(only = null) {
  const list = only ? state.accounts.filter((a) => a.id === only) : state.accounts;
  const startedAt = Date.now();
  const results = await Promise.allSettled(list.map(async (a) => [a.id, await api.folders(a.id)]));
  let ok = false;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const [acct, fresh] = r.value;
      const keep = foldersWithPendingSeen(acct, startedAt);
      if (keep.size) for (const f of fresh) {
        const old = foldersOf(acct).find((x) => x.path === f.path);
        if (old && keep.has(f.path)) f.unread = old.unread;
      }
      state.folders[acct] = fresh;
      ok = true;
    }
    else handleError(r.reason, true);
  }
  if (ok) setOffline(false);
  renderSidebar();
  renderListHeader();
  updateTitle();
}

const foldersOf = (acct) => state.folders[acct] || [];
const byRole = (role, acct) => foldersOf(acct).find((f) => f.role === role);
const folderInfo = (key) => (isUnified(key) ? null : foldersOf(keyAcct(key)).find((f) => f.path === keyPath(key)));
/** Role of the current view: inbox / vip / flagged / drafts / sent / junk / trash / archive / null. */
function currentRole() {
  if (state.folder === U_INBOX) return "inbox";
  if (state.folder === U_VIP) return "vip";
  if (state.folder === U_FLAGGED) return "flagged";
  return folderInfo(state.folder)?.role || (keyPath() === "INBOX" ? "inbox" : null);
}
/** Viewing Drafts? (Unified views never include drafts, so the view's role says it all.)
 *  Drafts get their own actions: Continue Editing, Flag, Delete Draft. */
const inDrafts = () => currentRole() === "drafts";
/** Role of the folder a message lives in. */
function messageRole(m) {
  const f = foldersOf(m.account).find((x) => x.path === realFolder(m.folder));
  return f?.role || (realFolder(m.folder) === "INBOX" ? "inbox" : null);
}

const ROLE_TITLES = { inbox: "Inbox", drafts: "Drafts", sent: "Sent", junk: "Junk", trash: "Trash", archive: "Archive" };
function folderTitle(key) {
  if (key === U_INBOX) return multi() ? "All Inboxes" : "Inbox";
  if (key === U_VIP) return "VIP";
  if (key === U_FLAGGED) return "Flagged";
  const f = folderInfo(key);
  const name = f ? ROLE_TITLES[f.role] || f.name : keyPath(key) === "INBOX" ? "Inbox" : keyPath(key);
  return name;
}

function sideItem({ key, label, iconName, count, depth = 0, droppable = true, user = false }) {
  const sel = state.folder === key ? " selected" : "";
  const acct = keyAcct(key);
  return `<div class="side-item${sel}" data-key="${esc(key)}" ${acct ? `data-acct="${esc(acct)}"` : ""} ${droppable && acct ? 'data-drop="1"' : ""} ${user ? 'data-user="1"' : ""} style="padding-left:${10 + depth * 16}px">
    ${icon(iconName)}<span class="name">${esc(label)}</span>${count ? `<span class="count">${count.toLocaleString()}</span>` : ""}</div>`;
}

/** Inbox + special mailboxes of one account. */
function accountMailboxItems(acct, depth = 0) {
  const items = [];
  for (const role of ["drafts", "sent", "junk", "trash", "archive"]) {
    const f = byRole(role, acct);
    if (!f) continue;
    const count = role === "drafts" ? f.total : role === "sent" ? 0 : f.unread;
    items.push(sideItem({ key: fkey(acct, f.path), label: ROLE_TITLES[role], iconName: ROLE_ICON[role], count, depth }));
  }
  return items;
}

function userFolderItems(acct, depth = 0) {
  return foldersOf(acct)
    .filter((f) => !f.role)
    .map((f) => sideItem({ key: fkey(acct, f.path), label: f.name, iconName: "folder", count: f.unread, depth: f.depth + depth, droppable: f.selectable, user: !f.system }));
}

/**
 * Unread counts for VIP and Flagged. Both are views of the inbox, counted from the mail
 * saved on this computer (instant, no server calls). Runs shortly after any sidebar
 * update, so reading, flagging, new mail and VIP edits all keep it current.
 */
let virtualTimer = null;
function updateVirtualCounts() {
  clearTimeout(virtualTimer);
  virtualTimer = setTimeout(async () => {
    const sum = async (folder) => {
      const pages = await Promise.allSettled(state.accounts.map((a) => api.cachedMessages(a.id, folder, { filter: "unread", vip: vips(), limit: 1 })));
      return pages.reduce((n, p) => n + (p.status === "fulfilled" ? p.value.total || 0 : 0), 0);
    };
    const [vip, flagged] = await Promise.all([vips().length ? sum("__vip__") : 0, sum("__flagged__")]);
    if (vip === state.virtualUnread.vip && flagged === state.virtualUnread.flagged) return;
    state.virtualUnread = { vip, flagged };
    renderSidebar();
  }, 400);
}

function renderSidebar() {
  if (!state.accounts.length) return;
  updateVirtualCounts();
  const coll = settings.collapsedSections;
  const section = (sec, label, items, extra = "") => `
    <div class="side-section${coll[sec] ? " collapsed" : ""}" data-sec="${esc(sec)}">
      <div class="side-section-head"><span class="label">${label}</span>${extra}<span class="chev">${icon("chevronDown")}</span></div>
      <div class="side-items"><div class="side-items-in">${items.join("")}</div></div>
    </div>`;
  const top = [
    sideItem({ key: U_INBOX, label: multi() ? "All Inboxes" : "Inbox", iconName: "inbox", count: inboxUnread() }),
    sideItem({ key: U_VIP, label: "VIP", iconName: "vip", droppable: false, count: state.virtualUnread.vip }),
    sideItem({ key: U_FLAGGED, label: "Flagged", iconName: "flag", droppable: false, count: state.virtualUnread.flagged }),
  ];
  let html;
  if (!multi()) {
    // One account: same layout as always (Mailboxes, then Folders).
    const a = state.accounts[0].id;
    html =
      section("mailboxes", "Mailboxes", [...top, ...accountMailboxItems(a)]) +
      section("folders", "Folders", userFolderItems(a), `<button class="add" data-new-folder="${esc(a)}" title="New Folder">${icon("plus")}</button>`);
  } else {
    // Several accounts: unified mailboxes, then one section per account (like Apple Mail).
    html = section("mailboxes", "Mailboxes", top);
    for (const a of state.accounts) {
      const inbox = byRole("inbox", a.id) || { path: "INBOX", unread: 0 };
      const items = [
        sideItem({ key: fkey(a.id, inbox.path), label: "Inbox", iconName: "inbox", count: inbox.unread }),
        ...accountMailboxItems(a.id),
        ...userFolderItems(a.id),
      ];
      const label = `<span class="acct-dot" style="background:${acctColor(a.id)}"></span>${esc(acctLabel(a))}`;
      // (The header is the drag handle for reordering accounts.)
      const warn = state.needsAuth.has(a.id) ? `<button class="auth-warn" data-reauth="${esc(a.id)}" title="Sign in again">!</button>` : "";
      html += section(`acct:${a.id}`, label, items, `${warn}<button class="add" data-new-folder="${esc(a.id)}" title="New Folder">${icon("plus")}</button>`);
    }
  }
  if (document.body.classList.contains("dragging-reorder")) return; // re-rendered after the drop
  $("sidebar-scroll").innerHTML = html;
}

/** New account order from a drag (`from`: "sidebar" or "settings"). The dragged DOM is already in place. */
async function reorderAccounts(ids, from) {
  if (!ids) return renderSidebar(); // cancelled (and catch up on anything skipped while dragging)
  const before = state.accounts;
  const pos = (id) => { const i = ids.indexOf(id); return i < 0 ? Infinity : i; };
  state.accounts = [...before].sort((a, b) => pos(a.id) - pos(b.id));
  paintAccount();
  // Dragged in the sidebar: rebuild it after the drop glide finishes.
  if (from === "sidebar") setTimeout(renderSidebar, 250);
  else renderSidebar();
  try {
    await api.reorderAccounts(state.accounts.map((a) => a.id));
  } catch (e) {
    state.accounts = before;
    paintAccount();
    renderSidebar();
    const rows = document.querySelector(".settings .acct-list");
    if (rows) for (const a of state.accounts) { const r = rows.querySelector(`.acct-row[data-acct="${CSS.escape(a.id)}"]`); if (r) rows.appendChild(r); }
    handleError(e);
  }
}

dragReorder($("sidebar-scroll"), {
  item: '.side-section[data-sec^="acct:"]',
  handle: '.side-section[data-sec^="acct:"] > .side-section-head',
  idOf: (el) => el.dataset.sec.slice(5),
  onDrop: (ids) => reorderAccounts(ids, "sidebar"),
});

$("sidebar-scroll").addEventListener("click", (e) => {
  const chev = e.target.closest(".chev");
  if (chev) {
    const sec = chev.closest(".side-section");
    sec.classList.toggle("collapsed");
    settings.collapsedSections[sec.dataset.sec] = sec.classList.contains("collapsed");
    saveSetting("collapsedSections", settings.collapsedSections);
    return;
  }
  const nf = e.target.closest("[data-new-folder]");
  if (nf) return newFolder(nf.dataset.newFolder);
  const item = e.target.closest(".side-item[data-key]");
  if (item) selectFolder(item.dataset.key);
});

$("sidebar-scroll").addEventListener("contextmenu", (e) => {
  const item = e.target.closest(".side-item[data-key]");
  if (!item) return;
  e.preventDefault();
  const key = item.dataset.key;
  const acct = keyAcct(key);
  const user = item.dataset.user === "1";
  showMenu([
    { label: "Open", icon: "folder", action: () => selectFolder(key) },
    { label: "Mark All as Read", icon: "envelopeOpen", disabled: key === U_VIP, action: () => markAllRead(key) },
    { sep: true },
    { label: "New Folder…", icon: "plus", action: () => newFolder(acct || state.accounts[0].id) },
    // Only folders you made can be renamed or deleted (not Inbox, Sent, iCloud's Outbox…).
    ...(user ? [
      { label: "Rename Folder…", action: () => renameFolder(key) },
      { label: "Delete Folder", danger: true, action: () => deleteFolder(key) },
    ] : []),
  ], { x: e.clientX, y: e.clientY });
});

// Drag & drop messages onto folders (within the same account).
// Files dragged from Explorer and dropped anywhere but a compose window are ignored
// (the WebView would otherwise open the file in place of the app).
window.addEventListener("dragover", (e) => {
  if (e.defaultPrevented || ![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (e) => {
  if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
});

$("sidebar-scroll").addEventListener("dragover", (e) => {
  const item = e.target.closest('.side-item[data-drop="1"]');
  document.querySelectorAll(".side-item.drop-target").forEach((x) => x !== item && x.classList.remove("drop-target"));
  if (!item || item.dataset.key === state.folder || !e.dataTransfer.types.includes("pm/ids")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  item.classList.add("drop-target");
});
$("sidebar-scroll").addEventListener("dragleave", (e) => e.target.closest?.(".side-item")?.classList.remove("drop-target"));
$("sidebar-scroll").addEventListener("drop", (e) => {
  const item = e.target.closest('.side-item[data-drop="1"]');
  document.querySelectorAll(".side-item.drop-target").forEach((x) => x.classList.remove("drop-target"));
  if (!item) return;
  e.preventDefault();
  const ids = JSON.parse(e.dataTransfer.getData("pm/ids") || "[]");
  if (ids.length) moveMessages(ids, item.dataset.key);
});

/**
 * Folder changes show in the sidebar right away; the server does its part behind them,
 * then the account's folders are reloaded quietly. If the server refuses, the change is
 * undone. `change(list)` returns the new folder list for the account.
 */
async function folderChange(acct, change, serverOp) {
  const before = foldersOf(acct);
  const next = change([...before]);
  // Same order as the server gives: special mailboxes first (as they were), then folders by path.
  state.folders[acct] = [...next.filter((f) => f.role), ...next.filter((f) => !f.role).sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))];
  renderSidebar();
  try {
    await serverOp();
  } catch (e) {
    state.folders[acct] = before;
    renderSidebar();
    throw e;
  }
  loadFolders(acct); // pick up the server's exact names and counts (not awaited)
}
const localFolder = (acct, path) => {
  const segs = path.split("/");
  return { account: acct, path, name: segs[segs.length - 1], depth: segs.length - 1, role: null, unread: 0, total: 0, selectable: true, system: false };
};

async function newFolder(acct) {
  const where = multi() ? ` in ${acctLabel(acctById(acct))}` : "";
  const r = await dialog({ title: `New Folder${where}`, fields: [{ id: "name", placeholder: "Folder Name" }], ok: "Create" });
  const name = r?.name?.trim();
  if (!name) return;
  try {
    await folderChange(acct, (list) => [...list, localFolder(acct, name)], () => api.folderOp(acct, "create", name));
  } catch (e) { handleError(e); }
}
const userFolder = (key) => { const f = folderInfo(key); return !!f && !f.role && !f.system; };

async function renameFolder(key) {
  if (!userFolder(key)) return;
  const f = folderInfo(key);
  const acct = keyAcct(key), path = keyPath(key);
  const r = await dialog({ title: "Rename Folder", fields: [{ id: "name", value: f?.name || path }], ok: "Rename" });
  const name = r?.name?.trim();
  if (!name || name === f?.name) return;
  const parts = path.split("/");
  parts[parts.length - 1] = name;
  const to = parts.join("/");
  const wasOpen = state.folder === key;
  if (wasOpen) state.folder = fkey(acct, to);
  try {
    await folderChange(acct, (list) => list.map((x) => {
      if (x.path === path) return { ...x, ...localFolder(acct, to), unread: x.unread, total: x.total };
      if (x.path.startsWith(path + "/")) return { ...x, path: to + x.path.slice(path.length) }; // subfolders move too
      return x;
    }), () => api.folderOp(acct, "rename", path, to));
  } catch (e) {
    if (wasOpen) state.folder = key;
    handleError(e);
  }
  renderListHeader();
}
async function deleteFolder(key) {
  if (!userFolder(key)) return;
  const r = await dialog({ title: `Delete “${folderTitle(key)}”?`, message: "All messages in this folder will be permanently deleted.", ok: "Delete", danger: true });
  if (!r) return;
  const acct = keyAcct(key), path = keyPath(key);
  if (state.folder === key) selectFolder(U_INBOX);
  try {
    await folderChange(acct, (list) => list.filter((x) => x.path !== path && !x.path.startsWith(path + "/")), () => api.folderOp(acct, "delete", path));
  } catch (e) { handleError(e); }
}
async function markAllRead(key) {
  try {
    for (const s of sourcesFor(key)) {
      const page = await api.messages(s.account, s.folder, { filter: "unread", limit: 200 });
      if (!page.messages.length) continue;
      noteFlag(page.messages, "seen", true);
      try { await api.setFlag(s.account, s.folder, page.messages.map((m) => m.uid), "seen", true); settleFlag(page.messages); }
      catch (e) { settleFlag(page.messages, true); throw e; }
    }
    if (key === state.folder) state.messages.forEach((m) => (m.seen = true));
    renderList();
    loadFolders();
  } catch (e) { handleError(e); }
}

function selectFolder(key) {
  if (key === state.folder && !state.query && state.filter === "all") return Promise.resolve();
  commitPending();
  state.folder = key;
  store.set("lastFolder", key);
  state.selected.clear();
  state.anchor = null;
  state.conv = null;
  state.detail = null;
  state.filter = "all";
  state.query = "";
  $("search").value = "";
  $("search-clear").hidden = true;
  renderSidebar();
  renderReader();
  return loadList();
}

$("btn-hide-sidebar").onclick = () => { saveSetting("sidebarHidden", true); applySettings(); };
$("btn-show-sidebar").onclick = () => { saveSetting("sidebarHidden", false); applySettings(); };
$("btn-refresh").onclick = () => refreshAll(true);
$("btn-theme").onclick = toggleDark;
// Windows switched light/dark. Only matters in Automatic mode, and only if the result
// actually differs from what's shown (our own title-bar update also fires this event).
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme !== "system") return;
  if (darkActive() === document.documentElement.classList.contains("is-dark")) return;
  themeTransition();
});

/* ------------------------------------------------------------------ */
/* Message list                                                        */
/* ------------------------------------------------------------------ */
/** Where the messages of a view come from: one (account, folder) per source. */
function sourcesFor(key = state.folder) {
  if (isUnified(key)) return state.accounts.map((a) => ({ account: a.id, folder: UNIFIED_FOLDER[key] }));
  return [{ account: keyAcct(key), folder: keyPath(key) }];
}
const srcKey = (s) => `${s.account}\u0001${s.folder}`;
const msgById = (id) => state.messages.find((m) => m.id === id);

function listOpts(offset, limit = PAGE) {
  return { filter: state.filter, query: state.query, vip: vips(), offset, limit, sort: settings.sortOrder };
}
const oldestFirst = () => settings.sortOrder === "oldest";
/** The list's order: by date (then arrival), newest or oldest first per the Sort setting. */
const listOrder = (a, b) => (oldestFirst() ? -1 : 1) * ((b.date - a.date) || (b.uid - a.uid));

/** Merge per-account pages into one list (newest first across accounts). */
function mergePages(pairs) {
  const cursors = {};
  let messages = [], total = 0, hasMore = false;
  for (const [src, page] of pairs) {
    messages.push(...page.messages);
    total += page.total;
    hasMore ||= page.hasMore;
    cursors[srcKey(src)] = { offset: page.messages.length, hasMore: page.hasMore, total: page.total };
  }
  if (pairs.length > 1) messages.sort(listOrder);
  return { messages, total, hasMore, cursors };
}

/** Drop messages the user just moved/deleted (the server may not have caught up yet). */
function withoutRemoving(messages) {
  if (!state.removing.size) return messages;
  const now = Date.now();
  const listed = new Set(messages.map((m) => m.id));
  for (const [id, r] of state.removing) {
    // Once the server no longer lists a committed removal (or after 2 min), stop tracking it.
    if (r.committed && (!listed.has(id) || now - r.at > 120000)) state.removing.delete(id);
  }
  return messages.filter((m) => !state.removing.has(m.id));
}

/* ---- Read / flag changes don't bounce back ------------------------------
 * A refresh that asked the server before a change reached it brings back the old state.
 * Changes are remembered until the server has them, and lists or counts fetched before
 * that keep the local value.
 */
const pendKey = (m) => `${m.account}:${realFolder(m.folder)}:${m.uid}`;
function noteFlag(ms, flag, value) {
  for (const m of ms) {
    const k = pendKey(m);
    const e = state.pendingFlags.get(k) || { account: m.account, folder: realFolder(m.folder) };
    e[flag] = value;
    e.settledAt = null;
    state.pendingFlags.set(k, e);
  }
}
function settleFlag(ms, failed = false) {
  const now = Date.now();
  for (const m of ms) {
    const k = pendKey(m);
    if (failed) state.pendingFlags.delete(k);
    else if (state.pendingFlags.has(k)) state.pendingFlags.get(k).settledAt = now;
  }
}
const pendingWins = (e, startedAt) => e.settledAt === null || startedAt < e.settledAt;
function withPendingFlags(messages, startedAt) {
  if (!state.pendingFlags.size) return messages;
  const now = Date.now();
  for (const [k, e] of state.pendingFlags) if (e.settledAt !== null && now - e.settledAt > 120000) state.pendingFlags.delete(k);
  for (const m of messages) {
    const e = state.pendingFlags.get(pendKey(m));
    if (!e || !pendingWins(e, startedAt)) continue;
    if (e.seen !== undefined) m.seen = e.seen;
    if (e.flagged !== undefined) m.flagged = e.flagged;
  }
  return messages;
}
/** Folders whose unread count the server may not have caught up with yet. */
function foldersWithPendingSeen(acct, startedAt) {
  const out = new Set();
  for (const e of state.pendingFlags.values()) if (e.account === acct && e.seen !== undefined && pendingWins(e, startedAt)) out.add(e.folder);
  return out;
}

function acceptMerged(merged, startedAt = Date.now()) {
  // Blocked senders' inbox mail is on its way to Trash: never show it (sweepBlocked marks it removing).
  sweepBlocked(merged.messages);
  withPendingFlags(merged.messages, startedAt);
  const kept = withoutRemoving(merged.messages);
  state.messages = kept;
  state.total = Math.max(0, merged.total - (merged.messages.length - kept.length));
  state.hasMore = merged.hasMore;
  state.cursors = merged.cursors;
  pruneSelection();
}

function autoOpenFirst() {
  const first = state.messages.length ? visibleKeys()[0] : null;
  if (!state.selected.size && first && $("reader").offsetWidth > 0) {
    selectOnly(first, { open: true, markSeen: false });
  }
}

/** Fetch every source of the current view; failures of single accounts don't blank the list. */
async function fetchSources(fn) {
  const srcs = sourcesFor();
  const results = await Promise.allSettled(srcs.map((s) => fn(s)));
  const pairs = [];
  let firstError = null;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") pairs.push([srcs[i], r.value]);
    else firstError ??= r.reason;
  });
  return { pairs, firstError, allFailed: !pairs.length && srcs.length > 0 };
}

async function loadList() {
  const token = ++state.listToken;
  state.messages = [];
  state.total = 0;
  state.hasMore = false;
  state.cursors = {};
  renderListHeader();
  // 1) Instant: whatever is on disk.
  let shownCached = false;
  if (!state.query && !oldestFirst()) {
    try {
      const cachedAt = Date.now();
      const { pairs } = await fetchSources((s) => api.cachedMessages(s.account, s.folder, { filter: state.filter, vip: vips(), limit: PAGE }));
      if (token !== state.listToken) return;
      const merged = mergePages(pairs);
      if (merged.messages.length) {
        acceptMerged(merged, cachedAt);
        shownCached = true;
        renderList();
        renderListHeader();
        autoOpenFirst();
      }
    } catch {}
  }
  if (!shownCached) $("list").innerHTML = `<div class="center-spin"><span class="spinner"></span></div>`;
  // 2) Sync with the servers (only new messages are downloaded).
  const syncAt = Date.now();
  const { pairs, firstError, allFailed } = await fetchSources((s) => api.messages(s.account, s.folder, listOpts(0)));
  if (token !== state.listToken) return;
  if (allFailed) {
    if (!shownCached) $("list").innerHTML = `<div class="list-empty"><div class="big">Couldn't Load Messages</div>${esc(errText(firstError))}</div>`;
    splashDone();
    handleError(firstError, true);
    return;
  }
  if (firstError) handleError(firstError, true);
  else setOffline(false);
  const merged = mergePages(pairs);
  acceptMerged(merged, syncAt);
  rememberContacts(merged.messages.map((m) => m.from));
  renderList();
  renderListHeader();
  autoOpenFirst();
  if (state.conv && !state.conv.order.some((id) => msgById(id))) closeReader();
  prefetchVisible();
  if (currentRole() === "inbox" && state.filter === "all" && !state.query) checkNewMail(merged.messages);
}

let prefetching = false;
async function prefetchVisible() {
  if (prefetching || state.query) return;
  prefetching = true;
  try {
    const bySrc = new Map();
    for (const m of state.messages.slice(0, PREFETCH)) {
      const k = srcKey(m);
      if (!bySrc.has(k)) bySrc.set(k, { account: m.account, folder: m.folder, uids: [] });
      bySrc.get(k).uids.push(m.uid);
    }
    for (const s of bySrc.values()) {
      try { await api.prefetch(s.account, s.folder, s.uids); } catch {}
    }
  } finally {
    prefetching = false;
  }
}

async function loadMore() {
  if (!state.hasMore || state.loadingMore) return;
  state.loadingMore = true;
  const token = state.listToken;
  try {
    const srcs = sourcesFor().filter((s) => state.cursors[srcKey(s)]?.hasMore);
    const moreAt = Date.now();
    const results = await Promise.allSettled(srcs.map((s) => api.messages(s.account, s.folder, listOpts(state.cursors[srcKey(s)].offset))));
    if (token !== state.listToken) return;
    const have = new Set(state.messages.map((m) => m.id));
    results.forEach((r, i) => {
      const c = state.cursors[srcKey(srcs[i])];
      if (r.status !== "fulfilled") { c.hasMore = false; return; }
      state.messages.push(...withPendingFlags(r.value.messages, moreAt).filter((m) => !have.has(m.id) && !state.removing.has(m.id)));
      c.offset += r.value.messages.length;
      c.hasMore = r.value.hasMore;
    });
    if (isUnified()) state.messages.sort(listOrder);
    state.hasMore = Object.values(state.cursors).some((c) => c.hasMore);
    renderList({ animate: false });
  } catch (e) {
    handleError(e);
  } finally {
    state.loadingMore = false;
  }
}

/** Refresh without flicker, keeping selection. */
async function softRefreshList() {
  const token = state.listToken;
  const startedAt = Date.now();
  const { pairs, firstError, allFailed } = await fetchSources((s) => {
    const loaded = state.cursors[srcKey(s)]?.offset || 0;
    return api.messages(s.account, s.folder, listOpts(0, Math.min(Math.max(PAGE, loaded), 200)));
  });
  if (token !== state.listToken) return;
  if (allFailed) return handleError(firstError, true);
  if (!firstError) setOffline(false);
  const merged = mergePages(pairs);
  // Where the open message sat, in case it's gone after this refresh (see below).
  const shownKey = state.conv && state.selected.size === 1 ? [...state.selected][0] : null;
  const openIdx = shownKey ? listEntries().findIndex((e) => e.key === shownKey) : -1;
  acceptMerged(merged, startedAt);
  rememberContacts(merged.messages.map((m) => m.from));
  renderList();
  // The open message vanished on the server (a draft replaced by its newer save or sent,
  // mail deleted on another device): don't leave a ghost in the reader. Select the row
  // that took its place, like a delete does, but never mark it read on a background refresh.
  if (state.conv && openIdx >= 0 && !convStillListed(state.conv)) {
    const rest = visibleKeys();
    const next = rest[Math.min(openIdx, rest.length - 1)];
    if (next) selectOnly(next, { open: true, markSeen: false });
    else closeReader();
  }
  renderListHeader();
  prefetchVisible();
  if (currentRole() === "inbox" && state.filter === "all" && !state.query) checkNewMail(merged.messages);
}

/** Is any message of this conversation still in the list? (Its replies from Sent and
 *  just-sent local copies don't count: they're never rows of this list.) */
function convStillListed(conv) {
  const ids = new Set(state.messages.map((m) => m.id));
  return [...conv.cards.values()].some((c) => !c.m.local && ids.has(c.m.id));
}

function renderListHeader() {
  $("list-title").textContent = folderTitle(state.folder);
  const f = folderInfo(state.folder);
  let sub = "";
  if (state.query) sub = `${state.total.toLocaleString()} result${state.total === 1 ? "" : "s"}`;
  else if (state.filter !== "all") sub = `${state.total.toLocaleString()} message${state.total === 1 ? "" : "s"}`;
  else if (f) sub = `${f.total.toLocaleString()} message${f.total === 1 ? "" : "s"}${f.unread ? `, ${f.unread.toLocaleString()} unread` : ""}`;
  else if (state.folder === U_INBOX) {
    const total = state.accounts.reduce((n, a) => n + (byRole("inbox", a.id)?.total || 0), 0);
    const unread = inboxUnread();
    if (total) sub = `${total.toLocaleString()} message${total === 1 ? "" : "s"}${unread ? `, ${unread.toLocaleString()} unread` : ""}`;
  } else if (state.total) sub = `${state.total.toLocaleString()} message${state.total === 1 ? "" : "s"}`;
  if (multi() && !isUnified()) sub = `${acctLabel(acctById(keyAcct()))}${sub ? " · " + sub : ""}`;
  if (state.offline) sub = "Offline – showing saved mail";
  $("list-subtitle").textContent = sub;
  const filtered = state.filter !== "all";
  const custom = filtered || oldestFirst(); // the button shows that the view isn't the default
  $("btn-filter").innerHTML = icon(custom ? "filterFill" : "filter");
  $("btn-filter").classList.toggle("active", custom);
  const names = { unread: "Unread", flagged: "Flagged", toMe: "Addressed to Me", attachments: "With Attachments" };
  $("filter-bar").hidden = !filtered;
  if (filtered) {
    $("filter-bar").innerHTML = `Filtered by: <button class="chip" id="chip-filter">${esc(names[state.filter])} ${icon("xmark")}</button>`;
    $("chip-filter").onclick = () => setFilter("all");
  }
}

/// Contact photo from iCloud Contacts if there is one, otherwise initials (like iCloud Mail).
function avatarHtml(p, cls = "") {
  const photo = p?.email && state.photos[p.email.toLowerCase()];
  if (isVipPerson(p)) cls += " vip"; // yellow ring
  if (photo) return `<div class="avatar photo ${cls}"><img src="${photo}" alt="" draggable="false"></div>`;
  // Apple-style gray monogram (same gradient as iCloud Mail / Contacts).
  return `<div class="avatar monogram ${cls}">${esc(initials(p))}</div>`;
}

async function loadContactPhotos() {
  try {
    state.photos = (await api.contactPhotos()) || {};
  } catch {
    state.photos = {};
  }
}

function rowHtml(m, { child = false } = {}) {
  const sel = state.selected.has(m.id);
  const role = isUnified() ? "inbox" : currentRole();
  const showTo = role === "sent" || role === "drafts";
  const who = showTo ? (m.to.length ? m.to.map(displayName).join(", ") : "No Recipients") : displayName(m.from);
  const vip = showTo ? m.to.length === 1 && isVipPerson(m.to[0]) : isVipPerson(m.from);
  const blockedFrom = !showTo && isBlockedPerson(m.from);
  const draft = !m.local && messageRole(m) === "drafts";
  const names = m.attachmentNames || [];
  const chips = names.length
    ? `<div class="att-chips"><span class="att-chip">${icon("paperclip")}<span>${esc(names[0])}</span></span>${names.length > 1 ? `<span class="att-more">+${names.length - 1}</span>` : ""}</div>`
    : "";
  // In unified views with several accounts, a small colored dot shows which account.
  const acctMark = multi() && isUnified() ? `<span class="row-acct" style="background:${acctColor(m.account)}" title="${esc(acctLabel(acctById(m.account)))}"></span>` : "";
  return `<div class="msg-row${child ? " child" : ""}${sel ? " selected" : ""}${m.seen ? "" : " unread"}" data-id="${esc(m.id)}" draggable="true">
    ${m.seen ? "" : '<span class="dot"></span>'}
    ${avatarHtml(showTo ? m.to[0] || m.from : m.from, "row-avatar")}
    <div class="marks">${m.answered ? icon("replied", "replied") : ""}</div>
    <div class="line1"><span class="from${vip ? " has-vip" : ""}${vip || blockedFrom || draft ? " has-badge" : ""}">${esc(who)}</span>${vip ? vipBadge() : ""}${blockedFrom ? blockedBadge() : ""}${draft ? draftBadge() : ""}<span class="date">${acctMark}${m.hasAttachments ? icon("paperclip") : ""}${esc(listDate(m.date))}</span></div>
    <div class="subject"><span>${esc(m.subject || "(No Subject)")}</span>${m.flagged ? `<span class="row-tail">${icon("flagFill", "flag")}</span>` : ""}</div>
    <div class="preview">${esc(m.preview || "This message has no content.")}</div>
    ${chips}
    <div class="row-actions">
      ${role === "drafts"
        // A draft is always "read": its first button continues writing it instead.
        ? `<button data-act="edit" title="Continue Editing (Enter)">${icon("compose")}</button>`
        : `<button data-act="seen" title="${m.seen ? "Mark as Unread" : "Mark as Read"}">${icon(m.seen ? "envelope" : "envelopeOpen")}</button>`}
      <button data-act="flag" title="${m.flagged ? "Unflag" : "Flag"}">${icon(m.flagged ? "flagFill" : "flag")}</button>
      <button data-act="delete" title="${role === "drafts" ? "Delete Draft" : "Delete"}">${icon("trash")}</button>
    </div>
  </div>`;
}

const groupingOn = () => settings.groupByDate && !state.query;

/* ---- Keyed list rendering --------------------------------------------
 * The list is reconciled in place, like a native table view: rows keep their DOM
 * element for as long as the message is in the list, changed rows are patched in
 * place, removed rows collapse away and new rows expand in. Neighbours move only
 * through normal layout, so motion is smooth and never jumps back and forth.
 */
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const LIST_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const LIST_MS = 280;
let listRenderToken = null;

/* ---- Conversations ------------------------------------------------------
 * The list shows one row per conversation (like Outlook). Entries are keyed:
 *   "t:<threadKey>"  a conversation of 2+ messages (expandable)
 *   "<messageId>"    a single message, or a child row of an expanded conversation
 * Actions on a conversation row apply to all of its messages in this list.
 */
const convOn = () => settings.conversations && currentRole() !== "drafts";
const mineSet = () => new Set(state.accounts.map((a) => a.email.toLowerCase()));
function currentThreads() {
  if (convOn()) return buildThreads(state.messages, { mine: mineSet(), oldest: oldestFirst(), bridges: state.bridges });
  return state.messages.map((m) => ({ key: m.id, members: [m], latest: m, count: 1, date: m.date }));
}

/** Visible list entries in order: { key, ids, thread?, msg?, child?, group, hidden }. */
function listEntries({ includeCollapsedGroups = false } = {}) {
  const out = [];
  for (const t of currentThreads()) {
    const group = dateGroup(t.date);
    const hidden = groupingOn() && state.collapsedGroups.has(group);
    if (hidden && !includeCollapsedGroups) continue;
    if (t.count > 1) {
      out.push({ key: "t:" + t.key, thread: t, ids: t.members.map((m) => m.id), group, hidden });
      if (state.expandedThreads.has(t.key)) for (const m of t.members) out.push({ key: m.id, msg: m, ids: [m.id], child: true, group, hidden });
    } else {
      out.push({ key: t.latest.id, msg: t.latest, ids: [t.latest.id], group, hidden });
    }
  }
  return out;
}
const visibleKeys = () => listEntries().map((e) => e.key);
const threadByKey = (key) => currentThreads().find((t) => "t:" + t.key === key);

/** Message ids behind the selection (conversation rows expand to all their messages). */
function selectedIds() {
  const entries = new Map(listEntries({ includeCollapsedGroups: true }).map((e) => [e.key, e]));
  const out = new Set();
  for (const k of state.selected) {
    const e = entries.get(k);
    if (e) e.ids.forEach((i) => out.add(i));
    else if (msgById(k)) out.add(k);
  }
  return [...out];
}

/** Drop selected keys that are no longer in the list. */
function pruneSelection() {
  const valid = new Set(listEntries({ includeCollapsedGroups: true }).map((e) => e.key));
  for (const k of [...state.selected]) if (!valid.has(k)) state.selected.delete(k);
}

function threadRowHtml(t) {
  const m = t.latest;
  const key = "t:" + t.key;
  const sel = state.selected.has(key);
  const open = state.expandedThreads.has(t.key);
  const mine = mineSet();
  const face = (t.members.find((x) => !mine.has((x.from?.email || "").toLowerCase())) || m).from;
  const names = m.attachmentNames || [];
  const chips = names.length
    ? `<div class="att-chips"><span class="att-chip">${icon("paperclip")}<span>${esc(names[0])}</span></span>${names.length > 1 ? `<span class="att-more">+${names.length - 1}</span>` : ""}</div>`
    : "";
  const acctMark = multi() && isUnified() ? `<span class="row-acct" style="background:${acctColor(m.account)}" title="${esc(acctLabel(acctById(m.account)))}"></span>` : "";
  // One VIP badge after the names if anyone in the conversation is a VIP.
  const anyVip = (t.participantEmails || []).some((e) => isVipPerson({ email: e }));
  // Blocked: the person the conversation is with (its face) is blocked.
  const blockedFrom = !mine.has((face?.email || "").toLowerCase()) && isBlockedPerson(face);
  // The conversation's newest message is a draft you haven't sent yet.
  const draft = !m.local && messageRole(m) === "drafts";
  const who = esc(t.participants.join("; ") || displayName(m.from));
  return `<div class="msg-row thread${sel ? " selected" : ""}${t.unread ? " unread" : ""}${open ? " expanded" : ""}" data-id="${esc(key)}" draggable="true">
    ${t.unread ? '<span class="dot"></span>' : ""}
    ${avatarHtml(face, "row-avatar")}
    <div class="marks">${t.answered ? icon("replied", "replied") : ""}</div>
    <div class="line1"><span class="from${anyVip ? " has-vip" : ""}${anyVip || blockedFrom || draft ? " has-badge" : ""}">${who}</span>${anyVip ? vipBadge() : ""}${blockedFrom ? blockedBadge() : ""}${draft ? draftBadge() : ""}<span class="date">${acctMark}${t.hasAttachments ? icon("paperclip") : ""}${esc(listDate(t.date))}</span></div>
    <div class="subject"><span>${esc(m.subject || "(No Subject)")}</span><span class="row-tail">${t.flagged ? icon("flagFill", "flag") : ""}<span class="thread-ctl" data-thread="${esc(t.key)}" title="${t.count} messages: show or hide them"><span class="conv-badge">${t.count}</span><button class="thread-toggle" tabindex="-1">${icon("chevronRight")}</button></span></span></div>
    <div class="preview">${esc(m.preview || "This message has no content.")}</div>
    ${chips}
    <div class="row-actions">
      <button data-act="seen" title="${t.unread ? "Mark as Read" : "Mark as Unread"}">${icon(t.unread ? "envelopeOpen" : "envelope")}</button>
      <button data-act="flag" title="${t.flagged ? "Unflag" : "Flag"}">${icon(t.flagged ? "flagFill" : "flag")}</button>
      <button data-act="delete" title="Delete conversation">${icon("trash")}</button>
    </div>
  </div>`;
}

/** The list as it should be: [{ key, html }]. */
function listItems() {
  if (!state.messages.length) {
    const empty = state.query ? "No Results" : state.folder === U_VIP && !vips().length ? "No VIPs" : "No Messages";
    const hint = state.folder === U_VIP && !vips().length ? "Add people to VIP by clicking their name in a message." : "";
    return [{ key: "empty", html: `<div class="list-empty" data-key="empty"><div class="big">${empty}</div>${esc(hint)}</div>` }];
  }
  const items = [];
  let last = null;
  for (const e of listEntries({ includeCollapsedGroups: true })) {
    if (groupingOn() && e.group !== last) {
      const c = state.collapsedGroups.has(e.group);
      items.push({ key: "g:" + e.group, html: `<div class="group-head${c ? " collapsed" : ""}" data-group="${esc(e.group)}" data-key="${esc("g:" + e.group)}">${icon("chevronDown")}<span>${esc(e.group)}</span></div>` });
      last = e.group;
    }
    if (e.hidden) continue;
    items.push({ key: e.key, html: e.thread ? threadRowHtml(e.thread) : rowHtml(e.msg, { child: e.child }) });
  }
  if (state.hasMore) items.push({ key: "more", html: `<div class="list-more" data-key="more"><span class="spinner"></span></div>` });
  return items;
}

const itemKey = (el) => el.dataset.key || el.dataset.id;
const fromHtml = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

/** Make `el` look like `html` without replacing the element. */
function patchEl(el, html) {
  if (el._html === html) return;
  const n = fromHtml(html);
  for (const a of [...el.attributes]) if (!n.hasAttribute(a.name) && a.name !== "style") el.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
  // Only the element's own attributes changed (e.g. a group or conversation was
  // expanded): keep the children, so the chevron rotates smoothly instead of jumping.
  if (!el._html || fromHtml(el._html).innerHTML !== n.innerHTML) el.innerHTML = n.innerHTML;
  el._html = html;
}

/** Is the element within a screen of the visible part of the list? (Otherwise: no animation.) */
function nearView(el) {
  const list = $("list");
  const top = el.offsetTop - list.scrollTop;
  return top > -list.clientHeight && top < list.clientHeight * 2;
}

function leaveEl(el, animate) {
  el.classList.add("leaving");
  el._leaving = true;
  if (!animate || !nearView(el)) return el.remove();
  el.classList.add("anim");
  const cs = getComputedStyle(el);
  const a = el.animate(
    [
      { height: `${el.getBoundingClientRect().height}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, offset: 0 },
      { opacity: 0, offset: 0.6 },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, offset: 1 },
    ],
    { duration: LIST_MS, easing: LIST_EASE, fill: "forwards" }
  );
  a.onfinish = a.oncancel = () => el.remove();
}

function enterEl(el, animate) {
  if (!animate || !nearView(el)) return;
  // Lay the row out for real before measuring: with content-visibility:auto an unrendered
  // row reports its placeholder size (contain-intrinsic-size), which made Undo overshoot.
  el.classList.add("anim");
  const cs = getComputedStyle(el);
  const h = el.getBoundingClientRect().height;
  const a = el.animate(
    [
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.25 },
      { height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, offset: 1 },
    ],
    { duration: LIST_MS, easing: LIST_EASE }
  );
  a.onfinish = a.oncancel = () => el.classList.remove("anim");
}

/**
 * Render the message list. Same view as last time → reconcile in place (animated
 * unless `animate: false`); new folder/filter/search → plain fresh render at the top.
 */
function renderList({ animate = true } = {}) {
  splashDone();
  const list = $("list");
  const items = listItems();
  const fresh = listRenderToken !== state.listToken;
  listRenderToken = state.listToken;
  if (fresh) {
    list.innerHTML = items.map((i) => i.html).join("");
    for (const el of list.children) el._html = items.find((i) => i.key === itemKey(el))?.html;
    list.scrollTop = 0;
    return;
  }
  const motion = animate && !reduceMotion();
  // Current elements by key (ignoring ones already on their way out, and unkeyed
  // leftovers like a loading spinner or an error message).
  const current = new Map();
  for (const el of [...list.children]) {
    if (el._leaving) continue;
    const k = itemKey(el);
    if (!k) { el.remove(); continue; }
    current.set(k, el);
  }
  const wanted = new Set(items.map((i) => i.key));
  for (const [k, el] of current) if (!wanted.has(k)) leaveEl(el, motion && !el.classList.contains("list-more"));
  // Walk the wanted order, reusing elements and inserting new ones in place.
  let prev = null;
  for (const it of items) {
    let el = current.get(it.key);
    const isNew = !el;
    if (isNew) { el = fromHtml(it.html); el._html = it.html; }
    else patchEl(el, it.html);
    // Next non-leaving node after `prev` is where `el` belongs.
    let at = prev ? prev.nextElementSibling : list.firstElementChild;
    while (at && at._leaving && at !== el) at = at.nextElementSibling;
    if (at !== el) list.insertBefore(el, at);
    if (isNew) enterEl(el, motion && it.key !== "more" && it.key !== "empty");
    prev = el;
  }
  updateSelectionClasses();
}

const rowEl = (id) => [...$("list").querySelectorAll(".msg-row:not(.leaving)")].find((r) => r.dataset.id === id);

/** Refresh one message's rows in place: its conversation row and, if shown, its own row. */
function updateRow(id) {
  const m = msgById(id);
  if (!m) return;
  if (convOn()) {
    const t = currentThreads().find((x) => x.count > 1 && x.members.some((y) => y.id === id));
    if (t) {
      const tr = rowEl("t:" + t.key);
      if (tr) patchEl(tr, threadRowHtml(t));
      const c = rowEl(id);
      if (c) patchEl(c, rowHtml(m, { child: true }));
      return;
    }
  }
  const el = rowEl(id);
  if (el) patchEl(el, rowHtml(m));
}

function updateSelectionClasses() {
  // Like iCloud Mail: selected rows are rounded rectangles, and runs of adjacent selected
  // rows join into one block (only its outer corners rounded).
  const rows = [...$("list").children].filter((el) => !el._leaving && !el.classList.contains("leaving"));
  const sel = rows.map((r) => r.classList.contains("msg-row") && state.selected.has(r.dataset.id));
  rows.forEach((r, i) => {
    if (!r.classList.contains("msg-row")) return;
    r.classList.toggle("selected", sel[i]);
    r.classList.toggle("sel-prev", sel[i] && !!sel[i - 1]);
    r.classList.toggle("sel-next", sel[i] && !!sel[i + 1]);
  });
}

$("list").addEventListener("scroll", () => {
  const l = $("list");
  if (l.scrollTop + l.clientHeight > l.scrollHeight - 400) loadMore();
});

$("list").addEventListener("mousedown", (e) => {
  const tg = e.target.closest(".thread-ctl");
  if (tg) {
    e.preventDefault();
    e.stopPropagation();
    const k = tg.dataset.thread;
    state.expandedThreads.has(k) ? state.expandedThreads.delete(k) : state.expandedThreads.add(k);
    renderList(); // child rows expand/collapse in place
    return;
  }
  const gh = e.target.closest(".group-head");
  if (gh) {
    const g = gh.dataset.group;
    state.collapsedGroups.has(g) ? state.collapsedGroups.delete(g) : state.collapsedGroups.add(g);
    renderList();
    return;
  }
  const act = e.target.closest(".row-actions button");
  if (act) {
    e.preventDefault();
    e.stopPropagation();
    const key = act.closest(".msg-row").dataset.id;
    // On one of several selected rows, the button acts on the whole selection (like the
    // toolbar); otherwise on this row (a conversation row: all of its messages).
    const ids = state.selected.has(key) && state.selected.size > 1
      ? [...selectedIds()]
      : listEntries({ includeCollapsedGroups: true }).find((x) => x.key === key)?.ids || [key];
    if (act.dataset.act === "edit") openDraftById(key);
    if (act.dataset.act === "seen") toggleSeen(ids);
    if (act.dataset.act === "flag") toggleFlag(ids);
    if (act.dataset.act === "delete") deleteMessages(ids);
    return;
  }
  const row = e.target.closest(".msg-row");
  if (!row || e.button !== 0) return;
  const id = row.dataset.id;
  if (e.ctrlKey || e.metaKey) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.anchor = id;
    updateSelectionClasses();
    afterSelectionChange();
  } else if (e.shiftKey && state.anchor != null) {
    const ids = visibleKeys();
    const [a, b] = [ids.indexOf(state.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    state.selected = new Set(ids.slice(a, b + 1));
    updateSelectionClasses();
    afterSelectionChange();
    e.preventDefault();
  } else if (!state.selected.has(id) || state.selected.size > 1) {
    selectOnly(id, { open: true });
  }
});

$("list").addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".msg-row");
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.id;
  if (!state.selected.has(id)) selectOnly(id, { open: true });
  showMenu(messageMenu(), { x: e.clientX, y: e.clientY });
});

$("list").addEventListener("dragstart", (e) => {
  const row = e.target.closest(".msg-row");
  if (!row) return;
  const id = row.dataset.id;
  if (!state.selected.has(id)) selectOnly(id, { open: true });
  const ids = selectedIds();
  e.dataTransfer.setData("pm/ids", JSON.stringify(ids));
  e.dataTransfer.effectAllowed = "move";
  const ghost = document.createElement("div");
  ghost.style.cssText = "position:fixed;top:-100px;padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font:600 13px var(--font)";
  ghost.textContent = ids.length === 1 ? msgById(ids[0])?.subject || "1 message" : state.selected.size === 1 && id.startsWith("t:") ? threadByKey(id)?.latest.subject || "Conversation" : `${ids.length} messages`;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 10, 10);
  setTimeout(() => ghost.remove(), 0);
});

function selectOnly(id, { open = true, markSeen = true } = {}) {
  state.selected = new Set([id]);
  state.anchor = id;
  updateSelectionClasses();
  // Scroll only if the row is actually out of view (never during list animations otherwise).
  const r = rowEl(id), l = $("list");
  if (r && (r.offsetTop < l.scrollTop || r.offsetTop + r.offsetHeight > l.scrollTop + l.clientHeight)) r.scrollIntoView({ block: "nearest" });
  if (open) openKey(id, markSeen);
}

/** Open a list entry in the reading pane: a conversation or a single message. */
function openKey(key, markSeen = true) {
  if (key.startsWith("t:")) {
    const t = threadByKey(key);
    if (t) return openConversation(t.members, { key, markSeen });
  }
  const m = msgById(key);
  if (m) openConversation([m], { key, markSeen });
}

function afterSelectionChange() {
  if (state.selected.size === 1) openKey([...state.selected][0]);
  else closeReader();
}

/** Group message ids by (account, folder) for server calls. */
function groupsOf(ids) {
  const g = new Map();
  for (const id of ids) {
    const m = msgById(id);
    if (!m) continue;
    const k = srcKey(m);
    if (!g.has(k)) g.set(k, { account: m.account, folder: m.folder, uids: [], msgs: [] });
    g.get(k).uids.push(m.uid);
    g.get(k).msgs.push(m);
  }
  return [...g.values()];
}

/* ------------------------------------------------------------------ */
/* Reading pane                                                        */
/* ------------------------------------------------------------------ */
/*
 * The reading pane always shows a *conversation*: one or more message cards, newest
 * first (a single message is simply a conversation of one card, so it looks as before).
 *   state.conv = { key, token, markSeen, order: [ids newest first],
 *                  cards: Map(id → { m: summary, d: detail|null, open, loading, error }) }
 *   state.detail = the focused card's detail (toolbar Reply/Print/View Source, shortcuts).
 */
function closeReader() {
  state.conv = null;
  state.detail = null;
  renderReader();
}

async function openConversation(members, { key, markSeen = true } = {}) {
  const token = ++state.detailToken;
  const sorted = [...members].sort((a, b) => (b.date || 0) - (a.date || 0));
  const conv = { key, token, markSeen, order: sorted.map((m) => m.id), cards: new Map() };
  // Newest message open; in a conversation, unread ones open too (like Outlook).
  sorted.forEach((m, i) => conv.cards.set(m.id, { m, d: null, open: i === 0 || (sorted.length > 1 && !m.seen) }));
  state.conv = conv;
  state.detail = null;
  state.showHeaders = false;
  // Build it off-screen and show it in one piece once everything is in: the messages,
  // the rest of the conversation (your replies in Sent…), and their bodies with pictures.
  // The pane keeps what it showed; a spinner only if this takes a moment.
  conv.staged = true;
  renderReader();
  const spin = setTimeout(() => {
    if (state.conv !== conv || !conv.staged) return;
    const box = $("reader-scroll");
    for (const el of [...box.children]) if (el !== conv.root) el.remove();
    box.insertAdjacentHTML("afterbegin", `<div class="center-spin reader-wait"><span class="spinner"></span></div>`);
  }, 200);
  const ready = (async () => {
    await Promise.all([...conv.order.filter((id) => conv.cards.get(id).open).map((id) => loadCard(conv, id)), loadThreadExtras(conv)]);
    await framesRevealed(conv);
  })();
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  clearTimeout(spin);
  if (state.conv !== conv) return;
  showStaged(conv);
}

/** Wait until every message body in the conversation is visible (or gone). */
function framesRevealed(conv) {
  return new Promise((done) => {
    const check = () => {
      if (state.conv !== conv) return done();
      const frames = conv.root ? [...conv.root.querySelectorAll(".msg-body iframe")] : [];
      if (frames.every((f) => f._revealed)) return done();
      setTimeout(check, 16);
    };
    check();
  });
}

/** Swap the staged conversation in for whatever the pane showed. */
function showStaged(conv) {
  if (!conv.staged) return;
  conv.staged = false;
  const box = $("reader-scroll");
  const root = conv.root;
  if (!root) return;
  for (const el of [...box.children]) if (el !== root) el.remove();
  root.classList.remove("staging");
  root.style.top = "";
  box.scrollTop = 0;
  if (!reduceMotion()) root.classList.add("appear");
}

/**
 * The list guesses attachments from the start of each message. Once the whole message
 * is here, correct the row (paperclip and chips) if the guess was wrong.
 */
function syncRowAttachments(id, d) {
  if (!d || d.partial) return;
  const m = msgById(id);
  if (!m) return;
  const names = (d.attachments || []).map((a) => a.name);
  if (JSON.stringify(names) === JSON.stringify(m.attachmentNames || [])) return;
  m.attachmentNames = names;
  m.hasAttachments = names.length > 0;
  updateRow(id);
  updateSelectionClasses();
}

/** Load one card's message (and mark it read if it was unread). */
async function loadCard(conv, id) {
  const c = conv.cards.get(id);
  if (!c || c.loading || c.d) return;
  c.loading = true;
  c.error = null;
  const m = c.m;
  const doMark = conv.markSeen && settings.markReadOnOpen && !m.seen;
  if (doMark) noteFlag([m], "seen", true);
  try {
    const d = await api.message(m.account, m.folder, m.uid, doMark, true);
    if (doMark) settleFlag([m]);
    c.loading = false;
    if (state.conv !== conv) return;
    d.id = m.id;
    c.d = d;
    if (isPlain(d)) state.plainKeys.add(msgKey(d));
    if (doMark) {
      m.seen = true;
      const lm = msgById(m.id);
      if (lm) { lm.seen = true; updateRow(lm.id); updateSelectionClasses(); }
      bumpUnread(m.account, realFolder(m.folder), -1);
    }
    rememberContacts([d.from, ...d.to, ...d.cc]);
    syncRowAttachments(m.id, d);
    // Focus the newest loaded card.
    if (!state.detail || conv.order.indexOf(id) < conv.order.indexOf(state.detail.id)) state.detail = d;
    renderCard(conv, id);
    renderToolbar();
    if (d.partial) completeCard(conv, id);
  } catch (e) {
    c.loading = false;
    if (doMark) settleFlag([m], true);
    if (state.conv !== conv) return;
    c.error = errText(e);
    renderCard(conv, id);
    handleError(e, true);
  }
}

/**
 * A big email was shown from its first part only. Fetch the whole message in the
 * background, then fill in attachments and embedded pictures without a reload.
 */
async function completeCard(conv, id) {
  const c = conv.cards.get(id);
  const partial = c?.d;
  if (!partial) return;
  try {
    const full = await api.message(partial.account, partial.folder, partial.uid, false, false);
    if (state.conv !== conv) return;
    full.id = partial.id;
    c.d = full;
    syncRowAttachments(full.id, full);
    if (isPlain(full)) state.plainKeys.add(msgKey(full));
    if (state.detail?.id === id) state.detail = full;
    const el = cardEl(id);
    if (!el) return;
    if (full.html !== partial.html) return renderCard(conv, id);
    // Same body: only refresh the attachment area and load embedded pictures.
    el.querySelector(".att-loading")?.remove();
    const tmp = document.createElement("div");
    tmp.innerHTML = attachmentsHtml(full);
    const old = el.querySelector(".attachments");
    const fresh = tmp.firstElementChild;
    if (old && fresh) old.replaceWith(fresh);
    else if (fresh) el.querySelector(".msg-body")?.before(fresh);
    else old?.remove();
    bindAttachments(el, full);
    loadThumbnails(el, full);
    const frame = el.querySelector(".msg-body iframe");
    const doc = frame?.contentDocument;
    if (doc?.body) lazyImages(frame, doc, full, () => fitFrame(frame));
  } catch (e) {
    cardEl(id)?.querySelector(".att-loading")?.remove();
    handleError(e, true);
  }
}

/** Find the rest of the conversation (your replies in Sent, archived messages) and add them. */
/**
 * The rest of a conversation (your replies in Sent, archived messages…). Found in the
 * local cache first, which is instant (Sent is kept cached in the background, see
 * syncSentMail); the server search (seconds on some providers) then only double-checks.
 * Resolves once the local part is in; the server part follows on its own.
 */
async function loadThreadExtras(conv) {
  const members = conv.order.map((id) => conv.cards.get(id).m);
  const first = members[0];
  const seeds = threadSeedIds(members);
  if (!first || !seeds.length) return;
  const cacheKey = `${first.account}|${seeds[0]}`;
  const known = state.threadCache.get(cacheKey);
  if (known) return addThreadExtras(conv, known);
  try { addThreadExtras(conv, await localThreadExtras(first, seeds)); } catch {}
  api.getThread(first.account, first.folder, seeds)
    .then((extra) => { state.threadCache.set(cacheKey, extra); addThreadExtras(conv, extra); })
    .catch(() => {});
}

/** Conversation members in the locally cached Inbox, Sent and Archive (by message ids). */
async function localThreadExtras(first, seeds) {
  const acct = first.account;
  const paths = [...new Set([realFolder(first.folder), "INBOX", byRole("sent", acct)?.path, byRole("archive", acct)?.path].filter(Boolean))];
  const pages = await Promise.all(paths.map((p) => api.cachedMessages(acct, p, { limit: 2000 }).catch(() => ({ messages: [] }))));
  const pool = pages.flatMap((p) => p.messages || []);
  const strip = (x) => String(x || "").trim().replace(/^<|>$/g, "");
  const ids = new Set(seeds.map(strip));
  const found = new Map();
  // Two rounds, like the server search: the second catches replies to replies.
  for (let round = 0; round < 2; round++) {
    const before = ids.size;
    for (const m of pool) {
      if (found.has(m.id)) continue;
      const own = [m.messageId, m.inReplyTo, ...(m.references || [])].map(strip).filter(Boolean);
      if (!own.some((x) => ids.has(x))) continue;
      found.set(m.id, m);
      own.forEach((x) => ids.add(x));
    }
    if (ids.size === before) break;
  }
  return [...found.values()];
}

/** Add conversation members that aren't shown yet (collapsed, in date order). */
function addThreadExtras(conv, extra) {
  if (state.conv !== conv || !extra?.length) return;
  const members = conv.order.map((id) => conv.cards.get(id).m);
  const first = members[0];
  const haveIds = new Set(conv.order);
  const haveMsgIds = new Set(members.map((m) => m.messageId).filter(Boolean));
  // Same subject only: notification systems (Jira…) reference one anchor id from every
  // mail about an item, which shouldn't turn them all into one conversation.
  const subj = normSubject(first.subject);
  const added = extra.filter((x) => !haveIds.has(x.id) && !(x.messageId && haveMsgIds.has(x.messageId)) && !state.removing.has(x.id) && normSubject(x.subject) === subj);
  if (!added.length) return;
  for (const x of added) conv.cards.set(x.id, { m: x, d: null, open: false });
  conv.order = [...conv.cards.values()].map((c) => c.m).sort((a, b) => (b.date || 0) - (a.date || 0)).map((m) => m.id);
  renderConvHeader(conv);
  // Insert the new (collapsed) cards in date order: in place before the conversation is
  // shown, expanding into place if they arrive after.
  const wrap = conv.root?.querySelector(".conv-cards");
  if (!wrap) return;
  for (const x of added) {
    const el = cardElement(conv, x.id);
    const after = conv.order.slice(conv.order.indexOf(x.id) + 1).map(cardEl).find(Boolean) || null;
    wrap.insertBefore(el, after);
    if (!conv.staged && !reduceMotion()) {
      const h = el.getBoundingClientRect().height;
      el.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: LIST_MS, easing: LIST_EASE });
    }
  }
  // Single cards get "collapse" affordances once the conversation has more than one.
  for (const id of conv.order) if (conv.cards.get(id).open && conv.cards.get(id).d) cardEl(id)?.querySelector(".msg-head")?.classList.add("collapsible");
}

/* ---- A reply you just sent joins the open conversation ---------------- */
const stripId = (x) => String(x || "").trim().replace(/^<|>$/g, "");
function addrList(list) {
  return (list || []).map((s) => {
    const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    return m ? { name: m[1].trim(), email: m[2].trim() } : { name: "", email: String(s).trim() };
  }).filter((p) => p.email);
}

/**
 * Show a just-sent message in the open conversation it replies to: it grows in smoothly
 * once its content is laid out. It's a local copy until the one filed in Sent is found,
 * then it quietly takes on that message's identity.
 */
async function showSentInConversation(info) {
  const conv = state.conv;
  const { message: msg, account, messageId } = info;
  if (!conv || !messageId || !conv.root) return;
  const refs = new Set([msg.inReplyTo, ...(msg.references || [])].map(stripId).filter(Boolean));
  const members = conv.order.map((id) => conv.cards.get(id).m);
  if (!refs.size || !members.some((m) => refs.has(stripId(m.messageId)))) return;
  const acct = acctById(account);
  if (!acct) return;
  const sentPath = byRole("sent", account)?.path || "Sent Messages";
  const id = "local:" + stripId(messageId);
  if (conv.cards.has(id)) return;
  const names = (msg.attachments || []).map((a) => a.name);
  const m = {
    id, account, folder: sentPath, uid: 0, local: true,
    from: { name: acct.senderName || "", email: acct.email },
    to: addrList(msg.to), cc: addrList(msg.cc),
    subject: msg.subject, preview: (msg.text || "").replace(/\s+/g, " ").trim().slice(0, 200),
    date: Date.now(), seen: true, flagged: false, answered: false,
    hasAttachments: names.length > 0, attachmentNames: names, size: 0,
    messageId, inReplyTo: msg.inReplyTo || "", references: msg.references || [],
  };
  const d = { ...m, replyTo: [], html: msg.html, text: msg.text, hasRemoteContent: false, attachments: [], rawHeaders: "", partial: false };
  conv.cards.set(id, { m, d, open: true });
  conv.order = [...conv.cards.values()].map((c) => c.m).sort((a, b) => (b.date || 0) - (a.date || 0)).map((x) => x.id);
  renderConvHeader(conv);
  const wrap = conv.root.querySelector(".conv-cards");
  if (wrap) {
    const el = cardElement(conv, id);
    const after = conv.order.slice(conv.order.indexOf(id) + 1).map(cardEl).find(Boolean) || null;
    // Laid out but invisible and taking no room until its email has its final height.
    el.style.cssText = "height:0;opacity:0;overflow:hidden;margin-top:0;margin-bottom:0;padding-top:0;padding-bottom:0";
    wrap.insertBefore(el, after);
    for (const cid of conv.order) if (conv.cards.get(cid).open && conv.cards.get(cid).d) cardEl(cid)?.querySelector(".msg-head")?.classList.add("collapsible");
    await Promise.race([framesRevealed(conv), new Promise((r) => setTimeout(r, 1200))]);
    if (state.conv === conv && el.isConnected) {
      el.style.cssText = "";
      const h = el.getBoundingClientRect().height;
      const cs = getComputedStyle(el);
      if (!reduceMotion()) {
        el.style.overflow = "hidden";
        const a = el.animate([
          { height: "0px", opacity: 0, marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
          { height: `${h}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
        ], { duration: LIST_MS + 80, easing: LIST_EASE });
        a.finished.then(() => (el.style.overflow = "")).catch(() => {});
      }
      el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" });
    }
  }
  // Conversations opened later should find the reply too.
  for (const k of [...state.threadCache.keys()]) if (k.startsWith(account + "|")) state.threadCache.delete(k);
  adoptSentCopy(conv, id, account, sentPath, messageId, 0);
}

/** Find the copy of a just-sent message in Sent and give its card that identity. */
async function adoptSentCopy(conv, localId, account, sentPath, messageId, attempt) {
  const waits = [1500, 3000, 10000, 30000];
  if (attempt >= waits.length) return;
  await new Promise((r) => setTimeout(r, waits[attempt]));
  if (state.conv !== conv || !conv.cards.has(localId)) return;
  try {
    await api.syncRecent(account, "sent", 50);
    const page = await api.cachedMessages(account, sentPath, { limit: 50 });
    const real = (page.messages || []).find((x) => stripId(x.messageId) === stripId(messageId));
    if (!real) return adoptSentCopy(conv, localId, account, sentPath, messageId, attempt + 1);
    if (state.conv !== conv || !conv.cards.has(localId) || conv.cards.has(real.id)) return;
    const c = conv.cards.get(localId);
    for (const o of [c.m, c.d]) { o.id = real.id; o.uid = real.uid; o.folder = real.folder; o.date = real.date || o.date; delete o.local; }
    conv.cards.delete(localId);
    conv.cards.set(real.id, c);
    conv.order = conv.order.map((x) => (x === localId ? real.id : x));
    const el = cardEl(localId);
    if (el) el.dataset.card = real.id;
  } catch {
    adoptSentCopy(conv, localId, account, sentPath, messageId, attempt + 1);
  }
}

function bumpUnread(acct, path, delta) {
  const f = foldersOf(acct).find((x) => x.path === path);
  if (!f || !delta) return;
  f.unread = Math.max(0, f.unread + delta);
  renderSidebar();
  renderListHeader();
  updateTitle();
}

/** Account of the selection if it's all in one account (move menu, archive, etc.). */
function selectionAccount(ids = selectedIds()) {
  const accts = new Set(ids.map((id) => msgById(id)?.account).filter(Boolean));
  return accts.size === 1 ? [...accts][0] : null;
}

function canArchive(ids = selectedIds()) {
  const ms = ids.map(msgById).filter(Boolean);
  return ms.length > 0 && ms.every((m) => byRole("archive", m.account) && messageRole(m) !== "archive");
}

function renderToolbar() {
  const has = state.selected.size > 0;
  const single = state.selected.size === 1;
  // Icons reflect the whole selection (a conversation row covers several messages).
  const selMsgs = selectedIds().map(msgById).filter(Boolean);
  const sm = selMsgs.length ? { seen: !selMsgs.some((m) => !m.seen), flagged: selMsgs.every((m) => m.flagged) } : null;
  const btn = (id, ic, title, dis = !has, extra = "") => `<button class="tb-btn" id="${id}" title="${title}" ${dis ? "disabled" : ""}>${icon(ic)}${extra}</button>`;
  $("reader-toolbar").innerHTML = inDrafts() ? `
    <div class="spacer"></div>
    ${btn("tb-flag", sm?.flagged ? "flagFill" : "flag", sm?.flagged ? "Unflag (Ctrl+Shift+L)" : "Flag (Ctrl+Shift+L)")}
    ${btn("tb-trash", "trash", state.selected.size > 1 ? "Delete Drafts (Del)" : "Delete Draft (Del)")}
    <div class="tb-sep"></div>
    ${btn("tb-more", "more", "More", !single)}` : `
    <div class="spacer"></div>
    ${btn("tb-unread", sm && !sm.seen ? "envelopeOpen" : "envelope", sm && !sm.seen ? "Mark as Read (Ctrl+Shift+U)" : "Mark as Unread (Ctrl+Shift+U)")}
    ${btn("tb-flag", sm?.flagged ? "flagFill" : "flag", sm?.flagged ? "Unflag (Ctrl+Shift+L)" : "Flag (Ctrl+Shift+L)")}
    ${btn("tb-move", "folderMove", "Move to…", !has || !selectionAccount(), icon("chevronDown", "caret"))}
    ${btn("tb-trash", "trash", "Delete (Del)")}
    ${btn("tb-archive", "archive", "Archive (E)", !has || !canArchive())}
    <div class="tb-sep"></div>
    ${btn("tb-reply", "reply", "Reply, Reply All or Forward", !single, icon("chevronDown", "caret"))}
    ${btn("tb-more", "more", "More", !single)}`;
  const on = (id, fn) => $(id)?.addEventListener("click", fn);
  on("tb-unread", () => toggleSeen());
  on("tb-flag", () => toggleFlag());
  on("tb-move", (e) => showMoveMenu(e.currentTarget.getBoundingClientRect()));
  on("tb-trash", () => deleteMessages());
  on("tb-archive", () => archiveSelected());
  on("tb-reply", (e) => showMenu([
    { label: "Reply", icon: "reply", kbd: "Ctrl+R", action: () => reply("reply") },
    { label: "Reply All", icon: "replyAll", kbd: "Ctrl+Shift+R", action: () => reply("replyAll") },
    { label: "Forward", icon: "forward", kbd: "Ctrl+Shift+F", action: () => reply("forward") },
  ], e.currentTarget.getBoundingClientRect(), { alignRight: true }));
  on("tb-more", (e) => showMenu(moreMenu(), e.currentTarget.getBoundingClientRect(), { alignRight: true }));
}

const msgKey = (d) => `${d.account}:${realFolder(d.folder)}:${d.uid}`;
function remoteAllowed(d) {
  if (settings.remoteMode === "always") return true;
  const from = d.from.email.toLowerCase();
  return trusted().includes(from) || vips().includes(from) || remoteOkMessages().includes(msgKey(d));
}
const isPlain = (d) => d.html.startsWith('<div class="pm-plain">');

const cardEl = (id) => (state.conv?.root || $("reader-scroll")).querySelector(`.conv-card[data-card="${CSS.escape(id)}"]`);
const isMine = (p) => mineSet().has((p?.email || "").toLowerCase());
/**
 * The sender as shown on an open message. Your own mail can lack a name (sent before a
 * sender name was known): use your sender name, or your account name if you gave one.
 */
function shownSender(p) {
  if (!p || p.name || !isMine(p)) return p;
  const a = state.accounts.find((x) => x.email.toLowerCase() === p.email.toLowerCase());
  const label = a && a.name !== (PROVIDER_NAMES[a.provider] || "") && a.name !== a.email.split("@")[1] ? a.name : "";
  const name = a?.senderName || label;
  return name ? { ...p, name } : p;
}

function renderReader() {
  renderToolbar();
  const box = $("reader-scroll");
  const conv = state.conv;
  if (!conv) {
    const n = selectedIds().length;
    box.innerHTML = `<div class="reader-empty">${n > 1 ? `<div>${n} Messages Selected</div>` : "<div>No Message Selected</div>"}</div>`;
    return;
  }
  box.querySelectorAll(".message.staging").forEach((el) => el.remove());
  const root = document.createElement("div");
  root.className = "message";
  root.innerHTML = `<div class="conv-head"></div><div class="conv-cards"></div>`;
  conv.root = root;
  renderConvHeader(conv);
  const wrap = root.querySelector(".conv-cards");
  for (const id of conv.order) wrap.appendChild(cardElement(conv, id));
  if (conv.staged) {
    // Laid out at full size where the user is looking, but invisible until ready.
    root.classList.add("staging");
    root.style.top = `${box.scrollTop}px`;
    box.appendChild(root);
  } else {
    box.replaceChildren(root);
    box.scrollTop = 0;
  }
}

function renderConvHeader(conv) {
  const head = conv.root?.querySelector(".conv-head");
  if (!head) return;
  const cards = conv.order.map((id) => conv.cards.get(id));
  const latest = cards[0].d || cards[0].m;
  const flagged = cards.some((c) => (c.d || c.m).flagged);
  const n = cards.length;
  head.innerHTML = `<h1 class="msg-subject">${esc(latest.subject || "(No Subject)")}${flagged ? `<span class="flagmark">${icon("flagFill")}</span>` : ""}</h1>${n > 1 ? `<div class="conv-count">${n} messages</div>` : ""}`;
}

/**
 * Re-render one card in place. Cards the user has opened or closed change size
 * smoothly (and their chevron turns); the first render of the pane doesn't animate.
 */
function renderCard(conv, id) {
  if (state.conv !== conv) return;
  const old = cardEl(id);
  if (!old) return;
  const fresh = cardElement(conv, id);
  if (conv.cards.get(id)?.toggled && !reduceMotion()) swapCard(old, fresh);
  else old.replaceWith(fresh);
}

/** Replace a card, growing or shrinking from the old height to the new one. */
function swapCard(old, fresh) {
  const from = old.getBoundingClientRect().height;
  const wasOpen = !old.classList.contains("collapsed");
  old.getAnimations().forEach((a) => a.cancel());
  old.replaceWith(fresh);
  // The chevron starts where the old one was, then turns.
  const chev = fresh.querySelector(".cc-chev");
  if (chev) {
    chev.style.transition = "none";
    chev.style.transform = `rotate(${wasOpen ? 90 : 0}deg)`;
    chev.getBoundingClientRect();
    chev.style.transition = "";
    requestAnimationFrame(() => (chev.style.transform = ""));
  }
  fresh.style.height = `${from}px`;
  // The card's natural height, measurable while it's pinned to another height.
  const natural = () => {
    const top = fresh.getBoundingClientRect().top;
    let bottom = top;
    for (const k of fresh.children) bottom = Math.max(bottom, k.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(k).marginBottom) || 0));
    const cs = getComputedStyle(fresh);
    return bottom - top + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  };
  // An opened message: its body is fitted more than once while it renders (the first
  // fit can be far too tall). Wait until its height holds still for two frames
  // (at most ~300 ms) so the card doesn't overshoot, then keep following any change.
  const frame = fresh.querySelector(".msg-body iframe");
  const t0 = performance.now();
  let last = null, still = 0, ro = null, done = false, timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    ro?.disconnect();
    clearTimeout(timer);
    fresh.removeEventListener("transitionend", onEnd);
    fresh.style.transition = "";
    fresh.style.height = "";
  };
  const onEnd = (e) => { if (e.target === fresh && e.propertyName === "height") finish(); };
  const retarget = () => {
    if (done || !fresh.isConnected) return finish();
    fresh.style.height = `${natural()}px`;
    clearTimeout(timer);
    timer = setTimeout(finish, LIST_MS + 250); // in case no transitionend comes (no change)
  };
  const settle = () => {
    if (!fresh.isConnected) return;
    const waiting = performance.now() - t0 < 1300;
    if (frame && waiting) {
      const h = frame._fitDone ? frame.style.height : null;
      if (h === null || h !== last) { last = h; still = 0; return requestAnimationFrame(settle); }
      if (++still < 2) return requestAnimationFrame(settle);
    }
    fresh.style.transition = `height ${LIST_MS}ms ${LIST_EASE}`;
    fresh.addEventListener("transitionend", onEnd);
    if (frame) (ro = new ResizeObserver(retarget)).observe(frame);
    retarget();
  };
  requestAnimationFrame(settle);
}

/** Build a card element: collapsed one-liner, loading, or the full message. */
function cardElement(conv, id) {
  const c = conv.cards.get(id);
  const multiConv = conv.order.length > 1;
  const el = document.createElement("div");
  el.dataset.card = id;
  const m = c.m;
  // A draft isn't received or sent mail: it gets the DRAFT badge (and "Continue Editing").
  const isDraft = !m.local && messageRole(m) === "drafts";
  const sentTag = isDraft ? draftBadge() : isMine(m.from) ? `<span class="sent-tag">Sent</span>` : "";
  if (!c.open || !c.d) {
    el.className = `conv-card msg-card collapsed${c.open ? " loading" : ""}${m.seen ? "" : " unread"} ${cardThemeClass(c.d || m)}`.trim();
    const tail = c.error
      ? `<div class="cc-error">Couldn't load this message. ${esc(c.error)}</div>`
      : c.open ? `<div class="cc-spin"><span class="spinner"></span></div>` : "";
    el.innerHTML = `<div class="cc-head" title="${c.open ? "" : "Show this message"}">
        ${avatarHtml(m.from)}
        <div class="cc-meta">
          <div class="cc-line1"><span class="cc-from">${esc(isMine(m.from) ? "Me" : displayName(m.from))}</span>${isVipPerson(m.from) ? vipBadge() : ""}${!isMine(m.from) && isBlockedPerson(m.from) ? blockedBadge() : ""}${sentTag}<span class="cc-date">${esc(listDate(m.date))}</span>${icon("chevronRight", "cc-chev")}</div>
          <div class="cc-preview">${esc(m.preview || "This message has no content.")}</div>
        </div>
      </div>${tail}`;
    el.querySelector(".cc-head").addEventListener("click", () => {
      if (c.open && !c.error) return;
      c.open = true;
      c.toggled = true;
      c.error = null;
      renderCard(conv, id);
      loadCard(conv, id);
    });
    return el;
  }
  const d = c.d;
  el.className = `conv-card msg-card${state.detail?.id === id ? " focused" : ""} ${cardThemeClass(c.d)}`.trim();
  const from = shownSender(d.from);
  const fromBlocked = !isMine(d.from) && isBlockedPerson(d.from);
  const remoteOk = remoteAllowed(d);
  const adapted = messageAdapted(d);
  const people = (label, ps) =>
    ps.length ? `<div class="rcpts"><b>${label}:</b> ${ps.map((p, i) => `<span class="p" data-i="${label}${i}" title="${esc(p.email)}"><span class="pn">${esc(displayName(p))}</span>${icon("chevronRight", "chev")}</span>`).join("")}</div>` : "";
  const acct = acctById(d.account);
  const acctLine = multi() && acct ? `<div class="rcpts acct-line"><span class="acct-dot" style="background:${acctColor(acct.id)}"></span>${esc(acct.email)}</div>` : "";
  el.innerHTML = `
      <div class="msg-head${multiConv ? " collapsible" : ""}"${multiConv ? ' title="Hide this message"' : ""}>
        ${avatarHtml(d.from)}
        <div class="meta">
          <div class="sender"><span class="p" data-i="from"><span class="pn">${esc(displayName(from))}</span>${icon("chevronRight", "chev")}</span>${from.name ? `<span class="addr">&lt;${esc(from.email)}&gt;</span>` : ""}${isVipPerson(from) ? vipBadge() : ""}${fromBlocked ? blockedBadge() : ""}${sentTag}</div>
          ${people("To", d.to)}${people("Cc", d.cc)}${people("Bcc", d.bcc || [])}${d.replyTo.length && d.replyTo[0].email !== d.from.email ? people("Reply-To", d.replyTo) : ""}${acctLine}
        </div>
        <div class="head-right">
          <div class="head-actions">
            ${!isPlain(d) ? `<button class="theme-switch small hd-light${adapted ? " on" : ""}" role="switch" aria-checked="${adapted}" title="Dark mode for this message"><span class="ts-icon ts-sun">${icon("sun")}</span><span class="ts-icon ts-moon">${icon("moon")}</span><span class="knob"></span></button>` : ""}
            ${isDraft
              ? `<button class="mini-btn labeled" data-reply="edit" title="Continue writing this draft">${icon("compose")}<span>Continue Editing</span></button>`
              : `<button class="mini-btn labeled" data-reply="reply" title="Reply">${icon("reply")}<span>Reply</span></button>
            <button class="mini-btn labeled" data-reply="replyAll" title="Reply All">${icon("replyAll")}<span>Reply all</span></button>
            <button class="mini-btn labeled" data-reply="forward" title="Forward">${icon("forward")}<span>Forward</span></button>`}
          </div>
          <div class="when">${esc(longDate(d.date))}${multiConv ? icon("chevronRight", "cc-chev") : ""}</div>
        </div>
      </div>
      ${fromBlocked ? `<div class="remote-bar blocked-bar">${icon("block")}<span>This message is from a blocked sender.</span><button class="unblock-sender">Unblock</button></div>` : ""}
      ${d.hasRemoteContent && !remoteOk ? `<div class="remote-bar">${icon("photo")}<span>Pictures in this message were blocked to protect your privacy.</span><button class="load-remote">Load Pictures</button><button class="trust-sender">Always Load from Sender</button></div>` : ""}
      ${state.showHeaders && state.detail?.id === id ? `<div class="raw-headers">${esc(d.rawHeaders)}</div>` : ""}
      ${attachmentsHtml(d)}
      <div class="msg-body${isPlain(d) ? " plain" : ""}"><iframe sandbox="allow-same-origin allow-popups" title="Message content"></iframe></div>`;

  const focus = () => {
    if (d.local || state.detail?.id === d.id) return; // not on the server yet: not a toolbar target
    state.detail = d;
    (state.conv?.root || $("reader-scroll")).querySelectorAll(".conv-card.focused").forEach((x) => x.classList.remove("focused"));
    el.classList.add("focused");
    renderToolbar();
  };
  el.addEventListener("mousedown", focus, true);
  el.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.reply === "edit") return openDraftById(d.id);
    if (d.local) return compose({ mode: b.dataset.reply, source: d });
    focus();
    reply(b.dataset.reply);
  }));
  // In a conversation, clicking an open message's header (not a name or button) collapses it.
  if (multiConv) {
    el.querySelector(".msg-head").addEventListener("click", (e) => {
      if (e.target.closest("button, .p, a")) return;
      c.open = false;
      c.toggled = true;
      renderCard(conv, el.dataset.card);
    });
  }
  el.querySelector(".hd-light")?.addEventListener("click", () => {
    const k = msgKey(d);
    // Per-message override of the "Dark mode for messages" setting, applied in place.
    const set = !isDark() ? state.darkInLight : settings.darkMessages ? state.lightOverride : state.darkOverride;
    set.has(k) ? set.delete(k) : set.add(k);
    updateReaderTheme(true);
  });
  el.querySelector(".unblock-sender")?.addEventListener("click", () => unblockSender(d.from.email));
  el.querySelector(".load-remote")?.addEventListener("click", () => {
    store.set("remoteOkMessages", [...remoteOkMessages().slice(-999), msgKey(d)]);
    renderCard(conv, el.dataset.card);
  });
  el.querySelector(".trust-sender")?.addEventListener("click", () => {
    const from = d.from.email.toLowerCase();
    store.set("trustedSenders", [...new Set([...trusted(), from])]);
    toast(`Pictures from ${displayName(d.from)} will always load.`);
    for (const cid of conv.order) if (conv.cards.get(cid).d?.from.email.toLowerCase() === from) renderCard(conv, cid);
  });
  const allPeople = { from };
  d.to.forEach((p, i) => (allPeople["To" + i] = p));
  d.cc.forEach((p, i) => (allPeople["Cc" + i] = p));
  d.replyTo.forEach((p, i) => (allPeople["Reply-To" + i] = p));
  el.querySelectorAll(".msg-head .p").forEach((p) =>
    p.addEventListener("click", (e) => {
      // The name keeps its highlight while its menu is open (like iCloud Mail).
      p.classList.add("open");
      personMenu(allPeople[p.dataset.i], e.currentTarget.getBoundingClientRect(), () => p.classList.remove("open"));
    })
  );
  bindAttachments(el, d);
  // The iframe has to be in the document before its srcdoc is set up.
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    mountBody(el.querySelector("iframe"), d, remoteOk, adapted, { hideQuotes: multiConv });
    if (d.partial) el.insertAdjacentHTML("afterbegin", `<div class="att-loading"><span class="spinner"></span>Downloading attachments…</div>`);
    loadThumbnails(el, d);
  });
  return el;
}

const FORWARD_RE = /-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message/i;

/** Does this quote block start a forwarded message (not a reply's quoted history)? Looks only
 *  at its header and the lines just before it, so a reply that quotes a forward still folds. */
function isForwardBlock(start, subject) {
  const head = (start.querySelector(".gmail_attr, .moz-cite-prefix") || start).textContent.slice(0, 200);
  let before = "";
  for (let p = start.previousSibling, i = 0; p && i < 4; p = p.previousSibling, i++) before = (p.textContent || "") + "\n" + before;
  if (FORWARD_RE.test(head) || FORWARD_RE.test(before.slice(-200))) return true;
  // Outlook writes the same "From: … Sent: …" block for replies and forwards; the subject tells.
  return (start.id === "divRplyFwdMsg" || start.id === "appendonsend") && /^\s*(fwd?|fw)\s*:/i.test(subject);
}

/** Is there anything to read outside the folded quote, not counting signatures? */
function hasOwnWords(body) {
  let text = body.innerText; // only what's shown: folded parts are already hidden
  for (const sig of body.querySelectorAll('[data-smartmail="gmail_signature"], .gmail_signature, .moz-signature, #Signature, #signature')) {
    if (!sig.closest(".pm-q")) text = text.replace(sig.innerText, "");
  }
  // Plain text: a "-- " line starts the signature.
  text = text.split(/^--\s*$/m)[0];
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * In a conversation the earlier messages are right there, so each message's quoted
 * history is folded away behind a "•••" pill (like Outlook and Apple Mail).
 * Forwards and messages that would look empty without their quote stay unfolded.
 */
function hideQuoted(doc, onToggle, subject = "") {
  const body = doc.body;
  const start = body.querySelector("#divRplyFwdMsg, #appendonsend, .gmail_quote, .yahoo_quoted, .moz-cite-prefix, blockquote[type=cite], .pm-quote");
  if (!start) return;
  // Folding works because the quoted history is right there in the conversation. A forward
  // is the opposite: it brings something you haven't seen. Never hide it.
  if (isForwardBlock(start, subject)) return;
  // Plain text with replies written between quoted lines: leave it as is.
  if (start.classList.contains("pm-quote")) {
    for (let s = start.nextSibling; s; s = s.nextSibling) {
      if (s.nodeType === 3 ? s.textContent.trim() : s.nodeName !== "BR" && !s.classList?.contains("pm-quote")) return;
    }
  }
  const hide = [];
  const mark = (n) => {
    if (n.nodeType === 1) hide.push(n);
    else if (n.nodeType === 3 && n.textContent.trim()) {
      const s = doc.createElement("span");
      n.replaceWith(s);
      s.appendChild(n);
      hide.push(s);
    }
  };
  // The quote, everything after it, and everything after each of its ancestors.
  for (let n = start; n && n !== body; n = n.parentNode) {
    if (n === start) mark(n);
    for (let s = n.nextSibling; s; s = s.nextSibling) mark(s);
  }
  // The attribution just before it ("On … wrote:", "-----Original Message-----", a rule).
  let prev = start.previousSibling;
  for (let i = 0; prev && i < 4; i++) {
    const t = (prev.textContent || "").trim();
    const isBreak = prev.nodeName === "BR" || prev.nodeName === "HR" || (prev.nodeType === 3 && !t);
    const p = prev.previousSibling;
    if (isBreak || /wrote:?$|schrieb:?$|a écrit\s*:?$|escribió:?$|-{3,}\s*Original Message\s*-{3,}|^From:/i.test(t)) mark(prev);
    else break;
    prev = p;
  }
  if (!hide.length) return;
  hide.forEach((n) => n.classList.add("pm-q"));
  // Nothing left to read but a signature? Then don't fold anything: the message would look empty.
  if (!hasOwnWords(body)) { hide.forEach((n) => n.classList.remove("pm-q")); return; }
  const pill = doc.createElement("div");
  pill.className = "pm-more";
  pill.title = "Show quoted text";
  pill.textContent = "•••";
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    body.classList.toggle("pm-show-q");
    pill.title = body.classList.contains("pm-show-q") ? "Hide quoted text" : "Show quoted text";
    onToggle();
  });
  // Before the first folded node in document order (2 = DOCUMENT_POSITION_PRECEDING).
  hide.reduce((a, b) => (a.compareDocumentPosition(b) & 2 ? b : a)).before(pill);
}

function mountBody(frame, d, remoteOk, adapted, { hideQuotes = false } = {}) {
  const plain = isPlain(d);
  frame._plain = plain;
  frame._undoDark = null;
  const remote = remoteOk ? " https: http:" : "";
  frame.style.visibility = "hidden";
  frame._revealed = false;
  frame._fitDone = false;
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src data:${remote}">
<base target="_blank">
<style id="pm-base">
html,body{margin:0;padding:0;}
/* The frame takes the height of its content: a body sized to the window (height:100%)
   would make that circular and cut the email off. */
html:root,html>body{height:auto !important;min-height:0 !important;max-height:none !important;}
/* Same spacing in light and dark, so switching never moves the content. */
body{display:flow-root;padding:${plain ? "4px 2px" : "16px 18px"};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:break-word;overflow:hidden;}
img{max-width:100%;}
/* Keep the proportions of pictures without a set height; a height attribute is honoured
   (emails use e.g. height="1" to keep a picture as a thin strip). */
img:not([height]){height:auto;}
table img{max-width:none;}
pre{white-space:pre-wrap;}
.pm-q{display:none !important;}
body.pm-show-q .pm-q{display:revert !important;}
.pm-more{display:inline-block;margin:10px 0 4px;padding:0 9px;border-radius:9px;background:rgba(128,128,128,.18);color:#86868b;font:700 11px/18px system-ui,sans-serif;letter-spacing:1px;cursor:pointer;user-select:none;}
.pm-more:hover{background:rgba(128,128,128,.3);}
</style>
<style id="pm-theme">${messageThemeCss(plain)}</style></head><body>${d.html}</body></html>`;
  // Show the message as soon as its HTML is parsed. The iframe's `load` event waits
  // for every remote image, and slow image servers would keep the email blank.
  let started = false;
  const fit = () => fitFrame(frame);
  const begin = () => {
    const doc = frame.contentDocument;
    if (started || !doc?.body || doc.URL !== "about:srcdoc" || doc.readyState === "loading") return false;
    started = true;
    setup(doc);
    return true;
  };
  const poll = setInterval(() => {
    if (begin() || !frame.isConnected) clearInterval(poll);
  }, 15);
  frame.onload = () => {
    clearInterval(poll);
    begin();
    fit();
  };
  const setup = async (doc) => {
    if (hideQuotes) { try { hideQuoted(doc, () => fitFrameAnimated(frame), d.subject || ""); } catch {} }
    if (adapted) {
      await applyMessageTheme(frame, true, false);
      if (!frame.isConnected) return;
    }
    // Show the message only once it's complete: pictures (and web fonts) that are on their way (remote
    // ones in view, embedded ones being fetched) have arrived and its height holds still.
    // At most ~1.2 s, then it shows anyway; pictures further down stay lazy.
    const t0 = performance.now();
    let lastH = null, still = 0;
    const loadingPictures = () => doc.fonts?.status === "loading" || [...doc.images].some((i) => (i.getAttribute("src") ? !i.complete : i.dataset.pmLoaded === "1")); // web fonts reflow text too
    const reveal = () => {
      if (!frame.isConnected || frame._revealed) return;
      fit();
      const h = frame._pendingH;
      if (performance.now() - t0 < 1200) {
        if (loadingPictures()) { still = 0; return requestAnimationFrame(reveal); }
        if (h !== lastH) { lastH = h; still = 0; return requestAnimationFrame(reveal); }
        if (++still < 6) return requestAnimationFrame(reveal); // ~100 ms without change
      }
      frame._revealed = true;
      if (h) frame.style.height = h;
      frame._fitDone = true;
      frame.style.visibility = "visible";
    };
    reveal();
    doc.querySelectorAll("img").forEach((img) => {
      img.addEventListener("load", fit);
      img.addEventListener("error", fit, { once: true });
    });
    setTimeout(fit, 400);
    lazyImages(frame, doc, d, fit);
    doc.addEventListener("click", (e) => {
      const img = e.target.closest("img[data-pm-part]");
      const cur = frame._pmDetail || d;
      if (img && img.dataset.pmZoom && viewablePart(cur, +img.dataset.pmPart)) { openPreview(cur, +img.dataset.pmPart, frame); return; }
      const a = e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (/^mailto:/i.test(href)) {
        const addr = decodeURIComponent(href.slice(7).split("?")[0]);
        compose({ to: addr.split(",").map((x) => ({ name: "", email: x.trim() })), account: d.account });
      } else if (/^https?:/i.test(href)) openUrl(href);
    });
    doc.addEventListener("keydown", (e) => document.dispatchEvent(new KeyboardEvent("keydown", e)));
    doc.addEventListener("mousedown", () => closeMenu());
    doc.addEventListener("wheel", (e) => {
      if (e.ctrlKey) { e.preventDefault(); setZoom(settings.zoom + (e.deltaY < 0 ? 10 : -10)); }
    }, { passive: false });
  };
}

/**
 * Lazy-load pictures in a message: remote images (data-pm-src) and embedded ones
 * (data-pm-part, converted by the app when needed) load as they near the screen.
 */
function lazyImages(frame, doc, d, fit) {
  const remoteImgs = [...doc.querySelectorAll("img[data-pm-src], img[data-pm-srcset]")];
  const partImgs = d.partial ? [] : [...doc.querySelectorAll("img[data-pm-part]")];
  // A zoom cursor (and a click that opens the viewer) for pictures worth enlarging:
  // not tiny ones like signature icons and social-media logos.
  // The frame's clicks use the latest detail (a big email's full download replaces the partial one).
  frame._pmDetail = d;
  doc.querySelectorAll("img[data-pm-part]").forEach((img) => {
    if (!viewablePart(d, +img.dataset.pmPart)) return;
    const big = () => img.naturalWidth >= 48 || img.naturalHeight >= 48;
    const mark = () => {
      if (!big()) return;
      img.dataset.pmZoom = "1";
      img.style.cursor = "zoom-in";
    };
    // Each picture starts as a 1×1 placeholder and the real one is swapped in later, so
    // check again whenever it loads (not just now: the placeholder is "loaded" already).
    img.addEventListener("load", mark);
    if (img.complete && big()) mark();
  });
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < 3 && queue.length) {
      const img = queue.shift();
      active++;
      api.inlineImage(d.account, d.folder, d.uid, +img.dataset.pmPart)
        .then((url) => { if (url && frame.isConnected) img.src = url; })
        .catch(() => {})
        .finally(() => { active--; pump(); });
    }
  };
  const load = (img) => {
    if (img.dataset.pmLoaded) return;
    img.dataset.pmLoaded = "1";
    // Fade the picture in once it arrives.
    img.style.opacity = "0";
    img.style.transition = "opacity 0.35s ease";
    const show = () => { img.style.opacity = ""; };
    img.addEventListener("load", () => requestAnimationFrame(show), { once: true });
    img.addEventListener("error", show, { once: true });
    if (img.dataset.pmPart !== undefined && !img.dataset.pmSrc) {
      queue.push(img);
      pump();
      return;
    }
    if (img.dataset.pmSrcset) img.srcset = img.dataset.pmSrcset;
    if (img.dataset.pmSrc) img.src = img.dataset.pmSrc;
  };
  let pending = [...remoteImgs, ...partImgs];
  frame._pmLoadAll = () => { pending.forEach(load); pending = []; };
  if (!pending.length) return;
  // Check positions against the reading pane (an IntersectionObserver in this window
  // can't see elements inside the message iframe).
  const scroller = $("reader-scroll");
  const MARGIN = 1200;
  const check = () => {
    if (!frame.isConnected) { scroller.removeEventListener("scroll", onScroll); return; }
    const view = scroller.getBoundingClientRect();
    const top = frame.getBoundingClientRect().top;
    pending = pending.filter((img) => {
      const r = img.getBoundingClientRect();
      const y = top + r.top;
      if (y < view.bottom + MARGIN && y + Math.max(r.height, 1) > view.top - MARGIN) { load(img); return false; }
      return true;
    });
    if (!pending.length) scroller.removeEventListener("scroll", onScroll);
  };
  let raf = 0;
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; check(); }); };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  check();
  setTimeout(check, 500); // after layout settles (fit-to-width / zoom)
}

/* ------------------------------------------------------------------ */
/* Image attachments: thumbnails + viewer                              */
/* ------------------------------------------------------------------ */
const isImage = (a) => /^image\/(png|jpe?g|pjpeg|gif|webp|bmp|tiff?|x-tiff)$/i.test(a.mime);

/** First-page pictures of PDF attachments, kept while the app runs. */
const pdfThumbs = new Map();
async function pdfThumb(d, index) {
  const key = `${d.account}|${d.folder}|${d.uid}|${index}`;
  if (!pdfThumbs.has(key)) {
    const p = api.attachmentData(d.account, d.folder, d.uid, index)
      .then((buf) => pdfThumbnail(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer, 360));
    pdfThumbs.set(key, p);
    p.catch(() => pdfThumbs.delete(key));
    while (pdfThumbs.size > 60) pdfThumbs.delete(pdfThumbs.keys().next().value);
  }
  return pdfThumbs.get(key);
}

/** Thumbnails load only when their tile scrolls into view. */
function loadThumbnails(box, d) {
  if (d.partial) return;
  const tiles = [...box.querySelectorAll(".att.image")];
  if (!tiles.length) return;
  const fill = async (el) => {
    try {
      const url = el.classList.contains("pdf") ? await pdfThumb(d, +el.dataset.idx) : await api.attachmentPreview(d.account, d.folder, d.uid, +el.dataset.idx, 360);
      if (url && el.isConnected) {
        const thumb = el.querySelector(".thumb");
        const im = new Image();
        im.className = "thumb-img";
        im.alt = "";
        im.onload = () => { thumb.classList.add("loaded"); requestAnimationFrame(() => im.classList.add("shown")); };
        im.src = url;
        thumb.appendChild(im);
      }
    } catch {}
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); fill(e.target); }
  }, { root: $("reader-scroll"), rootMargin: "300px" });
  tiles.forEach((t) => io.observe(t));
}

/** How an attachment can be shown in the app (the backend decides; images as a fallback). */
const previewKind = (a) => a.kind || (isImage(a) ? "image" : "none");
const canPreview = (a) => previewKind(a) !== "none";
const TEXT_LIMIT = 2 * 1024 * 1024;

/** Decode text: UTF-8 when it is valid, else the usual Windows codepage. */
function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}

/**
 * Quick Look-style viewer for a message's attachments: images, PDFs (the WebView's own
 * PDF viewer), audio/video, text and HTML. Arrows step through the previewable ones.
 */
/** Pictures embedded in this message's body worth enlarging (the zoomable ones), in the
 *  order they appear there. Attachments aren't included: they come from `d.attachments`. */
function bodyImages(d, frame) {
  const doc = frame?.contentDocument;
  if (!doc) return [];
  const byIdx = new Map((d.inlineImages || []).map((a) => [a.index, a]));
  const seen = new Set();
  const out = [];
  for (const img of doc.querySelectorAll("img[data-pm-part][data-pm-zoom]")) {
    const i = +img.dataset.pmPart;
    if (seen.has(i) || !byIdx.has(i)) continue;
    seen.add(i);
    out.push(byIdx.get(i));
  }
  return out;
}

/** Can a click on this embedded picture open the viewer? */
const viewablePart = (d, idx) => d.attachments.some((a) => a.index === idx) || (d.inlineImages || []).some((a) => a.index === idx);

/** The viewer. Opened from a picture in the body (`frame` given), it pages through the body's
 *  pictures and then the attachments; opened from an attachment, just the attachments. */
function openPreview(d, startIdx, frame = null) {
  const items = [...bodyImages(d, frame), ...d.attachments.filter(canPreview)];
  if (!items.length) return;
  let pos = Math.max(0, items.findIndex((a) => a.index === startIdx));
  let blobUrl = null;
  const back = document.createElement("div");
  back.className = "viewer-back";
  back.innerHTML = `<div class="viewer-bar">
      <span class="viewer-name"></span><span class="viewer-count"></span><div class="spacer"></div>
      <button class="mini-btn labeled" data-v="open">${icon("expand")}<span>Open</span></button>
      <button class="mini-btn labeled" data-v="png">${icon("photo")}<span>Save as PNG</span></button>
      <button class="mini-btn labeled" data-v="save">${icon("download")}<span>Save</span></button>
      <button class="mini-btn" data-v="close" title="Close (Esc)">${icon("xmark")}</button>
    </div>
    <button class="viewer-nav prev" data-v="prev" title="Previous">${icon("chevronRight")}</button>
    <div class="viewer-stage"></div>
    <button class="viewer-nav next" data-v="next" title="Next">${icon("chevronRight")}</button>`;
  document.body.appendChild(back);
  const stage = back.querySelector(".viewer-stage");
  let cleanupPdf = null;
  const dropBlob = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
    cleanupPdf?.();
    cleanupPdf = null;
  };
  const fileCount = () => (items.length > 1 ? `${pos + 1} of ${items.length}` : "");
  const fail = (a) => {
    stage.innerHTML = `<div class="viewer-none"><div class="ficon big">${esc((a.name.split(".").pop() || "").slice(0, 4))}</div><div>Can't preview this file.</div><button class="mini-btn labeled" data-v="open"><span>Open</span></button></div>`;
  };
  const bytes = async (a) => {
    const buf = await api.attachmentData(d.account, d.folder, d.uid, a.index);
    return buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;
  };
  const show = async () => {
    const a = items[pos];
    const kind = previewKind(a);
    back.querySelector(".viewer-name").textContent = a.name;
    back.querySelector(".viewer-count").textContent = fileCount();
    back.querySelector(".prev").hidden = back.querySelector(".next").hidden = items.length < 2;
    back.querySelector("[data-v=png]").hidden = kind !== "image" || /png/i.test(a.mime);
    dropBlob();
    stage.className = "viewer-stage kind-" + kind;
    stage.innerHTML = `<span class="spinner"></span>`;
    const want = pos;
    const current = () => want === pos && back.isConnected;
    try {
      if (kind === "image") {
        const url = await api.attachmentPreview(d.account, d.folder, d.uid, a.index, 2400);
        if (!current()) return;
        if (!url) return fail(a);
        const img = new Image();
        img.alt = "";
        img.onload = () => { stage.querySelector(".spinner")?.remove(); img.classList.add("shown"); };
        img.src = url;
        stage.appendChild(img);
        return;
      }
      const buf = await bytes(a);
      if (!current()) return;
      if (kind === "text" || kind === "html") {
        let text = decodeText(buf.byteLength > TEXT_LIMIT ? buf.slice(0, TEXT_LIMIT) : buf);
        if (kind === "html") {
          // No scripts, no network: just the document as written.
          const f = document.createElement("iframe");
          f.setAttribute("sandbox", "");
          f.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` + text;
          stage.replaceChildren(f);
        } else {
          const pre = document.createElement("pre");
          pre.className = "viewer-text";
          pre.textContent = text;
          if (buf.byteLength > TEXT_LIMIT) pre.insertAdjacentHTML("beforeend", `<div class="viewer-note">Only the first 2 MB are shown.</div>`);
          stage.replaceChildren(pre);
        }
        return;
      }
      if (kind === "pdf") {
        // Drawn by pdf.js: plain white pages, no viewer chrome.
        const onPage = (n, total) => {
          if (!current()) return;
          const files = fileCount();
          back.querySelector(".viewer-count").textContent = `Page ${n} of ${total}` + (files ? ` · ${files} files` : "");
        };
        const stop = await renderPdf(stage, buf, { onPage, alive: current });
        if (current()) cleanupPdf = stop;
        else stop();
        return;
      }
      blobUrl = URL.createObjectURL(new Blob([buf], { type: a.mime }));
      {
        const media = document.createElement(kind === "video" ? "video" : "audio");
        media.controls = true;
        media.preload = "metadata";
        media.onerror = () => current() && fail(a);
        media.src = blobUrl;
        stage.replaceChildren(media);
      }
    } catch (e) {
      if (!current()) return;
      fail(a);
      handleError(e, true);
    }
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    stage.querySelectorAll("video, audio").forEach((m) => m.pause());
    dropBlob();
    dismissModal(back);
  };
  const step = (n) => { pos = (pos + n + items.length) % items.length; show(); };
  const onKey = (e) => {
    if (back._closing) return;
    e.stopPropagation();
    if (e.key === "Escape") return close();
    // Arrows belong to a focused media player; otherwise they change file.
    if (e.target.closest?.("video, audio, pre")) return;
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  };
  document.addEventListener("keydown", onKey, true);
  // A click on the empty dark area closes, as for images: around the PDF pages too
  // (but not on its scrollbar, and not when a text selection drag ends there).
  const isBackdrop = (el) => el === back || el === stage || el?.classList?.contains("pdf-scroll");
  let downOn = null;
  back.addEventListener("mousedown", (e) => {
    const el = e.target;
    const onScrollbar = el.classList?.contains("pdf-scroll") && e.offsetX >= el.clientWidth;
    downOn = isBackdrop(el) && !onScrollbar ? el : null;
  });
  back.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) {
      if (isBackdrop(e.target) && downOn === e.target && !String(getSelection()).trim()) close();
      return;
    }
    const a = items[pos];
    try {
      if (b.dataset.v === "close") close();
      if (b.dataset.v === "prev") step(-1);
      if (b.dataset.v === "next") step(1);
      if (b.dataset.v === "open") await api.openAttachment(d.account, d.folder, d.uid, a.index);
      if (b.dataset.v === "save" && (await api.saveAttachment(d.account, d.folder, d.uid, a.index))) toast("Attachment saved.");
      if (b.dataset.v === "png" && (await api.saveAttachmentPng(d.account, d.folder, d.uid, a.index))) toast("Image saved as PNG.");
    } catch (err) { handleError(err); }
  });
  show();
}

/** Scale wide emails down to fit the pane (like Outlook), combined with the user's zoom. */
function fitFrame(frame) {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const user = settings.zoom / 100;
  // A picture with a set height that had to be narrowed to fit keeps its proportions.
  for (const img of doc.querySelectorAll("img[height]")) {
    const w = parseFloat(img.getAttribute("width"));
    if (w && img.getBoundingClientRect().width < w * (parseFloat(doc.body.style.zoom) || 1) - 1 && !img.closest("table")) img.style.height = "auto";
  }
  doc.body.style.zoom = user;
  const avail = frame.clientWidth;
  const needed = doc.documentElement.scrollWidth;
  if (needed > avail + 2) doc.body.style.zoom = Math.max(0.4, user * (avail / needed));
  // The body's own box (a block formatting context, so floats and margins are inside
  // it), or its content if that sticks out further. Unlike the document's scrollHeight
  // this can also get smaller, e.g. when quoted text is hidden again.
  const body = doc.body;
  let bottom = body.getBoundingClientRect().bottom;
  let kids = 0;
  for (const k of body.children) kids = Math.max(kids, k.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(k).marginBottom) || 0));
  if (kids) bottom = Math.max(bottom, kids + (parseFloat(getComputedStyle(body).paddingBottom) || 0));
  const px = Math.max(40, Math.ceil(bottom + doc.documentElement.scrollTop)) + "px";
  // Not shown yet: remember the height, apply it when the message appears.
  if (frame._revealed === false) frame._pendingH = px;
  else frame.style.height = px;
}

/** Refit with the height change animated (showing or hiding quoted text). */
function fitFrameAnimated(frame) {
  const from = frame.getBoundingClientRect().height;
  frame.getAnimations().forEach((a) => a.cancel());
  fitFrame(frame);
  const to = frame.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1 || reduceMotion()) return;
  frame.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: LIST_MS, easing: LIST_EASE });
}

function setZoom(z) {
  saveSetting("zoom", Math.max(50, Math.min(200, Math.round(z / 10) * 10)));
  readerFrames().forEach(fitFrame);
  toast(`Zoom ${settings.zoom}%`, { duration: 1200 });
}

const readerFrames = () => [...$("reader-scroll").querySelectorAll(".msg-body iframe")];
new ResizeObserver(() => {
  readerFrames().forEach((f) => f.contentDocument?.body && fitFrame(f));
}).observe($("reader"));

function personMenu(p, rect, onClose) {
  if (!p) return;
  const k = p.email.toLowerCase();
  const isVip = vips().includes(k);
  const isTrusted = trusted().includes(k);
  showMenu([
    { header: p.name ? `${p.name} <${p.email}>` : p.email },
    { label: "New Message", icon: "compose", action: () => compose({ to: [p], account: state.detail?.account }) },
    { label: "Copy Address", action: () => navigator.clipboard.writeText(p.email).then(() => toast("Address copied.")) },
    { label: isVip ? "Remove from VIP" : "Add to VIP", icon: "vip", action: () => toggleVip(p.email) },
    { label: isTrusted ? "Stop Always Loading Pictures" : "Always Load Pictures", icon: "photo", action: () => {
      store.set("trustedSenders", isTrusted ? trusted().filter((x) => x !== k) : [...trusted(), k]);
      renderReader();
    } },
    { label: "Search for Messages from Sender", icon: "search", action: () => { $("search").value = p.email; setQuery(p.email); } },
    { sep: true },
    isBlockedPerson(p)
      ? { label: "Unblock Sender", icon: "block", action: () => unblockSender(p.email) }
      : { label: "Block Sender…", icon: "block", danger: true, action: () => blockSenders([p]) },
  ], rect, { onClose });
}

function toggleVip(email) {
  const k = email.toLowerCase();
  const list = vips();
  const i = list.indexOf(k);
  i >= 0 ? list.splice(i, 1) : list.push(k);
  store.set("vips", list);
  toast(i >= 0 ? "Removed from VIP." : "Added to VIP.");
  vipsChanged();
}

/* ---- Blocked senders ------------------------------------------------------
 * iCloud has no server rules over IMAP, so the app does it: whenever it sees inbox mail from a
 * blocked sender (list loads and new-mail checks), that mail is moved to Trash, quietly.
 */
/** Move blocked senders' inbox mail among `msgs` to Trash. Returns the ids it started moving. */
function sweepBlocked(msgs) {
  if (!blocked().length) return [];
  const hits = msgs.filter((m) => realFolder(m.folder) === "INBOX" && isBlockedPerson(m.from) && !sweeping.has(m.id) && !state.removing.get(m.id)?.committed);
  if (!hits.length) return [];
  const groups = new Map();
  for (const m of hits) {
    const k = `${m.account}\n${realFolder(m.folder)}`;
    if (!groups.has(k)) groups.set(k, { account: m.account, folder: realFolder(m.folder), ids: [], uids: [] });
    groups.get(k).ids.push(m.id);
    groups.get(k).uids.push(m.uid);
  }
  for (const g of groups.values()) {
    g.ids.forEach((id) => sweeping.add(id));
    markRemoving(g.ids);
    api.moveToRole(g.account, g.folder, g.uids, "trash")
      .then(() => { markRemoved(g.ids); api.logEvent("blocked", `moved ${g.uids.length} to Trash`); loadFolders(); })
      .catch((e) => { unmarkRemoving(g.ids); api.logEvent("blocked", `couldn't move to Trash: ${errText(e)}`); })
      .finally(() => g.ids.forEach((id) => sweeping.delete(id)));
  }
  return hits.map((m) => m.id);
}

async function blockSenders(people) {
  const mine = new Set(state.accounts.map((a) => a.email.toLowerCase()));
  const list = [...new Map(people.filter((p) => p?.email && !mine.has(p.email.toLowerCase())).map((p) => [p.email.toLowerCase(), p])).values()];
  if (!list.length) return toast("You can't block your own address.", { error: true });
  const who = list.length === 1 ? (list[0].name ? `${list[0].name} (${list[0].email})` : list[0].email) : `${list.length} senders`;
  const ok = await dialog({
    title: `Block ${who}?`,
    message: "Their mail in your inbox moves to Trash, now and whenever new mail from them arrives. Unblock any time from the account menu → Blocked Senders.",
    ok: "Block",
    danger: true,
  });
  if (!ok) return;
  store.set("blockedSenders", [...new Set([...blocked(), ...list.map((p) => p.email.toLowerCase())])]);
  blockedChanged(list.map((p) => p.email)); // badges first, then their inbox rows slide away
  const ids = sweepBlocked(state.messages);
  if (ids.length) removeFromList(ids);
  toast(ids.length ? `Blocked. Moved ${count(ids.length)} to Trash.` : "Blocked.");
}

function unblockSender(email) {
  const k = email.toLowerCase();
  store.set("blockedSenders", blocked().filter((x) => x !== k));
  toast("Unblocked.");
  blockedChanged([k]);
}

/** Senders were blocked or unblocked: update the "Blocked" badges in the list and the open
 *  conversation's cards from them (other cards stay as they are, so nothing reloads needlessly). */
function blockedChanged(emails) {
  const set = new Set(emails.map((e) => e.toLowerCase()));
  renderList({ animate: false });
  const conv = state.conv;
  if (!conv) return;
  for (const id of conv.order) {
    const c = conv.cards.get(id);
    const from = (c?.d?.from || c?.m?.from)?.email?.toLowerCase();
    if (from && set.has(from)) renderCard(conv, id);
  }
}

async function manageBlocked() {
  const r = await dialog({ title: "Blocked Senders", message: "One email address per line. Their inbox mail is moved to Trash.", fields: [{ id: "v", multiline: true, value: blocked().join("\n") }], ok: "Save" });
  if (!r) return;
  const before = blocked();
  store.set("blockedSenders", [...new Set(r.v.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@")))]);
  const after = blocked();
  blockedChanged([...before.filter((x) => !after.includes(x)), ...after.filter((x) => !before.includes(x))]);
  const ids = sweepBlocked(state.messages);
  if (ids.length) removeFromList(ids);
}

/** The VIP list changed (menu or the VIPs… editor): update everything that shows it. */
function vipsChanged() {
  if (state.folder === U_VIP) loadList();
  else renderList({ animate: false });
  updateVirtualCounts();
  // Open conversation: update the headers in place (no reload of the emails themselves).
  const conv = state.conv;
  if (conv) for (const id of conv.order) {
    const el = cardEl(id), c = conv.cards.get(id);
    if (!el || !c) continue;
    const from = c.m.from, vip = isVipPerson(from);
    el.querySelectorAll(".msg-head > .avatar, .cc-head > .avatar").forEach((a) => a.classList.toggle("vip", vip));
    el.querySelectorAll(".msg-head .sender, .cc-line1").forEach((line) => {
      line.querySelector(".vip-badge")?.remove();
      if (vip) (line.querySelector(".addr") || line.querySelector('.p[data-i="from"], .cc-from'))?.insertAdjacentHTML("afterend", vipBadge());
    });
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */
/** Account to send from by default: the message's account, the viewed account, or the first. */
const defaultFromAccount = () => keyAcct() || state.accounts[0]?.id;

function compose(opts = {}) {
  const fromId = opts.account || opts.source?.account || defaultFromAccount();
  loadCompose().then(({ openCompose }) => openCompose({
    mode: "new",
    ...opts,
    account: acctById(fromId) || state.accounts[0],
    accounts: state.accounts,
    signature: opts.mode === "draft" ? "" : settings.signature,
    allowRemote: settings.remoteMode === "always",
    undoDelay: settings.undoSendDelay,
    avatar: (p) => avatarHtml(p, "sug-avatar"), // same contact photos / initials as the inbox
    onDone: (what, info) => {
      if (what === "sent" && info) showSentInConversation(info);
      if (what === "draftDeleted" && info) {
        // Same as deleting it from the list: the row goes, and the next one is selected.
        const m = state.messages.find((x) => x.account === info.account && x.uid === info.uid && messageRole(x) === "drafts");
        if (m) { markRemoved([m.id]); removeFromList([m.id]); }
        else if (currentRole() === "drafts") softRefreshList(); // not listed yet (a newer save): just reload
        loadFolders();
        return;
      }
      const r = currentRole();
      if ((what === "sent" && r === "sent") || (what === "draft" && r === "drafts")) softRefreshList();
      loadFolders();
    },
  }));
}

function reply(mode) {
  if (state.detail) compose({ mode, source: state.detail });
}

/** Enter on a selected draft: same as its "Continue Editing" button. */
function editDraft() {
  if (state.selected.size === 1) openDraftById([...state.selected][0]);
}

/** Load a draft in full (not the quick partial preview) and continue it in the compose window. */
let draftOpening = null;
async function openDraftById(id) {
  const m = msgById(id);
  if (!m || draftOpening === id) return;
  draftOpening = id;
  try {
    const d = await api.message(m.account, m.folder, m.uid, false, false);
    d.id = m.id;
    compose({ mode: "draft", source: d });
  } catch (e) {
    handleError(e);
  } finally {
    draftOpening = null;
  }
}

function messageMenu() {
  const ids = selectedIds();
  const ms = ids.map(msgById).filter(Boolean);
  const anyUnread = ms.some((m) => !m.seen);
  const anyUnflagged = ms.some((m) => !m.flagged);
  const single = state.selected.size === 1 && state.detail;
  const allJunk = ms.length > 0 && ms.every((m) => messageRole(m) === "junk");
  if (inDrafts()) {
    // Only what makes sense for an unsent message of your own.
    const one = ids.length === 1;
    return [
      { label: "Continue Editing", icon: "compose", kbd: "Enter", disabled: !one, action: () => openDraftById(ids[0]) },
      { sep: true },
      { label: anyUnflagged ? "Flag" : "Unflag", icon: "flag", action: () => toggleFlag() },
      { sep: true },
      { label: one ? "Delete Draft" : "Delete Drafts", icon: "trash", danger: true, kbd: "Del", action: () => deleteMessages() },
    ];
  }
  return [
    { label: "Reply", icon: "reply", disabled: !single, action: () => reply("reply") },
    { label: "Reply All", icon: "replyAll", disabled: !single, action: () => reply("replyAll") },
    { label: "Forward", icon: "forward", disabled: !single, action: () => reply("forward") },
    { sep: true },
    { label: anyUnread ? "Mark as Read" : "Mark as Unread", icon: anyUnread ? "envelopeOpen" : "envelope", action: () => toggleSeen() },
    { label: anyUnflagged ? "Flag" : "Unflag", icon: "flag", action: () => toggleFlag() },
    { sep: true },
    { label: "Move to…", icon: "folderMove", disabled: !selectionAccount(ids), action: () => showMoveMenu($("tb-move").getBoundingClientRect()) },
    { label: allJunk ? "Not Junk" : "Move to Junk", icon: allJunk ? "inbox" : "junk", action: () => moveToRole(ids, allJunk ? "inbox" : "junk") },
    { label: "Archive", icon: "archive", disabled: !canArchive(ids), action: () => archiveSelected() },
    { label: "Delete", icon: "trash", danger: true, kbd: "Del", action: () => deleteMessages() },
    { sep: true },
    { label: new Set(ms.map((m) => m.from?.email?.toLowerCase())).size > 1 ? "Block Senders…" : "Block Sender…", icon: "block", danger: true, disabled: !ms.length, action: () => blockSenders(ms.map((m) => m.from)) },
  ];
}

function moreMenu() {
  const d = state.detail;
  const junk = currentRole() === "junk";
  if (inDrafts()) {
    // Viewing tools only: no replying to, junking or VIP-ing your own unsent message.
    return [
      { label: "Print…", icon: "print", kbd: "Ctrl+P", action: printMessage },
      { label: "Zoom In", kbd: "Ctrl+=", action: () => setZoom(settings.zoom + 10) },
      { label: "Zoom Out", kbd: "Ctrl+-", action: () => setZoom(settings.zoom - 10) },
      { label: "Actual Size", kbd: "Ctrl+0", action: () => setZoom(100) },
      { label: state.showHeaders ? "Hide All Headers" : "Show All Headers", action: () => { state.showHeaders = !state.showHeaders; if (state.detail) renderCard(state.conv, state.detail.id); } },
      { label: "View Source", icon: "doc", action: viewSource },
    ];
  }
  return [
    { label: "Reply", icon: "reply", action: () => reply("reply") },
    { label: "Reply All", icon: "replyAll", action: () => reply("replyAll") },
    { label: "Forward", icon: "forward", action: () => reply("forward") },
    { sep: true },
    { label: junk ? "Not Junk" : "Move to Junk", icon: "junk", action: () => moveToRole(selectedIds(), junk ? "inbox" : "junk") },
    { label: "Print…", icon: "print", kbd: "Ctrl+P", action: printMessage },
    { label: "Zoom In", kbd: "Ctrl+=", action: () => setZoom(settings.zoom + 10) },
    { label: "Zoom Out", kbd: "Ctrl+-", action: () => setZoom(settings.zoom - 10) },
    { label: "Actual Size", kbd: "Ctrl+0", action: () => setZoom(100) },
    { label: state.showHeaders ? "Hide All Headers" : "Show All Headers", action: () => { state.showHeaders = !state.showHeaders; if (state.detail) renderCard(state.conv, state.detail.id); } },
    { label: "View Source", icon: "doc", action: viewSource },
    { sep: true },
    { label: d && vips().includes(d.from.email.toLowerCase()) ? "Remove Sender from VIP" : "Add Sender to VIP", icon: "vip", disabled: !d, action: () => toggleVip(d.from.email) },
    d && isBlockedPerson(d.from)
      ? { label: "Unblock Sender", icon: "block", action: () => unblockSender(d.from.email) }
      : { label: "Block Sender…", icon: "block", danger: true, disabled: !d, action: () => blockSenders([d.from]) },
  ];
}

function showMoveMenu(rect) {
  const ids = selectedIds();
  const acct = selectionAccount(ids);
  if (!ids.length || !acct) return;
  const here = new Set(ids.map((id) => realFolder(msgById(id).folder)));
  const targets = foldersOf(acct).filter((f) => f.selectable && !(here.size === 1 && here.has(f.path)) && f.role !== "drafts" && f.role !== "sent");
  showMenu(
    [{ header: multi() ? `Move to (${acctLabel(acctById(acct))})` : "Move to" }, ...targets.map((f) => ({ label: ROLE_TITLES[f.role] || f.name, icon: f.role ? ROLE_ICON[f.role] : "folder", action: () => moveMessages(ids, fkey(acct, f.path)) }))],
    rect,
    { alignRight: true, scroll: true }
  );
}

/** Take messages out of the list (animated) and select the next one, like iCloud / Outlook. */
function removeFromList(ids) {
  const set = new Set(ids);
  // Where the removed entry (message or conversation) sat, to select the one after it.
  const before = listEntries();
  const idx = before.findIndex((e) => e.ids.some((i) => set.has(i)));
  const wasSelected = before.some((e) => state.selected.has(e.key) && e.ids.some((i) => set.has(i)));
  state.messages = state.messages.filter((m) => !set.has(m.id));
  state.total = Math.max(0, state.total - ids.length);
  ids.forEach((id) => state.selected.delete(id));
  pruneSelection();
  renderList(); // removed rows collapse; the rows below follow smoothly
  if (!wasSelected) return;
  const rest = visibleKeys();
  const next = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
  if (next) selectOnly(next, { open: true });
  else { closeReader(); }
}

/** Remember removals so refreshes can't bring them back before the server catches up. */
const markRemoving = (ids) => ids.forEach((id) => state.removing.set(id, { committed: false, at: Date.now() }));
const markRemoved = (ids) => ids.forEach((id) => state.removing.set(id, { committed: true, at: Date.now() }));
const unmarkRemoving = (ids) => ids.forEach((id) => state.removing.delete(id));

// Moves and deletes are applied after a short delay so they can be undone. Several in a
// row stack up: each Undo (or Ctrl+Z) takes back the latest, and once you pause for the
// undo window they're all sent to the server.
const UNDO_MS = 6000;
const undoStack = [];
let undoTimer = null;
function commitPending() {
  clearTimeout(undoTimer);
  const all = undoStack.splice(0);
  return Promise.all(all.map((p) => p.run()));
}
/** Restart the undo window and offer Undo for the latest pending action. */
function offerUndo() {
  clearTimeout(undoTimer);
  const p = undoStack[undoStack.length - 1];
  if (!p) return;
  undoTimer = setTimeout(commitPending, UNDO_MS);
  toast(p.label, {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      run: () => {
        if (undoStack[undoStack.length - 1] !== p) return;
        undoStack.pop();
        p.undo();
        offerUndo(); // the one before it, if any
      },
    },
  });
}

/** Remove messages from the list now, run `fn(groups)` after the undo window. */
function runMove(ids, fn, label) {
  if (!ids.length) return;
  const view = state.folder;
  const groups = groupsOf(ids);
  const removed = groups.flatMap((g) => g.msgs);
  const removedIds = removed.map((m) => m.id);
  const unreadBy = groups.map((g) => [g.account, realFolder(g.folder), g.msgs.filter((m) => !m.seen).length]);
  markRemoving(removedIds);
  removeFromList(removedIds);
  unreadBy.forEach(([a, f, n]) => bumpUnread(a, f, -n));
  undoStack.push({
    label,
    run: async () => {
      try {
        await fn(groups);
        markRemoved(removedIds); // hidden until the server stops listing them
        loadFolders();
      } catch (e) {
        unmarkRemoving(removedIds);
        handleError(e);
        if (state.folder === view) softRefreshList();
      }
    },
    undo: () => {
      unmarkRemoving(removedIds);
      unreadBy.forEach(([a, f, n]) => bumpUnread(a, f, n));
      if (state.folder !== view) return;
      const have = new Set(state.messages.map((m) => m.id));
      state.messages.push(...removed.filter((m) => !have.has(m.id)));
      state.messages.sort(isUnified() ? listOrder : (a, b) => (oldestFirst() ? -1 : 1) * (b.uid - a.uid));
      state.total += removed.length;
      renderList(); // restored rows expand back into place
      selectOnly(removed[0].id, { open: true, markSeen: false });
    },
  });
  offerUndo();
}

const count = (n) => (n === 1 ? "1 message" : `${n} messages`);

function moveMessages(ids, destKey) {
  const acct = keyAcct(destKey), dest = keyPath(destKey);
  const same = ids.filter((id) => msgById(id)?.account === acct);
  if (!same.length) return toast("Messages can only be moved to folders in the same account.", { error: true });
  if (same.length < ids.length) toast("Only messages from the same account were moved.");
  runMove(same, (groups) => Promise.all(groups.map((g) => api.move(g.account, g.folder, g.uids, dest))), `Moved ${count(same.length)} to ${folderTitle(destKey)}.`);
}

const moveToRole = (ids, role) =>
  runMove(ids, (groups) => Promise.all(groups.map((g) => api.moveToRole(g.account, g.folder, g.uids, role))), `Moved ${count(ids.length)} to ${role === "inbox" ? "Inbox" : role[0].toUpperCase() + role.slice(1)}.`);
const archiveSelected = () => { if (canArchive()) moveToRole(selectedIds(), "archive"); };

async function deleteMessages(ids = selectedIds()) {
  if (!ids.length) return;
  if (currentRole() === "trash") {
    const r = await dialog({ title: `Permanently delete ${ids.length === 1 ? "this message" : ids.length + " messages"}?`, message: "You can't undo this action.", ok: "Delete", danger: true });
    if (!r) return;
    const groups = groupsOf(ids);
    markRemoving(ids);
    removeFromList(ids);
    try {
      await Promise.all(groups.map((g) => api.remove(g.account, g.folder, g.uids)));
      markRemoved(ids);
      loadFolders();
    } catch (e) { unmarkRemoving(ids); handleError(e); softRefreshList(); }
    return;
  }
  runMove(ids, (groups) => Promise.all(groups.map((g) => api.remove(g.account, g.folder, g.uids))), `Moved ${count(ids.length)} to Trash.`);
}

async function toggleSeen(ids = selectedIds()) {
  const ms = ids.map(msgById).filter(Boolean);
  if (!ms.length) return;
  const on = ms.some((m) => !m.seen);
  const groups = groupsOf(ids);
  for (const g of groups) bumpUnread(g.account, realFolder(g.folder), g.msgs.filter((m) => m.seen !== on).length * (on ? -1 : 1));
  ms.forEach((m) => { m.seen = on; updateRow(m.id); });
  noteFlag(ms, "seen", on);
  updateSelectionClasses();
  renderToolbar();
  try {
    await Promise.all(groups.map((g) => api.setFlag(g.account, g.folder, g.uids, "seen", on)));
    settleFlag(ms);
  } catch (e) { settleFlag(ms, true); handleError(e); softRefreshList(); loadFolders(); }
}

async function toggleFlag(ids = selectedIds()) {
  const ms = ids.map(msgById).filter(Boolean);
  if (!ms.length) return;
  const on = ms.some((m) => !m.flagged);
  const groups = groupsOf(ids);
  ms.forEach((m) => { m.flagged = on; updateRow(m.id); });
  noteFlag(ms, "flagged", on);
  updateSelectionClasses();
  if (state.conv) {
    for (const c of state.conv.cards.values()) if (ids.includes(c.m.id)) { c.m.flagged = on; if (c.d) c.d.flagged = on; }
    renderConvHeader(state.conv);
  }
  renderToolbar();
  try {
    await Promise.all(groups.map((g) => api.setFlag(g.account, g.folder, g.uids, "flagged", on)));
    settleFlag(ms);
  } catch (e) { settleFlag(ms, true); handleError(e); softRefreshList(); }
}

function printMessage() {
  const frame = (state.detail && cardEl(state.detail.id)?.querySelector(".msg-body iframe")) || readerFrames()[0];
  if (!frame) return;
  frame._pmLoadAll?.(); // make sure lazily-loaded pictures are in the printout
  setTimeout(() => frame.contentWindow?.print(), 700);
}

async function viewSource() {
  const d = state.detail;
  if (!d) return;
  try {
    const src = await api.rawSource(d.account, realFolder(d.folder), d.uid);
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" style="width:min(900px,90vw)"><h3>Message Source</h3><div class="raw-headers" style="max-height:65vh">${esc(src)}</div><div class="actions"><button class="btn primary">Done</button></div></div>`;
    back.querySelector("button").onclick = () => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && back.remove());
    document.body.appendChild(back);
  } catch (e) { handleError(e); }
}

/* ------------------------------------------------------------------ */
/* Search & filter                                                     */
/* ------------------------------------------------------------------ */
let searchTimer;
function setQuery(q) {
  $("search-clear").hidden = !q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (q.trim() === state.query) return;
    state.query = q.trim();
    state.selected.clear();
    closeReader();
    loadList();
  }, 450);
}
$("search").addEventListener("input", (e) => setQuery(e.target.value));
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("search").value = ""; setQuery(""); $("list").focus(); }
  if (e.key === "Enter") { clearTimeout(searchTimer); state.query = ""; setQuery($("search").value); }
  if (e.key === "ArrowDown") { e.preventDefault(); $("list").focus(); }
  e.stopPropagation();
});
$("search-clear").addEventListener("click", () => { $("search").value = ""; setQuery(""); });

/** Conversations switched on/off: list keys change, so reselect what was open. */
function conversationsChanged() {
  const open = state.conv?.order.find((id) => msgById(id));
  state.selected.clear();
  renderList({ animate: false });
  if (!open) return closeReader();
  const key = visibleKeys().find((k) => (k.startsWith("t:") ? threadByKey(k)?.members.some((m) => m.id === open) : k === open));
  if (key) selectOnly(key, { open: true, markSeen: false });
  else closeReader();
}

function setSort(order) {
  if (settings.sortOrder === order) return;
  saveSetting("sortOrder", order);
  state.selected.clear();
  closeReader();
  loadList();
}
function setFilter(f) {
  state.filter = f;
  state.selected.clear();
  closeReader();
  loadList();
}
$("btn-filter").addEventListener("click", (e) => {
  const f = state.filter;
  showMenu([
    { header: "Filter by" },
    { label: "All Messages", checked: f === "all", action: () => setFilter("all") },
    { label: "Unread", checked: f === "unread", action: () => setFilter("unread") },
    { label: "Flagged", checked: f === "flagged", action: () => setFilter("flagged") },
    { label: "Addressed to Me", checked: f === "toMe", action: () => setFilter("toMe") },
    { label: "With Attachments", checked: f === "attachments", action: () => setFilter("attachments") },
    { sep: true },
    { header: "Sort by" },
    { label: "Newest First", checked: !oldestFirst(), action: () => setSort("newest") },
    { label: "Oldest First", checked: oldestFirst(), action: () => setSort("oldest") },
    { sep: true },
    { label: "Group by Date", checked: settings.groupByDate, action: () => { saveSetting("groupByDate", !settings.groupByDate); renderList({ animate: false }); } },
    { label: "Show as Conversations", checked: settings.conversations, action: () => { saveSetting("conversations", !settings.conversations); conversationsChanged(); } },
  ], e.currentTarget.getBoundingClientRect(), { alignRight: true });
});
$("btn-compose").addEventListener("click", () => compose());

/* ------------------------------------------------------------------ */
/* Accounts menu & settings                                            */
/* ------------------------------------------------------------------ */
$("account-btn").addEventListener("click", (e) => {
  showMenu([
    ...state.accounts.map((a) => ({ header: `${acctLabel(a)} · ${a.email}${state.needsAuth.has(a.id) ? " · needs sign-in" : ""}` })),
    ...state.accounts.filter((a) => state.needsAuth.has(a.id)).map((a) => ({ label: multi() ? `Sign In Again: ${a.email}` : "Sign In Again…", icon: "person", cls: "alert", action: () => signInAgain(a.id) })),
    { label: "Add Account…", icon: "plus", action: addAccount },
    { label: "Settings…", icon: "gear", kbd: "Ctrl+,", action: openSettings },
    { label: "Manage VIPs…", icon: "vip", action: manageVips },
    { label: "Blocked Senders…", icon: "block", action: manageBlocked },
    { sep: true },
    ...(multi()
      ? state.accounts.map((a) => ({ label: `Sign Out ${a.email}…`, icon: "signOut", action: () => removeAccount(a.id) }))
      : [{ label: "Sign Out", icon: "signOut", action: () => removeAccount(state.accounts[0].id) }]),
  ], e.currentTarget.getBoundingClientRect(), {});
});

async function addAccount() {
  const { addAccountModal } = await loadAccountsUi();
  const acct = await addAccountModal();
  if (!acct) return;
  state.accounts.push(acct);
  toast(`${acct.email} added.`);
  paintAccount();
  await loadFolders(acct.id);
  renderSidebar();
  if (isUnified()) loadList();
  loadContactPhotos();
}

async function removeAccount(id) {
  const a = acctById(id);
  if (!a) return;
  const last = state.accounts.length === 1;
  const r = await dialog({
    title: last ? "Sign out of Mail?" : `Sign out of ${a.email}?`,
    message: "Its password or sign-in and the mail saved on this computer will be removed. Nothing is deleted from the server.",
    ok: "Sign Out",
    danger: !last,
  });
  if (!r) return;
  await commitPending();
  try { await api.removeAccount(id); } catch (e) { return handleError(e); }
  state.accounts = state.accounts.filter((x) => x.id !== id);
  const colors = { ...settings.accountColors };
  delete colors[id];
  saveSetting("accountColors", colors);
  state.needsAuth.delete(id);
  renderAuthBanners();
  delete state.folders[id];
  closeSettings();
  if (!state.accounts.length) {
    Object.assign(state, { folders: {}, messages: [], detail: null, conv: null, selected: new Set(), folder: U_INBOX });
    return showSignIn();
  }
  if (keyAcct() === id) state.folder = U_INBOX;
  state.messages = state.messages.filter((m) => m.account !== id);
  if (state.conv && [...state.conv.cards.values()][0]?.m.account === id) { state.conv = null; state.detail = null; }
  paintAccount();
  renderSidebar();
  renderReader();
  updateTitle();
  loadList();
}

function closeSettings() {
  document.querySelector(".modal.settings")?.closest(".modal-back")?.remove();
}

function accountsSettingsHtml() {
  return state.accounts.map((a) => `
    <div class="acct-row" data-acct="${esc(a.id)}">
      ${multi() ? `<span class="acct-grip" title="Drag to change the order">${icon("grip")}</span>` : ""}
      <span class="acct-dot" style="background:${acctColor(a.id)}"></span>
      <div class="acct-info"><input type="text" class="acct-name" value="${esc(a.name)}" placeholder="Account name" spellcheck="false" title="Account Name: what this account is called in Pear Mail">
        <input type="text" class="acct-sender" value="${esc(a.senderName || "")}" placeholder="Sender name (taken from your sent mail)" spellcheck="false" title="Sender Name: what people see when you email them. Leave blank to use the name from your sent mail.">
        <div class="acct-mail">${esc(a.email)} · ${esc(PROVIDER_NAMES[a.provider] || a.provider)}${a.auth !== "password" ? " · browser sign-in" : ""}</div></div>
      <button class="btn${state.needsAuth.has(a.id) ? " primary" : ""}" data-reauth="${esc(a.id)}">Sign In Again</button>
      <button class="btn" data-remove="${esc(a.id)}">Sign Out</button>
    </div>`).join("");
}

/** The per-message light/dark slider, drawn small and inert for the Settings hint. */
const hintSwitch = `<span class="theme-switch small on hint-switch" aria-hidden="true"><span class="ts-icon ts-sun">${icon("sun")}</span><span class="ts-icon ts-moon">${icon("moon")}</span><span class="knob"></span></span>`;

/** Fade a window's backdrop out while the window settles back down, then remove it. */
function dismissModal(back) {
  if (back._closing) return;
  back._closing = true;
  back.style.pointerEvents = "none";
  if (reduceMotion()) return back.remove();
  back.classList.add("closing");
  setTimeout(() => back.remove(), 200);
}

async function openSettings() {
  const radio = (name, opts, cur) =>
    `<div class="seg">${opts.map(([v, l]) => `<label class="${String(cur) === String(v) ? "on" : ""}"><input type="radio" name="${name}" value="${v}" ${String(cur) === String(v) ? "checked" : ""}>${l}</label>`).join("")}</div>`;
  const toggle = (name, label, cur, hint = "") =>
    `<label class="toggle-row"><span><span class="tl">${label}</span>${hint ? `<span class="th">${hint}</span>` : ""}</span><input type="checkbox" name="${name}" ${cur ? "checked" : ""}><span class="switch"></span></label>`;
  const back = document.createElement("div");
  back.className = "modal-back settings-back"; // opens with a rise, like the compose window
  back.innerHTML = `<div class="modal settings">
    <h3>Settings</h3>
    <div class="set-sec">Accounts</div>
    <div class="acct-list">${accountsSettingsHtml()}</div>
    <div class="set-row"><span></span><button class="btn" data-act="add-account">Add Account…</button></div>
    <div class="set-sec">Appearance</div>
    ${toggle("themeAuto", "Automatic", settings.theme === "system", "Follow the Windows light/dark setting.")}
    ${toggle("themeDark", "Dark Mode", darkActive())}
    ${toggle("darkMessages", "Dark mode for messages", settings.darkMessages, `Recolor emails to match dark mode, like Outlook. Use ${hintSwitch} on a message to see the original.`)}
    <div class="set-sec">Message List</div>
    <div class="set-row"><span>Preview</span>${radio("previewLines", [[0, "None"], [1, "1 line"], [2, "2 lines"]], settings.previewLines)}</div>
    ${toggle("groupByDate", "Group by date", settings.groupByDate)}
    ${toggle("conversations", "Show messages as conversations", settings.conversations)}
    ${toggle("listAvatars", "Show sender contact photos", settings.listAvatars)}
    <div class="set-sec">Reading</div>
    ${toggle("markReadOnOpen", "Mark messages as read when opened", settings.markReadOnOpen)}
    <div class="set-row"><span>Content from the web</span>${radio("remoteMode", [["always", "Always load"], ["trusted", "Trusted senders only"]], settings.remoteMode)}</div>
    <div class="set-row"><span>Text size</span>${radio("zoom", [[90, "Small"], [100, "Default"], [115, "Large"], [130, "Larger"]], settings.zoom)}</div>
    <div class="set-sec">Composing</div>
    <div class="set-row"><span>Undo Send delay</span>${radio("undoSendDelay", [[0, "Off"], [5, "5 s"], [10, "10 s"], [20, "20 s"], [30, "30 s"]], settings.undoSendDelay)}</div>
    <div class="set-col"><span>Signature</span><textarea name="signature" placeholder="e.g. Sent from Pear Mail">${esc(settings.signature)}</textarea></div>
    <div class="set-sec">Startup</div>
    ${toggle("openAtLogin", "Open Pear Mail when I sign in to Windows", false)}
    <div class="set-row startup-mode" hidden><span><span class="tl">Open in</span><span class="th">In the background, Pear Mail starts in the notification area and notifies you about new mail. This needs "Keep running in the background".</span></span>${radio("startupMode", [["window", "Window"], ["background", "Background"]], "window")}</div>
    <div class="set-sec">Notifications</div>
    ${toggle("notifications", "Notify me about new mail", settings.notifications, "Shown when Pear Mail isn't in the foreground.")}
    ${toggle("runInBackground", "Keep running in the background", settings.runInBackground, "When the window is closed, Pear Mail stays in the notification area and keeps notifying you. Right-click its icon to exit.")}
    <div class="set-sec">Updates</div>
    ${toggle("autoUpdate", "Check for updates automatically", settings.autoUpdate, "Once a day, from Pear Mail's GitHub releases. Updates are checked for a valid signature before they're installed.")}
    <div class="set-row"><span><span class="tl">Version</span><span class="th upd-version">Pear Mail</span></span><button class="btn" data-act="check-updates">Check Now</button></div>
    <div class="set-sec">Troubleshooting</div>
    <div class="set-row"><span><span class="tl">Diagnostic log</span><span class="th">If something isn't working, send this file to whoever gave you Pear Mail. It has no email content or passwords.</span></span><button class="btn" data-act="show-log">Show Log File</button></div>
    <div class="actions"><button class="btn" data-act="cancel">Cancel</button><span class="spacer"></span><button class="btn" data-act="save">Save</button><button class="btn primary" data-act="done">Done</button></div>
  </div>`;
  document.body.appendChild(back);
  applySettings(); // sync the Automatic / Dark Mode switches
  api.updateStatus().then((st) => { const v = back.querySelector(".upd-version"); if (v) v.textContent = `Pear Mail ${st.current}`; }).catch(() => {});
  // Open at sign-in lives in the Windows registry (the source of truth), not in settings.
  const startupEl = back.querySelector('[name="openAtLogin"]');
  const modeRow = back.querySelector(".startup-mode");
  const showStartup = (st) => {
    startupEl.checked = st.on;
    modeRow.hidden = !st.on;
    const mode = st.background ? "background" : "window";
    modeRow.querySelectorAll("input").forEach((i) => { i.checked = i.value === mode; i.closest("label").classList.toggle("on", i.checked); });
  };
  let startup = { on: false, background: false };
  let startupBefore = null;
  api.getOpenAtLogin().then((st) => { startup = st; startupBefore ??= { ...st }; showStartup(st); }).catch(() => {});
  const setStartup = async (st) => {
    try { await api.setOpenAtLogin(st.on, st.background); startup = st; } catch (e) { handleError(e); }
    showStartup(startup);
  };
  dragReorder(back.querySelector(".acct-list"), { item: ".acct-row", handle: ".acct-grip", idOf: (el) => el.dataset.acct, onDrop: (ids) => ids && reorderAccounts(ids, "settings") });
  // Text fields are saved by Save and Done (switches apply right away).
  const save = async () => {
    saveSetting("signature", back.querySelector('[name="signature"]').value);
    // Per-account names: what it's called here, and what people you email see.
    for (const row of back.querySelectorAll(".acct-row")) {
      const a = acctById(row.dataset.acct);
      if (!a) continue;
      const nameEl = row.querySelector(".acct-name");
      const name = nameEl.value.trim() || PROVIDER_NAMES[a.provider] || a.email.split("@")[1] || a.email;
      nameEl.value = name;
      if (name !== a.name) {
        try { await api.setDisplayName(a.id, name); a.name = name; } catch (e) { handleError(e); }
      }
      const sender = row.querySelector(".acct-sender").value.trim();
      if (sender !== (a.senderName || "")) {
        try { await api.setSenderName(a.id, sender); a.senderName = sender; } catch (e) { handleError(e); }
      }
    }
    paintAccount();
    renderSidebar();
  };
  const close = async () => {
    await save();
    dismissModal(back);
  };
  // Cancel: put back every setting this window changed (switches apply right away)
  // and drop unsaved text (signature, names). "Save" moves the starting point forward.
  let before = JSON.parse(JSON.stringify(settings));
  const cancel = () => {
    const changed = Object.keys(before).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(before[k]));
    for (const k of changed) if (k !== "theme") saveSetting(k, before[k]);
    if (changed.includes("theme")) setTheme(before.theme);
    if (startupBefore && (startupBefore.on !== startup.on || startupBefore.background !== startup.background)) setStartup(startupBefore);
    dismissModal(back);
    applySettings();
    if (changed.some((k) => ["groupByDate", "listAvatars", "previewLines"].includes(k))) renderList({ animate: false });
    if (changed.includes("conversations")) conversationsChanged();
    if (changed.includes("darkMessages")) updateReaderTheme(true);
    if (changed.some((k) => ["remoteMode", "zoom"].includes(k))) renderReader();
    if (changed.includes("runInBackground")) api.setRunInBackground(settings.runInBackground).catch(() => {});
  };
  back.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) return removeAccount(rm.dataset.remove);
    if (e.target.closest('[data-act="add-account"]')) { close().then(addAccount); }
    if (e.target.closest('[data-act="show-log"]')) api.showLogFile().catch(handleError);
    const chk = e.target.closest('[data-act="check-updates"]');
    if (chk && !chk.disabled) {
      chk.disabled = true;
      chk.textContent = "Checking…";
      checkForUpdates(true).finally(() => { chk.disabled = false; chk.textContent = "Check Now"; });
    }
  });
  const setRunInBackgroundSwitch = (on) => {
    const el = back.querySelector('[name="runInBackground"]');
    el.checked = on;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  back.addEventListener("change", (e) => {
    const t = e.target;
    // Let the switch finish sliding, then crossfade the app.
    if (t.name === "themeAuto") { setTheme(t.checked ? "system" : document.documentElement.classList.contains("is-dark") ? "dark" : "light", 240); return; }
    if (t.name === "themeDark") { setTheme(t.checked ? "dark" : "light", 240); return; }
    if (t.name === "openAtLogin") { setStartup({ on: t.checked, background: t.checked && startup.background && settings.runInBackground }); return; }
    if (t.name === "startupMode") {
      const background = t.value === "background";
      // Background needs the tray icon, or Pear Mail would run with no way to open it.
      if (background && !settings.runInBackground) setRunInBackgroundSwitch(true);
      setStartup({ on: true, background });
      return;
    }
    if (!t.name || ["signature", "msId", "gId", "gSecret"].includes(t.name) || t.classList.contains("acct-name")) return;
    let val = t.type === "checkbox" ? t.checked : t.value;
    if (["previewLines", "zoom", "undoSendDelay"].includes(t.name)) val = Number(val);
    saveSetting(t.name, val);
    if (t.type === "radio") t.closest(".seg").querySelectorAll("label").forEach((l) => l.classList.toggle("on", l.contains(t)));
    applySettings();
    if (["groupByDate", "listAvatars"].includes(t.name)) renderList({ animate: false });
    if (t.name === "conversations") conversationsChanged();
    if (t.name === "darkMessages") updateReaderTheme(true);
    if (["remoteMode", "zoom"].includes(t.name)) renderReader();
    if (t.name === "notifications" && val) notify("Pear Mail", "Notifications are on.");
    if (t.name === "runInBackground") {
      api.setRunInBackground(val).catch(handleError);
      if (val) saveSetting("trayNoticeShown", false);
      // Without the tray icon a background start would be invisible: open in the window instead.
      if (!val && startup.on && startup.background) {
        setStartup({ on: true, background: false });
        toast("Pear Mail will now open in a window when you sign in.");
      }
    }
  });
  back.querySelector('[data-act="done"]').onclick = close;
  back.querySelector('[data-act="save"]').onclick = () => save().then(() => { before = JSON.parse(JSON.stringify(settings)); startupBefore = { ...startup }; toast("Settings saved."); });
  back.querySelector('[data-act="cancel"]').onclick = cancel;
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") cancel(); });
}

async function manageVips() {
  const r = await dialog({ title: "VIPs", message: "One email address per line. Messages from VIPs appear in the VIP mailbox.", fields: [{ id: "v", multiline: true, value: vips().join("\n") }], ok: "Save" });
  if (!r) return;
  store.set("vips", r.v.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@")));
  vipsChanged();
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */
document.addEventListener("keydown", (e) => {
  if ($("app").hidden || (composeOpen() && e.target.closest?.(".compose"))) return;
  if (document.querySelector(".modal-back") || isMenuOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (ctrl && k === "n") { e.preventDefault(); compose(); return; }
  if (ctrl && k === "f") { e.preventDefault(); $("search").focus(); $("search").select(); return; }
  if (ctrl && k === ",") { e.preventDefault(); openSettings(); return; }
  if (ctrl && (k === "=" || k === "+")) { e.preventDefault(); setZoom(settings.zoom + 10); return; }
  if (ctrl && k === "-") { e.preventDefault(); setZoom(settings.zoom - 10); return; }
  if (ctrl && k === "0") { e.preventDefault(); setZoom(100); return; }
  if (ctrl && k === "p") { e.preventDefault(); printMessage(); return; }
  if (k === "f5") { e.preventDefault(); refreshAll(true); return; }
  if (typing) return;
  // In Drafts, shortcuts match the draft menus: no replying, read/unread, junk or archive.
  if (inDrafts() && ((ctrl && (k === "r" || (e.shiftKey && (k === "f" || k === "u" || k === "j")))) || (!ctrl && k === "e"))) {
    e.preventDefault();
    return;
  }
  if (ctrl && e.shiftKey && k === "r") { e.preventDefault(); reply("replyAll"); return; }
  if (ctrl && k === "r") { e.preventDefault(); reply("reply"); return; }
  if (ctrl && e.shiftKey && k === "f") { e.preventDefault(); reply("forward"); return; }
  if (ctrl && e.shiftKey && k === "u") { e.preventDefault(); toggleSeen(); return; }
  if (ctrl && e.shiftKey && k === "l") { e.preventDefault(); toggleFlag(); return; }
  if (ctrl && e.shiftKey && k === "n") { e.preventDefault(); refreshAll(true); return; }
  if (ctrl && e.shiftKey && k === "j") {
    e.preventDefault();
    const ids = selectedIds();
    const allJunk = ids.length > 0 && ids.every((id) => msgById(id) && messageRole(msgById(id)) === "junk");
    moveToRole(ids, allJunk ? "inbox" : "junk");
    return;
  }
  if (ctrl && k === "z") { e.preventDefault(); document.querySelector(".toast button")?.click(); return; }
  if (ctrl && k === "a") {
    e.preventDefault();
    state.selected = new Set(visibleKeys());
    updateSelectionClasses();
    afterSelectionChange();
    return;
  }
  if (!ctrl && k === "e") { e.preventDefault(); archiveSelected(); return; }
  if (k === "delete" || k === "backspace") { e.preventDefault(); deleteMessages(); return; }
  if (k === "arrowdown" || k === "arrowup") {
    e.preventDefault();
    const ids = visibleKeys();
    if (!ids.length) return;
    const cur = state.anchor != null ? ids.indexOf(state.anchor) : -1;
    const next = Math.max(0, Math.min(ids.length - 1, cur + (k === "arrowdown" ? 1 : -1)));
    if (e.shiftKey && cur >= 0) {
      state.selected.add(ids[next]);
      state.anchor = ids[next];
      updateSelectionClasses();
      afterSelectionChange();
    } else if (next !== cur || state.selected.size !== 1) selectOnly(ids[next], { open: true });
    $("list").focus();
    if (next >= ids.length - 5) loadMore();
    return;
  }
  if (k === "enter" && currentRole() === "drafts") editDraft();
});

/* ------------------------------------------------------------------ */
/* List pane resizing                                                  */
/* ------------------------------------------------------------------ */
$("list-resizer").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startX = e.clientX, startW = $("list-pane").offsetWidth;
  const move = (ev) => {
    settings.listWidth = Math.max(280, Math.min(640, startW + ev.clientX - startX));
    applySettings();
  };
  const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); store.set("listWidth", settings.listWidth); };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

/* ------------------------------------------------------------------ */
/* Refresh / live updates / notifications / errors                     */
/* ------------------------------------------------------------------ */
/* ---- "Downloading Messages – 14 of 231" ------------------------------------
 * The app reports every download of new messages (list rows, Sent sync, bodies) as one running
 * count. The card only appears for a real batch (10+) that's still going after a moment, so
 * routine refreshes never flash it.
 */
const dl = { el: null, showTimer: null, hideTimer: null, last: { done: 0, total: 0 } };
function renderDownload() {
  const { done, total } = dl.last;
  if (!dl.el) return;
  dl.el.classList.toggle("above", !!document.querySelector(".send-pending:not(.dl-progress):not(.leaving)"));
  dl.el.querySelector(".sp-count").textContent = `${Math.min(done, total).toLocaleString()} of ${total.toLocaleString()}`;
  dl.el.querySelector(".sp-progress div").style.transform = `scaleX(${total ? Math.min(1, done / total) : 1})`;
}
listen("download-progress", (e) => {
  const { done, total } = e.payload;
  if (total === 0) {
    // All done: fill the bar, then let it go.
    clearTimeout(dl.showTimer);
    dl.showTimer = null;
    if (dl.el && !dl.hideTimer) {
      dl.last = { done: dl.last.total, total: dl.last.total };
      renderDownload();
      const el = dl.el;
      dl.hideTimer = setTimeout(() => {
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 180);
        if (dl.el === el) dl.el = null;
        dl.hideTimer = null;
      }, 400);
    }
    return;
  }
  dl.last = { done, total };
  if (dl.el) {
    // A new batch started while the card was on its way out: keep it.
    if (dl.hideTimer) { clearTimeout(dl.hideTimer); dl.hideTimer = null; }
    renderDownload();
    return;
  }
  if (total < 10 || dl.showTimer) return;
  dl.showTimer = setTimeout(() => {
    dl.showTimer = null;
    if (dl.el || dl.last.total < 10) return;
    const el = document.createElement("div");
    el.className = "send-pending dl-progress";
    el.innerHTML = `<div class="sp-row">${icon("download")}<span class="sp-label">Downloading Messages</span><span class="sp-count"></span></div><div class="sp-progress"><div></div></div>`;
    document.body.appendChild(el);
    dl.el = el;
    renderDownload();
  }, 400);
});

/* ---- Pull to refresh -------------------------------------------------------
 * At the top of the list, keep scrolling up (trackpad swipe or mouse wheel) or drag down
 * (touch): the list slides down behind an arrow, which flips once it's far enough, and
 * refreshes. A wheel pull only starts with a fresh gesture made at the top (after a short
 * pause), so the momentum of scrolling up to the top never refreshes by itself.
 */
{
  const list = $("list"), ind = $("pull-ind");
  ind.querySelector(".pull-arrow").innerHTML = icon("arrowUp");
  const THRESHOLD = 70, MAX = 96, HOLD = 44;
  let pull = 0, busy = false, lastWheel = 0, idleTimer = null, cooldownUntil = 0;
  const show = (h, settle = false) => {
    ind.classList.toggle("settling", settle);
    ind.style.height = `${h}px`;
    ind.classList.toggle("armed", h >= THRESHOLD && !busy);
  };
  const reset = () => { pull = 0; if (!busy) show(0, true); };
  async function fire() {
    busy = true;
    pull = 0;
    cooldownUntil = Date.now() + 1200;
    ind.classList.remove("armed");
    ind.classList.add("loading");
    show(HOLD, true);
    try { await refreshAll(true); } finally {
      busy = false;
      ind.classList.remove("loading");
      show(0, true);
    }
  }
  // Rubber-band feel: the further it goes, the less each bit of pull moves it.
  const eased = (p) => Math.min(MAX, p * (1 - Math.min(p, 200) / 600));
  list.addEventListener("wheel", (e) => {
    const now = Date.now();
    const gap = now - lastWheel;
    lastWheel = now;
    if (busy || now < cooldownUntil || e.ctrlKey) return;
    if (list.scrollTop > 0) { if (pull) reset(); return; }
    // Pixels moved; a mouse notch counts for ~a third of the way (about 3 notches refresh).
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!pull && (dy >= 0 || gap < 150)) return;
    // Scrolling up pulls further (capped per event, so one big flick isn't a whole pull);
    // scrolling back down takes the pull back.
    pull = Math.max(0, dy < 0 ? pull + Math.min(-dy, 34) : pull - Math.min(dy, 60));
    if (pull <= 0) { reset(); return; }
    const h = eased(pull);
    show(h);
    clearTimeout(idleTimer);
    // Let go (no more scrolling for a moment): refresh if it went far enough.
    idleTimer = setTimeout(() => { if (eased(pull) >= THRESHOLD) fire(); else reset(); }, 220);
  }, { passive: true });

  let touchY = null;
  list.addEventListener("touchstart", (e) => {
    touchY = !busy && list.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  list.addEventListener("touchmove", (e) => {
    if (touchY === null) return;
    const dy = e.touches[0].clientY - touchY;
    if (dy <= 0 || list.scrollTop > 0) { pull = 0; show(0); return; }
    pull = dy * 0.6;
    show(eased(pull));
  }, { passive: true });
  const touchEnd = () => {
    if (touchY === null) return;
    touchY = null;
    if (eased(pull) >= THRESHOLD) fire(); else reset();
  };
  list.addEventListener("touchend", touchEnd);
  list.addEventListener("touchcancel", touchEnd);
}

let refreshing = false;
/** Settle within `ms` no matter what (a stuck network call must not block refreshing). */
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms))]);

let refreshStarted = 0;
async function refreshAll(manual = false, force = false) {
  if (!state.accounts.length) return;
  // A refresh normally takes seconds. If one has been going for over a minute it's stuck
  // (dead connection): start a new one instead of skipping every refresh from now on.
  if (refreshing && !manual && !force && Date.now() - refreshStarted < 60000) return;
  if (refreshing) api.logEvent("refresh", `previous refresh still running after ${Math.round((Date.now() - refreshStarted) / 1000)} s`);
  const run = ++refreshRun;
  refreshing = true;
  refreshStarted = Date.now();
  const btn = $("btn-refresh");
  if (manual) startSpin(btn);
  try {
    const jobs = [withTimeout(loadFolders(), 45000, "folders"), withTimeout(softRefreshList(), 45000, "message list")];
    // New-mail checks for inboxes that aren't on screen.
    const shown = new Set(currentRole() === "inbox" ? sourcesFor().map((s) => s.account) : []);
    for (const a of state.accounts) {
      if (!shown.has(a.id)) jobs.push(withTimeout(api.messages(a.id, "INBOX", { limit: 20 }), 45000, "inbox check").then((p) => checkNewMail(p.messages)));
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") api.logEvent("refresh", errText(r.reason));
  } finally {
    if (run === refreshRun) {
      refreshing = false;
      stopSpin(btn);
    }
  }
}
let refreshRun = 0;

/* The refresh icon never snaps back mid-turn: when the refresh ends it finishes the turn it's
 * on, then makes one more that slows to a stop upright. */
let spinStop = null; // cancels a pending stop when a new refresh starts
function startSpin(btn) {
  spinStop?.abort();
  spinStop = null;
  btn.classList.remove("spin-out");
  btn.classList.add("spinning");
}
function stopSpin(btn) {
  if (!btn.classList.contains("spinning")) return;
  spinStop?.abort();
  const ctl = (spinStop = new AbortController());
  const icon = btn.querySelector(".icon");
  const done = () => {
    if (ctl.signal.aborted) return;
    ctl.abort();
    btn.classList.remove("spinning", "spin-out");
    if (spinStop === ctl) spinStop = null;
  };
  // Hidden button or no animation: no events will come.
  let fallback = setTimeout(done, 1500);
  ctl.signal.addEventListener("abort", () => clearTimeout(fallback));
  if (!icon || reduceMotion()) return done();
  // A turn just completed (the icon is upright again): glide through one last, slowing turn.
  icon.addEventListener("animationiteration", () => {
    if (ctl.signal.aborted) return;
    clearTimeout(fallback);
    fallback = setTimeout(done, 2000);
    btn.classList.replace("spinning", "spin-out");
    icon.addEventListener("animationend", done, { once: true, signal: ctl.signal });
  }, { once: true, signal: ctl.signal });
}

// After sleep or a network change the open connections are dead: reconnect and refresh.
let lastWake = 0;
function reconnect(reason) {
  if (!state.accounts.length || Date.now() - lastWake < 5000) return;
  lastWake = Date.now();
  api.logEvent("wake", reason);
  api.restartWatchers(reason).catch(() => {}).finally(() => refreshAll(false, true));
}
window.addEventListener("online", () => reconnect("network back online"));
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  // Timers stop while the PC sleeps, so a big gap means it just woke up.
  if (now - lastTick > 90000) reconnect(`resumed after ${Math.round((now - lastTick) / 1000)} s`);
  lastTick = now;
}, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

// UI errors go to the diagnostic log too (Settings → Show Log File).
window.addEventListener("error", (e) => api.logEvent("error", `${e.message} at ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => api.logEvent("error", errText(e.reason)));

/** A new-mail notification was clicked: show that message (or that inbox). */
async function openFromNotification(t) {
  if (!t?.account || !acctById(t.account)) return;
  // An inbox that contains the account: the current one if it does, else All Inboxes / its Inbox.
  const showing = currentRole() === "inbox" && (isUnified() || keyAcct() === t.account);
  if (!showing || state.query || state.filter !== "all") {
    const inbox = byRole("inbox", t.account)?.path || "INBOX";
    await selectFolder(multi() ? U_INBOX : fkey(t.account, inbox));
  }
  if (!t.id) return;
  if (!msgById(t.id)) await softRefreshList();
  const entry = listEntries({ includeCollapsedGroups: true }).find((e) => e.ids.includes(t.id));
  if (!entry) return;
  if (entry.hidden) { state.collapsedGroups.delete(entry.group); renderList({ animate: false }); }
  selectOnly(entry.key);
}
listen("notification-clicked", (e) => openFromNotification(e.payload));

/** Notify about unseen inbox messages newer than the last ones we saw (per account). */
function checkNewMail(inboxMsgs) {
  // Every account's inbox passes through here on each check: move blocked senders' mail away
  // (also for inboxes that aren't on screen), and never notify about it.
  sweepBlocked(inboxMsgs);
  inboxMsgs = inboxMsgs.filter((m) => !isBlockedPerson(m.from));
  const byAcct = new Map();
  for (const m of inboxMsgs) {
    if (realFolder(m.folder) !== "INBOX") continue;
    if (!byAcct.has(m.account)) byAcct.set(m.account, []);
    byAcct.get(m.account).push(m);
  }
  for (const [acct, msgs] of byAcct) {
    const a = acctById(acct);
    if (!a) continue;
    // Keyed by email so the single-account version's marker is reused.
    const key = "lastInboxUid:" + a.email;
    const last = store.get(key, null);
    const max = Math.max(0, ...msgs.map((m) => m.uid));
    if (last === null || max > last) store.set(key, Math.max(max, last ?? 0));
    if (last === null || !settings.notifications || document.hasFocus()) continue;
    const fresh = msgs.filter((m) => m.uid > last && !m.seen);
    if (!fresh.length) continue;
    const suffix = multi() ? ` – ${acctLabel(a)}` : "";
    if (fresh.length === 1) notify(displayName(fresh[0].from) + suffix, `${fresh[0].subject || "(No Subject)"}\n${fresh[0].preview}`.slice(0, 200), { account: acct, id: fresh[0].id });
    else notify(`${fresh.length} new messages${suffix}`, fresh.slice(0, 3).map((m) => `${displayName(m.from)}: ${m.subject}`).join("\n"), { account: acct });
  }
}

let changeTimer;
// Contact photos refreshed from iCloud Contacts.
listen("accounts-updated", async () => {
  let fresh;
  try { fresh = await api.listAccounts(); } catch { return; }
  for (const f of fresh) {
    const a = acctById(f.id);
    if (!a) continue;
    a.senderName = f.senderName;
    const input = document.querySelector(`.settings .acct-row[data-acct="${CSS.escape(f.id)}"] .acct-sender`);
    if (input && !input.value && document.activeElement !== input) input.value = f.senderName || "";
  }
  paintAccount();
});

listen("contacts-updated", async () => {
  await loadContactPhotos();
  if (!state.accounts.length) return;
  renderList();
  paintAccount();
  const conv = state.conv;
  if (conv) for (const id of conv.order) {
    const m = conv.cards.get(id).m;
    cardEl(id)?.querySelectorAll(".msg-head > .avatar, .cc-head > .avatar").forEach((a) => (a.outerHTML = avatarHtml(m.from)));
  }
});

listen("mail-changed", () => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => refreshAll(), 800);
});
setInterval(() => refreshAll(), 120000);
window.addEventListener("focus", () => refreshAll());

// Make sure a pending (undoable) move/delete is applied before the window closes.
try {
  appWindow().onCloseRequested(async (event) => {
    const outbox = composeMod?.hasPendingSend?.();
    // "Keep running in the background": hide to the notification area instead of quitting.
    if (settings.runInBackground) {
      event.preventDefault();
      appWindow().hide();
      if (!settings.trayNoticeShown) {
        saveSetting("trayNoticeShown", true);
        notify("Pear Mail is running in the background", "To exit, right-click its icon in the tray.");
      }
      if (undoStack.length) commitPending();
      return;
    }
    if (!undoStack.length && !outbox) return;
    event.preventDefault();
    await commitPending();
    await composeMod?.flushPendingSend?.();
    appWindow().destroy();
  });
} catch {}

function setOffline(on) {
  if (state.offline === on) return;
  state.offline = on;
  renderListHeader();
}

function handleError(e, quiet = false) {
  const msg = errText(e);
  const auth = msg.match(/password for (\S+) is incorrect|(\S+) needs to be signed in again/i);
  if (auth) {
    // One account's sign-in stopped working: flag it (banner + sidebar), offer one-click sign-in.
    const email = (auth[1] || auth[2] || "").replace(/[.,]+$/, "").toLowerCase();
    const a = state.accounts.find((x) => x.email.toLowerCase() === email);
    if (a) markNeedsAuth(a.id);
    else toast(msg, { error: true });
    return;
  }
  if (/Could not reach|not responding|internet|Timed out|connection/i.test(msg)) {
    setOffline(true);
    if (quiet) return;
  }
  if (!quiet) toast(msg, { error: true });
}

// Block the WebView's default context menu except in text fields.
document.addEventListener("contextmenu", (e) => {
  if (!e.defaultPrevented && !/INPUT|TEXTAREA/.test(e.target.tagName) && !e.target.isContentEditable) e.preventDefault();
});

boot();

/* ------------------------------------------------------------------ */
/* Attachment tiles                                                    */
/* ------------------------------------------------------------------ */
/** Rough file family, for the colour of a file's badge. */
function fileFamily(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (/^(docx?|rtf|odt|pages)$/.test(ext)) return "doc";
  if (/^(xlsx?|ods|numbers)$/.test(ext)) return "sheet";
  if (/^(pptx?|odp|key)$/.test(ext)) return "slides";
  if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return "archive";
  return "file";
}

function attachmentsHtml(d) {
  // While only the start of a big email is downloaded, attachments are shown once complete.
  if (d.partial || !d.attachments.length) return "";
  const tile = (a) =>
    isImage(a) || previewKind(a) === "pdf"
      ? `<div class="att image${previewKind(a) === "pdf" ? " pdf previewable" : ""}" data-idx="${a.index}" title="${esc(a.name)}"><div class="thumb">${icon(previewKind(a) === "pdf" ? "doc" : "photo")}</div><div class="info"><div class="n">${esc(a.name)}</div><div class="s">${(a.name.split(".").pop() || "").toUpperCase()} · ${fileSize(a.size)}</div></div><span class="dl" data-save="${a.index}" title="Save">${icon("download")}</span></div>`
      : `<div class="att${canPreview(a) ? " previewable" : ""} type-${esc(previewKind(a) === "none" ? fileFamily(a.name) : previewKind(a))}" data-idx="${a.index}" title="${canPreview(a) ? "Click to preview" : "Click to open"}, right-click for more"><div class="ficon">${esc((a.name.split(".").pop() || "").slice(0, 4))}</div><div class="info"><div class="n">${esc(a.name)}</div><div class="s">${fileSize(a.size)}</div></div><span class="dl" data-save="${a.index}" title="Save">${icon("download")}</span></div>`;
  const saveAll = d.attachments.length > 1 ? `<button class="mini-btn labeled save-all">${icon("download")}<span>Save all</span></button>` : "";
  return `<div class="attachments">${d.attachments.map(tile).join("")}${saveAll}</div>`;
}

function bindAttachments(box, d) {
  box.querySelector(".attachments .save-all")?.addEventListener("click", async () => {
    let n = 0;
    for (const a of d.attachments) { try { if (await api.saveAttachment(d.account, d.folder, d.uid, a.index)) n++; } catch (e) { handleError(e); break; } }
    if (n) toast(`Saved ${n} attachment${n === 1 ? "" : "s"}.`);
  });
  box.querySelectorAll(".attachments .att").forEach((el) => {
    const idx = +el.dataset.idx;
    el.addEventListener("click", async (e) => {
      try {
        if (e.target.closest("[data-save]")) {
          if (await api.saveAttachment(d.account, d.folder, d.uid, idx)) toast("Attachment saved.");
        } else if (el.classList.contains("image") || el.classList.contains("previewable")) {
          openPreview(d, idx);
        } else await api.openAttachment(d.account, d.folder, d.uid, idx);
      } catch (err) { handleError(err); }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const img = el.classList.contains("image") && !el.classList.contains("pdf");
      const pv = img || el.classList.contains("previewable");
      showMenu([
        ...(pv ? [{ label: "Preview", icon: img ? "photo" : undefined, action: () => openPreview(d, idx) }] : []),
        { label: "Open", action: () => api.openAttachment(d.account, d.folder, d.uid, idx).catch(handleError) },
        { label: "Save As…", icon: "download", action: () => api.saveAttachment(d.account, d.folder, d.uid, idx).then((ok) => ok && toast("Attachment saved.")).catch(handleError) },
        ...(img ? [{ label: "Save as PNG…", action: () => api.saveAttachmentPng(d.account, d.folder, d.uid, idx).then((ok) => ok && toast("Image saved as PNG.")).catch(handleError) }] : []),
      ], { x: e.clientX, y: e.clientY });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Message light/dark, switched in place (no reload, no layout shift)   */
/* ------------------------------------------------------------------ */
/**
 * A message shown light in a dark app (or dark in a light app) gets the whole card in
 * that look — headers, buttons and all — not just the email itself.
 */
function cardThemeClass(d) {
  // A summary (collapsed card) has no body yet: plain if seen to be before, else HTML.
  if (!d || (d.html !== undefined ? isPlain(d) : state.plainKeys.has(msgKey(d)))) return "";
  const adapted = messageAdapted(d);
  if (isDark() && !adapted) return "card-light";
  if (!isDark() && adapted) return "card-dark";
  return "";
}

function messageAdapted(d) {
  if (!d || (d.html !== undefined && isPlain(d))) return false;
  const k = msgKey(d);
  if (!isDark()) return state.darkInLight.has(k);
  return settings.darkMessages ? !state.lightOverride.has(k) : state.darkOverride.has(k);
}

/** Colors inside the message frame. HTML mail keeps its own (light) canvas; plain text follows the app. */
function messageThemeCss(plain) {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return plain
    ? `html{background:transparent;}body{color:${v("--text")};}a{color:${v("--accent")};}
       blockquote[type=cite]{margin:8px 0 0 4px;padding-left:10px;border-left:2px solid ${v("--quote")};color:${v("--text-2")};}
       .pm-quote{color:${v("--text-2")};}`
    : `html{background:#fff;}body{color:#1d1d1f;}a{color:#0066cc;}
       blockquote[type=cite]{margin:8px 0 0 4px;padding-left:10px;border-left:2px solid #0071e3;color:#6e6e73;}`;
}

let darkModCache = null;

/** Recolor the open message for dark mode (or restore its original look) in place. */
async function applyMessageTheme(frame, adapted, animate) {
  const doc = frame?.contentDocument;
  if (!doc?.body) return;
  if (animate) {
    // Fade colors instead of snapping.
    let s = doc.getElementById("pm-anim");
    if (!s) {
      s = doc.createElement("style");
      s.id = "pm-anim";
      s.textContent = "*,*::before,*::after{transition:background-color .35s ease,color .35s ease,border-color .35s ease !important;}";
      doc.head.appendChild(s);
    }
    clearTimeout(frame._animT);
    frame._animT = setTimeout(() => s.remove(), 450);
  }
  const sheet = doc.getElementById("pm-theme");
  if (sheet) sheet.textContent = messageThemeCss(frame._plain);
  if (frame._plain) return;
  frame.classList.toggle("dark-in-light", adapted && !isDark());
  if (adapted && !frame._undoDark) {
    if (!darkModCache) darkModCache = await loadDark();
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    // In a light app the message still goes dark: use the dark theme's card colors.
    const theme = isDark() ? { bg: v("--card-bg"), text: v("--text") } : { bg: "#2a2a2c", text: "#f5f5f7" };
    try { frame._undoDark = darkModCache.adaptDark(doc, theme); } catch (e) { console.warn(e); }
  } else if (!adapted && frame._undoDark) {
    frame._undoDark();
    frame._undoDark = null;
  }
}

/** Bring the open message (and its slider) in line with the current theme settings. */
async function updateReaderTheme(animate) {
  const conv = state.conv;
  if (!conv) return;
  // Every card, collapsed ones too, takes its message's light/dark look.
  for (const id of conv.order) {
    const c = conv.cards.get(id), el = cardEl(id);
    if (!el) continue;
    setCardLook(el, cardThemeClass(c.d || c.m), animate);
  }
  await Promise.all(conv.order.map((id) => {
    const d = conv.cards.get(id).d;
    const el = cardEl(id);
    const frame = el?.querySelector(".msg-body iframe");
    if (!d || !frame) return null;
    const adapted = messageAdapted(d);
    const sw = el.querySelector(".hd-light");
    if (sw) { sw.classList.toggle("on", adapted); sw.setAttribute("aria-checked", String(adapted)); }
    setCardLook(el, cardThemeClass(d), animate);
    return applyMessageTheme(frame, adapted, animate);
  }));
}

/** Give a card its light/dark look; when animating, its contents (attachment tiles, text)
 *  crossfade along with the card itself. */
function setCardLook(el, look, animate) {
  const cur = el.classList.contains("card-light") ? "card-light" : el.classList.contains("card-dark") ? "card-dark" : "";
  if (cur === (look || "")) return;
  if (animate) {
    el.classList.add("theme-anim");
    clearTimeout(el._themeAnim);
    el._themeAnim = setTimeout(() => el.classList.remove("theme-anim"), 450);
  }
  el.classList.toggle("card-light", look === "card-light");
  el.classList.toggle("card-dark", look === "card-dark");
}

/* ------------------------------------------------------------------ */
/* Re-sign-in (password changed, app password revoked, token expired)  */
/* ------------------------------------------------------------------ */
function markNeedsAuth(id) {
  const a = acctById(id);
  if (!a || state.needsAuth.has(id)) return;
  state.needsAuth.add(id);
  renderAuthBanners();
  renderSidebar();
  paintAccount();
  toast(`${a.email} needs you to sign in again.`, { error: true, duration: 8000, action: { label: "Sign In", run: () => signInAgain(id) } });
}

/**
 * Show exactly `items` ([{ key, html }]) in a banner host. New banners grow into place and
 * departing ones shrink away (like a sidebar section); banners already shown are updated in
 * place without replaying their animation.
 */
function syncBanners(host, items) {
  const want = new Map(items.map((i) => [i.key, i.html]));
  const now = new Map([...host.children].filter((w) => !w.classList.contains("leaving")).map((w) => [w.dataset.key, w]));
  for (const [key, w] of now) {
    if (want.has(key)) continue;
    if (reduceMotion()) { w.remove(); continue; }
    w.classList.add("leaving");
    w.classList.remove("open");
    const done = () => w.remove();
    w.addEventListener("transitionend", (e) => e.target === w && e.propertyName === "grid-template-rows" && done());
    setTimeout(done, 400);
  }
  for (const [key, html] of want) {
    const w = now.get(key);
    if (w) {
      if (w._html !== html) { w.firstElementChild.innerHTML = html; w._html = html; }
      continue;
    }
    const nw = document.createElement("div");
    nw.className = "banner-wrap";
    nw.dataset.key = key;
    nw.innerHTML = `<div class="banner-inner">${html}</div>`;
    nw._html = html;
    host.appendChild(nw);
    if (reduceMotion()) nw.classList.add("open");
    else { void nw.offsetHeight; requestAnimationFrame(() => nw.classList.add("open")); }
  }
}

function renderAuthBanners() {
  const list = [...state.needsAuth].map(acctById).filter(Boolean);
  syncBanners(
    $("auth-banners"),
    list.map((a) => ({
      key: a.id,
      html: `<div class="auth-banner"><div class="ab-icon">${icon("person")}</div><div class="ab-text"><div class="ab-title">Sign in to keep getting mail</div><div class="ab-sub" title="${esc(a.email)}">${esc(a.email)}</div></div><button data-reauth="${esc(a.id)}">Sign In</button></div>`,
    })),
  );
}

let reauthBusy = false;
async function signInAgain(id) {
  const a = acctById(id);
  if (!a || reauthBusy) return;
  reauthBusy = true;
  try {
    const { reauthAccount } = await loadAccountsUi();
    if (a.auth !== "password") toast("Finish signing in in your browser…", { duration: 10000 });
    const info = await reauthAccount(a);
    if (!info) return; // cancelled
    Object.assign(a, info);
    state.needsAuth.delete(id);
    renderAuthBanners();
    renderSidebar();
    paintAccount();
    document.querySelectorAll(`.settings [data-reauth="${CSS.escape(id)}"]`).forEach((b) => b.classList.remove("primary"));
    toast(`Signed in to ${a.email}.`);
    await loadFolders(id);
    refreshAll();
  } catch (e) {
    toast(errText(e), { error: true, duration: 8000 });
  } finally {
    reauthBusy = false;
  }
}

// "Sign In" buttons: banners, sidebar warnings, Settings rows.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-reauth]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  signInAgain(b.dataset.reauth);
}, true);

// The background new-mail watcher found that an account's sign-in no longer works.
listen("auth-required", (e) => markNeedsAuth(e.payload));

// ===== Updates (from GitHub releases; the app verifies the signature) =====
let updateChecking = null;
function checkForUpdates(manual = false) {
  if (updateChecking) return updateChecking;
  updateChecking = (async () => {
    try {
      const st = await api.checkForUpdate();
      renderUpdateBanner(st);
      if (manual && !st.ready) toast(`Pear Mail ${st.current} is up to date.`);
      if (manual && st.ready) toast(`Pear Mail ${st.ready.version} is ready to install.`);
    } catch (e) {
      if (manual) toast(errText(e), { error: true });
    } finally {
      updateChecking = null;
    }
  })();
  return updateChecking;
}

function renderUpdateBanner(st) {
  const host = $("update-banner");
  const r = st?.ready;
  if (!r) return syncBanners(host, []);
  const btn = st.canApply ? `<button data-upd="restart">Restart</button>` : `<button data-upd="download">Download</button>`;
  const sub = st.canApply ? `<a data-upd="notes">What's new</a>` : `Can't update this copy in place. <a data-upd="notes">Download it</a>`;
  host.dataset.notes = r.notesUrl;
  syncBanners(host, [{ key: "update", html: `<div class="auth-banner update"><div class="ab-icon">${icon("download")}</div><div class="ab-text"><div class="ab-title">Pear Mail ${esc(r.version)} is ready</div><div class="ab-sub">${sub}</div></div>${btn}</div>` }]);
}

$("update-banner").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-upd]")?.dataset.upd;
  if (!act) return;
  e.preventDefault();
  if (act === "notes" || act === "download") return openUrl($("update-banner").dataset.notes);
  if (composeOpen()) return toast("Send or close the message you're writing, then restart to update.", { duration: 6000 });
  try {
    // Like quitting: apply pending moves/deletes and send anything waiting in the outbox.
    if (undoStack.length) await commitPending();
    await composeMod?.flushPendingSend?.();
    await api.restartToUpdate();
  } catch (err) {
    toast(errText(err), { error: true, duration: 8000 });
  }
});

setTimeout(() => { if (settings.autoUpdate) checkForUpdates(); }, 30000);
setInterval(() => { if (settings.autoUpdate) checkForUpdates(); }, 24 * 3600 * 1000);
