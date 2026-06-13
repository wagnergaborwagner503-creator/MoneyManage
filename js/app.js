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

// ---------- Segédfüggvények ----------
const fmt = (n) => (Math.round(n) || 0).toLocaleString("hu-HU") + " Ft";
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const isCurrentMonth = (d) => monthKey(d) === monthKey(new Date());
const monthLabel = (d) => `${d.getFullYear()}. ${MONTHS_HU[d.getMonth()]}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
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
async function applyRecurring() {
  const now = new Date();
  const key = monthKey(now);
  let added = 0;
  for (const r of state.cache.recurring) {
    if (!r.active) continue;
    const day = Math.min(Number(r.day || 1), daysInMonth(now));
    if (now.getDate() < day) continue; // még nem jött el a napja
    const exists = state.cache.transactions.some(t => t.recurring_id === r.id && (t.date || "").startsWith(key));
    if (exists) continue;
    await state.store.insert("transactions", {
      type: r.type, amount: r.amount, category_id: r.category_id || null,
      note: r.name, date: `${key}-${String(day).padStart(2, "0")}`, recurring_id: r.id,
    });
    added++;
  }
  if (added) {
    await refreshCache();
    toast(`${added} ismétlődő tétel automatikusan könyvelve ✓`);
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
    showAuthError(error ? "Hiba: " + error.message : "Jelszó-visszaállító e-mail elküldve! 📧", !error);
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
  $("#sidebar-user").textContent = (store.mode === "cloud" ? "☁️ " : "📱 ") + who;

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
}

// ============ ÁTTEKINTÉS (Dashboard) ============
function renderDashboard(el) {
  const tx = txOfMonth();
  const income = sumBy(tx, "income");
  const expense = sumBy(tx, "expense");
  const saving = sumBy(tx, "saving");
  const balance = income - expense - saving;

  const now = new Date();
  const dim = daysInMonth(state.month);
  let dailyHtml = "", projHtml = "";
  if (isCurrentMonth(state.month)) {
    const daysLeft = dim - now.getDate() + 1;
    const daily = balance > 0 ? balance / daysLeft : 0;
    dailyHtml = `<div class="stat-card"><div class="stat-label">📅 Napi keret</div>
      <div class="stat-value blue">${fmt(daily)}</div>
      <div class="stat-sub">még ${daysLeft} napra elosztva</div></div>`;
    const elapsed = now.getDate();
    const projected = elapsed > 0 ? (expense / elapsed) * dim : 0;
    const projBalance = income - projected - saving;
    projHtml = `<div class="banner ${projBalance < 0 ? "warn" : "info"}">
      🔮 <b>Hó végi előrejelzés:</b> a jelenlegi tempóban kb. <b>${fmt(projected)}</b> lesz az összes kiadásod,
      így várhatóan <b>${fmt(projBalance)}</b> marad a hónap végén.</div>`;
  }

  // Költségkeretek állapota
  const budgetCats = state.cache.categories.filter(c => Number(c.budget) > 0);
  const spentByCat = {};
  tx.filter(t => t.type === "expense").forEach(t => {
    spentByCat[t.category_id] = (spentByCat[t.category_id] || 0) + Number(t.amount);
  });
  const budgetRows = budgetCats.map(c => {
    const spent = spentByCat[c.id] || 0;
    const pct = Math.min(100, (spent / c.budget) * 100);
    const cls = spent > c.budget ? "over" : pct > 85 ? "warn" : "ok";
    return `<div class="budget-row">
      <div class="budget-row-head">
        <span class="budget-row-name">${c.icon} ${esc(c.name)}</span>
        <span class="budget-row-vals"><b>${fmt(spent)}</b> / ${fmt(c.budget)}</span>
      </div>
      <div class="progress"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");

  // Utolsó tranzakciók
  const recent = tx.slice(0, 5).map(txItemHtml).join("");

  // Célok mini
  const goalsMini = state.cache.goals.filter(g => !g.done).slice(0, 3).map(g => {
    const saved = goalSaved(g);
    const pct = Math.min(100, (saved / g.target_amount) * 100);
    return `<div class="budget-row">
      <div class="budget-row-head">
        <span class="budget-row-name">${g.icon || "🎯"} ${esc(g.name)}</span>
        <span class="budget-row-vals"><b>${fmt(saved)}</b> / ${fmt(g.target_amount)} (${Math.round(pct)}%)</span>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card highlight"><div class="stat-label">💰 Hó végén marad</div>
        <div class="stat-value">${fmt(balance)}</div>
        <div class="stat-sub">bevétel − kiadás − megtakarítás</div></div>
      <div class="stat-card"><div class="stat-label">📈 Bevétel</div>
        <div class="stat-value pos">${fmt(income)}</div></div>
      <div class="stat-card"><div class="stat-label">📉 Kiadás</div>
        <div class="stat-value neg">${fmt(expense)}</div></div>
      ${dailyHtml || `<div class="stat-card"><div class="stat-label">🏦 Megtakarítás</div>
        <div class="stat-value blue">${fmt(saving)}</div></div>`}
    </div>
    ${projHtml}
    <div class="row-2">
      <div class="card">
        <div class="card-title">Költségkeretek <button class="btn-link" data-goto="budget">Szerkesztés ›</button></div>
        ${budgetRows || `<div class="empty-state"><div class="empty-ico">📋</div><p>Még nincsenek költségkeretek.<br>Állítsd be a Költségvetés fülön!</p></div>`}
      </div>
      <div class="card">
        <div class="card-title">Utolsó tételek <button class="btn-link" data-goto="transactions">Összes ›</button></div>
        ${recent || `<div class="empty-state"><div class="empty-ico">🧾</div><p>Még nincs tétel ebben a hónapban.<br>Nyomd meg a + gombot!</p></div>`}
      </div>
    </div>
    ${goalsMini ? `<div class="card"><div class="card-title">Céljaid <button class="btn-link" data-goto="goals">Összes ›</button></div>${goalsMini}</div>` : ""}
  `;
  el.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => switchView(b.dataset.goto));
  el.querySelectorAll("[data-txid]").forEach(item => item.onclick = () => {
    const t = state.cache.transactions.find(x => x.id === item.dataset.txid);
    if (t) openTxModal(t);
  });
}

function txItemHtml(t) {
  const cat = catById(t.category_id);
  const goal = t.goal_id ? goalById(t.goal_id) : null;
  const ico = t.type === "income" ? "💵" : t.type === "saving" ? (goal?.icon || "🏦") : (cat?.icon || "📦");
  const bg = t.type === "income" ? "var(--green-bg)" : t.type === "saving" ? "var(--blue-50)" : (cat?.color ? cat.color + "1a" : "var(--bg)");
  const sub = t.type === "income" ? "Bevétel" : t.type === "saving" ? `Megtakarítás${goal ? " → " + esc(goal.name) : ""}` : (cat?.name || "Egyéb");
  const sign = t.type === "income" ? "+" : "−";
  return `<div class="tx-item" data-txid="${t.id}">
    <div class="tx-ico" style="background:${bg}">${ico}</div>
    <div class="tx-info"><div class="tx-name">${esc(t.note) || sub}</div><div class="tx-cat">${sub}${t.recurring_id ? " · 🔁" : ""}</div></div>
    <div class="tx-amount ${t.type}">${sign} ${fmt(t.amount)}</div>
  </div>`;
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
    if (!list.length) return `<div class="empty-state"><div class="empty-ico">🔍</div><p>Nincs találat ebben a hónapban.</p></div>`;
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

  const catOptions = state.cache.categories.map(c => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join("");
  el.innerHTML = `
    <div class="filter-bar">
      <input type="search" id="tx-search" placeholder="🔍 Keresés a tételek közt...">
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
    bindTxClicks();
  };
  function bindTxClicks() {
    el.querySelectorAll("[data-txid]").forEach(item => item.onclick = () => {
      const t = state.cache.transactions.find(x => x.id === item.dataset.txid);
      if (t) openTxModal(t);
    });
  }
  $("#tx-search").oninput = (e) => { search = e.target.value; rerender(); };
  $("#tx-filter-type").onchange = (e) => { filterType = e.target.value; rerender(); };
  $("#tx-filter-cat").onchange = (e) => { filterCat = e.target.value; rerender(); };
  bindTxClicks();
}

// ============ KÖLTSÉGVETÉS ============
function renderBudget(el) {
  const tx = txOfMonth();
  const income = sumBy(tx, "income");
  const allocated = state.cache.categories.reduce((s, c) => s + Number(c.budget || 0), 0);
  const free = income - allocated;

  const catRows = state.cache.categories.map(c => `
    <div class="list-edit-row" data-catid="${c.id}">
      <span class="lab">${c.icon} ${esc(c.name)}</span>
      <input class="inline-amount" type="text" inputmode="numeric" value="${c.budget || ""}" placeholder="0" data-budget="${c.id}">
      <button class="icon-btn" data-delcat="${c.id}" title="Törlés">🗑</button>
    </div>`).join("");

  const recRows = state.cache.recurring.map(r => {
    const cat = catById(r.category_id);
    return `<div class="list-edit-row">
      <span class="lab">${r.type === "income" ? "💵" : (cat?.icon || "📦")} ${esc(r.name)}
        <small style="color:var(--text-muted);font-weight:400">· ${r.day}. nap · ${r.type === "income" ? "bevétel" : "kiadás"}</small></span>
      <b style="font-size:14px">${fmt(r.amount)}</b>
      <button class="icon-btn" data-delrec="${r.id}" title="Törlés">🗑</button>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="banner ${free < 0 ? "warn" : "info"}">
      💡 Havi bevétel: <b>${fmt(income)}</b> · Keretekre szétosztva: <b>${fmt(allocated)}</b> ·
      ${free >= 0 ? `Szabadon maradt: <b>${fmt(free)}</b>` : `<b>Túltervezés: ${fmt(-free)}</b> – csökkentsd a kereteket!`}
    </div>
    <div class="card">
      <div class="card-title">Havi költségkeretek kategóriánként
        <button class="btn-link" id="btn-add-cat">+ Új kategória</button></div>
      <p class="field-hint" style="margin-bottom:10px">Írd be, mennyit szánsz az adott kategóriára havonta. Tipp: "15k" = 15 000 Ft.</p>
      ${catRows}
      <button class="btn btn-primary btn-block" id="btn-save-budgets" style="margin-top:16px">Keretek mentése</button>
    </div>
    <div class="card">
      <div class="card-title">🔁 Ismétlődő havi tételek
        <button class="btn-link" id="btn-add-rec">+ Új ismétlődő</button></div>
      <p class="field-hint" style="margin-bottom:10px">Pl. fizetés, albérlet, előfizetések – ezek minden hónapban automatikusan könyvelődnek a megadott napon.</p>
      ${recRows || `<div class="empty-state"><div class="empty-ico">🔁</div><p>Még nincs ismétlődő tétel.<br>Add hozzá a fizetésed és a fix kiadásaid!</p></div>`}
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
    toast("Költségkeretek mentve ✓");
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
      monthlyHtml = `<div class="goal-monthly">📌 Havi ${fmt(remaining / months)} félretételével eléred ${dl.getFullYear()}. ${MONTHS_HU[dl.getMonth()]}ig (${months} hónap)</div>`;
    } else if (remaining === 0) {
      monthlyHtml = `<div class="goal-monthly" style="background:var(--green-bg);color:var(--green)">🎉 Cél elérve! Gratulálunk!</div>`;
    }
    const dlText = g.deadline ? `Határidő: ${g.deadline.slice(0, 10).replaceAll("-", ". ")}.` : "Nincs határidő";
    return `<div class="goal-card">
      <div class="goal-head">
        <div class="goal-ico">${g.icon || "🎯"}</div>
        <div style="flex:1"><div class="goal-name">${esc(g.name)}</div><div class="goal-deadline">${dlText}</div></div>
        <button class="icon-btn" data-editgoal="${g.id}" title="Szerkesztés">✏️</button>
        <button class="icon-btn" data-delgoal="${g.id}" title="Törlés">🗑</button>
      </div>
      <div class="goal-amounts"><span>Összegyűjtve: <b>${fmt(saved)}</b></span><span>Cél: <b>${fmt(g.target_amount)}</b></span></div>
      <div class="progress" style="height:10px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="goal-amounts"><span>${Math.round(pct)}%</span><span>Még hiányzik: ${fmt(remaining)}</span></div>
      ${monthlyHtml}
      <div class="goal-actions">
        <button class="btn btn-ghost btn-sm" data-deposit="${g.id}" style="flex:1">💸 Félreteszek rá</button>
      </div>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-title">Hosszú távú céljaid 🎯</div>
    ${cards || `<div class="empty-state"><div class="empty-ico">🎯</div><p>Még nincs célod.<br>Mire gyűjtenél? Nyaralás, autó, vésztartalék?</p></div>`}
    <button class="btn btn-primary btn-block" id="btn-add-goal">+ Új cél hozzáadása</button>
  `;
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

// ============ STATISZTIKÁK ============
function renderStats(el) {
  el.innerHTML = `
    <div class="row-2">
      <div class="card"><div class="card-title">Kiadások megoszlása – ${monthLabel(state.month)}</div>
        <div class="chart-box"><canvas id="chart-pie" height="240"></canvas></div></div>
      <div class="card"><div class="card-title">Bevétel vs. kiadás – utolsó 6 hónap</div>
        <div class="chart-box"><canvas id="chart-bar" height="240"></canvas></div></div>
    </div>
    <div class="card"><div class="card-title">Halmozott napi költés – e havi vs. előző havi</div>
      <div class="chart-box"><canvas id="chart-line" height="200"></canvas></div></div>
    <div class="row-2">
      <div class="card"><div class="card-title">Átlagok és érdekességek</div><div id="stats-avgs"></div></div>
      <div class="card"><div class="card-title">Top 5 legnagyobb kiadás (${monthLabel(state.month)})</div><div id="stats-top"></div></div>
    </div>
  `;

  const tx = txOfMonth();
  const expenses = tx.filter(t => t.type === "expense");

  // --- Kördiagram kategóriánként ---
  const byCat = {};
  expenses.forEach(t => {
    const c = catById(t.category_id);
    const name = c ? `${c.icon} ${c.name}` : "📦 Egyéb";
    byCat[name] = { sum: (byCat[name]?.sum || 0) + Number(t.amount), color: c?.color || "#64748b" };
  });
  const pieLabels = Object.keys(byCat);
  if (pieLabels.length) {
    state.charts.pie = new Chart($("#chart-pie"), {
      type: "doughnut",
      data: { labels: pieLabels, datasets: [{ data: pieLabels.map(l => byCat[l].sum), backgroundColor: pieLabels.map(l => byCat[l].color), borderWidth: 2, borderColor: "#fff" }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { family: "Inter", size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${fmt(c.parsed)}` } } }, cutout: "62%" },
    });
  } else {
    $("#chart-pie").closest(".chart-box").innerHTML = `<div class="empty-state"><div class="empty-ico">📊</div><p>Nincs kiadás ebben a hónapban.</p></div>`;
  }

  // --- 6 havi oszlopdiagram ---
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(state.month.getFullYear(), state.month.getMonth() - i, 1));
  const incomeData = months.map(m => sumBy(txOfMonth(m), "income"));
  const expenseData = months.map(m => sumBy(txOfMonth(m), "expense"));
  state.charts.bar = new Chart($("#chart-bar"), {
    type: "bar",
    data: {
      labels: months.map(m => MONTHS_HU[m.getMonth()].slice(0, 3) + "."),
      datasets: [
        { label: "Bevétel", data: incomeData, backgroundColor: "#16a34a", borderRadius: 6 },
        { label: "Kiadás", data: expenseData, backgroundColor: "#3b82f6", borderRadius: 6 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { family: "Inter", size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { y: { ticks: { callback: (v) => (v / 1000) + "k" } } },
    },
  });

  // --- Halmozott vonal: aktuális vs előző hónap ---
  const prevMonth = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  const cumul = (m) => {
    const dim = daysInMonth(m);
    const daily = new Array(dim).fill(0);
    txOfMonth(m).filter(t => t.type === "expense").forEach(t => {
      const day = parseInt(t.date.slice(8, 10), 10);
      if (day >= 1 && day <= dim) daily[day - 1] += Number(t.amount);
    });
    let run = 0;
    return daily.map(v => (run += v));
  };
  const curC = cumul(state.month), prevC = cumul(prevMonth);
  const maxDays = Math.max(curC.length, prevC.length);
  // jövőbeli napok levágása az aktuális hónapnál
  let curTrim = curC;
  if (isCurrentMonth(state.month)) curTrim = curC.slice(0, new Date().getDate());
  state.charts.line = new Chart($("#chart-line"), {
    type: "line",
    data: {
      labels: Array.from({ length: maxDays }, (_, i) => i + 1),
      datasets: [
        { label: monthLabel(state.month), data: curTrim, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.08)", fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2.5 },
        { label: monthLabel(prevMonth), data: prevC, borderColor: "#94a3b8", borderDash: [5, 5], fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { family: "Inter", size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { y: { ticks: { callback: (v) => (v / 1000) + "k" } } },
      interaction: { mode: "index", intersect: false },
    },
  });

  // --- Átlagok ---
  const last3 = [0, 1, 2].map(i => sumBy(txOfMonth(new Date(state.month.getFullYear(), state.month.getMonth() - i, 1)), "expense"));
  const avg3 = last3.reduce((a, b) => a + b, 0) / 3;
  const avg6 = expenseData.reduce((a, b) => a + b, 0) / 6;
  const dayCount = isCurrentMonth(state.month) ? new Date().getDate() : daysInMonth(state.month);
  const totalExp = sumBy(tx, "expense");
  const avgDaily = dayCount ? totalExp / dayCount : 0;
  const topCatName = pieLabels.length ? pieLabels.reduce((a, b) => byCat[a].sum > byCat[b].sum ? a : b) : "–";
  const savingRate = sumBy(tx, "income") > 0 ? Math.round(sumBy(tx, "saving") / sumBy(tx, "income") * 100) : 0;
  $("#stats-avgs").innerHTML = `
    <div class="avg-row"><span>Átlagos napi költés (e hónap)</span><b>${fmt(avgDaily)}</b></div>
    <div class="avg-row"><span>3 havi átlag kiadás</span><b>${fmt(avg3)}</b></div>
    <div class="avg-row"><span>6 havi átlag kiadás</span><b>${fmt(avg6)}</b></div>
    <div class="avg-row"><span>Legköltekezősebb kategória</span><b>${topCatName}</b></div>
    <div class="avg-row"><span>Megtakarítási ráta</span><b>${savingRate}%</b></div>
    <div class="avg-row"><span>Tételek száma e hónapban</span><b>${tx.length} db</b></div>
  `;

  // --- Top 5 kiadás ---
  const top5 = [...expenses].sort((a, b) => b.amount - a.amount).slice(0, 5);
  $("#stats-top").innerHTML = top5.length
    ? top5.map(txItemHtml).join("")
    : `<div class="empty-state"><div class="empty-ico">🏆</div><p>Nincs kiadás ebben a hónapban.</p></div>`;
  el.querySelectorAll("[data-txid]").forEach(item => item.onclick = () => {
    const t = state.cache.transactions.find(x => x.id === item.dataset.txid);
    if (t) openTxModal(t);
  });
}

// ============ PROFIL ============
function renderProfile(el) {
  const p = state.cache.profile || {};
  const isCloud = state.store.mode === "cloud";
  el.innerHTML = `
    <div class="section-title">Profil és beállítások 👤</div>
    <div class="card">
      <div class="card-title">Fiók</div>
      <div class="field"><label>Név</label><input type="text" id="profile-name" value="${esc(p.name || state.user?.user_metadata?.name || "")}" placeholder="A neved"></div>
      ${isCloud ? `<div class="field"><label>E-mail</label><input type="text" value="${esc(state.user?.email || "")}" disabled></div>` : ""}
      <div class="banner info">${isCloud ? "☁️ Az adataid a Supabase felhőben tárolódnak, minden eszközödön elérhetők." : "📱 Helyi mód: az adataid csak ezen az eszközön, a böngészőben tárolódnak."}</div>
      <button class="btn btn-primary btn-block" id="btn-save-profile">Mentés</button>
    </div>

    <div class="card">
      <div class="card-title">💬 Visszajelzés / tipp / hibajelentés</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
        Küldj visszajelzést az alkalmazásról – bugok, ötletek, fejlesztési javaslatok mind jók!
        ${!isCloud ? `<br><span style="color:var(--amber)">⚠️ Helyi módban a visszajelzések nem kerülnek el a fejlesztőhöz. Regisztrálj, hogy elküldhesd.</span>` : ""}
      </p>
      <div class="field">
        <label>Kategória</label>
        <div class="type-switch" id="fb-type-switch">
          <button data-fbtype="bug"     class="active">🐛 Hiba</button>
          <button data-fbtype="tip">💡 Tipp</button>
          <button data-fbtype="feature">✨ Ötlet</button>
          <button data-fbtype="other">💬 Egyéb</button>
        </div>
      </div>
      <div class="field">
        <label>Üzenet</label>
        <textarea id="fb-message" rows="4" placeholder="Pl. A kiadás törlése nem működik ha… / Jó lenne ha lehetne… / Nagyon tetszik a…" style="resize:vertical;border:1.5px solid var(--border);border-radius:12px;padding:12px;width:100%;line-height:1.6"></textarea>
      </div>
      <button class="btn btn-primary btn-block" id="btn-send-feedback">Visszajelzés küldése ✉️</button>
      <div id="fb-result" class="auth-error hidden" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="card-title">Alkalmazás</div>
      <button class="btn btn-ghost btn-block" id="btn-install" style="margin-bottom:10px">📲 Telepítés a telefonra / gépre</button>
      <button class="btn btn-ghost btn-block" id="btn-export" style="margin-bottom:10px">⬇️ Adatok exportálása (CSV)</button>
      <button class="btn btn-danger btn-block" id="btn-logout">${isCloud ? "Kijelentkezés" : "Kilépés a helyi módból"}</button>
      ${!isCloud ? `<button class="btn btn-danger btn-block" id="btn-wipe" style="margin-top:10px">🗑 Helyi adatok végleges törlése</button>` : ""}
    </div>
    <p style="text-align:center;color:var(--text-muted);font-size:12px">MoneyManage (MM) v1.0 · Készült ❤️-vel</p>
  `;
  $("#btn-save-profile").onclick = async () => {
    await state.store.setProfile({ name: $("#profile-name").value.trim() });
    await refreshCache(); toast("Profil mentve ✓");
  };

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
      await state.store.sendFeedback({
        category: fbType,
        message: msg,
        email: state.user?.email || null,
        app_version: "1.0",
      });
      resBox.textContent = "✅ Visszajelzés elküldve – köszönjük!";
      resBox.classList.remove("hidden", "success");
      resBox.classList.add("success");
      $("#fb-message").value = "";
    } catch (err) {
      if (err.message === "local") {
        resBox.textContent = "⚠️ Helyi módban nem lehet visszajelzést küldeni. Regisztrálj fiókot!";
      } else {
        resBox.textContent = "❌ Küldési hiba: " + (err.message || "próbáld újra");
      }
      resBox.classList.remove("hidden");
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
      alert("Telepítés:\n\n📱 Androidon (Chrome): menü (⋮) → „Alkalmazás telepítése”\n🍎 iPhone-on (Safari): Megosztás → „Hozzáadás a kezdőképernyőhöz”\n💻 Gépen (Chrome/Edge): címsor jobb oldalán a telepítés ikon");
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
  const rows = [["Dátum", "Típus", "Kategória", "Megnevezés", "Összeg (Ft)"]];
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
  toast("CSV exportálva ⬇️");
}

// ============ MODÁLOK ============
function openModal(title, bodyHtml) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  $("#modal-overlay").classList.remove("hidden");
}
function closeModal() { $("#modal-overlay").classList.add("hidden"); }

// ---------- Tranzakció modál (új / szerkesztés) ----------
function openTxModal(tx = null, preset = {}) {
  const isEdit = !!tx;
  let type = tx?.type || preset.type || "expense";
  let categoryId = tx?.category_id || preset.category_id || state.cache.categories[0]?.id || null;
  let goalId = tx?.goal_id || preset.goal_id || state.cache.goals.filter(g => !g.done)[0]?.id || null;

  const noteSuggestions = [...new Set(state.cache.transactions.map(t => t.note).filter(Boolean))].slice(0, 30);
  const goalOptions = state.cache.goals.map(g => `<option value="${g.id}" ${g.id === goalId ? "selected" : ""}>${g.icon || "🎯"} ${esc(g.name)}</option>`).join("");

  openModal(isEdit ? "Tétel szerkesztése" : "Új tétel", `
    <div class="type-switch" id="tx-type-switch">
      <button data-type="expense" class="${type === "expense" ? "active" : ""}">💸 Kiadás</button>
      <button data-type="income" class="${type === "income" ? "active" : ""}">💵 Bevétel</button>
      <button data-type="saving" class="${type === "saving" ? "active" : ""}">🏦 Félretétel</button>
    </div>
    <div class="field amount-input-wrap">
      <input type="text" id="tx-amount" inputmode="decimal" placeholder="0 Ft" value="${tx ? tx.amount : ""}" autocomplete="off">
      <div class="quick-amounts">
        ${[1000, 2000, 5000, 10000].map(v => `<button type="button" class="chip" data-addamount="${v}">+${v / 1000}k</button>`).join("")}
        <button type="button" class="chip" data-clearamount>C</button>
      </div>
      <p class="field-hint" style="text-align:center">Tipp: írhatod így is: „12k” = 12 000 Ft</p>
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
        ${state.cache.categories.map(c => `<button type="button" class="cat-pick ${c.id === categoryId ? "active" : ""}" data-cat="${c.id}"><span>${c.icon}</span>${esc(c.name)}</button>`).join("")}
      </div>
    </div>
    <div class="field" id="tx-goal-field" style="${type === "saving" ? "" : "display:none"}">
      <label>Melyik célra teszel félre?</label>
      <select id="tx-goal">${goalOptions || `<option value="">Nincs cél – általános megtakarítás</option>`}</select>
    </div>
    <div class="field">
      <label>Dátum</label>
      <input type="date" id="tx-date" value="${tx?.date || todayStr()}">
    </div>
    ${!isEdit ? `<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="tx-recurring" style="width:18px;height:18px"> 🔁 Ismétlődjön minden hónapban ezen a napon
    </label>` : ""}
    <div class="modal-actions">
      ${isEdit ? `<button class="btn btn-danger" id="tx-delete">🗑 Törlés</button>` : ""}
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
      hint.innerHTML = `💡 Javasolt kategória: <b style="color:var(--blue-600);cursor:pointer">${suggested.icon} ${esc(suggested.name)}</b> – kattints az elfogadáshoz`;
      hint.onclick = () => {
        categoryId = suggested.id;
        $("#tx-cat-grid").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x.dataset.cat === suggested.id));
        hint.style.display = "none";
      };
    } else hint.style.display = "none";
  };

  // Mentés
  $("#tx-save").onclick = async () => {
    const amount = parseAmount($("#tx-amount").value);
    if (isNaN(amount) || amount <= 0) { toast("Adj meg érvényes összeget!"); return; }
    const note = $("#tx-note").value.trim();
    const date = $("#tx-date").value || todayStr();
    const row = {
      type, amount, note, date,
      category_id: type === "expense" ? categoryId : null,
      goal_id: type === "saving" ? ($("#tx-goal")?.value || null) : null,
    };
    try {
      if (isEdit) {
        await state.store.update("transactions", tx.id, row);
      } else {
        await state.store.insert("transactions", row);
        if ($("#tx-recurring")?.checked) {
          await state.store.insert("recurring", {
            name: note || "Ismétlődő tétel", amount, type,
            category_id: row.category_id, day: new Date(date + "T00:00:00").getDate(), active: true,
          });
          toast("Tétel + ismétlődés mentve ✓");
        }
      }
      await refreshCache();
      closeModal();
      renderView();
      if (!$("#tx-recurring")?.checked) toast(isEdit ? "Tétel módosítva ✓" : "Tétel hozzáadva ✓");
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
  const icons = ["🎯", "🏖", "🚗", "🏠", "💍", "🎓", "💻", "🛡", "✈️", "🎸", "👶", "🐕"];
  openModal(isEdit ? "Cél szerkesztése" : "Új cél", `
    <div class="field"><label>Mi a célod?</label>
      <input type="text" id="goal-name" placeholder="Pl. nyaralás, autó, vésztartalék" value="${esc(goal?.name || "")}"></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(6,1fr)" id="goal-icons">
        ${icons.map(i => `<button type="button" class="cat-pick ${(goal?.icon || "🎯") === i ? "active" : ""}" data-icon="${i}"><span>${i}</span></button>`).join("")}
      </div></div>
    <div class="field"><label>Célösszeg</label>
      <input type="text" id="goal-target" inputmode="decimal" placeholder="Pl. 300k" value="${goal?.target_amount || ""}">
      <p class="field-hint">Tipp: „300k” = 300 000 Ft</p></div>
    <div class="field"><label>Már megvan ennyi (kezdőösszeg)</label>
      <input type="text" id="goal-start" inputmode="decimal" placeholder="0" value="${goal?.start_amount || ""}"></div>
    <div class="field"><label>Határidő (nem kötelező)</label>
      <input type="date" id="goal-deadline" value="${goal?.deadline ? goal.deadline.slice(0, 10) : ""}"></div>
    <div class="banner info" id="goal-calc" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="goal-save">${isEdit ? "Mentés" : "Cél létrehozása"}</button>
    </div>
  `);

  let icon = goal?.icon || "🎯";
  $("#goal-icons").querySelectorAll(".cat-pick").forEach(b => b.onclick = () => {
    icon = b.dataset.icon;
    $("#goal-icons").querySelectorAll(".cat-pick").forEach(x => x.classList.toggle("active", x === b));
  });

  // Élő számítás: havi szükséges összeg
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
      box.style.display = "block";
      box.innerHTML = `📌 Ehhez havonta <b>${fmt(monthly)}</b> félretétele szükséges (${months} hónapon át).`;
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
    toast(isEdit ? "Cél módosítva ✓" : "Cél létrehozva 🎯");
  };
}

// ---------- Kategória modál ----------
function openCategoryModal() {
  const icons = ["🏠", "🛒", "🚌", "🎉", "💊", "👕", "📱", "📦", "🎮", "📚", "🐾", "🚬", "☕", "💇", "🎁", "⚽"];
  const colors = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#4f46e5", "#64748b", "#db2777", "#65a30d"];
  openModal("Új kategória", `
    <div class="field"><label>Név</label><input type="text" id="cat-name" placeholder="Pl. Hobbi"></div>
    <div class="field"><label>Ikon</label>
      <div class="cat-grid" style="grid-template-columns:repeat(8,1fr)" id="cat-icons">
        ${icons.map((i, x) => `<button type="button" class="cat-pick ${x === 0 ? "active" : ""}" data-icon="${i}"><span>${i}</span></button>`).join("")}
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
    await refreshCache(); closeModal(); renderView(); toast("Kategória létrehozva ✓");
  };
}

// ---------- Ismétlődő tétel modál ----------
function openRecurringModal() {
  const catOptions = state.cache.categories.map(c => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join("");
  openModal("Új ismétlődő tétel", `
    <div class="type-switch" id="rec-type-switch">
      <button data-type="expense" class="active">💸 Kiadás</button>
      <button data-type="income">💵 Bevétel</button>
    </div>
    <div class="field"><label>Megnevezés</label><input type="text" id="rec-name" placeholder="Pl. Fizetés, Albérlet, Netflix"></div>
    <div class="field"><label>Összeg</label><input type="text" id="rec-amount" inputmode="decimal" placeholder="Pl. 150k"></div>
    <div class="field" id="rec-cat-field"><label>Kategória</label><select id="rec-cat">${catOptions}</select></div>
    <div class="field"><label>A hónap melyik napján?</label>
      <input type="number" id="rec-day" min="1" max="31" value="1">
      <p class="field-hint">Pl. fizetésnél 5, ha 5-én érkezik. Az adott napon automatikusan könyvelődik.</p></div>
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
    const day = Math.min(31, Math.max(1, parseInt($("#rec-day").value, 10) || 1));
    if (!name || isNaN(amount) || amount <= 0) { toast("Add meg a nevet és az összeget!"); return; }
    await state.store.insert("recurring", {
      name, amount, type, day, active: true,
      category_id: type === "expense" ? $("#rec-cat").value : null,
    });
    await refreshCache();
    await applyRecurring();
    await refreshCache();
    closeModal(); renderView(); toast("Ismétlődő tétel mentve 🔁");
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
