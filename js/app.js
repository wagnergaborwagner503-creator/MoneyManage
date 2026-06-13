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
  cache: { categories: [], transactions: [], goals: [], recurring: [], profile: {} },
  charts: {},
  deferredInstall: null,
};

// ---------- Beállítások (valuta, téma) – eszközszinten, localStorage-ben ----------
const CURRENCIES = {
  HUF: { symbol: "Ft", position: "suffix", decimals: 2, label: "Forint (Ft)" },
  EUR: { symbol: "€", position: "suffix", decimals: 2, label: "Euró (€)" },
  USD: { symbol: "$", position: "prefix", decimals: 2, label: "Dollár ($)" },
  GBP: { symbol: "£", position: "prefix", decimals: 2, label: "Font (£)" },
  RON: { symbol: "lei", position: "suffix", decimals: 2, label: "Román lej (lei)" },
  CHF: { symbol: "Fr", position: "suffix", decimals: 2, label: "Svájci frank (Fr)" },
};
function getSettings() { try { return JSON.parse(localStorage.getItem("mm_settings") || "{}"); } catch { return {}; } }
function setSetting(k, v) { const s = getSettings(); s[k] = v; localStorage.setItem("mm_settings", JSON.stringify(s)); }
const currentCurrency = () => (CURRENCIES[getSettings().currency] ? getSettings().currency : "HUF");

// ---------- Pénz-formázás (magyar tagolás: ezresek vékony szóközzel, tizedesek elkülönítve) ----------
const THIN = " "; // vékony szóköz az ezresekhez ("egy picit távolabb")
function moneyParts(n, curCode = currentCurrency()) {
  const c = CURRENCIES[curCode] || CURRENCIES.HUF;
  const neg = Number(n) < 0;
  const abs = Math.abs(Number(n) || 0);
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
  const p = moneyParts(n, opts.cur);
  const sign = p.neg ? "−" : (opts.plus ? "+" : "");
  const cur = `<span class="m-cur">${p.symbol}</span>`;
  const num = `<span class="m-int">${p.intPart}</span>${p.decPart ? `<span class="m-dec">${p.decPart}</span>` : ""}`;
  const body = p.position === "prefix" ? `${cur}${num}` : `${num}${THIN}${cur}`;
  return `<span class="money">${sign}${body}</span>`;
}
// Sima szöveg (CSV, toast, input)
function fmt(n, opts = {}) {
  const p = moneyParts(n, opts.cur);
  const sign = p.neg ? "−" : (opts.plus ? "+" : "");
  const num = p.intPart + p.decPart;
  return p.position === "prefix" ? `${sign}${p.symbol}${num}` : `${sign}${num} ${p.symbol}`;
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
// Aktuális téma színei (Chart.js-hez)
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { text: v("--text"), muted: v("--text-muted"), grid: v("--border"), primary: v("--primary"), green: v("--green"), surface: v("--surface") };
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
function goalById(id) { return state.cache.goals.find(g => g.id === id); }
function goalSaved(goal) {
  return Number(goal.start_amount || 0) +
    state.cache.transactions.filter(t => t.type === "saving" && t.goal_id === goal.id)
      .reduce((s, t) => s + Number(t.amount || 0), 0);
}

async function refreshCache() {
  const [categories, transactions, goals, recurring, profile] = await Promise.all([
    state.store.list("categories"),
    state.store.list("transactions"),
    state.store.list("goals"),
    state.store.list("recurring"),
    state.store.getProfile(),
  ]);
  categories.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  transactions.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.created_at || "").localeCompare(a.created_at || ""));
  state.cache = { categories, transactions, goals, recurring, profile };
}

// ---------- Ismétlődő tételek automatikus könyvelése ----------
// A horgonytól (anchor_date) indulva minden esedékes (mai vagy korábbi) előfordulást
// pontos dátum szerint könyvel. A dedup a (recurring_id + dátum) páron alapul,
// így egy adott előfordulás SOHA nem kerül be kétszer – frissítéskor sem.
async function applyRecurring() {
  const today = today0();
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
    for (let n = 0, guard = 0; guard < 1000; n++, guard++) {
      const occ = occurrenceDate(anchor, unit, count, n);
      occ.setHours(0, 0, 0, 0);
      if (occ > today) break;          // jövőbeli előfordulást még nem könyvelünk
      const occStr = isoDate(occ);
      const dedupKey = r.id + "|" + occStr;
      if (booked.has(dedupKey)) continue;
      booked.add(dedupKey);
      await state.store.insert("transactions", {
        type: r.type, amount: r.amount, category_id: r.category_id || null,
        note: r.name, date: occStr, recurring_id: r.id, pending: false,
      });
      added++;
    }
  }
  if (added) {
    await refreshCache();
    toast(`${added} ismétlődő tétel automatikusan könyvelve`, "check");
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

  let mode = "login";
  $$(".auth-tab").forEach(tab => tab.onclick = () => {
    $$(".auth-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    mode = tab.dataset.authtab;
    $("#auth-name-field").style.display = mode === "register" ? "block" : "none";
    $("#auth-submit").textContent = mode === "register" ? "Fiók létrehozása" : "Bejelentkezés";
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
  await store.init();
  await refreshCache();
  await applyRecurring();

  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const who = user ? (user.user_metadata?.name || user.email) : "Helyi mód (nincs fiók)";
  $("#sidebar-user").textContent = (store.mode === "cloud" ? "☁ " : "▣ ") + who;

  bindNav();
  renderView();
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
    goals: renderGoals, stats: renderStats, profile: renderProfile,
  };
  renderers[state.view](el);
  drawIcons();
}

// ============ ÁTTEKINTÉS (Dashboard) ============
function renderDashboard(el) {
  const txAll = txOfMonth();
  const txReal = realized(txAll);
  // Teljesített (realized) – ez megy a Bevétel/Kiadás kártyákra és a keretekbe
  const incomeR = sumBy(txReal, "income");
  const expenseR = sumBy(txReal, "expense");
  const savingR = sumBy(txReal, "saving");
  // Tervezettel együtt (pending is) – ez a "Hó végén marad"
  const incomeAll = sumBy(txAll, "income");
  const expenseAll = sumBy(txAll, "expense");
  const savingAll = sumBy(txAll, "saving");
  const balance = incomeAll - expenseAll - savingAll;
  const pendingCount = txAll.filter(isPending).length;
  const plannedExpense = expenseAll - expenseR;
  const plannedIncome = incomeAll - incomeR;

  const now = new Date();
  const dim = daysInMonth(state.month);
  const cur = isCurrentMonth(state.month);
  const daysLeft = cur ? dim - now.getDate() + 1 : dim;
  const daily = balance > 0 ? balance / daysLeft : 0;

  let projHtml = "";
  if (cur) {
    const elapsed = now.getDate();
    const projected = elapsed > 0 ? (expenseR / elapsed) * dim : 0;
    const projBalance = incomeAll - projected - savingAll;
    projHtml = `<div class="banner ${projBalance < 0 ? "warn" : "info"}">${ic("sparkles")}<div><b>Hó végi előrejelzés:</b> a jelenlegi tempóban kb. ${fmt(projected)} lesz az összes kiadásod, így várhatóan <b>${fmt(projBalance)}</b> marad a hónap végén.</div></div>`;
  }

  const pendingBanner = pendingCount ? `<div class="banner info">${ic("calendar-clock")}<div><b>${pendingCount} tervezett tétel</b> ebben a hónapban – a hó végi egyenlegbe beleszámítanak, a statisztikába még nem. A Tételek fülön pipáld ki őket, amint megtörténtek.</div></div>` : "";

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
    return `<div class="budget-row">
      <div class="budget-row-head">
        <span class="budget-row-name"><span class="mini-ico" style="background:${c.color}22;color:${c.color}">${ic(c.icon)}</span><span>${esc(c.name)}</span></span>
        <span class="budget-row-vals"><b>${fmt(spent)}</b> / ${fmt(c.budget)}</span>
      </div>
      <div class="progress"><div class="progress-fill ${cls}" data-w="${pct}"></div></div>
    </div>`;
  }).join("");

  const recent = txAll.slice(0, 6).map(txItemHtml).join("");

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
    <div class="greet">
      <div class="greet-avatar">${esc(initial)}</div>
      <div class="greet-text"><div class="greet-hi">Üdv újra,</div><div class="greet-name">${esc(name)}</div></div>
      <button class="icon-btn-round" data-goto="profile" aria-label="Profil">${ic("settings")}</button>
    </div>

    <div class="hero">
      <div class="hero-label">${ic("wallet")} Hó végén marad</div>
      <div class="hero-balance">${fmtHTML(balance)}</div>
      <div class="hero-sub ${balance < 0 ? "neg" : ""}">${ic(cur ? "calendar-range" : "calendar")} ${cur ? `Napi keret: ${fmt(daily)}` : monthLabel(state.month)}</div>
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
        <div class="stat-value pos">${fmtHTML(incomeR)}</div>
        ${plannedIncome ? `<div class="stat-sub">+ ${fmt(plannedIncome)} tervezett</div>` : ""}
      </div>
      <div class="stat-card">
        <div class="stat-head"><span class="pill-ico red">${ic("trending-down")}</span> Kiadás</div>
        <div class="stat-value neg">${fmtHTML(expenseR)}</div>
        ${plannedExpense ? `<div class="stat-sub">+ ${fmt(plannedExpense)} tervezett</div>` : ""}
      </div>
    </div>

    ${pendingBanner}
    ${projHtml}

    <div class="row-2">
      <div class="card">
        <div class="card-title">Költségkeretek <button class="btn-link" data-goto="budget">Szerkesztés ${ic("chevron-right")}</button></div>
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
  let iconN, color, tint;
  if (t.type === "income") { iconN = "arrow-down-left"; color = "var(--green)"; tint = "var(--green-soft)"; }
  else if (t.type === "saving") { iconN = goal?.icon || "piggy-bank"; color = "var(--primary)"; tint = "var(--primary-soft)"; }
  else { iconN = cat?.icon || "package"; color = cat?.color || "var(--text-muted)"; tint = cat?.color ? cat.color + "22" : "var(--surface-2)"; }
  const sub = t.type === "income" ? "Bevétel"
    : t.type === "saving" ? `Megtakarítás${goal ? " → " + esc(goal.name) : ""}`
    : esc(cat?.name || "Egyéb");
  const amtHtml = t.type === "income" ? fmtHTML(t.amount, { plus: true }) : fmtHTML(-Math.abs(Number(t.amount)));
  const badge = pending ? `<span class="tx-badge">${ic("clock")} tervezett</span>` : "";
  const completeBtn = pending ? `<button class="tx-complete" data-complete="${t.id}" title="Megjelölés teljesítettként">${ic("check")}</button>` : "";
  return `<div class="tx-item ${pending ? "pending" : ""}" data-txid="${t.id}">
    <div class="tx-ico" style="background:${tint};color:${color}">${ic(iconN)}</div>
    <div class="tx-info"><div class="tx-name">${esc(t.note) || sub}</div><div class="tx-cat">${sub}${t.recurring_id ? ic("repeat") : ""}${badge}</div></div>
    ${completeBtn}
    <div class="tx-amount ${t.type}">${amtHtml}</div>
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
  const tx = txOfMonth();
  let filterCat = "all", filterType = "all", search = "";

  function listHtml() {
    let list = tx;
    if (filterType !== "all") list = list.filter(t => t.type === filterType);
    if (filterCat !== "all") list = list.filter(t => t.category_id === filterCat);
    if (search) list = list.filter(t => (t.note || "").toLowerCase().includes(search.toLowerCase()));
    if (!list.length) return `<div class="empty-state"><div class="empty-ico">${ic("search-x")}</div><p>Nincs találat ebben a hónapban.</p></div>`;
    // napok szerint csoportosítva
    const groups = {};
    list.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
    return Object.keys(groups).sort().reverse().map(date => {
      const d = new Date(date + "T00:00:00");
      const label = `${d.getMonth() + 1 + ". " + d.getDate()}. (${DAYS_HU[d.getDay()]})`;
      const dayTotal = groups[date].filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
      return `<div class="tx-group-date">${label}${dayTotal ? ` · −${fmt(dayTotal)}` : ""}</div>` +
        groups[date].map(txItemHtml).join("");
    }).join("");
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

  const catRows = state.cache.categories.map(c => `
    <div class="list-edit-row" data-catid="${c.id}">
      <span class="lab"><span class="mini-ico" style="background:${c.color}22;color:${c.color}">${ic(c.icon)}</span><span class="lab-txt"><div>${esc(c.name)}</div></span></span>
      <input class="inline-amount" type="text" inputmode="numeric" value="${c.budget || ""}" placeholder="0" data-budget="${c.id}">
      <button class="icon-btn" data-delcat="${c.id}" title="Törlés">${ic("trash-2")}</button>
    </div>`).join("");

  const recRows = state.cache.recurring.map(r => {
    const cat = catById(r.category_id);
    const rico = r.type === "income" ? "arrow-down-left" : (cat?.icon || "package");
    const rcolor = r.type === "income" ? "var(--green)" : (cat?.color || "var(--text-muted)");
    const rtint = r.type === "income" ? "var(--green-soft)" : (cat?.color ? cat.color + "22" : "var(--surface-2)");
    return `<div class="list-edit-row">
      <span class="lab"><span class="mini-ico" style="background:${rtint};color:${rcolor}">${ic(rico)}</span>
        <span class="lab-txt"><div>${esc(r.name)}</div><small style="color:var(--text-muted);font-weight:400">${freqText(r)} · ${r.type === "income" ? "bevétel" : "kiadás"}${r.active === false ? " · szünetel" : ""}</small></span></span>
      <b style="font-size:14px;white-space:nowrap">${fmt(r.amount)}</b>
      <button class="icon-btn" data-delrec="${r.id}" title="Törlés">${ic("trash-2")}</button>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-title">Költségvetés</div>
    <div class="banner ${free < 0 ? "warn" : "info"}">${ic(free < 0 ? "triangle-alert" : "info")}
      <div>Havi bevétel: <b>${fmt(income)}</b> · Keretekre szétosztva: <b>${fmt(allocated)}</b> ·
      ${free >= 0 ? `Szabadon maradt: <b>${fmt(free)}</b>` : `<b>Túltervezés: ${fmt(-free)}</b> – csökkentsd a kereteket!`}</div>
    </div>
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
      const val = input.value.trim() === "" ? 0 : parseAmount(input.value);
      if (isNaN(val)) continue;
      const cat = catById(input.dataset.budget);
      if (cat && Number(cat.budget || 0) !== val) await state.store.update("categories", cat.id, { budget: val });
    }
    await refreshCache();
    renderView();
    toast("Költségkeretek mentve", "check");
  };
  $("#btn-add-cat").onclick = () => openCategoryModal();
  el.querySelectorAll("[data-delcat]").forEach(b => b.onclick = async () => {
    if (!confirm("Biztosan törlöd a kategóriát? A tételei 'Egyéb' nélkül maradnak.")) return;
    await state.store.remove("categories", b.dataset.delcat);
    await refreshCache(); renderView(); toast("Kategória törölve");
  });
  $("#btn-add-rec").onclick = () => openRecurringModal();
  el.querySelectorAll("[data-delrec]").forEach(b => b.onclick = async () => {
    if (!confirm("Törlöd az ismétlődő tételt? (A már könyvelt tételek megmaradnak.)")) return;
    await state.store.remove("recurring", b.dataset.delrec);
    await refreshCache(); renderView(); toast("Ismétlődő tétel törölve");
  });
}

// ============ CÉLOK ============
function renderGoals(el) {
  const cards = state.cache.goals.map(g => {
    const saved = goalSaved(g);
    const pct = Math.min(100, (saved / g.target_amount) * 100);
    const remaining = Math.max(0, g.target_amount - saved);
    let monthlyHtml = "";
    if (g.deadline && remaining > 0) {
      const now = new Date();
      const dl = new Date(g.deadline);
      const months = Math.max(1, (dl.getFullYear() - now.getFullYear()) * 12 + (dl.getMonth() - now.getMonth()));
      monthlyHtml = `<div class="goal-monthly">${ic("calendar-check")}<div>Havi <b>${fmt(remaining / months)}</b> félretételével eléred ${dl.getFullYear()}. ${MONTHS_HU[dl.getMonth()]}ig (${months} hónap)</div></div>`;
    } else if (remaining === 0) {
      monthlyHtml = `<div class="goal-monthly done">${ic("party-popper")}<div>Cél elérve! Gratulálunk!</div></div>`;
    }
    const dlText = g.deadline ? `Határidő: ${g.deadline.slice(0, 10).replaceAll("-", ". ")}.` : "Nincs határidő";
    return `<div class="goal-card">
      <div class="goal-head">
        <div class="goal-ico">${ic(g.icon || "target")}</div>
        <div style="flex:1;min-width:0"><div class="goal-name">${esc(g.name)}</div><div class="goal-deadline">${dlText}</div></div>
        <button class="icon-btn edit" data-editgoal="${g.id}" title="Szerkesztés">${ic("pencil")}</button>
        <button class="icon-btn" data-delgoal="${g.id}" title="Törlés">${ic("trash-2")}</button>
      </div>
      <div class="goal-amounts"><span>Összegyűjtve: <b>${fmt(saved)}</b></span><span>Cél: <b>${fmt(g.target_amount)}</b></span></div>
      <div class="progress" style="height:10px"><div class="progress-fill" data-w="${pct}"></div></div>
      <div class="goal-amounts"><span>${Math.round(pct)}%</span><span>Még hiányzik: ${fmt(remaining)}</span></div>
      ${monthlyHtml}
      <div class="goal-actions">
        <button class="btn btn-ghost btn-sm" data-deposit="${g.id}" style="flex:1">${ic("piggy-bank")} Félreteszek rá</button>
      </div>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-title">Céljaid</div>
    ${cards || `<div class="empty-state"><div class="empty-ico">${ic("target")}</div><p>Még nincs célod.<br>Mire gyűjtenél? Nyaralás, autó, vésztartalék?</p></div>`}
    <button class="btn btn-primary btn-block" id="btn-add-goal">${ic("plus")} Új cél hozzáadása</button>
  `;
  animateBars(el);
  $("#btn-add-goal").onclick = () => openGoalModal();
  el.querySelectorAll("[data-editgoal]").forEach(b => b.onclick = () => openGoalModal(goalById(b.dataset.editgoal)));
  el.querySelectorAll("[data-delgoal]").forEach(b => b.onclick = async () => {
    if (!confirm("Biztosan törlöd a célt?")) return;
    await state.store.remove("goals", b.dataset.delgoal);
    await refreshCache(); renderView(); toast("Cél törölve");
  });
  el.querySelectorAll("[data-deposit]").forEach(b => b.onclick = () => {
    openTxModal(null, { type: "saving", goal_id: b.dataset.deposit });
  });
}

// Időszak-adatok az egyedi oszlopdiagramhoz (Napi / Heti / Havi)
function periodData(mode) {
  const expSum = (list) => list.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  let bars = [];
  if (mode === "day") {
    const base = isCurrentMonth(state.month) ? today0() : new Date(state.month.getFullYear(), state.month.getMonth(), daysInMonth(state.month));
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base); d.setDate(base.getDate() - i); const ds = isoDate(d);
      bars.push({ label: DAYS_HU[d.getDay()].slice(0, 2), value: expSum(realized(state.cache.transactions.filter(t => t.date === ds))) });
    }
  } else if (mode === "week") {
    const dim = daysInMonth(state.month);
    const weeks = {};
    realizedOfMonth().filter(t => t.type === "expense").forEach(t => { const day = parseInt(t.date.slice(8, 10), 10); weeks[Math.floor((day - 1) / 7)] = (weeks[Math.floor((day - 1) / 7)] || 0) + Number(t.amount); });
    for (let w = 0; w < Math.ceil(dim / 7); w++) bars.push({ label: (w + 1) + ".", value: weeks[w] || 0 });
  } else {
    for (let i = 5; i >= 0; i--) { const mo = new Date(state.month.getFullYear(), state.month.getMonth() - i, 1); bars.push({ label: MONTHS_HU[mo.getMonth()].slice(0, 3), value: expSum(realizedOfMonth(mo)), cur: monthKey(mo) === monthKey(state.month) }); }
  }
  const max = Math.max(1, ...bars.map(b => b.value));
  let activeIdx = bars.reduce((mi, b, i, arr) => (b.value > arr[mi].value ? i : mi), 0);
  if (mode === "month") { const ci = bars.findIndex(b => b.cur); if (ci >= 0) activeIdx = ci; }
  bars.forEach((b, i) => (b.active = i === activeIdx));
  return { bars, max, total: bars.reduce((s, b) => s + b.value, 0) };
}

// ============ STATISZTIKÁK ============
function renderStats(el) {
  const tx = realizedOfMonth();   // statisztika: csak teljesített tételek (pending kizárva)
  const expenses = tx.filter(t => t.type === "expense");
  const prevMonth = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  const C = themeColors();

  // Kategória-bontás aktuális + előző hónap (trendhez)
  const byCat = {};
  expenses.forEach(t => { const id = t.category_id || "_"; byCat[id] = (byCat[id] || 0) + Number(t.amount); });
  const prevByCat = {};
  realizedOfMonth(prevMonth).filter(t => t.type === "expense").forEach(t => { const id = t.category_id || "_"; prevByCat[id] = (prevByCat[id] || 0) + Number(t.amount); });
  const catSorted = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const totalExp = sumBy(tx, "expense");

  const catRows = catSorted.map(id => {
    const c = catById(id);
    const sum = byCat[id], prev = prevByCat[id] || 0;
    let trend = "";
    if (prev > 0) { const p = Math.round((sum - prev) / prev * 100); trend = `<span class="trend ${p > 0 ? "down" : "up"}">${ic(p > 0 ? "trending-up" : "trending-down")} ${p > 0 ? "+" : ""}${p}%</span>`; }
    else if (sum > 0) trend = `<span class="trend down">${ic("trending-up")} új</span>`;
    const color = c?.color || "#64748b";
    return `<div class="catrow">
      <div class="tx-ico" style="background:${color}22;color:${color}">${ic(c?.icon || "package")}</div>
      <div class="catrow-info"><div class="catrow-name">${esc(c?.name || "Egyéb")}</div><div class="catrow-total">${fmt(sum)} · ${totalExp ? Math.round(sum / totalExp * 100) : 0}%</div></div>
      ${trend}
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-title">Statisztika</div>
    <div class="card" id="period-card">
      <div class="segment" id="period-seg">
        <button data-pm="day" class="active">Napi</button>
        <button data-pm="week">Heti</button>
        <button data-pm="month">Havi</button>
      </div>
      <div class="chart-total"><div class="amt" id="period-total"></div><div class="lbl">összes kiadás az időszakban</div></div>
      <div class="barchart" id="period-bars"></div>
      <div class="chart-hint">Érintsd meg a füleket a nézet váltásához</div>
    </div>

    <div class="card">
      <div class="card-title">Kiadások kategóriánként <span style="color:var(--text-muted);font-weight:600">${monthLabel(state.month)}</span></div>
      ${catRows || `<div class="empty-state"><div class="empty-ico">${ic("chart-pie")}</div><p>Nincs kiadás ebben a hónapban.</p></div>`}
    </div>

    <div class="card"><div class="card-title">Bevétel vs. kiadás <span style="color:var(--text-muted);font-weight:600">utolsó 6 hónap</span></div>
      <div class="chart-box"><canvas id="chart-bar"></canvas></div></div>
    <div class="card"><div class="card-title">Halmozott napi költés <span style="color:var(--text-muted);font-weight:600">e havi vs. előző havi</span></div>
      <div class="chart-box" style="height:210px"><canvas id="chart-line"></canvas></div></div>

    <div class="row-2">
      <div class="card"><div class="card-title">Átlagok</div><div id="stats-avgs"></div></div>
      <div class="card"><div class="card-title">Top 5 kiadás</div><div id="stats-top"></div></div>
    </div>
  `;

  // --- Egyedi időszak-oszlopdiagram (váltható) ---
  let pmode = "day";
  function renderPeriod() {
    const d = periodData(pmode);
    $("#period-total").innerHTML = fmtHTML(d.total);
    $("#period-bars").innerHTML = d.bars.map(b => `
      <div class="bar-col ${b.active ? "active" : ""}" title="${esc(b.label)}: ${fmt(b.value)}">
        <div class="bar-track"><div class="bar-fill" data-h="${d.max ? Math.round(b.value / d.max * 100) : 0}"></div></div>
        <div class="bar-label">${esc(b.label)}</div>
      </div>`).join("");
    animateBars($("#period-card"));
  }
  $("#period-seg").querySelectorAll("button").forEach(b => b.onclick = () => {
    pmode = b.dataset.pm;
    $("#period-seg").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    renderPeriod();
  });
  renderPeriod();

  // --- 6 havi oszlopdiagram (Chart.js, témázott) ---
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(state.month.getFullYear(), state.month.getMonth() - i, 1));
  const incomeData = months.map(m => sumBy(realizedOfMonth(m), "income"));
  const expenseData = months.map(m => sumBy(realizedOfMonth(m), "expense"));
  state.charts.bar = new Chart($("#chart-bar"), {
    type: "bar",
    data: { labels: months.map(m => MONTHS_HU[m.getMonth()].slice(0, 3)), datasets: [
      { label: "Bevétel", data: incomeData, backgroundColor: C.green, borderRadius: 7, maxBarThickness: 26 },
      { label: "Kiadás", data: expenseData, backgroundColor: C.primary, borderRadius: 7, maxBarThickness: 26 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, color: C.muted, font: { family: "Inter", size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: C.muted } }, y: { grid: { color: C.grid }, ticks: { color: C.muted, callback: (v) => (v / 1000) + "k" } } } },
  });

  // --- Halmozott vonal ---
  const cumul = (m) => { const dim = daysInMonth(m); const daily = new Array(dim).fill(0); realizedOfMonth(m).filter(t => t.type === "expense").forEach(t => { const day = parseInt(t.date.slice(8, 10), 10); if (day >= 1 && day <= dim) daily[day - 1] += Number(t.amount); }); let run = 0; return daily.map(v => (run += v)); };
  const curC = cumul(state.month), prevC = cumul(prevMonth);
  const maxDays = Math.max(curC.length, prevC.length);
  let curTrim = curC; if (isCurrentMonth(state.month)) curTrim = curC.slice(0, new Date().getDate());
  state.charts.line = new Chart($("#chart-line"), {
    type: "line",
    data: { labels: Array.from({ length: maxDays }, (_, i) => i + 1), datasets: [
      { label: monthLabel(state.month), data: curTrim, borderColor: C.primary, backgroundColor: "transparent", fill: false, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      { label: monthLabel(prevMonth), data: prevC, borderColor: C.muted, borderDash: [5, 5], fill: false, tension: .35, pointRadius: 0, borderWidth: 2 },
    ]},
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

  el.innerHTML = `
    <div class="section-title">Profil</div>

    <div class="card">
      <div class="greet" style="margin:0;display:flex">
        <div class="greet-avatar">${esc(initial)}</div>
        <div class="greet-text"><div class="greet-name">${esc(name || "Vendég")}</div><div class="greet-hi">${isCloud ? esc(state.user?.email || "") : "Helyi mód (nincs fiók)"}</div></div>
      </div>
    </div>

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
      <div class="setting-row" style="border:none;padding-bottom:0">
        <div class="setting-ico">${ic("circle-dollar-sign")}</div>
        <div class="grow"><div class="t">Megjelenített valuta</div><div class="s">Minden összeg ebben jelenik meg</div></div>
        <select id="cur-select" style="width:auto;padding:11px 13px;border:1.5px solid var(--border);border-radius:12px;background:var(--surface-2);font-weight:600">
          ${Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}" ${k === curCode ? "selected" : ""}>${c.label}</option>`).join("")}
        </select>
      </div>
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

    <div class="card">
      <div class="card-title">Alkalmazás</div>
      <button class="btn btn-ghost btn-block" id="btn-install" style="margin-bottom:10px">${ic("download")} Telepítés telefonra / gépre</button>
      <button class="btn btn-ghost btn-block" id="btn-export" style="margin-bottom:10px">${ic("file-down")} Adatok exportálása (CSV)</button>
      <button class="btn btn-danger btn-block" id="btn-logout">${ic("log-out")} ${isCloud ? "Kijelentkezés" : "Kilépés a helyi módból"}</button>
      ${!isCloud ? `<button class="btn btn-danger btn-block" id="btn-wipe" style="margin-top:10px">${ic("trash-2")} Helyi adatok törlése</button>` : ""}
    </div>
    <p style="text-align:center;color:var(--text-faint);font-size:12px">MoneyManage (MM) v1.2</p>
  `;

  $("#seg-theme").querySelectorAll("button").forEach(b => b.onclick = () => { setSetting("theme", b.dataset.theme); applyTheme(); });
  $("#cur-select").onchange = (e) => { setSetting("currency", e.target.value); renderView(); toast("Pénznem módosítva", "check"); };
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

  $("#btn-logout").onclick = logout;
  $("#btn-export").onclick = exportCSV;
  $("#btn-install").onclick = async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
    } else {
      alert("Telepítés:\n\nAndroidon (Chrome): menü → „Alkalmazás telepítése”\niPhone-on (Safari): Megosztás → „Hozzáadás a kezdőképernyőhöz”\nGépen (Chrome/Edge): a címsor jobb oldalán a telepítés ikon");
    }
  };
  const wipeBtn = $("#btn-wipe");
  if (wipeBtn) wipeBtn.onclick = async () => {
    if (!confirm("Minden helyi adat (tételek, célok, keretek) VÉGLEGESEN törlődik. Biztos?")) return;
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

// ---------- Tranzakció modál (új / szerkesztés) ----------
function openTxModal(tx = null, preset = {}) {
  const isEdit = !!tx;
  let type = tx?.type || preset.type || "expense";
  let categoryId = tx?.category_id || preset.category_id || state.cache.categories[0]?.id || null;
  let goalId = tx?.goal_id || preset.goal_id || state.cache.goals.filter(g => !g.done)[0]?.id || null;
  const linkedRec = tx?.recurring_id ? state.cache.recurring.find(r => r.id === tx.recurring_id) : null;

  const noteSuggestions = [...new Set(state.cache.transactions.map(t => t.note).filter(Boolean))].slice(0, 30);
  const goalOptions = state.cache.goals.map(g => `<option value="${g.id}" ${g.id === goalId ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  const curMeta = CURRENCIES[currentCurrency()];

  openModal(isEdit ? "Tétel szerkesztése" : "Új tétel", `
    <div class="type-switch" id="tx-type-switch">
      <button data-type="expense" class="${type === "expense" ? "active" : ""}">${ic("arrow-up-right")} Kiadás</button>
      <button data-type="income" class="${type === "income" ? "active" : ""}">${ic("arrow-down-left")} Bevétel</button>
      <button data-type="saving" class="${type === "saving" ? "active" : ""}">${ic("piggy-bank")} Félretétel</button>
    </div>
    <div class="field">
      <div class="amount-wrap">
        <input type="text" id="tx-amount" inputmode="decimal" placeholder="0" value="${tx ? tx.amount : ""}" autocomplete="off">
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
      <input type="text" id="tx-note" placeholder="Pl. heti bevásárlás" value="${esc(tx?.note || "")}" list="note-suggestions" autocomplete="off">
      <datalist id="note-suggestions">${noteSuggestions.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
      <p class="field-hint" id="cat-suggest-hint" style="display:none"></p>
    </div>
    <div class="field" id="tx-cat-field" style="${type === "expense" ? "" : "display:none"}">
      <label>Kategória</label>
      <div class="cat-grid" id="tx-cat-grid">
        ${state.cache.categories.map(c => `<button type="button" class="cat-pick ${c.id === categoryId ? "active" : ""}" data-cat="${c.id}">${ic(c.icon)}<span>${esc(c.name)}</span></button>`).join("")}
      </div>
    </div>
    <div class="field" id="tx-goal-field" style="${type === "saving" ? "" : "display:none"}">
      <label>Melyik célra teszel félre?</label>
      <select id="tx-goal">${goalOptions || `<option value="">Nincs cél – általános megtakarítás</option>`}</select>
    </div>
    <div class="field">
      <label>Dátum</label>
      <input type="date" id="tx-date" value="${tx?.date || todayStr()}">
      <p class="field-hint" id="tx-future-hint" style="display:none">Jövőbeli dátum – <b>tervezett</b> tételként kerül be: a hó végi egyenlegbe beleszámít, a statisztikába még nem. Később a tételsoron a pipa gombbal jelölheted teljesítettnek.</p>
    </div>
    <div class="field">
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
  });

  // Gyorsösszegek
  $$("[data-addamount]").forEach(b => b.onclick = () => {
    const cur = parseAmount($("#tx-amount").value) || 0;
    $("#tx-amount").value = cur + Number(b.dataset.addamount);
  });
  const clearBtn = document.querySelector("[data-clearamount]");
  if (clearBtn) clearBtn.onclick = () => { $("#tx-amount").value = ""; $("#tx-amount").focus(); };

  // Kategóriaválasztó
  $("#tx-cat-grid")?.querySelectorAll(".cat-pick").forEach(b => b.onclick = () => {
    categoryId = b.dataset.cat;
    $("#tx-cat-grid").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x === b));
  });

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

  // Jövőbeli dátum jelzése
  const updateFutureHint = () => {
    const d = $("#tx-date").value;
    $("#tx-future-hint").style.display = (d && isFutureDate(d)) ? "block" : "none";
  };
  $("#tx-date").onchange = updateFutureHint;
  updateFutureHint();

  // Ismétlődés kapcsoló
  $("#tx-recurring").onchange = (e) => {
    $("#tx-recur-opts").style.display = e.target.checked ? "block" : "none";
  };

  // Mentés
  $("#tx-save").onclick = async () => {
    const amount = parseAmount($("#tx-amount").value);
    if (isNaN(amount) || amount <= 0) { toast("Adj meg érvényes összeget!"); return; }
    const note = $("#tx-note").value.trim();
    const date = $("#tx-date").value || todayStr();
    const pending = isFutureDate(date);
    const recurOn = $("#tx-recurring")?.checked;
    const unit = $("#tx-recur-unit")?.value || "month";
    const count = Math.max(1, parseInt($("#tx-recur-count")?.value, 10) || 1);
    const row = {
      type, amount, note, date, pending,
      category_id: type === "expense" ? categoryId : null,
      goal_id: type === "saving" ? ($("#tx-goal")?.value || null) : null,
    };
    try {
      if (isEdit) {
        if (recurOn && linkedRec) {
          // meglévő sorozat frissítése (a jövőbeli könyveléseket érinti)
          await state.store.update("recurring", linkedRec.id, {
            name: note || linkedRec.name, amount, type, category_id: row.category_id,
            interval_unit: unit, interval_count: count, active: true,
          });
          row.recurring_id = linkedRec.id;
        } else if (recurOn && !linkedRec) {
          // most tették ismétlődővé
          const rec = await state.store.insert("recurring", {
            name: note || (type === "income" ? "Bevétel" : "Kiadás"), amount, type,
            category_id: row.category_id, interval_unit: unit, interval_count: count,
            anchor_date: date, active: true,
          });
          row.recurring_id = rec.id;
        } else if (!recurOn && linkedRec) {
          // kikapcsolták az ismétlődést → a sorozatot szüneteltetjük
          await state.store.update("recurring", linkedRec.id, { active: false });
          row.recurring_id = null;
        }
        await state.store.update("transactions", tx.id, row);
      } else {
        if (recurOn) {
          // a sorozat létrehozása, az eredeti tételt hozzákötjük (így nem duplázódik könyveléskor)
          const rec = await state.store.insert("recurring", {
            name: note || (type === "income" ? "Bevétel" : "Kiadás"), amount, type,
            category_id: row.category_id, interval_unit: unit, interval_count: count,
            anchor_date: date, active: true,
          });
          row.recurring_id = rec.id;
        }
        await state.store.insert("transactions", row);
      }
      await refreshCache();
      closeModal();
      renderView();
      toast(isEdit ? "Tétel módosítva" : (recurOn ? "Tétel + ismétlődés mentve" : "Tétel hozzáadva"), "check");
    } catch (e) {
      toast("Mentési hiba – próbáld újra");
    }
  };

  // Törlés
  const delBtn = $("#tx-delete");
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm("Biztosan törlöd ezt a tételt?")) return;
    await state.store.remove("transactions", tx.id);
    await refreshCache(); closeModal(); renderView(); toast("Tétel törölve");
  };

  if (!isEdit) setTimeout(() => $("#tx-amount").focus(), 100);
}

// ---------- Cél modál ----------
function openGoalModal(goal = null) {
  const isEdit = !!goal;
  const icons = ["target", "umbrella", "car", "house", "gem", "graduation-cap", "laptop", "shield", "plane", "music", "baby", "dog"];
  const sel = iconName(goal?.icon || "target");
  openModal(isEdit ? "Cél szerkesztése" : "Új cél", `
    <div class="field"><label>Mi a célod?</label>
      <input type="text" id="goal-name" placeholder="Pl. nyaralás, autó, vésztartalék" value="${esc(goal?.name || "")}"></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))" id="goal-icons">
        ${icons.map(i => `<button type="button" class="cat-pick icononly ${sel === i ? "active" : ""}" data-icon="${i}">${ic(i)}</button>`).join("")}
      </div></div>
    <div class="field"><label>Célösszeg</label>
      <input type="text" id="goal-target" inputmode="decimal" placeholder="Pl. 300k" value="${goal?.target_amount || ""}">
      <p class="field-hint">Tipp: „300k" = 300 000</p></div>
    <div class="field"><label>Már megvan ennyi (kezdőösszeg)</label>
      <input type="text" id="goal-start" inputmode="decimal" placeholder="0" value="${goal?.start_amount || ""}"></div>
    <div class="field"><label>Határidő (nem kötelező)</label>
      <input type="date" id="goal-deadline" value="${goal?.deadline ? goal.deadline.slice(0, 10) : ""}"></div>
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
    const target = parseAmount($("#goal-target").value);
    const start = parseAmount($("#goal-start").value) || 0;
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
    const target = parseAmount($("#goal-target").value);
    if (!name || isNaN(target) || target <= 0) { toast("Add meg a cél nevét és összegét!"); return; }
    const row = {
      name, icon, target_amount: target,
      start_amount: parseAmount($("#goal-start").value) || 0,
      deadline: $("#goal-deadline").value || null,
    };
    if (isEdit) await state.store.update("goals", goal.id, row);
    else await state.store.insert("goals", row);
    await refreshCache(); closeModal(); renderView();
    toast(isEdit ? "Cél módosítva" : "Cél létrehozva", "check");
  };
}

// ---------- Kategória modál ----------
function openCategoryModal() {
  const icons = ["house", "shopping-cart", "bus", "car", "party-popper", "pill", "shirt", "smartphone", "package", "gamepad-2", "book-open", "coffee", "scissors", "gift", "dumbbell", "plane", "graduation-cap", "heart", "utensils", "wifi", "dog", "music", "briefcase", "fuel"];
  const colors = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#4f46e5", "#64748b", "#db2777", "#65a30d"];
  openModal("Új kategória", `
    <div class="field"><label>Név</label><input type="text" id="cat-name" placeholder="Pl. Hobbi"></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))" id="cat-icons">
        ${icons.map((i, x) => `<button type="button" class="cat-pick icononly ${x === 0 ? "active" : ""}" data-icon="${i}">${ic(i)}</button>`).join("")}
      </div></div>
    <div class="field"><label>Havi keret (nem kötelező)</label>
      <input type="text" id="cat-budget" inputmode="decimal" placeholder="Pl. 10k"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="cat-save">Létrehozás</button></div>
  `);
  let icon = icons[0];
  $("#cat-icons").querySelectorAll(".cat-pick").forEach(b => b.onclick = () => {
    icon = b.dataset.icon;
    $("#cat-icons").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x === b));
  });
  $("#cat-save").onclick = async () => {
    const name = $("#cat-name").value.trim();
    if (!name) { toast("Adj nevet a kategóriának!"); return; }
    await state.store.insert("categories", {
      name, icon, color: colors[state.cache.categories.length % colors.length],
      budget: parseAmount($("#cat-budget").value) || 0, sort: state.cache.categories.length,
    });
    await refreshCache(); closeModal(); renderView(); toast("Kategória létrehozva", "check");
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
    const amount = parseAmount($("#rec-amount").value);
    const count = Math.max(1, parseInt($("#rec-count").value, 10) || 1);
    const unit = $("#rec-unit").value || "month";
    const anchor = $("#rec-anchor").value || todayStr();
    if (!name || isNaN(amount) || amount <= 0) { toast("Add meg a nevet és az összeget!"); return; }
    await state.store.insert("recurring", {
      name, amount, type, active: true,
      category_id: type === "expense" ? $("#rec-cat").value : null,
      interval_unit: unit, interval_count: count, anchor_date: anchor,
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
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ============ START ============
initAuth();
