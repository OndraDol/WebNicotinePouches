# Průvodce pro AI agenty a vývojáře NicoTracker

Tento dokument popisuje požadavky na kód, procesy a UI pro aplikaci NicoTracker (SPA/PWA pro sledování užívání nikotinových sáčků). Dodržujte jej při každé úpravě kódu v tomto repozitáři.

## 1) Přehled projektu
- **Typ aplikace:** Webová SPA + PWA.
- **Cíl:** Sledování spotřeby, gamifikace odvykání, finanční přehledy.
- **Backend:** Firebase (Auth, Firestore), hosting statických assetů, service worker pro offline.
- **Knihovny:** Chart.js pro grafy; zbytek je vanilla HTML/CSS/JS (ES6 moduly).

## 2) Struktura repo
- `index.html` – hlavní UI, logika, styly a skripty (module script). Minimalizujte globální proměnné; pokud jsou potřeba pro event handlery, namespace je přes `window.*`.
- `data.js` – seed/mock dat a pomocné utilitní funkce.
- `manifest.json` – konfigurace PWA (ikony, barvy, režim standalone).
- `sw.js` – service worker; udržujte cache základních assetů (`index.html`, knihovny) a respektujte offline start.

## 3) Firestore datový model
- **Profil uživatele:** `users/{userId}/settings/profile`
  - `currency` (string), `packPrice` (number), `pouchesPerPack` (number), `dailyLimit` (number), `onboarded` (bool), `createdAt`, `updatedAt` (timestampy).
- **Historie spotřeby:** `users/{userId}/history/{documentId}`
  - `brand` (string), `mg` (number), `cost` (number vypočtený při zápisu), `timestamp` (Firestore Timestamp), `createdAt` (timestamp).
- **Vlastní sáčky:** `users/{userId}/custom_pouches/{documentId}`
  - `name`, `mg`, `isCustom` (bool), `createdAt` (timestamp).

## 4) UI a design systém
- **Typografie:** Inter (Google Fonts).
- **Barvy:** Primary `#10b981` (emerald), Background `#f3f4f6`, Card `#ffffff`, Text `#111827`.
- **Komponenty:** Používejte `<dialog>` pro modální okna; žádné `alert()`/`confirm()`.
- **Toasty:** Preferujte neblokující toast notifikace pro úspěch/chybu.
- **Mobile-first:** Layouty musí být použitelné na mobilech; velká tap-targets, nepočítat s hoverem.
- **Přístupnost:** Rozumné kontrasty, focus styly nemazat bez náhrady.
- **Interakce:** Zabraňte zoomu (`user-scalable=no`) a nechtěnému výběru textu (`user-select: none`) mimo inputy.

## 5) Kód a architektura
- **ES6 moduly:** Importy bez try/catch; držte logiku v modulech, ne v globálním scope.
- **Stav:** Neztrácejte inicializaci Firebase ani referenci na Auth/Firestore při úpravách.
- **Validace:** Žádný záznam nesmí mít timestamp z budoucnosti; kontrolujte vstupy u formulářů a backdated zápisů.
- **Výpočty:** Cena sáčku = `packPrice / pouchesPerPack` v době zápisu; ukládejte do `cost`.
- **Gamifikace:** Při načtení dat počítejte 16 odznaků (Milníky, Disciplína, Zdraví, Finance); zahrňte logiku Streak a „Víkendový válečník“ (sobota+nedele ≤ dailyLimit).

## 6) PWA a service worker
- Udržujte cache pro rychlý cold start (`index.html`, knihovny, fonty/ikony dle potřeby).
- Respektujte aktualizační flow (skipWaiting/clientsClaim používejte opatrně, aby nedošlo ke ztrátě stavu formulářů).
- Neodstraňujte manifest ani meta tagy pro PWA instalaci.

## 7) Lokalizace a texty
- Default jazyk je čeština; nové texty přidávejte konzistentně (diakritika, tón přátelský, stručný).
- Nepoužívejte inline alerty; chyby/úspěchy hlaste toastem nebo textovou hláškou u prvku.

## 8) Testování
- Minimálně spusťte relevantní lint/CI skripty, jsou-li k dispozici; pokud nic neexistuje, zvažte aspoň ruční kouknutí na konzoli v devtools.
- V PR message uvádějte, které příkazy byly spuštěny (nebo že nebyly požádány/spuštěny).

## 9) PR a git proces
- Komitujte smysluplné logické změny; žádné commity s prázdným nebo vágním popisem.
- PR shrnutí: stručné bullet body (co se změnilo, proč), sekce Testování s příkazy a výsledky.
- Pokud přidáte vizuální změny v UI, přiložte screenshot z aktuální verze (desktop nebo mobil dle dopadu).

## 10) Bezpečnost a soukromí
- Nikdy nepropisujte či nelogujte Firebase API klíče nebo citlivé tokeny.
- Nepřidávejte debug logy do produkčního buildu; pokud je nutné logování, držte jej minimální a vypínatelné.

## 11) Poznámky k historii a mazání dat
- Funkce pro mazání historie musí mít dvojí potvrzení a bezpečný reset (UI dialogy, žádné `confirm()`).
- Při mazání lokálních cache zvažte i invalidaci zobrazených grafů/tabulek.

Dodržujte tento dokument pro všechny soubory v repozitáři, pokud není v podadresáři uveden přísnější AGENTS.md.
