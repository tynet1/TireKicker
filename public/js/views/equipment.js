// Equipment (shop, supervisors, admin): each trailer with its pieces, when each was last checked and whether it's due,
// open problems, and recent checks. A piece's own page shows its details, history (moves between trailers) and checks.
import { api } from "../api.js";
import { can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, lightbox, toast } from "../util.js";
import { allEquipDrafts, flushEquip, sendEquip } from "../equipq.js";
import { resolveRepair } from "./common.js";
import { discardEquipDraft } from "./equip-form.js";

/** One open problem, with Resolve. */
export function problemItem(f, { showPiece = true } = {}) {
  const age = f.days_open >= 14 ? "bad" : f.days_open >= 3 ? "warn" : "grey";
  return `<li><div class="spread" style="align-items:flex-start"><div class="grow">
      ${showPiece ? `<a href="#/equipment/piece/${f.equipment_id}"><b>${esc(f.tag)}</b></a> ${esc(f.type_title)}${f.trailer_number ? ` · ${esc(f.trailer_number)}` : ""} · ` : ""}<b>${esc(f.label)}</b>
      <span class="pill ${age}">${f.days_open <= 0 ? "Today" : `${f.days_open} day${f.days_open === 1 ? "" : "s"} open`}</span>
      ${f.note ? `<div>${esc(f.note)}</div>` : ""}
      <div class="small muted">${esc(f.checker_name)} · <a href="#/equipment-check/${esc(f.check_id)}">From ${fmtDate(f.check_date)} check</a></div>
      ${f.photo_ids?.length ? `<div class="row" style="margin-top:4px">${f.photo_ids.map((id) =>
        `<img class="dmgthumb" src="/api/photos/${esc(id)}" data-lb="${esc(id)}" data-cap="${esc(`${f.tag} · ${f.label}${f.note ? `: ${f.note}` : ""}`)}" alt="Photo of the problem">`).join("")}</div>` : ""}
    </div><div class="btncol">${can.logService() ? `<a class="secondary" href="#/equipment/service/new/${f.equipment_id}?fix=${f.id}">Log fix</a>` : ""}
      <button class="secondary" data-eresolve="${f.id}" data-label="${esc(`${f.tag}: ${f.label}`)}">Resolve</button></div></div></li>`;
}

/** Wire Resolve buttons and thumbnails inside `root`; `after` runs once a problem was resolved. */
export function wireProblems(root, after) {
  root.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  root.querySelectorAll("[data-eresolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.eresolve, b.dataset.label, `/equipment-findings/${b.dataset.eresolve}/resolve`)) after();
  }));
}

const dueText = (p) => (p.last_checked ? `Last checked ${fmtDate(p.last_checked)}` : "Never checked");

function pieceRow(p) {
  return `<a class="item" href="#/equipment/piece/${p.id}"><span class="grow"><b>${esc(p.tag)}</b> ${esc(p.type_title)}
      <span class="small muted clip">${esc([p.make, p.model].filter(Boolean).join(" "))}${p.make || p.model ? " · " : ""}${dueText(p)}</span></span>
    <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${p.due ? `<span class="pill warn">Due</span>` : `<span class="pill okk">OK</span>`}
      ${p.service_due ? `<span class="pill warn">Service due</span>` : ""}
      ${p.open_problems ? `<span class="pill bad">${p.open_problems} open</span>` : ""}</span></a>`;
}

export async function render(app, pieceId) {
  if (pieceId) return renderPiece(app, pieceId);
  const nav = state.nav;
  setHeader({ title: "Equipment", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, problems, checks, drafts;
  try {
    [data, problems, checks, drafts] = await Promise.all([
      api("/equipment"), api("/equipment-findings"), api("/equipment-checks?limit=15"), allEquipDrafts().catch(() => []),
    ]);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const reload = () => { if (!stale(nav)) render(app); };
  const draftFor = (key) => drafts.find((d) => d.key === `equip-${key}`);

  const groups = [
    ...data.trailers.map((t) => ({ key: String(t.id), title: t.trailer_number, sub: [t.name, t.truck_code ? `on ${t.truck_code}` : ""].filter(Boolean).join(" · "), pieces: t.pieces })),
    ...(data.unassigned.length ? [{ key: "none", title: "Not on a trailer", sub: "", pieces: data.unassigned }] : []),
  ];
  let h = `<p class="small muted" style="margin:14px 4px 0">Each piece is due for a check every ${data.check_days} days.
      ${data.due ? `<b>${data.due} due now.</b>` : "None due."} ${data.open_problems ? `<b>${data.open_problems} open problem${data.open_problems === 1 ? "" : "s"}.</b>` : ""}</p>`;
  const queued = drafts.filter((d) => d.status === "queued");
  if (queued.length) {
    h += `<div class="banner info"><b>${queued.length} equipment check${queued.length > 1 ? "s" : ""} saved on phone, not yet uploaded.</b>
      <br>${esc(queued[0].lastError || "Uploading…")}.<div style="margin-top:8px"><button class="secondary" id="sendNow">Try upload now</button></div></div>`;
  }
  if (!groups.length) {
    h += `<div class="card empty">No equipment yet.${state.user.role === "admin" ? ` Add trailers and equipment under <a href="#/admin/equipment">Admin → Equipment</a>.` : " An admin adds it under Admin → Equipment."}</div>`;
  }
  for (const g of groups) {
    const due = g.pieces.filter((p) => p.due).length;
    const d = draftFor(g.key);
    h += `<div class="h2row"><h2>${esc(g.title)}${g.sub ? ` · <span class="muted" style="text-transform:none">${esc(g.sub)}</span>` : ""}</h2>
        <span class="small muted">${g.pieces.length} piece${g.pieces.length === 1 ? "" : "s"}${due ? ` · ${due} due` : ""}</span></div>
      <div class="card list">${g.pieces.length ? g.pieces.map(pieceRow).join("") : `<div class="empty">No equipment on this trailer.</div>`}
        ${g.pieces.length && d?.status !== "queued" ? `<a class="${due ? "primary" : "secondary"} wide" style="margin-top:10px" href="#/equipment/check/${g.key}">${d ? "Resume draft check" : `Check ${esc(g.title)}`}</a>` : ""}
        ${d && d.status !== "queued" ? `<button class="link danger" data-discard="${g.key}" style="width:100%">Discard draft</button>` : ""}
      </div>`;
  }
  h += `<h2>Open problems (${problems.length})</h2><div class="card">${problems.length
    ? `<ul class="repairlist">${problems.map((f) => problemItem(f)).join("")}</ul>` : `<span class="muted">Nothing open. ✓</span>`}</div>`;
  h += `<h2>Recent checks</h2><div class="card list">${checks.length ? checks.map((c) => `<a class="item" href="#/equipment-check/${esc(c.id)}">
      <span class="grow">${fmtDate(c.check_date)} · ${esc(c.trailer_number || "Not on a trailer")}
        <span class="small muted clip">${esc(c.checker_name)} · ${c.checked} checked${c.not_here ? ` · ${c.not_here} not here` : ""}</span></span>
      <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${c.problems
        ? `<span class="pill ${c.open ? "bad" : "okk"}">${c.open ? `${c.open} open` : "All fixed"}</span>` : `<span class="pill okk">All OK</span>`}</span></a>`).join("")
    : `<div class="empty">No checks yet.</div>`}</div>`;
  app.innerHTML = h;

  wireProblems(app, reload);
  app.querySelectorAll("[data-discard]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Discard this draft equipment check? This can't be undone.", "Discard", { danger: true }))) return;
    await discardEquipDraft(b.dataset.discard);
    toast("Draft discarded");
    reload();
  }));
  const sn = $("#sendNow");
  if (sn) sn.onclick = async () => {
    sn.disabled = true;
    sn.innerHTML = `<span class="spinner"></span> Sending…`;
    let sent = 0;
    for (const d of queued) if ((await sendEquip(d.key)).state === "sent") sent++;
    toast(sent ? `${sent} check${sent > 1 ? "s" : ""} uploaded ✓` : "Still no connection to the server. It will keep trying.");
    flushEquip();
    reload();
  };
}

const ACTIONS = { added: "Added", edited: "Edited", moved: "Moved", retired: "Retired", restored: "Restored" };

async function renderPiece(app, id) {
  const nav = state.nav;
  setHeader({ title: "Equipment", back: "#/equipment" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, svc, problems;
  try {
    [data, svc, problems] = await Promise.all([
      api(`/equipment/${id}`), api(`/equipment/${id}/service`), api("/equipment-findings"),
    ]);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  problems = problems.filter((f) => String(f.equipment_id) === String(id));
  if (stale(nav)) return;
  const e = data.equipment;
  setHeader({ title: e.tag, sub: e.type_title, back: "#/equipment",
    actions: state.user.role === "admin" ? [{ label: "Edit", href: `#/admin/equipment?edit=${e.id}` }] : [] });
  const what = (h) => {
    if (h.action === "moved") return `from ${esc(h.before?.trailer || "no trailer")} to ${esc(h.after?.trailer || "no trailer")}`;
    if (h.action === "edited") return Object.keys(h.after || {}).map((k) => esc(k.replace("_", " "))).join(", ");
    return "";
  };
  let h = `<div class="card" style="margin-top:14px"><dl class="kv">
      <dt>Tag</dt><dd>${esc(e.tag)}</dd><dt>Kind</dt><dd>${esc(e.type_title)}</dd>
      <dt>Make / model</dt><dd>${esc([e.make, e.model].filter(Boolean).join(" ") || "—")}</dd>
      <dt>Serial</dt><dd>${esc(e.serial || "—")}</dd><dt>Trailer</dt><dd>${esc(e.trailer_number || "Not on a trailer")}</dd>
      ${e.notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(e.notes)}</dd>` : ""}
      ${e.active ? "" : `<dt>Status</dt><dd><span class="pill grey">Retired</span></dd>`}</dl></div>`;
  h += `<h2>Open problems (${problems.length})</h2><div class="card">${problems.length
    ? `<ul class="repairlist">${problems.map((f) => problemItem(f, { showPiece: false })).join("")}</ul>` : `<span class="muted">Nothing open. ✓</span>`}</div>`;
  h += `<div class="h2row"><h2>Maintenance</h2>${can.logService() && e.active ? `<a class="link" href="#/equipment/service/new/${e.id}">+ Log maintenance</a>` : ""}</div>
    <div class="card list">${svc.next_due.length ? `<div class="small" style="padding:4px 2px 10px">${svc.next_due.map((n) =>
      `<div>${esc(n.title)}: next due ${fmtDate(n.date)} <span class="pill ${n.state === "due" ? "bad" : n.state === "soon" ? "warn" : "grey"}">${n.state === "due" ? "Due" : n.state === "soon" ? "Soon" : "OK"}</span></div>`).join("")}</div>` : ""}
      ${svc.entries.length ? svc.entries.map((s) => `<a class="item${s.voided ? " voided" : ""}" href="#/equipment-service/${s.id}">
        <span class="grow">${fmtDate(s.service_date)} · ${esc(s.work_titles.join(", "))}<span class="small muted clip">${esc(s.description)}</span></span>
        <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${s.voided ? `<span class="pill grey">Voided</span>` : ""}
          ${s.fixed && !s.voided ? `<span class="pill okk">${s.fixed} fixed</span>` : ""}</span></a>`).join("") : `<div class="empty">No maintenance logged yet.</div>`}</div>`;
  h += `<h2>Checks (${data.checks.length})</h2><div class="card list">${data.checks.length ? data.checks.map((c) => `<a class="item" href="#/equipment-check/${esc(c.id)}">
      <span class="grow">${fmtDate(c.check_date)}<span class="small muted clip">${esc(c.checker_name)}${c.note ? ` · ${esc(c.note)}` : ""}</span></span>
      ${c.status === "not_here" ? `<span class="pill grey">Not here</span>` : c.problems ? `<span class="pill bad">${c.problems} problem${c.problems === 1 ? "" : "s"}</span>` : `<span class="pill okk">All OK</span>`}</a>`).join("")
    : `<div class="empty">Not checked yet.</div>`}</div>`;
  h += `<h2>History</h2><div class="card"><ul class="small" style="padding-left:18px;margin:0">${data.history.map((x) =>
    `<li>${fmtDate(x.changed_at)} · ${esc(x.changed_by_name)} · ${ACTIONS[x.action] || esc(x.action)} ${what(x)}</li>`).join("")}</ul></div>`;
  app.innerHTML = h;
  wireProblems(app, () => { if (!stale(nav)) renderPiece(app, id); });
}
