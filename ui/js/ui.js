// Menus, toasts and small modal dialogs.
import { icon, ICONS } from "./icons.js";
import { esc } from "./api.js";

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu.onClose?.();
    openMenu = null;
  }
}

/**
 * items: [{label, icon, kbd, action, disabled, danger, checked, sep:true, header:"…", html:"…", submenu? }]
 * anchor: DOMRect-like {left, top, bottom, right} or {x, y}
 */
export function showMenu(items, anchor, opts = {}) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu" + (opts.className ? " " + opts.className : "");
  const inner = document.createElement("div");
  if (opts.scroll) inner.className = "menu-scroll";
  el.appendChild(inner);
  for (const it of items) {
    if (it.sep) {
      inner.insertAdjacentHTML("beforeend", '<div class="sep"></div>');
      continue;
    }
    if (it.header) {
      inner.insertAdjacentHTML("beforeend", `<div class="mh">${esc(it.header)}</div>`);
      continue;
    }
    if (it.html) {
      const wrap = document.createElement("div");
      wrap.innerHTML = it.html;
      it.bind?.(wrap, closeMenu);
      inner.appendChild(wrap);
      continue;
    }
    const mi = document.createElement("div");
    mi.className = "mi" + (it.disabled ? " disabled" : "") + (it.danger ? " danger" : "") + (it.cls ? " " + it.cls : "");
    const lead = it.checked !== undefined
      ? `<span class="icon check">${it.checked ? ICONS.check : ""}</span>`
      : it.icon ? icon(it.icon) : "";
    mi.innerHTML = `${lead}<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ""}`;
    if (!it.disabled) {
      mi.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        it.action?.();
      });
    }
    inner.appendChild(mi);
  }
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let x = anchor.x ?? (opts.alignRight ? anchor.right - r.width : anchor.left);
  let y = anchor.y ?? anchor.bottom + 4;
  if (x + r.width > innerWidth - 6) x = innerWidth - r.width - 6;
  if (y + r.height > innerHeight - 6) y = Math.max(6, (anchor.top ?? y) - r.height - 4);
  el.style.left = Math.max(6, x) + "px";
  el.style.top = Math.max(6, y) + "px";
  openMenu = { el, onClose: opts.onClose };
  return el;
}

document.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.el.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    closeMenu();
    e.stopPropagation();
  }
}, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

export const isMenuOpen = () => !!openMenu;

let toastTimer = null;
export function toast(text, opts = {}) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (opts.error ? " error" : "");
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (opts.action) {
    const b = document.createElement("button");
    b.textContent = opts.action.label;
    b.onclick = () => {
      clearTimeout(toastTimer);
      fadeOut(el);
      opts.action.run();
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  toastTimer = setTimeout(() => fadeOut(el), opts.duration || (opts.error ? 6000 : 4000));
}
/** Fade a toast out, then remove it (a replacing toast still swaps in instantly). */
function fadeOut(el) {
  if (!el.isConnected || el.classList.contains("leaving")) return;
  el.classList.add("leaving");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400); // in case the animation doesn't run
}

/** Simple modal. fields: [{id, label, value, multiline, placeholder}] → resolves values object or null */
export function dialog({ title, message = "", fields = [], ok = "OK", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog">
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ""}
      ${fields
        .map((f) =>
          f.multiline
            ? `<textarea data-id="${f.id}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
            : `<input type="text" data-id="${f.id}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" spellcheck="false">`
        )
        .join("")}
      <div class="actions">
        ${cancel ? `<button class="btn" data-act="cancel">${esc(cancel)}</button>` : ""}
        <button class="btn ${danger ? "danger" : "primary"}" data-act="ok">${esc(ok)}</button>
      </div></div>`;
    const done = (v) => {
      back.remove();
      resolve(v);
    };
    const collect = () => {
      const out = {};
      back.querySelectorAll("[data-id]").forEach((i) => (out[i.dataset.id] = i.value));
      return out;
    };
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    back.querySelector('[data-act="ok"]').onclick = () => done(collect());
    back.querySelector('[data-act="cancel"]')?.addEventListener("click", () => done(null));
    back.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") done(collect());
    });
    document.body.appendChild(back);
    (back.querySelector("[data-id]") || back.querySelector('[data-act="ok"]')).focus();
    back.querySelector("input")?.select();
  });
}

/**
 * Click-and-hold dragging to reorder sibling elements (accounts in the sidebar and in
 * Settings). Pointer events rather than HTML5 drag and drop, so we control the cursor
 * (an open hand that closes while dragging) and the motion. A plain click still works.
 *
 * - `item`: selector of the reorderable elements (siblings).
 * - `handle`: selector of the part that starts a drag (buttons inside it don't).
 * - `idOf(el)`: the id to report for an item.
 * - `onDrop(ids)`: the new order, or `null` if the drag was cancelled (Escape).
 */
export function dragReorder(container, { item, handle, idOf, onDrop }) {
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const h = e.target.closest(handle);
    if (!h || !container.contains(h) || e.target.closest("button, input, a, .chev")) return;
    const el = h.closest(item);
    if (!el) return;
    const startY = e.clientY;
    let active = false, sibs, rects, from, to, step;
    const begin = () => {
      if (active) return;
      active = true;
      clearTimeout(hold);
      sibs = [...el.parentElement.children].filter((x) => x.matches(item));
      rects = sibs.map((s) => s.getBoundingClientRect());
      from = to = sibs.indexOf(el);
      const next = rects[from + 1], prev = rects[from - 1];
      // Distance the other items move to make room: our height plus the gap between items.
      step = next ? next.top - rects[from].top : prev ? rects[from].bottom - prev.bottom : rects[from].height;
      document.body.classList.add("dragging-reorder");
      el.classList.add("reordering");
      for (const s of sibs) if (s !== el) s.classList.add("reorder-shift");
    };
    // Holding still also picks the item up (the hand closes right away).
    const hold = setTimeout(begin, 250);
    const move = (ev) => {
      const dy = ev.clientY - startY;
      if (!active) {
        if (Math.abs(dy) <= 4) return;
        begin();
      }
      ev.preventDefault();
      const r = rects[from];
      const d = Math.max(rects[0].top - r.top, Math.min(rects[rects.length - 1].bottom - r.bottom, dy));
      el.style.transform = `translateY(${d}px)`;
      // Moving down, pass an item once our bottom crosses its middle; up, once our top does.
      to = from;
      for (let i = from + 1; i < sibs.length; i++) if (r.bottom + d > rects[i].top + rects[i].height / 2) to = i;
      for (let i = from - 1; i >= 0; i--) if (r.top + d < rects[i].top + rects[i].height / 2) to = i;
      sibs.forEach((s, i) => {
        if (s === el) return;
        const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
        s.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const finish = (cancel) => {
      clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelDrag);
      window.removeEventListener("keydown", key, true);
      if (!active) return;
      // The click that follows the drag must not select anything.
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 100);
      document.body.classList.remove("dragging-reorder");
      const before = el.getBoundingClientRect().top;
      for (const s of sibs) { s.classList.remove("reorder-shift"); s.style.transform = ""; }
      el.classList.remove("reordering");
      if (cancel || to === from) {
        onDrop(null);
        return;
      }
      if (to > from) sibs[to].after(el);
      else sibs[to].before(el);
      // Glide from where it was dropped into its slot.
      el.style.transform = `translateY(${before - el.getBoundingClientRect().top}px)`;
      requestAnimationFrame(() => {
        el.classList.add("reorder-settle");
        el.style.transform = "";
        setTimeout(() => el.classList.remove("reorder-settle"), 200);
      });
      onDrop([...el.parentElement.children].filter((x) => x.matches(item)).map(idOf));
    };
    const up = () => finish(false);
    const cancelDrag = () => finish(true);
    const key = (k) => { if (k.key === "Escape" && active) { k.stopPropagation(); finish(true); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("keydown", key, true);
  });
}
