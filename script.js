import { db, auth } from "./firebase.js";
import { buildXlsx, XLSX_MIME } from "./xlsx-writer.js";
import { BRANCHES, DEFAULT_SCHOOLS_BY_BRANCH, STADIUMS, ADMIN_IDLE_MINUTES, PRIVACY } from "./config.js";
import {
  escapeHtml, intText, normName, normPhone, phoneLink, goesHomeLabel, fritidsBadgeHtml, homeBadgeHtml,
  stadiumForGrade, gradeSortValue, activitySortKey, sortByDay, parseSortMinutes, currentWeekKey, weekLabel, buildPrivacyHtml
} from "./utils.js";
import {
  collection, addDoc, setDoc, updateDoc, deleteDoc, doc, onSnapshot, getDoc,
  query, where, getDocs, increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const CURRENT_BRANCH_KEY = "fg-current-branch";

// Arbetskopia av skollistan – kan ersättas av inställningar från databasen (se Inställningar).
const SCHOOLS_BY_BRANCH = JSON.parse(JSON.stringify(DEFAULT_SCHOOLS_BY_BRANCH));


/* ---------- Dialoger: fokusfälla, Escape och återställd fokus ---------- */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const modalClosers = new Map();   // overlay -> funktion som stänger och nollställer just den dialogen

function registerModal(overlay, closer){ modalClosers.set(overlay, closer); }
function visibleFocusables(root){
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(el => el.getClientRects().length > 0);
}
function openModalEl(overlay, focusEl){
  overlay._opener = document.activeElement;
  overlay.classList.add("open");
  document.body.classList.add("modal-open");
  setTimeout(() => {
    const target = focusEl || visibleFocusables(overlay)[0];
    if(target) target.focus();
  }, 40);
}
function closeModalEl(overlay){
  overlay.classList.remove("open");
  if(!document.querySelector(".modal-overlay.open")) document.body.classList.remove("modal-open");
  const opener = overlay._opener;
  overlay._opener = null;
  if(opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
}
function topOpenModal(){
  const open = document.querySelectorAll(".modal-overlay.open");
  return open.length ? open[open.length - 1] : null;
}
document.addEventListener("keydown", (e) => {
  const m = topOpenModal();
  if(!m){
    if(e.key === "Escape" && typeof openRowMenu !== "undefined" && openRowMenu){
      const btn = openRowMenu.btn;
      closeRowMenus();
      btn.focus();
    }
    return;
  }
  if(e.key === "Escape"){
    e.preventDefault();
    const close = modalClosers.get(m);
    if(close) close();
    return;
  }
  if(e.key !== "Tab") return;
  const items = visibleFocusables(m.querySelector(".modal-card"));
  if(!items.length) return;
  const first = items[0], last = items[items.length - 1], active = document.activeElement;
  if(!m.contains(active)){ e.preventDefault(); first.focus(); }
  else if(e.shiftKey && active === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && active === last){ e.preventDefault(); first.focus(); }
});

const activitiesCol = collection(db, "activities");
const registrationsCol = collection(db, "registrations");
const leadersCol = collection(db, "leaders");
const buddiesCol = collection(db, "buddies");
const statsCol = collection(db, "stats");
const todosCol = collection(db, "todos");
const settingsRef = doc(db, "settings", "main");

function emptyGroups(){
  const o = {};
  BRANCHES.forEach(b => o[b.id] = []);
  return o;
}

let activitiesByBranch = emptyGroups();
let registrationsByBranch = emptyGroups();
let leadersByBranch = emptyGroups();
let buddiesByBranch = emptyGroups();
let statsByBranch = emptyGroups();
let todosByBranch = emptyGroups();
let unsubscribeRegs = null;
let unsubscribeLeaders = null;
let unsubscribeBuddies = null;
let unsubscribeStats = null;
let unsubscribeTodos = null;

let currentBranch = localStorage.getItem(CURRENT_BRANCH_KEY) || BRANCHES[0].id;
if(!BRANCHES.some(b => b.id === currentBranch)) currentBranch = BRANCHES[0].id;

let isAdmin = false;
let contactFilter = "";
let signupBranch = null;

function branchInfo(id){
  return BRANCHES.find(b => b.id === id) || BRANCHES[0];
}


function moveOptionsHtml(branchId, excludeActId){
  return acts(branchId)
    .filter(a => a.id !== excludeActId)
    .map(a => {
      const count = realPlacedCountFor(branchId, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      return `<option value="${a.id}">${escapeHtml(a.name)}${full ? ' (fullt)' : ''}</option>`;
    }).join("");
}

function activityLabelHtml(a){
  return escapeHtml(a.name) + (a.schedule ? ` <span class="act-time">· ${escapeHtml(a.schedule)}</span>` : '');
}

function placedIds(r){
  return Array.isArray(r.placedActivityIds) ? r.placedActivityIds : [];
}
function wishIds(r){
  return Array.isArray(r.wishActivityIds) ? r.wishActivityIds : [];
}
function reserveIds(r){
  return Array.isArray(r.reserveActivityIds) ? r.reserveActivityIds : [];
}
function actStadiums(a){
  return Array.isArray(a.stadiums) ? a.stadiums : (a.stadium ? [a.stadium] : []);
}


/* ---------- Synliga felmeddelanden ---------- */
// Tidigare hamnade fel (t.ex. saknade databasregler) bara i webbläsarens konsol och
// listorna såg tomma ut. Nu visas ett tydligt meddelande överst.

const bannerErrors = new Map();
function renderErrorBanner(){
  const el = document.getElementById("errorBanner");
  if(!bannerErrors.size){ el.classList.remove("open"); return; }
  document.getElementById("errorBannerText").textContent = Array.from(bannerErrors.values()).join("  ·  ");
  el.classList.add("open");
}
function setBannerError(key, message){
  if(message) bannerErrors.set(key, message); else bannerErrors.delete(key);
  renderErrorBanner();
}
document.getElementById("errorBannerClose").addEventListener("click", () => { bannerErrors.clear(); renderErrorBanner(); });

function friendlyError(err){
  const code = String((err && err.code) || "");
  if(code.includes("permission-denied")) return "Behörighet saknas – logga ut och in igen, eller kontrollera att Firestore-reglerna är publicerade.";
  if(code.includes("unauthenticated")) return "Du är utloggad – logga in igen.";
  if(code.includes("resource-exhausted")) return "Databasens gräns är nådd (gratisnivån). Försök igen senare.";
  if(code.includes("unavailable") || code.includes("deadline") || code.includes("network")) return "Ingen kontakt med databasen – kontrollera internetanslutningen.";
  return "Något gick fel" + (err && err.message ? " (" + err.message + ")" : "") + ".";
}

const LISTENER_LABELS = {
  activitiesCol: "aktiviteterna", registrationsCol: "anmälningarna", leadersCol: "ledarna",
  buddiesCol: "veckans kompis", statsCol: "statistiken", todosCol: "att göra-lapparna",
  settingsRef: "inställningarna"
};
function listen(ref, name, onData){
  return onSnapshot(ref, snap => {
    setBannerError("read:" + name, null);
    onData(snap);
  }, err => {
    console.error(name + " snapshot error:", err);
    // Personalens listor är bara relevanta när man är inloggad; aktiviteterna behövs alltid.
    if(name !== "activitiesCol" && !isAdmin) return;
    if(name === "settingsRef" && !isAdmin) return;
    setBannerError("read:" + name, "Kunde inte läsa " + (LISTENER_LABELS[name] || "data") + ". " + friendlyError(err));
  });
}

// Misslyckade skrivningar (spara/ändra/ta bort) som annars försvinner tyst.
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  if(!r || !(r.code || r.name === "FirebaseError")) return;
  e.preventDefault();
  console.error("Skrivfel:", r);
  setBannerError("write", "Ändringen kunde inte sparas. " + friendlyError(r));
  clearTimeout(window.__writeBannerTimer);
  window.__writeBannerTimer = setTimeout(() => setBannerError("write", null), 12000);
});

/* ---------- Live-synk mot Firestore ---------- */

listen(activitiesCol, "activitiesCol", snap => {
  const grouped = emptyGroups();
  snap.forEach(d => {
    const data = { id: d.id, ...d.data() };
    if(!grouped[data.branch]) grouped[data.branch] = [];
    grouped[data.branch].push(data);
  });
  activitiesByBranch = grouped;
  rerenderAll();
});

function startRegistrationsListener(){
  if(unsubscribeRegs) return;
  unsubscribeRegs = listen(registrationsCol, "registrationsCol", snap => {
    const grouped = emptyGroups();
    snap.forEach(d => {
      const data = { id: d.id, ...d.data() };
      if(!grouped[data.branch]) grouped[data.branch] = [];
      grouped[data.branch].push(data);
    });
    registrationsByBranch = grouped;
    rerenderAll();
  });
}
function stopRegistrationsListener(){
  if(unsubscribeRegs){ unsubscribeRegs(); unsubscribeRegs = null; }
  registrationsByBranch = emptyGroups();
}

function startLeadersAndBuddiesListeners(){
  if(!unsubscribeLeaders){
    unsubscribeLeaders = listen(leadersCol, "leadersCol", snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      leadersByBranch = grouped;
      rerenderAll();
    });
  }
  if(!unsubscribeBuddies){
    unsubscribeBuddies = listen(buddiesCol, "buddiesCol", snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      buddiesByBranch = grouped;
      rerenderAll();
    });
  }
  if(!unsubscribeStats){
    unsubscribeStats = listen(statsCol, "statsCol", snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      statsByBranch = grouped;
      rerenderAll();
    });
  }
  if(!unsubscribeTodos){
    unsubscribeTodos = listen(todosCol, "todosCol", snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      todosByBranch = grouped;
      rerenderAll();
    });
  }
}
function stopLeadersAndBuddiesListeners(){
  if(unsubscribeLeaders){ unsubscribeLeaders(); unsubscribeLeaders = null; }
  if(unsubscribeBuddies){ unsubscribeBuddies(); unsubscribeBuddies = null; }
  if(unsubscribeStats){ unsubscribeStats(); unsubscribeStats = null; }
  if(unsubscribeTodos){ unsubscribeTodos(); unsubscribeTodos = null; }
  leadersByBranch = emptyGroups();
  buddiesByBranch = emptyGroups();
  statsByBranch = emptyGroups();
  todosByBranch = emptyGroups();
}

function rerenderAll(){
  if(signupBranch){
    renderActivityChecks();
    renderActList();
  }
  if(isAdmin) renderAdmin();
}

function acts(branchId){ return activitiesByBranch[branchId] || []; }
function regs(branchId){ return registrationsByBranch[branchId] || []; }

// Faktiskt antal utifrån riktiga anmälningar - bara tillgängligt när man är
// inloggad (admin), används för avstämning och deltagarlistor.
function realPlacedCountFor(branchId, actId){
  return regs(branchId).filter(r => placedIds(r).includes(actId)).length;
}
function activityName(branchId, id){
  const a = acts(branchId).find(a => a.id === id);
  return a ? a.name : "Okänd aktivitet";
}
function activityNameWithSchedule(branchId, id){
  const a = acts(branchId).find(a => a.id === id);
  if(!a) return "Okänd aktivitet";
  return a.schedule ? `${a.name} (${a.schedule})` : a.name;
}


function activitiesForStadium(branchId, stadium){
  return sortByDay(acts(branchId).filter(a => actStadiums(a).includes(stadium)));
}
function activityMatchesSchool(a, school){
  return !a.schools || !a.schools.length || !school || a.schools.includes(school);
}
function leadersFor(branchId){ return leadersByBranch[branchId] || []; }
function buddiesFor(branchId){ return buddiesByBranch[branchId] || []; }
function statsFor(branchId){ return (statsByBranch[branchId] || []).slice().sort((a,b) => (b.date || '').localeCompare(a.date || '') || b.ts - a.ts); }
function fritidsListFor(branchId){
  return regs(branchId)
    .filter(r => r.attendsFritids)
    .slice()
    .sort((a, b) => (gradeSortValue(a.grade) - gradeSortValue(b.grade)) || a.childName.localeCompare(b.childName, 'sv'));
}
function todosFor(branchId){ return (todosByBranch[branchId] || []).slice().sort((a,b) => b.ts - a.ts); }

function buddiesForLeader(branchId, leaderId){
  return buddiesFor(branchId).filter(b => b.leaderId === leaderId).sort((a,b) => b.ts - a.ts);
}

// Håller det publika räknefältet i synk med verkliga placeringar. Körs vid
// varje admin-rendering; skriver bara om värdet faktiskt avviker.
async function reconcileCounts(branchId){
  for(const a of acts(branchId)){
    const real = realPlacedCountFor(branchId, a.id);
    if((a.placedCount || 0) !== real){
      try{ await updateDoc(doc(db, "activities", a.id), { placedCount: real }); }catch(e){ /* ignore */ }
    }
  }
}

/* ---------- Header ---------- */

function updateHeaderForAdminBranch(){
  const b = branchInfo(currentBranch);
  document.getElementById("adminLoginSub").textContent = "Logga in med ditt personal-konto för att hantera " + b.name + ".";
  document.getElementById("adminBranchLabel").textContent = "· " + b.name;
}

/* ---------- Avdelningsväxlare (bara i admin) ---------- */

function renderBranchSwitch(){
  const wrap = document.getElementById("branchSwitch");
  if(BRANCHES.length <= 1){
    wrap.innerHTML = "";
    wrap.classList.remove("visible");
    return;
  }
  wrap.innerHTML = BRANCHES.map(b =>
    `<button class="branchbtn ${b.id === currentBranch ? 'active' : ''}" data-branch="${b.id}">${escapeHtml(b.name)}</button>`
  ).join("");
  wrap.querySelectorAll(".branchbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      if(btn.dataset.branch === currentBranch) return;
      currentBranch = btn.dataset.branch;
      localStorage.setItem(CURRENT_BRANCH_KEY, currentBranch);
      renderBranchSwitch();
      updateHeaderForAdminBranch();
      if(isAdmin) renderAdmin();
    });
  });
}

/* ---------- Anmälningssida ---------- */

function renderGate(){
  if(BRANCHES.length === 1){
    selectSignupBranch(BRANCHES[0].id);
    return;
  }
  const wrap = document.getElementById("gateBtns");
  wrap.innerHTML = BRANCHES.map(b =>
    `<button class="gate-btn" data-branch="${b.id}">${escapeHtml(b.name)}</button>`
  ).join("");
  wrap.querySelectorAll(".gate-btn").forEach(btn => {
    btn.addEventListener("click", () => selectSignupBranch(btn.dataset.branch));
  });
}

function renderSchoolSelect(){
  const sel = document.getElementById("s-school");
  const schools = SCHOOLS_BY_BRANCH[signupBranch] || [];
  const previous = sel.value;   // behåll förälderns val om skolan finns kvar
  sel.innerHTML = '<option value="">Välj skola</option>' +
    schools.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if(previous && schools.includes(previous)) sel.value = previous;
}

function selectSignupBranch(branchId){
  signupBranch = branchId;
  document.getElementById("branchGate").style.display = "none";
  document.getElementById("signupContent").style.display = "block";
  document.getElementById("signupBranchLabel").textContent = branchInfo(branchId).name;
  document.getElementById("actListSub").textContent = "Så här ser det ut just nu hos " + branchInfo(branchId).name + ".";
  document.querySelector(".signup-branch-bar").style.display = BRANCHES.length <= 1 ? "none" : "flex";
  renderSchoolSelect();
  renderActivityChecks();
  renderActList();
}

document.getElementById("changeBranchBtn").addEventListener("click", () => {
  signupBranch = null;
  document.getElementById("signupForm").reset();
  document.getElementById("ticketHolder").innerHTML = "";
  document.getElementById("signupContent").style.display = "none";
  document.getElementById("branchGate").style.display = "block";
});

function renderActivityChecks(){
  const wrap = document.getElementById("s-activities");
  const grade = document.getElementById("s-grade").value;
  const school = document.getElementById("s-school").value;
  const stadium = stadiumForGrade(grade);
  wrap.innerHTML = "";
  if(!signupBranch){
    wrap.innerHTML = '<p class="muted">Välj årskurs först</p>';
    return;
  }
  if(!school){
    wrap.innerHTML = '<p class="muted">Välj skola och årskurs först</p>';
    return;
  }

  const sections = [];
  if(stadium){
    const cat = STADIUMS.find(s => s.id === stadium);
    sections.push({ label: cat.label, options: activitiesForStadium(signupBranch, stadium).filter(a => activityMatchesSchool(a, school)) });
  }
  const familyEligible = stadium === "f" || stadium === "lag";
  const extraCats = familyEligible ? ["utflykt", "familj"] : ["utflykt"];
  extraCats.forEach(catId => {
    const options = activitiesForStadium(signupBranch, catId).filter(a => activityMatchesSchool(a, school));
    if(options.length){
      sections.push({ label: STADIUMS.find(s => s.id === catId).label, options, isFamily: catId === "familj" });
    }
  });

  const anyOptions = sections.some(s => s.options.length);
  if(!anyOptions){
    wrap.innerHTML = stadium
      ? '<p class="muted">Inga aktiviteter för din skola/årskurs än</p>'
      : '<p class="muted">Välj årskurs först</p>';
    return;
  }

  sections.forEach(sec => {
    if(!sec.options.length) return;
    const heading = document.createElement("div");
    heading.className = "achk-section-heading";
    heading.textContent = sec.label;
    wrap.appendChild(heading);
    // Föräldrar ser aldrig platsantal eller om en aktivitet är full – de kan alltid
    // söka. Är den full hamnar barnet i reservlistan när personalen placerar.
    sec.options.forEach(a => {
      const isFamilyActivity = actStadiums(a).includes("familj");
      const label = document.createElement("label");
      label.className = "activity-check";
      label.innerHTML = `
        <input type="checkbox" value="${a.id}" ${isFamilyActivity ? 'data-family="1"' : ''}>
        <span>${activityLabelHtml(a)}</span>`;
      wrap.appendChild(label);
    });
  });
  updateFamilyCountFieldsVisibility();
}

function updateFamilyCountFieldsVisibility(){
  const anyFamily = document.querySelectorAll('#s-activities input[data-family="1"]:checked').length > 0;
  const wrap = document.getElementById("familyCountFields");
  wrap.style.display = anyFamily ? "block" : "none";
  if(!anyFamily){
    document.getElementById("s-family-children").value = "";
    document.getElementById("s-family-adults").value = "";
  }
}

document.getElementById("s-activities").addEventListener("change", updateFamilyCountFieldsVisibility);
document.getElementById("s-grade").addEventListener("change", renderActivityChecks);
document.getElementById("s-school").addEventListener("change", renderActivityChecks);

function buildStadiumSections(branchId, school){
  const frag = document.createDocumentFragment();
  let any = false;
  STADIUMS.forEach(st => {
    const stActs = activitiesForStadium(branchId, st.id).filter(a => activityMatchesSchool(a, school));
    if(!stActs.length) return;
    any = true;
    const group = document.createElement("div");
    group.className = "stadium-group";
    group.innerHTML = `<h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub})</span></h4>`;
    const list = document.createElement("div");
    list.className = "act-list";
    stActs.forEach(a => {
      const div = document.createElement("div");
      div.className = "act-card";
      div.innerHTML = `
        <div class="top">
          <span class="name">${activityLabelHtml(a)}</span>
        </div>`;
      list.appendChild(div);
    });
    group.appendChild(list);
    frag.appendChild(group);
  });
  return { frag, any };
}

function renderActList(){
  const wrap = document.getElementById("actList");
  wrap.innerHTML = "";
  if(!signupBranch) return;
  const branchActs = acts(signupBranch);
  if(!branchActs.length){
    wrap.innerHTML = '<p class="empty">Inga aktiviteter är tillagda ännu.</p>';
    return;
  }
  const schools = SCHOOLS_BY_BRANCH[signupBranch] || [];
  if(schools.length > 1){
    let anyAtAll = false;
    schools.forEach(school => {
      const { frag, any } = buildStadiumSections(signupBranch, school);
      if(!any) return;
      anyAtAll = true;
      const schoolGroup = document.createElement("div");
      schoolGroup.className = "branch-group";
      schoolGroup.innerHTML = `<h3 class="branch-heading">${escapeHtml(school)}</h3>`;
      schoolGroup.appendChild(frag);
      wrap.appendChild(schoolGroup);
    });
    if(!anyAtAll){
      wrap.innerHTML = '<p class="empty">Inga aktiviteter är tillagda ännu.</p>';
    }
  }else{
    const { frag, any } = buildStadiumSections(signupBranch, schools[0] || null);
    if(!any){
      wrap.innerHTML = '<p class="empty">Inga aktiviteter är tillagda ännu.</p>';
    }else{
      wrap.appendChild(frag);
    }
  }
}

function showTicket(branchName, data, wishNames){
  const holder = document.getElementById("ticketHolder");
  const now = new Date();
  const dateStr = now.toLocaleDateString('sv-SE', { day:'numeric', month:'long' });
  holder.innerHTML = `
    <div class="ticket">
      <img src="assets/logo-a.png" alt="" class="mark" aria-hidden="true">
      <p class="ticket-title">Ansökan mottagen · ${escapeHtml(branchName)}</p>
      <h3>${escapeHtml(data.childName)}</h3>
      <div class="row"><span>Skola</span><b>${escapeHtml(data.school)}</b></div>
      <div class="row"><span>Årskurs</span><b>${escapeHtml(data.grade)}</b></div>
      <div class="row"><span>Klass</span><b>${escapeHtml(data.klass)}</b></div>
      <div class="row"><span>Går hem själv</span><b>${data.goesHomeAlone ? "Ja" : "Nej, ska hämtas"}</b></div>
      <div class="row"><span>Önskade aktiviteter</span><b>${escapeHtml(wishNames.join(', '))}</b></div>
      ${typeof data.familyChildren !== "undefined" ? `<div class="row"><span>Familj: barn / vuxna</span><b>${intText(data.familyChildren)} / ${intText(data.familyAdults)}</b></div>` : ''}
      <div class="row"><span>Förälder</span><b>${escapeHtml(data.parentName)}</b></div>
      <div class="row"><span>Datum</span><b>${dateStr}</b></div>
      <p class="ticket-note">Personalen placerar barnet i aktivitet(er) inom kort.</p>
      <svg class="scissor" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle>
        <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
        <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
        <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
      </svg>
    </div>`;
}

const REQUIRED_SIGNUP_FIELDS = ["s-name", "s-school", "s-grade", "s-class", "s-parentname", "s-parentphone"];

function clearFieldErrors(){
  REQUIRED_SIGNUP_FIELDS.forEach(id => document.getElementById(id).classList.remove("field-error"));
  document.getElementById("s-gender").classList.remove("field-error");
  document.getElementById("s-gohome").classList.remove("field-error");
  document.getElementById("s-activities").classList.remove("field-error");
  document.getElementById("familyCountFields").classList.remove("field-error");
}

document.getElementById("signupForm").addEventListener("input", (e) => {
  e.target.classList.remove("field-error");
  const wrap = e.target.closest(".radio-row, .activity-checks, .family-count-fields");
  if(wrap) wrap.classList.remove("field-error");
});

let signupInFlight = false;

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if(signupInFlight) return;   // en andra tryckning medan första skickas ignoreras
  // Honungsfälla: människor ser aldrig det dolda fältet, robotar fyller ofta i det.
  // Då låtsas vi att det gick bra men sparar ingenting.
  if(document.getElementById("s-hp").value.trim()){
    document.getElementById("ticketHolder").innerHTML = '<div class="ticket"><p class="ticket-title">Ansökan mottagen</p></div>';
    document.getElementById("signupForm").reset();
    return;
  }
  const err = document.getElementById("s-err");
  err.style.display = "none";
  clearFieldErrors();

  const childName = document.getElementById("s-name").value.trim();
  const genderInput = document.querySelector('input[name="gender"]:checked');
  const gender = genderInput ? genderInput.value : "";
  const gohomeInput = document.querySelector('input[name="gohome"]:checked');
  const goesHomeAlone = gohomeInput ? gohomeInput.value === "ja" : null;
  const school = document.getElementById("s-school").value;
  const grade = document.getElementById("s-grade").value;
  const klass = document.getElementById("s-class").value.trim();
  const attendsFritids = document.getElementById("s-fritids").checked;
  const childPhone = document.getElementById("s-childphone").value.trim();
  const parentName = document.getElementById("s-parentname").value.trim();
  const parentPhone = document.getElementById("s-parentphone").value.trim();
  const otherInfo = document.getElementById("s-other").value.trim();
  const wishActivityIds = Array.from(document.querySelectorAll('#s-activities input[type="checkbox"]:checked')).map(c => c.value);
  const isFamilySignup = document.querySelectorAll('#s-activities input[data-family="1"]:checked').length > 0;
  const familyChildrenInp = document.getElementById("s-family-children");
  const familyAdultsInp = document.getElementById("s-family-adults");

  let firstInvalid = null;
  function invalid(id){
    const el = document.getElementById(id);
    el.classList.add("field-error");
    if(!firstInvalid) firstInvalid = el;
  }
  if(!childName) invalid("s-name");
  if(!gender) invalid("s-gender");
  if(goesHomeAlone === null) invalid("s-gohome");
  if(!school) invalid("s-school");
  if(!grade) invalid("s-grade");
  if(!klass) invalid("s-class");
  if(!parentName) invalid("s-parentname");
  if(!parentPhone) invalid("s-parentphone");
  if(!wishActivityIds.length) invalid("s-activities");
  if(isFamilySignup && (familyChildrenInp.value === "" || familyAdultsInp.value === "")){
    document.getElementById("familyCountFields").classList.add("field-error");
    if(!firstInvalid) firstInvalid = document.getElementById("familyCountFields");
  }

  if(firstInvalid){
    err.textContent = "Fyll i de markerade fälten innan du skickar ansökan.";
    err.style.display = "block";
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const data = { childName, gender, goesHomeAlone, school, grade, klass, attendsFritids, childPhone, parentName, parentPhone, otherInfo };
  if(isFamilySignup){
    data.familyChildren = parseInt(familyChildrenInp.value, 10) || 0;
    data.familyAdults = parseInt(familyAdultsInp.value, 10) || 0;
  }
  const wishNames = wishActivityIds.map(id => activityName(signupBranch, id));

  // Lås knappen medan ansökan skickas – annars kan ett dubbeltryck på en långsam
  // anslutning skapa två ansökningar.
  const submitBtn = document.querySelector('#signupForm button[type="submit"]');
  const submitLabel = submitBtn.textContent;
  signupInFlight = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Skickar…";
  const slowHint = setTimeout(() => { submitBtn.textContent = "Väntar på anslutning…"; }, 10000);
  try{
    await addDoc(registrationsCol, {
      branch: signupBranch,
      ...data,
      wishActivityIds,
      placedActivityIds: [],
      ts: Date.now()
    });
  }catch(e){
    // Databasen nekar en anmälan som bryter mot reglerna (t.ex. orimligt lång text). Säg det tydligt
    // – "kolla internet" vore missvisande.
    err.textContent = String((e && e.code) || "").includes("permission-denied")
      ? "Ansökan kunde inte skickas. Kontrollera att uppgifterna är rimliga (t.ex. inte alltför långa texter) och försök igen. Fortsätter det – kontakta fritidsgården."
      : "Kunde inte skicka ansökan, kolla internetanslutningen och försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }finally{
    clearTimeout(slowHint);
    signupInFlight = false;
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
  }
  showTicket(branchInfo(signupBranch).name, data, wishNames);
  document.getElementById("signupForm").reset();
  renderActivityChecks();
  updateFamilyCountFieldsVisibility();
});

document.querySelectorAll(".tabbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.tab).classList.add("active");
    document.getElementById("branchSwitch").classList.toggle("visible", btn.dataset.tab === "admin");
    if(btn.dataset.tab === "admin" && isAdmin) renderAdmin();
  });
});

/* ---------- Admin-inloggning (Firebase Authentication) ---------- */

onAuthStateChanged(auth, user => {
  isAdmin = !!user;
  const err = document.getElementById("pw-err");
  if(user){
    err.style.display = "none";
    document.getElementById("admPassword").value = "";
    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminPanel").style.display = "block";
    startRegistrationsListener();
    startLeadersAndBuddiesListeners();
    showLoginNotice("");
    resetIdleTimer();
    loadRole(user);
    renderAdmin();
  }else{
    stopRegistrationsListener();
    stopLeadersAndBuddiesListeners();
    stopIdleTimer();
    document.body.classList.remove("role-staff");
    document.getElementById("roleNote").textContent = "";
    document.getElementById("adminPanel").style.display = "none";
    document.getElementById("adminLogin").style.display = "block";
    rerenderAll();
  }
});

/* ---------- Automatisk utloggning vid inaktivitet ---------- */

let idleTimer = null;
let lastIdleReset = 0;
function stopIdleTimer(){ clearTimeout(idleTimer); idleTimer = null; }
function showLoginNotice(text){
  const el = document.getElementById("pw-info");
  el.textContent = text || "";
  el.classList.toggle("show", !!text);
}
function resetIdleTimer(){
  stopIdleTimer();
  if(!ADMIN_IDLE_MINUTES) return;
  idleTimer = setTimeout(async () => {
    await signOut(auth);
    showLoginNotice("Du loggades ut efter " + ADMIN_IDLE_MINUTES + " minuters inaktivitet. Logga in igen för att fortsätta.");
  }, ADMIN_IDLE_MINUTES * 60 * 1000);
}
["mousemove", "keydown", "click", "touchstart", "scroll"].forEach(evt => {
  window.addEventListener(evt, () => {
    if(!isAdmin) return;
    const now = Date.now();
    if(now - lastIdleReset < 5000) return;
    lastIdleReset = now;
    resetIdleTimer();
  }, { passive: true, capture: true });
});

document.getElementById("pwResetBtn").addEventListener("click", async () => {
  const email = document.getElementById("admEmail").value.trim();
  const err = document.getElementById("pw-err");
  err.style.display = "none";
  showLoginNotice("");
  if(!email){
    err.textContent = "Skriv in din e-postadress först, tryck sedan på Glömt lösenord.";
    err.style.display = "block";
    return;
  }
  try{
    await sendPasswordResetEmail(auth, email);
  }catch(e){
    const code = String((e && e.code) || "");
    if(code.includes("invalid-email")){
      err.textContent = "Det ser inte ut som en giltig e-postadress.";
      err.style.display = "block";
      return;
    }
    if(!code.includes("user-not-found")){
      err.textContent = friendlyError(e);
      err.style.display = "block";
      return;
    }
  }
  // Samma svar oavsett om adressen finns, så att ingen kan pröva sig fram till vilka konton som finns.
  showLoginNotice("Om adressen finns hos oss har ett mejl skickats med en länk för att välja nytt lösenord.");
});

document.getElementById("pwBtn").addEventListener("click", async () => {
  const email = document.getElementById("admEmail").value.trim();
  const password = document.getElementById("admPassword").value;
  const err = document.getElementById("pw-err");
  err.style.display = "none";
  if(!email || !password){
    err.textContent = "Fyll i e-post och lösenord.";
    err.style.display = "block";
    return;
  }
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(e){
    err.textContent = "Fel e-post eller lösenord.";
    err.style.display = "block";
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  signOut(auth);
});

/* ---------- Rensa anmälningar ---------- */

document.getElementById("clearRegsBtn").addEventListener("click", async () => {
  const list = regs(currentBranch).slice();
  await bulkDeleteRegistrations(list, "Detta tar bort ALLA " + list.length + " anmälningar (väntande, reserv och placerade) för " + branchInfo(currentBranch).name + ". Det går inte att ångra.");
});

/* ---------- Lägg till en befintlig deltagare i fler aktiviteter ---------- */
// Från fliken Deltagare: placera ett barn som redan finns i ytterligare aktiviteter
// (utan att skapa en ny anmälan). Full aktivitet → barnet hamnar i reservlistan.

let atRegId = null;
function atEl(id){ return document.getElementById(id); }

function atSections(r, showAll){
  const taken = new Set([...placedIds(r), ...reserveIds(r)]);
  const seen = new Set(taken);
  const sections = [];
  const add = (label, list) => {
    const opts = list.filter(a => !seen.has(a.id));
    opts.forEach(a => seen.add(a.id));
    if(opts.length) sections.push({ label, options: opts });
  };
  if(showAll){
    STADIUMS.forEach(st => add(st.label, activitiesForStadium(currentBranch, st.id)));
  }else{
    const stadium = stadiumForGrade(r.grade);
    const forSchool = list => list.filter(a => activityMatchesSchool(a, r.school));
    if(stadium) add(STADIUMS.find(s => s.id === stadium).label, forSchool(activitiesForStadium(currentBranch, stadium)));
    add("Utflykter", forSchool(activitiesForStadium(currentBranch, "utflykt")));
    if(stadium === "f" || stadium === "lag") add("Familjeaktivitet", forSchool(activitiesForStadium(currentBranch, "familj")));
  }
  return sections;
}

function renderAtCurrent(r){
  const chips = [];
  placedIds(r).forEach(id => chips.push(`<span class="chip chip-placed">Placerad: ${escapeHtml(activityNameWithSchedule(currentBranch, id))}</span>`));
  reserveIds(r).forEach(id => chips.push(`<span class="chip chip-reserve">Reserv: ${escapeHtml(activityNameWithSchedule(currentBranch, id))}</span>`));
  atEl("at-current").innerHTML = '<span class="at-current-label">Just nu</span>' +
    (chips.length ? chips.join("") : '<span class="muted">Är inte placerad i någon aktivitet än.</span>');
}

function renderAtActivities(){
  const r = regs(currentBranch).find(x => x.id === atRegId);
  const wrap = atEl("at-activities");
  if(!r){ wrap.innerHTML = ""; return; }
  const checked = new Set(Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value));
  const sections = atSections(r, atEl("at-show-all").checked);
  wrap.innerHTML = "";
  sections.forEach(sec => {
    const heading = document.createElement("div");
    heading.className = "achk-section-heading";
    heading.textContent = sec.label;
    wrap.appendChild(heading);
    sec.options.forEach(a => {
      const count = realPlacedCountFor(currentBranch, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      const label = document.createElement("label");
      label.className = "activity-check";
      label.innerHTML = `
        <input type="checkbox" value="${escapeHtml(a.id)}" ${actStadiums(a).includes("familj") ? 'data-family="1"' : ''} ${checked.has(a.id) ? "checked" : ""}>
        <span>${activityLabelHtml(a)}</span>
        <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt – hamnar i reserv' : (count + '/' + a.maxSpots)) : ''}</span>`;
      wrap.appendChild(label);
    });
  });
  if(!sections.length){
    wrap.innerHTML = '<p class="muted">Inga fler aktiviteter att lägga till just nu. Kryssa i "Visa alla aktiviteter" för att se övriga.</p>';
  }
  updateAtFamilyFields();
}

function updateAtFamilyFields(){
  const any = document.querySelectorAll('#at-activities input[data-family="1"]:checked').length > 0;
  atEl("at-family-fields").classList.toggle("show", any);
  if(!any) atEl("at-family-fields").classList.remove("field-error");
}

function atClearErrors(){
  atEl("at-err").style.display = "none";
  atEl("at-family-fields").classList.remove("field-error");
  atEl("at-activities").classList.remove("field-error");
}

function openAddToActivity(regId){
  const r = regs(currentBranch).find(x => x.id === regId);
  if(!r) return;
  atRegId = regId;
  atEl("at-show-all").checked = false;
  atEl("at-activities").innerHTML = "";
  atEl("at-family-children").value = typeof r.familyChildren !== "undefined" ? intText(r.familyChildren) : "";
  atEl("at-family-adults").value = typeof r.familyAdults !== "undefined" ? intText(r.familyAdults) : "";
  atClearErrors();
  atEl("atSub").textContent = `${r.childName} · ${r.grade === "F" ? "förskoleklass" : "åk " + r.grade} · ${r.klass}`;
  renderAtCurrent(r);
  renderAtActivities();
  openModalEl(atEl("atModal"));
}

function closeAddToActivity(){
  closeModalEl(atEl("atModal"));
  atRegId = null;
}
registerModal(atEl("atModal"), closeAddToActivity);

atEl("at-close-btn").addEventListener("click", closeAddToActivity);
atEl("at-cancel-btn").addEventListener("click", closeAddToActivity);
atEl("atModal").addEventListener("click", (e) => { if(e.target === atEl("atModal")) closeAddToActivity(); });
atEl("at-show-all").addEventListener("change", renderAtActivities);
atEl("at-activities").addEventListener("change", () => { updateAtFamilyFields(); atClearErrors(); });
atEl("atModal").addEventListener("input", (e) => {
  e.target.classList.remove("field-error");
  const box = e.target.closest(".pf-family-fields");
  if(box) box.classList.remove("field-error");
});

atEl("at-save-btn").addEventListener("click", async () => {
  const r = regs(currentBranch).find(x => x.id === atRegId);
  if(!r) return;
  atClearErrors();
  const err = atEl("at-err");
  const chosen = Array.from(new Set(Array.from(document.querySelectorAll('#at-activities input[type="checkbox"]:checked')).map(c => c.value)));
  const isFamily = document.querySelectorAll('#at-activities input[data-family="1"]:checked').length > 0;
  if(!chosen.length){
    atEl("at-activities").classList.add("field-error");
    err.textContent = "Välj minst en aktivitet.";
    err.style.display = "block";
    return;
  }
  if(isFamily && (atEl("at-family-children").value === "" || atEl("at-family-adults").value === "")){
    atEl("at-family-fields").classList.add("field-error");
    err.textContent = "Fyll i antal barn och vuxna för familjeaktiviteten.";
    err.style.display = "block";
    return;
  }

  const toPlace = [], toReserve = [];
  chosen.forEach(id => {
    const act = acts(currentBranch).find(a => a.id === id);
    const full = act && act.maxSpots && realPlacedCountFor(currentBranch, id) >= act.maxSpots;
    (full ? toReserve : toPlace).push(id);
  });
  const updates = {
    placedActivityIds: Array.from(new Set([...placedIds(r), ...toPlace])),
    reserveActivityIds: Array.from(new Set([...reserveIds(r), ...toReserve]))
  };
  if(isFamily){
    updates.familyChildren = parseInt(atEl("at-family-children").value, 10) || 0;
    updates.familyAdults = parseInt(atEl("at-family-adults").value, 10) || 0;
  }

  const btn = atEl("at-save-btn");
  btn.disabled = true;
  try{
    await updateDoc(doc(db, "registrations", r.id), updates);
    await Promise.all(toPlace.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(1) }).catch(() => {})));
  }catch(e){
    console.error(e);
    err.textContent = "Kunde inte spara. " + friendlyError(e);
    err.style.display = "block";
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  const name = r.childName;
  const placedNames = toPlace.map(id => activityName(currentBranch, id));
  const reserveNames = toReserve.map(id => activityName(currentBranch, id));
  closeAddToActivity();
  showToast("✓ " + name + (placedNames.length ? " lades till i " + placedNames.join(", ") : "") + (reserveNames.length ? (placedNames.length ? " och" : "") + " står i reserv för " + reserveNames.join(", ") : ""), { duration: 4000 });
  if(reserveNames.length){
    alert("Fullt just nu för: " + reserveNames.join(", ") + ". " + name + " hamnade i reservlistan för den aktiviteten.");
  }
});

/* ---------- Inställningar: skolor (sparas i databasen) ---------- */
// Skolorna kan ändras i appen (Admin → Inställningar). Listan i config.js är bara
// standardvärde som används tills något har sparats.

function sanitizeSchoolList(list){
  if(!Array.isArray(list)) return null;
  const clean = [];
  list.forEach(x => {
    const name = String(x == null ? "" : x).trim().slice(0, 40);
    if(name && !clean.some(c => c.toLowerCase() === name.toLowerCase())) clean.push(name);
  });
  return clean.length ? clean : null;
}

listen(settingsRef, "settingsRef", snap => {
  if(!snap.exists()) return;
  const stored = (snap.data() || {}).schools || {};
  BRANCHES.forEach(b => {
    const list = sanitizeSchoolList(stored[b.id]);
    if(list) SCHOOLS_BY_BRANCH[b.id] = list;
  });
  if(signupBranch) renderSchoolSelect();
  rerenderAll();
});

async function saveSchools(branchId, list){
  const next = JSON.parse(JSON.stringify(SCHOOLS_BY_BRANCH));
  next[branchId] = list;
  try{
    await setDoc(settingsRef, { schools: next }, { merge: true });
    return true;
  }catch(e){
    console.error(e);
    setBannerError("write", "Skolorna kunde inte sparas. " + friendlyError(e));
    return false;
  }
}

function renderSettings(){
  const wrap = document.getElementById("settingsSchools");
  wrap.innerHTML = BRANCHES.map(b => {
    const schools = SCHOOLS_BY_BRANCH[b.id] || [];
    return `
      <div class="settings-branch" data-branch="${escapeHtml(b.id)}">
        <h4 class="stadium-heading">${escapeHtml(b.name)}</h4>
        <ul class="school-list">
          ${schools.map(name => `
            <li>
              <span>${escapeHtml(name)}</span>
              <button type="button" class="rowbtn danger-text" data-school-remove="${escapeHtml(name)}" aria-label="Ta bort skolan ${escapeHtml(name)}">Ta bort</button>
            </li>`).join("")}
        </ul>
        <div class="toolbar school-add">
          <div class="field">
            <label for="newSchool-${escapeHtml(b.id)}">Lägg till skola</label>
            <input type="text" id="newSchool-${escapeHtml(b.id)}" maxlength="40" placeholder="t.ex. Ny skola" autocomplete="off">
          </div>
          <button type="button" class="btn small" data-school-add>➕ Lägg till</button>
        </div>
        <p class="err school-err" role="alert"></p>
      </div>`;
  }).join("");
}

async function addSchoolFrom(box){
  const branchId = box.dataset.branch;
  const input = box.querySelector("input");
  const err = box.querySelector(".school-err");
  err.style.display = "none";
  const name = input.value.trim().slice(0, 40);
  const current = SCHOOLS_BY_BRANCH[branchId] || [];
  if(!name){ err.textContent = "Skriv skolans namn."; err.style.display = "block"; return; }
  if(current.some(s => s.toLowerCase() === name.toLowerCase())){
    err.textContent = "Den skolan finns redan i listan.";
    err.style.display = "block";
    return;
  }
  if(await saveSchools(branchId, [...current, name])){
    input.value = "";
    showToast("✓ " + name + " lades till");
  }
}

document.getElementById("settingsSchools").addEventListener("click", async (e) => {
  const add = e.target.closest("[data-school-add]");
  if(add){ await addSchoolFrom(add.closest(".settings-branch")); return; }
  const rm = e.target.closest("[data-school-remove]");
  if(!rm) return;
  const box = rm.closest(".settings-branch");
  const branchId = box.dataset.branch;
  const name = rm.dataset.schoolRemove;
  const current = SCHOOLS_BY_BRANCH[branchId] || [];
  if(current.length <= 1){
    alert("Det måste finnas minst en skola – annars går det inte att anmäla sig.");
    return;
  }
  const regCount = regs(branchId).filter(r => r.school === name).length;
  const actCount = acts(branchId).filter(a => (a.schools || []).includes(name)).length;
  let msg = 'Ta bort skolan "' + name + '" från listan?';
  if(regCount || actCount){
    msg += "\n\n" + regCount + (regCount === 1 ? " anmälan" : " anmälningar") + " och " + actCount + (actCount === 1 ? " aktivitet" : " aktiviteter") + " nämner den skolan. De behåller sina uppgifter, " +
           "men skolan går inte längre att välja, och aktiviteter som bara gäller den skolan kan inte längre väljas vid nya anmälningar.";
  }
  if(!confirm(msg)) return;
  if(await saveSchools(branchId, current.filter(s => s !== name))) showToast("✓ " + name + " togs bort");
});
document.getElementById("settingsSchools").addEventListener("keydown", async (e) => {
  if(e.key === "Enter" && e.target.matches(".school-add input")){
    e.preventDefault();
    await addSchoolFrom(e.target.closest(".settings-branch"));
  }
});

/* ---------- Roller: personal eller admin ---------- */
// Ett konto utan rolluppgift är admin (fungerar som förut). Ett konto med
// roles/<uid> = { role: "staff" } kan placera och redigera men inte ta bort –
// Firestore-reglerna i firestore.rules genomdriver det, det här döljer bara knapparna.

async function loadRole(user){
  document.body.classList.add("role-staff");   // dolt tills rollen är känd
  let role = "admin";
  try{
    const snap = await getDoc(doc(db, "roles", user.uid));
    if(snap.exists() && (snap.data() || {}).role === "staff") role = "staff";
  }catch(e){
    console.warn("Kunde inte läsa rollen – fortsätter som admin:", e);
  }
  if(!isAdmin) return;   // hann personen logga ut under tiden?
  document.body.classList.toggle("role-staff", role === "staff");
  document.getElementById("roleNote").textContent = role === "staff" ? "Personal – du kan placera och redigera, men inte ta bort." : "";
}

/* ---------- Gallring: radera gamla anmälningar ---------- */
// Uppgifter om barn ska inte sparas längre än nödvändigt. Här kan gamla anmälningar
// rensas – med samma säkerhetsspärrar som "Rensa alla" (skriv RADERA + Excel-säkerhetskopia).

function oldRegistrations(months){
  const cutoff = Date.now() - months * 30.44 * 24 * 60 * 60 * 1000;
  return regs(currentBranch).filter(r => typeof r.ts === "number" && r.ts < cutoff);
}
function renderPruneInfo(){
  const months = parseInt(document.getElementById("pruneMonths").value, 10);
  const n = oldRegistrations(months).length;
  document.getElementById("pruneInfo").textContent = n === 1 ? "(1 anmälan berörs)" : "(" + n + " anmälningar berörs)";
  document.getElementById("pruneBtn").disabled = n === 0;
}
document.getElementById("pruneMonths").addEventListener("change", renderPruneInfo);
document.getElementById("pruneBtn").addEventListener("click", async () => {
  const months = parseInt(document.getElementById("pruneMonths").value, 10);
  const list = oldRegistrations(months);
  await bulkDeleteRegistrations(list, "Detta tar bort " + list.length + " anmälningar som är äldre än " + months + " månader.");
});

/* ---------- Skriv ut deltagarlista ---------- */

document.getElementById("printListBtn").addEventListener("click", () => {
  document.body.classList.add("printing-participants");
  window.print();
});

/* ---------- Lägg till aktivitet ---------- */

function renderNewActSchoolsOptions(){
  const wrap = document.getElementById("newActSchools");
  const schools = SCHOOLS_BY_BRANCH[currentBranch] || [];
  wrap.innerHTML = schools.map(s =>
    `<label class="radio-pill"><input type="checkbox" value="${escapeHtml(s)}"> ${escapeHtml(s)}</label>`
  ).join("");
}

document.getElementById("addActBtn").addEventListener("click", async () => {
  const nameInp = document.getElementById("newActName");
  const scheduleInp = document.getElementById("newActSchedule");
  const maxInp = document.getElementById("newActMax");
  const err = document.getElementById("newAct-err");
  err.style.display = "none";
  const name = nameInp.value.trim();
  const stadiums = Array.from(document.querySelectorAll('#newActStadiums input:checked')).map(c => c.value);
  const schools = Array.from(document.querySelectorAll('#newActSchools input:checked')).map(c => c.value);
  if(!name){
    err.textContent = "Ange ett namn på aktiviteten.";
    err.style.display = "block";
    return;
  }
  if(!stadiums.length){
    err.textContent = "Välj minst en grupp (t.ex. Lågstadiet eller Utflykter).";
    err.style.display = "block";
    return;
  }
  const maxSpots = maxInp.value ? parseInt(maxInp.value, 10) : null;
  try{
    await addDoc(activitiesCol, {
      branch: currentBranch, name,
      schedule: scheduleInp.value.trim(),
      maxSpots: (maxSpots && maxSpots > 0) ? maxSpots : null,
      stadiums,
      schools,
      placedCount: 0
    });
  }catch(e){
    err.textContent = "Kunde inte spara, försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }
  nameInp.value = "";
  scheduleInp.value = "";
  maxInp.value = "";
  document.querySelectorAll('#newActStadiums input:checked').forEach(c => c.checked = false);
  document.querySelectorAll('#newActSchools input:checked').forEach(c => c.checked = false);
});

/* ---------- Väntande ansökningar ---------- */

let pendingFilter = "";
document.getElementById("pendingSearch").addEventListener("input", (e) => {
  pendingFilter = e.target.value.trim().toLowerCase();
  renderPending();
});

function renderPending(){
  const wrap = document.getElementById("pendingApps");
  const pending = regs(currentBranch)
    .filter(r => placedIds(r).length === 0 && reserveIds(r).length === 0)
    .sort((a,b) => a.ts - b.ts);

  const countEl = document.getElementById("pendingCount");
  if(countEl) countEl.textContent = pending.length ? `(${pending.length} st)` : "";

  const filtered = pendingFilter
    ? pending.filter(r => (r.childName || "").toLowerCase().includes(pendingFilter) || (r.klass || "").toLowerCase().includes(pendingFilter))
    : pending;

  if(!pending.length){
    wrap.innerHTML = '<p class="empty">Inga väntande ansökningar just nu.</p>';
    return;
  }
  if(!filtered.length){
    wrap.innerHTML = '<p class="empty">Ingen matchning.</p>';
    return;
  }

  wrap.innerHTML = filtered.map(r => {
    const stadium = stadiumForGrade(r.grade);
    const options = (stadium ? activitiesForStadium(currentBranch, stadium) : []).filter(a => activityMatchesSchool(a, r.school));
    const familyEligible = stadium === "f" || stadium === "lag";
    const extraCatIds = familyEligible ? ["utflykt", "familj"] : ["utflykt"];
    const extra = extraCatIds.flatMap(catId => activitiesForStadium(currentBranch, catId)).filter(a => activityMatchesSchool(a, r.school));
    const allOptions = [...options, ...extra.filter(a => !options.some(o => o.id === a.id))];
    const wishSet = new Set(wishIds(r));
    const checksHtml = allOptions.length
      ? allOptions.map(a => {
          const count = realPlacedCountFor(currentBranch, a.id);
          const full = a.maxSpots && count >= a.maxSpots;
          return `
            <label class="activity-check">
              <input type="checkbox" value="${a.id}" ${wishSet.has(a.id) ? "checked" : ""}>
              <span>${activityLabelHtml(a)}</span>
              <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt – hamnar i reserv' : (count + '/' + a.maxSpots)) : ''}</span>
            </label>`;
        }).join("")
      : '<p class="muted">Inga aktiviteter i den här årskursgruppen än.</p>';

    return `
      <div class="pending-card" data-reg="${escapeHtml(r.id)}">
        <div class="pending-head">
          <span class="pname">${escapeHtml(r.childName)}</span>
          <span class="badge ok">Åk ${escapeHtml(r.grade)} · ${escapeHtml(r.klass)}</span>${dupBadge(r)}
        </div>
        <div class="pending-meta">
          <div>Skola: <b>${escapeHtml(r.school || '–')}</b> &nbsp;·&nbsp; Kön: <b>${escapeHtml(r.gender || '–')}</b> &nbsp;·&nbsp; Går på fritids: <b>${r.attendsFritids ? "Ja" : "Nej"}</b> &nbsp;·&nbsp; Går hem själv: <b>${goesHomeLabel(r.goesHomeAlone)}</b></div>
          <div>Barnets telefon: <b>${r.childPhone ? phoneLink(r.childPhone) : '–'}</b></div>
          <div>Förälder: <b>${escapeHtml(r.parentName)}</b> &nbsp;·&nbsp; Telefon: <b>${phoneLink(r.parentPhone)}</b></div>
          <div>Önskemål: <b>${escapeHtml(wishIds(r).map(id => activityName(currentBranch, id)).join(', ') || '–')}</b></div>
          ${typeof r.familyChildren !== "undefined" ? `<div>Familj: <b>${intText(r.familyChildren)} barn / ${intText(r.familyAdults)} vuxna</b></div>` : ''}
          ${r.otherInfo ? `<div>Övrig info: <b>${escapeHtml(r.otherInfo)}</b></div>` : ''}
        </div>
        <label class="muted" style="font-size:12px;">Placera i:</label>
        <div class="activity-checks pending-place-checks">${checksHtml}</div>
        <div class="pending-actions">
          <button class="rowbtn admin-only" data-remove-pending="${escapeHtml(r.id)}">Ta bort ansökan</button>
          <button class="btn small place-btn">Placera</button>
        </div>
      </div>`;
  }).join("");

  wrap.querySelectorAll(".place-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".pending-card");
      const regId = card.dataset.reg;
      const chosen = Array.from(card.querySelectorAll('.pending-place-checks input[type="checkbox"]:checked')).map(c => c.value);
      if(!chosen.length){
        alert("Välj minst en aktivitet att placera i.");
        return;
      }
      const toPlace = [];
      const toReserve = [];
      chosen.forEach(id => {
        const act = acts(currentBranch).find(a => a.id === id);
        const full = act && act.maxSpots && realPlacedCountFor(currentBranch, id) >= act.maxSpots;
        if(full) toReserve.push(id); else toPlace.push(id);
      });
      await updateDoc(doc(db, "registrations", regId), { placedActivityIds: toPlace, reserveActivityIds: toReserve });
      await Promise.all(toPlace.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(1) }).catch(() => {})));
      if(toReserve.length){
        const names = toReserve.map(id => activityName(currentBranch, id)).join(', ');
        alert('Fullt just nu för: ' + names + '. Placerad i reservlistan istället — hittas under "Reservlista".');
      }
    });
  });

  wrap.querySelectorAll("[data-remove-pending]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if(!confirm("Ta bort den här ansökan helt?")) return;
      await deleteRegistrationEntirely(btn.dataset.removePending);
    });
  });
}

/* ---------- Reservlista ---------- */

let reserveFilter = "";
document.getElementById("reserveSearch").addEventListener("input", (e) => {
  reserveFilter = e.target.value.trim().toLowerCase();
  renderReserveList();
});

function renderReserveList(){
  const wrap = document.getElementById("reserveApps");
  const countEl = document.getElementById("reserveCount");
  const branchActs = sortByDay(acts(currentBranch));
  let totalWaiting = 0;

  const groupsHtml = branchActs.map(act => {
    const allWaiting = regs(currentBranch).filter(r => reserveIds(r).includes(act.id)).sort((a,b) => a.ts - b.ts);
    totalWaiting += allWaiting.length;
    const waiting = reserveFilter
      ? allWaiting.filter(r => (r.childName || "").toLowerCase().includes(reserveFilter) || (r.klass || "").toLowerCase().includes(reserveFilter))
      : allWaiting;
    if(!waiting.length) return "";
    const rows = waiting.map(r => `
      <tr data-reg="${escapeHtml(r.id)}" data-act="${act.id}">
        <td data-label="Barn">${escapeHtml(r.childName)}${dupBadge(r)}</td>
        <td data-label="Åk/Klass">${escapeHtml(r.grade)} / ${escapeHtml(r.klass)}</td>
        <td data-label="Fritids">${fritidsBadgeHtml(r.attendsFritids)}</td>
        <td data-label="Förälder">${escapeHtml(r.parentName)}</td>
        <td data-label="Telefon">${phoneLink(r.parentPhone)}</td>
        <td data-label="" class="no-print stack-actions">
          <button class="btn small reserve-place-btn">Placera</button>
          <button class="rowbtn reserve-remove-btn">Ta bort från reserv</button>
        </td>
      </tr>`).join("");
    const full = act.maxSpots && realPlacedCountFor(currentBranch, act.id) >= act.maxSpots;
    return `
      <div class="adm-act">
        <div class="adm-act-head">
          <div>
            <span class="name">${escapeHtml(act.name)}</span>
            <span class="count"> · ${realPlacedCountFor(currentBranch, act.id)}${act.maxSpots ? ' / ' + act.maxSpots : ''} placerade · ${allWaiting.length} i reserv</span>
          </div>
          ${full ? '<span class="badge full">Fortfarande fullt</span>' : '<span class="badge ok">Ledig plats!</span>'}
        </div>
        <div class="table-scroll">
        <table class="responsive-stack">
          <thead><tr><th>Barn</th><th>Åk/Klass</th><th>Fritids</th><th>Förälder</th><th>Telefon</th><th class="no-print"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        </div>
      </div>`;
  }).join("");

  if(countEl) countEl.textContent = totalWaiting ? `(${totalWaiting} st)` : "";
  if(!totalWaiting){
    wrap.innerHTML = '<p class="empty">Ingen står i reserv just nu.</p>';
  }else if(!groupsHtml.trim()){
    wrap.innerHTML = '<p class="empty">Ingen matchning.</p>';
  }else{
    wrap.innerHTML = groupsHtml;
  }

  wrap.querySelectorAll(".reserve-place-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const regId = tr.dataset.reg;
      const actId = tr.dataset.act;
      const r = regs(currentBranch).find(x => x.id === regId);
      const act = acts(currentBranch).find(a => a.id === actId);
      if(!r || !act) return;
      if(act.maxSpots && realPlacedCountFor(currentBranch, actId) >= act.maxSpots){
        if(!confirm(act.name + ' är fortfarande fullt. Placera ändå?')) return;
      }
      const newReserve = reserveIds(r).filter(id => id !== actId);
      const newPlaced = [...placedIds(r), actId];
      await updateDoc(doc(db, "registrations", regId), { reserveActivityIds: newReserve, placedActivityIds: newPlaced });
      await updateDoc(doc(db, "activities", actId), { placedCount: increment(1) }).catch(() => {});
    });
  });

  wrap.querySelectorAll(".reserve-remove-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if(!confirm("Ta bort från reservlistan för den här aktiviteten?")) return;
      const tr = btn.closest("tr");
      const regId = tr.dataset.reg;
      const actId = tr.dataset.act;
      const r = regs(currentBranch).find(x => x.id === regId);
      if(!r) return;
      const newReserve = reserveIds(r).filter(id => id !== actId);
      await updateDoc(doc(db, "registrations", regId), { reserveActivityIds: newReserve });
    });
  });
}

/* ---------- Ta bort en hel anmälan (dekrementerar placedCount) ---------- */

// Tar bort en anmälan helt. En "Ångra"-knapp visas en stund och återskapar allt (även platsräknare).
async function deleteRegistrationEntirely(regId){
  const r = regs(currentBranch).find(x => x.id === regId);
  const ids = r ? placedIds(r) : [];
  const backup = r ? { ...r } : null;
  if(backup) delete backup.id;
  await deleteDoc(doc(db, "registrations", regId));
  await Promise.all(ids.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(-1) }).catch(() => {})));
  if(!backup) return;
  showToast((backup.childName || "Anmälan") + " togs bort", {
    actionLabel: "Ångra",
    onAction: async () => {
      await setDoc(doc(db, "registrations", regId), backup);
      await Promise.all(ids.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(1) }).catch(() => {})));
      showToast("✓ " + (backup.childName || "Anmälan") + " återställdes");
    }
  });
}

// Massradering med säkerhetsspärrar: skriv RADERA + automatisk Excel-säkerhetskopia först.
async function bulkDeleteRegistrations(list, description){
  if(!list.length){ alert("Det finns inga anmälningar att ta bort."); return false; }
  const answer = prompt(description + "\n\nEn Excel-säkerhetskopia av alla anmälningar laddas ner först.\nSkriv RADERA för att fortsätta.");
  if(answer === null) return false;
  if(answer.trim().toUpperCase() !== "RADERA"){
    alert("Ingen radering gjordes – du skrev inte RADERA.");
    return false;
  }
  const backup = await downloadExcelExport("Sakerhetskopia");
  if(!backup){
    alert("Säkerhetskopian kunde inte skapas, så ingenting har raderats.");
    return false;
  }
  const perActivity = new Map();
  list.forEach(r => placedIds(r).forEach(id => perActivity.set(id, (perActivity.get(id) || 0) + 1)));
  await Promise.all(list.map(r => deleteDoc(doc(db, "registrations", r.id))));
  await Promise.all(Array.from(perActivity.entries()).map(([id, n]) =>
    updateDoc(doc(db, "activities", id), { placedCount: increment(-n) }).catch(() => {})));
  showToast("✓ " + list.length + " anmälningar togs bort. Säkerhetskopian ligger i din nedladdningsmapp.", { duration: 6000 });
  return true;
}

/* ---------- Aktivitetslistor i admin ---------- */

/* ---------- Möjliga dubbletter ---------- */
// Samma barn kan söka flera gånger (t.ex. två föräldrar, eller om sidan laddats om).
// Två anmälningar flaggas om namnet är detsamma (utan hänsyn till versaler/accenter)
// OCH förälderns telefonnummer eller klassen är samma. Personalen avgör själv vad som tas bort.

const dupCache = { src: null, set: new Set() };
function getDuplicates(){
  const list = regs(currentBranch);
  if(dupCache.src === list) return dupCache.set;
  const groups = new Map();
  list.forEach(r => {
    const key = normName(r.childName);
    if(!key) return;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const flagged = new Set();
  groups.forEach(group => {
    for(let i = 0; i < group.length; i++){
      for(let j = i + 1; j < group.length; j++){
        const a = group[i], b = group[j];
        const pa = normPhone(a.parentPhone);
        const samePhone = pa && pa === normPhone(b.parentPhone);
        const sameClass = a.klass && b.klass && String(a.klass).trim().toLowerCase() === String(b.klass).trim().toLowerCase();
        if(samePhone || sameClass){ flagged.add(a.id); flagged.add(b.id); }
      }
    }
  });
  dupCache.src = list;
  dupCache.set = flagged;
  return flagged;
}
function dupBadge(r){
  return getDuplicates().has(r.id)
    ? ' <span class="dup-badge" title="Möjlig dubblett – samma namn finns med samma telefonnummer eller klass">Möjlig dubblett</span>'
    : "";
}

function renderAdminOverview(){
  const wrap = document.getElementById("adminOverview");
  const pendingCount = regs(currentBranch).filter(r => placedIds(r).length === 0 && reserveIds(r).length === 0).length;
  const reserveCount = regs(currentBranch).reduce((n, r) => n + reserveIds(r).length, 0);
  const placedCount = regs(currentBranch).filter(r => placedIds(r).length > 0).length;
  const activityCount = acts(currentBranch).length;
  const fritidsCount = fritidsListFor(currentBranch).length;

  const boxes = [
    { label: "Väntande", num: pendingCount, subtab: "activities", warn: pendingCount > 0 },
    { label: "I reserv", num: reserveCount, subtab: "activities", warn: reserveCount > 0 },
    { label: "Placerade", num: placedCount, subtab: "participants", warn: false },
    { label: "Aktiviteter", num: activityCount, subtab: "activities", warn: false },
    { label: "På fritids", num: fritidsCount, subtab: "participants", warn: false }
  ];
  const dupCount = getDuplicates().size;
  if(dupCount) boxes.push({ label: "Möjliga dubbletter", num: dupCount, subtab: "participants", warn: true });

  wrap.innerHTML = boxes.map(b => `
    <div class="overview-box${b.warn ? ' overview-warn' : ''}" data-jump-subtab="${b.subtab}">
      <span class="num">${b.num}</span>
      <span class="lbl">${escapeHtml(b.label)}</span>
    </div>`).join("");

  wrap.querySelectorAll("[data-jump-subtab]").forEach(box => {
    box.addEventListener("click", () => {
      const target = box.dataset.jumpSubtab;
      document.querySelectorAll(".subtabbtn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".adm-subview").forEach(v => v.classList.remove("active"));
      document.querySelector(`.subtabbtn[data-subtab="${target}"]`).classList.add("active");
      document.getElementById("adm-sub-" + target).classList.add("active");
    });
  });
}

function renderAdmin(){
  updateHeaderForAdminBranch();
  renderNewActSchoolsOptions();
  reconcileCounts(currentBranch);
  renderAdminOverview();
  renderPending();
  renderReserveList();
  const wrap = document.getElementById("adminActivities");
  wrap.innerHTML = "";
  const branchActs = acts(currentBranch);
  if(!branchActs.length){
    wrap.innerHTML = '<p class="empty">Inga aktiviteter tillagda ännu för ' + escapeHtml(branchInfo(currentBranch).name) + '. Lägg till en ovan.</p>';
  }

  STADIUMS.forEach(st => {
    const stActs = activitiesForStadium(currentBranch, st.id);
    if(!stActs.length) return;
    const heading = document.createElement("h4");
    heading.className = "stadium-heading";
    heading.innerHTML = `${st.label} <span class="muted">(${st.sub})</span>`;
    wrap.appendChild(heading);

    stActs.forEach(act => {
      const regsHere = regs(currentBranch).filter(r => placedIds(r).includes(act.id));
      const box = document.createElement("div");
      box.className = "adm-act";
      const rowsHtml = regsHere.length
        ? regsHere.map(r => `
            <tr data-reg="${escapeHtml(r.id)}">
              <td data-label="Barn">
                <div class="roster-cell">
                  <div class="roster-primary">${escapeHtml(r.childName)}${dupBadge(r)}</div>
                  <div class="roster-sub">${escapeHtml(r.klass)}</div>
                </div>
              </td>
              <td data-label="Förälder">
                <div class="roster-cell">
                  <div class="roster-primary">${escapeHtml(r.parentName)}</div>
                  <div class="roster-sub">${phoneLink(r.parentPhone)}</div>
                </div>
              </td>
              <td data-label="Fritids">${fritidsBadgeHtml(r.attendsFritids)}</td>
              <td data-label="Hemgång">${homeBadgeHtml(r.goesHomeAlone)}</td>
              <td data-label="Kontaktad" class="roster-center">
                <label class="icon-toggle" title="Kontaktat förälder">
                  <input type="checkbox" class="contacted-toggle" ${r.parentContacted ? "checked" : ""}>
                  <span class="icon-toggle-mark" aria-hidden="true">☎</span>
                  <span class="sr-only">Kontaktat förälder</span>
                </label>
              </td>
              <td data-label="" class="row-menu-cell">
                <button class="rowbtn row-menu-toggle" aria-haspopup="true" aria-expanded="false"><span aria-hidden="true">⋯</span> Mer<span class="sr-only"> om ${escapeHtml(r.childName)}</span></button>
                <div class="row-menu-panel">
                  <div class="row-menu-move">
                    <select class="move-act-select">
                      <option value="">Flytta till…</option>
                      ${moveOptionsHtml(currentBranch, act.id)}
                    </select>
                    <button class="rowbtn small move-act-btn">Flytta</button>
                  </div>
                  <button class="rowbtn addact-from-roster-btn" data-reg="${escapeHtml(r.id)}">➕ Lägg till i annan aktivitet</button>
                  <button class="rowbtn unplace-btn" title="Tar bara bort barnet från den här aktiviteten">Ta bort från aktivitet</button>
                  <button class="rowbtn danger-text admin-only" data-reg-remove="${escapeHtml(r.id)}" title="Tar bort hela anmälan">Ta bort deltagare</button>
                </div>
              </td>
            </tr>`).join("")
        : `<tr><td colspan="6" class="empty">Ingen placerad här än.</td></tr>`;

      const pct = act.maxSpots ? Math.min(100, Math.round((regsHere.length / act.maxSpots) * 100)) : null;

      box.innerHTML = `
        <div class="adm-act-head">
          <div>
            <span class="name">${escapeHtml(act.name)}</span>
            <span class="count"> · ${regsHere.length}${act.maxSpots ? ' / ' + act.maxSpots : ''} placerade</span>
          </div>
          <button class="del-x admin-only" data-act="${act.id}" title="Ta bort aktivitet" aria-label="Ta bort aktivitet">✕</button>
        </div>
        ${act.maxSpots ? `<div class="capacity-bar"><div class="capacity-fill${pct >= 100 ? ' full' : ''}" style="width:${pct}%;"></div></div>` : ''}
        <div class="adm-act-meta">
          <span class="meta-item" data-act-schedule="${act.id}">
            <span class="meta-value schedule-text"><span aria-hidden="true">🕐</span> ${act.schedule ? escapeHtml(act.schedule) : '<span class="muted">Ingen tid</span>'}</span>
            <button class="meta-edit schedule-edit-btn">Ändra</button>
          </span>
          <span class="meta-sep">·</span>
          <span class="meta-item">
            <span class="meta-value"><span aria-hidden="true">🏫</span> ${(act.schools && act.schools.length) ? escapeHtml(act.schools.join(', ')) : 'Alla skolor'}</span>
          </span>
          <span class="meta-sep">·</span>
          <span class="meta-item" data-act-maxspots="${act.id}">
            <span class="meta-value maxspots-text"><span aria-hidden="true">🎟️</span> ${act.maxSpots ? escapeHtml(String(act.maxSpots)) + ' platser' : 'Obegränsat'}</span>
            <button class="meta-edit maxspots-edit-btn">Ändra</button>
          </span>
        </div>
        <div class="table-scroll">
        <table class="responsive-stack">
          <thead><tr><th>Barn</th><th>Förälder</th><th>Fritids</th><th>Hemgång</th><th>Kontaktad</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        </div>
        <div class="adm-act-foot">
          <button class="btn small add-participant-btn" type="button">➕ Lägg till deltagare</button>
        </div>
      `;
      wrap.appendChild(box);

      box.querySelector(".add-participant-btn").addEventListener("click", () => {
        openAddParticipant(act.id);
      });

      box.querySelectorAll(".row-menu-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
          const panel = btn.nextElementSibling;
          const wasOpen = panel.classList.contains("open");
          closeRowMenus();
          if(wasOpen) return;
          panel.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
          positionRowMenu(btn, panel);
          openRowMenu = { btn, panel };
        });
      });

      const scheduleRow = box.querySelector(`[data-act-schedule="${act.id}"]`);
      scheduleRow.querySelector(".schedule-edit-btn").addEventListener("click", () => {
        scheduleRow.innerHTML = `
          <div class="act-schedule-edit">
            <input type="text" class="schedule-input" value="${escapeHtml(act.schedule || '')}" placeholder="t.ex. Måndag 15:00–16:15">
            <button class="btn small schedule-save-btn">Spara</button>
            <button class="ghostlink schedule-cancel-btn">Avbryt</button>
          </div>`;
        scheduleRow.querySelector(".schedule-save-btn").addEventListener("click", async () => {
          const newSchedule = scheduleRow.querySelector(".schedule-input").value.trim();
          await updateDoc(doc(db, "activities", act.id), { schedule: newSchedule });
        });
        scheduleRow.querySelector(".schedule-cancel-btn").addEventListener("click", () => {
          renderAdmin();
        });
      });

      const maxSpotsRow = box.querySelector(`[data-act-maxspots="${act.id}"]`);
      maxSpotsRow.querySelector(".maxspots-edit-btn").addEventListener("click", () => {
        maxSpotsRow.innerHTML = `
          <div class="act-schedule-edit">
            <input type="number" min="0" class="maxspots-input" value="${act.maxSpots || ''}" placeholder="Lämna tomt = obegränsat">
            <button class="btn small maxspots-save-btn">Spara</button>
            <button class="ghostlink maxspots-cancel-btn">Avbryt</button>
          </div>`;
        maxSpotsRow.querySelector(".maxspots-save-btn").addEventListener("click", async () => {
          const raw = maxSpotsRow.querySelector(".maxspots-input").value;
          const newMax = raw.trim() === "" ? null : Math.max(0, parseInt(raw, 10) || 0);
          const currentlyPlaced = realPlacedCountFor(currentBranch, act.id);
          if(newMax !== null && newMax < currentlyPlaced){
            if(!confirm(`Det är redan ${currentlyPlaced} placerade. Sätta max till ${newMax} ändå? (Ingen tas automatiskt bort.)`)) return;
          }
          await updateDoc(doc(db, "activities", act.id), { maxSpots: newMax });
        });
        maxSpotsRow.querySelector(".maxspots-cancel-btn").addEventListener("click", () => {
          renderAdmin();
        });
      });

      box.querySelector(".del-x").addEventListener("click", async () => {
        if(!confirm('Ta bort aktiviteten "' + act.name + '"? Den tas bort ur alla ansökningar/placeringar/reserver som nämner den.')) return;
        const affected = regs(currentBranch).filter(r => wishIds(r).includes(act.id) || placedIds(r).includes(act.id) || reserveIds(r).includes(act.id));
        await Promise.all(affected.map(r => {
          const newWish = wishIds(r).filter(id => id !== act.id);
          const newPlaced = placedIds(r).filter(id => id !== act.id);
          const newReserve = reserveIds(r).filter(id => id !== act.id);
          return updateDoc(doc(db, "registrations", r.id), { wishActivityIds: newWish, placedActivityIds: newPlaced, reserveActivityIds: newReserve });
        }));
        await deleteDoc(doc(db, "activities", act.id));
      });

      box.querySelectorAll("[data-reg-remove]").forEach(b => {
        b.addEventListener("click", async () => {
          if(!confirm("Ta bort den här deltagaren helt (alla placeringar och ansökan)?")) return;
          await deleteRegistrationEntirely(b.dataset.regRemove);
        });
      });

      box.querySelectorAll(".addact-from-roster-btn").forEach(b => {
        b.addEventListener("click", () => {
          closeRowMenus();
          openAddToActivity(b.dataset.reg);
        });
      });

      box.querySelectorAll(".unplace-btn").forEach(b => {
        b.addEventListener("click", async () => {
          const tr = b.closest("tr");
          const regId = tr.dataset.reg;
          const r = regs(currentBranch).find(x => x.id === regId);
          if(!r) return;
          const newPlaced = placedIds(r).filter(id => id !== act.id);
          await updateDoc(doc(db, "registrations", regId), { placedActivityIds: newPlaced });
          await updateDoc(doc(db, "activities", act.id), { placedCount: increment(-1) }).catch(() => {});
        });
      });

      box.querySelectorAll(".contacted-toggle").forEach(cb => {
        cb.addEventListener("change", async () => {
          const tr = cb.closest("tr");
          const regId = tr.dataset.reg;
          await updateDoc(doc(db, "registrations", regId), { parentContacted: cb.checked });
        });
      });

      box.querySelectorAll(".move-act-btn").forEach(b => {
        b.addEventListener("click", async () => {
          const tr = b.closest("tr");
          const regId = tr.dataset.reg;
          const targetId = tr.querySelector(".move-act-select").value;
          if(!targetId){
            alert("Välj vilken aktivitet barnet ska flyttas till.");
            return;
          }
          const r = regs(currentBranch).find(x => x.id === regId);
          const targetAct = acts(currentBranch).find(a => a.id === targetId);
          if(!r || !targetAct) return;
          if(targetAct.maxSpots && realPlacedCountFor(currentBranch, targetId) >= targetAct.maxSpots){
            if(!confirm(targetAct.name + ' är redan fullt. Flytta ändå?')) return;
          }
          const newPlaced = placedIds(r).filter(id => id !== act.id);
          newPlaced.push(targetId);
          await updateDoc(doc(db, "registrations", regId), { placedActivityIds: newPlaced });
          await updateDoc(doc(db, "activities", act.id), { placedCount: increment(-1) }).catch(() => {});
          await updateDoc(doc(db, "activities", targetId), { placedCount: increment(1) }).catch(() => {});
        });
      });
    });
  });

  renderDeltagarlista();
  renderFritidslista();
  renderBuddies();
  renderStats();
  renderTodos();
  renderSettings();
}

document.getElementById("contactSearch").addEventListener("input", (e) => {
  contactFilter = e.target.value.trim().toLowerCase();
  renderDeltagarlista();
});

/* ---------- Lägg till deltagare (dialog, admin) ---------- */
// Samma uppgifter som föräldrarna fyller i vid anmälan, plus val av vilka
// aktiviteter barnet ska placeras i. Öppnas från deltagarlistan eller från
// ett aktivitetskort (då är den aktiviteten förvald).

let npForcedActId = null;    // aktivitet som alltid ska synas i listan (öppnad från aktivitetskort)
let npInitialCheckId = null; // aktivitet som ska vara förkryssad första gången

function npEl(id){ return document.getElementById(id); }

// Kort bekräftelse. Med { actionLabel, onAction } får den en knapp (t.ex. "Ångra").
function showToast(message, options = {}){
  const t = document.createElement("div");
  t.className = "toast" + (options.onAction ? " has-action" : "");
  t.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  t.appendChild(text);
  const remove = () => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); };
  if(options.onAction){
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = options.actionLabel || "Ångra";
    b.addEventListener("click", async () => { remove(); await options.onAction(); });
    t.appendChild(b);
  }
  let host = document.getElementById("toastHost");
  if(!host){
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(remove, options.duration || (options.onAction ? 9000 : 2600));
}

function npClearErrors(){
  ["np-name","np-school","np-grade","np-class","np-parentname","np-parentphone"].forEach(id => npEl(id).classList.remove("field-error"));
  ["np-gender","np-gohome","np-activities","np-family-fields"].forEach(id => npEl(id).classList.remove("field-error"));
  npEl("newParticipant-err").style.display = "none";
}

function npResetForm(keepContext){
  ["np-name","np-class","np-childphone","np-parentname","np-parentphone","np-other","np-family-children","np-family-adults"].forEach(id => npEl(id).value = "");
  npEl("np-fritids").checked = false;
  document.querySelectorAll('input[name="npgender"], input[name="npgohome"]').forEach(r => r.checked = false);
  if(!keepContext){
    npEl("np-grade").value = "";
    npEl("np-activities").innerHTML = "";
  }
  npClearErrors();
}

function openAddParticipant(preActId){
  npResetForm(false);
  const schools = SCHOOLS_BY_BRANCH[currentBranch] || [];
  const preAct = preActId ? acts(currentBranch).find(a => a.id === preActId) : null;

  const schoolSel = npEl("np-school");
  schoolSel.innerHTML = '<option value="">Välj skola</option>' +
    schools.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if(schools.length === 1){
    schoolSel.value = schools[0];
  }else if(preAct && preAct.schools && preAct.schools.length === 1){
    schoolSel.value = preAct.schools[0];
  }

  npForcedActId = preAct ? preAct.id : null;
  npInitialCheckId = preAct ? preAct.id : null;
  npEl("npSub").textContent = preAct
    ? `Läggs till i ${preAct.name}. Samma uppgifter som föräldrarna fyller i.`
    : "Samma uppgifter som föräldrarna fyller i vid anmälan.";

  renderNewParticipantActivities();
  npUpdateFamilyFields();
  openModalEl(npEl("npModal"), npEl("np-name"));
}

function closeAddParticipant(){
  closeModalEl(npEl("npModal"));
  npForcedActId = null;
  npInitialCheckId = null;
}
registerModal(npEl("npModal"), closeAddParticipant);

function renderNewParticipantActivities(){
  const wrap = npEl("np-activities");
  const school = npEl("np-school").value;
  const grade = npEl("np-grade").value;
  const stadium = stadiumForGrade(grade);

  const checked = new Set(Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value));
  if(npInitialCheckId){ checked.add(npInitialCheckId); npInitialCheckId = null; }

  const seen = new Set();
  const sections = [];
  function addSection(label, list){
    const opts = list.filter(a => !seen.has(a.id));
    opts.forEach(a => seen.add(a.id));
    if(opts.length) sections.push({ label, options: opts });
  }
  const forSchool = list => list.filter(a => activityMatchesSchool(a, school));

  if(stadium){
    addSection(STADIUMS.find(s => s.id === stadium).label, forSchool(activitiesForStadium(currentBranch, stadium)));
  }
  addSection("Utflykter", forSchool(activitiesForStadium(currentBranch, "utflykt")));
  if(stadium === "f" || stadium === "lag"){
    addSection("Familjeaktivitet", forSchool(activitiesForStadium(currentBranch, "familj")));
  }
  if(npForcedActId && !seen.has(npForcedActId)){
    const a = acts(currentBranch).find(x => x.id === npForcedActId);
    if(a) addSection("Vald aktivitet", [a]);
  }

  wrap.innerHTML = "";
  sections.forEach(sec => {
    const heading = document.createElement("div");
    heading.className = "achk-section-heading";
    heading.textContent = sec.label;
    wrap.appendChild(heading);
    sec.options.forEach(a => {
      const count = realPlacedCountFor(currentBranch, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      const label = document.createElement("label");
      label.className = "activity-check";
      label.innerHTML = `
        <input type="checkbox" value="${a.id}" ${actStadiums(a).includes("familj") ? 'data-family="1"' : ''} ${checked.has(a.id) ? "checked" : ""}>
        <span>${activityLabelHtml(a)}</span>
        <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt – hamnar i reserv' : (count + '/' + a.maxSpots)) : ''}</span>`;
      wrap.appendChild(label);
    });
  });

  if(!sections.length){
    wrap.innerHTML = '<p class="muted">Välj skola och årskurs för att se aktiviteter.</p>';
  }else if(!stadium){
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.style.marginTop = "6px";
    hint.textContent = "Välj årskurs för att se fler aktiviteter.";
    wrap.appendChild(hint);
  }
}

function npUpdateFamilyFields(){
  const anyFamily = document.querySelectorAll('#np-activities input[data-family="1"]:checked').length > 0;
  const box = npEl("np-family-fields");
  box.classList.toggle("show", anyFamily);
  if(!anyFamily){
    npEl("np-family-children").value = "";
    npEl("np-family-adults").value = "";
    box.classList.remove("field-error");
  }
}

npEl("newParticipantToggleBtn").addEventListener("click", () => openAddParticipant(null));
npEl("np-close-btn").addEventListener("click", closeAddParticipant);
npEl("np-cancel-btn").addEventListener("click", closeAddParticipant);
npEl("npModal").addEventListener("click", (e) => {
  if(e.target === npEl("npModal")) closeAddParticipant();
});
npEl("np-school").addEventListener("change", () => { renderNewParticipantActivities(); npUpdateFamilyFields(); });
npEl("np-grade").addEventListener("change", () => { renderNewParticipantActivities(); npUpdateFamilyFields(); });
npEl("np-activities").addEventListener("change", () => {
  npUpdateFamilyFields();
  npEl("np-activities").classList.remove("field-error");
});
npEl("npModal").addEventListener("input", (e) => {
  e.target.classList.remove("field-error");
  const wrap = e.target.closest(".pf-radio-row, .pf-family-fields");
  if(wrap) wrap.classList.remove("field-error");
});

async function saveNewParticipant(addAnother){
  const err = npEl("newParticipant-err");
  npClearErrors();

  const childName = npEl("np-name").value.trim();
  const genderInput = document.querySelector('input[name="npgender"]:checked');
  const gender = genderInput ? genderInput.value : "";
  const school = npEl("np-school").value;
  const grade = npEl("np-grade").value;
  const klass = npEl("np-class").value.trim();
  const gohomeInput = document.querySelector('input[name="npgohome"]:checked');
  const goesHomeAlone = gohomeInput ? gohomeInput.value === "ja" : null;
  const attendsFritids = npEl("np-fritids").checked;
  const childPhone = npEl("np-childphone").value.trim();
  const parentName = npEl("np-parentname").value.trim();
  const parentPhone = npEl("np-parentphone").value.trim();
  const otherInfo = npEl("np-other").value.trim();
  const activityIds = Array.from(new Set(
    Array.from(document.querySelectorAll('#np-activities input[type="checkbox"]:checked')).map(c => c.value)
  ));
  const isFamily = document.querySelectorAll('#np-activities input[data-family="1"]:checked').length > 0;

  let firstInvalid = null;
  function invalid(id){
    const el = npEl(id);
    el.classList.add("field-error");
    if(!firstInvalid) firstInvalid = el;
  }
  if(!childName) invalid("np-name");
  if(!gender) invalid("np-gender");
  if(!school) invalid("np-school");
  if(!grade) invalid("np-grade");
  if(!klass) invalid("np-class");
  if(goesHomeAlone === null) invalid("np-gohome");
  if(!parentName) invalid("np-parentname");
  if(!parentPhone) invalid("np-parentphone");
  if(isFamily && (npEl("np-family-children").value === "" || npEl("np-family-adults").value === "")) invalid("np-family-fields");

  if(firstInvalid){
    err.textContent = "Fyll i de markerade fälten innan du sparar.";
    err.style.display = "block";
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  // Full aktivitet → reservlistan (samma regler som när man placerar en väntande ansökan).
  const toPlace = [];
  const toReserve = [];
  activityIds.forEach(id => {
    const act = acts(currentBranch).find(a => a.id === id);
    const full = act && act.maxSpots && realPlacedCountFor(currentBranch, id) >= act.maxSpots;
    if(full) toReserve.push(id); else toPlace.push(id);
  });

  const data = {
    branch: currentBranch, childName, gender, school, grade, klass,
    attendsFritids, goesHomeAlone, childPhone, parentName, parentPhone, otherInfo,
    wishActivityIds: activityIds, placedActivityIds: toPlace, reserveActivityIds: toReserve,
    parentContacted: false, ts: Date.now()
  };
  if(isFamily){
    data.familyChildren = parseInt(npEl("np-family-children").value, 10) || 0;
    data.familyAdults = parseInt(npEl("np-family-adults").value, 10) || 0;
  }

  const buttons = [npEl("np-save-btn"), npEl("np-save-more-btn")];
  buttons.forEach(b => b.disabled = true);
  try{
    await addDoc(registrationsCol, data);
    await Promise.all(toPlace.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(1) }).catch(() => {})));
  }catch(e){
    err.textContent = "Kunde inte spara, kolla internetanslutningen och försök igen.";
    err.style.display = "block";
    console.error(e);
    buttons.forEach(b => b.disabled = false);
    return;
  }
  buttons.forEach(b => b.disabled = false);

  const reserveNames = toReserve.map(id => activityName(currentBranch, id)).join(", ");
  if(addAnother){
    npResetForm(true);
    renderNewParticipantActivities();
    npUpdateFamilyFields();
    npEl("np-name").focus();
  }else{
    closeAddParticipant();
  }
  showToast(`✓ ${childName} tillagd${activityIds.length ? "" : " (väntar på placering)"}`);
  if(toReserve.length){
    alert('Fullt just nu för: ' + reserveNames + '. ' + childName + ' hamnade i reservlistan för den aktiviteten.');
  }
}

npEl("np-save-btn").addEventListener("click", () => saveNewParticipant(false));
npEl("np-save-more-btn").addEventListener("click", () => saveNewParticipant(true));

function renderDeltagarlista(){
  const wrap = document.getElementById("deltagarlista");
  wrap.innerHTML = "";
  renderPruneInfo();

  const printTitle = document.createElement("h3");
  printTitle.className = "printTitle";
  printTitle.textContent = "Deltagarlista · " + branchInfo(currentBranch).name + " · " + new Date().toLocaleDateString('sv-SE');
  wrap.appendChild(printTitle);

  STADIUMS.forEach(st => {
    let list;
    if(st.id === "utflykt" || st.id === "familj"){
      const catActIds = new Set(activitiesForStadium(currentBranch, st.id).map(a => a.id));
      list = regs(currentBranch).filter(r =>
        placedIds(r).some(id => catActIds.has(id)) || wishIds(r).some(id => catActIds.has(id))
      );
    }else{
      list = regs(currentBranch).filter(r => stadiumForGrade(r.grade) === st.id);
    }
    if(contactFilter){
      list = list.filter(r =>
        (r.childName || "").toLowerCase().includes(contactFilter) ||
        (r.klass || "").toLowerCase().includes(contactFilter) ||
        (r.school || "").toLowerCase().includes(contactFilter) ||
        (r.parentName || "").toLowerCase().includes(contactFilter) ||
        (r.parentPhone || "").toLowerCase().includes(contactFilter)
      );
    }
    list = list.slice().sort((a,b) => (gradeSortValue(a.grade) - gradeSortValue(b.grade)) || a.childName.localeCompare(b.childName, 'sv'));

    if(!list.length && !contactFilter && (st.id === "utflykt" || st.id === "familj")) return;

    const section = document.createElement("div");
    section.className = "deltagar-group";
    const rowsHtml = list.length
      ? list.map(r => {
          const placedNames = placedIds(r).map(id => activityName(currentBranch, id));
          return `
          <tr data-reg="${escapeHtml(r.id)}">
            <td data-label="Barn">${escapeHtml(r.childName)}${dupBadge(r)}</td>
            <td data-label="Kön">${escapeHtml(r.gender || '–')}</td>
            <td data-label="Skola">${escapeHtml(r.school || '–')}</td>
            <td data-label="Åk">${escapeHtml(r.grade)}</td>
            <td data-label="Klass">${escapeHtml(r.klass)}</td>
            <td data-label="Fritids">${r.attendsFritids ? "Ja" : "Nej"}</td>
            <td data-label="Går hem själv">${goesHomeLabel(r.goesHomeAlone)}</td>
            <td data-label="Kontaktad"><label class="contact-check"><input type="checkbox" class="contacted-toggle" ${r.parentContacted ? "checked" : ""}> Kontaktad</label></td>
            <td data-label="Förälder">${escapeHtml(r.parentName)}</td>
            <td data-label="Förälders tel">${phoneLink(r.parentPhone)}</td>
            <td data-label="Barnets tel">${r.childPhone ? phoneLink(r.childPhone) : '<span class="muted">–</span>'}</td>
            <td data-label="Aktivitet(er)">${placedNames.length ? escapeHtml(placedNames.join(', ')) : '<span class="muted">Väntar på placering</span>'}</td>
            <td data-label="Familj: barn/vuxna">${typeof r.familyChildren !== "undefined" ? (intText(r.familyChildren) + ' / ' + intText(r.familyAdults)) : ''}</td>
            <td data-label="Övrig info">${r.otherInfo ? escapeHtml(r.otherInfo) : ''}</td>
            <td data-label="" class="no-print stack-actions">
              <button class="rowbtn contact-addact-btn" title="Lägg till i fler aktiviteter">➕ Aktivitet</button>
              <button class="rowbtn contact-edit-btn">Ändra</button>
              <button class="rowbtn admin-only" data-contact-remove="${escapeHtml(r.id)}">Ta bort</button>
            </td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="15" class="empty">${contactFilter ? 'Ingen matchning.' : 'Ingen anmäld i den här gruppen än.'}</td></tr>`;

    const cardsHtml = list.length
      ? list.map(r => {
          const placedNames = placedIds(r).map(id => activityName(currentBranch, id));
          return `
          <div class="contact-card" data-reg="${escapeHtml(r.id)}">
            <div class="contact-card-head">
              <span class="contact-card-name">${escapeHtml(r.childName)}</span>
              <span class="badge ok">Åk ${escapeHtml(r.grade)} · ${escapeHtml(r.klass)}</span>${dupBadge(r)}
            </div>
            <div class="contact-card-callrow">
              <div class="contact-card-callitem">
                <span class="muted">Förälder</span>
                <span>${escapeHtml(r.parentName)} — ${phoneLink(r.parentPhone)}</span>
              </div>
              ${r.childPhone ? `<div class="contact-card-callitem"><span class="muted">Barnet</span><span>${phoneLink(r.childPhone)}</span></div>` : ''}
            </div>
            <div class="contact-card-meta">
              <span>${escapeHtml(r.gender || '–')}</span>
              <span>${escapeHtml(r.school || '–')}</span>
              <span>Fritids: ${r.attendsFritids ? "Ja" : "Nej"}</span>
              <span class="${r.goesHomeAlone === false ? 'contact-card-warn' : ''}">Går hem själv: ${goesHomeLabel(r.goesHomeAlone)}</span>
            </div>
            <label class="contact-check" style="margin-bottom:8px;"><input type="checkbox" class="contacted-toggle" ${r.parentContacted ? "checked" : ""}> Kontaktat förälder</label>
            <div class="contact-card-line"><b>Aktivitet(er):</b> ${placedNames.length ? escapeHtml(placedNames.join(', ')) : '<span class="muted">Väntar på placering</span>'}</div>
            ${typeof r.familyChildren !== "undefined" ? `<div class="contact-card-line"><b>Familj:</b> ${intText(r.familyChildren)} barn / ${intText(r.familyAdults)} vuxna</div>` : ''}
            ${r.otherInfo ? `<div class="contact-card-line"><b>Övrig info:</b> ${escapeHtml(r.otherInfo)}</div>` : ''}
            <div class="edit-actions">
              <button class="rowbtn no-print contact-addact-btn" title="Lägg till i fler aktiviteter">➕ Aktivitet</button>
              <button class="rowbtn no-print contact-edit-btn">Ändra</button>
              <button class="rowbtn no-print admin-only" data-contact-remove="${escapeHtml(r.id)}">Ta bort</button>
            </div>
          </div>`;
        }).join("")
      : `<p class="empty">${contactFilter ? 'Ingen matchning.' : 'Ingen anmäld i den här gruppen än.'}</p>`;

    section.innerHTML = `
      <h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub}) · ${list.length} st</span></h4>
      <div class="table-scroll desktop-table">
      <table>
        <thead><tr><th>Barn</th><th>Kön</th><th>Skola</th><th>Åk</th><th>Klass</th><th>Fritids</th><th>Går hem själv</th><th>Kontaktad</th><th>Förälder</th><th>Förälders tel</th><th>Barnets tel</th><th>Aktivitet(er)</th><th>Familj: barn/vuxna</th><th>Övrig info</th><th class="no-print"></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      </div>
      <div class="mobile-card-list">${cardsHtml}</div>`;
    wrap.appendChild(section);
  });

  wrap.querySelectorAll("[data-contact-remove]").forEach(b => {
    b.addEventListener("click", async () => {
      if(!confirm("Ta bort den här deltagaren helt?")) return;
      await deleteRegistrationEntirely(b.dataset.contactRemove);
    });
  });

  wrap.querySelectorAll(".contacted-toggle").forEach(cb => {
    cb.addEventListener("change", async () => {
      const regId = cb.closest("[data-reg]").dataset.reg;
      await updateDoc(doc(db, "registrations", regId), { parentContacted: cb.checked });
    });
  });

  wrap.querySelectorAll(".contact-addact-btn").forEach(btn => {
    btn.addEventListener("click", () => openAddToActivity(btn.closest("[data-reg]").dataset.reg));
  });

  wrap.querySelectorAll(".contact-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const host = btn.closest("[data-reg]");
      const regId = host.dataset.reg;
      const r = regs(currentBranch).find(x => x.id === regId);
      if(!r) return;
      const isRow = host.tagName === "TR";
      const formHtml = contactEditFormHtml(r);
      if(isRow){
        host.innerHTML = `<td colspan="15">${formHtml}</td>`;
      }else{
        host.innerHTML = formHtml;
      }
      bindContactEditHandlers(host, r);
    });
  });
}

function contactEditFormHtml(r){
  const schools = SCHOOLS_BY_BRANCH[currentBranch] || [];
  const grades = ["F","1","2","3","4","5","6","7","8","9"];
  return `
    <div class="edit-grid">
      <label>Barnets namn<input type="text" class="ef-name" value="${escapeHtml(r.childName)}"></label>
      <label>Kön<select class="ef-gender">
        <option value="Flicka" ${r.gender === "Flicka" ? "selected" : ""}>Flicka</option>
        <option value="Pojke" ${r.gender === "Pojke" ? "selected" : ""}>Pojke</option>
        <option value="Annat" ${r.gender === "Annat" ? "selected" : ""}>Annat</option>
      </select></label>
      <label>Skola<select class="ef-school">
        ${schools.map(s => `<option value="${escapeHtml(s)}" ${r.school === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
      </select></label>
      <label>Årskurs<select class="ef-grade">
        ${grades.map(g => `<option value="${g}" ${String(r.grade) === g ? "selected" : ""}>${g === "F" ? "Förskoleklass" : "Åk " + g}</option>`).join("")}
      </select></label>
      <label>Klass<input type="text" class="ef-klass" value="${escapeHtml(r.klass)}"></label>
      <label>Går hem själv<select class="ef-gohome">
        <option value="" ${(r.goesHomeAlone === null || typeof r.goesHomeAlone === "undefined") ? "selected" : ""}>Okänt</option>
        <option value="ja" ${r.goesHomeAlone === true ? "selected" : ""}>Ja</option>
        <option value="nej" ${r.goesHomeAlone === false ? "selected" : ""}>Nej</option>
      </select></label>
      <label class="checkbox-row-inline"><input type="checkbox" class="ef-fritids" ${r.attendsFritids ? "checked" : ""}> Går på fritids</label>
      <label>Förälders namn<input type="text" class="ef-parentname" value="${escapeHtml(r.parentName)}"></label>
      <label>Förälders telefon<input type="tel" class="ef-parentphone" value="${escapeHtml(r.parentPhone)}"></label>
      <label>Barnets telefon<input type="tel" class="ef-childphone" value="${escapeHtml(r.childPhone || '')}"></label>
      <label>Övrig info<input type="text" class="ef-otherinfo" value="${escapeHtml(r.otherInfo || '')}"></label>
      ${typeof r.familyChildren !== "undefined" ? `
      <label>Familj: barn<input type="number" min="0" class="ef-familychildren" value="${intText(r.familyChildren)}"></label>
      <label>Familj: vuxna<input type="number" min="0" class="ef-familyadults" value="${intText(r.familyAdults)}"></label>` : ''}
    </div>
    <div class="edit-actions">
      <button class="btn small ef-save-btn">Spara</button>
      <button class="ghostlink ef-cancel-btn">Avbryt</button>
    </div>`;
}

function bindContactEditHandlers(host, r){
  host.querySelector(".ef-save-btn").addEventListener("click", async () => {
    const gohomeVal = host.querySelector(".ef-gohome").value;
    const updates = {
      childName: host.querySelector(".ef-name").value.trim(),
      gender: host.querySelector(".ef-gender").value,
      school: host.querySelector(".ef-school").value,
      grade: host.querySelector(".ef-grade").value,
      klass: host.querySelector(".ef-klass").value.trim(),
      attendsFritids: host.querySelector(".ef-fritids").checked,
      goesHomeAlone: gohomeVal === "" ? null : gohomeVal === "ja",
      parentName: host.querySelector(".ef-parentname").value.trim(),
      parentPhone: host.querySelector(".ef-parentphone").value.trim(),
      childPhone: host.querySelector(".ef-childphone").value.trim(),
      otherInfo: host.querySelector(".ef-otherinfo").value.trim()
    };
    const fc = host.querySelector(".ef-familychildren");
    const fa = host.querySelector(".ef-familyadults");
    if(fc && fa){
      updates.familyChildren = parseInt(fc.value, 10) || 0;
      updates.familyAdults = parseInt(fa.value, 10) || 0;
    }
    await updateDoc(doc(db, "registrations", r.id), updates);
  });
  host.querySelector(".ef-cancel-btn").addEventListener("click", () => {
    renderDeltagarlista();
  });
}

/* ---------- Fritidslista ---------- */

function fritidslistaTableHtml(list){
  return `
    <div class="table-scroll desktop-table">
    <table class="responsive-stack">
      <thead><tr><th>Barn</th><th>Åk</th><th>Klass</th><th>Aktivitet(er)</th></tr></thead>
      <tbody>
        ${list.map(r => `
          <tr>
            <td data-label="Barn">${escapeHtml(r.childName)}${dupBadge(r)}</td>
            <td data-label="Åk">${escapeHtml(r.grade)}</td>
            <td data-label="Klass">${escapeHtml(r.klass)}</td>
            <td data-label="Aktivitet(er)">${placedIds(r).length ? escapeHtml(placedIds(r).map(id => activityNameWithSchedule(currentBranch, id)).join('; ')) : '<span class="muted">Väntar på placering</span>'}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    </div>`;
}

let fritidsFilter = "";
document.getElementById("fritidsSearch").addEventListener("input", (e) => {
  fritidsFilter = e.target.value.trim().toLowerCase();
  renderFritidslista();
});

function renderFritidslista(){
  const wrap = document.getElementById("fritidslista");
  const list = fritidsListFor(currentBranch);

  document.getElementById("fritidsPrintArea").innerHTML = list.length ? `
    <h3 class="printTitle">Fritidslista · ${escapeHtml(branchInfo(currentBranch).name)} · ${new Date().toLocaleDateString('sv-SE')}</h3>
    ${fritidslistaTableHtml(list)}` : "";

  if(!list.length){
    wrap.innerHTML = '<p class="empty">Inga barn markerade som "Går på fritids" än.</p>';
    return;
  }

  const filtered = fritidsFilter
    ? list.filter(r => (r.childName || "").toLowerCase().includes(fritidsFilter) || (r.klass || "").toLowerCase().includes(fritidsFilter))
    : list;

  if(!filtered.length){
    wrap.innerHTML = '<p class="empty">Ingen matchning.</p>';
    return;
  }
  wrap.innerHTML = `<p class="muted" style="margin-bottom:12px;">${filtered.length} av ${list.length} st går på fritids.</p>` + fritidslistaTableHtml(filtered);
}

document.getElementById("printFritidsBtn").addEventListener("click", () => {
  document.body.classList.add("printing-fritids");
  window.print();
});

function exportHtmlToWord(filename, title, bodyHtml){
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset="utf-8"><title>${title}</title>
    <style>
      body{font-family:Calibri,Arial,sans-serif;}
      h1{font-size:18px;color:#12314F;}
      table{border-collapse:collapse;width:100%;}
      th,td{border:1px solid #888;padding:6px 10px;font-size:12px;text-align:left;}
      th{background:#DCEAFB;}
    </style></head>
    <body>${bodyHtml}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("exportFritidsWordBtn").addEventListener("click", () => {
  const list = fritidsListFor(currentBranch);
  if(!list.length){
    alert('Inga barn markerade som "Går på fritids" att exportera.');
    return;
  }
  const rows = list.map(r => `
    <tr>
      <td>${escapeHtml(r.childName)}</td>
      <td>${escapeHtml(r.grade)}</td>
      <td>${escapeHtml(r.klass)}</td>
      <td>${placedIds(r).length ? escapeHtml(placedIds(r).map(id => activityNameWithSchedule(currentBranch, id)).join('; ')) : 'Väntar på placering'}</td>
    </tr>`).join("");
  const body = `
    <h1>Fritidslista – ${escapeHtml(branchInfo(currentBranch).name)}</h1>
    <p>${new Date().toLocaleDateString('sv-SE')}</p>
    <table>
      <thead><tr><th>Namn</th><th>Åk</th><th>Klass</th><th>Aktivitet(er)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  exportHtmlToWord("fritidslista.doc", "Fritidslista", body);
});

/* ---------- Export till Excel ---------- */
// Skapar en .xlsx med tre blad: Deltagare (all info), Aktiviteter (platser)
// och Placeringar (en rad per barn och aktivitet, lätt att filtrera per aktivitet).

function registrationStatus(r){
  const placed = placedIds(r).length;
  const reserve = reserveIds(r).length;
  if(placed && reserve) return "Placerad + reserv";
  if(placed) return "Placerad";
  if(reserve) return "Reserv";
  return "Väntande";
}

function homeCell(v){
  if(v === false) return { v: "Nej – ska hämtas", warn: true };
  if(v === true) return "Ja";
  return "Okänt";
}

function stadiumLabelsFor(a){
  return actStadiums(a).map(id => {
    const st = STADIUMS.find(x => x.id === id);
    return st ? st.label : id;
  }).join(", ");
}

function byGradeClassName(a, b){
  return (gradeSortValue(a.grade) - gradeSortValue(b.grade))
    || String(a.klass || "").localeCompare(String(b.klass || ""), "sv")
    || String(a.childName || "").localeCompare(String(b.childName || ""), "sv");
}

function buildExportSheets(){
  const branch = currentBranch;
  const allActs = sortByDay(acts(branch));
  const allRegs = regs(branch).slice().sort(byGradeClassName);
  const names = ids => ids.map(id => activityNameWithSchedule(branch, id)).join("; ");

  const deltagare = {
    name: "Deltagare",
    columns: [
      { header: "Barn", width: 26 },
      { header: "Kön", width: 9 },
      { header: "Skola", width: 16 },
      { header: "Årskurs", width: 9 },
      { header: "Klass", width: 8 },
      { header: "Går på fritids", width: 12 },
      { header: "Går hem själv", width: 17 },
      { header: "Förälder", width: 24 },
      { header: "Förälders telefon", width: 17 },
      { header: "Barnets telefon", width: 16 },
      { header: "Kontaktat förälder", width: 13 },
      { header: "Status", width: 17 },
      { header: "Placerad i", width: 42, wrap: true },
      { header: "Reserv för", width: 30, wrap: true },
      { header: "Önskade aktiviteter", width: 42, wrap: true },
      { header: "Familj: barn", width: 11, type: "number" },
      { header: "Familj: vuxna", width: 11, type: "number" },
      { header: "Övrig info", width: 40, wrap: true },
      { header: "Anmäld", width: 12, type: "date" }
    ],
    rows: allRegs.map(r => [
      r.childName || "",
      r.gender || "",
      r.school || "",
      String(r.grade == null ? "" : r.grade),
      r.klass || "",
      r.attendsFritids ? "Ja" : "Nej",
      homeCell(r.goesHomeAlone),
      r.parentName || "",
      r.parentPhone || "",
      r.childPhone || "",
      r.parentContacted ? "Ja" : "Nej",
      registrationStatus(r),
      names(placedIds(r)),
      names(reserveIds(r)),
      names(wishIds(r)),
      typeof r.familyChildren === "number" ? r.familyChildren : null,
      typeof r.familyAdults === "number" ? r.familyAdults : null,
      r.otherInfo || "",
      r.ts ? new Date(r.ts) : null
    ])
  };

  const aktiviteter = {
    name: "Aktiviteter",
    columns: [
      { header: "Aktivitet", width: 30 },
      { header: "Tid", width: 24 },
      { header: "Grupper", width: 28 },
      { header: "Skola", width: 24 },
      { header: "Max platser (tomt = obegränsat)", width: 18, type: "number" },
      { header: "Placerade", width: 11, type: "number" },
      { header: "Lediga platser", width: 13, type: "number" },
      { header: "I reserv", width: 10, type: "number" }
    ],
    rows: allActs.map(a => {
      const placed = realPlacedCountFor(branch, a.id);
      const reserve = allRegs.filter(r => reserveIds(r).includes(a.id)).length;
      return [
        a.name || "",
        a.schedule || "",
        stadiumLabelsFor(a),
        (a.schools && a.schools.length) ? a.schools.join(", ") : "Alla skolor",
        a.maxSpots || null,
        placed,
        a.maxSpots ? Math.max(0, a.maxSpots - placed) : null,
        reserve
      ];
    })
  };

  const placeringar = {
    name: "Placeringar",
    columns: [
      { header: "Aktivitet", width: 28 },
      { header: "Tid", width: 22 },
      { header: "Status", width: 11 },
      { header: "Barn", width: 26 },
      { header: "Årskurs", width: 9 },
      { header: "Klass", width: 8 },
      { header: "Skola", width: 16 },
      { header: "Går på fritids", width: 12 },
      { header: "Går hem själv", width: 17 },
      { header: "Förälder", width: 24 },
      { header: "Förälders telefon", width: 17 },
      { header: "Kontaktat förälder", width: 13 }
    ],
    rows: []
  };
  allActs.forEach(a => {
    const line = (r, status) => [
      a.name || "", a.schedule || "", status, r.childName || "", String(r.grade == null ? "" : r.grade),
      r.klass || "", r.school || "", r.attendsFritids ? "Ja" : "Nej", homeCell(r.goesHomeAlone),
      r.parentName || "", r.parentPhone || "", r.parentContacted ? "Ja" : "Nej"
    ];
    allRegs.filter(r => placedIds(r).includes(a.id)).forEach(r => placeringar.rows.push(line(r, "Placerad")));
    allRegs.filter(r => reserveIds(r).includes(a.id)).sort((x, y) => x.ts - y.ts)
      .forEach(r => placeringar.rows.push(line(r, "Reserv")));
  });

  return [deltagare, aktiviteter, placeringar];
}

function exportFilename(prefix = "Deltagare"){
  const slug = branchInfo(currentBranch).name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const d = new Date();
  const date = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return `${prefix}_${slug}_${date}.xlsx`;
}

// Skapar och laddar ner Excel-filen. Returnerar antal rader eller null om det misslyckades.
async function downloadExcelExport(prefix = "Deltagare"){
  try{
    const sheets = buildExportSheets();
    const bytes = await buildXlsx(sheets, {
      title: "Deltagare – " + branchInfo(currentBranch).name,
      creator: "Allaktivitetshuset"
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(prefix);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { participants: sheets[0].rows.length, activities: sheets[1].rows.length };
  }catch(e){
    console.error(e);
    return null;
  }
}

const exportExcelBtn = document.getElementById("exportExcelBtn");
exportExcelBtn.addEventListener("click", async () => {
  if(!regs(currentBranch).length && !acts(currentBranch).length){
    alert("Det finns inget att exportera än.");
    return;
  }
  const label = exportExcelBtn.textContent;
  exportExcelBtn.disabled = true;
  exportExcelBtn.textContent = "⏳ Skapar Excel…";
  const result = await downloadExcelExport();
  exportExcelBtn.disabled = false;
  exportExcelBtn.textContent = label;
  if(result) showToast(`✓ Excelfilen skapades (${result.participants} deltagare, ${result.activities} aktiviteter)`);
  else alert("Kunde inte skapa Excel-filen. Försök igen.");
});

/* ---------- Veckans kompis ---------- */

document.getElementById("addLeaderBtn").addEventListener("click", async () => {
  const nameInp = document.getElementById("newLeaderName");
  const err = document.getElementById("newLeader-err");
  err.style.display = "none";
  const name = nameInp.value.trim();
  if(!name){
    err.textContent = "Ange ledarens namn.";
    err.style.display = "block";
    return;
  }
  if(leadersFor(currentBranch).length >= 10){
    err.textContent = "Max 10 ledare per avdelning.";
    err.style.display = "block";
    return;
  }
  await addDoc(leadersCol, { branch: currentBranch, name });
  nameInp.value = "";
});

function renderBuddies(){
  const wrap = document.getElementById("leadersList");
  const leaders = leadersFor(currentBranch);
  const week = currentWeekKey();

  if(!leaders.length){
    wrap.innerHTML = '<p class="empty">Inga ledare tillagda ännu.</p>';
    return;
  }

  wrap.innerHTML = leaders.map(leader => {
    const entries = buddiesForLeader(currentBranch, leader.id);
    const weekCount = entries.filter(b => currentWeekKey(b.ts) === week).length;
    const rows = entries.length
      ? entries.map(b => `
          <div class="buddy-entry" data-buddy="${b.id}">
            <div class="buddy-entry-head">
              <span class="buddy-name">${escapeHtml(b.buddyName)}</span>
              <span class="badge ok">${weekLabel(b.ts)}</span>
              <span class="muted">${new Date(b.ts).toLocaleDateString('sv-SE')}</span>
              <button class="rowbtn" data-buddy-remove="${b.id}">Ta bort</button>
            </div>
            <div class="buddy-entry-detail"><b>Anledning:</b> ${escapeHtml(b.reason || '–')}</div>
            <div class="buddy-entry-detail"><b>Föräldrarnas respons:</b> ${escapeHtml(b.parentResponse || '–')}</div>
          </div>`).join("")
      : '<p class="empty">Inga tillagda än.</p>';

    return `
      <div class="leader-card" data-leader="${leader.id}">
        <div class="adm-act-head">
          <div>
            <span class="name">${escapeHtml(leader.name)}</span>
            <span class="count badge ${weekCount >= 3 ? 'ok' : 'full'}"> ${weekCount}/3 denna vecka (${weekLabel(Date.now())})</span>
          </div>
          <button class="del-x" data-leader-remove="${leader.id}" title="Ta bort ledare" aria-label="Ta bort ledare">✕</button>
        </div>
        <div class="inline-add buddy-add-form">
          <input type="text" placeholder="Namn på veckans kompis" class="buddy-name-inp">
          <input type="text" placeholder="Anledning" class="buddy-reason-inp">
          <input type="text" placeholder="Föräldrarnas respons" class="buddy-response-inp">
          <button class="btn small buddy-add-btn">Lägg till</button>
        </div>
        <div class="buddy-entries">${rows}</div>
      </div>`;
  }).join("");

  wrap.querySelectorAll("[data-leader-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const leaderId = btn.dataset.leaderRemove;
      const leader = leadersFor(currentBranch).find(l => l.id === leaderId);
      if(!confirm('Ta bort ledaren "' + (leader ? leader.name : '') + '"? Alla dennes veckans-kompis-poster tas också bort.')) return;
      const entries = buddiesForLeader(currentBranch, leaderId);
      await Promise.all(entries.map(e => deleteDoc(doc(db, "buddies", e.id))));
      await deleteDoc(doc(db, "leaders", leaderId));
    });
  });

  wrap.querySelectorAll(".leader-card").forEach(card => {
    const leaderId = card.dataset.leader;
    const leader = leadersFor(currentBranch).find(l => l.id === leaderId);

    card.querySelector(".buddy-add-btn").addEventListener("click", async () => {
      const buddyNameInp = card.querySelector(".buddy-name-inp");
      const reasonInp = card.querySelector(".buddy-reason-inp");
      const responseInp = card.querySelector(".buddy-response-inp");
      const buddyName = buddyNameInp.value.trim();
      if(!buddyName) return;
      await addDoc(buddiesCol, {
        branch: currentBranch,
        leaderId,
        leaderName: leader ? leader.name : "",
        buddyName,
        reason: reasonInp.value.trim(),
        parentResponse: responseInp.value.trim(),
        ts: Date.now()
      });
      buddyNameInp.value = "";
      reasonInp.value = "";
      responseInp.value = "";
    });

    card.querySelectorAll("[data-buddy-remove]").forEach(b => {
      b.addEventListener("click", async () => {
        if(!confirm("Ta bort den här veckans kompis-posten?")) return;
        await deleteDoc(doc(db, "buddies", b.dataset.buddyRemove));
      });
    });
  });
}

/* ---------- Statistik ---------- */

function renderStatActivityOptions(){
  const dl = document.getElementById("statActivityOptions");
  const names = acts(currentBranch).map(a => a.name);
  dl.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
}

document.getElementById("addStatBtn").addEventListener("click", async () => {
  const labelInp = document.getElementById("statLabel");
  const dateInp = document.getElementById("statDate");
  const boysInp = document.getElementById("statBoys");
  const girlsInp = document.getElementById("statGirls");
  const womenInp = document.getElementById("statWomen");
  const menInp = document.getElementById("statMen");
  const err = document.getElementById("newStat-err");
  err.style.display = "none";

  const label = labelInp.value.trim();
  if(!label){
    err.textContent = "Ange vilken aktivitet/tillfälle det gäller.";
    err.style.display = "block";
    return;
  }
  const boys = parseInt(boysInp.value, 10) || 0;
  const girls = parseInt(girlsInp.value, 10) || 0;
  const women = parseInt(womenInp.value, 10) || 0;
  const men = parseInt(menInp.value, 10) || 0;
  const date = dateInp.value || new Date().toISOString().slice(0, 10);

  try{
    await addDoc(statsCol, {
      branch: currentBranch, label, date,
      boys, girls, women, men,
      ts: Date.now()
    });
  }catch(e){
    err.textContent = "Kunde inte spara, försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }
  labelInp.value = "";
  boysInp.value = "";
  girlsInp.value = "";
  womenInp.value = "";
  menInp.value = "";
});

function entryTotal(e){
  return (e.boys || 0) + (e.girls || 0) + (e.women || 0) + (e.men || 0);
}

function statsTableHtml(entries, showActions){
  return `
    <div class="table-scroll">
    <table class="responsive-stack">
      <thead><tr><th>Datum</th><th>Aktivitet/tillfälle</th><th>Pojkar</th><th>Flickor</th><th>Kvinnor</th><th>Män</th><th>Totalt</th>${showActions ? '<th class="no-print"></th>' : ''}</tr></thead>
      <tbody>
        ${entries.map(e => `
          <tr>
            <td data-label="Datum">${escapeHtml(e.date || '')}</td>
            <td data-label="Aktivitet/tillfälle">${escapeHtml(e.label)}</td>
            <td data-label="Pojkar">${e.boys || 0}</td>
            <td data-label="Flickor">${e.girls || 0}</td>
            <td data-label="Kvinnor">${e.women || 0}</td>
            <td data-label="Män">${e.men || 0}</td>
            <td data-label="Totalt"><b>${entryTotal(e)}</b></td>
            ${showActions ? `<td data-label="" class="no-print stack-actions"><button class="rowbtn" data-stat-remove="${e.id}">Ta bort</button></td>` : ''}
          </tr>`).join("")}
      </tbody>
    </table>
    </div>`;
}

function summaryBoxesHtml(entries){
  const totals = entries.reduce((t, e) => {
    t.boys += e.boys || 0;
    t.girls += e.girls || 0;
    t.women += e.women || 0;
    t.men += e.men || 0;
    return t;
  }, { boys: 0, girls: 0, women: 0, men: 0 });
  const total = totals.boys + totals.girls + totals.women + totals.men;
  return `
    <div class="stat-box"><span class="num">${entries.length}</span><span class="lbl">Tillfällen</span></div>
    <div class="stat-box"><span class="num">${total}</span><span class="lbl">Deltagare totalt</span></div>
    <div class="stat-box"><span class="num">${totals.boys}</span><span class="lbl">Pojkar</span></div>
    <div class="stat-box"><span class="num">${totals.girls}</span><span class="lbl">Flickor</span></div>
    <div class="stat-box"><span class="num">${totals.women}</span><span class="lbl">Kvinnor</span></div>
    <div class="stat-box"><span class="num">${totals.men}</span><span class="lbl">Män</span></div>
  `;
}

function renderStats(){
  renderStatActivityOptions();
  const entries = statsFor(currentBranch);

  const summary = document.getElementById("statsSummary");
  summary.innerHTML = summaryBoxesHtml(entries);

  const tableWrap = document.getElementById("statsTable");
  const printArea = document.getElementById("statsPrintArea");
  if(!entries.length){
    tableWrap.innerHTML = '<p class="empty">Ingen statistik tillagd ännu.</p>';
    printArea.innerHTML = "";
    return;
  }

  // Kategorisera per aktivitet/tillfälle, alfabetiskt, med delsumma per grupp.
  const byLabel = {};
  entries.forEach(e => {
    if(!byLabel[e.label]) byLabel[e.label] = [];
    byLabel[e.label].push(e);
  });
  const labels = Object.keys(byLabel).sort((a, b) => a.localeCompare(b, 'sv'));

  const groupsHtml = labels.map(label => {
    const group = byLabel[label];
    const sub = summaryBoxesHtml(group);
    return `
      <div class="stat-group">
        <h4 class="stadium-heading">${escapeHtml(label)} <span class="muted">(${group.length} tillfällen)</span></h4>
        <div class="stats-summary stats-summary-small">${sub}</div>
        ${statsTableHtml(group, true)}
      </div>`;
  }).join("");

  tableWrap.innerHTML = groupsHtml;

  tableWrap.querySelectorAll("[data-stat-remove]").forEach(b => {
    b.addEventListener("click", async () => {
      if(!confirm("Ta bort den här statistikposten?")) return;
      await deleteDoc(doc(db, "stats", b.dataset.statRemove));
    });
  });

  // Bygg en ren utskriftsversion (samma kategorisering, utan knappar).
  printArea.innerHTML = `
    <h3 class="printTitle">Statistik · ${escapeHtml(branchInfo(currentBranch).name)} · ${new Date().toLocaleDateString('sv-SE')}</h3>
    <div class="stats-summary">${summaryBoxesHtml(entries)}</div>
    ${labels.map(label => {
      const group = byLabel[label];
      return `
        <h4 class="stadium-heading">${escapeHtml(label)} <span class="muted">(${group.length} tillfällen)</span></h4>
        ${statsTableHtml(group, false)}`;
    }).join("")}
  `;
}

document.getElementById("printStatsBtn").addEventListener("click", () => {
  document.body.classList.add("printing-stats");
  window.print();
});
window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-stats", "printing-participants", "printing-fritids");
});

/* ---------- Att göra ---------- */

document.getElementById("addTodoBtn").addEventListener("click", async () => {
  const titleInp = document.getElementById("newTodoTitle");
  const descInp = document.getElementById("newTodoDesc");
  const err = document.getElementById("newTodo-err");
  err.style.display = "none";
  const title = titleInp.value.trim();
  if(!title){
    err.textContent = "Ange en uppgift.";
    err.style.display = "block";
    return;
  }
  try{
    await addDoc(todosCol, {
      branch: currentBranch,
      title,
      description: descInp.value.trim(),
      done: false,
      ts: Date.now()
    });
  }catch(e){
    err.textContent = "Kunde inte spara, försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }
  titleInp.value = "";
  descInp.value = "";
});

function renderTodos(){
  const wrap = document.getElementById("todoList");
  const todos = todosFor(currentBranch).slice().sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));
  if(!todos.length){
    wrap.innerHTML = '<p class="empty">Inga lappar just nu.</p>';
    return;
  }
  wrap.innerHTML = todos.map(t => `
    <div class="todo-note${t.done ? ' todo-note-done' : ''}">
      <button class="todo-note-remove" data-todo-remove="${t.id}" title="Ta bort" aria-label="Ta bort">✕</button>
      <div class="todo-note-title">${escapeHtml(t.title)}</div>
      ${t.description ? `<div class="todo-note-desc">${escapeHtml(t.description)}</div>` : ''}
      <div class="todo-note-date">${new Date(t.ts).toLocaleDateString('sv-SE')}</div>
      <button class="todo-note-done-btn" data-todo-toggle="${t.id}" data-current="${t.done ? '1' : '0'}">${t.done ? 'Ångra' : 'Avklarad'}</button>
    </div>`).join("");

  wrap.querySelectorAll("[data-todo-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await deleteDoc(doc(db, "todos", btn.dataset.todoRemove));
    });
  });

  wrap.querySelectorAll("[data-todo-toggle]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const nowDone = btn.dataset.current !== "1";
      await updateDoc(doc(db, "todos", btn.dataset.todoToggle), { done: nowDone });
    });
  });
}

/* ---------- Init ---------- */

function initSubTabs(){
  document.querySelectorAll(".subtabbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtabbtn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".adm-subview").forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("adm-sub-" + btn.dataset.subtab).classList.add("active");
    });
  });
}

/* ---------- Stäng "Mer"-menyn i deltagarraden vid klick utanför ---------- */

document.addEventListener("click", (e) => {
  if(!e.target.closest(".row-menu-cell")) closeRowMenus();
});

// Menyn är "fixed" så den inte klipps av tabellens scrollyta. Placeras under
// knappen, eller ovanför om det inte finns plats nedanför.
function positionRowMenu(btn, panel){
  const r = btn.getBoundingClientRect();
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  let left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if(top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}
let openRowMenu = null;   // { btn, panel } för den meny som är öppen just nu
function closeRowMenus(){
  document.querySelectorAll(".row-menu-panel.open").forEach(p => p.classList.remove("open"));
  document.querySelectorAll(".row-menu-toggle[aria-expanded='true']").forEach(b => b.setAttribute("aria-expanded", "false"));
  openRowMenu = null;
}
// Menyn följer med sin knapp när sidan scrollas och stängs först när knappen försvinner ur bild.
function repositionOpenRowMenu(){
  if(!openRowMenu) return;
  const { btn, panel } = openRowMenu;
  const r = btn.getBoundingClientRect();
  if(!btn.isConnected || r.bottom < 0 || r.top > window.innerHeight){ closeRowMenus(); return; }
  positionRowMenu(btn, panel);
}
window.addEventListener("scroll", repositionOpenRowMenu, true);
window.addEventListener("resize", repositionOpenRowMenu);

/* ---------- Dra för att scrolla i sidled (tabeller) ---------- */
// Gör det möjligt att klicka och dra var som helst på en rad för att scrolla
// i sidled, istället för att behöva nå scrollisten längst ner på tabellen.

(function enableDragScroll(){
  let drag = null;
  document.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".table-scroll");
    if(!el || el.scrollWidth <= el.clientWidth) return;
    drag = { el, startX: e.pageX, scrollLeft: el.scrollLeft, moved: false };
    el.classList.add("dragging");
  });
  document.addEventListener("mousemove", (e) => {
    if(!drag) return;
    const dx = e.pageX - drag.startX;
    if(Math.abs(dx) > 4) drag.moved = true;
    if(drag.moved) e.preventDefault();
    drag.el.scrollLeft = drag.scrollLeft - dx;
  });
  document.addEventListener("mouseup", () => {
    if(!drag) return;
    drag.el.classList.remove("dragging");
    drag = null;
  });
  document.addEventListener("mouseleave", () => {
    if(!drag) return;
    drag.el.classList.remove("dragging");
    drag = null;
  });
  document.addEventListener("click", (e) => {
    if(drag && drag.moved){
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();

document.getElementById("privacyNotice").innerHTML = buildPrivacyHtml(PRIVACY);

/* ---------- Tillgänglighet: flikar och felmarkering ---------- */

// Flikarna (Anmäl dig/Admin och adminpanelens underflikar) får flikroller, aria-selected,
// och går att styra med piltangenter. Klassen "active" är sanningen – attributen följer den.
function enhanceTablist(container, tabSel, panelIdOf, label){
  container.setAttribute("role", "tablist");
  if(label) container.setAttribute("aria-label", label);
  const tabs = () => Array.from(container.querySelectorAll(tabSel));
  tabs().forEach(tab => {
    tab.setAttribute("role", "tab");
    const panelId = panelIdOf(tab);
    if(panelId){
      tab.setAttribute("aria-controls", panelId);
      const panel = document.getElementById(panelId);
      if(panel){
        panel.setAttribute("role", "tabpanel");
        if(!tab.id) tab.id = "tab-" + panelId;
        panel.setAttribute("aria-labelledby", tab.id);
      }
    }
  });
  const sync = () => tabs().forEach(tab => tab.setAttribute("aria-selected", tab.classList.contains("active") ? "true" : "false"));
  new MutationObserver(sync).observe(container, { subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
  container.addEventListener("keydown", (e) => {
    const list = tabs().filter(t => t.getClientRects().length > 0);
    const i = list.indexOf(document.activeElement);
    if(i < 0) return;
    let next = null;
    if(e.key === "ArrowRight") next = list[(i + 1) % list.length];
    else if(e.key === "ArrowLeft") next = list[(i - 1 + list.length) % list.length];
    else if(e.key === "Home") next = list[0];
    else if(e.key === "End") next = list[list.length - 1];
    if(next){ e.preventDefault(); next.focus(); next.click(); }
  });
}
enhanceTablist(document.querySelector(".tabs"), ".tabbtn", t => "view-" + t.dataset.tab, "Huvudmeny");
enhanceTablist(document.querySelector(".adm-subtabs"), ".subtabbtn", t => "adm-sub-" + t.dataset.subtab, "Adminpanelens avsnitt");

// Fält som markeras röda (klassen field-error) markeras också som ogiltiga för skärmläsare.
new MutationObserver(records => {
  records.forEach(r => {
    const el = r.target;
    if(!(el instanceof Element)) return;
    if(el.classList.contains("field-error")) el.setAttribute("aria-invalid", "true");
    else if(el.hasAttribute("aria-invalid")) el.removeAttribute("aria-invalid");
  });
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });

function init(){
  renderGate();
  renderBranchSwitch();
  updateHeaderForAdminBranch();
  initSubTabs();
  document.getElementById("statDate").value = new Date().toISOString().slice(0, 10);
}

init();
