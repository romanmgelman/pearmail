// Outlook-style dark mode for HTML email: light backgrounds are darkened and
// dark text is lightened (hue preserved), while saturated brand colors and
// images are left alone. Runs on the sandboxed iframe's document from the parent.

function parse(c) {
  const m = c && c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function fromHsl(h, s, l, a = 1) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const c = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - c * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return a < 1 ? `rgba(${f(0)}, ${f(8)}, ${f(4)}, ${a})` : `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

// Relative luminance-ish lightness that accounts for perceived brightness.
const lightness = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;

/**
 * @param {Document} doc
 * @param {{bg: string, text: string}} theme  CSS colors of the message card (white maps to `bg`)
 * @returns {() => void} undo: restores the email's original colors in place
 */
export function adaptDark(doc, theme) {
  const win = doc.defaultView;
  if (!win || !doc.body) return () => {};
  const all = [doc.documentElement, doc.body, ...doc.body.querySelectorAll("*")];
  // Per element: is the effective background behind it light (kept as-is)?
  const lightBehind = new Map();
  const writes = [];
  for (const el of all) {
    if (el.tagName === "IMG" || el.tagName === "svg" || el.tagName === "PICTURE" || el.tagName === "VIDEO") continue;
    const cs = win.getComputedStyle(el);
    const parentLight = lightBehind.get(el.parentElement) ?? false;
    let light = parentLight;

    const bg = parse(cs.backgroundColor);
    if (bg && bg.a > 0.05) {
      const hsl = toHsl(bg);
      const L = lightness(bg);
      // Darken whites/greys and pale tints; keep saturated brand blocks.
      if (L > 0.8 || (L > 0.5 && hsl.s < 0.35)) {
        // Pure white becomes exactly the card color so the email blends in seamlessly.
        const val = L > 0.97 ? theme.bg : fromHsl(hsl.h, Math.min(hsl.s, 0.35), 0.11 + (1 - hsl.l) * 0.5, bg.a);
        writes.push([el, "background-color", val]);
        light = false;
      } else {
        light = L > 0.55;
      }
    }
    if (cs.backgroundImage && cs.backgroundImage !== "none" && !bg) light = parentLight;
    lightBehind.set(el, light);

    if (!light) {
      const fg = parse(cs.color);
      if (fg) {
        const hsl = toHsl(fg);
        const L = lightness(fg);
        if (L < 0.55) {
          // Map dark text to light text, keeping hue (dark blue -> light blue).
          const nl = Math.max(0.72, 0.92 - hsl.l * 0.45);
          writes.push([el, "color", fromHsl(hsl.h, hsl.s, nl, fg.a)]);
        }
      }
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        const b = parse(cs[`border${side}Color`]);
        if (b && cs[`border${side}Style`] !== "none" && parseFloat(cs[`border${side}Width`]) > 0 && lightness(b) > 0.7) {
          writes.push([el, `border-${side.toLowerCase()}-color`, "rgba(255,255,255,0.18)"]);
        }
      }
    }
  }
  // Remember the original inline values so the change can be undone without a reload.
  const undo = writes.map(([el, prop]) => [el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  for (const [el, prop, val] of writes) el.style.setProperty(prop, val, "important");
  return () => {
    for (const [el, prop, val, prio] of undo) {
      if (val) el.style.setProperty(prop, val, prio);
      else el.style.removeProperty(prop);
    }
  };
}
