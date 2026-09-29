// Inställningar som är enkla att ändra. Ändra värdena här – inte i script.js.

// Avdelningar (fritidsgårdar). Lägg till fler här om ni startar en ny.
export const BRANCHES = [
  { id: "holma", name: "Holma/Kroksbäck" }
];

// Skolor per avdelning. Ändringar som görs under Admin → Inställningar sparas i
// databasen och gäller före den här listan (som är standardvärdet).
export const DEFAULT_SCHOOLS_BY_BRANCH = {
  holma: ["Holmaskolan", "Kroksbäckskolan"]
};

// Grupper som aktiviteter kan höra till.
export const STADIUMS = [
  { id: "f", label: "Förskoleklass", sub: "Årskurs F" },
  { id: "lag", label: "Lågstadiet", sub: "Årskurs 1–3" },
  { id: "mellan", label: "Mellanstadiet", sub: "Årskurs 4–6" },
  { id: "hog", label: "Högstadiet", sub: "Årskurs 7–9" },
  { id: "utflykt", label: "Utflykter", sub: "Alla åldrar" },
  { id: "familj", label: "Familjeaktivitet", sub: "Endast åk F–3" }
];


// Automatisk utloggning av adminpanelen efter så här många minuters inaktivitet
// (skyddar mot att någon sätter sig vid en olåst dator). 0 = av.
export const ADMIN_IDLE_MINUTES = 30;

// Integritetsinformation som visas för föräldrar på anmälningssidan (under "Så hanteras uppgifterna").
// Texten om vilka uppgifter som sparas och vem som ser dem är skriven utifrån hur appen faktiskt fungerar.
// FYLL I raderna nedan – det jag inte kan veta åt er är vem som ansvarar, hur föräldrar når er och hur länge
// ni sparar uppgifterna. Tomma rader utelämnas. Det här är inte juridisk rådgivning: stäm av texten med
// ert dataskyddsombud eller er huvudman.
export const PRIVACY = {
  controller: "",   // Vem som ansvarar för uppgifterna, t.ex. "Allaktivitetshuset, Malmö stad"
  contact: "",      // Dit man vänder sig med frågor/rättelse/radering, t.ex. "fritid@exempel.se · 040-00 00 00"
  retention: "",    // Hur länge uppgifterna sparas, t.ex. "Till terminens slut – därefter raderas de."
  extra: ""         // Valfri extra mening, t.ex. en länk till er fullständiga integritetspolicy
};

// Skydd mot robotar/skräpanmälningar (Firebase App Check med reCAPTCHA v3). Lämna tomt tills ni har skapat
// en reCAPTCHA v3-webbplatsnyckel – se README ("Skydd mot skräpanmälningar"). Tomt = av (som förut).
export const APP_CHECK_SITE_KEY = "";
