// ============ MoneyManage adatréteg ============
// Két tárolási mód, azonos API-val:
//  - LocalStore: localStorage (fiók nélküli / offline mód)
//  - SupaStore:  Supabase (bejelentkezett felhasználó)
// Táblák: categories, transactions, goals, recurring

const DEFAULT_CATEGORIES = [
  { name: "Lakhatás",      icon: "house",         color: "#2563eb", budget: 0 },
  { name: "Élelmiszer",    icon: "shopping-cart", color: "#16a34a", budget: 0 },
  { name: "Közlekedés",    icon: "bus",           color: "#d97706", budget: 0 },
  { name: "Szórakozás",    icon: "party-popper",  color: "#9333ea", budget: 0 },
  { name: "Egészség",      icon: "pill",          color: "#dc2626", budget: 0 },
  { name: "Ruházat",       icon: "shirt",         color: "#0891b2", budget: 0 },
  { name: "Előfizetések",  icon: "smartphone",    color: "#4f46e5", budget: 0 },
  { name: "Egyéb",         icon: "package",       color: "#64748b", budget: 0 },
];

// Kulcsszó → kategória javaslat (okos bevitel)
const CATEGORY_KEYWORDS = {
  "Élelmiszer": ["kaja", "étel", "lidl", "aldi", "tesco", "spar", "penny", "bolt", "élelmiszer", "bevásárl", "pék", "hús"],
  "Lakhatás": ["albérlet", "lakbér", "rezsi", "villany", "gáz", "víz", "fűtés", "közös költség", "internet", "lakás"],
  "Közlekedés": ["busz", "bérlet", "bkk", "vonat", "máv", "benzin", "tank", "üzemanyag", "parkol", "taxi", "bolt fox"],
  "Szórakozás": ["mozi", "koncert", "buli", "sör", "kocsma", "étterem", "pizza", "burger", "játék", "szórakoz"],
  "Egészség": ["gyógyszer", "orvos", "patika", "fogorvos", "vitamin", "edzés", "edzőterem", "gym"],
  "Ruházat": ["ruha", "cipő", "póló", "nadrág", "kabát", "zara", "h&m", "sinsay"],
  "Előfizetések": ["netflix", "spotify", "youtube", "hbo", "disney", "előfizetés", "telefon", "mobil", "yettel", "telekom", "vodafone", "one "],
};

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ---------- Helyi tároló ----------
class LocalStore {
  constructor() {
    this.key = "mm_local_data_v1";
    this.data = this._load();
    this.mode = "local";
  }
  _load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* sérült adat esetén újrakezdjük */ }
    return { categories: [], transactions: [], goals: [], recurring: [], profile: { name: "Vendég" } };
  }
  _save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }

  async init() {
    if (!this.data.categories.length) {
      this.data.categories = DEFAULT_CATEGORIES.map((c, i) => ({ id: uuid(), sort: i, ...c }));
      this._save();
    }
  }
  setCtx() { /* helyi módban nincs közös fiók */ }
  async list(table) { return [...(this.data[table] || [])]; }
  async insert(table, row) {
    const rec = { id: uuid(), created_at: new Date().toISOString(), ...row };
    this.data[table].push(rec); this._save(); return rec;
  }
  async update(table, id, patch) {
    const i = this.data[table].findIndex(r => r.id === id);
    if (i >= 0) { this.data[table][i] = { ...this.data[table][i], ...patch }; this._save(); return this.data[table][i]; }
    return null;
  }
  async remove(table, id) {
    this.data[table] = this.data[table].filter(r => r.id !== id); this._save();
  }
  async getProfile() { return this.data.profile || { name: "Vendég" }; }
  async setProfile(patch) { this.data.profile = { ...this.data.profile, ...patch }; this._save(); }
  async convertAll(factor) {
    const r = (n) => Math.round((Number(n) || 0) * factor * 100) / 100;
    this.data.transactions.forEach(t => { t.amount = r(t.amount); });
    this.data.goals.forEach(g => { g.target_amount = r(g.target_amount); g.start_amount = r(g.start_amount); });
    this.data.categories.forEach(c => { c.budget = r(c.budget); });
    this.data.recurring.forEach(x => { x.amount = r(x.amount); });
    this._save();
  }
  // ---- Közös fiók: csak felhő módban (helyi módban nem elérhető) ----
  async getHousehold() { return null; }
  async createInvite() { throw new Error("local"); }
  async joinHousehold() { throw new Error("local"); }
  async leaveHousehold() {}
  async listShared() { return []; }
  async insertShared() { throw new Error("local"); }
  async listContributions() { return []; }
  async addContribution() { throw new Error("local"); }
  async sendFeedback(row) {
    // Helyi módban nincs szerver – csak a konzolba írjuk (Supabase nélkül nem küldhető el)
    console.info("[MM feedback – helyi mód]", row);
    throw new Error("local");
  }
  async wipe() { localStorage.removeItem(this.key); }
}

// ---------- Supabase tároló ----------
class SupaStore {
  constructor(client, userId) {
    this.sb = client;
    this.uid = userId;
    this.mode = "cloud";
    this.ctxHousehold = null;   // ha be van állítva, a megosztható táblák a közös fiókra mennek
  }
  setCtx(hid) { this.ctxHousehold = hid || null; }
  // Megosztható táblák (a recurring mindig személyes marad)
  _shareable(table) { return ["transactions", "categories", "goals"].includes(table); }
  async init() {
    const cats = await this.list("categories");
    if (!cats.length) {
      const rows = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, sort: i, user_id: this.uid }));
      const { error } = await this.sb.from("categories").insert(rows);
      if (error) console.error("Alap kategóriák létrehozása sikertelen:", error.message);
    }
  }
  async list(table) {
    // Közös nézet: a household tételei; személyes nézet: a sajátok (household_id null)
    if (this.ctxHousehold && this._shareable(table)) {
      const { data, error } = await this.sb.from(table).select("*").eq("household_id", this.ctxHousehold);
      if (error) { console.error(`${table} (közös) lekérés hiba:`, error.message); return []; }
      return data || [];
    }
    let q = this.sb.from(table).select("*").eq("user_id", this.uid);
    if (this._shareable(table)) q = q.is("household_id", null);
    const { data, error } = await q;
    if (error) { console.error(`${table} lekérés hiba:`, error.message); return []; }
    return data || [];
  }
  async insert(table, row) {
    const extra = (this.ctxHousehold && this._shareable(table)) ? { household_id: this.ctxHousehold } : {};
    const { data, error } = await this.sb.from(table).insert({ ...row, user_id: this.uid, ...extra }).select().single();
    if (error) { console.error(`${table} mentés hiba:`, error.message); throw error; }
    return data;
  }
  async update(table, id, patch) {
    // user_id szűrő nélkül – a jogosultságot az RLS dönti el (közös tételt a társ is módosíthat)
    const { data, error } = await this.sb.from(table).update(patch).eq("id", id).select().single();
    if (error) { console.error(`${table} módosítás hiba:`, error.message); throw error; }
    return data;
  }
  async remove(table, id) {
    const { error } = await this.sb.from(table).delete().eq("id", id);
    if (error) { console.error(`${table} törlés hiba:`, error.message); throw error; }
  }
  // ---- Közös fiók (cloud) ----
  async listShared(table, hid) {
    const { data, error } = await this.sb.from(table).select("*").eq("household_id", hid);
    if (error) { console.error(`${table} (közös) lekérés hiba:`, error.message); return []; }
    return data || [];
  }
  async insertShared(table, row, hid) {
    const { data, error } = await this.sb.from(table).insert({ ...row, user_id: this.uid, household_id: hid }).select().single();
    if (error) { console.error(`${table} (közös) mentés hiba:`, error.message); throw error; }
    return data;
  }
  async getHousehold() {
    const { data: hs } = await this.sb.from("households").select("*").limit(1);
    if (!hs || !hs.length) return null;
    const h = hs[0];
    const { data: members } = await this.sb.from("household_members").select("*").eq("household_id", h.id);
    return { ...h, members: members || [] };
  }
  // Az ÖSSZES háztartás/zseb, amelynek a felhasználó tagja (a tagokkal együtt)
  async getHouseholds() {
    const { data: hs, error } = await this.sb.from("households").select("*").order("created_at", { ascending: true });
    if (error || !hs) return [];
    const out = [];
    for (const h of hs) {
      const { data: members } = await this.sb.from("household_members").select("*").eq("household_id", h.id);
      out.push({ ...h, members: members || [] });
    }
    return out;
  }
  async createPocket(name) {
    const { data, error } = await this.sb.rpc("mm_create_pocket", { p_name: name });
    if (error) throw error;
    return data;
  }
  async renamePocket(hid, name) {
    const { error } = await this.sb.rpc("mm_rename", { p_hid: hid, p_name: name });
    if (error) throw error;
  }
  async createInvite() {
    const { data, error } = await this.sb.rpc("mm_create_invite");
    if (error) throw error;
    return data;
  }
  async joinHousehold(code) {
    const { data, error } = await this.sb.rpc("mm_join", { p_code: code });
    if (error) throw error;
    return data;
  }
  async leaveHousehold(hid) {
    const { error } = await this.sb.rpc("mm_leave", { p_hid: hid });
    if (error) throw error;
  }
  async listContributions(hid) {
    const { data, error } = await this.sb.from("shared_contributions").select("*").eq("household_id", hid);
    if (error) { console.error("hozzájárulások hiba:", error.message); return []; }
    return data || [];
  }
  async addContribution(row) {
    const { error } = await this.sb.from("shared_contributions").insert({ ...row, user_id: this.uid });
    if (error) throw error;
  }
  async getProfile() {
    const { data } = await this.sb.from("profiles").select("*").eq("id", this.uid).maybeSingle();
    return data || { name: "" };
  }
  async setProfile(patch) {
    await this.sb.from("profiles").upsert({ id: this.uid, ...patch });
  }
  async convertAll(factor) {
    const r = (n) => Math.round((Number(n) || 0) * factor * 100) / 100;
    const tx = await this.list("transactions");
    for (const t of tx) await this.update("transactions", t.id, { amount: r(t.amount) });
    const goals = await this.list("goals");
    for (const g of goals) await this.update("goals", g.id, { target_amount: r(g.target_amount), start_amount: r(g.start_amount) });
    const cats = await this.list("categories");
    for (const c of cats) await this.update("categories", c.id, { budget: r(c.budget) });
    const recs = await this.list("recurring");
    for (const x of recs) await this.update("recurring", x.id, { amount: r(x.amount) });
  }
  async sendFeedback(row) {
    const { error } = await this.sb.from("feedback").insert({ ...row, user_id: this.uid });
    if (error) throw error;
  }
  async wipe() { /* felhőben nem törlünk mindent egy gombbal */ }
}

// ---------- Okos összeg-értelmezés: "12k" → 12000, "1.5m" → 1500000 ----------
function parseAmount(str) {
  if (typeof str === "number") return str;
  if (!str) return NaN;
  let s = String(str).trim().toLowerCase().replace(/\s+/g, "").replace(/ft$/, "").replace(",", ".");
  let mult = 1;
  if (s.endsWith("k") || s.endsWith("e")) { mult = 1000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1000000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : Math.round(n * mult * 100) / 100;
}

// ---------- Kategória-javaslat a megnevezés alapján ----------
function suggestCategory(note, categories) {
  if (!note) return null;
  const low = note.toLowerCase();
  for (const [catName, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => low.includes(w))) {
      const cat = categories.find(c => c.name === catName);
      if (cat) return cat;
    }
  }
  return null;
}
