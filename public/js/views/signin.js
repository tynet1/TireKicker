// Sign in: crew pick their name and enter a PIN; supervisors/admins use email + password.
import { api } from "../api.js";
import { brand } from "../brand.js";
import { homeHeader } from "../ui.js";
import { $, esc } from "../util.js";

const hero = () => brand.logo_url
  ? `<div class="brandhero"><img src="${esc(brand.logo_url)}" alt="${esc(brand.company_name)}"></div>`
  : "";

export async function render(app, { onSignedIn }) {
  homeHeader({ logo: false }); // the big logo is on the page itself
  let crew = [];
  let loadErr = null;
  let picked = null;
  let pin = "";
  let filter = "";
  let mode = "crew";
  try { picked = Number(localStorage.getItem("gc-last-crew")) || null; } catch { /* ignore */ }

  app.innerHTML = `<div class="signin"><div class="empty">Loading…</div></div>`;
  try {
    crew = await api("/auth/crew");
  } catch (e) {
    loadErr = e;
  }
  if (!crew.some((c) => c.id === picked)) picked = null;
  if (!loadErr && !crew.length) mode = "staff";

  const onKey = (e) => {
    if (mode !== "crew" || !picked || e.target.matches("input")) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("back");
    else if (e.key === "Enter") submitPin();
  };
  document.addEventListener("keydown", onKey);
  render.leave = () => document.removeEventListener("keydown", onKey);

  draw();

  function draw() {
    const box = app.querySelector(".signin") || app;
    if (mode === "staff") {
      box.innerHTML = `${hero()}
        <h2>Supervisor / admin sign in</h2>
        <form class="card" id="staffForm" autocomplete="on">
          <label class="f" for="em">Email</label>
          <input class="t" id="em" type="email" autocomplete="username" autocapitalize="off" required>
          <label class="f" for="pw" style="margin-top:12px">Password</label>
          <input class="t" id="pw" type="password" autocomplete="current-password" required>
          <div id="err"></div>
          <button class="primary wide" style="margin-top:14px" id="go">Sign in</button>
        </form>
        ${crew.length ? `<button class="link" id="toCrew" style="width:100%">Crew? Sign in with your PIN</button>` : ""}`;
      $("#staffForm").onsubmit = async (e) => {
        e.preventDefault();
        const go = $("#go");
        go.disabled = true;
        try {
          const u = await api("/auth/login", { method: "POST", body: { email: $("#em").value, password: $("#pw").value } });
          done(u);
        } catch (err) {
          $("#err").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
          go.disabled = false;
        }
      };
      const tc = $("#toCrew");
      if (tc) tc.onclick = () => { mode = "crew"; draw(); };
      return;
    }

    const list = crew.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
    box.innerHTML = `${hero()}
      ${loadErr ? `<div class="banner err">${esc(loadErr.message)}</div>` : ""}
      <h2>Who's inspecting?</h2>
      ${crew.length > 8 ? `<input class="search" id="filter" placeholder="Find your name" value="${esc(filter)}" autocomplete="off" style="margin:0 0 10px">` : ""}
      <div class="names" id="names">${list.map((c) => `<button data-id="${c.id}" class="${c.id === picked ? "on" : ""}">${esc(c.name)}</button>`).join("")}</div>
      ${picked ? `
        <div class="card" id="pinBox" style="margin-top:14px">
          <div class="spread"><b>PIN for ${esc(crew.find((c) => c.id === picked)?.name)}</b></div>
          <div class="pinshow" id="dots"></div>
          <div id="err"></div>
          <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
            <button class="fn" data-k="clear">Clear</button><button data-k="0">0</button><button class="fn" data-k="back" aria-label="Delete">⌫</button></div>
          <button class="primary wide" style="margin-top:14px" id="goPin" disabled>Sign in</button>
        </div>` : ""}
      <button class="link" id="toStaff" style="width:100%;margin-top:8px">Supervisor or admin? Sign in with email</button>`;

    box.querySelectorAll("#names button").forEach((b) => (b.onclick = () => {
      picked = Number(b.dataset.id);
      pin = "";
      draw();
      $("#pinBox")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
    const f = $("#filter");
    if (f) f.oninput = () => {
      filter = f.value;
      const pos = f.selectionStart;
      draw();
      const nf = $("#filter");
      nf.focus();
      nf.setSelectionRange(pos, pos);
    };
    box.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => press(b.dataset.k)));
    const gp = $("#goPin");
    if (gp) gp.onclick = submitPin;
    $("#toStaff").onclick = () => { mode = "staff"; draw(); };
    showDots();
  }

  function showDots() {
    const d = $("#dots");
    if (!d) return;
    const n = Math.max(4, pin.length);
    d.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pin.length ? "on" : ""}"></i>`).join("");
    $("#goPin").disabled = pin.length < 4;
  }

  function press(k) {
    if (k === "clear") pin = "";
    else if (k === "back") pin = pin.slice(0, -1);
    else if (pin.length < 6) pin += k;
    const e = $("#err");
    if (e) e.innerHTML = "";
    showDots();
  }

  async function submitPin() {
    if (pin.length < 4) return;
    const gp = $("#goPin");
    gp.disabled = true;
    try {
      const u = await api("/auth/pin", { method: "POST", body: { user_id: picked, pin } });
      try { localStorage.setItem("gc-last-crew", String(picked)); } catch { /* ignore */ }
      done(u);
    } catch (err) {
      pin = "";
      showDots();
      $("#err").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  }

  function done(u) {
    render.leave?.();
    onSignedIn(u);
  }
}

export function leave() {
  render.leave?.();
}
