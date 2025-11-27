💊 NicoTracker Ultimate – Project Context
Tento dokument slouží jako zdroj pravdy pro AI agenty pracující na projektu NicoTracker. Obsahuje definici stacku, databáze, pravidel a funkčních požadavků.
1. O Projektu
NicoTracker je Single Page Aplikace (SPA) a Progressive Web App (PWA) určená pro sledování spotřeby nikotinových sáčků. Cílem je pomoci uživatelům sledovat finance, snižovat dávky a gamifikovat proces odvykání.
Typ aplikace: SaaS / B2C Web App
Cílová skupina: Široká veřejnost (mobilní uživatelé)
2. Tech Stack
Frontend: HTML5, CSS3 (Moderní, Flexbox/Grid), Vanilla JavaScript (ES6 Modules).
Backend: Firebase (BaaS).
Auth: Firebase Auth (Email/Password + Google).
Database: Cloud Firestore.
Hosting: Firebase Hosting (nebo jakýkoliv statický hosting).
Knihovny: Chart.js (grafy).
PWA: manifest.json, sw.js (Service Worker).
3. Struktura Souborů
code
Text
/
├── index.html        # Hlavní aplikační logika (HTML + CSS + JS)
├── manifest.json     # Konfigurace PWA (ikony, barvy, standalone)
├── sw.js             # Service Worker (offline cache, fetch strategie)
└── agents.md         # Dokumentace pro AI a vývojáře
4. Datový Model (Firestore)
Všechna data jsou uložena pod users/{userId}/....
A. Nastavení uživatele
Path: users/{userId}/settings/profile
code
JSON
{
  "currency": "CZK",       // string
  "packPrice": 150,        // number (cena za puk)
  "pouchesPerPack": 20,    // number (kusů v puku)
  "dailyLimit": 10,        // number (cílový denní limit)
  "onboarded": true,       // boolean (zda prošel úvodním nastavením)
  "createdAt": timestamp,
  "updatedAt": timestamp
}
B. Historie spotřeby
Path: users/{userId}/history/{documentId}
code
JSON
{
  "brand": "Velo Freeze",  // string
  "mg": 10.9,              // number (síla nikotinu)
  "cost": 7.5,             // number (vypočtená cena v době zadání)
  "timestamp": timestamp,  // Firestore Timestamp (datum a čas spotřeby)
  "createdAt": timestamp   // Server timestamp vytvoření záznamu
}
C. Vlastní sáčky (Custom Pouches)
Path: users/{userId}/custom_pouches/{documentId}
Umožňuje uživateli definovat vlastní značky do dropdownu.
code
JSON
{
  "name": "Moje Značka",   // string
  "mg": 12.0,              // number
  "isCustom": true,        // boolean (pro rozlišení v UI)
  "createdAt": timestamp
}
5. Design System & UI Pravidla
Font: Inter (Google Fonts).
Barvy:
Primary: #10b981 (Emerald Green)
Background: #f3f4f6 (Light Grey)
Card: #ffffff (White)
Text: #111827 (Dark Grey)
Komponenty:
Používat nativní HTML <dialog> pro modální okna.
Toast notifikace pro zpětnou vazbu (nikdy alert()).
Mobile-first layout (velká tlačítka, žádný hover na mobilech).
6. Klíčové Funkce (Logika)
Gamifikace (Badges)
Systém musí dynamicky počítat 16 odznaků při každém načtení dat.
Kategorie: Milníky, Disciplína, Zdraví, Finance.
Logika Víkendový Válečník: Kontrola, zda Sobota i Neděle (po sobě jdoucí) jsou <= dailyLimit.
Logika Streak: Počet po sobě jdoucích dní (zpětně od dneška/včerejška), kdy count <= dailyLimit.
PWA Chování
Aplikace musí zabránit zoomování (user-scalable=no).
Musí potlačit "select" textu (user-select: none) kromě inputů, aby působila jako nativní appka.
Service Worker musí cachovat index.html a knihovny pro rychlý start.
7. Instrukce pro úpravy kódu
Zachování stavu: Při úpravách JS kódu dbej na to, aby se nerozbila inicializace Firebase.
Modularita: Kód v index.html je v <script type="module">. Nepoužívej globální proměnné (var), pokud to není nutné pro HTML event handlery (např. window.editItem).
Bezpečnost: Nikdy nevypisuj apiKey do logů.
Validace: Vždy kontrolovat, zda timestamp není v budoucnosti.
