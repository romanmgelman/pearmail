// Thin wrapper around Tauri's invoke() plus small shared helpers.
const T = window.__TAURI__;

export const call = (cmd, args = {}, options) => T.core.invoke(cmd, args, options);
export const listen = (ev, cb) => T.event.listen(ev, cb);
export const openUrl = (url) => T.opener.openUrl(url);

export const api = {
  // Accounts
  restore: () => call("restore_session"),
  listAccounts: () => call("list_accounts"),
  addAccount: (args) => call("add_account", args),
  removeAccount: (account) => call("remove_account", { account }),
  reauthAccount: (account, password = null) => call("reauth_account", { account, password }),
  detectProvider: (email) => call("detect_provider", { email }),
  signOut: () => call("sign_out"),
  setDisplayName: (account, name) => call("set_display_name", { account, name }),
  reorderAccounts: (order) => call("reorder_accounts", { order }),
  setSenderName: (account, name) => call("set_sender_name", { account, name }),
  // Mail (every call names its account)
  folders: (account) => call("list_folders", { account }),
  messages: (account, folder, opts = {}) => call("list_messages", { account, folder, ...opts }),
  message: (account, folder, uid, markSeen = true, allowPartial = false) => call("get_message", { account, folder, uid, markSeen, allowPartial }),
  setFlag: (account, folder, uids, flag, on) => call("set_flag", { account, folder, uids, flag, on }),
  move: (account, folder, uids, dest) => call("move_messages", { account, folder, uids, dest }),
  moveToRole: (account, folder, uids, role) => call("move_to_role", { account, folder, uids, role }),
  remove: (account, folder, uids) => call("delete_messages", { account, folder, uids }),
  send: (account, message) => call("send_message", { account, message }),
  saveDraft: (account, message) => call("save_draft", { account, message }),
  discardDraft: (account, uid) => call("discard_draft", { account, uid }),
  stageMessageAttachments: (account, folder, uid) => call("stage_message_attachments", { account, folder, uid }),
  saveAttachment: (account, folder, uid, index) => call("save_attachment", { account, folder, uid, index }),
  openAttachment: (account, folder, uid, index) => call("open_attachment", { account, folder, uid, index }),
  rawSource: (account, folder, uid) => call("raw_source", { account, folder, uid }),
  pickFiles: () => call("pick_files"),
  /** Copy a dropped File for sending: returns { name, path, size } like pickFiles. */
  stageAttachment: async (file) =>
    call("stage_attachment", new Uint8Array(await file.arrayBuffer()), { headers: { "x-name": encodeURIComponent(file.name) } }),
  folderOp: (account, op, path, newPath) => call("folder_op", { account, op, path, newPath }),
  cachedFolders: (account) => call("cached_folders", { account }),
  cachedMessages: (account, folder, opts = {}) => call("cached_messages", { account, folder, ...opts }),
  prefetch: (account, folder, uids) => call("prefetch", { account, folder, uids }),
  contactPhotos: () => call("contact_photos"),
  attachmentPreview: (account, folder, uid, index, max) => call("attachment_preview", { account, folder, uid, index, max }),
  inlineImage: (account, folder, uid, index) => call("inline_image", { account, folder, uid, index }),
  getThread: (account, folder, ids) => call("get_thread", { account, folder, ids }),
  syncRecent: (account, role, limit) => call("sync_recent", { account, role, limit }),
  restartWatchers: (reason) => call("restart_watchers", { reason }),
  setRunInBackground: (on) => call("set_run_in_background", { on }),
  startedHidden: () => call("started_hidden"),
  updateStatus: () => call("update_status"),
  checkForUpdate: () => call("check_for_update"),
  restartToUpdate: () => call("restart_to_update"),
  getOpenAtLogin: () => call("get_open_at_login"),
  setOpenAtLogin: (on, background) => call("set_open_at_login", { on, background }),
  logEvent: (kind, message) => call("log_event", { kind, message }).catch(() => {}),
  showLogFile: () => call("show_log_file"),
  attachmentData: (account, folder, uid, index) => call("attachment_data", { account, folder, uid, index }),
  saveAttachmentPng: (account, folder, uid, index) => call("save_attachment_png", { account, folder, uid, index }),
};

export const appWindow = () => T.window.getCurrentWindow();

// New-mail notifications: shown by the app itself as "Pear Mail" with its icon
// (the notification plugin would show "Windows PowerShell" for an unpackaged app).
export async function notify(title, body, target = null) {
  try {
    await call("show_notification", { title, body, target });
  } catch {}
}

// Outlook-like avatar colors, stable per sender.
const AVATAR_COLORS = ["#a4262c", "#ca5010", "#8f7034", "#407855", "#038387", "#0078d4", "#40587c", "#4f6bed", "#5c2e91", "#986f0b", "#c239b3", "#e3008c", "#881798", "#004e8c", "#498205", "#750b1c", "#00827a", "#8764b8"];
export function avatarColor(person) {
  const key = (person?.email || person?.name || "?").toLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Outlook-style date group for the message list.
export function dateGroup(ms) {
  if (!ms) return "Older";
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  if (diff <= dow) return "This Week";
  if (diff <= dow + 7) return "Last Week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "This Month";
  const month = d.toLocaleDateString(undefined, { month: "long" });
  return d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Avatar initials come from the sender-name parser in names.js.
export { initials } from "./names.js";

export const displayName = (p) => (p?.name || p?.email || "No Sender").trim();

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// List-style date: time today, "Yesterday", weekday within 7 days, else short date.
export function listDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  const diff = (now - d) / 86400000;
  if (diff < 7 && diff > 0) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

// Reading-pane date: "November 12, 2026 at 9:41 AM".
export function longDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

export function fileSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("pm." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("pm." + key, JSON.stringify(value));
    } catch {}
  },
};

export function errText(e) {
  return typeof e === "string" ? e : e?.message || String(e);
}

// Remember people we've seen, for recipient autocomplete.
export function rememberContacts(people) {
  const c = store.get("contacts", {});
  let changed = false;
  for (const p of people) {
    if (!p?.email) continue;
    const k = p.email.toLowerCase();
    if (!c[k] || (!c[k].name && p.name)) {
      c[k] = { name: p.name || "", email: p.email, n: (c[k]?.n || 0) + 1 };
      changed = true;
    }
  }
  if (changed) store.set("contacts", c);
}
