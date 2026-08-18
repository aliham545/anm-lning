import { db } from "./firebase.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const BRANCHES = [
  { id: "holma", name: "Holma/Kroksbäck", code: "fritids2026" },
  { id: "hermodsdal", name: "Hermodsdal", code: "hermodsdal2026" }
];
const CURRENT_BRANCH_KEY = "fg-current-branch";

const STADIUMS = [
  { id: "lag", label: "Lågstadiet", sub: "Årskurs 1–3" },
  { id: "mellan", label: "Mellanstadiet", sub: "Årskurs 4–6" },
  { id: "hog", label: "Högstadiet", sub: "Årskurs 7–9" }
];

const activitiesCol = collection(db, "activities");
const registrationsCol = collection(db, "registrations");

// Data hålls per avdelning i minnet, hålls i synk med Firestore via onSnapshot.
let activitiesByBranch = { holma: [], hermodsdal: [] };
let registrationsByBranch = { holma: [], hermodsdal: [] };

// currentBranch styr ENDAST vilken avdelning admin tittar på/hanterar.
let currentBranch = localStorage.getItem(CURRENT_BRANCH_KEY) || BRANCHES[0].id;
if(!BRANCHES.some(b => b.id === currentBranch)) currentBranch = BRANCHES[0].id;

let isAdmin = false;
let contactFilter = "";
let signupBranch = null;

function branchInfo(id){
  return BRANCHES.find(b => b.id === id) || BRANCHES[0];
}

function uid(prefix){
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function stadiumForGrade(grade){
  const g = parseInt(grade, 10);
  if(g >= 1 && g <= 3) return "lag";
  if(g >= 4 && g <= 6) return "mellan";
  if(g >= 7 && g <= 9) return "hog";
  return null;
}

function escapeHtml(s){
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function phoneLink(phone){
  if(!phone) return '';
  const dial = phone.replace(/[^0-9+]/g, "");
  return `<a href="tel:${dial}" class="phone-link">${escapeHtml(phone)}</a>`;
}

/* ---------- Live-synk mot Firestore ---------- */

onSnapshot(activitiesCol, snap => {
  const grouped = { holma: [], hermodsdal: [] };
  snap.forEach(d => {
    const data = { id: d.id, ...d.data() };
    if(!grouped[data.branch]) grouped[data.branch] = [];
    grouped[data.branch].push(data);
  });
  activitiesByBranch = grouped;
  rerenderAll();
}, err => console.error("activities snapshot error:", err));

onSnapshot(registrationsCol, snap => {
  const grouped = { holma: [], hermodsdal: [] };
  snap.forEach(d => {
    const data = { id: d.id, ...d.data() };
    if(!grouped[data.branch]) grouped[data.branch] = [];
    grouped[data.branch].push(data);
  });
  registrationsByBranch = grouped;
  rerenderAll();
}, err => console.error("registrations snapshot error:", err));

function rerenderAll(){
  if(signupBranch){
    renderActivitySelect();
    renderActList();
  }
  if(isAdmin) renderAdmin();
}

function acts(branchId){ return activitiesByBranch[branchId] || []; }
function regs(branchId){ return registrationsByBranch[branchId] || []; }

function placedCountFor(branchId, actId){
  return regs(branchId).filter(r => r.placedActivityId === actId).length;
}
function activityName(branchId, id){
  const a = acts(branchId).find(a => a.id === id);
  return a ? a.name : "Okänd aktivitet";
}
function activitiesForStadium(branchId, stadium){
  return acts(branchId).filter(a => a.stadium === stadium);
}

/* ---------- Header ---------- */

function updateHeaderForAdminBranch(){
  const b = branchInfo(currentBranch);
  document.getElementById("adminLoginSub").textContent = "Ange koden för " + b.name + ".";
  document.getElementById("adminBranchLabel").textContent = "· " + b.name;
}

/* ---------- Avdelningsväxlare (bara i admin) ---------- */

function renderBranchSwitch(){
  const wrap = document.getElementById("branchSwitch");
  wrap.innerHTML = BRANCHES.map(b =>
    `<button class="branchbtn ${b.id === currentBranch ? 'active' : ''}" data-branch="${b.id}">${escapeHtml(b.name)}</button>`
  ).join("");
  wrap.querySelectorAll(".branchbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      if(btn.dataset.branch === currentBranch) return;
      currentBranch = btn.dataset.branch;
      localStorage.setItem(CURRENT_BRANCH_KEY, currentBranch);
      isAdmin = false;
      document.getElementById("adminLogin").style.display = "block";
      document.getElementById("adminPanel").style.display = "none";
      document.getElementById("pw").value = "";
      renderBranchSwitch();
      updateHeaderForAdminBranch();
    });
  });
}

/* ---------- Anmälningssida ---------- */

function renderGate(){
  const wrap = document.getElementById("gateBtns");
  wrap.innerHTML = BRANCHES.map(b =>
    `<button class="gate-btn" data-branch="${b.id}">${escapeHtml(b.name)}</button>`
  ).join("");
  wrap.querySelectorAll(".gate-btn").forEach(btn => {
    btn.addEventListener("click", () => selectSignupBranch(btn.dataset.branch));
  });
}

function selectSignupBranch(branchId){
  signupBranch = branchId;
  document.getElementById("branchGate").style.display = "none";
  document.getElementById("signupContent").style.display = "block";
  document.getElementById("signupBranchLabel").textContent = branchInfo(branchId).name;
  document.getElementById("actListSub").textContent = "Så här ser det ut just nu hos " + branchInfo(branchId).name + ".";
  renderActivitySelect();
  renderActList();
}

document.getElementById("changeBranchBtn").addEventListener("click", () => {
  signupBranch = null;
  document.getElementById("signupForm").reset();
  document.getElementById("ticketHolder").innerHTML = "";
  document.getElementById("signupContent").style.display = "none";
  document.getElementById("branchGate").style.display = "block";
});

function currentSignupContext(){
  const grade = document.getElementById("s-grade").value;
  return { branch: signupBranch, stadium: stadiumForGrade(grade) };
}

function renderActivitySelect(){
  const sel = document.getElementById("s-activity");
  const { branch, stadium } = currentSignupContext();
  sel.innerHTML = "";
  if(!branch || !stadium){
    sel.disabled = true;
    sel.innerHTML = '<option value="">Välj årskurs först</option>';
    return;
  }
  const options = activitiesForStadium(branch, stadium);
  if(!options.length){
    sel.disabled = true;
    sel.innerHTML = '<option value="">Inga aktiviteter för den årskursen än</option>';
    return;
  }
  sel.disabled = false;
  options.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    sel.appendChild(opt);
  });
}

document.getElementById("s-grade").addEventListener("change", renderActivitySelect);

function renderActList(){
  const wrap = document.getElementById("actList");
  wrap.innerHTML = "";
  if(!signupBranch) return;
  const branchActs = acts(signupBranch);
  if(!branchActs.length){
    wrap.innerHTML = '<p class="empty">Inga aktiviteter är tillagda ännu.</p>';
    return;
  }
  STADIUMS.forEach(st => {
    const stActs = activitiesForStadium(signupBranch, st.id);
    if(!stActs.length) return;
    const group = document.createElement("div");
    group.className = "stadium-group";
    group.innerHTML = `<h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub})</span></h4>`;
    const list = document.createElement("div");
    list.className = "act-list";
    stActs.forEach(a => {
      const count = placedCountFor(signupBranch, a.id);
      const full = a.maxSpots && count >= a.maxSpots;
      const div = document.createElement("div");
      div.className = "act-card";
      div.innerHTML = `
        <div class="top">
          <span class="name">${escapeHtml(a.name)}</span>
          <span class="badge ${full ? 'full' : 'ok'}">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : (count + ' platser tagna')}</span>
        </div>`;
      list.appendChild(div);
    });
    group.appendChild(list);
    wrap.appendChild(group);
  });
}

function showTicket(branchName, name, phone, klass, grade, wishName){
  const holder = document.getElementById("ticketHolder");
  const now = new Date();
  const dateStr = now.toLocaleDateString('sv-SE', { day:'numeric', month:'long' });
  holder.innerHTML = `
    <div class="ticket">
      <img src="assets/logo-a.png" alt="" class="mark" aria-hidden="true">
      <p class="ticket-title">Ansökan mottagen · ${escapeHtml(branchName)}</p>
      <h3>${escapeHtml(wishName)}</h3>
      <div class="row"><span>Namn</span><b>${escapeHtml(name)}</b></div>
      <div class="row"><span>Telefon</span><b>${escapeHtml(phone)}</b></div>
      <div class="row"><span>Årskurs</span><b>${escapeHtml(grade)}</b></div>
      <div class="row"><span>Klass</span><b>${escapeHtml(klass)}</b></div>
      <div class="row"><span>Datum</span><b>${dateStr}</b></div>
      <p class="ticket-note">Personalen placerar dig i en aktivitet inom kort.</p>
      <svg class="scissor" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle>
        <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
        <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
        <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
      </svg>
    </div>`;
}

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("s-name").value.trim();
  const phone = document.getElementById("s-phone").value.trim();
  const branch = signupBranch;
  const grade = document.getElementById("s-grade").value;
  const klass = document.getElementById("s-class").value.trim();
  const activityId = document.getElementById("s-activity").value;
  const err = document.getElementById("s-err");
  err.style.display = "none";

  if(!name || !phone || !branch || !grade || !klass || !activityId){
    err.textContent = "Fyll i namn, telefonnummer, årskurs, klass och önskad aktivitet.";
    err.style.display = "block";
    return;
  }
  const act = acts(branch).find(a => a.id === activityId);
  if(!act){
    err.textContent = "Aktiviteten hittades inte, ladda om sidan.";
    err.style.display = "block";
    return;
  }
  try{
    await addDoc(registrationsCol, {
      branch, name, phone, klass, grade, activityId,
      placedActivityId: null, ts: Date.now()
    });
  }catch(e){
    err.textContent = "Kunde inte skicka ansökan, kolla internetanslutningen och försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }
  showTicket(branchInfo(branch).name, name, phone, klass, grade, act.name);
  document.getElementById("signupForm").reset();
  renderActivitySelect();
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

/* ---------- Admin-inloggning ---------- */

document.getElementById("pwBtn").addEventListener("click", () => {
  const val = document.getElementById("pw").value;
  const err = document.getElementById("pw-err");
  if(val === branchInfo(currentBranch).code){
    isAdmin = true;
    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminPanel").style.display = "block";
    renderAdmin();
  }else{
    err.textContent = "Fel kod, försök igen.";
    err.style.display = "block";
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  isAdmin = false;
  document.getElementById("pw").value = "";
  document.getElementById("adminPanel").style.display = "none";
  document.getElementById("adminLogin").style.display = "block";
});

/* ---------- Rensa anmälningar ---------- */

document.getElementById("clearRegsBtn").addEventListener("click", async () => {
  const b = branchInfo(currentBranch);
  if(!confirm('Ta bort ALLA anmälningar (väntande + placerade) för ' + b.name + '? Detta går inte att ångra.')) return;
  const q = query(registrationsCol, where("branch", "==", currentBranch));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
});

/* ---------- Lägg till aktivitet ---------- */

document.getElementById("addActBtn").addEventListener("click", async () => {
  const nameInp = document.getElementById("newActName");
  const maxInp = document.getElementById("newActMax");
  const stadiumInp = document.getElementById("newActStadium");
  const err = document.getElementById("newAct-err");
  err.style.display = "none";
  const name = nameInp.value.trim();
  if(!name){
    err.textContent = "Ange ett namn på aktiviteten.";
    err.style.display = "block";
    return;
  }
  const maxSpots = maxInp.value ? parseInt(maxInp.value, 10) : null;
  try{
    await addDoc(activitiesCol, {
      branch: currentBranch, name,
      maxSpots: (maxSpots && maxSpots > 0) ? maxSpots : null,
      stadium: stadiumInp.value
    });
  }catch(e){
    err.textContent = "Kunde inte spara, försök igen.";
    err.style.display = "block";
    console.error(e);
    return;
  }
  nameInp.value = "";
  maxInp.value = "";
});

function activityOptionsHtml(branchId, selectedId, stadium){
  return activitiesForStadium(branchId, stadium).map(a => {
    const count = placedCountFor(branchId, a.id);
    const full = a.maxSpots && count >= a.maxSpots && a.id !== selectedId;
    return `<option value="${a.id}" ${a.id === selectedId ? "selected" : ""}>${escapeHtml(a.name)}${full ? " (fullt)" : ""}</option>`;
  }).join("");
}

/* ---------- Väntande ansökningar ---------- */

function renderPending(){
  const wrap = document.getElementById("pendingApps");
  const pending = regs(currentBranch)
    .filter(r => !r.placedActivityId)
    .sort((a,b) => a.ts - b.ts);

  if(!pending.length){
    wrap.innerHTML = '<p class="empty">Inga väntande ansökningar just nu.</p>';
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>Namn</th><th>Telefon</th><th>Åk</th><th>Klass</th><th>Önskemål</th><th>Placera i</th><th></th></tr></thead>
      <tbody>
        ${pending.map(r => {
          const stadium = stadiumForGrade(r.grade);
          return `
          <tr data-reg="${r.id}">
            <td>${escapeHtml(r.name)}</td>
            <td>${phoneLink(r.phone)}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.klass)}</td>
            <td class="muted">${escapeHtml(activityName(currentBranch, r.activityId))}</td>
            <td>
              <select class="place-select">${activityOptionsHtml(currentBranch, r.activityId, stadium)}</select>
            </td>
            <td style="white-space:nowrap;">
              <button class="btn small place-btn" style="margin:0 6px 0 0;">Placera</button>
              <button class="rowbtn" data-remove-pending="${r.id}">Ta bort</button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>`;

  wrap.querySelectorAll(".place-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const regId = tr.dataset.reg;
      const select = tr.querySelector(".place-select");
      if(!select.value) return;
      const act = acts(currentBranch).find(a => a.id === select.value);
      if(!act) return;
      if(act.maxSpots && placedCountFor(currentBranch, act.id) >= act.maxSpots){
        if(!confirm(act.name + ' är redan fullt. Placera ändå?')) return;
      }
      await updateDoc(doc(db, "registrations", regId), { placedActivityId: act.id });
    });
  });

  wrap.querySelectorAll("[data-remove-pending]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await deleteDoc(doc(db, "registrations", btn.dataset.removePending));
    });
  });
}

/* ---------- Aktivitetslistor i admin ---------- */

function renderAdmin(){
  updateHeaderForAdminBranch();
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
      const regsHere = regs(currentBranch).filter(r => r.placedActivityId === act.id);
      const box = document.createElement("div");
      box.className = "adm-act";
      const rowsHtml = regsHere.length
        ? regsHere.map(r => `
            <tr data-reg="${r.id}">
              <td>${escapeHtml(r.name)}</td>
              <td>${phoneLink(r.phone)}</td>
              <td>${escapeHtml(r.klass)}</td>
              <td>
                <select class="move-select">${activityOptionsHtml(currentBranch, act.id, act.stadium)}</select>
              </td>
              <td style="white-space:nowrap;">
                <button class="rowbtn move-btn" style="margin-right:10px;">Flytta</button>
                <button class="rowbtn" data-reg-remove="${r.id}">Ta bort</button>
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
        <div class="table-scroll">
        <table>
          <thead><tr><th>Namn</th><th>Telefon</th><th>Klass</th><th>Flytta till</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        </div>
        <div class="inline-add">
          <input type="text" placeholder="Namn" class="add-name">
          <input type="tel" placeholder="Telefon (valfritt)" class="add-phone">
          <input type="text" placeholder="Klass" class="add-class" style="max-width:100px;">
          <button class="btn small add-reg-btn">Lägg till direkt</button>
        </div>
      `;
      wrap.appendChild(box);

      box.querySelector(".del-x").addEventListener("click", async () => {
        if(!confirm('Ta bort aktiviteten "' + act.name + '"? Alla som är placerade eller sökt dit tas också bort.')) return;
        const toRemove = regs(currentBranch).filter(r => r.activityId === act.id || r.placedActivityId === act.id);
        await Promise.all(toRemove.map(r => deleteDoc(doc(db, "registrations", r.id))));
        await deleteDoc(doc(db, "activities", act.id));
      });

      box.querySelectorAll("[data-reg-remove]").forEach(b => {
        b.addEventListener("click", async () => {
          await deleteDoc(doc(db, "registrations", b.dataset.regRemove));
        });
      });

      box.querySelectorAll(".move-btn").forEach(b => {
        b.addEventListener("click", async () => {
          const tr = b.closest("tr");
          const regId = tr.dataset.reg;
          const chosenId = tr.querySelector(".move-select").value;
          const newAct = acts(currentBranch).find(a => a.id === chosenId);
          if(!newAct || chosenId === act.id) return;
          if(newAct.maxSpots && placedCountFor(currentBranch, newAct.id) >= newAct.maxSpots){
            if(!confirm(newAct.name + ' är redan fullt. Flytta ändå?')) return;
          }
          await updateDoc(doc(db, "registrations", regId), { placedActivityId: chosenId });
        });
      });

      box.querySelector(".add-reg-btn").addEventListener("click", async () => {
        const nameInp = box.querySelector(".add-name");
        const phoneInp = box.querySelector(".add-phone");
        const classInp = box.querySelector(".add-class");
        const name = nameInp.value.trim();
        const klass = classInp.value.trim();
        const phone = phoneInp.value.trim();
        if(!name || !klass) return;
        const grade = st.id === "lag" ? "1" : st.id === "mellan" ? "4" : "7";
        await addDoc(registrationsCol, {
          branch: currentBranch, name, phone, klass, grade,
          activityId: act.id, placedActivityId: act.id, ts: Date.now()
        });
        nameInp.value = "";
        phoneInp.value = "";
        classInp.value = "";
      });
    });
  });

  renderDeltagarlista();
}

/* ---------- Deltagare & kontaktuppgifter ---------- */

document.getElementById("contactSearch").addEventListener("input", (e) => {
  contactFilter = e.target.value.trim().toLowerCase();
  renderDeltagarlista();
});

function renderDeltagarlista(){
  const wrap = document.getElementById("deltagarlista");
  wrap.innerHTML = "";
  STADIUMS.forEach(st => {
    let list = regs(currentBranch).filter(r => stadiumForGrade(r.grade) === st.id);
    if(contactFilter){
      list = list.filter(r =>
        r.name.toLowerCase().includes(contactFilter) ||
        r.klass.toLowerCase().includes(contactFilter) ||
        (r.phone || "").toLowerCase().includes(contactFilter)
      );
    }
    list = list.slice().sort((a,b) => (a.grade - b.grade) || a.name.localeCompare(b.name, 'sv'));

    const section = document.createElement("div");
    section.className = "deltagar-group";
    const rowsHtml = list.length
      ? list.map(r => `
          <tr>
            <td>${escapeHtml(r.name)}</td>
            <td>${r.phone ? phoneLink(r.phone) : '<span class="muted">–</span>'}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.klass)}</td>
            <td>${r.placedActivityId ? escapeHtml(activityName(currentBranch, r.placedActivityId)) : '<span class="muted">Väntar på placering</span>'}</td>
          </tr>`).join("")
      : `<tr><td colspan="5" class="empty">${contactFilter ? 'Ingen matchning.' : 'Ingen anmäld i den här gruppen än.'}</td></tr>`;

    section.innerHTML = `
      <h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub}) · ${list.length} st</span></h4>
      <div class="table-scroll">
      <table>
        <thead><tr><th>Namn</th><th>Telefon</th><th>Åk</th><th>Klass</th><th>Aktivitet</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      </div>`;
    wrap.appendChild(section);
  });
}

/* ---------- Init ---------- */

function init(){
  renderGate();
  renderBranchSwitch();
  updateHeaderForAdminBranch();
}

init();
