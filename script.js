import { db, auth } from "./firebase.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  query, where, getDocs, increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const BRANCHES = [
  { id: "holma", name: "Holma/Kroksbäck" }
];
const CURRENT_BRANCH_KEY = "fg-current-branch";

const SCHOOLS_BY_BRANCH = {
  holma: ["Holmaskolan", "Kroksbäckskolan"]
};

const STADIUMS = [
  { id: "f", label: "Förskoleklass", sub: "Årskurs F" },
  { id: "lag", label: "Lågstadiet", sub: "Årskurs 1–3" },
  { id: "mellan", label: "Mellanstadiet", sub: "Årskurs 4–6" },
  { id: "hog", label: "Högstadiet", sub: "Årskurs 7–9" },
  { id: "utflykt", label: "Utflykter", sub: "Alla åldrar" },
  { id: "familj", label: "Familjeaktivitet", sub: "Endast åk F–3" }
];

const activitiesCol = collection(db, "activities");
const registrationsCol = collection(db, "registrations");
const leadersCol = collection(db, "leaders");
const buddiesCol = collection(db, "buddies");
const statsCol = collection(db, "stats");
const todosCol = collection(db, "todos");

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

function stadiumForGrade(grade){
  if(String(grade).trim().toUpperCase() === "F") return "f";
  const g = parseInt(grade, 10);
  if(g >= 1 && g <= 3) return "lag";
  if(g >= 4 && g <= 6) return "mellan";
  if(g >= 7 && g <= 9) return "hog";
  return null;
}
function gradeSortValue(grade){
  if(String(grade).trim().toUpperCase() === "F") return 0;
  const g = parseInt(grade, 10);
  return isNaN(g) ? 99 : g;
}

function escapeHtml(s){
  const d = document.createElement("div");
  d.textContent = s == null ? "" : s;
  return d.innerHTML;
}

function phoneLink(phone){
  if(!phone) return '';
  const dial = phone.replace(/[^0-9+]/g, "");
  return `<a href="tel:${dial}" class="phone-link">${escapeHtml(phone)}</a>`;
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
function actStadiums(a){
  return Array.isArray(a.stadiums) ? a.stadiums : (a.stadium ? [a.stadium] : []);
}

/* ---------- Live-synk mot Firestore ---------- */

onSnapshot(activitiesCol, snap => {
  const grouped = emptyGroups();
  snap.forEach(d => {
    const data = { id: d.id, ...d.data() };
    if(!grouped[data.branch]) grouped[data.branch] = [];
    grouped[data.branch].push(data);
  });
  activitiesByBranch = grouped;
  rerenderAll();
}, err => console.error("activities snapshot error:", err));

function startRegistrationsListener(){
  if(unsubscribeRegs) return;
  unsubscribeRegs = onSnapshot(registrationsCol, snap => {
    const grouped = emptyGroups();
    snap.forEach(d => {
      const data = { id: d.id, ...d.data() };
      if(!grouped[data.branch]) grouped[data.branch] = [];
      grouped[data.branch].push(data);
    });
    registrationsByBranch = grouped;
    rerenderAll();
  }, err => console.error("registrations snapshot error:", err));
}
function stopRegistrationsListener(){
  if(unsubscribeRegs){ unsubscribeRegs(); unsubscribeRegs = null; }
  registrationsByBranch = emptyGroups();
}

function startLeadersAndBuddiesListeners(){
  if(!unsubscribeLeaders){
    unsubscribeLeaders = onSnapshot(leadersCol, snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      leadersByBranch = grouped;
      rerenderAll();
    }, err => console.error("leaders snapshot error:", err));
  }
  if(!unsubscribeBuddies){
    unsubscribeBuddies = onSnapshot(buddiesCol, snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      buddiesByBranch = grouped;
      rerenderAll();
    }, err => console.error("buddies snapshot error:", err));
  }
  if(!unsubscribeStats){
    unsubscribeStats = onSnapshot(statsCol, snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      statsByBranch = grouped;
      rerenderAll();
    }, err => console.error("stats snapshot error:", err));
  }
  if(!unsubscribeTodos){
    unsubscribeTodos = onSnapshot(todosCol, snap => {
      const grouped = emptyGroups();
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        if(!grouped[data.branch]) grouped[data.branch] = [];
        grouped[data.branch].push(data);
      });
      todosByBranch = grouped;
      rerenderAll();
    }, err => console.error("todos snapshot error:", err));
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

// Publikt/visningsantal - bygger på det synkade räknefältet på aktiviteten
// (registreringar är inte publikt läsbara, se Firestore-reglerna).
function displayCount(branchId, actId){
  const a = acts(branchId).find(a => a.id === actId);
  return a && a.placedCount ? a.placedCount : 0;
}
// Faktiskt antal utifrån riktiga anmälningar - bara tillgängligt när man är
// inloggad (admin), används för avstämning och deltagarlistor.
function realPlacedCountFor(branchId, actId){
  return regs(branchId).filter(r => placedIds(r).includes(actId)).length;
}
function activityName(branchId, id){
  const a = acts(branchId).find(a => a.id === id);
  return a ? a.name : "Okänd aktivitet";
}
function activitiesForStadium(branchId, stadium){
  return acts(branchId).filter(a => actStadiums(a).includes(stadium));
}
function activityMatchesSchool(a, school){
  return !a.schools || !a.schools.length || !school || a.schools.includes(school);
}
function leadersFor(branchId){ return leadersByBranch[branchId] || []; }
function buddiesFor(branchId){ return buddiesByBranch[branchId] || []; }
function statsFor(branchId){ return (statsByBranch[branchId] || []).slice().sort((a,b) => (b.date || '').localeCompare(a.date || '') || b.ts - a.ts); }
function todosFor(branchId){ return (todosByBranch[branchId] || []).slice().sort((a,b) => b.ts - a.ts); }
function buddiesForLeader(branchId, leaderId){
  return buddiesFor(branchId).filter(b => b.leaderId === leaderId).sort((a,b) => b.ts - a.ts);
}
function currentWeekKey(ts){
  const d = new Date(ts || Date.now());
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return d.getFullYear() + "-W" + week;
}
function weekLabel(ts){
  const wk = currentWeekKey(ts);
  const [year, wpart] = wk.split("-W");
  return "v." + wpart + " " + year;
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
  sel.innerHTML = '<option value="">Välj skola</option>' +
    schools.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
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
    sec.options.forEach(a => {
      const count = displayCount(signupBranch, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      const label = document.createElement("label");
      label.className = "activity-check" + (full ? " disabled" : "");
      label.innerHTML = `
        <input type="checkbox" value="${a.id}" ${sec.isFamily ? 'data-family="1"' : ''} ${full ? "disabled" : ""}>
        <span>${activityLabelHtml(a)}</span>
        <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : ''}</span>`;
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
      const count = displayCount(branchId, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      const div = document.createElement("div");
      div.className = "act-card";
      div.innerHTML = `
        <div class="top">
          <span class="name">${activityLabelHtml(a)}</span>
          <span class="badge ${full ? 'full' : 'ok'}">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : (count + ' platser tagna')}</span>
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
      <div class="row"><span>Önskade aktiviteter</span><b>${escapeHtml(wishNames.join(', '))}</b></div>
      ${typeof data.familyChildren !== "undefined" ? `<div class="row"><span>Familj: barn / vuxna</span><b>${data.familyChildren} / ${data.familyAdults}</b></div>` : ''}
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
  document.getElementById("s-activities").classList.remove("field-error");
  document.getElementById("familyCountFields").classList.remove("field-error");
}

document.getElementById("signupForm").addEventListener("input", (e) => {
  e.target.classList.remove("field-error");
  const wrap = e.target.closest(".radio-row, .activity-checks, .family-count-fields");
  if(wrap) wrap.classList.remove("field-error");
});

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("s-err");
  err.style.display = "none";
  clearFieldErrors();

  const childName = document.getElementById("s-name").value.trim();
  const genderInput = document.querySelector('input[name="gender"]:checked');
  const gender = genderInput ? genderInput.value : "";
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

  const data = { childName, gender, school, grade, klass, attendsFritids, childPhone, parentName, parentPhone, otherInfo };
  if(isFamilySignup){
    data.familyChildren = parseInt(familyChildrenInp.value, 10) || 0;
    data.familyAdults = parseInt(familyAdultsInp.value, 10) || 0;
  }
  const wishNames = wishActivityIds.map(id => activityName(signupBranch, id));

  try{
    await addDoc(registrationsCol, {
      branch: signupBranch,
      ...data,
      wishActivityIds,
      placedActivityIds: [],
      ts: Date.now()
    });
  }catch(e){
    err.textContent = "Kunde inte skicka ansökan, kolla internetanslutningen och försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
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
    renderAdmin();
  }else{
    stopRegistrationsListener();
    stopLeadersAndBuddiesListeners();
    document.getElementById("adminPanel").style.display = "none";
    document.getElementById("adminLogin").style.display = "block";
    rerenderAll();
  }
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
  const b = branchInfo(currentBranch);
  if(!confirm('Ta bort ALLA anmälningar (väntande + placerade) för ' + b.name + '? Detta går inte att ångra.')) return;
  const q = query(registrationsCol, where("branch", "==", currentBranch));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  await Promise.all(acts(currentBranch).map(a => updateDoc(doc(db, "activities", a.id), { placedCount: 0 }).catch(() => {})));
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

function renderPending(){
  const wrap = document.getElementById("pendingApps");
  const pending = regs(currentBranch)
    .filter(r => placedIds(r).length === 0)
    .sort((a,b) => a.ts - b.ts);

  if(!pending.length){
    wrap.innerHTML = '<p class="empty">Inga väntande ansökningar just nu.</p>';
    return;
  }

  wrap.innerHTML = pending.map(r => {
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
              <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : ''}</span>
            </label>`;
        }).join("")
      : '<p class="muted">Inga aktiviteter i den här årskursgruppen än.</p>';

    return `
      <div class="pending-card" data-reg="${r.id}">
        <div class="pending-head">
          <span class="pname">${escapeHtml(r.childName)}</span>
          <span class="badge ok">Åk ${escapeHtml(r.grade)} · ${escapeHtml(r.klass)}</span>
        </div>
        <div class="pending-meta">
          <div>Skola: <b>${escapeHtml(r.school || '–')}</b> &nbsp;·&nbsp; Kön: <b>${escapeHtml(r.gender || '–')}</b> &nbsp;·&nbsp; Går på fritids: <b>${r.attendsFritids ? "Ja" : "Nej"}</b></div>
          <div>Barnets telefon: <b>${r.childPhone ? phoneLink(r.childPhone) : '–'}</b></div>
          <div>Förälder: <b>${escapeHtml(r.parentName)}</b> &nbsp;·&nbsp; Telefon: <b>${phoneLink(r.parentPhone)}</b></div>
          <div>Önskemål: <b>${escapeHtml(wishIds(r).map(id => activityName(currentBranch, id)).join(', ') || '–')}</b></div>
          ${typeof r.familyChildren !== "undefined" ? `<div>Familj: <b>${r.familyChildren} barn / ${r.familyAdults} vuxna</b></div>` : ''}
          ${r.otherInfo ? `<div>Övrig info: <b>${escapeHtml(r.otherInfo)}</b></div>` : ''}
        </div>
        <label class="muted" style="font-size:12px;">Placera i:</label>
        <div class="activity-checks pending-place-checks">${checksHtml}</div>
        <div class="pending-actions">
          <button class="rowbtn" data-remove-pending="${r.id}">Ta bort ansökan</button>
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
      await updateDoc(doc(db, "registrations", regId), { placedActivityIds: chosen });
      await Promise.all(chosen.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(1) }).catch(() => {})));
    });
  });

  wrap.querySelectorAll("[data-remove-pending]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if(!confirm("Ta bort den här ansökan helt?")) return;
      await deleteDoc(doc(db, "registrations", btn.dataset.removePending));
    });
  });
}

/* ---------- Ta bort en hel anmälan (dekrementerar placedCount) ---------- */

async function deleteRegistrationEntirely(regId){
  const r = regs(currentBranch).find(x => x.id === regId);
  const ids = r ? placedIds(r) : [];
  await deleteDoc(doc(db, "registrations", regId));
  await Promise.all(ids.map(id => updateDoc(doc(db, "activities", id), { placedCount: increment(-1) }).catch(() => {})));
}

/* ---------- Aktivitetslistor i admin ---------- */

function renderAdmin(){
  updateHeaderForAdminBranch();
  renderNewActSchoolsOptions();
  reconcileCounts(currentBranch);
  renderPending();
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
            <tr data-reg="${r.id}">
              <td>${escapeHtml(r.childName)}</td>
              <td>${escapeHtml(r.klass)}</td>
              <td>${escapeHtml(r.parentName)}</td>
              <td>${phoneLink(r.parentPhone)}</td>
              <td style="white-space:nowrap;">
                <button class="rowbtn unplace-btn" style="margin-right:10px;" title="Tar bara bort barnet från den här aktiviteten">Flytta bort</button>
                <button class="rowbtn" data-reg-remove="${r.id}" title="Tar bort hela anmälan">Ta bort deltagare</button>
              </td>
            </tr>`).join("")
        : `<tr><td colspan="5" class="empty">Ingen placerad här än.</td></tr>`;

      box.innerHTML = `
        <div class="adm-act-head">
          <div>
            <span class="name">${escapeHtml(act.name)}</span>
            <span class="count"> · ${regsHere.length}${act.maxSpots ? ' / ' + act.maxSpots : ''} placerade</span>
          </div>
          <button class="del-x" data-act="${act.id}" title="Ta bort aktivitet" aria-label="Ta bort aktivitet">✕</button>
        </div>
        <div class="act-schedule-row" data-act-schedule="${act.id}">
          <span class="act-schedule-view">
            <span class="act-schedule-text">${act.schedule ? escapeHtml(act.schedule) : '<span class="muted">Ingen tid inställd</span>'}</span>
            <button class="ghostlink schedule-edit-btn">Ändra tid</button>
          </span>
        </div>
        <div class="act-school-row">
          Skola: <b>${(act.schools && act.schools.length) ? escapeHtml(act.schools.join(', ')) : 'Alla skolor'}</b>
        </div>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Barn</th><th>Klass</th><th>Förälder</th><th>Förälders telefon</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        </div>
        <div class="inline-add">
          <input type="text" placeholder="Barnets namn" class="add-name">
          <input type="text" placeholder="Klass" class="add-class" style="max-width:90px;">
          <input type="text" placeholder="Förälders namn" class="add-parent">
          <input type="tel" placeholder="Förälders telefon (valfritt)" class="add-phone">
          <button class="btn small add-reg-btn">Lägg till direkt</button>
        </div>
      `;
      wrap.appendChild(box);

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

      box.querySelector(".del-x").addEventListener("click", async () => {
        if(!confirm('Ta bort aktiviteten "' + act.name + '"? Den tas bort ur alla ansökningar/placeringar som nämner den.')) return;
        const affected = regs(currentBranch).filter(r => wishIds(r).includes(act.id) || placedIds(r).includes(act.id));
        await Promise.all(affected.map(r => {
          const newWish = wishIds(r).filter(id => id !== act.id);
          const newPlaced = placedIds(r).filter(id => id !== act.id);
          return updateDoc(doc(db, "registrations", r.id), { wishActivityIds: newWish, placedActivityIds: newPlaced });
        }));
        await deleteDoc(doc(db, "activities", act.id));
      });

      box.querySelectorAll("[data-reg-remove]").forEach(b => {
        b.addEventListener("click", async () => {
          if(!confirm("Ta bort den här deltagaren helt (alla placeringar och ansökan)?")) return;
          await deleteRegistrationEntirely(b.dataset.regRemove);
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

      box.querySelector(".add-reg-btn").addEventListener("click", async () => {
        const nameInp = box.querySelector(".add-name");
        const classInp = box.querySelector(".add-class");
        const parentInp = box.querySelector(".add-parent");
        const phoneInp = box.querySelector(".add-phone");
        const childName = nameInp.value.trim();
        const klass = classInp.value.trim();
        const parentName = parentInp.value.trim();
        const parentPhone = phoneInp.value.trim();
        if(!childName || !klass) return;
        const grade = st.id === "f" ? "F" : st.id === "lag" ? "1" : st.id === "mellan" ? "4" : st.id === "hog" ? "7" : "";
        await addDoc(registrationsCol, {
          branch: currentBranch, childName, klass, grade,
          gender: "", school: "", attendsFritids: false, childPhone: "", otherInfo: "",
          parentName, parentPhone,
          wishActivityIds: [act.id], placedActivityIds: [act.id], ts: Date.now()
        });
        await updateDoc(doc(db, "activities", act.id), { placedCount: increment(1) }).catch(() => {});
        nameInp.value = "";
        classInp.value = "";
        parentInp.value = "";
        phoneInp.value = "";
      });
    });
  });

  renderDeltagarlista();
  renderBuddies();
  renderStats();
  renderTodos();
}

document.getElementById("contactSearch").addEventListener("input", (e) => {
  contactFilter = e.target.value.trim().toLowerCase();
  renderDeltagarlista();
});

function renderDeltagarlista(){
  const wrap = document.getElementById("deltagarlista");
  wrap.innerHTML = "";

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
          <tr data-reg="${r.id}">
            <td>${escapeHtml(r.childName)}</td>
            <td>${escapeHtml(r.gender || '–')}</td>
            <td>${escapeHtml(r.school || '–')}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.klass)}</td>
            <td>${r.attendsFritids ? "Ja" : "Nej"}</td>
            <td>${escapeHtml(r.parentName)}</td>
            <td>${phoneLink(r.parentPhone)}</td>
            <td>${r.childPhone ? phoneLink(r.childPhone) : '<span class="muted">–</span>'}</td>
            <td>${placedNames.length ? escapeHtml(placedNames.join(', ')) : '<span class="muted">Väntar på placering</span>'}</td>
            <td>${typeof r.familyChildren !== "undefined" ? (r.familyChildren + ' / ' + r.familyAdults) : ''}</td>
            <td>${r.otherInfo ? escapeHtml(r.otherInfo) : ''}</td>
            <td class="no-print"><button class="rowbtn" data-contact-remove="${r.id}">Ta bort</button></td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="13" class="empty">${contactFilter ? 'Ingen matchning.' : 'Ingen anmäld i den här gruppen än.'}</td></tr>`;

    section.innerHTML = `
      <h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub}) · ${list.length} st</span></h4>
      <div class="table-scroll">
      <table>
        <thead><tr><th>Barn</th><th>Kön</th><th>Skola</th><th>Åk</th><th>Klass</th><th>Fritids</th><th>Förälder</th><th>Förälders tel</th><th>Barnets tel</th><th>Aktivitet(er)</th><th>Familj: barn/vuxna</th><th>Övrig info</th><th class="no-print"></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      </div>`;
    wrap.appendChild(section);
  });

  wrap.querySelectorAll("[data-contact-remove]").forEach(b => {
    b.addEventListener("click", async () => {
      if(!confirm("Ta bort den här deltagaren helt?")) return;
      await deleteRegistrationEntirely(b.dataset.contactRemove);
    });
  });
}

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
    <table>
      <thead><tr><th>Datum</th><th>Aktivitet/tillfälle</th><th>Pojkar</th><th>Flickor</th><th>Kvinnor</th><th>Män</th><th>Totalt</th>${showActions ? '<th class="no-print"></th>' : ''}</tr></thead>
      <tbody>
        ${entries.map(e => `
          <tr>
            <td>${escapeHtml(e.date || '')}</td>
            <td>${escapeHtml(e.label)}</td>
            <td>${e.boys || 0}</td>
            <td>${e.girls || 0}</td>
            <td>${e.women || 0}</td>
            <td>${e.men || 0}</td>
            <td><b>${entryTotal(e)}</b></td>
            ${showActions ? `<td class="no-print"><button class="rowbtn" data-stat-remove="${e.id}">Ta bort</button></td>` : ''}
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
  document.body.classList.remove("printing-stats", "printing-participants");
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

function init(){
  renderGate();
  renderBranchSwitch();
  updateHeaderForAdminBranch();
  initSubTabs();
  document.getElementById("statDate").value = new Date().toISOString().slice(0, 10);
}

init();
