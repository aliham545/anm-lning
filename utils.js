// Rena hjälpfunktioner (inga beroenden av databasen eller sidan).

/* ---------- Text och säkerhet ---------- */

// Gör text säker att sätta in i HTML – både som innehåll och inuti attribut
// (value="…", data-…="…"). Allt som skrivs av föräldrar måste gå igenom denna.
export function escapeHtml(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Antal (t.ex. familjens barn/vuxna) visas alltid som ett heltal – aldrig som fri text.
export function intText(v){
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.max(0, Math.trunc(n))) : "0";
}

// Normaliserar för jämförelse: gemener, utan accenter, enkla mellanslag.
export function normName(s){
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
// Sista nio siffrorna i ett telefonnummer (jämför +46 70… med 070…).
export function normPhone(s){
  return String(s || "").replace(/\D/g, "").slice(-9);
}

/* ---------- Visning ---------- */

export function phoneLink(phone){
  if(!phone) return '';
  const dial = phone.replace(/[^0-9+]/g, "");
  return `<a href="tel:${dial}" class="phone-link">${escapeHtml(phone)}</a>`;
}

export function goesHomeLabel(v){
  if(v === true) return "Ja";
  if(v === false) return "Nej";
  return "–";
}

// Kompakt märke för hemgång i aktivitetens deltagarlista. "Ska hämtas" är
// säkerhetsinfo och får därför en tydlig varningsfärg.
// Tydligt Ja/Nej för fritids i aktiviteternas deltagarlistor.
export function fritidsBadgeHtml(v){
  return v
    ? '<span class="home-badge fritids-yes" title="Går på fritids">Ja</span>'
    : '<span class="home-badge fritids-no" title="Går inte på fritids">Nej</span>';
}

export function homeBadgeHtml(v){
  if(v === true) return '<span class="home-badge home-ok" title="Får gå hem själv">Går själv</span>';
  if(v === false) return '<span class="home-badge home-warn" title="Ska hämtas av vårdnadshavare">Ska hämtas</span>';
  return '<span class="home-badge home-unknown" title="Uppgift saknas">Okänt</span>';
}

/* ---------- Årskurs och sortering ---------- */

export function stadiumForGrade(grade){
  if(String(grade).trim().toUpperCase() === "F") return "f";
  const g = parseInt(grade, 10);
  if(g >= 1 && g <= 3) return "lag";
  if(g >= 4 && g <= 6) return "mellan";
  if(g >= 7 && g <= 9) return "hog";
  return null;
}

export function gradeSortValue(grade){
  if(String(grade).trim().toUpperCase() === "F") return 0;
  const g = parseInt(grade, 10);
  return isNaN(g) ? 99 : g;
}

const WEEKDAY_ORDER = { "måndag": 1, "tisdag": 2, "onsdag": 3, "torsdag": 4, "fredag": 5, "lördag": 6, "söndag": 7 };
export function activitySortKey(a){
  const s = String(a.schedule || "").toLowerCase();
  let day = 99;
  for(const name in WEEKDAY_ORDER){
    if(s.includes(name)){ day = WEEKDAY_ORDER[name]; break; }
  }
  const m = s.match(/(\d{1,2})[:.](\d{2})/);
  const minutes = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 9999;
  return day * 10000 + minutes;
}

export function sortByDay(list){
  return list.slice().sort((a, b) => activitySortKey(a) - activitySortKey(b));
}

export function parseSortMinutes(timeStr){
  const m = String(timeStr || "").match(/(\d{1,2})[:.](\d{2})/);
  if(!m) return 9999;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/* ---------- Veckor ---------- */

export function currentWeekKey(ts){
  const d = new Date(ts || Date.now());
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return d.getFullYear() + "-W" + week;
}

export function weekLabel(ts){
  const wk = currentWeekKey(ts);
  const [year, wpart] = wk.split("-W");
  return "v." + wpart + " " + year;
}

/* ---------- Integritetsinformation ---------- */

// Bygger HTML för rutan "Så hanteras uppgifterna" av inställningarna i config.js (PRIVACY).
export function buildPrivacyHtml(cfg){
  const c = cfg || {};
  const line = (label, text) => text && String(text).trim()
    ? `<li><b>${escapeHtml(label)}</b> ${escapeHtml(String(text).trim())}</li>`
    : "";
  const contact = c.contact && String(c.contact).trim()
    ? line("Frågor, rättelse eller radering:", c.contact)
    : `<li><b>Frågor, rättelse eller radering:</b> kontakta fritidsgården.</li>`;
  return `
    <details class="privacy-box">
      <summary><span aria-hidden="true">🔒</span> Så hanteras uppgifterna</summary>
      <div class="privacy-body">
        <ul>
          <li><b>Vilka uppgifter:</b> barnets namn, kön, skola, årskurs och klass, om barnet går på fritids och om det får gå hem själv,
              kontaktuppgifter till dig (och till barnet om du anger dem) samt övrig information du skriver.</li>
          <li><b>Varför:</b> för att anmäla och placera barnet i aktiviteter, för att kunna nå dig vid behov och för barnets säkerhet
              (t.ex. hemgång och allergier).</li>
          <li><b>Vem ser dem:</b> bara personal som är inloggad i systemet. Uppgifterna visas aldrig för andra föräldrar.</li>
          <li><b>Var de lagras:</b> i molntjänsten Google Firebase.</li>
          ${line("Ansvarig:", c.controller)}
          ${line("Hur länge:", c.retention)}
          ${contact}
        </ul>
        ${c.extra && String(c.extra).trim() ? `<p>${escapeHtml(String(c.extra).trim())}</p>` : ""}
      </div>
    </details>`;
}
