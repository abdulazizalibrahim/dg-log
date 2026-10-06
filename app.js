/* DG Movement Log - runs in the browser.
   The page is hosted for free (for example on GitHub Pages) and every change is
   saved in your free Supabase database. Supabase checks who is signed in and
   what they're allowed to do, and writes the change history itself, so it can't
   be edited from the website. Your project address and key live in config.js. */
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const S = { me:null, fleet:new Map(), moves:[], sites:[], siteMap:new Map(), settings:{}, userNames:{},
  filter:"all", logLimit:40, crewEditMinutes:120, tab:"fleet", recovery:false };
const isStaff = () => S.me && (S.me.role === "admin" || S.me.role === "engineer");
const isAdmin = () => S.me && S.me.role === "admin";

/* ---------------- connection to Supabase ---------------- */
const CFG = window.DG_CONFIG || {};
const configured = CFG.url && CFG.key && !/PASTE/.test(CFG.url + CFG.key);
const sb = configured && window.supabase ? window.supabase.createClient(CFG.url, CFG.key) : null;

const ts = v => v ? Date.parse(v) : null;
const numOrNull = v => (v === null || v === undefined || v === "") ? null : Number(v);
function friendly(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Can't reach the database. Check your internet connection.";
  if (/Invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/row-level security|permission denied/i.test(m)) return "Your account isn't allowed to do that.";
  if (/duplicate key/i.test(m)) return "That already exists.";
  if (/JWT|session/i.test(m)) return "Your sign-in has expired. Sign in again.";
  if (/invalid input syntax for type numeric/i.test(m)) return "Readings must be numbers.";
  return m || "Something went wrong.";
}
async function q(p){ const { data, error } = await p; if (error) throw new Error(friendly(error)); return data; }
const rpc = (fn, args) => q(sb.rpc(fn, args));

function serMove(r){
  return { id:r.id, genId:r.gen_id, genLabel:r.gen_label, from:r.from_site, plannedTo:r.planned_to, to:r.to_site,
    reason:r.reason, subcontractor:r.subcontractor, crew:r.crew, vehicle:r.vehicle, status:r.status,
    t0:ts(r.picked_at), t1:ts(r.dropped_at),
    pickup:{ runHours:numOrNull(r.pickup_run_hours), note:r.pickup_note },
    dropoff:{ runHours:numOrNull(r.dropoff_run_hours), note:r.dropoff_note, condition:r.condition },
    locMismatch:r.loc_mismatch, legacy:r.legacy, note:r.note, createdBy:r.created_by, droppedBy:r.dropped_by };
}
const serGen = r => ({ id:r.id, tag:r.id, kind:r.kind, make:r.make, model:r.model, kva:r.kva, service:r.service,
  condition:r.condition, loc:r.loc, locNote:r.loc_note, legacy:r.legacy, moveId:r.move_id, lastMovedAt:ts(r.last_moved_at), active:r.active });
const personLabel = p => (p.name || p.email) + (p.role === "crew" && p.subcontractor ? " (" + p.subcontractor + ")" : "");
const toNum = v => { v = String(v ?? "").trim(); if (v === "") return null; const n = Number(v); if (!isFinite(n)) throw new Error("Readings must be numbers."); return n; };

/* Every screen asks for data through api(). This maps each request to Supabase. */
async function api(path, b = {}) {
  if (!sb) throw new Error("The website isn't connected to the database yet. Fill in config.js.");
  const mv = /^\/api\/moves\/(\d+)\/([a-z-]+)$/.exec(path);
  if (mv) {
    const id = +mv[1];
    if (mv[2] === "dropoff") return rpc("record_dropoff", { p_move:id, p_to:b.to, p_run_hours:toNum(b.runHours), p_condition:b.condition, p_note:b.note || "" });
    if (mv[2] === "cancel") return rpc("cancel_move", { p_move:id, p_why:b.reason || "" });
    if (mv[2] === "close-legacy") return rpc("close_legacy", { p_move:id, p_to:b.to, p_date:b.t1 ? new Date(b.t1).toISOString().slice(0,10) : null });
    if (mv[2] === "edit") {
      const c = {};
      if ("plannedTo" in b) c.planned_to = b.plannedTo;
      if ("to" in b) c.to_site = b.to;
      if ("reason" in b) c.reason = b.reason;
      if ("crew" in b) c.crew = b.crew;
      if ("vehicle" in b) c.vehicle = b.vehicle;
      if ("note" in b) c.note = b.note;
      if ("pickupRunHours" in b) c.pickup_run_hours = toNum(b.pickupRunHours);
      if ("dropoffRunHours" in b) c.dropoff_run_hours = toNum(b.dropoffRunHours);
      return rpc("correct_move", { p_move:id, p_changes:c, p_why:b.why || "" });
    }
  }
  switch (path) {
    case "/api/bootstrap": {
      const { data:{ session } } = await sb.auth.getSession();
      if (!session) { showLogin(); throw new Error("Please sign in."); }
      const prof = await q(sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle());
      if (!prof || !prof.active || prof.role === "pending") { showPending(prof, session.user.email); throw new Error("Waiting for approval."); }
      const [st, sites, gens, moves, people] = await Promise.all([
        q(sb.from("settings").select("*").eq("id", 1).single()),
        q(sb.from("sites").select("*").order("id").limit(5000)),
        q(sb.from("generators").select("*").order("id").limit(5000)),
        q(sb.from("moves").select("*").order("picked_at", { ascending:false }).limit(1000)),
        q(sb.from("profiles").select("id,name,email,role,subcontractor"))]);
      return { me:{ id:prof.id, username:prof.email, name:prof.name || prof.email, role:prof.role, subcontractor:prof.subcontractor, mustChangePw:S.recovery },
        settings:{ transitLimitHours:Number(st.transit_limit_hours), subcontractors:st.subcontractors, reasons:st.reasons },
        crewEditMinutes:st.crew_edit_minutes, sites, generators:gens.map(serGen), moves:moves.map(serMove),
        userNames:Object.fromEntries(people.map(p => [p.id, personLabel(p)])) };
    }
    case "/api/pickup":
      return rpc("record_pickup", { p_gen:b.genId, p_from:b.from, p_to:b.plannedTo || "", p_reason:b.reason,
        p_subcontractor:b.subcontractor || "", p_crew:b.crew || "", p_vehicle:b.vehicle || "", p_run_hours:toNum(b.runHours), p_note:b.note || "" });
    case "/api/generators": {
      const id = String(b.id || "").trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,30}$/.test(id)) throw new Error("Use letters, numbers and dashes for the tag.");
      const old = S.fleet.get(id);
      if (b.isNew && old) throw new Error("That tag is already used.");
      const row = { kind:b.kind || "DG", make:(b.make||"").trim(), model:(b.model||"").trim(), kva:toNum(b.kva), service:b.service,
        condition:b.condition === "Faulty" ? "Faulty" : "Working", loc_note:(b.locNote||"").trim(), active:b.active !== false };
      if (!old || old.loc !== "TRANSIT") { const loc = parseSite(b.loc); if (loc === null) throw new Error("That location isn't on the site list."); row.loc = loc; }
      if (b.isNew) return q(sb.from("generators").insert({ id, ...row }));
      return q(sb.from("generators").update(row).eq("id", id));
    }
    case "/api/sites": {
      let id = String(b.id || "").trim(); if (/^\d+$/.test(id)) id = id.padStart(4, "0");
      if (!/^[A-Za-z0-9-]{1,20}$/.test(id)) throw new Error("Enter a site number.");
      const row = { name:(b.name||"").trim(), address:(b.address||"").trim(), area:(b.area||"").trim(), access:(b.access||"").trim(), scope:(b.scope||"").trim() };
      if (b.isNew) { if (S.siteMap.has(id)) throw new Error(`Site ${id} is already on the list.`); return q(sb.from("sites").insert({ id, ...row })); }
      return q(sb.from("sites").update(row).eq("id", id));
    }
    case "/api/settings": {
      const lim = Number(b.transitLimitHours), mins = Number(b.crewEditMinutes);
      if (!(lim > 0) || !(mins >= 0) || !b.subcontractors.length || !b.reasons.length) throw new Error("Fill in every rule.");
      return q(sb.from("settings").update({ transit_limit_hours:lim, crew_edit_minutes:Math.round(mins), subcontractors:b.subcontractors, reasons:b.reasons }).eq("id", 1));
    }
    case "/api/report":
      return { moves:(await q(sb.from("moves").select("*").lt("picked_at", new Date(b.end).toISOString()).neq("status","cancelled").order("picked_at").limit(5000))).map(serMove) };
    case "/api/audit": {
      let qq = sb.from("activity").select("*").order("id", { ascending:false }).range(b.offset, b.offset + b.limit);
      const t = (b.q || "").replace(/[,()%*]/g, " ").trim();
      if (t) qq = qq.or(`summary.ilike.*${t}*,actor_name.ilike.*${t}*,entity_id.ilike.*${t}*`);
      const rows = await q(qq);
      return { items:rows.slice(0, b.limit).map(a => ({ ...a, at:ts(a.at), user_name:a.actor_name })), more:rows.length > b.limit };
    }
    case "/api/move-history":
      return (await q(sb.from("activity").select("*").eq("entity","move").eq("entity_id", String(b.id)).order("id"))).map(a => ({ ...a, at:ts(a.at) }));
    case "/api/users":
      return { users:await q(sb.from("profiles").select("*").order("created_at")) };
    case "/api/user-save": {
      if (b.id === S.me.id && (b.role !== "admin" || !b.active)) throw new Error("You can't remove your own admin access.");
      if (b.role === "crew" && !S.settings.subcontractors.includes(b.subcontractor)) throw new Error("Choose the crew member's company.");
      return q(sb.from("profiles").update({ name:(b.name||"").trim(), role:b.role, subcontractor:b.role === "crew" ? b.subcontractor : "", active:!!b.active && b.role !== "pending" }).eq("id", b.id));
    }
  }
  throw new Error("Unknown request " + path);
}
async function refresh() {
  const d = await api("/api/bootstrap");
  S.me = d.me; S.settings = d.settings; S.userNames = d.userNames; S.crewEditMinutes = d.crewEditMinutes;
  S.sites = d.sites; S.siteMap = new Map(d.sites.map(s => [s.id, s]));
  S.fleet = new Map(d.generators.map(g => [g.id, g])); S.moves = d.moves;
  if (S.me.mustChangePw) return showPwGate();
  render();
}

/* ---------------- sign in, sign up, password reset ---------------- */
const gates = ["#login","#signup","#forgot","#pwgate","#pending","#setup"];
function only(id){ gates.forEach(g => $(g).hidden = g !== id); $("#app").hidden = id !== "#app"; }
function showLogin(){ only("#login"); $("#le").focus(); }
function showPwGate(){ only("#pwgate"); $("#pn").focus(); }
function showApp(){ only("#app"); }
function showPending(prof, email){
  only("#pending");
  $("#pendingMsg").textContent = prof && prof.role !== "pending" && !prof.active
    ? "Your account has been switched off. Ask the admin if you need access again."
    : `You're signed up as ${email}. The admin needs to approve your account before you can see the log. Ask them to open People and approve you.`;
}
document.querySelectorAll("[data-goto]").forEach(a => a.onclick = e => { e.preventDefault(); only(a.dataset.goto); const f = $(a.dataset.goto + " input"); f && f.focus(); });
$("#loginForm").onsubmit = async e => {
  e.preventDefault(); $("#lerr").textContent = "";
  try { await q(sb.auth.signInWithPassword({ email:$("#le").value.trim(), password:$("#lp").value })); $("#lp").value = ""; await start(); }
  catch (x) { $("#lerr").textContent = x.message; }
};
$("#signupForm").onsubmit = async e => {
  e.preventDefault(); $("#serr").textContent = "";
  const name = $("#sn").value.trim(), email = $("#se").value.trim(), pw = $("#sp").value;
  if (!name) return $("#serr").textContent = "Enter your full name.";
  if (pw.length < 8) return $("#serr").textContent = "Use at least 8 characters for the password.";
  try {
    const d = await q(sb.auth.signUp({ email, password:pw, options:{ data:{ name }, emailRedirectTo:location.href.split("#")[0] } }));
    if (!d.session) { only("#pending"); $("#pendingMsg").textContent = `Check ${email} for a confirmation link, then sign in. After that, the admin approves your account.`; return; }
    await start();
  } catch (x) { $("#serr").textContent = x.message; }
};
$("#forgotForm").onsubmit = async e => {
  e.preventDefault(); $("#ferr").textContent = "";
  try { await q(sb.auth.resetPasswordForEmail($("#fe").value.trim(), { redirectTo:location.href.split("#")[0] })); $("#fmsg").textContent = "If that email has an account, a reset link is on its way. Open it on this device."; }
  catch (x) { $("#ferr").textContent = x.message; }
};
$("#pwForm").onsubmit = async e => {
  e.preventDefault(); $("#pwerr").textContent = "";
  if ($("#pn").value.length < 8) return $("#pwerr").textContent = "Use at least 8 characters.";
  try { await q(sb.auth.updateUser({ password:$("#pn").value })); $("#pn").value = ""; S.recovery = false; toast("Password saved."); history.replaceState(null, "", location.pathname); await start(); }
  catch (x) { $("#pwerr").textContent = x.message; }
};
$("#pendingOut").onclick = async () => { await sb.auth.signOut(); showLogin(); };
$("#pendingRetry").onclick = () => start();
async function start(){
  if (!sb) { only("#setup"); return; }
  try { await refresh(); if (S.me && !S.me.mustChangePw) { showApp(); buildTabs(); showTab(S.tab); } }
  catch {}
}
if (sb) sb.auth.onAuthStateChange(ev => { if (ev === "PASSWORD_RECOVERY") { S.recovery = true; showPwGate(); } });
let poll = setInterval(() => { if (!$("#app").hidden && document.visibilityState === "visible" && $("#scrim").hidden) refresh().catch(()=>{}); }, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#app").hidden) refresh().catch(()=>{}); });

/* ---------------- formatting ---------------- */
const fmtDT = t => t ? new Date(t).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "Not recorded";
const fmtD = t => t ? new Date(t).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) : "";
const hrs = ms => { const h = ms/36e5; return h < 1 ? Math.round(h*60)+" min" : h < 48 ? Math.round(h)+" h" : Math.round(h/24)+" days"; };
const isNum = v => typeof v === "number" && isFinite(v);
const who = id => (id && S.userNames[id]) || "Not recorded";
function siteLabel(id){
  if (!id) return "Unknown"; if (id === "TRANSIT") return "In transit";
  const s = S.siteMap.get(id); if (s && s.kind) return s.name; return "Site " + id;
}
function siteDesc(id){ const s = S.siteMap.get(id); if (!s) return ""; return [s.name, s.address, s.area].filter(Boolean).join(", "); }
/* Address shown under a site's name, so people know where a generator is going. */
function siteAddr(id){
  if (!id || id === "TRANSIT") return "";
  const s = S.siteMap.get(id); if (!s) return "Not on the site list";
  if (s.kind) return "";
  return [s.name, s.address, s.area].map(x => (x || "").replace(/[\s.,]+$/, "")).filter(Boolean).join(", ") || "Address not on file";
}
function siteBlock(id, extra){
  const a = siteAddr(id);
  return `<b>${esc(siteLabel(id))}${extra ? ` <span class="meta">${esc(extra)}</span>` : ""}</b>${a ? `<small class="addr">${esc(a)}</small>` : ""}`;
}
function routeHtml(m){
  const toId = m.to || m.plannedTo;
  const toExtra = m.to ? (m.plannedTo && m.plannedTo !== m.to ? "" : "") : m.plannedTo ? "(planned)" : "";
  return `<div class="legs">
    <div class="leg"><span class="leg-l">From</span><div class="leg-s">${siteBlock(m.from)}</div></div>
    <div class="leg"><span class="leg-l">To</span><div class="leg-s">${toId ? siteBlock(toId, toExtra) : `<b class="q">Destination not given</b>`}</div></div>
    ${m.to && m.plannedTo && m.plannedTo !== m.to ? `<div class="leg was"><span class="leg-l">Planned</span><div class="leg-s">${siteBlock(m.plannedTo)}</div></div>` : ""}
  </div>`;
}
function locKind(loc){ if (!loc) return "unk"; if (loc === "TRANSIT") return "transit"; const s = S.siteMap.get(loc); return s && s.kind ? "shop" : "site"; }
function locPill(g){ const k = locKind(g.loc); const t = k==="unk" ? "Not confirmed" : k==="transit" ? "In transit" : siteLabel(g.loc); return `<span class="pill ${k}">${esc(t)}</span>`; }
const genLine = g => [g.make, g.model, g.kva ? g.kva+" kVA" : "", g.service].filter(Boolean).join(", ");
const plate = tag => tag ? `<span class="plate">${esc(tag)}</span>` : `<span class="plate untagged">Untagged</span>`;
const moveTag = m => m.genId || "";
const moveGen = m => m.genId ? genLine(S.fleet.get(m.genId) || {}) : m.genLabel;

/* ---------------- exceptions (also used for reports) ---------------- */
function flagsFor(m, now = Date.now()){
  const f = [], st = S.settings;
  if (m.status === "cancelled") return f;
  if (!m.genId) f.push("Generator had no asset tag");
  if (m.status === "in_transit") {
    if (m.legacy) f.push("No drop-off recorded");
    else if (now - m.t0 > st.transitLimitHours*36e5) f.push("In transit " + hrs(now - m.t0));
  }
  if (m.locMismatch) f.push(`Register had it at ${siteLabel(m.locMismatch)}, not ${siteLabel(m.from)}`);
  if (m.status === "completed") {
    if (m.plannedTo && m.to && m.plannedTo !== m.to) f.push(`Went to ${siteLabel(m.to)}, planned ${siteLabel(m.plannedTo)}`);
    if (!m.t1) f.push("Arrival time not recorded");
    const p = m.pickup || {}, d = m.dropoff || {};
    if (isNum(p.runHours) && isNum(d.runHours)) {
      if (d.runHours < p.runHours) f.push("Run hours went down");
      else if (d.runHours - p.runHours > 1) f.push(`Engine ran ${+(d.runHours-p.runHours).toFixed(1)} h during the move`);
    }
  }
  return f;
}
function canEditMove(m){
  if (m.status === "cancelled" || m.legacy) return false;
  if (isStaff()) return true;
  return [m.createdBy, m.droppedBy].includes(S.me.id) && Date.now() - (m.t1 || m.t0) < S.crewEditMinutes*60000;
}

/* ---------------- toast & sheet ---------------- */
let toastT; function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500); }
let lastFocus = null;
function addSiteHints(root){
  root.querySelectorAll('input[list="dlSite"]').forEach(inp => {
    const h = document.createElement("div"); h.className = "hint addr-hint"; inp.after(h);
    const upd = () => { const v = inp.value.trim(); if (!v) { h.textContent = ""; return; } const id = parseSite(v);
      h.textContent = id ? siteLabel(id) + ": " + (siteAddr(id) || siteLabel(id)) : "Not on the site list."; h.classList.toggle("bad", !id); };
    inp.addEventListener("input", upd); inp.addEventListener("change", upd); upd(); inp._updAddr = upd;
  });
}
function openSheet(html, onMount){ lastFocus = document.activeElement; $("#sheet").innerHTML = html; $("#scrim").hidden = false; addSiteHints($("#sheet")); onMount && onMount($("#sheet")); const f = $("#sheet").querySelector("input:not([disabled]),select,textarea,button:not(.x)"); f && f.focus(); }
function closeSheet(){ $("#scrim").hidden = true; $("#sheet").innerHTML = ""; lastFocus && lastFocus.focus && lastFocus.focus(); }
$("#scrim").addEventListener("click", e => { if (e.target.id === "scrim" || e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#scrim").hidden) closeSheet(); });
const head = t => `<div class="sheet-head"><h2 id="sheetTitle">${t}</h2><button class="x" aria-label="Close" data-close>×</button></div>`;
const cancelBtn = `<button class="btn" data-close>Cancel</button>`;
async function busy(btn, label, fn){ const t = btn.textContent; btn.disabled = true; btn.textContent = label; try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; } }

/* ---------------- tabs ---------------- */
function buildTabs(){
  const tabs = [["fleet","Fleet"],["transit","In transit"],["log", isStaff() ? "Movement log" : "Our moves"]];
  if (isStaff()) tabs.push(["reports","Reports"],["activity","Activity"],["setup","Setup"]);
  if (isAdmin()) tabs.push(["people","People"]);
  $("#tabs").innerHTML = tabs.map(([k,l]) => `<button role="tab" data-tab="${k}" aria-selected="false">${l}${k==="transit"?` <span class="count" id="transitCount" hidden>0</span>`:""}</button>`).join("");
  $("#tabs").querySelectorAll("button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $("#whoami").textContent = S.me.name + (S.me.subcontractor ? ", " + S.me.subcontractor : "") + " (" + {admin:"Admin",engineer:"Ooredoo engineer",crew:"Crew"}[S.me.role] + ")";
  if (!tabs.some(t => t[0] === S.tab)) S.tab = "fleet";
  renderStrip();
}
function showTab(t){
  S.tab = t; refresh().catch(()=>{});
  $("#tabs").querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  document.querySelectorAll("main>section").forEach(s => s.hidden = s.id !== "tab-"+t);
  if (t === "reports") buildReport();
  if (t === "setup") renderSetup();
  if (t === "activity") loadActivity(true);
  if (t === "people") loadUsers();
}
$("#btnPickup").onclick = () => openPickup(null);
$("#btnMenu").onclick = () => openSheet(head("Your account") + `
  <dl class="kv"><dt>Name</dt><dd>${esc(S.me.name)}</dd><dt>Email</dt><dd>${esc(S.me.username)}</dd>
  <dt>Role</dt><dd>${esc({admin:"Admin",engineer:"Ooredoo engineer",crew:"Crew"}[S.me.role])}</dd>${S.me.subcontractor?`<dt>Company</dt><dd>${esc(S.me.subcontractor)}</dd>`:""}</dl>
  <h3>Change password</h3>
  <div class="field"><label for="cpo">Current password</label><input id="cpo" type="password" autocomplete="current-password"></div>
  <div class="field"><label for="cpn">New password</label><input id="cpn" type="password" autocomplete="new-password"></div>
  <div class="formerr" id="cperr" role="alert"></div>
  <div class="actions"><button class="btn" id="cpSave">Change password</button><button class="btn primary" id="logout">Sign out</button></div>`,
  el => {
    el.querySelector("#logout").onclick = async () => { await sb.auth.signOut().catch(()=>{}); closeSheet(); S.me = null; showLogin(); };
    el.querySelector("#cpSave").onclick = async () => {
      const err = el.querySelector("#cperr"), nw = el.querySelector("#cpn").value; err.textContent = "";
      if (nw.length < 8) return err.textContent = "Use at least 8 characters.";
      try { await q(sb.auth.signInWithPassword({ email:S.me.username, password:el.querySelector("#cpo").value })).catch(() => { throw new Error("Current password is wrong."); });
        await q(sb.auth.updateUser({ password:nw })); closeSheet(); toast("Password changed."); }
      catch(x){ err.textContent = x.message; } };
  });

/* ---------------- fleet ---------------- */
function render(){ renderStrip(); renderFleet(); renderTransit(); renderLog(); updateAreas(); }
function renderStrip(){
  const g = [...S.fleet.values()].filter(x => x.active);
  const c = {all:g.length, site:0, transit:0, shop:0, unk:0}; g.forEach(x => c[locKind(x.loc)]++);
  const items = [["all","All generators","var(--ink)"],["site","At a site","var(--green)"],["transit","In transit","var(--amber)"],["shop","Workshop or warehouse","var(--blue)"],["unk","Location not confirmed","var(--muted)"]];
  $("#strip").innerHTML = items.map(([k,l,col]) => `<button data-f="${k}" aria-pressed="${S.filter===k}"><b>${c[k]}</b><span><i class="dot" style="background:${col}"></i>${l}</span></button>`).join("");
  $("#strip").querySelectorAll("button").forEach(b => b.onclick = () => { S.filter = S.filter === b.dataset.f ? "all" : b.dataset.f; renderStrip(); renderFleet(); });
  const n = S.moves.filter(m => m.status === "in_transit" && !m.legacy).length, el = $("#transitCount");
  if (el) { el.textContent = n; el.hidden = !n; }
}
function updateAreas(){
  const areas = new Set(); S.sites.forEach(s => s.area && areas.add(s.area));
  const sel = $("#fArea"), cur = sel.value;
  sel.innerHTML = `<option value="">All areas</option>` + [...areas].sort().map(a => `<option${a===cur?" selected":""}>${esc(a)}</option>`).join("");
}
const byTag = (a,b) => a.id.localeCompare(b.id, undefined, {numeric:true});
function renderFleet(){
  const q = $("#q").value.trim().toLowerCase(), area = $("#fArea").value;
  let g = [...S.fleet.values()].filter(x => x.active).sort(byTag);
  if (S.filter !== "all") g = g.filter(x => locKind(x.loc) === S.filter);
  if (area) g = g.filter(x => (S.siteMap.get(x.loc) || {}).area === area);
  if (q) g = g.filter(x => [x.id, x.loc, x.make, x.model, x.kva && x.kva+"kva", siteDesc(x.loc), x.legacy].join(" ").toLowerCase().includes(q));
  $("#fleetList").innerHTML = g.length ? g.map(x => `<button class="row" data-g="${esc(x.id)}">${plate(x.id)}<span class="what"><b>${esc(genLine(x))}</b><small>${esc(x.loc && x.loc !== "TRANSIT" ? siteDesc(x.loc) || siteLabel(x.loc) : x.locNote || "")}</small></span><span class="right">${locPill(x)}${x.condition==="Faulty"?` <span class="pill faulty">Faulty</span>`:""}<br>${x.lastMovedAt ? "Moved "+fmtD(x.lastMovedAt) : ""}</span></button>`).join("")
    : `<div class="empty">${S.fleet.size ? "No generators match." : "No generators on the list yet."}</div>`;
  $("#fleetList").querySelectorAll(".row").forEach(r => r.onclick = () => openGen(r.dataset.g));
}
$("#q").addEventListener("input", renderFleet); $("#fArea").addEventListener("change", renderFleet);

/* ---------------- in transit & log ---------------- */
function tripCard(m){
  const fl = flagsFor(m), late = fl.some(x => x.startsWith("In transit") || x.startsWith("No drop"));
  const mayDrop = !m.legacy && (isStaff() || m.subcontractor === S.me.subcontractor);
  return `<div class="trip${late?" late":""}">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${plate(moveTag(m))}<span class="meta">${esc(moveGen(m))}</span></div>
    ${routeHtml(m)}
    <div class="meta">Picked up ${fmtDT(m.t0)} by ${esc(m.subcontractor || "Not recorded")}${m.crew ? ", "+esc(m.crew) : ""}${m.vehicle ? ", vehicle "+esc(m.vehicle) : ""}</div>
    ${fl.length ? `<div class="flags">${fl.map(x => `<span class="pill flag">${esc(x)}</span>`).join("")}</div>` : ""}
    <div class="actions">${m.legacy ? (isStaff() ? `<button class="btn small" data-closeold="${m.id}">Record where it went</button>` : "")
      : `<button class="btn small" data-detail="${m.id}">Details</button>${mayDrop ? `<button class="btn primary small" data-drop="${m.id}">Record drop-off</button>` : ""}`}</div>
  </div>`;
}
function renderTransit(){
  const open = S.moves.filter(m => m.status === "in_transit").sort((a,b) => a.t0 - b.t0);
  const live = open.filter(m => !m.legacy), old = open.filter(m => m.legacy);
  let h = live.length ? live.map(tripCard).join("") : `<div class="empty card">Nothing in transit right now. When a crew picks up a generator, it shows here until the drop-off is recorded.</div>`;
  if (old.length) h += `<h2>Never closed in the old schedule</h2><p class="meta">These pickups from the swap schedule have no destination. Find where each generator went and record it.</p>` + old.map(tripCard).join("");
  $("#transitList").innerHTML = h; wire($("#transitList"));
}
function wire(root){
  root.querySelectorAll("[data-drop]").forEach(b => b.onclick = e => { e.stopPropagation(); openDropoff(+b.dataset.drop); });
  root.querySelectorAll("[data-detail]").forEach(b => b.onclick = e => { e.stopPropagation(); openMove(+b.dataset.detail); });
  root.querySelectorAll("[data-closeold]").forEach(b => b.onclick = e => { e.stopPropagation(); openCloseLegacy(+b.dataset.closeold); });
}
function moveRow(m){
  const fl = flagsFor(m);
  const st = m.status === "in_transit" ? `<span class="pill transit">In transit</span>` : m.status === "cancelled" ? `<span class="pill unk">Cancelled</span>` : "";
  return `<button class="row" data-detail="${m.id}">${plate(moveTag(m))}<span class="what"><b>${esc(siteLabel(m.from))} to ${esc(m.to ? siteLabel(m.to) : m.plannedTo ? siteLabel(m.plannedTo) : "?")}</b>${(m.to || m.plannedTo) ? `<small class="addr">To: ${esc(siteAddr(m.to || m.plannedTo))}</small>` : ""}<small>${esc(m.subcontractor || "Not recorded")}${m.crew ? ", "+esc(m.crew) : ""}${m.legacy ? ", from the old swap schedule" : ""}</small></span><span class="right">${fmtDT(m.t0)}<br>${st}${fl.length ? ` <span class="pill flag">${fl.length} exception${fl.length>1?"s":""}</span>` : ""}</span></button>`;
}
function renderLog(){
  const q = $("#lq").value.trim().toLowerCase(), f = $("#lf").value;
  let m = [...S.moves].sort((a,b) => b.t0 - a.t0);
  if (f === "flag") m = m.filter(x => flagsFor(x).length);
  if (f === "open") m = m.filter(x => x.status === "in_transit");
  if (f === "mine") m = m.filter(x => x.createdBy === S.me.id || x.droppedBy === S.me.id);
  if (q) m = m.filter(x => [x.genId, x.genLabel, x.from, x.to, x.plannedTo, siteLabel(x.from), siteLabel(x.to), x.subcontractor, x.crew, x.vehicle].join(" ").toLowerCase().includes(q));
  const shown = m.slice(0, S.logLimit);
  $("#logList").innerHTML = shown.length ? shown.map(moveRow).join("") : `<div class="empty">${S.moves.length ? "No movements match." : "No movements recorded yet. Use Record pickup when a crew collects a generator."}</div>`;
  $("#logMore").hidden = m.length <= S.logLimit; wire($("#logList"));
}
$("#lq").addEventListener("input", renderLog); $("#lf").addEventListener("change", renderLog);
$("#logMore").onclick = () => { S.logLimit += 40; renderLog(); };

/* ---------------- details ---------------- */
function openGen(id){
  const g = S.fleet.get(id); if (!g) return;
  const hist = S.moves.filter(m => m.genId === id && m.status !== "cancelled").sort((a,b) => b.t0 - a.t0);
  const open = g.loc === "TRANSIT" ? S.moves.find(m => m.id === g.moveId) : null;
  const mayDrop = open && (isStaff() || open.subcontractor === S.me.subcontractor);
  openSheet(head(plate(g.id)) + `
    <dl class="kv"><dt>Generator</dt><dd>${esc(genLine(g))}</dd>
    <dt>Now</dt><dd>${locPill(g)} ${esc(g.loc && g.loc !== "TRANSIT" ? siteDesc(g.loc) : "")}</dd>
    <dt>Condition</dt><dd>${esc(g.condition || "Working")}</dd>
    ${g.locNote ? `<dt>Note</dt><dd>${esc(g.locNote)}</dd>` : ""}
    ${g.legacy ? `<dt>Old register</dt><dd>${esc(g.legacy)}</dd>` : ""}</dl>
    <div class="actions" style="justify-content:flex-start">
      ${mayDrop ? `<button class="btn primary" data-drop="${open.id}">Record drop-off</button>` : ""}
      ${g.loc !== "TRANSIT" ? `<button class="btn primary" id="gPick">Record pickup</button>` : ""}
      ${isStaff() ? `<button class="btn" id="gEdit">Edit details</button>` : ""}
    </div>
    <h3>Movement history</h3>
    ${hist.length ? `<div class="hist">${hist.map(m => `<div class="ev${m.status==="in_transit"?" open":""}"><b>${esc(siteLabel(m.from))} to ${esc(m.to ? siteLabel(m.to) : (m.plannedTo ? siteLabel(m.plannedTo)+" (planned)" : "?"))}</b>${(m.to || m.plannedTo) ? `<small class="addr">To: ${esc(siteAddr(m.to || m.plannedTo))}</small>` : ""}<div class="meta">${fmtDT(m.t0)}${m.t1 ? " to "+fmtDT(m.t1) : ""}, ${esc(m.subcontractor || "")}${m.crew ? ", "+esc(m.crew) : ""}</div>${flagsFor(m).map(x => `<span class="pill flag">${esc(x)}</span>`).join(" ")}<div><button class="btn small" data-detail="${m.id}" style="margin-top:6px">Details</button></div></div>`).join("")}</div>`
      : `<p class="meta">No moves recorded for this generator yet.</p>`}`,
  el => { el.querySelector("#gPick")?.addEventListener("click", () => openPickup(id)); el.querySelector("#gEdit")?.addEventListener("click", () => openGenForm(id)); wire(el); });
}
function openMove(id){
  const m = S.moves.find(x => x.id === id); if (!m) return;
  const p = m.pickup || {}, d = m.dropoff || {}, fl = flagsFor(m);
  const mayDrop = m.status === "in_transit" && !m.legacy && (isStaff() || m.subcontractor === S.me.subcontractor);
  openSheet(head("Movement #" + m.id) + `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${plate(moveTag(m))}<span class="meta">${esc(moveGen(m))}</span></div>
    ${routeHtml(m)}
    ${fl.length ? `<div class="flags">${fl.map(x => `<span class="pill flag">${esc(x)}</span>`).join("")}</div>` : ""}
    <dl class="kv"><dt>Reason</dt><dd>${esc(m.reason || "")}</dd><dt>Subcontractor</dt><dd>${esc(m.subcontractor || "")}</dd>
    <dt>Crew lead</dt><dd>${esc(m.crew || "Not recorded")}</dd><dt>Vehicle</dt><dd>${esc(m.vehicle || "Not recorded")}</dd>
    ${m.note ? `<dt>Note</dt><dd>${esc(m.note)}</dd>` : ""}</dl>
    <h3>Pickup</h3><dl class="kv"><dt>Time</dt><dd>${fmtDT(m.t0)}</dd>
    ${m.legacy ? "" : `<dt>Run hours</dt><dd>${isNum(p.runHours) ? p.runHours : "Not recorded"}</dd><dt>Recorded by</dt><dd>${esc(who(m.createdBy))}</dd>`}
    ${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ""}</dl>
    ${m.status === "completed" ? `<h3>Drop-off</h3><dl class="kv"><dt>Time</dt><dd>${fmtDT(m.t1)}</dd>
    ${m.legacy ? "" : `<dt>Run hours</dt><dd>${isNum(d.runHours) ? d.runHours : "Not recorded"}</dd><dt>Condition</dt><dd>${esc(d.condition || "")}</dd><dt>Recorded by</dt><dd>${esc(who(m.droppedBy))}</dd>`}
    ${d.note ? `<dt>Note</dt><dd>${esc(d.note)}</dd>` : ""}</dl>` : ""}
    ${isStaff() && !m.legacy ? `<h3>Change history</h3><div id="mHist"><p class="meta">Loading…</p></div>` : ""}
    <div class="actions">
      ${canEditMove(m) ? `<button class="btn" id="mEdit">Correct this entry</button>` : ""}
      ${m.status === "in_transit" && !m.legacy && isStaff() ? `<button class="btn danger" id="mCancel">Cancel pickup</button>` : ""}
      ${m.status === "in_transit" && m.legacy && isStaff() ? `<button class="btn primary" data-closeold="${m.id}">Record where it went</button>` : ""}
      ${mayDrop ? `<button class="btn primary" data-drop="${m.id}">Record drop-off</button>` : ""}
    </div>`,
  el => { wire(el); if (isStaff() && !m.legacy) loadMoveHistory(m.id, el); el.querySelector("#mEdit")?.addEventListener("click", () => openEditMove(m.id)); el.querySelector("#mCancel")?.addEventListener("click", () => openCancel(m.id)); });
}

/* ---------------- forms ---------------- */
const genOpts = () => [...S.fleet.values()].filter(g => g.active).sort(byTag).map(g => `<option value="${esc(g.id)}">${esc(genLine(g))}, ${esc(g.loc === "TRANSIT" ? "in transit" : g.loc ? siteLabel(g.loc) : "location not confirmed")}</option>`).join("");
const siteOpts = () => S.sites.map(s => `<option value="${esc(s.id)}">${esc([s.name, s.address, s.area].filter(Boolean).join(", ").slice(0,90))}</option>`).join("");
function parseGen(v){ v = (v||"").trim().toUpperCase(); if (!v) return null; const all = [...S.fleet.values()].filter(g => g.active);
  return all.find(x => x.id === v) || (/^\d+$/.test(v) ? all.find(x => x.id.endsWith("-"+v.padStart(3,"0")) || x.id.endsWith("-"+v.padStart(2,"0"))) : null) || null; }
function parseSite(v){ v = (v||"").trim(); if (!v) return ""; if (/^\d+$/.test(v)) v = v.padStart(4,"0"); const s = S.sites.find(x => x.id.toUpperCase() === v.toUpperCase()); return s ? s.id : null; }

function openPickup(genId){
  const g = genId ? S.fleet.get(genId) : null, crew = S.me.role === "crew";
  openSheet(head("Record pickup") + `
    <datalist id="dlGen">${genOpts()}</datalist><datalist id="dlSite">${siteOpts()}</datalist>
    <div class="field"><label for="pGen">Generator tag</label><input id="pGen" list="dlGen" autocomplete="off" placeholder="e.g. OQ-DG-014 or just 14" value="${esc(g ? g.id : "")}"><div class="hint" id="pGenHint"></div></div>
    <div class="grid2">
      <div class="field"><label for="pFrom">Picked up from</label><input id="pFrom" list="dlSite" autocomplete="off" placeholder="Site number"></div>
      <div class="field"><label for="pTo">Going to</label><input id="pTo" list="dlSite" autocomplete="off" placeholder="Site, WS-01 or warehouse"></div>
    </div>
    <div class="field"><label for="pReason">Reason</label><select id="pReason">${S.settings.reasons.map(r => `<option>${esc(r)}</option>`).join("")}</select></div>
    ${crew ? `<p class="meta">Recorded as ${esc(S.me.name)}, ${esc(S.me.subcontractor)}.</p>` : `<div class="grid2">
      <div class="field"><label for="pSub">Subcontractor</label><select id="pSub">${S.settings.subcontractors.map(s => `<option>${esc(s)}</option>`).join("")}</select></div>
      <div class="field"><label for="pCrew">Crew lead name</label><input id="pCrew"></div></div>`}
    <div class="grid2">
      <div class="field"><label for="pVeh">Vehicle plate</label><input id="pVeh" autocapitalize="characters"></div>
      <div class="field"><label for="pRH">Run-hour meter</label><input id="pRH" inputmode="decimal" placeholder="e.g. 12450.5"></div>
    </div>
    <div class="field"><label for="pNote">Note</label><textarea id="pNote" placeholder="Anything unusual"></textarea></div>
    <div class="formerr" id="pErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="pSave">Record pickup</button></div>`,
  el => {
    const hint = () => { const x = parseGen(el.querySelector("#pGen").value), h = el.querySelector("#pGenHint");
      if (!x) { h.textContent = ""; return; }
      h.textContent = x.id + ": " + genLine(x) + ". " + (x.loc === "TRANSIT" ? "Already in transit, so record its drop-off first." : x.loc ? "Register has it at " + siteLabel(x.loc) + "." : "Location not confirmed yet.");
      const f = el.querySelector("#pFrom"); if (!f.dataset.touched && x.loc && x.loc !== "TRANSIT") { f.value = x.loc; f._updAddr && f._updAddr(); } };
    el.querySelector("#pGen").addEventListener("input", hint); el.querySelector("#pFrom").addEventListener("input", e => e.target.dataset.touched = 1); hint();
    el.querySelector("#pSave").onclick = e => busy(e.target, "Saving…", async () => {
      const err = el.querySelector("#pErr"); err.textContent = "";
      const g = parseGen(el.querySelector("#pGen").value);
      if (!g) return err.textContent = "Choose a generator tag from the list.";
      try {
        await api("/api/pickup", { genId:g.id, from:el.querySelector("#pFrom").value, plannedTo:el.querySelector("#pTo").value,
          reason:el.querySelector("#pReason").value, subcontractor:el.querySelector("#pSub")?.value, crew:el.querySelector("#pCrew")?.value,
          vehicle:el.querySelector("#pVeh").value, runHours:el.querySelector("#pRH").value, note:el.querySelector("#pNote").value });
        closeSheet(); toast("Pickup recorded for " + g.id + "."); refresh();
      } catch (x) { err.textContent = x.message; }
    });
  });
}
function openDropoff(id){
  const m = S.moves.find(x => x.id === id); if (!m) return;
  openSheet(head("Record drop-off") + `<datalist id="dlSite">${siteOpts()}</datalist>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${plate(moveTag(m))}<span class="meta">picked up ${fmtDT(m.t0)}</span></div>
    ${routeHtml(m)}
    <div class="field" style="margin-top:14px"><label for="dTo">Dropped at</label><input id="dTo" list="dlSite" autocomplete="off" value="${esc(m.plannedTo || "")}">${m.plannedTo ? `<div class="hint">Planned: ${esc(siteLabel(m.plannedTo))}. Change it if the generator went somewhere else.</div>` : ""}</div>
    <div class="grid2">
      <div class="field"><label for="dRH">Run-hour meter</label><input id="dRH" inputmode="decimal" placeholder="${isNum((m.pickup||{}).runHours) ? "At pickup: "+m.pickup.runHours : ""}"></div>
      <div class="field"><label for="dCond">Condition after drop-off</label><select id="dCond"><option>Installed and running</option><option>Installed, on standby</option><option>Not installed</option><option>Faulty</option></select></div>
    </div>
    <div class="field"><label for="dNote">Note</label><textarea id="dNote"></textarea></div>
    <div class="formerr" id="dErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="dSave">Record drop-off</button></div>`,
  el => { el.querySelector("#dSave").onclick = e => busy(e.target, "Saving…", async () => {
    const err = el.querySelector("#dErr"); err.textContent = "";
    try {
      await api(`/api/moves/${id}/dropoff`, { to:el.querySelector("#dTo").value, runHours:el.querySelector("#dRH").value,
        condition:el.querySelector("#dCond").value, note:el.querySelector("#dNote").value });
      closeSheet(); toast("Drop-off recorded."); refresh();
    } catch (x) { err.textContent = x.message; }
  }); });
}
function openEditMove(id){
  const m = S.moves.find(x => x.id === id); if (!m) return; const p = m.pickup || {}, d = m.dropoff || {}, done = m.status === "completed";
  openSheet(head("Correct movement #" + m.id) + `<datalist id="dlSite">${siteOpts()}</datalist>
    <p class="meta">Your name, the old value and the new value are saved in the change history.${S.me.role === "crew" ? ` You can correct your own entries for ${Math.round(S.crewEditMinutes/60)} hours.` : ""}</p>
    <div class="grid2"><div class="field"><label for="ePlan">Planned destination</label><input id="ePlan" list="dlSite" value="${esc(m.plannedTo)}"></div>
    ${done ? `<div class="field"><label for="eTo">Dropped at</label><input id="eTo" list="dlSite" value="${esc(m.to)}"></div>` : ""}</div>
    <div class="grid2"><div class="field"><label for="eReason">Reason</label><select id="eReason">${S.settings.reasons.map(r => `<option${r===m.reason?" selected":""}>${esc(r)}</option>`).join("")}</select></div>
    <div class="field"><label for="eVeh">Vehicle plate</label><input id="eVeh" value="${esc(m.vehicle)}"></div></div>
    ${isStaff() ? `<div class="field"><label for="eCrew">Crew lead</label><input id="eCrew" value="${esc(m.crew)}"></div>` : ""}
    <div class="grid2"><div class="field"><label for="ePRH">Run hours at pickup</label><input id="ePRH" inputmode="decimal" value="${isNum(p.runHours)?p.runHours:""}"></div>
    ${done ? `<div class="field"><label for="eDRH">Run hours at drop-off</label><input id="eDRH" inputmode="decimal" value="${isNum(d.runHours)?d.runHours:""}"></div>` : ""}</div>
    <div class="field"><label for="eNote">Note</label><textarea id="eNote">${esc(m.note)}</textarea></div>
    <div class="field"><label for="eWhy">Why are you correcting it?</label><input id="eWhy" placeholder="e.g. Crew read the wrong meter"><div class="hint">Saved in the change history with your name.</div></div>
    <div class="formerr" id="eErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="eSave">Save correction</button></div>`,
  el => { el.querySelector("#eSave").onclick = e => busy(e.target, "Saving…", async () => {
    const b = { plannedTo:el.querySelector("#ePlan").value, reason:el.querySelector("#eReason").value, vehicle:el.querySelector("#eVeh").value,
      note:el.querySelector("#eNote").value, pickupRunHours:el.querySelector("#ePRH").value, why:el.querySelector("#eWhy").value };
    if (done) Object.assign(b, { to:el.querySelector("#eTo").value, dropoffRunHours:el.querySelector("#eDRH").value });
    if (el.querySelector("#eCrew")) b.crew = el.querySelector("#eCrew").value;
    try { await api(`/api/moves/${id}/edit`, b); closeSheet(); toast("Correction saved."); refresh(); } catch (x) { el.querySelector("#eErr").textContent = x.message; }
  }); });
}
function openCancel(id){
  const m = S.moves.find(x => x.id === id); if (!m) return;
  openSheet(head("Cancel pickup") + `<p>The generator goes back to ${esc(siteLabel(m.from))} on the register. The pickup stays in the log, marked cancelled.</p>
    <div class="field"><label for="cR">Why?</label><input id="cR" placeholder="e.g. Recorded on the wrong generator"></div>
    <div class="formerr" id="cErr" role="alert"></div><div class="actions"><button class="btn" data-close>Keep it</button><button class="btn danger" id="cGo">Cancel pickup</button></div>`,
  el => el.querySelector("#cGo").onclick = async () => { try { await api(`/api/moves/${id}/cancel`, {reason:el.querySelector("#cR").value}); closeSheet(); toast("Pickup cancelled."); refresh(); } catch (x) { el.querySelector("#cErr").textContent = x.message; } });
}
function openCloseLegacy(id){
  const m = S.moves.find(x => x.id === id); if (!m) return;
  openSheet(head("Record where it went") + `<datalist id="dlSite">${siteOpts()}</datalist>
    <p class="meta">${esc(m.genLabel)}, picked up from ${esc(siteLabel(m.from))} on ${fmtD(m.t0)}.</p>
    <div class="field"><label for="lTo">Went to</label><input id="lTo" list="dlSite" autocomplete="off"></div>
    <div class="field"><label for="lD">Arrival date, if known</label><input type="date" id="lD"></div>
    <div class="formerr" id="lErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="lSave">Save</button></div>`,
  el => el.querySelector("#lSave").onclick = async () => { const d = el.querySelector("#lD").value;
    try { await api(`/api/moves/${id}/close-legacy`, { to:el.querySelector("#lTo").value, t1:d ? new Date(d+"T09:00").getTime() : null }); closeSheet(); toast("Saved."); refresh(); }
    catch (x) { el.querySelector("#lErr").textContent = x.message; } });
}
function nextTag(){ let n = 0; S.fleet.forEach(g => { const m = /^OQ-DG-(\d+)$/.exec(g.id); if (m) n = Math.max(n, +m[1]); }); return "OQ-DG-" + String(n+1).padStart(3,"0"); }
function openGenForm(id){
  const g = id ? S.fleet.get(id) : { kind:"DG", condition:"Working", service:"Dedicated", active:true };
  openSheet(head(id ? "Edit " + esc(id) : "Add generator") + `<datalist id="dlSite">${siteOpts()}</datalist>
    <div class="grid2"><div class="field"><label for="gTag">Asset tag</label><input id="gTag" value="${esc(id || nextTag())}" ${id ? "disabled" : ""}></div>
    <div class="field"><label for="gKind">Type</label><select id="gKind"><option value="DG"${g.kind==="DG"?" selected":""}>Site generator</option><option value="MDG"${g.kind==="MDG"?" selected":""}>Mobile generator</option></select></div></div>
    <div class="grid2"><div class="field"><label for="gMake">Make</label><input id="gMake" value="${esc(g.make || "")}"></div><div class="field"><label for="gModel">Model</label><input id="gModel" value="${esc(g.model || "")}"></div></div>
    <div class="grid2"><div class="field"><label for="gKva">Capacity (kVA)</label><input id="gKva" inputmode="numeric" value="${esc(g.kva || "")}"></div>
    <div class="field"><label for="gSvc">Service</label><select id="gSvc">${["Dedicated","Standby","Backup"].map(s => `<option${g.service===s?" selected":""}>${s}</option>`).join("")}</select></div></div>
    <div class="grid2"><div class="field"><label for="gCond">Condition</label><select id="gCond">${["Working","Faulty"].map(s => `<option${g.condition===s?" selected":""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label for="gLoc">Current location</label><input id="gLoc" list="dlSite" value="${esc(g.loc === "TRANSIT" ? "" : g.loc || "")}" ${g.loc === "TRANSIT" ? `disabled placeholder="In transit"` : `placeholder="Blank if not confirmed"`}><div class="hint">For correcting the register after a site audit. Record moves with pickup and drop-off.</div></div></div>
    <div class="field"><label for="gNote">Note</label><textarea id="gNote">${esc(g.locNote || "")}</textarea></div>
    ${id ? `<label class="check"><input type="checkbox" id="gActive" ${g.active ? "checked" : ""}> In service (untick if scrapped or sold)</label>` : ""}
    <div class="formerr" id="gErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="gSave">${id ? "Save changes" : "Add generator"}</button></div>`,
  el => el.querySelector("#gSave").onclick = async () => {
    const b = { id:el.querySelector("#gTag").value, isNew:!id, kind:el.querySelector("#gKind").value, make:el.querySelector("#gMake").value, model:el.querySelector("#gModel").value,
      kva:el.querySelector("#gKva").value, service:el.querySelector("#gSvc").value, condition:el.querySelector("#gCond").value, loc:el.querySelector("#gLoc").value,
      locNote:el.querySelector("#gNote").value, active:id ? el.querySelector("#gActive").checked : true };
    try { await api("/api/generators", b); closeSheet(); toast(id ? "Saved." : "Added " + b.id.toUpperCase() + "."); refresh(); } catch (x) { el.querySelector("#gErr").textContent = x.message; }
  });
}
function openSiteForm(id){
  const s = id ? S.siteMap.get(id) : {};
  openSheet(head(id ? "Edit site " + esc(id) : "Add site") + `
    <div class="grid2"><div class="field"><label for="aId">Site number</label><input id="aId" inputmode="numeric" value="${esc(id || "")}" ${id ? "disabled" : ""}></div><div class="field"><label for="aArea">Area</label><input id="aArea" value="${esc(s.area || "")}" placeholder="e.g. Ahmadi"></div></div>
    <div class="field"><label for="aName">Name</label><input id="aName" value="${esc(s.name || "")}"></div>
    <div class="field"><label for="aAddr">Address</label><textarea id="aAddr">${esc(s.address || "")}</textarea></div>
    <div class="grid2"><div class="field"><label for="aAcc">Access</label><input id="aAcc" value="${esc(s.access || "")}" placeholder="e.g. KOC, Boat, No access issue"></div><div class="field"><label for="aScope">Scope</label><input id="aScope" value="${esc(s.scope || "")}"></div></div>
    <div class="formerr" id="aErr" role="alert"></div><div class="actions">${cancelBtn}<button class="btn primary" id="aSave">${id ? "Save site" : "Add site"}</button></div>`,
  el => el.querySelector("#aSave").onclick = async () => {
    try { await api("/api/sites", { id:el.querySelector("#aId").value, isNew:!id, name:el.querySelector("#aName").value, address:el.querySelector("#aAddr").value,
      area:el.querySelector("#aArea").value, access:el.querySelector("#aAcc").value, scope:el.querySelector("#aScope").value }); closeSheet(); toast("Site saved."); refresh(); }
    catch (x) { el.querySelector("#aErr").textContent = x.message; }
  });
}

/* ---------------- setup ---------------- */
function renderSetup(){
  $("#rulesCard").hidden = !isAdmin();
  $("#sLimit").value = S.settings.transitLimitHours; $("#sEdit").value = S.crewEditMinutes;
  $("#sSubs").value = S.settings.subcontractors.join("\n"); $("#sReasons").value = S.settings.reasons.join("\n");
  $("#siteCount").textContent = S.sites.length + " sites, including the DG workshop and the Amghara warehouse.";
}
const lines = v => v.split("\n").map(s => s.trim()).filter(Boolean);
$("#sSave").onclick = async () => {
  try { await api("/api/settings", { transitLimitHours:$("#sLimit").value, crewEditMinutes:$("#sEdit").value, subcontractors:lines($("#sSubs").value), reasons:lines($("#sReasons").value) }); toast("Rules saved."); refresh(); }
  catch (x) { toast(x.message); }
};
$("#sAddGen").onclick = () => openGenForm(null);
$("#sAddSite").onclick = () => openSiteForm(null);
$("#sEditSite").onclick = () => openSheet(head("Edit a site") + `<datalist id="dlSite">${siteOpts()}</datalist><div class="field"><label for="es">Site number</label><input id="es" list="dlSite"></div><div class="formerr" id="esErr"></div><div class="actions">${cancelBtn}<button class="btn primary" id="esGo">Open</button></div>`,
  el => el.querySelector("#esGo").onclick = () => { const id = parseSite(el.querySelector("#es").value); if (!id) return el.querySelector("#esErr").textContent = "Choose a site from the list."; openSiteForm(id); });

function download(name, data, type){
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], {type}));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$("#sLabels").onclick = () => {
  if (!window.QRCode) return toast("The QR code tool didn't load. Check the internet connection and reload.");
  const gens = [...S.fleet.values()].filter(g => g.active).sort(byTag), box = $("#qrScratch");
  const cells = gens.map(g => { box.innerHTML = ""; new QRCode(box, {text:g.id, width:220, height:220, correctLevel:QRCode.CorrectLevel.M}); const c = box.querySelector("canvas");
    return `<div class="l"><div class="t">${esc(g.id)}</div>${c ? `<img src="${c.toDataURL("image/png")}" alt="">` : ""}<div class="m">${esc(genLine(g))}</div><div class="o">Ooredoo Kuwait property. Every move must be logged.</div></div>`; });
  download("DG-asset-labels.html", `<!doctype html><html><head><meta charset="utf-8"><title>DG asset labels</title><style>@page{size:A4;margin:10mm}body{font-family:Arial,sans-serif;margin:0}.g{display:grid;grid-template-columns:1fr 1fr;gap:6mm}.l{border:2px solid #000;border-radius:3mm;padding:4mm;text-align:center;break-inside:avoid}.t{font:900 28pt "Arial Narrow",Arial,sans-serif;letter-spacing:1px}.l img{width:32mm;height:32mm;margin:2mm auto;display:block}.m{font-size:10pt}.o{font-size:8pt;margin-top:2mm;color:#333}</style></head><body><div class="g">${cells.join("")}</div><script>print()<\/script></body></html>`, "text/html");
};

/* ---------------- people (admin) ---------------- */
// People sign themselves up on the website. New accounts wait here until an admin approves them.
let USERS = [];
const ROLE = { pending:"Waiting for approval", admin:"Admin", engineer:"Ooredoo engineer", crew:"Crew" };
async function loadUsers(){ try { USERS = (await api("/api/users")).users; renderUsers(); } catch (x) { $("#userList").innerHTML = `<div class="empty">${esc(x.message)}</div>`; } }
function renderUsers(){
  const qv = $("#uq").value.trim().toLowerCase();
  const list = USERS.filter(u => !qv || [u.name, u.email, u.subcontractor, u.role].join(" ").toLowerCase().includes(qv))
    .sort((x, y) => (x.role === "pending" ? 0 : 1) - (y.role === "pending" ? 0 : 1));
  $("#userList").innerHTML = list.length ? list.map(u => `<button class="row" data-u="${esc(u.id)}" style="grid-template-columns:1fr auto"><span class="what"><b>${esc(u.name || u.email)}</b><small>${esc(u.email)}, ${ROLE[u.role]}${u.subcontractor ? ", " + esc(u.subcontractor) : ""}</small></span><span class="right">${u.role === "pending" ? `<span class="pill transit">Approve</span>` : u.active ? "Joined " + fmtD(ts(u.created_at)) : `<span class="pill unk">Switched off</span>`}</span></button>`).join("") : `<div class="empty">No people match.</div>`;
  $("#userList").querySelectorAll(".row").forEach(r => r.onclick = () => openUser(r.dataset.u));
}
$("#uq").addEventListener("input", renderUsers);
$("#uAdd").onclick = () => {
  const link = location.href.split("#")[0];
  openSheet(head("Invite someone") + `<p>Send them this link. They tap <b>Create an account</b>, then you approve them here and choose their role.</p>
    <div class="secret" style="font-size:16px">${esc(link)}</div>
    <div class="actions"><button class="btn" id="cpInv">Copy invite message</button><button class="btn primary" data-close>Done</button></div>`,
    el => el.querySelector("#cpInv").onclick = () => navigator.clipboard?.writeText(`You're invited to the DG Movement Log.\nOpen ${link}, tap "Create an account", and sign up with your work email. I'll approve you after.`).then(() => toast("Copied."), () => toast("Copy didn't work. Select the link instead.")));
};
function openUser(id){
  const u = USERS.find(x => x.id === id); if (!u) return;
  const role = u.role === "pending" ? "crew" : u.role;
  openSheet(head(esc(u.name || u.email)) + `
    <p class="meta">${esc(u.email)}${u.role === "pending" ? ". Waiting for approval." : ""}</p>
    <div class="field"><label for="uName">Full name</label><input id="uName" value="${esc(u.name || "")}"></div>
    <div class="grid2"><div class="field"><label for="uRole">Role</label><select id="uRole"><option value="crew">Crew (subcontractor)</option><option value="engineer">Ooredoo engineer</option><option value="admin">Admin</option></select>
      <div class="hint">Crews record moves for their own company. Engineers also see reports and the change history. Admins also manage people and rules.</div></div>
    <div class="field" id="uSubF"><label for="uSub">Company</label><select id="uSub">${S.settings.subcontractors.map(s => `<option${s===u.subcontractor?" selected":""}>${esc(s)}</option>`).join("")}</select></div></div>
    <label class="check"><input type="checkbox" id="uActive" ${u.active || u.role === "pending" ? "checked" : ""}> Can use the log</label>
    <div class="formerr" id="uErr" role="alert"></div>
    <div class="actions">${cancelBtn}<button class="btn primary" id="uSave">${u.role === "pending" ? "Approve" : "Save"}</button></div>`,
  el => {
    el.querySelector("#uRole").value = role;
    const sync = () => el.querySelector("#uSubF").hidden = el.querySelector("#uRole").value !== "crew"; sync(); el.querySelector("#uRole").onchange = sync;
    el.querySelector("#uSave").onclick = async () => {
      try {
        await api("/api/user-save", { id, name:el.querySelector("#uName").value, role:el.querySelector("#uRole").value, subcontractor:el.querySelector("#uSub").value, active:el.querySelector("#uActive").checked });
        closeSheet(); toast(u.role === "pending" ? "Approved." : "Saved."); await loadUsers(); refresh();
      } catch (x) { el.querySelector("#uErr").textContent = x.message; }
    };
  });
}

/* change history for one movement (shown inside its details) */
async function loadMoveHistory(id, el){
  const box = el.querySelector("#mHist"); if (!box) return;
  try {
    const items = await api("/api/move-history", { id });
    box.innerHTML = items.length ? `<div class="hist">${items.map(a => `<div class="ev"><b>${esc(a.summary)}</b><div class="meta">${esc(a.actor_name)}, ${fmtDT(a.at)}</div>${a.changes && a.action === "correct" ? `<table class="diff"><tbody>${Object.entries(a.changes).map(([k, v]) => `<tr><th>${esc(k)}</th><td><s>${esc(v.from ?? "blank") || "blank"}</s></td><td>${esc(v.to ?? "blank") || "blank"}</td></tr>`).join("")}</tbody></table>` : ""}</div>`).join("")}</div>` : `<p class="meta">No changes recorded.</p>`;
  } catch (x) { box.innerHTML = `<p class="meta">${esc(x.message)}</p>`; }
}

/* ---------------- activity (staff) ---------------- */
let actOff = 0, actItems = [], actTimer;
async function loadActivity(reset){
  if (reset) { actOff = 0; actItems = []; }
  try {
    const r = await api("/api/audit", { limit:100, offset:actOff, q:$("#aq").value.trim() });
    actItems = actItems.concat(r.items); actOff += r.items.length; $("#actMore").hidden = !r.more;
    const icon = {correct:"Correction", signup:"Sign-up", delete:"Deleted", pickup:"Pickup", dropoff:"Drop-off", edit:"Change", cancel:"Cancelled", create:"Added", login:"Sign-in", password:"Password", import:"Import"};
    $("#actList").innerHTML = actItems.length ? actItems.map(a => `<div class="row plain"><span class="what"><b>${esc(a.summary)}</b><small>${esc(a.user_name)}</small></span><span class="right">${esc(fmtDT(a.at))}<br><span class="pill ${a.action==="cancel"||a.action==="edit"?"transit":"unk"}">${esc(icon[a.action] || a.action)}</span></span></div>`).join("") : `<div class="empty">Nothing found.</div>`;
  } catch (x) { $("#actList").innerHTML = `<div class="empty">${esc(x.message)}</div>`; }
}
$("#aq").addEventListener("input", () => { clearTimeout(actTimer); actTimer = setTimeout(() => loadActivity(true), 300); });
$("#actMore").onclick = () => loadActivity(false);

/* ---------------- reports (staff) ---------------- */
const pad = n => String(n).padStart(2,"0");
const isoDay = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
$("#repDate").value = isoDay(new Date());
let repKind = "day", repData = null;
$("#repKind").querySelectorAll("button").forEach(b => b.onclick = () => { repKind = b.dataset.k; $("#repKind").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); $("#repDateLbl").textContent = repKind === "day" ? "Day" : "Any day in the week"; buildReport(); });
$("#repDate").addEventListener("change", buildReport);
function range(){
  const d = $("#repDate").value ? new Date($("#repDate").value+"T00:00") : new Date(); d.setHours(0,0,0,0);
  const s = new Date(d); let e;
  if (repKind === "week") { s.setDate(d.getDate() - d.getDay()); e = new Date(s); e.setDate(s.getDate()+7); } else { e = new Date(s); e.setDate(s.getDate()+1); }
  return { s:s.getTime(), e:e.getTime(), label: repKind === "day" ? fmtD(s.getTime()) : `Week of ${fmtD(s.getTime())} to ${fmtD(e.getTime()-1)}` };
}
async function buildReport(){
  const r = range(); $("#report").innerHTML = `<div class="empty">Building report…</div>`; $("#repExport").disabled = true;
  let all; try { all = (await api("/api/report", { end:r.e })).moves; } catch (x) { $("#report").innerHTML = `<div class="notice err">${esc(x.message)}</div>`; return; }
  const inR = t => t && t >= r.s && t < r.e, now = Math.min(Date.now(), r.e);
  const moves = all.filter(m => inR(m.t0) || inR(m.t1) || (m.status === "in_transit") || (m.t1 && m.t1 >= r.e));
  const rows = moves.map(m => ({ m, tag:m.genId || "Untagged", gen:moveGen(m), flags:flagsFor(m, now),
    stateAtEnd: m.status === "completed" && (!m.t1 || m.t1 < r.e) ? "Delivered" : "In transit" }));
  const started = rows.filter(x => inR(x.m.t0)), done = rows.filter(x => inR(x.m.t1)), open = rows.filter(x => x.stateAtEnd === "In transit"), flagged = rows.filter(x => x.flags.length);
  const subs = {}; rows.forEach(x => { const k = x.m.subcontractor || "Not recorded"; const o = subs[k] || (subs[k] = {started:0,done:0,open:0,flags:0,moves:0}); o.moves++; if (inR(x.m.t0)) o.started++; if (inR(x.m.t1)) o.done++; if (x.stateAtEnd === "In transit") o.open++; if (x.flags.length) o.flags++; });
  repData = { r, rows, subs, counts:{started:started.length, done:done.length, open:open.length, flagged:flagged.length} };
  $("#repExport").disabled = false; $("#repExport").textContent = window.XLSX ? "Export to Excel" : "Export to CSV";
  const cell = (id, extra) => id ? `${esc(siteLabel(id))}${extra || ""}${siteAddr(id) ? `<small class="addr">${esc(siteAddr(id))}</small>` : ""}` : "?";
  const tr = x => `<tr><td>${esc(x.tag)}</td><td class="site">${cell(x.m.from)}</td><td class="site">${x.m.to ? cell(x.m.to) : cell(x.m.plannedTo, " (planned)")}</td><td>${fmtDT(x.m.t0)}</td><td>${x.m.status === "completed" ? fmtDT(x.m.t1) : "In transit"}</td><td>${esc(x.m.subcontractor || "")}</td><td>${esc(x.m.crew || "")}</td><td>${x.flags.map(f => `<span class="pill flag">${esc(f)}</span>`).join(" ")}</td></tr>`;
  $("#report").innerHTML = `<h2>${esc(r.label)}</h2>
    <div class="figs"><div class="fig"><b>${started.length}</b><span>Pickups</span></div><div class="fig"><b>${done.length}</b><span>Drop-offs</span></div><div class="fig"><b>${open.length}</b><span>Still in transit at period end</span></div><div class="fig${flagged.length ? " warn" : ""}"><b>${flagged.length}</b><span>Moves with exceptions</span></div></div>
    ${rows.length ? `<h3>By subcontractor</h3><div class="tbl-wrap"><table><thead><tr><th>Subcontractor</th><th class="num">Pickups</th><th class="num">Drop-offs</th><th class="num">Open</th><th class="num">With exceptions</th></tr></thead><tbody>${Object.entries(subs).sort((a,b) => b[1].moves - a[1].moves).map(([k,o]) => `<tr><td>${esc(k)}</td><td class="num">${o.started}</td><td class="num">${o.done}</td><td class="num">${o.open}</td><td class="num">${o.flags}</td></tr>`).join("")}</tbody></table></div>
    <h3>Movements</h3><div class="tbl-wrap"><table><thead><tr><th>Tag</th><th>From</th><th>To</th><th>Picked up</th><th>Dropped off</th><th>Subcontractor</th><th>Crew</th><th>Exceptions</th></tr></thead><tbody>${rows.map(tr).join("")}</tbody></table></div>`
    : `<div class="empty card">No generator movements in this period.</div>`}`;
}
$("#repExport").onclick = () => {
  if (!repData) return; const { r, rows, subs, counts } = repData; const dt = t => t ? new Date(t) : "";
  const mv = [["Tag","Generator","From","From details","Planned to","Dropped at","Dropped at details","Picked up","Dropped off","State at period end","Reason","Subcontractor","Crew lead","Vehicle","Run hours at pickup","Run hours at drop-off","Condition after drop-off","Recorded by (pickup)","Recorded by (drop-off)","Exceptions","Notes"],
    ...rows.map(x => { const p = x.m.pickup || {}, d = x.m.dropoff || {}; return [x.tag, x.gen, x.m.from, siteDesc(x.m.from), x.m.plannedTo || "", x.m.to || "", siteDesc(x.m.to), dt(x.m.t0), dt(x.m.t1), x.stateAtEnd, x.m.reason || "", x.m.subcontractor || "", x.m.crew || "", x.m.vehicle || "", p.runHours ?? "", d.runHours ?? "", d.condition || "", x.m.createdBy ? who(x.m.createdBy) : "", x.m.droppedBy ? who(x.m.droppedBy) : "", x.flags.join("; "), [x.m.note, p.note, d.note].filter(Boolean).join(" | ")]; })];
  const base = `DG-movements-${repKind === "day" ? "daily" : "weekly"}-${isoDay(new Date(r.s))}`;
  if (!window.XLSX) {   // offline fallback
    const csv = mv.map(row => row.map(v => { v = v instanceof Date ? v.toLocaleString("en-GB") : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; }).join(",")).join("\r\n");
    return download(base + ".csv", "\ufeff" + csv, "text/csv");
  }
  const X = window.XLSX, wb = X.utils.book_new();
  const sum = [["DG movement report"], [r.label], ["Generated", new Date(), "by " + S.me.name], [], ["Pickups", counts.started], ["Drop-offs", counts.done], ["Still in transit at period end", counts.open], ["Moves with exceptions", counts.flagged], [], ["Subcontractor","Pickups","Drop-offs","Open","With exceptions"], ...Object.entries(subs).map(([k,o]) => [k, o.started, o.done, o.open, o.flags])];
  const ws1 = X.utils.aoa_to_sheet(sum, {cellDates:true}); ws1["!cols"] = [{wch:34},{wch:22},{wch:14},{wch:10},{wch:16}]; X.utils.book_append_sheet(wb, ws1, "Summary");
  const ws2 = X.utils.aoa_to_sheet(mv, {cellDates:true, dateNF:"dd-mmm-yyyy hh:mm"}); ws2["!cols"] = mv[0].map((h,i) => ({wch:[10,26,9,30,10,10,30,17,17,14,20,16,16,10,10,10,18,20,20,40,30][i] || 12})); ws2["!autofilter"] = {ref:"A1:U"+(rows.length+1)}; X.utils.book_append_sheet(wb, ws2, "Movements");
  const ex = [["Tag","From","To","Picked up","Subcontractor","Crew lead","Exception"]]; rows.forEach(x => x.flags.forEach(f => ex.push([x.tag, x.m.from, x.m.to || x.m.plannedTo || "", dt(x.m.t0), x.m.subcontractor || "", x.m.crew || "", f])));
  const ws3 = X.utils.aoa_to_sheet(ex, {cellDates:true, dateNF:"dd-mmm-yyyy hh:mm"}); ws3["!cols"] = [{wch:10},{wch:9},{wch:9},{wch:17},{wch:16},{wch:16},{wch:50}]; X.utils.book_append_sheet(wb, ws3, "Exceptions");
  const fl = [["Tag","Type","Make","Model","kVA","Service","Condition","Location now","Location details","Last moved","Old register reference","Note"], ...[...S.fleet.values()].filter(g => g.active).sort(byTag).map(g => [g.id, g.kind, g.make, g.model, g.kva || "", g.service, g.condition, g.loc === "TRANSIT" ? "In transit" : g.loc || "Not confirmed", siteDesc(g.loc), dt(g.lastMovedAt), g.legacy || "", g.locNote || ""])];
  const ws4 = X.utils.aoa_to_sheet(fl, {cellDates:true, dateNF:"dd-mmm-yyyy"}); ws4["!cols"] = [{wch:11},{wch:6},{wch:12},{wch:11},{wch:6},{wch:11},{wch:10},{wch:13},{wch:40},{wch:13},{wch:16},{wch:40}]; X.utils.book_append_sheet(wb, ws4, "Fleet now");
  download(base + ".xlsx", new Blob([X.write(wb, {type:"array", bookType:"xlsx"})], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
};

start();
