// "Add Account" flow: provider tiles → one-click browser sign-in (Google / Microsoft),
// app-password form, or manual server settings. Rendered into any container (first-launch screen
// or a modal).
import { api, esc, errText, openUrl } from "./api.js";
import { icon } from "./icons.js";

const PROVIDERS = [
  { id: "icloud", name: "iCloud", color: "#3b82f6", hint: "iCloud Mail" },
  { id: "gmail", name: "Gmail", color: "#ea4335", hint: "Google" },
  { id: "outlook", name: "Outlook.com", color: "#0a6cd6", hint: "Hotmail, Live, MSN" },
  { id: "yahoo", name: "Yahoo", color: "#6001d2", hint: "Yahoo Mail" },
  { id: "aol", name: "AOL", color: "#2e2e2e", hint: "AOL Mail" },
  { id: "other", name: "Other", color: "#8e8e93", hint: "Any IMAP account" },
];

const APP_PASSWORD_HELP = {
  icloud: { url: "https://account.apple.com/account/manage", text: "Create an <b>app-specific password</b> at account.apple.com → Sign-In and Security → App-Specific Passwords." },
  gmail: { url: "https://myaccount.google.com/apppasswords", text: "Turn on 2-Step Verification for your Google Account, then create an <b>app password</b> at myaccount.google.com/apppasswords." },
  yahoo: { url: "https://login.yahoo.com/account/security/app-passwords", text: "Create an <b>app password</b> in Yahoo Account Security → Generate app password." },
  aol: { url: "https://login.aol.com/account/security/app-passwords", text: "Create an <b>app password</b> in AOL Account Security → Generate app password." },
  other: { url: null, text: "Use your email password, or an app password if your provider requires one." },
};

/**
 * Render the Add Account flow into `host`.
 * opts: { onAdded(accountInfo), onCancel?(), heading?: string }
 */
export function addAccountFlow(host, opts) {
  const root = document.createElement("div");
  root.className = "add-acct";
  host.innerHTML = "";
  host.appendChild(root);
  // Links inside guides open in the browser.
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-url]");
    if (a) { e.preventDefault(); openUrl(a.dataset.url); }
  });
  choose();

  function frame(title, sub, body, { back = true } = {}) {
    root.innerHTML = `
      ${back ? `<button class="aa-back" data-act="back">${icon("chevronRight")}<span>Back</span></button>` : ""}
      <h2 class="aa-title">${title}</h2>
      ${sub ? `<p class="aa-sub">${sub}</p>` : ""}
      <div class="aa-body">${body}</div>
      <div class="aa-error" role="alert"></div>`;
    root.querySelector('[data-act="back"]')?.addEventListener("click", choose);
  }

  const setError = (msg) => { const e = root.querySelector(".aa-error"); if (e) e.textContent = msg || ""; };
  // While busy, the button's icon becomes a spinner (the label stays put).
  const busy = (btn, on, label) => {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("busy", on);
    const ic = btn.querySelector(":scope > .icon");
    if (on && ic) { btn._icon = ic; ic.replaceWith(Object.assign(document.createElement("span"), { className: "btn-spin" })); }
    if (!on && btn._icon) { btn.querySelector(":scope > .btn-spin")?.replaceWith(btn._icon); btn._icon = null; }
    if (label) btn.querySelector(":scope > span:not(.btn-spin):not(.icon)").textContent = label;
  };

  function choose() {
    frame(opts.heading || "Add an Account", "Choose your email provider.", `
      <div class="aa-tiles">${PROVIDERS.map((p) => `
        <button class="aa-tile" data-p="${p.id}">
          <span class="aa-mark" style="background:${p.color}">${esc(p.name[0])}</span>
          <span class="aa-name">${esc(p.name)}</span><span class="aa-hint">${esc(p.hint)}</span>
        </button>`).join("")}</div>
      ${opts.onCancel ? `<div class="aa-actions"><button class="btn" data-act="cancel">Cancel</button></div>` : ""}`, { back: false });
    root.querySelectorAll(".aa-tile").forEach((t) => t.addEventListener("click", () => provider(t.dataset.p)));
    root.querySelector('[data-act="cancel"]')?.addEventListener("click", () => opts.onCancel?.());
  }

  function provider(p) {
    if (p === "outlook") return oauth("microsoft", "Outlook.com");
    if (p === "gmail") return oauth("google", "Gmail");
    passwordForm(p);
  }

  function passwordForm(p, prefill = {}) {
    const meta = PROVIDERS.find((x) => x.id === p);
    const help = APP_PASSWORD_HELP[p];
    frame(`Add ${esc(meta.name)} Account`, help.text + (help.url ? ` <a data-url="${help.url}">Open ${new URL(help.url).hostname}</a>` : ""), `
      <form class="aa-form" autocomplete="off">
        <label>Email<input name="email" type="email" spellcheck="false" placeholder="${p === "icloud" ? "name@icloud.com" : "name@example.com"}" value="${esc(prefill.email || "")}"></label>
        <label>${p === "other" ? "Password" : "App Password"}<input name="password" type="password" spellcheck="false" value="${esc(prefill.password || "")}"></label>
        <label>Account Name <i>(optional)</i><input name="name" spellcheck="false" placeholder="e.g. Personal or Work" value="${esc(prefill.name || "")}"></label>
        <label>Sender Name <i>(optional)</i><input name="senderName" spellcheck="false" placeholder="Taken from your sent mail if left blank" value="${esc(prefill.senderName || "")}"></label>
        <div class="aa-servers" hidden></div>
        <div class="aa-actions">
          <button type="submit" class="btn primary" data-act="add">${icon("arrowRight")}<span>Sign In</span></button>
        </div>
      </form>`);
    const form = root.querySelector("form");
    form.elements.namedItem("email").focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setError("");
      const email = form.elements.namedItem("email").value.trim();
      if (!email || !form.elements.namedItem("password").value) return setError("Enter your email address and password.");
      const args = { email, password: form.elements.namedItem("password").value, name: form.elements.namedItem("name").value.trim() || null, senderName: form.elements.namedItem("senderName").value.trim() || null, auth: "password" };
      const servers = form.querySelector(".aa-servers");
      if (!servers.hidden) Object.assign(args, readServers(servers));
      const btn = form.querySelector('[data-act="add"]');
      busy(btn, true, "Signing In…");
      try {
        opts.onAdded(await api.addAccount(args));
      } catch (err) {
        const msg = errText(err);
        if (msg.startsWith("MANUAL:")) {
          showServers(servers, email);
          setError("We couldn't find this provider's settings automatically. Enter its mail servers below.");
        } else setError(msg);
      } finally {
        busy(btn, false, "Sign In");
      }
    });
  }

  function showServers(el, email) {
    const domain = email.split("@")[1] || "example.com";
    const sec = (name, v) => `<select name="${name}"><option value="tls" ${v === "tls" ? "selected" : ""}>SSL/TLS</option><option value="starttls" ${v === "starttls" ? "selected" : ""}>STARTTLS</option></select>`;
    el.hidden = false;
    el.innerHTML = `
      <div class="aa-srv"><span>Incoming (IMAP)</span><input name="imapHost" value="imap.${esc(domain)}" spellcheck="false"><input name="imapPort" value="993" inputmode="numeric">${sec("imapSec", "tls")}</div>
      <div class="aa-srv"><span>Outgoing (SMTP)</span><input name="smtpHost" value="smtp.${esc(domain)}" spellcheck="false"><input name="smtpPort" value="587" inputmode="numeric">${sec("smtpSec", "starttls")}</div>`;
  }

  function readServers(el) {
    const v = (n) => el.querySelector(`[name="${n}"]`).value.trim();
    return {
      imap: { host: v("imapHost"), port: Number(v("imapPort")) || 993, security: v("imapSec") },
      smtp: { host: v("smtpHost"), port: Number(v("smtpPort")) || 587, security: v("smtpSec") },
    };
  }

  /** Google / Microsoft: one button. The address comes from the sign-in itself. */
  function oauth(kind, label) {
    const brand = kind === "microsoft" ? "Microsoft" : "Google";
    frame(`Add ${label} Account`, `You'll sign in on ${brand}'s website in your browser. Pear Mail never sees your password.`, `
      <div class="aa-actions aa-oauth">
        <button class="btn primary" data-act="go">${icon("arrowRight")}<span>Sign in with ${brand}</span></button>
        ${kind === "google" ? `<a class="aa-alt" data-act="app-password" href="#">Use an app password instead</a>` : ""}
      </div>`);
    root.querySelector('[data-act="app-password"]')?.addEventListener("click", (e) => { e.preventDefault(); passwordForm("gmail"); });
    const btn = root.querySelector('[data-act="go"]');
    btn.focus();
    btn.addEventListener("click", async () => {
      setError("");
      busy(btn, true, "Finish signing in in your browser…");
      try {
        opts.onAdded(await api.addAccount({ auth: kind }));
      } catch (err) {
        setError(errText(err));
      } finally {
        busy(btn, false, `Sign in with ${brand}`);
      }
    });
  }
}

/** Modal wrapper around the flow (used from inside the app). Resolves with the new account or null. */
export function addAccountModal() {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal add-acct-modal"></div>`;
    document.body.appendChild(back);
    const done = (v) => { back.remove(); resolve(v); };
    back.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") done(null); });
    addAccountFlow(back.querySelector(".modal"), { onAdded: (a) => done(a), onCancel: () => done(null) });
  });
}

/**
 * One-click re-sign-in. Browser sign-in accounts (Outlook / Google) go straight to the
 * browser; app-password accounts get a single password field with the provider's help link.
 * Resolves with the account info on success, null if cancelled; rejects on failure.
 */
export async function reauthAccount(acct) {
  if (acct.auth && acct.auth !== "password") return api.reauthAccount(acct.id);
  const help = APP_PASSWORD_HELP[acct.provider] || APP_PASSWORD_HELP.other;
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal reauth">
      <h3>Sign In to ${esc(acct.email)}</h3>
      <p>${acct.provider === "other" ? "Enter the password for this account." : "Enter a new app password for this account."} ${help.text}${help.url ? ` <a data-url="${help.url}">Open ${new URL(help.url).hostname}</a>` : ""}</p>
      <form autocomplete="off">
        <input type="password" name="pw" placeholder="${acct.provider === "other" ? "Password" : "App Password"}" spellcheck="false">
        <div class="aa-error" role="alert"></div>
        <div class="actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary" data-act="ok">Sign In</button></div>
      </form></div>`;
    document.body.appendChild(back);
    const form = back.querySelector("form");
    const field = form.elements.namedItem("pw");
    const close = (v) => { back.remove(); resolve(v); };
    field.focus();
    back.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-url]");
      if (a) { e.preventDefault(); openUrl(a.dataset.url); }
      if (e.target.closest('[data-act="cancel"]')) close(null);
    });
    back.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(null); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[data-act="ok"]');
      btn.disabled = true;
      btn.innerHTML = `<span class="btn-spin"></span>Signing In…`;
      form.querySelector(".aa-error").textContent = "";
      try {
        close(await api.reauthAccount(acct.id, field.value));
      } catch (err) {
        form.querySelector(".aa-error").textContent = errText(err);
        btn.disabled = false;
        btn.textContent = "Sign In";
        field.select();
      }
    });
  });
}
