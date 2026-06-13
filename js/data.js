// ============ MoneyManage adatréteg ============
// Két tárolási mód, azonos API-val:
//  - LocalStore: localStorage (fiók nélküli / offline mód)
//  - SupaStore:  Supabase (bejelentkezett felhasználó)
// Táblák: categories, transactions, goals, recurring

const DEFAULT_CATEGORIES = [
  { name: "Lakhatás",      icon: "🏠", color: "#2563eb", budget: 0 },
  { name: "Élelmiszer",    icon: "🛒", color: "#16a34a", budget: 0 },
  { name: "Közlekedés",    icon: "🚌", color: "#d97706", budget: 0 },
  { name: "Szórakozás",    icon: "🎉", color: "#9333ea", budget: 0 },
  { name: "Egészség",      icon: "💊", color: "#dc2626", budget: 0 },
  { name: "Ruházat",       icon: "👕", color: "#0891b2", budget: 0 },
  { name: "Előfizetések",  icon: "📱", color: "#4f46e5", budget: 0 },
  { name: "Egyéb",         icon: "📦", color: "#64748b", budget: 0 },
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
  }
  async init() {
    const cats = await this.list("categories");
    if (!cats.length) {
      const rows = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, sort: i, user_id: this.uid }));
      const { error } = await this.sb.from("categories").insert(rows);
      if (error) console.error("Alap kategóriák létrehozása sikertelen:", error.message);
    }
  }
  async list(table) {
    const { data, error } = await this.sb.from(table).select("*").eq("user_id", this.uid);
    if (error) { console.error(`${table} lekérés hiba:`, error.message); return []; }
    return data || [];
  }
  async insert(table, row) {
    const { data, error } = await this.sb.from(table).insert({ ...row, user_id: this.uid }).select().single();
    if (error) { console.error(`${table} mentés hiba:`, error.message); throw error; }
    return data;
  }
  async update(table, id, patch) {
    const { data, error } = await this.sb.from(table).update(patch).eq("id", id).eq("user_id", this.uid).select().single();
    if (error) { console.error(`${table} módosítás hiba:`, error.message); throw error; }
    return data;
  }
  async remove(table, id) {
    const { error } = await this.sb.from(table).delete().eq("id", id).eq("user_id", this.uid);
    if (error) { console.error(`${table} törlés hiba:`, error.message); throw error; }
  }
  async getProfile() {
    const { data } = await this.sb.from("profiles").select("*").eq("id", this.uid).maybeSingle();
    return data || { name: "" };
  }
  async setProfile(patch) {
    await this.sb.from("profiles").upsert({ id: this.uid, ...patch });
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
  return isNaN(n) ? NaN : Math.round(n * mult);
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
