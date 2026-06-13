# 💙 MoneyManage (MM)

Telefonra telepíthető webalkalmazás (PWA) a havi pénzügyeid tervezéséhez és követéséhez.

**Funkciók:**
- 🎨 Modern fintech design **világos és sötét témával** (váltó a beállításokban + automatikus rendszerkövetés), letisztult monochrome ikonokkal
- 💱 Választható pénznem (Ft, €, $, £, lei, Fr) – magyar számformázással (ezres-tagolás, elkülönített tizedesek), a valuta az összeg-beviteknél is megjelenik
- 📋 Havi költségvetés tervezése kategóriánként (keretek + túlköltés-jelzés)
- 🧾 Kiadások / bevételek / megtakarítások rögzítése okos bevitellel („12k" = 12 000 Ft, kategória-javaslat a megnevezés alapján, gyorsösszeg gombok)
- 🔁 Ismétlődő tételek tetszőleges gyakorisággal: naponta / hetente / havonta / évente, sőt „3 hetente" is – automatikus könyveléssel
- 🎯 Hosszú távú célok célösszeggel és határidővel – kiszámolja, mennyit kell havonta félretenned
- 🔮 Hó végi előrejelzés: a jelenlegi költési tempód alapján megmondja, mennyi marad
- 🗓️ Jövőbeli (tervezett) tételek: a hó végi egyenlegbe beleszámítanak, a statisztikába még nem – egy ✓ gombbal jelölheted teljesítettnek
- 📊 Statisztikák: kategória-megoszlás, 6 havi trend, halmozott napi költés összevetése az előző hónappal, átlagok, top kiadások
- 💬 Visszajelzés-küldés (a Supabase `feedback` tábláján keresztül)
- ☁️ Teljes regisztrációs/bejelentkezős rendszer (Supabase) – az adataid minden eszközödön elérhetők
- 📱 Helyi mód fiók nélkül is (localStorage)
- ⬇️ CSV export, offline működés, telepíthető Androidra/iPhone-ra/PC-re

---

## 🔄 FONTOS – frissítés után futtasd újra a sémát (v1.1)

Ha már korábban beállítottad a Supabase-t, az új funkciókhoz (tetszőleges ismétlődési gyakoriság + jövőbeli/tervezett tételek) **új adatbázis-oszlopok kellenek**. Nyisd meg a **Supabase Dashboard → SQL Editor → New query**, másold be újra a **`supabase/schema.sql`** teljes tartalmát, és kattints **Run**. A fájl idempotens (az `add column if not exists` / `drop policy if exists` miatt hibamentesen újrafuttatható), tehát nyugodtan lefuttathatod akárhányszor – a meglévő adataid megmaradnak.

---

## 🚀 Üzembe helyezés – lépésről lépésre

### 1. Supabase beállítása (kb. 5 perc)

1. Menj a **https://supabase.com** oldalra, jelentkezz be (GitHub fiókkal a legegyszerűbb).
2. **New project** → adj nevet (pl. `moneymanage`), válassz egy erős adatbázis-jelszót és egy közeli régiót (pl. `eu-central-1`), majd **Create new project**.
3. Várd meg, míg elkészül (1-2 perc).
4. Bal oldali menü → **SQL Editor** → **New query** → másold be a **`supabase/schema.sql`** fájl TELJES tartalmát → **Run**. (Zöld „Success" üzenetet kell kapnod.)
5. Bal oldali menü → **Project Settings** (fogaskerék) → **API**:
   - másold ki a **Project URL**-t (pl. `https://abcdefgh.supabase.co`)
   - másold ki az **anon public** kulcsot (hosszú `eyJ...` kezdetű szöveg)
6. Nyisd meg a **`js/config.js`** fájlt, és írd be a két értéket:
   ```js
   window.MM_CONFIG = {
     SUPABASE_URL: "https://abcdefgh.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1..."
   };
   ```
   > Az anon kulcs nyilvános kulcs, nyugodtan mehet GitHubra – az adataidat a Row Level Security védi.

7. *(Ajánlott teszteléshez)* **Authentication → Sign In / Up → Email** alatt kapcsold KI a **"Confirm email"** opciót, így regisztráció után azonnal be tudsz lépni e-mail megerősítés nélkül. (Élesben visszakapcsolhatod.)

### 2. Publikálás GitHub Pages-re (kb. 5 perc)

1. Menj a **https://github.com/new** oldalra → repó neve pl. `moneymanage` → **Public** → **Create repository**.
2. Nyiss egy terminált (PowerShell) ebben a mappában (`MM`), és futtasd:
   ```powershell
   git init
   git add .
   git commit -m "MoneyManage v1.0"
   git branch -M main
   git remote add origin https://github.com/<FELHASZNÁLÓNEVED>/moneymanage.git
   git push -u origin main
   ```
   (Első alkalommal a GitHub bejelentkezést fog kérni egy felugró ablakban.)
3. A GitHubon a repóban: **Settings → Pages** → "Build and deployment" alatt **Source: Deploy from a branch** → Branch: **main**, mappa: **/ (root)** → **Save**.
4. 1-2 perc múlva az oldalad elérhető lesz itt:
   `https://<FELHASZNÁLÓNEVED>.github.io/moneymanage/`

### 3. Telepítés telefonra

- **Android (Chrome):** nyisd meg az oldalt → ⋮ menü → **„Alkalmazás telepítése”** (vagy felugró sáv alul)
- **iPhone (Safari):** nyisd meg az oldalt → **Megosztás** ikon → **„Hozzáadás a kezdőképernyőhöz”**
- **PC (Chrome/Edge):** címsor jobb szélén a 📥 telepítés ikon

Ezután ikonja lesz a kezdőképernyőn és teljes képernyőn, appként fut – offline is megnyílik.

---

## 🔄 Frissítések publikálása később

Ha változtatsz a fájlokon:
```powershell
git add .
git commit -m "Mit változtattam"
git push
```
1-2 perc múlva élesedik. (A telefonon az app újraindítása után frissül.)

## 📁 Fájlszerkezet

```
MM/
├── index.html              ← az alkalmazás váza
├── css/style.css           ← fehér-kék design
├── js/config.js            ← ⚠️ IDE kell a Supabase URL + kulcs
├── js/data.js              ← adatréteg (helyi + felhő tárolás)
├── js/app.js               ← alkalmazáslogika
├── manifest.webmanifest    ← PWA telepítési adatok
├── sw.js                   ← offline működés (service worker)
├── icons/                  ← app ikonok
└── supabase/schema.sql     ← ⚠️ EZT kell lefuttatni a Supabase SQL Editorban
```
