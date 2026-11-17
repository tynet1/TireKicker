// Shared app state and the header bar.
import { brand } from "./brand.js";
import { $, esc } from "./util.js";

export const state = {
  user: null,   // { id, name, email, role }
  nav: 0,       // bumps on every route change; async renders check it before touching the DOM
};

const RANK = { crew: 1, shop: 1, supervisor: 2, admin: 3 };
export const atLeast = (role) => !!state.user && RANK[state.user.role] >= RANK[role];
const isRole = (...roles) => !!state.user && roles.includes(state.user.role);

/** What the signed-in user may do (the server checks the same rules). */
export const can = {
  seeService: () => atLeast("supervisor") || isRole("shop"),
  logService: () => isRole("shop", "admin"),
  resolveRepairs: () => atLeast("supervisor") || isRole("shop"),
};

/** True if the user has navigated away since `nav` was captured. */
export const stale = (nav) => nav !== state.nav;

/**
 * @param {{title: string, sub?: string, back?: string|null, actions?: {label: string, href?: string, onclick?: () => void}[]}} h
 */
export function setHeader({ title, sub = "", back = null, actions = [], logo: showLogo = true }) {
  $("#title").innerHTML = `${esc(title)}${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  const b = $("#backBtn");
  b.hidden = !back;
  if (back) b.href = back;
  // The logo shows on the top-level screens (home, sign in), where there's no back button.
  const logo = $("#hdrLogo");
  logo.hidden = !showLogo || !!back || !brand.logo_url;
  if (!logo.hidden && logo.getAttribute("src") !== brand.logo_url) logo.src = brand.logo_url;
  logo.alt = brand.company_name;
  const box = $("#headActions");
  box.innerHTML = "";
  for (const a of actions) {
    const el = document.createElement(a.href ? "a" : "button");
    el.className = "iconbtn";
    el.textContent = a.label;
    if (a.href) el.href = a.href;
    if (a.onclick) el.onclick = a.onclick;
    box.appendChild(el);
  }
  document.title = title === brand.app_name ? `${brand.app_name} · ${brand.company_name}` : `${title} · ${brand.app_name}`;
}

/** Header for the top-level screens: app name, company (and who's signed in). */
export function homeHeader(extra = {}) {
  const who = state.user ? ` · ${state.user.name}` : "";
  setHeader({ title: brand.app_name, sub: `${brand.company_name}${extra.showUser ? who : ""}`, ...extra });
}

export function errorHtml(e) {
  return `<div class="banner err">${esc(e?.message || String(e))}</div>`;
}
