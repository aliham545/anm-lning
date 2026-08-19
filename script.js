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

let activitiesByBranch = { holma: [], hermodsdal: [] };
let registrationsByBranch = { holma: [], hermodsdal: [] };

let currentBranch = localStorage.getItem(CURRENT_BRANCH_KEY) || BRANCHES[0].id;
if(!BRANCHES.some(b => b.id === currentBranch)) currentBranch = BRANCHES[0].id;

let isAdmin = false;
let contactFilter = "";
let signupBranch = null;

function branchInfo(id){
  return BRANCHES.find(b => b.id === id) || BRANCHES[0];
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
    renderActivityChecks();
    renderActList();
  }
  if(isAdmin) renderAdmin();
}

function acts(branchId){ return activitiesByBranch[branchId] || []; }
function regs(branchId){ return registrationsByBranch[branchId] || []; }

function placedCountFor(branchId, actId){
  return regs(branchId).filter(r => placedIds(r).includes(actId)).length;
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
  const stadium = stadiumForGrade(grade);
  wrap.innerHTML = "";
  if(!signupBranch || !stadium){
    wrap.innerHTML = '<p class="muted">Välj årskurs först</p>';
    return;
  }
  const options = activitiesForStadium(signupBranch, stadium);
  if(!options.length){
    wrap.innerHTML = '<p class="muted">Inga aktiviteter för den årskursen än</p>';
    return;
  }
  options.forEach(a => {
    const count = placedCountFor(signupBranch, a.id);
    const full = a.maxSpots && count >= a.maxSpots;
    const label = document.createElement("label");
    label.className = "activity-check" + (full ? " disabled" : "");
    label.innerHTML = `
      <input type="checkbox" value="${a.id}" ${full ? "disabled" : ""}>
      <span>${activityLabelHtml(a)}</span>
      <span class="achk-badge">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : ''}</span>`;
    wrap.appendChild(label);
  });
}

document.getElementById("s-grade").addEventListener("change", renderActivityChecks);

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
          <span class="name">${activityLabelHtml(a)}</span>
          <span class="badge ${full ? 'full' : 'ok'}">${a.maxSpots ? (full ? 'Fullt' : (count + '/' + a.maxSpots)) : (count + ' platser tagna')}</span>
        </div>`;
      list.appendChild(div);
    });
    group.appendChild(list);
    wrap.appendChild(group);
  });
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
      <div class="row"><span>Årskurs</span><b>${escapeHtml(data.grade)}</b></div>
      <div class="row"><span>Klass</span><b>${escapeHtml(data.klass)}</b></div>
      <div class="row"><span>Önskade aktiviteter</span><b>${escapeHtml(wishNames.join(', '))}</b></div>
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

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("s-err");
  err.style.display = "none";

  const childName = document.getElementById("s-name").value.trim();
  const genderInput = document.querySelector('input[name="gender"]:checked');
  const gender = genderInput ? genderInput.value : "";
  const grade = document.getElementById("s-grade").value;
  const klass = document.getElementById("s-class").value.trim();
  const attendsFritids = document.getElementById("s-fritids").checked;
  const childPhone = document.getElementById("s-childphone").value.trim();
  const parentName = document.getElementById("s-parentname").value.trim();
  const parentPhone = document.getElementById("s-parentphone").value.trim();
  const wishActivityIds = Array.from(document.querySelectorAll('#s-activities input[type="checkbox"]:checked')).map(c => c.value);

  if(!childName || !gender || !grade || !klass || !parentName || !parentPhone || !wishActivityIds.length){
    err.textContent = "Fyll i barnets namn, kön, årskurs, klass, förälders namn och telefonnummer, och välj minst en aktivitet.";
    err.style.display = "block";
    return;
  }

  const data = { childName, gender, grade, klass, attendsFritids, childPhone, parentName, parentPhone };
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
  const scheduleInp = document.getElementById("newActSchedule");
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
      schedule: scheduleInp.value.trim(),
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
  scheduleInp.value = "";
  maxInp.value = "";
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
    const options = activitiesForStadium(currentBranch, stadium);
    const wishSet = new Set(wishIds(r));
    const checksHtml = options.length
      ? options.map(a => {
          const count = placedCountFor(currentBranch, a.id);
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
          <div>Kön: <b>${escapeHtml(r.gender || '–')}</b> &nbsp;·&nbsp; Går på fritids: <b>${r.attendsFritids ? "Ja" : "Nej"}</b></div>
          <div>Barnets telefon: <b>${r.childPhone ? phoneLink(r.childPhone) : '–'}</b></div>
          <div>Förälder: <b>${escapeHtml(r.parentName)}</b> &nbsp;·&nbsp; Telefon: <b>${phoneLink(r.parentPhone)}</b></div>
          <div>Önskemål: <b>${escapeHtml(wishIds(r).map(id => activityName(currentBranch, id)).join(', ') || '–')}</b></div>
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
    });
  });

  wrap.querySelectorAll("[data-remove-pending]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if(!confirm("Ta bort den här ansökan helt?")) return;
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
          await deleteDoc(doc(db, "registrations", b.dataset.regRemove));
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
        const grade = st.id === "lag" ? "1" : st.id === "mellan" ? "4" : "7";
        await addDoc(registrationsCol, {
          branch: currentBranch, childName, klass, grade,
          gender: "", attendsFritids: false, childPhone: "",
          parentName, parentPhone,
          wishActivityIds: [act.id], placedActivityIds: [act.id], ts: Date.now()
        });
        nameInp.value = "";
        classInp.value = "";
        parentInp.value = "";
        phoneInp.value = "";
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
        (r.childName || "").toLowerCase().includes(contactFilter) ||
        (r.klass || "").toLowerCase().includes(contactFilter) ||
        (r.parentName || "").toLowerCase().includes(contactFilter) ||
        (r.parentPhone || "").toLowerCase().includes(contactFilter)
      );
    }
    list = list.slice().sort((a,b) => (a.grade - b.grade) || a.childName.localeCompare(b.childName, 'sv'));

    const section = document.createElement("div");
    section.className = "deltagar-group";
    const rowsHtml = list.length
      ? list.map(r => {
          const placedNames = placedIds(r).map(id => activityName(currentBranch, id));
          return `
          <tr data-reg="${r.id}">
            <td>${escapeHtml(r.childName)}</td>
            <td>${escapeHtml(r.gender || '–')}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.klass)}</td>
            <td>${r.attendsFritids ? "Ja" : "Nej"}</td>
            <td>${escapeHtml(r.parentName)}</td>
            <td>${phoneLink(r.parentPhone)}</td>
            <td>${r.childPhone ? phoneLink(r.childPhone) : '<span class="muted">–</span>'}</td>
            <td>${placedNames.length ? escapeHtml(placedNames.join(', ')) : '<span class="muted">Väntar på placering</span>'}</td>
            <td><button class="rowbtn" data-contact-remove="${r.id}">Ta bort</button></td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="10" class="empty">${contactFilter ? 'Ingen matchning.' : 'Ingen anmäld i den här gruppen än.'}</td></tr>`;

    section.innerHTML = `
      <h4 class="stadium-heading">${st.label} <span class="muted">(${st.sub}) · ${list.length} st</span></h4>
      <div class="table-scroll">
      <table>
        <thead><tr><th>Barn</th><th>Kön</th><th>Åk</th><th>Klass</th><th>Fritids</th><th>Förälder</th><th>Förälders tel</th><th>Barnets tel</th><th>Aktivitet(er)</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      </div>`;
    wrap.appendChild(section);
  });

  wrap.querySelectorAll("[data-contact-remove]").forEach(b => {
    b.addEventListener("click", async () => {
      if(!confirm("Ta bort den här deltagaren helt?")) return;
      await deleteDoc(doc(db, "registrations", b.dataset.contactRemove));
    });
  });
}

/* ---------- Init ---------- */

function init(){
  renderGate();
  renderBranchSwitch();
  updateHeaderForAdminBranch();
}

init();
