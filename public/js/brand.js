// Branding set by an admin: company name, app name, header color and logo.
// The last copy is kept on the phone so the right look shows instantly, even with no signal.
import { api } from "./api.js";

const DEFAULT = { company_name: "Your Company", app_name: "TireKicker", color: "#2f6b3a", logo_url: null };
export const brand = { ...DEFAULT };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function lum(c) {
  const [r, g, b] = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const WHITE = [255, 255, 255];
const DARK = [17, 17, 17];

const CARD_DARK = [26, 31, 28]; // --card in dark mode (app.css)
const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

/**
 * CSS variables for a brand color, chosen so text stays readable whatever color is picked, in the light look or the
 * dark one (dark: the page's current look).
 */
export function brandVars(hex, dark = isDark()) {
  const c = /^#[0-9a-f]{6}$/i.test(hex || "") ? rgb(hex) : rgb(DEFAULT.color);
  const lightText = contrast(c, WHITE) >= contrast(c, DARK);
  // Brand-colored text on a card (links, pills) is darkened (light look) or lightened (dark look) until it reads easily.
  let ink = c;
  const paper = dark ? CARD_DARK : WHITE;
  const toward = dark ? WHITE : [0, 0, 0];
  for (let t = 0.1; contrast(ink, paper) < 4.5 && t <= 1; t += 0.1) ink = mix(c, toward, t);
  return {
    "--brand": toHex(c),
    "--brand-2": toHex(dark ? mix(c, CARD_DARK, 0.72) : mix(c, WHITE, 0.88)),
    "--brand-ink": toHex(ink),
    "--on-brand": lightText ? "#fff" : "#111",
    "--on-brand-soft": lightText ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.08)",
  };
}

// The phone switched between light and dark (or someone picked one in the menu): redo the brand colors for it.
document.addEventListener("gc-theme", () => applyBranding(brand));

export function applyBranding(b) {
  if (b !== brand) Object.assign(brand, DEFAULT, b || {});
  const vars = brandVars(brand.color);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--brand"]);
}

/** Apply the saved copy right away, then fetch the current one. Never throws. */
export async function loadBranding() {
  try {
    const saved = JSON.parse(localStorage.getItem("gc-brand") || "null");
    if (saved) applyBranding(saved);
  } catch { /* nothing saved */ }
  try {
    const b = await api("/branding", { timeout: 5000 });
    applyBranding(b);
    try { localStorage.setItem("gc-brand", JSON.stringify(b)); } catch { /* private mode */ }
  } catch { /* offline: keep the saved look */ }
}

export function rememberBranding(b) {
  applyBranding(b);
  try { localStorage.setItem("gc-brand", JSON.stringify(b)); } catch { /* private mode */ }
}
