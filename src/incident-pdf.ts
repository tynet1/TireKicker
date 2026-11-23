// The incident report packet, filled in from the report, in one PDF:
//   1. Managers Incident Report (1 page)
//   2. Vehicle Accident Report (5 pages, plus a page for any further parties and witnesses)
//   3. The damage marked on the truck (diagram with numbered pins)
//   4. Photograph Log (two photos a page)
//   5. When our employee was hurt: the Employee Injury/Near Miss Report (3 pages) and, if they weren't taken for a
//      medical evaluation, the Employee Refusal of Medical Treatment, with what the report knows filled in and the rest
//      left to complete by hand
//   6. Notes added after the report was filed
// What the app deliberately doesn't keep (the driver's home address, birth date, license and employee ID, a lease unit
// ID, claim numbers) prints as blank lines to fill in by hand.
import { getBranding } from "./branding.ts";
import { readDiagram } from "./diagrams.ts";
import { dataUrl, esc, fmtDate, safeRead } from "./pdf.ts";
import type { IncidentData, Party, Witness } from "./routes/incidents.ts";

interface Assets {
  company: string;
  logo: string | null;
  truckDiagram: string | null;
  trailerDiagram: string | null;
  sketch: string | null;
  map: string | null;
  driverSig: string | null;
  reporterSig: string | null;
  photos: { src: string; caption: string; date: string }[];
}

const X = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="#111" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const cb = (on: boolean | null | undefined, label = "") => `<span class="cbw"><span class="cb">${on ? X : ""}</span>${label ? ` ${label}` : ""}</span>`;
/** "Yes ☐ No ☐", with the answer ticked (nothing ticked when it wasn't answered). */
const yesNo = (v: boolean | null | undefined) => `${cb(v === true, "Yes")}&nbsp;&nbsp;${cb(v === false, "No")}`;
const yna = (v: "yes" | "no" | "na" | null) => `<td class="c">${cb(v === "yes", "Yes")}</td><td class="c">${cb(v === "no", "No")}</td><td class="c">${cb(v === "na", "N/A")}</td>`;

/** A form line: the label, then the value written on the underline. */
const ln = (label: string, value: unknown, grow = 1) =>
  `<span class="fl" style="flex:${grow}"><span class="lb">${label}</span><span class="uv">${esc(value)}</span></span>`;
const row = (...parts: string[]) => `<div class="row">${parts.join("")}</div>`;

/** "14:30" -> { t: "2:30", pm: true }. */
function clock(t: string | null) {
  if (!t) return { t: "", pm: null as boolean | null };
  const [h, m] = t.split(":").map(Number);
  return { t: `${h % 12 || 12}:${String(m).padStart(2, "0")}`, pm: h >= 12 };
}

const page = (body: string, footer: string, assets: Assets, title = "") => `<section class="page">
  <div class="phead">${assets.logo ? `<img class="logo" src="${assets.logo}" alt="">` : `<b class="co">${esc(assets.company)}</b>`}
    ${title ? `<h1>${esc(title)}</h1>` : ""}</div>
  <div class="pbody">${body}</div>
  <div class="pfoot">${footer}</div></section>`;

function managersReport(n: IncidentData["incident"], assets: Assets, hasNotes: boolean, injuryForms: { injury: boolean; refusal: boolean }) {
  const c = clock(n.incident_time);
  const w = (n.witnesses as Witness[])[0] ?? {};
  const addr = [n.street, n.location_name && n.location_name !== n.street ? `(${n.location_name})` : ""].filter(Boolean).join(" ");
  const police = n.police_present === true ? null : "na";
  return page(`<table class="mir">
    <colgroup>${"<col>".repeat(10)}</colgroup>
    <tr><th colspan="5" class="hd">TYPE OF INCIDENT (Check All Involved)</th><th colspan="5" class="hd dk">CLAIM NUMBERS (OFFICE USE)</th></tr>
    <tr><td colspan="3">${cb(n.employee_injured, "Employee Injury")}</td><td colspan="2">${cb(true, "Auto")}</td>
      <td class="hr">${cb(false, "WC")}</td><td class="hr"></td><td colspan="2" class="hr">${cb(false, "AUTO")}</td><td class="hr"></td></tr>
    <tr><td colspan="3">${cb(n.theft_vandalism, "Theft/Vandalism")}</td><td colspan="2">${cb(n.property_damage, "Property Damage")}</td>
      <td class="hr">${cb(false, "GL")}</td><td class="hr"></td><td colspan="3" class="hr">${cb(false, "Information Only")}</td></tr>
    <tr><th colspan="10" class="sec">1.0&nbsp; GENERAL INFORMATION</th></tr>
    <tr><td colspan="3">Employee Name</td><td colspan="2" class="v">${esc(n.driver_name)}</td><td colspan="2" class="r">Employee ID</td><td colspan="3"></td></tr>
    <tr><td colspan="3">Employee Manager</td><td colspan="2" class="v">${esc(n.employee_manager)}</td><td colspan="2" class="r">Department</td><td colspan="3" class="v">${esc(n.department)}</td></tr>
    <tr><td colspan="3">Reporting Manager</td><td colspan="2" class="v">${esc(n.reporter_name)}</td><td colspan="2" class="r">Date</td><td colspan="3" class="v">${fmtDate(n.created_at)}</td></tr>
    <tr><th colspan="10" class="sec">2.0&nbsp; MEDICAL</th></tr>
    <tr><td colspan="4">Employee Taken For Medical Evaluation</td><td>${cb(n.medical_evaluation === true, "Yes")}</td><td>${cb(n.medical_evaluation === false, "No")}</td>
      <td class="r">Clinic</td><td colspan="3" class="v">${esc(n.medical_clinic)}</td></tr>
    <tr><td colspan="4">Employee Taken For A&amp;D Testing</td><td>${cb(n.ad_test === true, "Yes")}</td><td>${cb(n.ad_test === false, "No")}</td>
      <td class="r">Clinic</td><td colspan="3" class="v">${esc(n.ad_clinic)}</td></tr>
    <tr><th colspan="10" class="sec">3.0&nbsp; INCIDENT DETAILS</th></tr>
    <tr><td colspan="3">Date of Incident</td><td colspan="2" class="v">${fmtDate(n.incident_date)}</td><td colspan="2" class="r">Time of Incident</td>
      <td class="v">${esc(c.t)}</td><td>${cb(c.pm === false, "AM")}</td><td>${cb(c.pm === true, "PM")}</td></tr>
    <tr><td colspan="3">Did Incident Occur on Job</td><td>${cb(n.on_job === true, "Yes")}</td><td>${cb(n.on_job === false, "No")}</td>
      <td colspan="2" class="r">If Yes, Enter Site Name</td><td colspan="3" class="v">${esc(n.site_name)}</td></tr>
    <tr><td colspan="3">Address/Cross Section</td><td colspan="3" class="v">${esc(addr)}</td><td class="r">City</td><td class="v">${esc(n.city)}</td>
      <td class="r">Zip</td><td class="v">${esc(n.zip)}</td></tr>
    <tr><td colspan="3">Police Present</td><td>${cb(n.police_present === true, "Yes")}</td><td>${cb(n.police_present === false, "No")}</td>
      <td colspan="2" class="r">If Yes, Report Number</td><td colspan="3" class="v">${esc(n.police_report_no)}</td></tr>
    <tr><td colspan="3">Witness Name</td><td colspan="2" class="v">${esc(w.name)}</td><td colspan="2" class="r">Telephone Number</td><td colspan="3" class="v">${esc(w.phone)}</td></tr>
    <tr><th colspan="10" class="sec">4.0&nbsp; MANAGER INCIDENT COMMENTS</th></tr>
    <tr><td colspan="10" class="box pre">${esc(n.manager_comments)}${hasNotes ? `<div class="later">Notes were added after this report was filed: see the last page.</div>` : ""}</td></tr>
    <tr><th colspan="10" class="sec">5.0&nbsp; HAZARD RESOLUTION AND PREVENTATIVE MEASURES</th></tr>
    <tr><td colspan="10" class="box pre">${esc(n.preventive_measures)}</td></tr>
    <tr><th colspan="10" class="sec">6.0&nbsp; FORMS &amp; REPORTS ATTACHED</th></tr>
    <tr class="sm"><td colspan="2">Employee Injury Report</td>${yna(injuryForms.injury ? "yes" : "na")}<td colspan="2">Alcohol &amp; Drug Report</td>${yna(n.ad_test === true ? null : "na")}</tr>
    <tr class="sm"><td colspan="2">Medical Clinic Report</td>${yna(n.medical_evaluation === true ? null : "na")}<td colspan="2">Medical Waiver Report</td>${yna(injuryForms.refusal ? "yes" : "na")}</tr>
    <tr class="sm"><td colspan="2">Vehicle Accident Report</td>${yna("yes")}<td colspan="2">Police Report</td>${yna(police)}</tr>
    <tr class="sm"><td colspan="2">Theft/Vandalism</td>${yna(n.theft_vandalism ? null : "na")}<td colspan="2">Police Report</td>${yna(n.theft_vandalism ? null : "na")}</tr>
    <tr class="sm"><td colspan="2">Property Damage</td>${yna(n.property_damage ? null : "na")}<td colspan="2">Police Report</td>${yna(n.property_damage ? null : "na")}</tr>
    <tr><th colspan="10" class="sec">7.0&nbsp; MANAGER SIGNATURE</th></tr>
    <tr class="sigrow"><td colspan="3" class="v">${esc(n.reporter_name)}</td><td colspan="5" class="sig">${assets.reporterSig ? `<img src="${assets.reporterSig}" alt="">` : ""}</td>
      <td colspan="2" class="v">${fmtDate(n.created_at)}</td></tr>
    <tr class="cap"><td colspan="3">Reporting Manager Name</td><td colspan="5">Signature</td><td colspan="2">Date</td></tr>
  </table>`, `<span></span><span>-1-</span>`, assets, "Managers Incident Report");
}

function partyBlock(p: Party) {
  return row(ln("Drivers Name", p.name, 3), `<span class="fl yn">Passengers? ${yesNo(p.passengers ?? null)}</span>`)
    + row(ln("Address", p.address))
    + row(ln("City", p.city, 3), ln("State", p.state, 1), ln("Zip Code", p.zip, 1.4))
    + row(ln("Phone No", p.phone, 2), ln("License No.", p.license_no, 2))
    + row(ln("Vehicle Year", p.vehicle_year, 1), ln("Make", p.make, 1.6), ln("Model", p.model, 1.6))
    + row(ln("License Plate State", p.plate_state, 1.2), ln("License Plate No.", p.plate_no, 1.2), `<span style="flex:1"></span>`)
    + row(ln("Insurance Company", p.insurance_company, 2.4), ln("Policy No", p.policy_no, 1.4))
    + row(ln("Phone No.", p.insurance_phone, 1), `<span style="flex:1.4"></span>`);
}

function witnessBlock(w: Witness) {
  return row(ln("Witness Name", w.name, 2.2), ln("Phone No", w.phone, 1.4))
    + row(ln("Home Address", w.address))
    + row(ln("City", w.city, 3), ln("State", w.state, 1), ln("Zip Code", w.zip, 1.4));
}

function accidentReport(n: IncidentData["incident"], assets: Assets) {
  const c = clock(n.incident_time);
  const parties = n.other_parties as Party[];
  const witnesses = n.witnesses as Witness[];
  const co = esc(assets.company);
  const pages: string[] = [];
  const foot = (i: number) => `<span></span><span>Page ${i}</span>`;
  const title = "Vehicle Accident Report";

  pages.push(page(
    row(ln(`${co} Vehicle ID`, n.truck_code), ln("Lease Unit ID", ""))
    + `<h3>Incident Logistics</h3>`
    + row(ln("Date of Incident", fmtDate(n.incident_date), 2), ln("Time", c.t, 1), `<span class="fl yn">${cb(c.pm === false, "AM")}&nbsp;&nbsp;${cb(c.pm === true, "PM")}</span>`)
    + row(ln("Weather Conditions", n.weather), ln("Incident Location", n.location_name ?? n.site_name))
    + row(ln("Street Address/Intersection", n.street))
    + row(ln("City", n.city, 3), ln("State", n.state, 1), ln("Zip Code", n.zip, 1.4))
    + `<h3>Police Report Information</h3>`
    + row(ln("Police Department", n.police_department, 2), ln("Phone No", n.police_phone, 1.3))
    + row(ln("Officer Name", n.officer_name, 2), ln("Report No", n.police_report_no, 1.3))
    + row(`<span class="fl yn">Citation Issued? ${yesNo(n.citation_driver)}</span>`, `<span class="fl yn">Other Party ${yesNo(n.citation_other)}</span>`, `<span style="flex:1"></span>`)
    + `<h3>Injuries</h3>`
    + row(`<span class="fl yn">Anyone injured? ${yesNo(n.anyone_injured)}</span>`, ln("Describe", "", 2))
    + `<div class="para">${esc(n.injury_description)}</div>`
    + row(`<span class="fl yn">Employee Taken to a Clinic/Hospital? ${yesNo(n.medical_evaluation)}&nbsp;&nbsp;If yes, attach the clinic's report</span>`)
    + `<h3>Reporting Manager</h3>`
    + row(ln("Name", n.reporter_name, 2.4), ln("Date", fmtDate(n.created_at), 1.2)),
    foot(1), assets, title));

  pages.push(page(
    `<h3>${co} Driver Information</h3>`
    + row(ln("Employee Name", n.driver_name, 2.4), ln("Employee ID", "", 1.2))
    + row(ln("Home Address", ""))
    + row(ln("City", "", 3), ln("State", "", 1), ln("Zip Code", "", 1.4))
    + row(ln("Phone No", "", 2), ln("Date of Birth", "", 2))
    + row(ln("Driver’s License State", "", 2), ln("License No.", "", 2))
    + row(`<span class="fl yn">Passengers? ${yesNo(n.passengers)}</span>`, ln("If Yes, Name", n.passenger_names, 2))
    + `<h3>Other Party (If more than two parties, include information on additional pages)</h3>`
    + partyBlock(parties[0] ?? {})
    + `<h3>Witness Information</h3>`
    + witnessBlock(witnesses[0] ?? {}),
    foot(2), assets));

  pages.push(page(
    `<h3>Employee Details of Accident</h3>`
    + row(`<span class="fl yn">Were you wearing a seatbelt? ${yesNo(n.seatbelt_driver)}</span>`, `<span class="fl yn">Passenger seatbelt? ${yesNo(n.seatbelt_passenger)}</span>`)
    + row(`<span class="fl yn">Vehicle Drivable? ${yesNo(n.drivable)}</span>`, ln("If towed, provide location", n.towed_to, 2))
    + row(ln(`Damage to ${co} Vehicle`, [n.damage_gc, "(marked on the attached damage diagram)"].filter(Boolean).join(" ")))
    + row(ln("Damage to Other Party Vehicle", n.damage_other))
    + row(ln("Any distinguishable marks on other party vehicle", n.other_marks))
    + row(ln("Other Parties Appearance/Concerns", n.other_appearance))
    + `<h3>Describe Accident</h3><div class="bigbox pre">${esc(n.description)}</div>`,
    foot(3), assets));

  const gps = n.latitude != null ? `${Number(n.latitude).toFixed(5)}, ${Number(n.longitude).toFixed(5)}` : "";
  const where = [n.street, n.city, n.state].filter(Boolean).join(", ");
  pages.push(page(
    `<h3>Diagram of Accident</h3>
    <div class="diabox"><div class="dinst"><span class="compass">N<br>↑</span><span>Sketch the scene: street names, signals and signs, and which way each
      vehicle was going. Number our vehicle 1 and the others 2, 3 and so on. A map of the spot is printed below when the
      phone had one.</span></div>
      ${assets.map ? `<figure><img class="map" src="${assets.map}" alt=""><figcaption>Map</figcaption></figure>` : ""}
      ${assets.sketch ? `<figure><img class="sketch" src="${assets.sketch}" alt=""><figcaption>Drawn at the scene</figcaption></figure>` : ""}
      ${where || gps ? `<div class="gps">${esc(where)}${gps ? `${where ? " · " : ""}GPS ${gps}${n.location_accuracy_m != null ? ` (±${n.location_accuracy_m} m)` : ""}
        <br>https://www.google.com/maps?q=${Number(n.latitude).toFixed(6)},${Number(n.longitude).toFixed(6)}` : ""}</div>` : ""}
    </div>`,
    foot(4), assets));

  const filed = fmtDate(n.created_at);
  pages.push(page(
    `<h3>Employee Certification</h3>
    <p class="cert">I, (Employee Name) <span class="uv inl">${esc(n.driver_name)}</span>, confirm that this information is true and correct as far as I know.</p>
    ${row(`<span class="fl sigl" style="flex:2"><span class="sigimg">${assets.driverSig ? `<img src="${assets.driverSig}" alt="">` : ""}</span><span class="cap">Signature</span></span>`,
      `<span class="fl sigl" style="flex:1"><span class="sigimg dt">${assets.driverSig ? filed : ""}</span><span class="cap">Date</span></span>`)}
    <h3 style="margin-top:28pt">Manager Certification</h3>
    <p class="cert">I, (Manager Name) <span class="uv inl">${esc(n.reporter_name)}</span>, confirm that this information was entered as the employee reported it and is true and correct as far as I know.</p>
    ${row(`<span class="fl sigl" style="flex:2"><span class="sigimg">${assets.reporterSig ? `<img src="${assets.reporterSig}" alt="">` : ""}</span><span class="cap">Signature</span></span>`,
      `<span class="fl sigl" style="flex:1"><span class="sigimg dt">${filed}</span><span class="cap">Date</span></span>`)}`,
    foot(5), assets));

  // More than one other party or witness: on additional pages, as the form says.
  const more = [
    ...parties.slice(1).map((p, i) => `<h3>Other Party ${i + 2}</h3>${partyBlock(p)}`),
    ...witnesses.slice(1).map((w, i) => `<h3>Witness ${i + 2}</h3>${witnessBlock(w)}`),
  ];
  for (let i = 0; i < more.length; i += 2) {
    pages.push(page(more.slice(i, i + 2).join(""), `<span>Additional parties and witnesses</span><span></span>`, assets, title));
  }
  return pages.join("");
}

function damagePage(d: IncidentData, assets: Assets) {
  const n = d.incident;
  const block = (kind: "truck" | "trailer", src: string | null) => {
    const marks = d.damage.filter((m) => m.diagram === kind);
    if (!marks.length) return "";
    const label = kind === "truck" ? `${esc(n.truck_code)} (${esc([n.year, n.make, n.model].filter(Boolean).join(" "))})` : `Trailer${n.trailer_number_text ? ` ${esc(n.trailer_number_text)}` : ""}`;
    return `<h3>${label}</h3>${src ? `<div class="dia"><img src="${src}" alt="">${marks.map((m) =>
      `<span class="pin" style="left:${(Number(m.x) * 100).toFixed(2)}%;top:${(Number(m.y) * 100).toFixed(2)}%">${m.seq}</span>`).join("")}</div>` : ""}
      <ol class="legend">${marks.map((m) => `<li value="${m.seq}">${esc(m.note || "(no description)")}${m.repaired_at ? ` <span class="fixed">✓ Repaired ${fmtDate(m.repaired_at)}</span>` : ""}</li>`).join("")}</ol>`;
  };
  const body = block("truck", assets.truckDiagram) + block("trailer", assets.trailerDiagram);
  if (!body) return "";
  return page(`<p class="small">Damage marked on the report, numbered as in the photo captions.${n.damage_gc ? ` In words: ${esc(n.damage_gc)}` : ""}</p>${body}`,
    `<span>${esc(n.truck_code)} · incident ${fmtDate(n.incident_date)}</span><span></span>`, assets, `Damage to ${assets.company} Vehicle`);
}

function photoLog(n: IncidentData["incident"], assets: Assets) {
  const out: string[] = [];
  for (let i = 0; i < assets.photos.length; i += 2) {
    const two = assets.photos.slice(i, i + 2);
    out.push(`<section class="page plog"><div class="plhead"><b>PHOTOGRAPH LOG</b><br><b>Documentation</b></div>
      <div class="plbody">${two.map((p, j) => `<div class="plslot"><div class="plframe"><img src="${p.src}" alt=""></div>
        <div class="plno"><b>Photograph No.</b> ${i + j + 1}${p.caption ? ` &nbsp;·&nbsp; ${esc(p.caption)}` : ""}</div></div>`).join("")}</div>
      <table class="plfoot"><tr><td class="pllogo">${assets.logo ? `<img src="${assets.logo}" alt="">` : esc(assets.company)}</td>
        <td><b>Truck:</b><br>${esc(n.truck_code)}</td><td><b>Prepared By:</b><br>${esc(n.reporter_name)}</td>
        <td><b>Photograph Date:</b><br>${esc([...new Set(two.map((p) => p.date))].join(", "))}</td></tr></table></section>`);
  }
  return out.join("");
}

const NATURE = [
  ["Abrasion", "Allergic Reaction", "Amputation", "Bite or Sting", "Burn", "Carpal Tunnel", "Contusion or Bruise"],
  ["Dermatitis / Skin Irritation", "Dislocation", "Foreign Body", "Fracture", "Frostbite / Hypothermia", "Heat Exhaustion / Stroke", "Hernia"],
  ["Inhalation", "Laceration or Cut", "Pinched Nerve", "Poisoning", "Puncture", "Sprain or Strain", "Tendonitis"],
  ["Unconscious", "Other (describe)"],
];
const BODY = [
  ["Abdomen", "Ankle", "Arms", "Back", "Chest", "Ears", "Elbow", "Eye(s)"],
  ["Face / Jaw", "Feet / Toes", "Fingers", "Groin", "Hands", "Hips", "Knee", "Leg"],
  ["Mouth / Teeth", "Neck", "Scalp", "Shoulders", "Wrists", "Other (specify)"],
];
const checks = (cols: string[][]) => `<div class="cks">${cols.map((c) => `<div>${c.map((x) => `<div>${cb(false, x)}</div>`).join("")}</div>`).join("")}</div>`;

function injuryReport(n: IncidentData["incident"], assets: Assets) {
  const c = clock(n.incident_time);
  const foot = (i: number) => `<span></span><span>-${i}-</span>`;
  const t = "Employee Injury/Near Miss Report";
  return page(`<table class="inj">
      <tr><th class="l">TYPE OF OCCURRENCE</th><th class="dk">OFFICE USE</th></tr>
      <tr><td>${cb(false, "Occupational Illness")}&nbsp;&nbsp;&nbsp;${cb(true, "Injury")}<br>${cb(false, "Near Miss")}</td>
        <td class="hr">${cb(false, "<b>Lost Time</b>")}&nbsp;&nbsp;&nbsp;${cb(false, "<b>Medical attention</b>")}<br>${cb(false, "<b>Restricted Work</b>")}&nbsp;&nbsp;&nbsp;${cb(false, "<b>First Aid</b>")}</td></tr>
      <tr><th colspan="2" class="bar">1.0 GENERAL INFORMATION</th></tr></table>
    ${row(ln("Employee Name", n.driver_name, 2), ln("Date of Incident", fmtDate(n.incident_date), 1.4))}
    ${row(ln("Employee ID", "", 2), ln("Time of Incident", c.t ? `${c.t} ${c.pm ? "PM" : "AM"}` : "", 1.4))}
    <h3 class="rule">TASK / SCOPE OF WORK DESCRIPTION</h3><div class="small">Briefly describe the task being performed when incident occurred.</div>
    <div class="blank" style="height:2.1in"></div>
    <h3 class="rule">NATURE OF INJURY <span class="nb">(check all that are applicable)</span></h3>${checks(NATURE)}
    <h3 class="rule">BODY PART <span class="nb">(check all that are applicable)</span> <span class="right">LOCATION OF BODY PART</span></h3>
    <div class="bp">${checks(BODY)}${checks([["Upper", "Top", "Front", "Left", "Other (specify)"], ["Lower", "Bottom", "Back", "Right"]])}</div>`,
    foot(1), assets, t)
  + page(`<table class="inj"><tr><th class="bar">2.0 INJURY INFORMATION<br><span class="nb">Complete section if incident resulted in or had the potential for injury.</span></th></tr></table>
    ${row(`<span class="fl yn" style="flex:1.4">Was First Aid given? ${yesNo(null)}</span>`, ln("Name of First Aider", "", 1.2))}
    ${row(`<span class="fl yn" style="flex:1.4">Medical Aid? ${yesNo(n.medical_evaluation)}</span>`, ln("Facility", n.medical_clinic, 1.2))}
    ${row(`<span class="fl yn" style="flex:1.4">Drug &amp; Alcohol Test Performed ${yesNo(n.ad_test)}</span>`, `<span style="flex:1.2"></span>`)}
    <h3 class="rule">ANALYSIS OF INCIDENT</h3><div><b>Preventative Action</b> What are recommendations to prevent recurrence?</div>
    <div class="blank" style="height:5.2in"></div>
    ${row(ln("Name <span class=\"nb\">(please print)</span>", "", 1), ln("Title", "", 1))}
    ${row(ln("Signature", "", 1), ln("Date", "", 1))}`,
    foot(2), assets, t)
  + page(`<table class="inj"><tr><th class="l">WITNESS STATEMENT (If applicable)</th></tr></table>
    ${row(ln("Name", "", 1), ln("Employer", "", 1))}${row(ln("Occupation", "", 1), ln("Employer Phone", "", 1))}${row(ln("Phone", "", 1), ln("Employer Address", "", 1))}
    <div class="small" style="margin-top:6pt">Briefly but concisely outline sequence of events that were witnessed before, during and after incident.</div>
    <div class="blank" style="height:6.4in"></div>
    ${row(ln("Signature", "", 2), ln("Date", "", 1))}`,
    foot(3), assets, "Witness Statement");
}

function refusalForm(n: IncidentData["incident"], assets: Assets) {
  return page(`<p class="para2">My manager or supervisor has told me I can get medical treatment for the injury described below.
      I don't believe I need treatment right now. If that changes, I will tell my manager or supervisor right away.</p>
    ${row(ln("Employee Printed Name", n.driver_name, 1.4), ln("Date of Injury per Employee", "", 1))}
    ${row(ln("Time of Injury per Employee", "", 1), `<span style="flex:1.4"></span>`)}
    ${row(ln("Employee List Specific Body Part(s): <span class=\"nb\">Example: Right Hand, Index Finger</span>", ""))}
    ${row(ln("Employee List Specific Injury Type: <span class=\"nb\">Example: Scratch, Burn, Cut</span>", ""))}
    <div style="height:18pt"></div>
    ${row(ln("Employee Signature", "", 1.4), ln("Today’s Date", "", 1))}
    ${row(ln("Manager/Supervisor", "", 1.4), ln("Today’s Date", "", 1))}
    <div style="margin-top:10pt">Manager/Supervisor Comments:</div>
    <div class="lines">${"<div></div>".repeat(5)}</div>
    <p class="para2">For managers and supervisors: use this form whenever an employee with an injury, even a minor one, chooses
      not to be treated. If the injury is serious, get medical help or call 911 first. Keep this form with the rest of the
      incident packet.</p>`,
    `<span></span><span></span>`, assets, "Employee Refusal of Medical Treatment");
}

function notesPage(d: IncidentData, assets: Assets) {
  if (!d.notes.length) return "";
  return page(`<p class="small">The report itself can't be changed once filed; corrections and later facts are added here.</p>
    <table class="notes">${d.notes.map((x) => `<tr><td class="when">${fmtDate(x.created_at)}<br>${esc(x.created_by_name)}</td><td class="pre">${esc(x.note)}</td></tr>`).join("")}</table>`,
    `<span>${esc(d.incident.truck_code)} · incident ${fmtDate(d.incident.incident_date)}</span><span></span>`, assets, "Notes Added After Filing");
}

/** Which injury forms the packet adds: the injury report when our employee was hurt, the refusal form if they weren't seen. */
export function injuryForms(n: { employee_injured: boolean; medical_evaluation: boolean | null }) {
  return { injury: !!n.employee_injured, refusal: !!n.employee_injured && n.medical_evaluation !== true };
}

export function buildIncidentHtml(d: IncidentData, assets: Assets): string {
  const n = d.incident;
  const forms = injuryForms(n);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    ${managersReport(n, assets, d.notes.length > 0, forms)}
    ${accidentReport(n, assets)}
    ${damagePage(d, assets)}
    ${photoLog(n, assets)}
    ${forms.injury ? injuryReport(n, assets) : ""}
    ${forms.refusal ? refusalForm(n, assets) : ""}
    ${notesPage(d, assets)}
  </body></html>`;
}

const img = (buf: Buffer | null) => (buf ? dataUrl(buf, buf[0] === 0x89 ? "image/png" : "image/jpeg") : null);

/** The packet's HTML with every image inlined (separate from rendering so tests can check it). */
export async function incidentPdfHtml(d: IncidentData): Promise<string> {
  const n = d.incident;
  const brand = await getBranding();
  const truckDia = d.truckDiagram.file_path ? await readDiagram(d.truckDiagram.file_path).catch(() => null) : null;
  const trailerDia = d.trailerDiagram?.file_path ? await readDiagram(d.trailerDiagram.file_path).catch(() => null) : null;
  const marks = new Map(d.damage.map((m) => [m.id, `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${m.seq}${m.note ? `: ${m.note}` : ""}`]));
  let map: string | null = null;
  const photos: Assets["photos"] = [];
  for (const p of d.photos) {
    const src = img(await safeRead(p.file_path));
    if (!src) continue;
    if (p.id === n.map_photo_id) { map = src; continue; }
    photos.push({ src, caption: [p.damage_mark_id ? marks.get(p.damage_mark_id) : "", p.caption].filter(Boolean).join(" — "), date: fmtDate(p.created_at) });
  }
  return buildIncidentHtml(d, {
    company: brand.company_name,
    logo: img(await safeRead(brand.logo_key)),
    truckDiagram: truckDia ? dataUrl(truckDia.data, truckDia.mime) : null,
    trailerDiagram: trailerDia ? dataUrl(trailerDia.data, trailerDia.mime) : null,
    sketch: img(await safeRead(n.sketch_path)),
    map,
    driverSig: img(await safeRead(n.driver_signature_path)),
    reporterSig: img(await safeRead(n.reporter_signature_path)),
    photos,
  });
}

const CSS = `
@page { size: Letter; margin: 0.45in 0.6in 0.4in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.5pt/1.3 Calibri, Carlito, "Liberation Sans", Arial, sans-serif; color: #111; }
.page { break-after: page; display: flex; flex-direction: column; min-height: 10.1in; }
.page:last-child { break-after: auto; }
.phead { position: relative; min-height: 0.62in; margin-bottom: 6pt; }
.phead .logo { max-height: 0.6in; max-width: 1.6in; object-fit: contain; }
.phead .co { font-size: 12pt; }
.phead h1 { position: absolute; left: 0; right: 0; top: 0.18in; margin: 0; text-align: center; font-size: 13.5pt; }
.pbody { flex: 1; display: flex; flex-direction: column; }
.pfoot { display: flex; justify-content: space-between; font-size: 8.5pt; color: #333; margin-top: 6pt; }
h3 { font-size: 10.5pt; margin: 12pt 0 5pt; }
h3.rule { border-top: 1pt solid #111; padding-top: 3pt; margin-top: 10pt; }
h3 .right { float: right; }
.nb { font-weight: 400; }
.small { font-size: 9pt; }
.row { display: flex; gap: 14pt; align-items: flex-end; margin: 0 0 10pt; }
.fl { display: flex; align-items: flex-end; min-width: 0; white-space: nowrap; }
.fl .lb { flex: none; margin-right: 4pt; }
.fl .uv { flex: 1; border-bottom: 0.8pt solid #111; min-height: 13pt; padding: 0 3pt; font-weight: 700; white-space: normal; }
.fl.yn { flex: none; }
.uv.inl { display: inline-block; min-width: 2.6in; border-bottom: 0.8pt solid #111; font-weight: 700; padding: 0 4pt; }
.cbw { display: inline-flex; align-items: center; gap: 3pt; white-space: nowrap; }
.cb { display: inline-block; width: 10pt; height: 10pt; border: 0.8pt solid #111; vertical-align: middle; flex: none; }
.cb svg { display: block; width: 100%; height: 100%; }
.para { min-height: 34pt; border-bottom: 0.8pt solid #111; margin: -4pt 0 10pt; font-weight: 700; white-space: pre-wrap; }
.para2 { text-align: justify; margin: 10pt 0 16pt; }
.pre { white-space: pre-wrap; }
.bigbox { border: 0.8pt solid #111; flex: 1 0 auto; min-height: 2.5in; padding: 6pt; font-weight: 700; }
.diabox { border: 0.8pt solid #111; flex: 1 0 auto; min-height: 3in; padding: 6pt; }
.dinst { display: flex; gap: 10pt; font-size: 10pt; margin-bottom: 8pt; }
.compass { font-weight: 700; text-align: center; border: 1pt solid #111; border-radius: 50%; width: 0.42in; height: 0.42in; flex: none; line-height: 1; padding-top: 3pt; }
.diabox figure { margin: 0 0 6pt; text-align: center; }
.diabox img.map { max-width: 100%; max-height: 3.2in; object-fit: contain; }
.diabox img.sketch { max-width: 100%; max-height: 3.2in; object-fit: contain; border: 0.5pt solid #bbb; }
.diabox figcaption { font-size: 8.5pt; color: #444; }
.gps { font-size: 9pt; word-break: break-all; }
.cert { line-height: 2; margin: 6pt 0 26pt; }
.sigl { flex-direction: column; align-items: stretch; }
.sigimg { border-bottom: 0.8pt solid #111; height: 46pt; display: flex; align-items: flex-end; font-weight: 700; }
.sigimg img { max-height: 44pt; max-width: 100%; }
.sigl .cap { font-size: 10pt; padding-top: 2pt; }
table.mir { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9.5pt; line-height: 1.2; }
.mir td, .mir th { border: 0.8pt solid #222; padding: 2pt 4pt; vertical-align: middle; }
.mir th { text-align: left; }
.mir th.hd { text-align: center; background: #d9d9d9; }
.mir th.dk, .inj th.dk { background: #7f7f7f; color: #fff; text-align: center; }
.mir td.hr, .inj td.hr { background: #e6e6e6; }
.mir th.sec { background: #d9d9d9; }
.mir td.r { text-align: center; }
.mir td.v { font-weight: 700; }
.mir td.box { height: 1.05in; vertical-align: top; font-weight: 700; }
.mir .later { font-weight: 400; font-style: italic; margin-top: 4pt; }
.mir tr.sm td { font-size: 9pt; padding: 2pt 3pt; }
.mir td.c { text-align: center; }
.mir tr.sigrow td { height: 30pt; }
.mir td.sig img { max-height: 27pt; max-width: 100%; }
.mir tr.cap td { text-align: center; font-size: 9.5pt; }
table.inj { width: 100%; border-collapse: collapse; margin-bottom: 8pt; }
.inj th, .inj td { padding: 2pt 4pt; text-align: left; vertical-align: top; }
.inj th.l { border-bottom: 0.8pt solid #111; }
.inj th.bar { background: #7f7f7f; color: #fff; }
.blank { border-bottom: 0.8pt solid #111; }
.cks { display: flex; gap: 14pt; font-size: 9.5pt; }
.cks > div > div { margin-bottom: 1.5pt; }
.bp { display: flex; justify-content: space-between; }
.lines div { border-bottom: 1.2pt solid #111; height: 22pt; }
.dia { position: relative; display: inline-block; max-width: 100%; }
.dia img { display: block; max-width: 100%; max-height: 3.6in; }
.pin { position: absolute; transform: translate(-50%, -50%); width: 15pt; height: 15pt; border-radius: 50%; background: #c62828; color: #fff;
  font-size: 8.5pt; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 1pt solid #fff; }
.legend { margin: 6pt 0 10pt 16pt; padding: 0; }
.legend .fixed { color: #2f6b3a; font-size: 9pt; }
.plog { border: 1.6pt solid #111; padding: 0; min-height: 10.1in; }
.plhead { text-align: center; border-bottom: 1.6pt solid #111; padding: 10pt 0 22pt; font-size: 11pt; }
.plbody { flex: 1; display: flex; flex-direction: column; justify-content: space-around; padding: 10pt 0.75in; }
.plframe { border: 3pt double #111; height: 3.6in; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.plframe img { max-width: 100%; max-height: 100%; object-fit: contain; }
.plno { text-align: center; margin: 6pt 0 10pt; }
table.plfoot { width: 100%; border-collapse: collapse; border-top: 1.6pt solid #111; table-layout: fixed; }
.plfoot td { border-left: 1.6pt solid #111; padding: 4pt 6pt; height: 0.62in; vertical-align: top; text-align: center; font-size: 10pt; }
.plfoot td:first-child { border-left: 0; }
.pllogo img { max-height: 0.5in; max-width: 100%; }
table.notes { width: 100%; border-collapse: collapse; }
.notes td { border: 0.8pt solid #222; padding: 4pt 6pt; vertical-align: top; }
.notes td.when { width: 1.5in; font-size: 9pt; }
`;
