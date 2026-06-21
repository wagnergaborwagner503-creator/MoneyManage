// ============ MoneyManage – fő alkalmazáslogika ============

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const MONTHS_HU = ["január","február","március","április","május","június","július","augusztus","szeptember","október","november","december"];
const DAYS_HU = ["vasárnap","hétfő","kedd","szerda","csütörtök","péntek","szombat"];

const state = {
  sb: null,            // supabase kliens
  store: null,         // LocalStore vagy SupaStore
  user: null,
  month: new Date(),   // kiválasztott hónap
  view: "dashboard",
  household: null,     // az AKTUÁLIS számla háztartás-objektuma (ha nem saját)
  households: [],      // az összes számla (zseb/közös háztartás)
  account: "self",     // melyik számlát kezeljük: "self" (saját) | <household id>
  cache: { categories: [], transactions: [], goals: [], recurring: [], profile: {}, sharedGoals: [], sharedTx: [], contributions: [] },
  charts: {},
  deferredInstall: null,
  rates: null,         // árfolyam-gyorsítótár (alap → megjelenítés)
  hideAmounts: false,  // szem-ikon: összegek elrejtése
};

// ---------- Beállítások (valuta, téma) – eszközszinten, localStorage-ben ----------
const CURRENCIES = {
  HUF: { symbol: "Ft", position: "suffix", decimals: 2, label: "Forint (Ft)" },
  EUR: { symbol: "€", position: "suffix", decimals: 2, label: "Euró (€)" },
  USD: { symbol: "$", position: "prefix", decimals: 2, label: "Dollár ($)" },
  GBP: { symbol: "£", position: "prefix", decimals: 2, label: "Font (£)" },
  RON: { symbol: "lei", position: "suffix", decimals: 2, label: "Román lej (lei)" },
  CHF: { symbol: "Fr", position: "suffix", decimals: 2, label: "Svájci frank (Fr)" },
  DKK: { symbol: "kr", position: "suffix", decimals: 2, label: "Dán korona (kr)" },
};
// Árfolyam-lekérés a mai napra (ingyenes, kulcs nélküli API-k, tartalékkal)
async function fetchRate(from, to) {
  // 1) Frankfurter (ECB) – elsődleges
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);
    if (r.ok) { const d = await r.json(); if (d.rates && d.rates[to]) return d.rates[to]; }
  } catch (e) { /* tartalékra váltunk */ }
  // 2) open.er-api.com – tartalék
  const r2 = await fetch(`https://open.er-api.com/v6/latest/${from}`);
  if (!r2.ok) throw new Error("rate");
  const d2 = await r2.json();
  const f = d2.rates && d2.rates[to];
  if (!f) throw new Error("rate");
  return f;
}
function getSettings() { try { return JSON.parse(localStorage.getItem("mm_settings") || "{}"); } catch { return {}; } }
function setSetting(k, v) { const s = getSettings(); s[k] = v; localStorage.setItem("mm_settings", JSON.stringify(s)); }
const currentCurrency = () => (CURRENCIES[getSettings().currency] ? getSettings().currency : "HUF");
// TÁROLÁSI (alap) pénznem – ebben tároljuk az összegeket; átváltáskor EZ nem változik (veszteségmentes visszaváltás)
const baseCurrency = () => (CURRENCIES[getSettings().baseCurrency] ? getSettings().baseCurrency : currentCurrency());
const MASK = "✱✱✱";   // rejtett összeg helyettesítője (csillagok)

// Az alap pénznemből az összes többibe – egy hívással
async function fetchAllRates(base) {
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`);
    if (r.ok) { const d = await r.json(); if (d.rates) return d.rates; }
  } catch (e) { /* tartalék */ }
  const r2 = await fetch(`https://open.er-api.com/v6/latest/${base}`);
  if (!r2.ok) throw new Error("rate");
  const d2 = await r2.json();
  if (!d2.rates) throw new Error("rate");
  return d2.rates;
}
// Árfolyam-gyorsítótár: state.rates = { base, date, map:{CUR:faktor} } (alap→cél)
async function ensureRates() {
  const base = baseCurrency(), cur = currentCurrency();
  if (cur === base) return;
  const today = isoDate(today0());
  if (state.rates && state.rates.base === base && state.rates.date === today && state.rates.map && state.rates.map[cur] != null) return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("mm_rates") || "null"); } catch (e) {}
  if (cached && cached.base === base && cached.date === today && cached.map && cached.map[cur] != null) { state.rates = cached; return; }
  try {
    const map = await fetchAllRates(base);
    state.rates = { base, date: today, map };
    localStorage.setItem("mm_rates", JSON.stringify(state.rates));
  } catch (e) {
    if (cached && cached.base === base && cached.map) state.rates = cached;
  }
}
function displayFactor() {
  const base = baseCurrency(), cur = currentCurrency();
  if (cur === base) return 1;
  if (state.rates && state.rates.base === base && state.rates.map && state.rates.map[cur] != null) return state.rates.map[cur];
  return null;
}

// ---------- Pénz-formázás (magyar tagolás: ezresek vékony szóközzel, tizedesek elkülönítve) ----------
const THIN = " "; // vékony szóköz az ezresekhez ("egy picit távolabb")
function moneyParts(baseAmount, curCode) {
  let display = curCode || currentCurrency();
  let factor = 1;
  if (!curCode && display !== baseCurrency()) { const f = displayFactor(); if (f != null) factor = f; else display = baseCurrency(); }
  const c = CURRENCIES[display] || CURRENCIES.HUF;
  const val = (Number(baseAmount) || 0) * factor;
  const neg = val < 0;
  const abs = Math.abs(val);
  const nf = new Intl.NumberFormat("hu-HU", { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals });
  let s = nf.format(abs).replace(/ /g, THIN); // NBSP → vékony szóköz
  let intPart = s, decPart = "";
  if (c.decimals > 0) {
    const idx = s.lastIndexOf(",");
    if (idx >= 0) { intPart = s.slice(0, idx); decPart = s.slice(idx); }
  }
  return { neg, intPart, decPart, symbol: c.symbol, position: c.position };
}
// Stílusozott HTML (tizedesek kisebb/halványabb, valuta jel)
function fmtHTML(n, opts = {}) {
  if (state.hideAmounts && !opts.force) return `<span class="money">${MASK}</span>`;
  const p = moneyParts(n, opts.cur);
  const sign = p.neg ? "−" : (opts.plus ? "+" : "");
  const cur = `<span class="m-cur">${p.symbol}</span>`;
  const num = `<span class="m-int">${p.intPart}</span>${p.decPart ? `<span class="m-dec">${p.decPart}</span>` : ""}`;
  const body = p.position === "prefix" ? `${cur}${num}` : `${num}${THIN}${cur}`;
  return `<span class="money">${sign}${body}</span>`;
}
// Sima szöveg (CSV, toast, input)
function fmt(n, opts = {}) {
  if (state.hideAmounts && !opts.force) return MASK;
  const p = moneyParts(n, opts.cur);
  const sign = p.neg ? "−" : (opts.plus ? "+" : "");
  const num = p.intPart + p.decPart;
  return p.position === "prefix" ? `${sign}${p.symbol}${num}` : `${sign}${num} ${p.symbol}`;
}

// Beírt (megjelenítési) összeg → tárolási (alap) összeg
function parseAmountToBase(str) {
  const v = parseAmount(str);
  if (isNaN(v)) return v;
  if (currentCurrency() === baseCurrency()) return v;
  const f = displayFactor();
  return f ? Math.round((v / f) * 100) / 100 : v;
}
// Tárolási (alap) összeg → megjelenítési szám (input mezőkbe, szerkesztéskor)
function baseToDisplay(n) {
  if (currentCurrency() === baseCurrency()) return Number(n) || 0;
  const f = displayFactor();
  return f ? Math.round((Number(n) || 0) * f * 100) / 100 : (Number(n) || 0);
}

// ---------- Téma ----------
function resolveTheme() {
  const mode = getSettings().theme || "system";
  if (mode === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return mode;
}
function applyTheme() {
  const t = resolveTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.getElementById("meta-theme");
  if (meta) meta.setAttribute("content", t === "dark" ? "#070b16" : "#2563eb");
  if (state.cache && state.view) renderView(); // diagramok újraszínezése
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((getSettings().theme || "system") === "system") applyTheme();
});

// ---------- Lucide ikonok ----------
function drawIcons() { try { if (window.lucide) lucide.createIcons(); } catch (e) {} }
// Sávok/oszlopok animációja (0 → érték, CSS átmenettel)
function animateBars(scope) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scope.querySelectorAll(".progress-fill[data-w]").forEach(e => { e.style.width = Math.max(0, Math.min(100, Number(e.dataset.w) || 0)) + "%"; });
    scope.querySelectorAll(".bar-fill[data-h]").forEach(e => { e.style.height = (Number(e.dataset.h) || 0) + "%"; });
  }));
}
// Ha egy nagy összeg nem fér ki egy sorba, a tizedes részt elrejtjük (sosem törik új sorba)
function fitMoney(scope) {
  (scope || document).querySelectorAll(".hero-balance, .stat-value, .chart-total .amt").forEach(c => {
    const dec = c.querySelector(".m-dec"); if (!dec) return;
    dec.style.display = "";
    if (c.scrollWidth > c.clientWidth + 1) dec.style.display = "none";
  });
}
window.addEventListener("resize", () => { try { fitMoney(); } catch (e) {} });
// Aktuális téma színei (Chart.js-hez)
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { text: v("--text"), muted: v("--text-muted"), grid: v("--border"), primary: v("--primary"), green: v("--green"), teal: v("--teal"), surface: v("--surface") };
}
const EMOJI_TO_ICON = {
  "🏠": "house", "🛒": "shopping-cart", "🚌": "bus", "🎉": "party-popper", "💊": "pill",
  "👕": "shirt", "📱": "smartphone", "📦": "package", "🎮": "gamepad-2", "📚": "book-open",
  "🐾": "paw-print", "🚬": "cigarette", "☕": "coffee", "💇": "scissors", "🎁": "gift",
  "⚽": "dribbble", "🎯": "target", "🏖": "umbrella", "🚗": "car", "💍": "gem",
  "🎓": "graduation-cap", "💻": "laptop", "🛡": "shield", "✈️": "plane", "🎸": "music",
  "👶": "baby", "🐕": "dog", "💵": "banknote", "🏦": "piggy-bank", "🍔": "utensils",
};
// Tárolt ikon → érvényes Lucide név (régi emoji adatok átképezése)
function iconName(stored) {
  if (!stored) return "circle";
  if (/^[a-z][a-z0-9-]*$/.test(stored)) return stored;
  return EMOJI_TO_ICON[stored] || "circle";
}
const ic = (name, cls = "") => `<i data-lucide="${iconName(name)}"${cls ? ` class="${cls}"` : ""}></i>`;

// ---------- Segédfüggvények ----------
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const isCurrentMonth = (d) => monthKey(d) === monthKey(new Date());
const monthLabel = (d) => `${d.getFullYear()}. ${MONTHS_HU[d.getMonth()]}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, iconName) {
  const t = $("#toast");
  t.innerHTML = (iconName ? ic(iconName) : "") + `<span>${esc(msg)}</span>`;
  t.classList.remove("hidden");
  drawIcons();
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2400);
}

function txOfMonth(d = state.month) {
  const key = monthKey(d);
  return state.cache.transactions.filter(t => (t.date || "").startsWith(key));
}
function sumBy(list, type) {
  return list.filter(t => t.type === type).reduce((s, t) => s + Number(t.amount || 0), 0);
}

// ---------- Jövőbeli / tervezett (pending) tételek ----------
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isFutureDate = (str) => new Date(str + "T00:00:00") > today0();
const isPending = (t) => t.pending === true || t.pending === "true";
// Megtakarítás-felhasználás: bevétel típusú, de cél megvalósításából (külön kezeljük)
const isWithdraw = (t) => t.type === "income" && (t.from_savings === true || t.from_savings === "true");
// Számlák közötti átvezetés (két láb: 'out' a forrásnál, 'in' a célnál) – se nem bevétel, se nem kiadás
const isTransfer = (t) => t.type === "transfer";
// Egy tétel hatása az adott számla KÖLTŐPÉNZ-egyenlegére (+ befelé, − kifelé)
function txBalanceDelta(t) {
  const a = Number(t.amount) || 0;
  if (isTransfer(t)) return (t.transfer_dir === "in") ? a : -a;
  return (t.type === "income") ? a : -a; // a kiadás és a megtakarítás is csökkenti a költőpénzt
}
// "realized" = teljesített tételek (ezek számítanak a statisztikába); a pending kimarad
const realized = (list) => list.filter(t => !isPending(t));
const realizedOfMonth = (d = state.month) => realized(txOfMonth(d));

// ---------- Ismétlődés: n-edik előfordulás dátuma a horgonytól számolva ----------
function occurrenceDate(anchor, unit, count, n) {
  const a = anchor;
  if (unit === "day")  { const d = new Date(a); d.setDate(a.getDate() + count * n); return d; }
  if (unit === "week") { const d = new Date(a); d.setDate(a.getDate() + count * 7 * n); return d; }
  if (unit === "year") {
    const y = a.getFullYear() + count * n;
    const dim = new Date(y, a.getMonth() + 1, 0).getDate();
    return new Date(y, a.getMonth(), Math.min(a.getDate(), dim));
  }
  // month (alapértelmezett)
  const total = a.getMonth() + count * n;
  const y = a.getFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const dim = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(a.getDate(), dim));
}
function recurringAnchor(r) {
  if (r.anchor_date) return new Date(r.anchor_date.slice(0, 10) + "T00:00:00");
  if (r.day) { // régi rekord: havi, adott napon – ettől a hónaptól indul
    const t = new Date();
    const dim = daysInMonth(t);
    return new Date(t.getFullYear(), t.getMonth(), Math.min(Number(r.day), dim));
  }
  if (r.created_at) { const d = new Date(r.created_at); d.setHours(0, 0, 0, 0); return d; }
  return today0();
}
function freqText(r) {
  const c = Math.max(1, Number(r.interval_count || 1));
  const u = r.interval_unit || "month";
  if (c === 1) return { day: "naponta", week: "hetente", month: "havonta", year: "évente" }[u];
  return { day: `${c} naponta`, week: `${c} hetente`, month: `${c} havonta`, year: `${c} évente` }[u];
}

function catById(id) { return state.cache.categories.find(c => c.id === id); }
const allGoals = () => [...state.cache.goals, ...(state.cache.sharedGoals || [])];
function goalById(id) { return allGoals().find(g => g.id === id); }
// Az aktuális számlán (saját vagy zseb/közös) az adott célra félretett megtakarítások összege.
function goalSaved(goal) {
  return Number(goal.start_amount || 0) +
    state.cache.transactions.filter(t => t.type === "saving" && t.goal_id === goal.id)
      .reduce((s, t) => s + Number(t.amount || 0), 0);
}
// Az adott célból már FELHASZNÁLT összeg (a célhoz kötött megtakarítás-felhasználások).
function goalUsed(goal) {
  return state.cache.transactions
    .filter(t => isWithdraw(t) && t.goal_id === goal.id)
    .reduce((s, t) => s + Number(t.amount || 0), 0);
}
// Az adott célon még elérhető (összegyűjtött − felhasznált) megtakarítás.
function goalAvailable(goal) { return Math.max(0, goalSaved(goal) - goalUsed(goal)); }

// Egy kategória havi átlagos (teljesített) kiadása a megadott hónap ELŐTTI hónapokból.
// A költségkeret-sávon ezt jelöli egy vékony vonal (mennyit szoktál itt költeni).
function categoryMonthlyAvg(catId, beforeMonth = state.month) {
  const cutoff = `${beforeMonth.getFullYear()}-${String(beforeMonth.getMonth() + 1).padStart(2, "0")}`;
  const byMonth = {};
  for (const t of state.cache.transactions) {
    if (t.type !== "expense" || t.category_id !== catId || isPending(t)) continue;
    const k = (t.date || "").slice(0, 7);
    if (!k || k >= cutoff) continue; // csak a megelőző hónapok
    byMonth[k] = (byMonth[k] || 0) + Number(t.amount || 0);
  }
  const months = Object.keys(byMonth);
  if (!months.length) return 0;
  return months.reduce((s, k) => s + byMonth[k], 0) / months.length;
}

// ---------- Egyenleg-korrekció (kezdő egyenleg) – számlánként, eszközszinten ----------
const acctKey = () => (state.account && state.account !== "self" ? state.account : "self");
// Az összes számla (Saját + zsebek/közös) – az átvezetés cél-választójához
function allAccounts() {
  return [{ id: "self", name: "Saját" }, ...(state.households || []).map(h => ({ id: h.id, name: h.name }))];
}
function accountName(id) {
  if (id === "self" || id == null) return "Saját";
  return (state.households || []).find(h => h.id === id)?.name || "Számla";
}
function getOpening() { const o = getSettings().openings; const v = o && o[acctKey()]; return v ? v : null; }
// A jelenleg vezetett nettó egy adott dátumig (korrekció nélkül) – a korrekció kiszámításához
function trackedNetUpTo(dateStr) {
  let sum = 0;
  for (const t of state.cache.transactions) {
    if ((t.date || "") > dateStr) continue;
    sum += txBalanceDelta(t); // bevétel +, kiadás/megtakarítás/átvezetés-ki −, átvezetés-be +
  }
  return sum;
}

// ---------- Előző hónapból átvitt maradék ----------
// A hónap kezdete ELŐTTI összes tétel nettója (bevétel − kiadás − megtakarítás) + a kezdő-egyenleg korrekció.
function carryoverInto(d = state.month) {
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  let sum = 0;
  for (const t of state.cache.transactions) {
    if ((t.date || "") >= start) continue;
    if (isPending(t)) continue; // a még KIFIZETETLEN korábbi tételek nem a maradékba, hanem az aktuális hónap látókörébe számítanak (áthúzódnak)
    sum += txBalanceDelta(t); // bevétel +, kiadás/megtakarítás/átvezetés-ki −, átvezetés-be +
  }
  const op = getOpening();
  if (op) sum += Number(op.amount) || 0; // a korrekció állandó alapszint
  return sum;
}

// A megadott hónap eleje ELŐTT dátumozott, még teljesítetlen (pending) tételek – "korábbról áthúzódó, kifizetetlen".
function overduePending(d = state.month) {
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return state.cache.transactions.filter(t => isPending(t) && (t.date || "") !== "" && (t.date || "") < start);
}
// A hónap teljes "látóköre": az adott hónapra dátumozott tételek + az áthúzódó kifizetetlenek.
function monthScopeTx(d = state.month) {
  return [...overduePending(d), ...txOfMonth(d)];
}

// ---------- Okos előrejelzés (szokások + rendszeresség) ----------
// Még nem könyvelt, ütemezett ismétlődő tételek a hónap hátralévő részében.
function upcomingRecurring(typeFilter, d = state.month) {
  if (!isCurrentMonth(d)) return 0;
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0); monthEnd.setHours(0, 0, 0, 0);
  const todayD = today0();
  let sum = 0;
  for (const r of state.cache.recurring) {
    if (!r.active) continue;
    if (typeFilter && r.type !== typeFilter) continue;
    const anchor = recurringAnchor(r); if (!anchor || isNaN(anchor)) continue;
    const unit = r.interval_unit || "month", count = Math.max(1, Number(r.interval_count || 1));
    for (let n = 0, g = 0; g < 1000; n++, g++) {
      const occ = occurrenceDate(anchor, unit, count, n); occ.setHours(0, 0, 0, 0);
      if (occ > monthEnd) break;
      if (occ > todayD) {
        const occStr = isoDate(occ);
        if (!state.cache.transactions.some(t => t.recurring_id === r.id && t.date === occStr)) sum += Number(r.amount) || 0;
      }
    }
  }
  return sum;
}
// A hónap várható összes kiadása: könyvelt + hátralévő ismétlődő + tervezett (pending) + napi szokás-kivetítés.
function projectMonthExpense(d = state.month) {
  const txReal = realizedOfMonth(d);
  const realizedExp = sumBy(txReal, "expense");
  if (!isCurrentMonth(d)) return realizedExp;
  const dim = daysInMonth(d), elapsed = new Date().getDate(), remaining = Math.max(0, dim - elapsed);
  const casualRealized = txReal.filter(t => t.type === "expense" && !t.recurring_id).reduce((s, t) => s + Number(t.amount), 0);
  const dailyRate = elapsed > 0 ? casualRealized / elapsed : 0;
  const pendingExp = sumBy(txOfMonth(d).filter(isPending), "expense"); // tervezett, kézi
  return realizedExp + dailyRate * remaining + upcomingRecurring("expense", d) + pendingExp;
}
function projectMonthIncome(d = state.month) {
  const incAll = sumBy(txOfMonth(d), "income"); // realized + pending
  if (!isCurrentMonth(d)) return incAll;
  return incAll + upcomingRecurring("income", d);
}
// Halmozott napi kivetítés a hónap végéig (statisztika szaggatott vonalához)
function projectedCumulative(d = state.month) {
  const dim = daysInMonth(d);
  const daily = new Array(dim).fill(0);
  realizedOfMonth(d).filter(t => t.type === "expense").forEach(t => { const day = parseInt(t.date.slice(8, 10), 10); if (day >= 1 && day <= dim) daily[day - 1] += Number(t.amount); });
  if (isCurrentMonth(d)) {
    const elapsed = new Date().getDate();
    const casualRealized = realizedOfMonth(d).filter(t => t.type === "expense" && !t.recurring_id).reduce((s, t) => s + Number(t.amount), 0);
    const dailyRate = elapsed > 0 ? casualRealized / elapsed : 0;
    // jövőbeli napokra: napi szokás + esedékes ismétlődő + tervezett az adott napon
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0); monthEnd.setHours(0, 0, 0, 0);
    for (let day = elapsed + 1; day <= dim; day++) {
      daily[day - 1] += dailyRate;
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      // tervezett (pending) kézi kiadások ezen a napon
      txOfMonth(d).filter(t => isPending(t) && t.type === "expense" && t.date === ds).forEach(t => daily[day - 1] += Number(t.amount));
      // esedékes ismétlődő kiadások ezen a napon
      for (const r of state.cache.recurring) {
        if (!r.active || r.type !== "expense") continue;
        const anchor = recurringAnchor(r); if (!anchor || isNaN(anchor)) continue;
        const unit = r.interval_unit || "month", count = Math.max(1, Number(r.interval_count || 1));
        for (let n = 0, g = 0; g < 1000; n++, g++) { const occ = occurrenceDate(anchor, unit, count, n); occ.setHours(0, 0, 0, 0); if (occ > monthEnd) break; if (isoDate(occ) === ds && !state.cache.transactions.some(t => t.recurring_id === r.id && t.date === ds)) daily[day - 1] += Number(r.amount); }
      }
    }
  }
  let run = 0; return daily.map(v => (run += v));
}

async function refreshCache() {
  // 1) Az összes számla (zseb/közös háztartás) lekérése (cloud) – hogy beállíthassuk a kontextust
  let households = [];
  if (state.store.mode === "cloud") {
    try { households = await state.store.getHouseholds(); } catch (e) { /* sharing nincs beállítva */ }
  }
  state.households = households;
  // ha a kiválasztott számla már nem létezik, vissza a sajátra
  if (state.account !== "self" && !households.some(h => h.id === state.account)) state.account = "self";
  const curHid = state.account !== "self" ? state.account : null;
  state.household = curHid ? households.find(h => h.id === curHid) : null;
  // a tároló kontextusa: zseb/közös nézetben az adott háztartás tételeit kezeljük
  state.store.setCtx(curHid);

  const [categories, transactions, goals, recurring, profile] = await Promise.all([
    state.store.list("categories"),
    state.store.list("transactions"),
    state.store.list("goals"),
    state.store.list("recurring"),   // a recurring mindig személyes
    state.store.getProfile(),
  ]);
  categories.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  transactions.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.created_at || "").localeCompare(a.created_at || ""));
  state.cache = { categories, transactions, goals, recurring, profile, sharedGoals: [], sharedTx: [], contributions: [] };
}

// ---------- Ismétlődő tételek automatikus könyvelése ----------
// A horgonytól (anchor_date) indulva minden esedékes (mai vagy korábbi) előfordulást
// pontos dátum szerint könyvel. A dedup a (recurring_id + dátum) páron alapul,
// így egy adott előfordulás SOHA nem kerül be kétszer – frissítéskor sem.
async function applyRecurring() {
  const today = today0();
  // Az ismétlődő tételek MINDIG a személyes számlára könyvelődnek (közös nézetben se a household-ba)
  const prevCtx = state.store.ctxHousehold;
  if (state.store.setCtx) state.store.setCtx(null);
  // Helyi munkapéldány, hogy a cikluson belül felvett tételeket is lássa a dedup
  const booked = new Set(
    state.cache.transactions
      .filter(t => t.recurring_id)
      .map(t => t.recurring_id + "|" + (t.date || "").slice(0, 10))
  );
  let added = 0;
  for (const r of state.cache.recurring) {
    if (!r.active) continue;
    const unit = r.interval_unit || "month";
    const count = Math.max(1, Number(r.interval_count || 1));
    const anchor = recurringAnchor(r);
    if (!anchor || isNaN(anchor)) continue;
    // Manuális (kézi) mód: a könyvelt előfordulások TERVEZETT (pending) tételként kerülnek be –
    // a felhasználónak kell kipipálnia, amikor ténylegesen levonták. A következő esedékességet is előre felvesszük.
    const manual = r.auto_post === false || r.auto_post === "false";
    for (let n = 0, guard = 0; guard < 1000; n++, guard++) {
      const occ = occurrenceDate(anchor, unit, count, n);
      occ.setHours(0, 0, 0, 0);
      const future = occ > today;
      if (future && !manual) break;    // auto: jövőbeli előfordulást még nem könyvelünk
      const occStr = isoDate(occ);
      const dedupKey = r.id + "|" + occStr;
      if (!booked.has(dedupKey)) {
        booked.add(dedupKey);
        await state.store.insert("transactions", {
          type: r.type, amount: r.amount, category_id: r.category_id || null,
          note: r.name, date: occStr, recurring_id: r.id, pending: manual,
        });
        added++;
      }
      if (future) break;               // manuálisnál az első jövőbeli esedékesség után megállunk
    }
  }
  if (state.store.setCtx) state.store.setCtx(prevCtx || null); // kontextus visszaállítása
  if (added) {
    await refreshCache();
    toast(`${added} ismétlődő tétel könyvelve`, "check");
  }
}

// ============ AUTENTIKÁCIÓ ============
function supabaseConfigured() {
  return window.MM_CONFIG && MM_CONFIG.SUPABASE_URL && MM_CONFIG.SUPABASE_ANON_KEY;
}

async function initAuth() {
  if (supabaseConfigured()) {
    state.sb = window.supabase.createClient(MM_CONFIG.SUPABASE_URL, MM_CONFIG.SUPABASE_ANON_KEY);
    const { data: { session } } = await state.sb.auth.getSession();
    if (session) { await startApp(new SupaStore(state.sb, session.user.id), session.user); return; }
  } else {
    $("#auth-config-note").style.display = "block";
    if (localStorage.getItem("mm_local_active") === "1") { await startApp(new LocalStore(), null); return; }
  }
  // Ha helyi módban volt aktív, folytassuk ott
  if (localStorage.getItem("mm_local_active") === "1") { await startApp(new LocalStore(), null); return; }
  showAuth();
}

function showAuth() {
  $("#auth-screen").classList.remove("hidden");
  $("#app").classList.add("hidden");
  drawIcons();

  // Pénznem-választó feltöltése (regisztrációhoz)
  const curSel = $("#auth-currency");
  if (curSel && !curSel.dataset.filled) {
    curSel.innerHTML = Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}" ${k === "HUF" ? "selected" : ""}>${esc(c.label)}</option>`).join("");
    curSel.dataset.filled = "1";
  }
  // Jelszó megjelenítése / elrejtése
  const pwToggle = $("#auth-pw-toggle");
  if (pwToggle) pwToggle.onclick = () => {
    const inp = $("#auth-password");
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    pwToggle.innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`;
    drawIcons();
  };

  let mode = "login";
  $$(".auth-tab").forEach(tab => tab.onclick = () => {
    $$(".auth-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    mode = tab.dataset.authtab;
    const reg = mode === "register";
    $("#auth-name-field").style.display = reg ? "block" : "none";
    $("#auth-currency-field").style.display = reg ? "block" : "none";
    $("#auth-submit").textContent = reg ? "Fiók létrehozása" : "Bejelentkezés";
    hideAuthError();
  });

  const errBox = $("#auth-error");
  function showAuthError(msg, ok = false) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    errBox.classList.toggle("success", ok);
  }
  function hideAuthError() { errBox.classList.add("hidden"); }

  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    hideAuthError();
    if (!supabaseConfigured()) { showAuthError("A Supabase nincs beállítva – használd a helyi módot, vagy töltsd ki a js/config.js fájlt."); return; }
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    $("#auth-submit").disabled = true;
    try {
      if (mode === "register") {
        const name = $("#auth-name").value.trim();
        const chosenCur = CURRENCIES[$("#auth-currency").value] ? $("#auth-currency").value : "HUF";
        setSetting("baseCurrency", chosenCur);   // a tárolási (fő) pénznem
        setSetting("currency", chosenCur);       // és kezdetben ezt is jelenítjük meg
        const { data, error } = await state.sb.auth.signUp({ email, password, options: { data: { name } } });
        if (error) throw error;
        if (!data.session) { showAuthError("Sikeres regisztráció! Erősítsd meg az e-mail címed a kapott levélben, majd jelentkezz be.", true); return; }
        await startApp(new SupaStore(state.sb, data.session.user.id), data.session.user);
      } else {
        const { data, error } = await state.sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await startApp(new SupaStore(state.sb, data.session.user.id), data.session.user);
      }
    } catch (err) {
      const msgs = {
        "Invalid login credentials": "Hibás e-mail cím vagy jelszó.",
        "Email not confirmed": "Az e-mail cím még nincs megerősítve – nézd meg a postaládád.",
        "User already registered": "Ezzel az e-mail címmel már van fiók.",
      };
      showAuthError(msgs[err.message] || ("Hiba: " + err.message));
    } finally {
      $("#auth-submit").disabled = false;
    }
  };

  $("#auth-forgot").onclick = async () => {
    if (!supabaseConfigured()) return;
    const email = $("#auth-email").value.trim();
    if (!email) { showAuthError("Add meg az e-mail címed, és újra kattints ide."); return; }
    const { error } = await state.sb.auth.resetPasswordForEmail(email, { redirectTo: location.href });
    showAuthError(error ? "Hiba: " + error.message : "Jelszó-visszaállító e-mail elküldve!", !error);
  };

  $("#btn-local-mode").onclick = async () => {
    localStorage.setItem("mm_local_active", "1");
    await startApp(new LocalStore(), null);
  };
}

async function logout() {
  if (state.store?.mode === "cloud" && state.sb) await state.sb.auth.signOut();
  localStorage.removeItem("mm_local_active");
  location.reload();
}

// ============ APP INDÍTÁS ============
async function startApp(store, user) {
  state.store = store;
  state.user = user;
  // alap pénznem és elrejtés-állapot inicializálása
  if (!getSettings().baseCurrency) setSetting("baseCurrency", currentCurrency());
  state.hideAmounts = !!getSettings().hide;
  await store.init();
  await refreshCache();
  await applyRecurring();
  await ensureRates();   // megjelenítési árfolyam (ha eltér az alaptól)

  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const who = user ? (user.user_metadata?.name || user.email) : "Helyi mód (nincs fiók)";
  $("#sidebar-user").textContent = (store.mode === "cloud" ? "☁ " : "▣ ") + who;

  bindNav();
  updateAppbar();
  renderView();
  maybeShowWelcome();
}

// Felső léc: profilnév + avatar + szem-ikon
function updateAppbar() {
  const name = state.cache.profile?.name || state.user?.user_metadata?.name || (state.store?.mode === "cloud" ? (state.user?.email || "") : "Vendég");
  const initial = ((name || "?").trim()[0] || "?").toUpperCase();
  const pn = $("#appbar-pname"), av = $("#appbar-avatar");
  if (pn) pn.textContent = name;
  if (av) av.textContent = initial;
  const hb = $("#btn-hide");
  if (hb) hb.innerHTML = `<i data-lucide="${state.hideAmounts ? "eye-off" : "eye"}"></i>`;
  updateAcctSwitch();
  drawIcons();
}

// Számla-váltó legördülő (Saját + zsebek/közös háztartások + Új zseb) – csak felhő módban
function updateAcctSwitch() {
  const wrap = $("#acct-wrap"); if (!wrap) return;
  if (!(state.store && state.store.mode === "cloud")) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const cur = state.account === "self" ? "Saját" : (state.households.find(h => h.id === state.account)?.name || "Számla");
  $("#acct-label").textContent = cur;
  const items = [`<button data-acct="self" class="${state.account === "self" ? "active" : ""}">${ic("user")} <span style="flex:1">Saját</span>${state.account === "self" ? ic("check") : ""}</button>`];
  for (const h of state.households) {
    const shared = (h.members || []).length > 1;
    items.push(`<button data-acct="${h.id}" class="${state.account === h.id ? "active" : ""}">${ic(shared ? "users" : "wallet")} <span style="flex:1">${esc(h.name)}</span>${state.account === h.id ? ic("check") : ""}</button>`);
  }
  items.push(`<div class="acct-sep"></div>`);
  items.push(`<button class="acct-new" data-acct="__new">${ic("plus")} Új zseb létrehozása</button>`);
  const menu = $("#acct-menu");
  menu.innerHTML = items.join("");
  menu.querySelectorAll("button").forEach(b => b.onclick = async () => {
    menu.classList.add("hidden");
    const a = b.dataset.acct;
    if (a === "__new") return createPocketFlow();
    if (a === state.account) return;
    state.account = a;
    await refreshCache();
    if (state.view === "dashboard") renderView(); else switchView("dashboard");
    toast(a === "self" ? "Saját számla" : (state.households.find(h => h.id === a)?.name || "Számla"), "check");
  });
}
async function createPocketFlow() {
  const name = await askText({ title: "Új zseb", label: "A zseb neve", placeholder: "Pl. Vállalkozás", okText: "Létrehozás" });
  if (!name) return;
  try {
    const hid = await state.store.createPocket(name);
    state.account = hid;
    await refreshCache();
    if (state.view === "dashboard") renderView(); else switchView("dashboard");
    toast("Zseb létrehozva", "check");
  } catch (e) { toast("Nem sikerült létrehozni – futott már a sharing.sql?"); }
}

// ============ NAVIGÁCIÓ ============
function bindNav() {
  $$("[data-view]").forEach(btn => btn.onclick = () => switchView(btn.dataset.view));
  $("#btn-quick-add").onclick = () => openTxModal();
  $("#btn-fab").onclick = () => openTxModal();
  $("#month-prev").onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderView(); };
  $("#month-next").onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderView(); };
  $("#month-label").onclick = () => { state.month = new Date(); renderView(); };
  $("#modal-close").onclick = closeModal;
  $("#modal-overlay").onclick = (e) => { if (e.target === $("#modal-overlay")) closeModal(); };
  // Felső léc gombjai
  $("#btn-settings").onclick = () => switchView("settings");
  $("#appbar-profile").onclick = () => switchView("profile");
  $("#btn-hide").onclick = () => {
    state.hideAmounts = !state.hideAmounts;
    setSetting("hide", state.hideAmounts);
    updateAppbar();
    renderView();
  };
  // Számla-váltó legördülő nyitása/zárása (a menüpontokat az updateAcctSwitch köti)
  const acctBtn = $("#acct-btn");
  if (acctBtn) acctBtn.onclick = (e) => { e.stopPropagation(); $("#acct-menu").classList.toggle("hidden"); };
  document.addEventListener("click", () => { const m = $("#acct-menu"); if (m) m.classList.add("hidden"); });
}

function switchView(view) {
  state.view = view;
  $$(".nav-item, .bnav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  renderView();
}

function renderView() {
  $("#month-label").textContent = monthLabel(state.month);
  $$(".view").forEach(v => v.classList.add("hidden"));
  const el = $(`#view-${state.view}`);
  el.classList.remove("hidden");
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};
  const renderers = {
    dashboard: renderDashboard, transactions: renderTransactions, budget: renderBudget,
    goals: renderGoals, stats: renderStats, profile: renderProfile, settings: renderSettings,
  };
  renderers[state.view](el);
  if (typeof updateAppbar === "function") updateAppbar();
  drawIcons();
  requestAnimationFrame(() => { try { fitMoney(el); } catch (e) {} });
}

// ============ ÁTTEKINTÉS (Dashboard) ============
function renderDashboard(el) {
  const txAll = txOfMonth();
  const txReal = realized(txAll);
  // Teljesített (realized) – ez megy a Bevétel/Kiadás kártyákra és a keretekbe
  const incomePureR = txReal.filter(t => t.type === "income" && !isWithdraw(t)).reduce((s, t) => s + Number(t.amount), 0);
  const withdrawR = txReal.filter(isWithdraw).reduce((s, t) => s + Number(t.amount), 0); // felhasznált megtakarítás
  const expenseR = sumBy(txReal, "expense");
  const savingR = sumBy(txReal, "saving");
  // Tervezettel együtt (pending is) – ez a "Hó végén marad"
  const incomeAll = sumBy(txAll, "income"); // tartalmazza a felhasznált megtakarítást is (mindkettő elérhető pénz)
  const incomePureAll = txAll.filter(t => t.type === "income" && !isWithdraw(t)).reduce((s, t) => s + Number(t.amount), 0);
  const expenseAll = sumBy(txAll, "expense");
  const savingAll = sumBy(txAll, "saving");
  const overdue = overduePending();   // korábbról áthúzódó, kifizetetlen tételek
  const overdueNet = overdue.reduce((s, t) => s + txBalanceDelta(t), 0);
  const transferNet = txAll.reduce((s, t) => s + (isTransfer(t) ? txBalanceDelta(t) : 0), 0); // számlák közötti átvezetések nettója (se nem bevétel, se nem kiadás)
  const carry = carryoverInto();   // előző hónapból átvitt maradék (a kifizetetlenek nélkül)
  const balance = carry + incomeAll - expenseAll - savingAll + overdueNet + transferNet;
  const pendingCount = txAll.filter(isPending).length;
  const plannedExpense = expenseAll - expenseR;
  const plannedIncome = incomePureAll - incomePureR;
  const plannedSaving = savingAll - savingR;

  const now = new Date();
  const dim = daysInMonth(state.month);
  const cur = isCurrentMonth(state.month);
  const daysLeft = cur ? dim - now.getDate() + 1 : dim;
  const daily = balance > 0 ? balance / daysLeft : 0;

  let projHtml = "";
  if (cur) {
    const projected = projectMonthExpense();          // szokás + rendszeresség alapján
    const projBalance = carry + projectMonthIncome() - projected - savingAll + overdueNet + transferNet;
    projHtml = `<div class="banner ${projBalance < 0 ? "warn" : "info"}">${ic("calculator")}<div><b>Hó végi előrejelzés:</b> szokásaid és a rendszeres tételeid alapján kb. <b>${fmt(projected)}</b> lesz az összes kiadásod, így várhatóan <b>${fmt(projBalance)}</b> marad a hónap végén.</div></div>`;
  }

  const pendingBanner = pendingCount ? `<div class="banner info">${ic("calendar-clock")}<div><b>${pendingCount} tervezett tétel</b> ebben a hónapban – a hó végi egyenlegbe beleszámítanak, a statisztikába még nem. A Tételek fülön pipáld ki őket, amint megtörténtek.</div></div>` : "";
  const overdueBanner = overdue.length ? `<div class="banner warn">${ic("calendar-clock")}<div><b>${overdue.length} korábbról áthúzódó, kifizetetlen tétel</b> – az egyenlegbe már beleszámítanak. A Tételek fülön pipáld ki, amint ténylegesen megtörténtek.</div></div>` : "";

  // Költségkeretek állapota (csak a teljesített kiadások töltik)
  const budgetCats = state.cache.categories.filter(c => Number(c.budget) > 0);
  const spentByCat = {};
  txReal.filter(t => t.type === "expense").forEach(t => {
    spentByCat[t.category_id] = (spentByCat[t.category_id] || 0) + Number(t.amount);
  });
  const budgetRows = budgetCats.map(c => {
    const spent = spentByCat[c.id] || 0;
    const pct = Math.min(100, (spent / c.budget) * 100);
    const cls = spent > c.budget ? "over" : pct > 85 ? "warn" : "ok";
    const avg = categoryMonthlyAvg(c.id, state.month);
    const avgPct = avg > 0 ? Math.min(100, (avg / c.budget) * 100) : -1;
    return `<div class="budget-row">
      <div class="budget-row-head">
        <span class="budget-row-name"><span class="mini-ico" style="background:${c.color}22;color:${c.color}">${ic(c.icon)}</span><span>${esc(c.name)}</span></span>
        <span class="budget-row-vals"><b>${fmt(spent)}</b> / ${fmt(c.budget)}</span>
      </div>
      <div class="progress"><div class="progress-fill ${cls}" data-w="${pct}"></div>${avgPct >= 0 ? `<span class="avg-marker" style="left:${avgPct}%" title="Havi átlag: ${fmt(avg)}"></span>` : ""}</div>
    </div>`;
  }).join("");

  const recent = [...overdue, ...txAll].slice(0, 6).map(txItemHtml).join("");

  const goalsMini = state.cache.goals.filter(g => !g.done).slice(0, 3).map(g => {
    const saved = goalSaved(g);
    const pct = Math.min(100, (saved / g.target_amount) * 100);
    return `<div class="budget-row">
      <div class="budget-row-head">
        <span class="budget-row-name"><span class="mini-ico" style="background:var(--primary-soft);color:var(--primary)">${ic(g.icon || "target")}</span><span>${esc(g.name)}</span></span>
        <span class="budget-row-vals"><b>${fmt(saved)}</b> / ${fmt(g.target_amount)} · ${Math.round(pct)}%</span>
      </div>
      <div class="progress"><div class="progress-fill" data-w="${pct}"></div></div>
    </div>`;
  }).join("");

  const name = state.cache.profile?.name || state.user?.user_metadata?.name || "Vendég";
  const initial = (name.trim()[0] || "V").toUpperCase();

  el.innerHTML = `
    <div class="hero">
      <div class="hero-label">${ic("wallet")} Hó végén marad${state.account === "shared" ? " · közös" : ""}</div>
      <div class="hero-balance">${fmtHTML(balance)}</div>
      <div class="hero-subrow">
        <div class="hero-sub ${balance < 0 ? "neg" : ""}">${ic(cur ? "calendar-range" : "calendar")} ${cur ? `Napi keret: ${fmt(daily)}` : monthLabel(state.month)}</div>
        ${carry ? `<div class="hero-sub">${ic("history")} Előző hónapból: ${fmt(carry, { plus: true })}</div>` : ""}
      </div>
    </div>

    <div class="quick-actions">
      <button class="qa" data-qa="income"><span class="qa-ico">${ic("plus")}</span><span>Bevétel</span></button>
      <button class="qa" data-qa="expense"><span class="qa-ico">${ic("minus")}</span><span>Kiadás</span></button>
      <button class="qa" data-qa="goals"><span class="qa-ico">${ic("target")}</span><span>Célok</span></button>
      <button class="qa" data-qa="budget"><span class="qa-ico">${ic("wallet")}</span><span>Keretek</span></button>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-head"><span class="pill-ico green">${ic("trending-up")}</span> Bevétel</div>
        <div class="stat-value pos">${fmtHTML(incomePureR)}</div>
        ${plannedIncome ? `<div class="stat-sub">+ ${fmt(plannedIncome)} tervezett</div>` : ""}
        ${withdrawR ? `<div class="stat-sub" style="color:var(--teal)">+ ${fmt(withdrawR)} felhasznált megtakarítás</div>` : ""}
      </div>
      <div class="stat-card">
        <div class="stat-head"><span class="pill-ico red">${ic("trending-down")}</span> Kiadás</div>
        <div class="stat-value neg">${fmtHTML(expenseR)}</div>
        ${plannedExpense ? `<div class="stat-sub">+ ${fmt(plannedExpense)} tervezett</div>` : ""}
      </div>
      <div class="stat-card span2">
        <div class="stat-head"><span class="pill-ico blue">${ic("piggy-bank")}</span> Megtakarítás / félretett</div>
        <div class="stat-value blue">${fmtHTML(savingR)}</div>
        <div class="stat-sub">${plannedSaving ? `+ ${fmt(plannedSaving)} tervezett · ` : ""}${withdrawR ? `ebből felhasználva: ${fmt(withdrawR)} · ` : ""}nem számít a kiadásokba</div>
      </div>
    </div>

    ${overdueBanner}
    ${pendingBanner}
    ${projHtml}

    <div class="row-2">
      <div class="card">
        <div class="card-title">Költségkeretek <button class="btn-link" data-goto="budget">Szerkesztés ${ic("chevron-right")}</button></div>
        ${budgetRows ? `<p class="field-hint avg-legend">${ic("minus")} A vékony függőleges vonal a kategória korábbi havi átlagát jelzi.</p>` : ""}
        ${budgetRows || `<div class="empty-state"><div class="empty-ico">${ic("wallet")}</div><p>Még nincsenek költségkeretek.<br>Állítsd be a Költségvetés fülön!</p></div>`}
      </div>
      <div class="card">
        <div class="card-title">Utolsó tételek <button class="btn-link" data-goto="transactions">Összes ${ic("chevron-right")}</button></div>
        ${recent || `<div class="empty-state"><div class="empty-ico">${ic("receipt-text")}</div><p>Még nincs tétel ebben a hónapban.<br>Nyomd meg a + gombot!</p></div>`}
      </div>
    </div>
    ${goalsMini ? `<div class="card"><div class="card-title">Céljaid <button class="btn-link" data-goto="goals">Összes ${ic("chevron-right")}</button></div>${goalsMini}</div>` : ""}
  `;
  el.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => switchView(b.dataset.goto));
  el.querySelectorAll("[data-qa]").forEach(b => b.onclick = () => {
    const a = b.dataset.qa;
    if (a === "income" || a === "expense") openTxModal(null, { type: a });
    else switchView(a);
  });
  animateBars(el);
  bindTxItems(el);
}

function txItemHtml(t) {
  const cat = catById(t.category_id);
  const goal = t.goal_id ? goalById(t.goal_id) : null;
  const pending = isPending(t);
  const withdraw = isWithdraw(t);
  const transfer = isTransfer(t);
  const transferIn = transfer && t.transfer_dir === "in";
  let iconN, color, tint;
  if (transfer) { iconN = "arrow-left-right"; color = "var(--primary)"; tint = "var(--primary-soft)"; }
  else if (withdraw) { iconN = "piggy-bank"; color = "var(--teal)"; tint = "var(--surface-2)"; }
  else if (t.type === "income") { iconN = "arrow-down-left"; color = "var(--green)"; tint = "var(--green-soft)"; }
  else if (t.type === "saving") { iconN = goal?.icon || "piggy-bank"; color = "var(--primary)"; tint = "var(--primary-soft)"; }
  else { iconN = cat?.icon || "package"; color = cat?.color || "var(--text-muted)"; tint = cat?.color ? cat.color + "22" : "var(--surface-2)"; }
  const peerName = transfer ? (t.transfer_peer_name || accountName(t.transfer_peer_id)) : "";
  const sub = transfer ? (transferIn ? `Átvezetés ← ${esc(peerName)}` : `Átvezetés → ${esc(peerName)}`)
    : withdraw ? "Felhasznált megtakarítás"
    : t.type === "income" ? "Bevétel"
    : t.type === "saving" ? `Megtakarítás${goal ? " → " + esc(goal.name) : ""}`
    : esc(cat?.name || "Egyéb");
  const amtHtml = transfer
    ? (transferIn ? fmtHTML(t.amount, { plus: true }) : fmtHTML(-Math.abs(Number(t.amount))))
    : t.type === "income" ? fmtHTML(t.amount, { plus: true }) : fmtHTML(-Math.abs(Number(t.amount)));
  const badge = pending ? `<span class="tx-badge">${ic("clock")} tervezett</span>`
    : transfer ? `<span class="tx-badge">${ic("arrow-left-right")} átvezetés</span>` : "";
  const completeBtn = pending ? `<button class="tx-complete" data-complete="${t.id}" title="Megjelölés teljesítettként">${ic("check")}</button>` : "";
  return `<div class="tx-item ${pending ? "pending" : ""}" data-txid="${t.id}">
    <div class="tx-ico" style="background:${tint};color:${color}">${ic(iconN)}</div>
    <div class="tx-info"><div class="tx-name">${esc(t.note) || (transfer ? "Átvezetés" : sub)}</div><div class="tx-cat">${sub}${t.recurring_id ? ic("repeat") : ""}${badge}</div></div>
    ${completeBtn}
    <div class="tx-amount ${transfer ? "transfer" : t.type}">${amtHtml}</div>
  </div>`;
}

// Közös eseménykötő a tételsorokhoz: kattintásra szerkesztés, ✓-re teljesítettnek jelölés
function bindTxItems(scope) {
  scope.querySelectorAll("[data-complete]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    await state.store.update("transactions", b.dataset.complete, { pending: false });
    await refreshCache(); renderView(); toast("Tétel teljesítve", "check");
  });
  scope.querySelectorAll("[data-txid]").forEach(item => item.onclick = () => {
    const t = state.cache.transactions.find(x => x.id === item.dataset.txid);
    if (t) openTxModal(t);
  });
}

// ============ TRANZAKCIÓK ============
function renderTransactions(el) {
  const tx = monthScopeTx();
  let filterCat = "all", filterType = "all", search = "";

  function listHtml() {
    let list = tx;
    if (filterType !== "all") list = list.filter(t => t.type === filterType);
    if (filterCat !== "all") list = list.filter(t => t.category_id === filterCat);
    if (search) list = list.filter(t => (t.note || "").toLowerCase().includes(search.toLowerCase()));
    if (!list.length) return `<div class="empty-state"><div class="empty-ico">${ic("search-x")}</div><p>Nincs találat ebben a hónapban.</p></div>`;
    // Korábbról áthúzódó (kifizetetlen) tételek külön, felül; utána a hónap napjai szerint csoportosítva
    const monthStart = `${state.month.getFullYear()}-${String(state.month.getMonth() + 1).padStart(2, "0")}-01`;
    const overdueList = list.filter(t => (t.date || "") < monthStart);
    const inMonthList = list.filter(t => (t.date || "") >= monthStart);
    let out = "";
    if (overdueList.length) {
      out += `<div class="tx-group-date overdue">${ic("calendar-clock")} Korábbról áthúzódó · kifizetetlen</div>` +
        overdueList.sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(txItemHtml).join("");
    }
    const groups = {};
    inMonthList.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
    out += Object.keys(groups).sort().reverse().map(date => {
      const d = new Date(date + "T00:00:00");
      const label = `${d.getMonth() + 1 + ". " + d.getDate()}. (${DAYS_HU[d.getDay()]})`;
      const dayTotal = groups[date].filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
      return `<div class="tx-group-date">${label}${dayTotal ? ` · −${fmt(dayTotal)}` : ""}</div>` +
        groups[date].map(txItemHtml).join("");
    }).join("");
    return out;
  }

  const catOptions = state.cache.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  el.innerHTML = `
    <div class="section-title">Tranzakciók</div>
    <div class="filter-bar">
      <div class="input-wrap">${ic("search")}<input type="search" id="tx-search" placeholder="Keresés a tételek közt..."></div>
      <select id="tx-filter-type">
        <option value="all">Minden típus</option>
        <option value="expense">Kiadás</option>
        <option value="income">Bevétel</option>
        <option value="saving">Megtakarítás</option>
        <option value="transfer">Átvezetés</option>
      </select>
      <select id="tx-filter-cat"><option value="all">Minden kategória</option>${catOptions}</select>
    </div>
    <div id="tx-list">${listHtml()}</div>
  `;
  const rerender = () => {
    $("#tx-list").innerHTML = listHtml();
    bindTxItems(el);
  };
  $("#tx-search").oninput = (e) => { search = e.target.value; rerender(); };
  $("#tx-filter-type").onchange = (e) => { filterType = e.target.value; rerender(); };
  $("#tx-filter-cat").onchange = (e) => { filterCat = e.target.value; rerender(); };
  bindTxItems(el);
}

// ============ KÖLTSÉGVETÉS ============
function renderBudget(el) {
  const tx = txOfMonth();
  const income = sumBy(tx, "income");
  const allocated = state.cache.categories.reduce((s, c) => s + Number(c.budget || 0), 0);
  const free = income - allocated;
  const transfersOut = tx.filter(t => isTransfer(t) && t.transfer_dir === "out").reduce((s, t) => s + Number(t.amount || 0), 0);
  const transfersIn = tx.filter(t => isTransfer(t) && t.transfer_dir === "in").reduce((s, t) => s + Number(t.amount || 0), 0);

  const catRows = state.cache.categories.map(c => `
    <div class="list-edit-row" data-catid="${c.id}">
      <span class="lab"><span class="mini-ico" style="background:${c.color}22;color:${c.color}">${ic(c.icon)}</span><span class="lab-txt"><div>${esc(c.name)}</div></span></span>
      <input class="inline-amount" type="text" inputmode="numeric" value="${c.budget ? baseToDisplay(c.budget) : ""}" placeholder="0" data-budget="${c.id}">
      <button class="icon-btn" data-delcat="${c.id}" title="Törlés">${ic("trash-2")}</button>
    </div>`).join("");

  const recRows = state.cache.recurring.map(r => {
    const cat = catById(r.category_id);
    const rico = r.type === "income" ? "arrow-down-left" : (cat?.icon || "package");
    const rcolor = r.type === "income" ? "var(--green)" : (cat?.color || "var(--text-muted)");
    const rtint = r.type === "income" ? "var(--green-soft)" : (cat?.color ? cat.color + "22" : "var(--surface-2)");
    const paused = r.active === false;
    return `<div class="list-edit-row ${paused ? "paused" : ""}">
      <span class="lab"><span class="mini-ico" style="background:${rtint};color:${rcolor}">${ic(rico)}</span>
        <span class="lab-txt"><div>${esc(r.name)}</div><small style="color:var(--text-muted);font-weight:400">${freqText(r)} · ${r.type === "income" ? "bevétel" : "kiadás"}${paused ? " · szünetel" : ""}${(r.auto_post === false || r.auto_post === "false") ? " · kézi pipálás" : ""}</small></span></span>
      <b style="font-size:14px;white-space:nowrap">${fmt(r.amount)}</b>
      <button class="icon-btn neutral" data-pauserec="${r.id}" data-on="${paused ? "0" : "1"}" title="${paused ? "Folytatás" : "Szüneteltetés"}">${ic(paused ? "play" : "pause")}</button>
      <button class="icon-btn" data-delrec="${r.id}" title="Törlés">${ic("trash-2")}</button>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-title">Költségvetés</div>
    <div class="banner ${free < 0 ? "warn" : "info"}">${ic(free < 0 ? "triangle-alert" : "info")}
      <div>Havi bevétel: <b>${fmt(income)}</b> · Keretekre szétosztva: <b>${fmt(allocated)}</b> ·
      ${free >= 0 ? `Szabadon maradt: <b>${fmt(free)}</b>` : `<b>Túltervezés: ${fmt(-free)}</b> – csökkentsd a kereteket!`}</div>
    </div>
    ${(transfersIn || transfersOut) ? `<div class="banner info">${ic("arrow-left-right")}<div>Számlák közötti átvezetés ebben a hónapban: ${transfersIn ? `<b style="color:var(--green)">+${fmt(transfersIn)}</b> be` : ""}${transfersIn && transfersOut ? " · " : ""}${transfersOut ? `<b>−${fmt(transfersOut)}</b> ki` : ""}. Ez <b>nem</b> bevétel és <b>nem</b> kiadás – csak az egyenleget mozgatja.</div></div>` : ""}
    <div class="card">
      <div class="card-title">Havi keretek kategóriánként
        <button class="btn-link" id="btn-add-cat">${ic("plus")} Kategória</button></div>
      <p class="field-hint" style="margin-bottom:10px">Írd be, mennyit szánsz az adott kategóriára havonta. Tipp: „15k" = 15 000.</p>
      ${catRows}
      <button class="btn btn-primary btn-block" id="btn-save-budgets" style="margin-top:16px">Keretek mentése</button>
    </div>
    <div class="card">
      <div class="card-title">Ismétlődő tételek
        <button class="btn-link" id="btn-add-rec">${ic("plus")} Ismétlődő</button></div>
      <p class="field-hint" style="margin-bottom:10px">Pl. fizetés, albérlet, előfizetések – a beállított gyakorisággal (naponta, hetente, havonta, évente, akár „3 hetente") automatikusan könyvelődnek.</p>
      ${recRows || `<div class="empty-state"><div class="empty-ico">${ic("repeat")}</div><p>Még nincs ismétlődő tétel.<br>Add hozzá a fizetésed és a fix kiadásaid!</p></div>`}
    </div>
  `;

  $("#btn-save-budgets").onclick = async () => {
    for (const input of el.querySelectorAll("[data-budget]")) {
      const val = input.value.trim() === "" ? 0 : parseAmountToBase(input.value);
      if (isNaN(val)) continue;
      const cat = catById(input.dataset.budget);
      if (cat && Number(cat.budget || 0) !== val) await state.store.update("categories", cat.id, { budget: val });
    }
    await refreshCache();
    renderView();
    toast("Költségkeretek mentve", "check");
  };
  $("#btn-add-cat").onclick = () => openCategoryModal();
  el.querySelectorAll("[data-pauserec]").forEach(b => b.onclick = async () => {
    const on = b.dataset.on === "1";
    await state.store.update("recurring", b.dataset.pauserec, { active: !on });
    await refreshCache(); renderView(); toast(on ? "Ismétlődés szüneteltetve" : "Ismétlődés folytatva", "check");
  });
  el.querySelectorAll("[data-delcat]").forEach(b => b.onclick = async () => {
    if (!(await askConfirm({ title: "Kategória törlése", message: "Biztosan törlöd a kategóriát? A tételei 'Egyéb' nélkül maradnak.", okText: "Törlés", danger: true }))) return;
    await state.store.remove("categories", b.dataset.delcat);
    await refreshCache(); renderView(); toast("Kategória törölve");
  });
  $("#btn-add-rec").onclick = () => openRecurringModal();
  el.querySelectorAll("[data-delrec]").forEach(b => b.onclick = async () => {
    if (!(await askConfirm({ title: "Ismétlődő tétel törlése", message: "Törlöd az ismétlődő tételt? (A már könyvelt tételek megmaradnak.)", okText: "Törlés", danger: true }))) return;
    await state.store.remove("recurring", b.dataset.delrec);
    await refreshCache(); renderView(); toast("Ismétlődő tétel törölve");
  });
}

// ============ CÉLOK ============
function goalCardHtml(g) {
  const isShared = !!g.household_id;
  const saved = goalSaved(g);
  const used = goalUsed(g);
  const available = Math.max(0, saved - used);
  const pct = Math.min(100, (saved / g.target_amount) * 100);
  const usedPct = Math.max(0, Math.min(pct, (used / g.target_amount) * 100));
  const availPct = Math.max(0, pct - usedPct);
  const remaining = Math.max(0, g.target_amount - saved);
  let monthlyHtml = "";
  if (g.deadline && remaining > 0) {
    const now = new Date(); const dl = new Date(g.deadline);
    const months = Math.max(1, (dl.getFullYear() - now.getFullYear()) * 12 + (dl.getMonth() - now.getMonth()));
    monthlyHtml = `<div class="goal-monthly">${ic("calendar-check")}<div>Havi <b>${fmt(remaining / months)}</b> félretételével eléred ${dl.getFullYear()}. ${MONTHS_HU[dl.getMonth()]}ig (${months} hónap)</div></div>`;
  } else if (remaining === 0) {
    monthlyHtml = `<div class="goal-monthly done">${ic("party-popper")}<div>Cél elérve! Gratulálunk!</div></div>`;
  }
  const dlText = g.deadline ? `Határidő: ${g.deadline.slice(0, 10).replaceAll("-", ". ")}.` : "Nincs határidő";
  // Közös cél: ki mennyit tett be
  let contribHtml = "";
  if (isShared) {
    const byUser = {};
    (state.cache.contributions || []).filter(c => c.goal_id === g.id).forEach(c => { const n = c.display_name || "Társ"; byUser[n] = (byUser[n] || 0) + Number(c.amount); });
    const parts = Object.entries(byUser).map(([n, a]) => `${esc(n)}: <b>${fmt(a)}</b>`).join(" · ");
    if (parts) contribHtml = `<div class="goal-monthly" style="background:var(--surface-2);color:var(--text-muted)">${ic("users")}<div>${parts}</div></div>`;
  }
  const done = !!g.done;
  const sharedBadge = isShared ? `<span class="tx-badge" style="color:var(--primary);border-color:var(--primary)">${ic("users")} közös</span>` : "";
  const doneBadge = done ? `<span class="tx-badge" style="color:var(--green);border-color:var(--green)">${ic("check")} megvalósítva</span>` : "";
  return `<div class="goal-card ${done ? "done" : ""}">
    <div class="goal-head">
      <div class="goal-ico">${ic(g.icon || "target")}</div>
      <div style="flex:1;min-width:0"><div class="goal-name">${esc(g.name)} ${sharedBadge}${doneBadge}</div><div class="goal-deadline">${dlText}</div></div>
      ${isShared || done ? "" : `<button class="icon-btn edit" data-editgoal="${g.id}" title="Szerkesztés">${ic("pencil")}</button>`}
      <button class="icon-btn" data-delgoal="${g.id}" title="Törlés">${ic("trash-2")}</button>
    </div>
    <div class="goal-amounts"><span>Összegyűjtve: <b>${fmt(saved)}</b></span><span>Cél: <b>${fmt(g.target_amount)}</b></span></div>
    <div class="progress goal-progress" style="height:10px"><div class="progress-fill used" data-w="${usedPct}"></div><div class="progress-fill avail" data-w="${availPct}"></div></div>
    <div class="goal-amounts"><span>${Math.round(pct)}%</span><span>Még hiányzik: ${fmt(remaining)}</span></div>
    ${used > 0 ? `<div class="goal-amounts"><span style="color:var(--green)">${ic("hand-coins")} Felhasználva: <b>${fmt(used)}</b></span><span>Elérhető: <b>${fmt(available)}</b></span></div>` : ""}
    ${monthlyHtml}
    ${contribHtml}
    ${done
      ? `<div class="goal-monthly done" style="margin-top:13px">${ic("circle-check")}<div>Megvalósítva – az összegyűjtött <b>${fmt(saved)}</b> a bevételekhez került.</div></div>`
      : `<div class="goal-actions">
          <button class="btn btn-ghost btn-sm" data-deposit="${g.id}" style="flex:1">${ic("piggy-bank")} Félreteszek rá</button>
          ${available > 0 ? `<button class="btn btn-primary btn-sm" data-usegoal="${g.id}" style="flex:1">${ic("hand-coins")} Felhasználás</button>` : ""}
        </div>`}
  </div>`;
}

function renderGoals(el) {
  const hh = state.household;
  const showShared = hh && state.account === "self";   // közös szekciók csak saját nézetben (közös nézetben a fő lista MÁR a közös)
  const personalCards = state.cache.goals.map(goalCardHtml).join("");
  const sharedCards = (state.cache.sharedGoals || []).map(goalCardHtml).join("");

  // Közös kassza kártya (közös kiadások e hónapban) – csak saját nézetben
  let kasszaHtml = "";
  if (showShared) {
    const stx = (state.cache.sharedTx || []).filter(t => (t.date || "").startsWith(monthKey(state.month)) && t.type === "expense");
    const total = stx.reduce((s, t) => s + Number(t.amount), 0);
    const list = stx.slice(0, 6).map(t => {
      const c = catById(t.category_id); const color = c?.color || "#64748b";
      const who = (hh.members || []).find(m => m.user_id === t.user_id)?.display_name || "";
      return `<div class="tx-item"><div class="tx-ico" style="background:${color}22;color:${color}">${ic(c?.icon || "package")}</div>
        <div class="tx-info"><div class="tx-name">${esc(t.note) || esc(c?.name || "Közös kiadás")}</div><div class="tx-cat">${esc(c?.name || "Egyéb")}${who ? " · " + esc(who) : ""}</div></div>
        <div class="tx-amount">${fmtHTML(-Math.abs(Number(t.amount)))}</div></div>`;
    }).join("");
    const memberNames = (hh.members || []).map(m => esc(m.display_name || "Társ")).join(", ");
    kasszaHtml = `<div class="card">
      <div class="card-title">${ic("wallet")} Közös kassza <button class="btn-link" id="btn-add-shared-exp">${ic("plus")} Közös kiadás</button></div>
      <div class="banner info">${ic("users")}<div>Tagok: <b>${memberNames || "csak te"}</b> · E havi közös kiadás: <b>${fmt(total)}</b></div></div>
      ${list || `<div class="empty-state"><div class="empty-ico">${ic("receipt-text")}</div><p>Még nincs közös kiadás ebben a hónapban.</p></div>`}
    </div>`;
  }

  el.innerHTML = `
    <div class="section-title">Célok${state.account === "shared" ? " · közös" : ""}</div>
    ${kasszaHtml}
    ${showShared && sharedCards ? `<div class="card-title" style="margin:6px 2px 8px">Közös célok</div>${sharedCards}` : ""}
    ${showShared ? `<div class="card-title" style="margin:16px 2px 8px">Saját célok</div>` : ""}
    ${personalCards || `<div class="empty-state"><div class="empty-ico">${ic("target")}</div><p>Még nincs célod.<br>Mire gyűjtenél? Nyaralás, autó, vésztartalék?</p></div>`}
    <button class="btn btn-primary btn-block" id="btn-add-goal">${ic("plus")} Új cél hozzáadása</button>
  `;
  animateBars(el);
  $("#btn-add-goal").onclick = () => openGoalModal();
  const sExp = $("#btn-add-shared-exp"); if (sExp) sExp.onclick = () => openTxModal(null, { type: "expense", shared: true });
  el.querySelectorAll("[data-editgoal]").forEach(b => b.onclick = () => openGoalModal(goalById(b.dataset.editgoal)));
  el.querySelectorAll("[data-delgoal]").forEach(b => b.onclick = async () => {
    if (!(await askConfirm({ title: "Cél törlése", message: "Biztosan törlöd a célt?", okText: "Törlés", danger: true }))) return;
    await state.store.remove("goals", b.dataset.delgoal);
    await refreshCache(); renderView(); toast("Cél törölve");
  });
  el.querySelectorAll("[data-deposit]").forEach(b => b.onclick = () => {
    openTxModal(null, { type: "saving", goal_id: b.dataset.deposit });
  });
  el.querySelectorAll("[data-usegoal]").forEach(b => b.onclick = async () => {
    const g = goalById(b.dataset.usegoal); if (!g) return;
    const avail = goalAvailable(g);
    if (avail <= 0) { toast("Nincs elérhető megtakarítás ezen a célon"); return; }
    const raw = await askText({ title: `Felhasználás – ${g.name}`, label: `Mennyit használsz fel? (elérhető: ${fmt(avail, { force: true })})`, placeholder: "Pl. 60k", okText: "Felhasználás", inputmode: "decimal" });
    if (raw == null || raw === "") return;
    const amount = parseAmountToBase(raw);
    if (isNaN(amount) || amount <= 0) { toast("Adj meg érvényes összeget!"); return; }
    if (amount > avail + 0.5) { toast("Nem használhatsz fel az elérhetőnél többet"); return; }
    // Cél-felhasználás könyvelése (from_savings, a célhoz kötve) – a cél NEM zárul le, tovább gyűjthető
    const prev = state.store.ctxHousehold;
    if (g.household_id && state.store.setCtx) state.store.setCtx(g.household_id);
    try {
      await state.store.insert("transactions", { type: "income", from_savings: true, goal_id: g.id, amount, note: g.name + " (cél felhasználva)", date: todayStr(), pending: false });
    } finally {
      if (g.household_id && state.store.setCtx) state.store.setCtx(prev || null);
    }
    await refreshCache(); renderView();
    toast("Felhasználva a megtakarításból", "check");
  });
}

// Időszak-adatok az egyedi oszlopdiagramhoz (Napi / Heti / Havi)
// Az ablak a `anchor` hónaphoz van rögzítve: a jobb szélső oszlop mindig az aktuális (anchor) hónap/nap/hét.
function periodData(mode, anchor = state.month) {
  const expSum = (list) => list.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  let bars = [];
  if (mode === "day") {
    const base = isCurrentMonth(anchor) ? today0() : new Date(anchor.getFullYear(), anchor.getMonth(), daysInMonth(anchor));
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base); d.setDate(base.getDate() - i); const ds = isoDate(d);
      bars.push({ label: DAYS_HU[d.getDay()].slice(0, 2), value: expSum(realized(state.cache.transactions.filter(t => t.date === ds))), ds });
    }
  } else if (mode === "week") {
    const dim = daysInMonth(anchor);
    const weeks = {};
    realizedOfMonth(anchor).filter(t => t.type === "expense").forEach(t => { const w = Math.floor((parseInt(t.date.slice(8, 10), 10) - 1) / 7); weeks[w] = (weeks[w] || 0) + Number(t.amount); });
    for (let w = 0; w < Math.ceil(dim / 7); w++) bars.push({ label: (w + 1) + ".", value: weeks[w] || 0, wk: w });
  } else {
    for (let i = 5; i >= 0; i--) { const mo = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1); bars.push({ label: MONTHS_HU[mo.getMonth()].slice(0, 3), value: expSum(realizedOfMonth(mo)), m: mo }); }
  }
  const max = Math.max(1, ...bars.map(b => b.value));
  return { bars, max, total: bars.reduce((s, b) => s + b.value, 0) };
}
// Egy oszlop (időszak) kiadásai kategóriánként
function barCatExpenses(mode, bar, anchor = state.month) {
  let list;
  if (mode === "day") list = realized(state.cache.transactions.filter(t => t.date === bar.ds));
  else if (mode === "week") list = realizedOfMonth(anchor).filter(t => Math.floor((parseInt(t.date.slice(8, 10), 10) - 1) / 7) === bar.wk);
  else list = realizedOfMonth(bar.m);
  const out = {};
  list.filter(t => t.type === "expense").forEach(t => { const id = t.category_id || "_"; out[id] = (out[id] || 0) + Number(t.amount); });
  return out;
}
function barTitle(mode, bar, anchor = state.month) {
  if (mode === "day") { const d = new Date(bar.ds + "T00:00:00"); return `${d.getMonth() + 1}. ${d.getDate()}. (${DAYS_HU[d.getDay()]})`; }
  if (mode === "week") return `${monthLabel(anchor)} · ${bar.wk + 1}. hét`;
  return monthLabel(bar.m);
}

// ============ STATISZTIKÁK ============
function renderStats(el) {
  const tx = realizedOfMonth();   // statisztika: csak teljesített tételek (pending kizárva)
  const expenses = tx.filter(t => t.type === "expense");
  const prevMonth = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  const C = themeColors();
  const pmode = state.statsPeriod || "day";   // megőrzött időszak-nézet

  // Kategória-bontás aktuális + előző hónap (trendhez)
  const byCat = {};
  expenses.forEach(t => { const id = t.category_id || "_"; byCat[id] = (byCat[id] || 0) + Number(t.amount); });
  const catSorted = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const totalExp = sumBy(tx, "expense");

  el.innerHTML = `
    <div class="section-title">Statisztika</div>
    <div class="card" id="period-card">
      <div class="segment" id="period-seg">
        <button data-pm="day" class="${pmode === "day" ? "active" : ""}">Napi</button>
        <button data-pm="week" class="${pmode === "week" ? "active" : ""}">Heti</button>
        <button data-pm="month" class="${pmode === "month" ? "active" : ""}">Havi</button>
      </div>
      <div class="chart-total"><div class="amt" id="period-total"></div><div class="lbl" id="period-lbl">összes kiadás az időszakban</div></div>
      <div class="barchart" id="period-bars"></div>
      <div class="chart-hint" id="period-hint"></div>
    </div>

    <div class="card">
      <div class="card-title">Kiadások kategóriánként <span id="cat-breakdown-title" style="color:var(--text-muted);font-weight:600"></span></div>
      <div id="cat-breakdown"></div>
    </div>

    <div class="card"><div class="card-title">Bevétel vs. kiadás <span style="color:var(--text-muted);font-weight:600">utolsó 6 hónap</span></div>
      <div class="chart-box"><canvas id="chart-bar"></canvas></div></div>
    <div class="card"><div class="card-title">Kategóriák havi összehasonlítása <span style="color:var(--text-muted);font-weight:600">utolsó 6 hónap</span></div>
      <p class="field-hint" style="margin:-6px 0 12px">Havonta, kategóriánként mennyit költöttél (egymásra rakva).</p>
      <div class="chart-box" style="height:270px"><canvas id="chart-catcompare"></canvas></div></div>
    <div class="card"><div class="card-title">Halmozott napi költés <span style="color:var(--text-muted);font-weight:600">e havi vs. előző havi</span></div>
      <div class="chart-box" style="height:210px"><canvas id="chart-line"></canvas></div></div>

    <div class="row-2">
      <div class="card"><div class="card-title">Átlagok</div><div id="stats-avgs"></div></div>
      <div class="card"><div class="card-title">Top 5 kiadás</div><div id="stats-top"></div></div>
    </div>
  `;

  // --- Egyedi időszak-oszlopdiagram (váltható + oszlopra kattintható, ablak rögzített) ---
  function fillBreakdown(mode, bars, sel) {
    const curC = barCatExpenses(mode, bars[sel]);
    const prevC = sel > 0 ? barCatExpenses(mode, bars[sel - 1]) : {};
    const total = Object.values(curC).reduce((a, b) => a + b, 0);
    const ids = Object.keys(curC).sort((a, b) => curC[b] - curC[a]);
    $("#cat-breakdown-title").textContent = barTitle(mode, bars[sel]);
    $("#cat-breakdown").innerHTML = ids.length ? ids.map(id => {
      const c = catById(id); const sum = curC[id], prev = prevC[id] || 0;
      let trend = "";
      if (prev > 0) { const p = Math.round((sum - prev) / prev * 100); trend = `<span class="trend ${p > 0 ? "down" : "up"}">${ic(p > 0 ? "trending-up" : "trending-down")} ${p > 0 ? "+" : ""}${p}%</span>`; }
      else if (sum > 0 && sel > 0) trend = `<span class="trend down">${ic("trending-up")} új</span>`;
      const color = c?.color || "#64748b";
      return `<div class="catrow">
        <div class="tx-ico" style="background:${color}22;color:${color}">${ic(c?.icon || "package")}</div>
        <div class="catrow-info"><div class="catrow-name">${esc(c?.name || "Egyéb")}</div><div class="catrow-total">${fmt(sum)} · ${total ? Math.round(sum / total * 100) : 0}%</div></div>
        ${trend}
      </div>`;
    }).join("") : `<div class="empty-state"><div class="empty-ico">${ic("chart-pie")}</div><p>Nincs kiadás ebben az időszakban.</p></div>`;
    drawIcons();
  }
  function renderPeriod(selIdx) {
    const mode = state.statsPeriod || "day";
    const d = periodData(mode, state.month);
    // alapból a jobb szélső (= aktuális) oszlop kiválasztva; kattintásra csak a kiválasztás vált, az ablak marad
    const sel = (selIdx != null && selIdx >= 0 && selIdx < d.bars.length) ? selIdx : d.bars.length - 1;
    $("#period-total").innerHTML = fmtHTML(d.bars[sel] ? d.bars[sel].value : 0);
    $("#period-lbl").textContent = "kiadás – " + (d.bars[sel] ? barTitle(mode, d.bars[sel]) : "");
    $("#period-hint").textContent = "Koppints egy oszlopra a részletekért";
    $("#period-bars").innerHTML = d.bars.map((b, i) => `
      <div class="bar-col ${i === sel ? "active" : ""}" data-idx="${i}" title="${esc(b.label)}: ${fmt(b.value)}">
        <div class="bar-track"><div class="bar-fill" data-h="${d.max ? Math.round(b.value / d.max * 100) : 0}"></div></div>
        <div class="bar-label">${esc(b.label)}</div>
      </div>`).join("");
    $("#period-bars").querySelectorAll(".bar-col").forEach(col => col.onclick = () => renderPeriod(Number(col.dataset.idx)));
    fillBreakdown(mode, d.bars, sel);
    animateBars($("#period-card"));
  }
  $("#period-seg").querySelectorAll("button").forEach(b => b.onclick = () => {
    state.statsPeriod = b.dataset.pm;
    $("#period-seg").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    renderPeriod();
  });
  renderPeriod();

  // --- 6 havi oszlopdiagram (Chart.js, témázott) ---
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(state.month.getFullYear(), state.month.getMonth() - i, 1));
  const incomeData = months.map(m => realizedOfMonth(m).filter(t => t.type === "income" && !isWithdraw(t)).reduce((s, t) => s + Number(t.amount), 0));
  const withdrawData = months.map(m => realizedOfMonth(m).filter(isWithdraw).reduce((s, t) => s + Number(t.amount), 0));
  const expenseData = months.map(m => sumBy(realizedOfMonth(m), "expense"));
  const hasWithdraw = withdrawData.some(v => v > 0);
  const barSets = [
    { label: "Bevétel", data: incomeData, backgroundColor: C.green, stack: "in", borderRadius: 6, maxBarThickness: 30 },
  ];
  if (hasWithdraw) barSets.push({ label: "Felhasznált megtakarítás", data: withdrawData, backgroundColor: C.teal, stack: "in", borderRadius: 6, maxBarThickness: 30 });
  barSets.push({ label: "Kiadás", data: expenseData, backgroundColor: C.primary, stack: "out", borderRadius: 6, maxBarThickness: 30 });
  state.charts.bar = new Chart($("#chart-bar"), {
    type: "bar",
    data: { labels: months.map(m => MONTHS_HU[m.getMonth()].slice(0, 3)), datasets: barSets },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, color: C.muted, font: { family: "Inter", size: 11 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { color: C.muted } }, y: { stacked: true, grid: { color: C.grid }, ticks: { color: C.muted, callback: (v) => (v / 1000) + "k" } } } },
  });

  // --- Kategóriák havi összehasonlítása (stacked) ---
  const monthExp = months.map(m => realizedOfMonth(m).filter(t => t.type === "expense"));
  const catTotals = {};
  monthExp.forEach(list => list.forEach(t => { const id = t.category_id || "_"; catTotals[id] = (catTotals[id] || 0) + Number(t.amount); }));
  const topCatIds = Object.keys(catTotals).filter(id => catTotals[id] > 0).sort((a, b) => catTotals[b] - catTotals[a]).slice(0, 8);
  if (topCatIds.length) {
    const catDatasets = topCatIds.map(id => {
      const c = catById(id);
      return { label: c?.name || "Egyéb", backgroundColor: c?.color || "#64748b",
        data: monthExp.map(list => list.filter(t => (t.category_id || "_") === id).reduce((s, t) => s + Number(t.amount), 0)),
        borderRadius: 4, maxBarThickness: 30 };
    });
    state.charts.catcompare = new Chart($("#chart-catcompare"), {
      type: "bar",
      data: { labels: months.map(m => MONTHS_HU[m.getMonth()].slice(0, 3)), datasets: catDatasets },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, color: C.muted, font: { family: "Inter", size: 11 } } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { color: C.muted } }, y: { stacked: true, grid: { color: C.grid }, ticks: { color: C.muted, callback: (v) => (v / 1000) + "k" } } } },
    });
  } else {
    $("#chart-catcompare").closest(".chart-box").innerHTML = `<div class="empty-state"><div class="empty-ico">${ic("chart-column")}</div><p>Nincs elég adat az összehasonlításhoz.</p></div>`;
  }

  // --- Halmozott vonal ---
  const cumul = (m) => { const dim = daysInMonth(m); const daily = new Array(dim).fill(0); realizedOfMonth(m).filter(t => t.type === "expense").forEach(t => { const day = parseInt(t.date.slice(8, 10), 10); if (day >= 1 && day <= dim) daily[day - 1] += Number(t.amount); }); let run = 0; return daily.map(v => (run += v)); };
  const curC = cumul(state.month), prevC = cumul(prevMonth);
  const maxDays = Math.max(curC.length, prevC.length);
  const isCur = isCurrentMonth(state.month);
  let curTrim = curC; if (isCur) curTrim = curC.slice(0, new Date().getDate());
  const lineSets = [
    { label: monthLabel(state.month), data: curTrim, borderColor: C.primary, backgroundColor: "transparent", fill: false, tension: .35, pointRadius: 0, borderWidth: 2.5 },
  ];
  if (isCur) lineSets.push({ label: "Előrejelzés (hó vége)", data: projectedCumulative(state.month), borderColor: C.primary, borderDash: [5, 5], backgroundColor: "transparent", fill: false, tension: .35, pointRadius: 0, borderWidth: 2 });
  lineSets.push({ label: monthLabel(prevMonth), data: prevC, borderColor: C.muted, borderDash: [2, 4], fill: false, tension: .35, pointRadius: 0, borderWidth: 1.5 });
  state.charts.line = new Chart($("#chart-line"), {
    type: "line",
    data: { labels: Array.from({ length: maxDays }, (_, i) => i + 1), datasets: lineSets },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, color: C.muted, font: { family: "Inter", size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: C.muted, maxTicksLimit: 8 } }, y: { grid: { color: C.grid }, ticks: { color: C.muted, callback: (v) => (v / 1000) + "k" } } },
      interaction: { mode: "index", intersect: false } },
  });

  // --- Átlagok ---
  const last3 = [0, 1, 2].map(i => sumBy(realizedOfMonth(new Date(state.month.getFullYear(), state.month.getMonth() - i, 1)), "expense"));
  const avg3 = last3.reduce((a, b) => a + b, 0) / 3;
  const avg6 = expenseData.reduce((a, b) => a + b, 0) / 6;
  const dayCount = isCurrentMonth(state.month) ? new Date().getDate() : daysInMonth(state.month);
  const avgDaily = dayCount ? totalExp / dayCount : 0;
  const topCat = catSorted.length ? catById(catSorted[0]) : null;
  const savingRate = sumBy(tx, "income") > 0 ? Math.round(sumBy(tx, "saving") / sumBy(tx, "income") * 100) : 0;
  $("#stats-avgs").innerHTML = `
    <div class="avg-row"><span>Átlagos napi költés</span><b>${fmt(avgDaily)}</b></div>
    <div class="avg-row"><span>3 havi átlag</span><b>${fmt(avg3)}</b></div>
    <div class="avg-row"><span>6 havi átlag</span><b>${fmt(avg6)}</b></div>
    <div class="avg-row"><span>Legtöbbet erre</span><b>${esc(topCat?.name || "–")}</b></div>
    <div class="avg-row"><span>Megtakarítási ráta</span><b>${savingRate}%</b></div>
    <div class="avg-row"><span>Tételek száma</span><b>${tx.length} db</b></div>
  `;

  const top5 = [...expenses].sort((a, b) => b.amount - a.amount).slice(0, 5);
  $("#stats-top").innerHTML = top5.length ? top5.map(txItemHtml).join("") : `<div class="empty-state"><div class="empty-ico">${ic("trophy")}</div><p>Nincs kiadás.</p></div>`;
  bindTxItems(el);
}

// ============ PROFIL / BEÁLLÍTÁSOK ============
function renderProfile(el) {
  const p = state.cache.profile || {};
  const isCloud = state.store.mode === "cloud";
  const theme = getSettings().theme || "system";
  const curCode = currentCurrency();
  const name = p.name || state.user?.user_metadata?.name || "";
  const initial = ((name || "V").trim()[0] || "V").toUpperCase();
  const op = getOpening();
  const acctName = state.account === "self" ? "Saját számla" : (state.household?.name || "Közös");

  // Számla-összesítő (a jelenleg kiválasztott számlára)
  const sumSpendable = trackedNetUpTo(todayStr()) + (op ? Number(op.amount) || 0 : 0);
  const sumSaving = state.cache.transactions.reduce((s, t) =>
    s + (t.type === "saving" ? Number(t.amount || 0) : 0) - (isWithdraw(t) ? Number(t.amount || 0) : 0), 0);
  const sumNet = sumSpendable + sumSaving;
  const moTx = realizedOfMonth();
  const moIn = moTx.filter(t => t.type === "income" && !isWithdraw(t)).reduce((s, t) => s + Number(t.amount || 0), 0);
  const moExp = sumBy(moTx, "expense");

  el.innerHTML = `
    <div class="section-title">Profil</div>

    <div class="card">
      <div class="greet" style="margin:0;display:flex">
        <div class="greet-avatar">${esc(initial)}</div>
        <div class="greet-text"><div class="greet-name">${esc(name || "Vendég")}</div><div class="greet-hi">${isCloud ? esc(state.user?.email || "") : "Helyi mód (nincs fiók)"}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${ic("wallet")} Számla összesítő <span style="color:var(--text-muted);font-weight:600">${esc(acctName)}</span></div>
      <div class="avg-row" style="font-size:15px"><span>${ic("wallet")} Költőpénz (egyenleg)</span><b style="color:${sumSpendable < 0 ? "var(--red)" : ""}">${fmtHTML(sumSpendable, { force: true })}</b></div>
      <div class="avg-row"><span>${ic("piggy-bank")} Megtakarítás (félretéve)</span><b>${fmtHTML(sumSaving, { force: true })}</b></div>
      <div class="avg-row" style="border-top:1.5px solid var(--border);font-weight:800"><span>${ic("layers")} Összes vagyon</span><b>${fmtHTML(sumNet, { force: true })}</b></div>
      <div class="avg-row"><span>${ic("arrow-down-left")} E havi bevétel</span><b style="color:var(--green)">${fmtHTML(moIn)}</b></div>
      <div class="avg-row"><span>${ic("arrow-up-right")} E havi kiadás</span><b style="color:var(--red)">${fmtHTML(moExp)}</b></div>
    </div>

    <div class="card">
      <div class="card-title">${ic("users")} Közös fiók (pár / barát)</div>
      ${isCloud ? (state.household ? `
        <div class="banner info">${ic("users")}<div>Tagok: <b>${(state.household.members || []).map(m => esc(m.display_name || "Társ")).join(", ") || "csak te"}</b></div></div>
        <p class="field-hint" style="margin-bottom:12px">Közös célt és közös kiadást a <b>Célok</b> fülön tudtok létrehozni – mindketten látjátok és kezelitek.</p>
        <button class="btn btn-ghost btn-block" id="btn-new-invite" style="margin-bottom:10px">${ic("user-plus")} Új meghívó kód</button>
        <div id="invite-out"></div>
        <button class="btn btn-danger btn-block" id="btn-leave-hh">${ic("log-out")} Kilépés a közös fiókból</button>
      ` : `
        <p class="field-hint" style="margin-bottom:12px">Kösd össze a fiókod a pároddal: generálj egy 6 jegyű kódot és add oda neki, vagy írd be az ő kódját.</p>
        <button class="btn btn-primary btn-block" id="btn-new-invite" style="margin-bottom:10px">${ic("user-plus")} Meghívó kód generálása</button>
        <div id="invite-out"></div>
        <div class="field" style="margin-top:12px"><label>Csatlakozás kóddal</label>
          <div style="display:flex;gap:8px"><input type="text" id="join-code" inputmode="numeric" maxlength="6" placeholder="6 jegyű kód"><button class="btn btn-ghost" id="btn-join">Csatlakozás</button></div>
        </div>
      `) : `<div class="banner warn">${ic("triangle-alert")}<div>A közös fiók csak regisztrált (felhő) fiókkal érhető el. Jelentkezz be a használatához.</div></div>`}
    </div>

    <div class="card">
      <div class="card-title">Fiók</div>
      <div class="field"><label>Név</label><div class="input-wrap">${ic("user")}<input type="text" id="profile-name" value="${esc(name)}" placeholder="A neved"></div></div>
      <div class="banner info">${ic(isCloud ? "cloud" : "smartphone")}<div>${isCloud ? "Az adataid a Supabase felhőben tárolódnak, minden eszközödön elérhetők." : "Helyi mód: az adataid csak ezen az eszközön, a böngészőben tárolódnak."}</div></div>
      <button class="btn btn-primary btn-block" id="btn-save-profile">Profil mentése</button>
    </div>

    <div class="card">
      <div class="card-title">Visszajelzés</div>
      <p class="field-hint" style="margin-bottom:14px">Bugok, ötletek, fejlesztési javaslatok – mind jól jönnek!${!isCloud ? ` <span style="color:var(--amber)">Helyi módban nem küldhető el; regisztrálj hozzá.</span>` : ""}</p>
      <div class="type-switch" id="fb-type-switch">
        <button data-fbtype="bug" class="active">${ic("bug")} Hiba</button>
        <button data-fbtype="tip">${ic("lightbulb")} Tipp</button>
        <button data-fbtype="feature">${ic("sparkles")} Ötlet</button>
        <button data-fbtype="other">${ic("message-circle")} Egyéb</button>
      </div>
      <div class="field"><textarea id="fb-message" rows="4" placeholder="Írd le, mit tapasztaltál vagy mit fejlesztenél…" style="resize:vertical"></textarea></div>
      <button class="btn btn-primary btn-block" id="btn-send-feedback">${ic("send")} Visszajelzés küldése</button>
      <div id="fb-result" class="auth-error hidden" style="margin-top:10px"></div>
    </div>

    <button class="btn btn-ghost btn-block" id="btn-open-settings" style="margin-top:4px">${ic("settings")} Beállítások (megjelenés, pénznem, korrekció, app)</button>
    <p style="text-align:center;color:var(--text-faint);font-size:12px;margin-top:14px">MoneyManage (MM) v1.4</p>
  `;

  $("#btn-open-settings").onclick = () => switchView("settings");

  // ---- Közös fiók ----
  const btnInvite = $("#btn-new-invite");
  if (btnInvite) btnInvite.onclick = async () => {
    btnInvite.disabled = true;
    try {
      const code = await state.store.createInvite();
      const had = !!state.household;
      await refreshCache();
      $("#invite-out").innerHTML = `<div class="banner info" style="justify-content:center"><div style="text-align:center">Add oda ezt a kódot a társadnak (7 napig érvényes):<br><b style="font-size:28px;letter-spacing:5px">${esc(code)}</b></div></div>`;
      drawIcons();
      if (!had && state.household) toast("Közös fiók létrehozva", "check");
    } catch (e) {
      toast("Nem sikerült kódot generálni – futott már a sharing.sql?");
    } finally { btnInvite.disabled = false; }
  };
  const btnJoin = $("#btn-join");
  if (btnJoin) btnJoin.onclick = async () => {
    const code = ($("#join-code").value || "").trim();
    if (!/^\d{6}$/.test(code)) { toast("Adj meg egy 6 jegyű kódot"); return; }
    btnJoin.disabled = true;
    try {
      await state.store.joinHousehold(code);
      await refreshCache(); renderView();
      toast("Sikeresen összecsatolva!", "check");
    } catch (e) {
      toast(/INVALID_CODE/.test(e.message || "") ? "Érvénytelen vagy lejárt kód" : "Csatlakozás sikertelen");
      btnJoin.disabled = false;
    }
  };
  const btnLeave = $("#btn-leave-hh");
  if (btnLeave) btnLeave.onclick = async () => {
    if (!(await askConfirm({ title: "Kilépés a közös fiókból", message: "Biztosan kilépsz a közös fiókból? A közös tételek/célok a társadnál megmaradnak.", okText: "Kilépés", danger: true }))) return;
    try { await state.store.leaveHousehold(state.household.id); await refreshCache(); renderView(); toast("Kiléptél a közös fiókból"); }
    catch (e) { toast("Nem sikerült kilépni"); }
  };

  $("#btn-save-profile").onclick = async () => { await state.store.setProfile({ name: $("#profile-name").value.trim() }); await refreshCache(); renderView(); toast("Profil mentve", "check"); };

  // ---- Visszajelzés ----
  let fbType = "bug";
  $("#fb-type-switch").querySelectorAll("button").forEach(b => b.onclick = () => {
    fbType = b.dataset.fbtype;
    $("#fb-type-switch").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
  });
  $("#btn-send-feedback").onclick = async () => {
    const msg = $("#fb-message").value.trim();
    const resBox = $("#fb-result");
    resBox.classList.add("hidden");
    if (!msg) { toast("Írj valamit az üzenet mezőbe!"); return; }
    $("#btn-send-feedback").disabled = true;
    try {
      await state.store.sendFeedback({ category: fbType, message: msg, email: state.user?.email || null, app_version: "1.2" });
      resBox.textContent = "Visszajelzés elküldve – köszönjük!";
      resBox.classList.remove("hidden"); resBox.classList.add("success");
      $("#fb-message").value = "";
    } catch (err) {
      resBox.textContent = err.message === "local" ? "Helyi módban nem küldhető el. Regisztrálj fiókot!" : ("Küldési hiba: " + (err.message || "próbáld újra"));
      resBox.classList.remove("hidden", "success");
    } finally {
      $("#btn-send-feedback").disabled = false;
    }
  };

}

// ============ BEÁLLÍTÁSOK (külön a profiltól) ============
function renderSettings(el) {
  const isCloud = state.store.mode === "cloud";
  const theme = getSettings().theme || "system";
  const curCode = currentCurrency();
  const op = getOpening();
  const acctName = state.account === "self" ? "Saját számla" : (state.household?.name || "Közös");

  el.innerHTML = `
    <div class="section-title">Beállítások</div>

    <div class="card">
      <div class="card-title">Megjelenés</div>
      <div class="seg-theme" id="seg-theme">
        <button data-theme="light" class="${theme === "light" ? "active" : ""}">${ic("sun")}<span>Világos</span></button>
        <button data-theme="dark" class="${theme === "dark" ? "active" : ""}">${ic("moon")}<span>Sötét</span></button>
        <button data-theme="system" class="${theme === "system" ? "active" : ""}">${ic("monitor-smartphone")}<span>Rendszer</span></button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Pénznem</div>
      <div class="field" style="margin-bottom:0">
        <label>Megjelenített valuta</label>
        <div class="input-wrap">${ic("circle-dollar-sign")}<select id="cur-select">
          ${Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}" ${k === curCode ? "selected" : ""}>${esc(c.label)}</option>`).join("")}
        </select></div>
        <p class="field-hint">Fő (tárolási) pénznem: <b>${esc(CURRENCIES[baseCurrency()].label)}</b>. Váltáskor csak a megjelenítés változik a mai árfolyamon – az eredeti összegek megmaradnak.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${ic("scale")} Egyenleg-korrekció <span style="color:var(--text-muted);font-weight:600">${esc(acctName)}</span></div>
      <p class="field-hint" style="margin-bottom:12px">Ha frissen kezdted vezetni a pénzügyeid, az app egyenlege eltérhet a banki egyenlegtől. Add meg egy dátumra a TÉNYLEGES egyenleget, és az app ahhoz igazodik. <b>Elég egyszer megtenni</b> – utána, ha mindent rögzítesz, pontos marad.</p>
      ${op ? `<div class="banner info">${ic("info")}<div>Aktív korrekció: <b>${fmt(op.amount, { plus: true, force: true })}</b> · ${esc(op.date)}</div></div>` : ""}
      <div class="field"><label>Dátum</label><input type="date" id="adj-date" value="${op?.date || todayStr()}"></div>
      <div class="field"><label>Tényleges egyenleg ezen a napon</label>
        <div class="input-wrap">${ic("circle-dollar-sign")}<input type="text" id="adj-amount" inputmode="decimal" placeholder="Pl. 250000"></div></div>
      <button class="btn btn-primary btn-block" id="adj-save">Korrekció mentése</button>
      ${op ? `<button class="btn btn-ghost btn-block" id="adj-clear" style="margin-top:8px">Korrekció törlése</button>` : ""}
    </div>

    <div class="card">
      <div class="card-title">Alkalmazás</div>
      <button class="btn btn-ghost btn-block" id="btn-install" style="margin-bottom:10px">${ic("download")} Telepítés telefonra / gépre</button>
      <button class="btn btn-ghost btn-block" id="btn-export" style="margin-bottom:10px">${ic("file-down")} Adatok exportálása (CSV)</button>
      <button class="btn btn-danger btn-block" id="btn-logout">${ic("log-out")} ${isCloud ? "Kijelentkezés" : "Kilépés a helyi módból"}</button>
      ${!isCloud ? `<button class="btn btn-danger btn-block" id="btn-wipe" style="margin-top:10px">${ic("trash-2")} Helyi adatok törlése</button>` : ""}
    </div>
    <p style="text-align:center;color:var(--text-faint);font-size:12px">MoneyManage (MM) v1.4</p>
  `;

  $("#seg-theme").querySelectorAll("button").forEach(b => b.onclick = () => { setSetting("theme", b.dataset.theme); applyTheme(); });

  // ---- Egyenleg-korrekció ----
  $("#adj-save").onclick = () => {
    const d = $("#adj-date").value || todayStr();
    const b = parseAmountToBase($("#adj-amount").value);
    if (isNaN(b)) { toast("Adj meg érvényes egyenleget!"); return; }
    const amount = Math.round((b - trackedNetUpTo(d)) * 100) / 100;
    const o = getSettings().openings || {};
    o[acctKey()] = { amount, date: d };
    setSetting("openings", o);
    renderView(); toast("Egyenleg-korrekció mentve", "check");
  };
  const adjClear = $("#adj-clear");
  if (adjClear) adjClear.onclick = () => {
    const o = getSettings().openings || {};
    delete o[acctKey()];
    setSetting("openings", o);
    renderView(); toast("Korrekció törölve");
  };

  // ---- Pénznem ----
  $("#cur-select").onchange = async (e) => {
    const from = currentCurrency();
    const to = e.target.value;
    const sel = e.target;
    if (from === to) return;
    sel.disabled = true;
    setSetting("currency", to);
    try {
      await ensureRates();
      if (to !== baseCurrency() && displayFactor() == null) {
        setSetting("currency", from); sel.value = from;
        toast("Árfolyam lekérése sikertelen – ellenőrizd az internetet");
      } else {
        renderView();
        toast(to === baseCurrency() ? "Megjelenítés: fő pénznem" : "Megjelenítés átváltva a mai árfolyamon", "check");
      }
    } catch (err) {
      setSetting("currency", from); sel.value = from;
      toast("Árfolyam lekérése sikertelen");
    } finally {
      sel.disabled = false;
    }
  };

  // ---- Alkalmazás ----
  $("#btn-logout").onclick = logout;
  $("#btn-export").onclick = exportCSV;
  $("#btn-install").onclick = async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
    } else {
      await askConfirm({ title: "Alkalmazás telepítése", message: "Androidon (Chrome): menü → „Alkalmazás telepítése”.<br>iPhone-on (Safari): Megosztás → „Hozzáadás a kezdőképernyőhöz”.<br>Gépen (Chrome/Edge): a címsor jobb szélén a telepítés ikon.", okText: "Értem" });
    }
  };
  const wipeBtn = $("#btn-wipe");
  if (wipeBtn) wipeBtn.onclick = async () => {
    if (!(await askConfirm({ title: "Összes adat törlése", message: "Minden helyi adat (tételek, célok, keretek) VÉGLEGESEN törlődik. Biztos?", okText: "Törlés", danger: true }))) return;
    await state.store.wipe();
    localStorage.removeItem("mm_local_active");
    location.reload();
  };
}

function exportCSV() {
  const rows = [["Dátum", "Típus", "Kategória", "Megnevezés", `Összeg (${CURRENCIES[currentCurrency()].symbol})`]];
  const typeHu = { expense: "Kiadás", income: "Bevétel", saving: "Megtakarítás" };
  [...state.cache.transactions].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach(t => {
    const cat = catById(t.category_id);
    const goal = t.goal_id ? goalById(t.goal_id) : null;
    rows.push([t.date, typeHu[t.type] || t.type, goal ? `Cél: ${goal.name}` : (cat?.name || ""), t.note || "", t.amount]);
  });
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v ?? "").replaceAll('"', '""')}"`).join(";")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `moneymanage_export_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("CSV exportálva", "check");
}

// ============ MODÁLOK ============
function openModal(title, bodyHtml) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  $("#modal-overlay").classList.remove("hidden");
  drawIcons();
}
function closeModal() { $("#modal-overlay").classList.add("hidden"); }

// Belső szövegbeviteli dialógus (a natív prompt helyett – nem mutatja a domaint)
function askText({ title, label, placeholder = "", value = "", okText = "OK", inputmode = "" }) {
  return new Promise((resolve) => {
    openModal(title, `
      <div class="field"><label>${esc(label)}</label>
        <input type="text" id="ask-input" placeholder="${esc(placeholder)}" value="${esc(value)}" ${inputmode ? `inputmode="${inputmode}"` : ""} autocomplete="off"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="ask-cancel">Mégse</button>
        <button class="btn btn-primary" id="ask-ok">${esc(okText)}</button>
      </div>
    `);
    const restore = () => { $("#modal-close").onclick = closeModal; };
    const done = (v) => { restore(); closeModal(); resolve(v); };
    $("#modal-close").onclick = () => done(null);
    $("#ask-ok").onclick = () => done(($("#ask-input").value || "").trim());
    $("#ask-cancel").onclick = () => done(null);
    $("#ask-input").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); done(($("#ask-input").value || "").trim()); } };
    setTimeout(() => $("#ask-input").focus(), 120);
  });
}

// Belső megerősítő dialógus (a natív confirm helyett)
function askConfirm({ title = "Megerősítés", message, okText = "OK", danger = false }) {
  return new Promise((resolve) => {
    openModal(title, `
      <p style="font-size:14.5px;line-height:1.55;margin-bottom:18px">${message}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cf-cancel">Mégse</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="cf-ok">${esc(okText)}</button>
      </div>
    `);
    const done = (v) => { $("#modal-close").onclick = closeModal; closeModal(); resolve(v); };
    $("#modal-close").onclick = () => done(false);
    $("#cf-ok").onclick = () => done(true);
    $("#cf-cancel").onclick = () => done(false);
  });
}

// Üdvözlő / funkció-összefoglaló (regisztráció vagy első indítás után, egyszer)
function maybeShowWelcome() {
  if (localStorage.getItem("mm_welcome_seen") === "1") return;
  localStorage.setItem("mm_welcome_seen", "1");
  const feat = (icon, title, desc) => `<div class="welcome-feat"><span class="welcome-ico">${ic(icon)}</span><div><div class="wf-t">${title}</div><div class="wf-d">${desc}</div></div></div>`;
  openModal("Üdv a MoneyManage-ben! 👋", `
    <p class="field-hint" style="margin:-6px 0 14px;font-size:13.5px">Tervezd meg a hónapod, kövesd a kiadásaid, és ne érjen meglepetés. Amit tud:</p>
    ${feat("wallet", "Költségvetés & limitek", "Havi keretek kategóriánként, túlköltés-jelzéssel.")}
    ${feat("chart-column", "Statisztikák", "Grafikonok, kategória-bontás, havi összehasonlítás, átlagok.")}
    ${feat("calculator", "Okos előrejelzés", "Szokásaid és a rendszeres tételeid alapján megmondja, mennyi marad a hó végén.")}
    ${feat("calendar-clock", "Jövőbeli & ismétlődő tételek", "Tervezz előre fizetésekkel, előfizetésekkel (akár 3 hetente).")}
    ${feat("target", "Célok", "Gyűjts félre célokra, majd egy gombbal valósítsd meg.")}
    ${feat("layers", "Külön számlák (zsebek)", "Saját, közös (pár/barát) és egyedi zsebek (pl. vállalkozás) – jobb fent válthatsz.")}
    ${feat("eye-off", "Privát", "Egy gombbal elrejtheted az összegeket; az adatok csak a tieid.")}
    <button class="btn btn-primary btn-block" id="welcome-close" style="margin-top:16px">Kezdjük!</button>
  `);
  $("#welcome-close").onclick = closeModal;
}

// ---------- Tranzakció modál (új / szerkesztés) ----------
function openTxModal(tx = null, preset = {}) {
  const isEdit = !!tx;
  let type = tx?.type || preset.type || "expense";
  let categoryId = tx?.category_id || preset.category_id || state.cache.categories[0]?.id || null;
  let goalId = tx?.goal_id || preset.goal_id || allGoals().filter(g => !g.done)[0]?.id || null;
  const linkedRec = tx?.recurring_id ? state.cache.recurring.find(r => r.id === tx.recurring_id) : null;

  const noteSuggestions = [...new Set(state.cache.transactions.map(t => t.note).filter(Boolean))].slice(0, 30);
  const goalOptions = allGoals().map(g => `<option value="${g.id}" ${g.id === goalId ? "selected" : ""}>${esc(g.name)}${g.household_id ? " (közös)" : ""}</option>`).join("");
  const curMeta = CURRENCIES[currentCurrency()];
  const canShare = false; // a számlaváltó modell váltotta ki a "közös" pipát   // van összecsatolt közös fiók
  const myName = state.cache.profile?.name || state.user?.user_metadata?.name || "Társ";

  // Meglévő átvezetést külön, egyszerű nézetben kezelünk (két láb, két számla)
  if (isEdit && tx.type === "transfer") return openTransferView(tx);
  // Átvezetés csak felhő módban, és ha van legalább 2 számla (Saját + zseb/közös)
  const canTransfer = state.store.mode === "cloud" && allAccounts().length >= 2;
  let transferDest = preset.transfer_dest || allAccounts().find(a => a.id !== state.account)?.id || null;

  openModal(isEdit ? "Tétel szerkesztése" : "Új tétel", `
    <div class="type-switch" id="tx-type-switch">
      <button data-type="expense" class="${type === "expense" ? "active" : ""}">${ic("arrow-up-right")} Kiadás</button>
      <button data-type="income" class="${type === "income" ? "active" : ""}">${ic("arrow-down-left")} Bevétel</button>
      <button data-type="saving" class="${type === "saving" ? "active" : ""}">${ic("piggy-bank")} Félretétel</button>
      ${canTransfer ? `<button data-type="transfer" class="${type === "transfer" ? "active" : ""}">${ic("arrow-left-right")} Átvezetés</button>` : ""}
    </div>
    <div class="field">
      <div class="amount-wrap">
        <input type="text" id="tx-amount" inputmode="decimal" placeholder="0" value="${tx ? baseToDisplay(tx.amount) : esc(preset.amountText || "")}" autocomplete="off">
        <span class="amount-cur ${curMeta.position === "prefix" ? "prefix" : ""}">${curMeta.symbol}</span>
      </div>
      <div class="quick-amounts">
        ${[1000, 2000, 5000, 10000].map(v => `<button type="button" class="chip" data-addamount="${v}">+${v / 1000}k</button>`).join("")}
        <button type="button" class="chip" data-clearamount>C</button>
      </div>
      <p class="field-hint" style="text-align:center">Tipp: írhatod így is: „12k" = 12 000</p>
    </div>
    <div class="field">
      <label>Megnevezés</label>
      <input type="text" id="tx-note" placeholder="Pl. heti bevásárlás" value="${esc(tx?.note || preset.note || "")}" list="note-suggestions" autocomplete="off">
      <datalist id="note-suggestions">${noteSuggestions.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
      <p class="field-hint" id="cat-suggest-hint" style="display:none"></p>
    </div>
    <div class="field" id="tx-cat-field" style="${type === "expense" ? "" : "display:none"}">
      <label>Kategória</label>
      <div class="cat-grid" id="tx-cat-grid">
        ${state.cache.categories.map(c => `<button type="button" class="cat-pick ${c.id === categoryId ? "active" : ""}" data-cat="${c.id}">${ic(c.icon)}<span>${esc(c.name)}</span></button>`).join("")}
        <button type="button" class="cat-pick cat-add" id="tx-cat-add">${ic("plus")}<span>Új</span></button>
      </div>
    </div>
    <div class="field" id="tx-goal-field" style="${type === "saving" ? "" : "display:none"}">
      <label>Melyik célra teszel félre?</label>
      <select id="tx-goal">${goalOptions || `<option value="">Nincs cél – általános megtakarítás</option>`}</select>
      <p class="field-hint">Közös célnál a befizetés a te megtakarításodba számít, a cél összege pedig mindkettőtöknél nő.</p>
    </div>
    <div class="field" id="tx-transfer-field" style="${type === "transfer" ? "" : "display:none"}">
      <label>Melyik számlára vezeted át?</label>
      <select id="tx-transfer-dest">
        ${allAccounts().filter(a => a.id !== state.account).map(a => `<option value="${a.id}" ${a.id === transferDest ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
      </select>
      <p class="field-hint">Az összeg a(z) <b>${esc(accountName(state.account))}</b> számláról ide kerül át. <b>Nem</b> bevétel és <b>nem</b> kiadás – csak a két számla egyenlegét mozgatja, és mindkét számlán megjelenik a Tételeknél.</p>
    </div>
    ${canShare ? `<div class="field" id="tx-shared-field" style="${type === "expense" ? "" : "display:none"}">
      <label class="check-row"><input type="checkbox" id="tx-shared" ${preset.shared ? "checked" : ""}> ${ic("users")} Közös kiadás (a közös kasszába)</label>
    </div>` : ""}
    <div class="field">
      <label>Dátum</label>
      <div class="date-input-wrap">
        <input type="text" id="tx-date-text" inputmode="numeric" placeholder="ÉÉÉÉ-HH-NN" maxlength="10" autocomplete="off" value="${tx?.date || preset.date || todayStr()}">
        <label class="date-cal-btn" aria-label="Naptár megnyitása">${ic("calendar")}
          <input type="date" id="tx-date" value="${tx?.date || preset.date || todayStr()}">
        </label>
      </div>
      <p class="field-hint" id="tx-date-guide"></p>
      <p class="field-hint" id="tx-future-hint" style="display:none">Jövőbeli dátum – <b>tervezett</b> tételként kerül be: a hó végi egyenlegbe beleszámít, a statisztikába még nem. Később a tételsoron a pipa gombbal jelölheted teljesítettnek.</p>
    </div>
    <div class="field" id="tx-recur-field">
      <label class="check-row"><input type="checkbox" id="tx-recurring" ${linkedRec ? "checked" : ""}> ${ic("repeat")} Ismétlődő tétel</label>
      <div id="tx-recur-opts" style="${linkedRec ? "" : "display:none"}">
        <div class="freq-row">
          <span class="freq-lbl">minden</span>
          <input type="number" id="tx-recur-count" min="1" max="365" value="${linkedRec?.interval_count || 1}" class="freq-count">
          <select id="tx-recur-unit" class="freq-unit">
            ${[["day", "nap"], ["week", "hét"], ["month", "hónap"], ["year", "év"]].map(([v, l]) => `<option value="${v}" ${(linkedRec?.interval_unit || "month") === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <p class="field-hint">Az első alkalom a fent megadott <b>dátum</b>. Pl. „minden 3 hét" = 3 hetente. Alapértelmezés: minden 1 hónap (havonta).</p>
        <label class="check-row" style="margin-top:6px"><input type="checkbox" id="tx-recur-manual" ${(linkedRec && (linkedRec.auto_post === false || linkedRec.auto_post === "false")) ? "checked" : ""}> ${ic("circle-check-big")} Kézi pipálás (nem automatikus levonás)</label>
        <p class="field-hint">Bekapcsolva: az esedékes tételek <b>tervezettként</b> (pipálandó) jelennek meg – a következő hónapban is –, és neked kell kipipálnod, amikor ténylegesen levonták. Kikapcsolva: automatikusan könyvelődik.</p>
      </div>
    </div>
    <div class="modal-actions">
      ${isEdit ? `<button class="btn btn-danger" id="tx-delete">${ic("trash-2")} Törlés</button>` : ""}
      <button class="btn btn-primary" id="tx-save">${isEdit ? "Mentés" : "Hozzáadás"}</button>
    </div>
  `);

  // Típusváltó
  $("#tx-type-switch").querySelectorAll("button").forEach(b => b.onclick = () => {
    type = b.dataset.type;
    $("#tx-type-switch").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    $("#tx-cat-field").style.display = type === "expense" ? "" : "none";
    $("#tx-goal-field").style.display = type === "saving" ? "" : "none";
    const tf = $("#tx-transfer-field"); if (tf) tf.style.display = type === "transfer" ? "" : "none";
    const rf = $("#tx-recur-field"); if (rf) rf.style.display = type === "transfer" ? "none" : ""; // átvezetés nem ismétlődő
    const sf = $("#tx-shared-field"); if (sf) sf.style.display = type === "expense" ? "" : "none";
  });

  // Gyorsösszegek
  $$("[data-addamount]").forEach(b => b.onclick = () => {
    const cur = parseAmount($("#tx-amount").value) || 0;
    $("#tx-amount").value = cur + Number(b.dataset.addamount);
  });
  const clearBtn = document.querySelector("[data-clearamount]");
  if (clearBtn) clearBtn.onclick = () => { $("#tx-amount").value = ""; $("#tx-amount").focus(); };

  // Kategóriaválasztó
  $("#tx-cat-grid")?.querySelectorAll(".cat-pick:not(.cat-add)").forEach(b => b.onclick = () => {
    categoryId = b.dataset.cat;
    $("#tx-cat-grid").querySelectorAll(".cat-pick:not(.cat-add)").forEach(x => x.classList.toggle("active", x === b));
  });
  // Új kategória közvetlenül a tétel-űrlapról (a már beírt összeg/megnevezés/dátum megmarad)
  const catAddBtn = $("#tx-cat-add");
  if (catAddBtn) catAddBtn.onclick = () => {
    const draft = { type, amountText: $("#tx-amount").value, note: $("#tx-note").value, date: $("#tx-date").value };
    openCategoryModal({ onCreated: (cat) => openTxModal(null, { type: draft.type, category_id: cat.id, amountText: draft.amountText, note: draft.note, date: draft.date }) });
  };

  // Okos kategória-javaslat a megnevezés alapján
  $("#tx-note").oninput = (e) => {
    if (type !== "expense") return;
    const suggested = suggestCategory(e.target.value, state.cache.categories);
    const hint = $("#cat-suggest-hint");
    if (suggested && suggested.id !== categoryId) {
      hint.style.display = "block";
      hint.innerHTML = `${ic("lightbulb")} Javasolt kategória: <b style="color:var(--primary);cursor:pointer">${esc(suggested.name)}</b> – kattints az elfogadáshoz`;
      drawIcons();
      hint.onclick = () => {
        categoryId = suggested.id;
        $("#tx-cat-grid").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x.dataset.cat === suggested.id));
        hint.style.display = "none";
      };
    } else hint.style.display = "none";
  };

  // Dátum: közvetlen gépelés + naptár, lépésenkénti súgóval (év → hónap → nap)
  const dateText = $("#tx-date-text");
  const dateNative = $("#tx-date");
  const dateGuide = $("#tx-date-guide");
  const MONTHS_HU = ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"];
  const pad2 = (n) => String(n).padStart(2, "0");

  const updateFutureHint = () => {
    const d = dateNative.value;
    $("#tx-future-hint").style.display = (d && isFutureDate(d)) ? "block" : "none";
  };

  function refreshDateGuide() {
    const digits = (dateText.value.match(/\d/g) || []).join("").slice(0, 8);
    dateGuide.style.color = "";
    if (digits.length < 8) {
      dateNative.value = "";
      updateFutureHint();
      if (digits.length === 0) dateGuide.textContent = "Írd be a dátumot számokkal: előbb az évet, majd a hónapot, végül a napot.";
      else if (digits.length < 4) dateGuide.textContent = `Év (${digits}…) — még ${4 - digits.length} számjegy.`;
      else if (digits.length < 6) dateGuide.textContent = "Most a hónap következik (01–12).";
      else dateGuide.textContent = "Most a nap következik (01–31).";
      return;
    }
    const y = +digits.slice(0, 4), m = +digits.slice(4, 6), d = +digits.slice(6, 8);
    const dt = new Date(y, m - 1, d);
    const ok = m >= 1 && m <= 12 && d >= 1 && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
    if (!ok) {
      dateNative.value = ""; updateFutureHint();
      dateGuide.style.color = "var(--danger)";
      dateGuide.textContent = "Érvénytelen dátum — ellenőrizd a hónapot (01–12) és a napot.";
      return;
    }
    dateNative.value = `${y}-${pad2(m)}-${pad2(d)}`;
    dateGuide.style.color = "var(--green)";
    dateGuide.textContent = `${y}. ${MONTHS_HU[m - 1]} ${d}.`;
    updateFutureHint();
  }

  function maskDateInput() {
    const digits = (dateText.value.match(/\d/g) || []).join("").slice(0, 8);
    let out = digits.slice(0, 4);
    if (digits.length > 4) out += "-" + digits.slice(4, 6);
    if (digits.length > 6) out += "-" + digits.slice(6, 8);
    dateText.value = out;
    refreshDateGuide();
  }

  dateText.oninput = maskDateInput;
  dateNative.onchange = () => { dateText.value = dateNative.value; refreshDateGuide(); };
  maskDateInput();

  // Ismétlődés kapcsoló
  $("#tx-recurring").onchange = (e) => {
    $("#tx-recur-opts").style.display = e.target.checked ? "block" : "none";
  };

  // Mentés
  $("#tx-save").onclick = async () => {
    const amount = parseAmountToBase($("#tx-amount").value);
    if (isNaN(amount) || amount <= 0) { toast("Adj meg érvényes összeget!"); return; }
    const note = $("#tx-note").value.trim();
    const date = $("#tx-date").value || todayStr();
    const pending = isFutureDate(date);
    // ----- Számlák közötti átvezetés: két láb (forrás + cél), nem bevétel/kiadás -----
    if (type === "transfer") {
      const destId = $("#tx-transfer-dest")?.value;
      if (!destId || destId === state.account) { toast("Válassz egy másik cél-számlát!"); return; }
      try {
        await doTransfer({ amount, date, note, destId });
        await refreshCache(); closeModal(); renderView();
        toast("Átvezetés rögzítve mindkét számlán", "check");
      } catch (e) { toast("Az átvezetés nem sikerült – próbáld újra"); }
      return;
    }
    const recurOn = $("#tx-recurring")?.checked;
    const unit = $("#tx-recur-unit")?.value || "month";
    const count = Math.max(1, parseInt($("#tx-recur-count")?.value, 10) || 1);
    const recurManual = $("#tx-recur-manual")?.checked || false;
    const row = {
      type, amount, note, date, pending,
      category_id: type === "expense" ? categoryId : null,
      goal_id: type === "saving" ? ($("#tx-goal")?.value || null) : null,
    };
    // A számlaváltó (Saját / zseb / közös) modellben a kontextus dönti el, hova kerül a tétel –
    // nincs külön "közös" pipa, a normál mentés a megfelelő számlára ír (ctxHousehold).
    const sharedOn = false;
    const sharedGoal = null;
    try {
      if (isEdit) {
        if (recurOn && linkedRec) {
          // meglévő sorozat frissítése (a jövőbeli könyveléseket érinti)
          await state.store.update("recurring", linkedRec.id, {
            name: note || linkedRec.name, amount, type, category_id: row.category_id,
            interval_unit: unit, interval_count: count, active: true, auto_post: !recurManual,
          });
          row.recurring_id = linkedRec.id;
        } else if (recurOn && !linkedRec) {
          // most tették ismétlődővé
          const rec = await state.store.insert("recurring", {
            name: note || (type === "income" ? "Bevétel" : "Kiadás"), amount, type,
            category_id: row.category_id, interval_unit: unit, interval_count: count,
            anchor_date: date, active: true, auto_post: !recurManual,
          });
          row.recurring_id = rec.id;
        } else if (!recurOn && linkedRec) {
          // kikapcsolták az ismétlődést → a sorozatot szüneteltetjük
          await state.store.update("recurring", linkedRec.id, { active: false });
          row.recurring_id = null;
        }
        await state.store.update("transactions", tx.id, row);
      } else if (sharedOn) {
        // Közös kiadás → a közös kasszába (mindkét fél látja)
        await state.store.insertShared("transactions", row, state.household.id);
      } else if (sharedGoal) {
        // Közös célba: a befizetés a SAJÁT megtakarításodba számít (privát tétel),
        // a cél összege pedig a közös hozzájárulás-naplóból nő (mindkét félnél)
        await state.store.insert("transactions", row);
        await state.store.addContribution({ household_id: sharedGoal.household_id, goal_id: sharedGoal.id, amount, date, display_name: myName });
      } else {
        if (recurOn) {
          // a sorozat létrehozása, az eredeti tételt hozzákötjük (így nem duplázódik könyveléskor)
          const rec = await state.store.insert("recurring", {
            name: note || (type === "income" ? "Bevétel" : "Kiadás"), amount, type,
            category_id: row.category_id, interval_unit: unit, interval_count: count,
            anchor_date: date, active: true, auto_post: !recurManual,
          });
          row.recurring_id = rec.id;
        }
        await state.store.insert("transactions", row);
      }
      await refreshCache();
      closeModal();
      renderView();
      toast(isEdit ? "Tétel módosítva" : sharedOn ? "Közös kiadás hozzáadva" : sharedGoal ? "Befizetés a közös célba" : (recurOn ? "Tétel + ismétlődés mentve" : "Tétel hozzáadva"), "check");
    } catch (e) {
      toast("Mentési hiba – próbáld újra");
    }
  };

  // Törlés
  const delBtn = $("#tx-delete");
  if (delBtn) delBtn.onclick = async () => {
    if (!(await askConfirm({ title: "Tétel törlése", message: "Biztosan törlöd ezt a tételt?", okText: "Törlés", danger: true }))) return;
    await state.store.remove("transactions", tx.id);
    await refreshCache(); closeModal(); renderView(); toast("Tétel törölve");
  };

  if (!isEdit) setTimeout(() => $("#tx-amount").focus(), 100);
}

// ---------- Számlák közötti átvezetés ----------
// Két lábat ír: 'out' a forrás (aktuális) számlán, 'in' a cél számlán, közös transfer_id-vel.
async function doTransfer({ amount, date, note, destId }) {
  const srcId = state.account;               // 'self' vagy household id
  const tid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2));
  const ctxOf = (id) => (id === "self" ? null : id);
  const prev = state.store.ctxHousehold;
  try {
    // forrás láb (kimenő)
    if (state.store.setCtx) state.store.setCtx(ctxOf(srcId));
    await state.store.insert("transactions", {
      type: "transfer", amount, date, note: note || null, pending: false,
      transfer_id: tid, transfer_dir: "out", transfer_peer_id: destId, transfer_peer_name: accountName(destId),
    });
    // cél láb (bejövő)
    if (state.store.setCtx) state.store.setCtx(ctxOf(destId));
    await state.store.insert("transactions", {
      type: "transfer", amount, date, note: note || null, pending: false,
      transfer_id: tid, transfer_dir: "in", transfer_peer_id: srcId, transfer_peer_name: accountName(srcId),
    });
  } finally {
    if (state.store.setCtx) state.store.setCtx(prev || null);
  }
}

// Meglévő átvezetés egyszerű nézete: részletek + törlés (mindkét számláról)
function openTransferView(t) {
  const dirIn = t.transfer_dir === "in";
  const peer = t.transfer_peer_name || accountName(t.transfer_peer_id);
  const here = accountName(state.account);
  openModal("Átvezetés", `
    <div class="banner info" style="margin-bottom:14px">${ic("arrow-left-right")}<div>
      ${dirIn
        ? `<b>${fmt(t.amount, { force: true })}</b> érkezett ide (<b>${esc(here)}</b>) innen: <b>${esc(peer)}</b>.`
        : `<b>${fmt(t.amount, { force: true })}</b> átvezetve innen (<b>${esc(here)}</b>) ide: <b>${esc(peer)}</b>.`}
      <br><span style="color:var(--text-muted);font-size:13px">Dátum: ${esc(t.date)}${t.note ? " · " + esc(t.note) : ""}</span>
    </div></div>
    <p class="field-hint" style="margin-bottom:16px">Az átvezetés <b>nem</b> bevétel és <b>nem</b> kiadás – csak a két számla egyenlegét mozgatja, ezért a statisztikába és a költségvetésbe nem számít bele. Mindkét számlán megjelenik.</p>
    <div class="modal-actions">
      <button class="btn btn-danger" id="tr-delete">${ic("trash-2")} Törlés (mindkét számláról)</button>
    </div>
  `);
  $("#tr-delete").onclick = async () => {
    if (!(await askConfirm({ title: "Átvezetés törlése", message: "Töröljük az átvezetést mindkét számláról?", okText: "Törlés", danger: true }))) return;
    try {
      await deleteTransfer(t);
      await refreshCache(); closeModal(); renderView();
      toast("Átvezetés törölve");
    } catch (e) { toast("A törlés nem sikerült"); }
  };
}

// Mindkét láb törlése a közös transfer_id alapján (a párja a másik számla kontextusában van)
async function deleteTransfer(t) {
  const tid = t.transfer_id;
  const ctxOf = (id) => (id === "self" ? null : id);
  const prev = state.store.ctxHousehold;
  await state.store.remove("transactions", t.id);
  if (tid && state.store.setCtx) {
    try {
      state.store.setCtx(ctxOf(t.transfer_peer_id));
      const peerTx = await state.store.list("transactions");
      const peer = peerTx.find(x => x.transfer_id === tid);
      if (peer) await state.store.remove("transactions", peer.id);
    } finally {
      state.store.setCtx(prev || null);
    }
  }
}

// ---------- Cél modál ----------
function openGoalModal(goal = null) {
  const isEdit = !!goal;
  const icons = ["target", "umbrella", "car", "house", "gem", "graduation-cap", "laptop", "shield", "plane", "music", "baby", "dog"];
  const sel = iconName(goal?.icon || "target");
  const canShare = false; // a számlaváltó modell váltotta ki a "közös" pipát
  openModal(isEdit ? "Cél szerkesztése" : "Új cél", `
    <div class="field"><label>Mi a célod?</label>
      <input type="text" id="goal-name" placeholder="Pl. nyaralás, autó, vésztartalék" value="${esc(goal?.name || "")}"></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))" id="goal-icons">
        ${icons.map(i => `<button type="button" class="cat-pick icononly ${sel === i ? "active" : ""}" data-icon="${i}">${ic(i)}</button>`).join("")}
      </div></div>
    <div class="field"><label>Célösszeg</label>
      <input type="text" id="goal-target" inputmode="decimal" placeholder="Pl. 300k" value="${goal ? baseToDisplay(goal.target_amount) : ""}">
      <p class="field-hint">Tipp: „300k" = 300 000</p></div>
    <div class="field"><label>Már megvan ennyi (kezdőösszeg)</label>
      <input type="text" id="goal-start" inputmode="decimal" placeholder="0" value="${goal && goal.start_amount ? baseToDisplay(goal.start_amount) : ""}"></div>
    <div class="field"><label>Határidő (nem kötelező)</label>
      <input type="date" id="goal-deadline" value="${goal?.deadline ? goal.deadline.slice(0, 10) : ""}"></div>
    ${(!isEdit && canShare) ? `<div class="field"><label class="check-row"><input type="checkbox" id="goal-shared"> ${ic("users")} Közös cél (a társaddal együtt gyűjtötök rá)</label></div>` : ""}
    <div class="banner info" id="goal-calc" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="goal-save">${isEdit ? "Mentés" : "Cél létrehozása"}</button>
    </div>
  `);

  let icon = sel;
  $("#goal-icons").querySelectorAll(".cat-pick").forEach(b => b.onclick = () => {
    icon = b.dataset.icon;
    $("#goal-icons").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x === b));
  });

  function recalc() {
    const target = parseAmountToBase($("#goal-target").value);
    const start = parseAmountToBase($("#goal-start").value) || 0;
    const dl = $("#goal-deadline").value;
    const box = $("#goal-calc");
    if (!isNaN(target) && target > 0 && dl) {
      const now = new Date();
      const d = new Date(dl);
      const months = Math.max(1, (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth()));
      const monthly = Math.max(0, (target - start)) / months;
      box.style.display = "flex";
      box.innerHTML = `${ic("calendar-check")}<div>Ehhez havonta <b>${fmt(monthly)}</b> félretétele szükséges (${months} hónapon át).</div>`;
      drawIcons();
    } else box.style.display = "none";
  }
  ["goal-target", "goal-start", "goal-deadline"].forEach(id => $("#" + id).oninput = recalc);
  recalc();

  $("#goal-save").onclick = async () => {
    const name = $("#goal-name").value.trim();
    const target = parseAmountToBase($("#goal-target").value);
    if (!name || isNaN(target) || target <= 0) { toast("Add meg a cél nevét és összegét!"); return; }
    const row = {
      name, icon, target_amount: target,
      start_amount: parseAmountToBase($("#goal-start").value) || 0,
      deadline: $("#goal-deadline").value || null,
    };
    const shared = !isEdit && canShare && $("#goal-shared")?.checked;
    if (isEdit) await state.store.update("goals", goal.id, row);
    else if (shared) await state.store.insertShared("goals", row, state.household.id);
    else await state.store.insert("goals", row);
    await refreshCache(); closeModal(); renderView();
    toast(isEdit ? "Cél módosítva" : shared ? "Közös cél létrehozva" : "Cél létrehozva", "check");
  };
}

// ---------- Kategória modál ----------
function openCategoryModal(opts = {}) {
  const icons = ["house", "shopping-cart", "bus", "car", "party-popper", "pill", "shirt", "smartphone", "package", "gamepad-2", "book-open", "coffee", "scissors", "gift", "dumbbell", "plane", "graduation-cap", "heart", "utensils", "wifi", "dog", "cat", "music", "briefcase", "fuel", "baby", "wrench", "stethoscope", "cigarette", "wine", "bike", "train-front", "shopping-bag", "hand-coins", "piggy-bank", "tv"];
  const colors = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#4f46e5", "#64748b", "#db2777", "#65a30d", "#ea580c", "#0d9488"];
  openModal("Új kategória", `
    <div class="field"><label>Név</label><input type="text" id="cat-name" placeholder="Pl. Hobbi"></div>
    <div class="field"><label>Szín</label>
      <div class="color-grid" id="cat-colors">
        ${colors.map((c, x) => `<button type="button" class="color-pick ${x === 0 ? "active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
      </div></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))" id="cat-icons">
        ${icons.map((i, x) => `<button type="button" class="cat-pick icononly ${x === 0 ? "active" : ""}" data-icon="${i}">${ic(i)}</button>`).join("")}
      </div></div>
    <div class="field"><label>Havi keret (nem kötelező)</label>
      <input type="text" id="cat-budget" inputmode="decimal" placeholder="Pl. 10k"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="cat-save">Létrehozás</button></div>
  `);
  let icon = icons[0], color = colors[0];
  $("#cat-icons").querySelectorAll(".cat-pick").forEach(b => b.onclick = () => {
    icon = b.dataset.icon;
    $("#cat-icons").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x === b));
  });
  $("#cat-colors").querySelectorAll(".color-pick").forEach(b => b.onclick = () => {
    color = b.dataset.color;
    $("#cat-colors").querySelectorAll(".color-pick").forEach(x => x.classList.toggle("active", x === b));
  });
  $("#cat-save").onclick = async () => {
    const name = $("#cat-name").value.trim();
    if (!name) { toast("Adj nevet a kategóriának!"); return; }
    const created = await state.store.insert("categories", {
      name, icon, color,
      budget: parseAmountToBase($("#cat-budget").value) || 0, sort: state.cache.categories.length,
    });
    await refreshCache();
    toast("Kategória létrehozva", "check");
    if (opts.onCreated) opts.onCreated(created);
    else { closeModal(); renderView(); }
  };
}

// ---------- Ismétlődő tétel modál ----------
function openRecurringModal() {
  const catOptions = state.cache.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  openModal("Új ismétlődő tétel", `
    <div class="type-switch" id="rec-type-switch">
      <button data-type="expense" class="active">${ic("arrow-up-right")} Kiadás</button>
      <button data-type="income">${ic("arrow-down-left")} Bevétel</button>
    </div>
    <div class="field"><label>Megnevezés</label><input type="text" id="rec-name" placeholder="Pl. Fizetés, Albérlet, Netflix"></div>
    <div class="field"><label>Összeg</label><input type="text" id="rec-amount" inputmode="decimal" placeholder="Pl. 150k"></div>
    <div class="field" id="rec-cat-field"><label>Kategória</label><select id="rec-cat">${catOptions}</select></div>
    <div class="field"><label>Gyakoriság</label>
      <div class="freq-row">
        <span class="freq-lbl">minden</span>
        <input type="number" id="rec-count" min="1" max="365" value="1" class="freq-count">
        <select id="rec-unit" class="freq-unit">
          <option value="day">nap</option>
          <option value="week">hét</option>
          <option value="month" selected>hónap</option>
          <option value="year">év</option>
        </select>
      </div>
      <p class="field-hint">Pl. „minden 3 hét" = 3 hetente. Alapértelmezés: minden 1 hónap (havonta).</p></div>
    <div class="field"><label>Első alkalom / kezdő dátum</label>
      <input type="date" id="rec-anchor" value="${todayStr()}">
      <p class="field-hint">Innen indul az ismétlődés. Havi fizetésnél állítsd arra a napra, amikor érkezik (pl. a hónap 5-e).</p></div>
    <div class="field" style="margin-bottom:4px">
      <label class="check-row"><input type="checkbox" id="rec-manual"> ${ic("circle-check-big")} Kézi pipálás (nem automatikus levonás)</label>
      <p class="field-hint">Bekapcsolva: a tételek <b>tervezettként</b> (pipálandó) jelennek meg – a következő hónapban is –, és te pipálod ki, amikor ténylegesen levonták. Kikapcsolva: automatikusan könyvelődik.</p>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" id="rec-save">Hozzáadás</button></div>
  `);
  let type = "expense";
  $("#rec-type-switch").querySelectorAll("button").forEach(b => b.onclick = () => {
    type = b.dataset.type;
    $("#rec-type-switch").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    $("#rec-cat-field").style.display = type === "expense" ? "" : "none";
  });
  $("#rec-save").onclick = async () => {
    const name = $("#rec-name").value.trim();
    const amount = parseAmountToBase($("#rec-amount").value);
    const count = Math.max(1, parseInt($("#rec-count").value, 10) || 1);
    const unit = $("#rec-unit").value || "month";
    const anchor = $("#rec-anchor").value || todayStr();
    if (!name || isNaN(amount) || amount <= 0) { toast("Add meg a nevet és az összeget!"); return; }
    await state.store.insert("recurring", {
      name, amount, type, active: true,
      category_id: type === "expense" ? $("#rec-cat").value : null,
      interval_unit: unit, interval_count: count, anchor_date: anchor,
      auto_post: !($("#rec-manual")?.checked),
    });
    await refreshCache();
    await applyRecurring();
    await refreshCache();
    closeModal(); renderView(); toast("Ismétlődő tétel mentve", "check");
  };
}

// ============ PWA ============
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.deferredInstall = e;
});
if ("serviceWorker" in navigator) {
  // Automatikus frissítés: új verziónál a SW azonnal átveszi (skipWaiting),
  // és az oldal EGYSZER újratölt, hogy a friss kód jelenjen meg – telefonra telepített appban is.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return; // első telepítéskor NE töltsön újra
    refreshing = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      reg.update();
      // frissítés-ellenőrzés, amikor az app előtérbe kerül (telefonon ez a kulcs), és óránként
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch (e) {}
  });
}

// ============ START ============
initAuth();
