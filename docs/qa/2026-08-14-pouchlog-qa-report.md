# QA report: PouchLog

Datum testu: 14. srpna 2026
Testovaný commit: `70bc856bc38b03f90fa13295e36b5422a4362dfa`
Produkce: `https://pouchlog.com/`

## Stav nápravy

Všech 11 nálezů je k 14. srpnu 2026 opraveno v místním pracovním stromu. Změny nejsou nasazené do produkce. Funkce odstranění účtu byla ověřena pouze jednotkovými testy s falešnou databází a falešným Firebase Auth; žádný skutečný účet ani reálná data nebyly odstraněny.

| ID | Implementovaná náprava |
|---|---|
| `PL-SEC-01` | striktní atomická validace zálohy a historie vytvořená přes DOM bez inline JavaScriptu |
| `PL-SYNC-01` | počáteční migrace hostovských dat, vlastník lokální historie, autoritativní snapshot včetně prázdného stavu a odpojení listeneru |
| `PL-PRIV-01` | opětovné ověření Google účtu nebo hesla a serverové odstranění celého `users/{uid}` před odstraněním Auth účtu |
| `PL-VAL-01` | sdílená validace měny, ceny, množství, limitu a cílového data pro průvodce i import |
| `PL-DATE-01` | editor používá místní kalendářní datum a čas |
| `PL-CSV-01` | RFC 4180 escapování, UTF-8 BOM a neutralizace tabulkových vzorců |
| `PL-STORAGE-01` | bezpečné parsování každého lokálního JSON klíče bez pádu a bez přepsání poškozeného zdroje při startu |
| `PL-STATS-01` | prázdná historie nemá benchmark ani elitní percentil |
| `PL-BADGE-01` | odznaky používají pouze dokončená období po začátku sledování |
| `PL-PWA-01` | cache `v1.4`, síťová aktualizace měnitelných aplikačních souborů a offline fallback |
| `PL-I18N-01` | český přihlašovací a registrační titulek používá překlady |

Po nápravě prošlo 145 frontendových a auditních testů, 23 testů Cloud Functions a 11 lokálních scénářů v Microsoft Edge. Browserová kontrola zahrnovala poškozené úložiště, nebezpečný import, datum kolem půlnoci, CSV a JSON export, statistiky, odznaky, českou lokalizaci, šířky 390 a 320 px a offline reload PWA.

## Shrnutí

Základní používání aplikace funguje na desktopu i v mobilních šířkách: onboarding, výběr a zápis sáčku, historie, jednotlivé i hromadné mazání, JSON import/export, všechny tři odvykací strategie a offline zápis prošly. Produkční smoke test měl 7/7 úspěšných kontrol včetně skutečného odeslání označené QA zprávy z kontaktního formuláře.

Audit potvrdil 11 samostatných problémů:

- 3 × P1: bezpečnost, riziko ztráty synchronizovaných dat a nepravdivý příslib mazání účtových dat;
- 7 × P2: validace, datum a čas, CSV, poškozené lokální úložiště, nesprávné statistiky a aktualizace PWA;
- 1 × P3: neúplná lokalizace registrace.

Nejvyšší prioritu mají importované identifikátory vykonatelné jako JavaScript a způsob slučování historie po přihlášení. Přihlášený produkční tok nebylo možné dynamicky retestovat, protože v relaci nebylo dostupné připojení k uživatelovu Chrome. Riziko synchronizace je proto potvrzené datovým tokem v kódu, nikoli produkčním účtem.

## Výsledky testů

| Oblast | Výsledek |
|---|---:|
| Node testy aplikace a auditních nástrojů | 108/108 prošlo |
| Testy kontaktní Cloud Function | 12/12 prošlo |
| Lokální E2E a statické kontroly | 57 průchodů, 11 prvotních selhání, 3 blokované kontroly |
| Falešné poplachy po diagnostice | 2: stránkování historie a offline chyba Firebase Analytics |
| Produkční smoke test | 7/7 prošlo |
| Kontaktní formulář v produkci | zpráva označená `QA TEST 2026-08-14` úspěšně odeslána |

Lokální E2E běžel v Microsoft Edge/Chromium na 1440 × 900, 390 × 844 a 320 × 568 px, v češtině i angličtině a ve světlém i tmavém režimu. Firefox, WebKit a headless Chrome nebyly v prostředí dostupné. Reálný iOS/Android telefon nebyl podle schváleného rozsahu použit.

## Nálezy

### PL-SEC-01: Importovaný backup může spustit JavaScript (P1)

**Dopad:** Útočně upravený JSON backup může po otevření celé historie vykonat JavaScript v kontextu PouchLogu. To může zpřístupnit data aplikace a přihlášenou Firebase relaci.

**Reprodukce:**

1. Importovat historii s ID `x');window.__qaXss='executed';//`.
2. Otevřít „Full History“ a kliknout na „Edit“.
3. `window.__qaXss` má hodnotu `executed`.

**Příčina:** `index.html:2916` vkládá neověřené `h.id` do inline `onclick`. Import na `index.html:3167` kontroluje pouze existenci `history` a `settings`, nikoli schéma nebo ID.

**Návrh opravy:** Historii sestavovat přes DOM API, text vkládat přes `textContent` a akce připojit pomocí `addEventListener` s ID v closure nebo `dataset`. Import validovat proti pevnému schématu, nebezpečná ID odmítnout nebo přegenerovat. Doplnit CSP bez `unsafe-inline` a regresní test s uvedeným payloadem.

### PL-SYNC-01: Přihlášení může přepsat lokální historii; prázdný cloud se nepropaguje (P1)

**Dopad:** Uživatel může před přihlášením vytvořit lokální záznamy, které se do cloudu nenahrají. Jakmile přijde neprázdný Firestore snapshot, lokální historie se celá nahradí vzdálenou. Naopak smazání posledního vzdáleného záznamu se kvůli podmínce `if (h.length)` do druhé relace nepropíše.

**Příčina:** Jednořádkový callback na `index.html:3364` nahrazuje `state.history` jen při neprázdném snapshotu. Neexistuje počáteční migrace lokálních dat, merge podle ID, verze záznamů ani tombstones. Zápisy a mazání navíc místy ignorují nebo nezachytávají selhání Firestore.

**Návrh opravy:** Definovat jednotnou synchronizační politiku. Při prvním přihlášení sloučit lokální a vzdálená data podle stabilního ID a času změny, transakčně nahrát lokální záznamy a aplikovat i prázdné snapshoty. Mazání reprezentovat tombstonem nebo potvrzenou serverovou operací. UI nesmí hlásit synchronizaci jako dokončenou před potvrzením zápisu.

### PL-PRIV-01: Aplikace nesplňuje deklarované mazání účtu a účtových dat (P1)

**Dopad:** README i Privacy Policy tvrdí, že uživatel může v nastavení odstranit účet, historii a účtová data. UI však nabízí pouze „Delete All“ v modalu historie. Funkce smaže lokální a cloudovou historii, ale ponechá Firebase Auth účet, profilové nastavení a vlastní sáčky.

**Důkaz:** `README.md:57`, `privacy.html:210` a implementace `index.html:3061–3072`.

**Návrh opravy:** Buď implementovat samostatné „Delete account and all data“ s opětovným ověřením uživatele a serverovým smazáním historie, nastavení, vlastních sáčků i Firebase Auth účtu, nebo okamžitě upravit dokumentaci na skutečný rozsah „Delete All“. Obě akce musí mít odlišný text a potvrzení.

### PL-VAL-01: Nastavení přijímá nesmyslné hodnoty (P2)

**Dopad:** Wizard uložil prázdnou měnu, cenu `-1`, počet sáčků `0` a denní limit `-5`. UI pak zobrazuje záporný limit a výpočty nákladů nebo upozornění ztrácejí význam. Stejný problém lze zanést importem. Cílové datum odvykání také nemá kontrolu, že leží v budoucnosti.

**Příčina:** Hodnoty se na `index.html:3122–3124` pouze převedou přes `Number`; vstupy nemají potřebné `min`, `step` a aplikační validaci.

**Návrh opravy:** Vyžadovat neprázdnou měnu, cenu nejméně 0, kladný celočíselný počet kusů, nezáporný celočíselný limit a budoucí cílové datum pro odvykání. Stejný validátor použít pro wizard, import i cloudová nastavení.

### PL-DATE-01: Editace nočního zpětného záznamu posune datum o den (P2)

**Dopad:** Záznam vytvořený pro 12. srpna v 00:30 v časové zóně Europe/Prague se v editoru otevřel jako 11. srpna. Uložení bez povšimnutí změní den a následně statistiky i sérii.

**Příčina:** Editor na `index.html:2931–2932` bere datum a čas pomocí `slice` přímo z UTC ISO řetězce.

**Návrh opravy:** Naplnit formulář z lokálních složek `Date` (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`) nebo používat již uložené `localDate`. Přidat regresní scénáře pro 00:30, 23:30 a přechody letního času.

### PL-CSV-01: CSV export se rozbije na uvozovkách a neřeší vzorce (P2)

**Dopad:** Název `QA "Quoted", =2+2` vytvořil šest sloupců místo pěti a po načtení se nevrátil původní text. Hodnoty začínající `=`, `+`, `-` nebo `@` mohou tabulkové aplikace vyhodnotit jako vzorec.

**Příčina:** `index.html:3150` obalí značku a název uvozovkami, ale vnitřní uvozovky nezdvojuje a neprovádí ochranu před CSV formula injection.

**Návrh opravy:** Zavést jednu funkci `escapeCsvCell`, která převádí hodnotu na text, zdvojí `"`, chrání nebezpečný první znak a každé textové pole korektně uzavře. Přidat round-trip test s čárkou, uvozovkami, novým řádkem, diakritikou a vzorcem.

### PL-STORAGE-01: Poškozený `localStorage` zablokuje spuštění aplikace (P2)

**Dopad:** Jediná neplatná JSON hodnota v `nt_history` ukončí inicializaci chybou `Expected property name or '}' in JSON...`. UI se sice vykreslí z HTML, ale listenerům a logice chybí inicializace. Uživatel se zotaví jen ručním vymazáním dat webu.

**Příčina:** Přímé `JSON.parse` bez ochrany na `index.html:2278` a `index.html:2286–2288`.

**Návrh opravy:** Použít sdílený `safeReadJson(key, fallback, validator)`, vadnou hodnotu přesunout do diagnostické zálohy nebo odstranit, pokračovat s fallbackem a zobrazit srozumitelné upozornění. Ošetřit každou uloženou strukturu samostatně.

### PL-STATS-01: Nový uživatel bez dat dostane profil „Top 10 % / elita“ (P2)

**Dopad:** Při nulové historii aplikace zobrazí „Top 10% (Casual)“ a „You're elite! Minimal dependence.“. Jde o zavádějící zdravotní a behaviorální interpretaci bez jediného měření.

**Příčina:** `dailyAvg` je pro prázdnou historii 0 a výběr benchmarku jej automaticky přiřadí do nejlepšího pásma; `renderBenchmark` na `index.html:2736` nekontroluje počet záznamů.

**Návrh opravy:** Benchmark skrýt nebo zobrazit „Zatím není dost dat“, dokud není splněno předem určené minimum zaznamenaných dnů.

### PL-BADGE-01: Odznaky za včerejšek a čistý víkend se odemknou bez příslušných dat (P2)

**Dopad:** Profil s jediným dnešním záznamem odemkl mimo jiné „Weekend Hero“ a „Discipline“, přestože neexistoval žádný záznam ze včerejška ani z víkendu.

**Příčina:** Na `index.html:2548` a `index.html:2564` se chybějící den interpretuje jako nula a tím jako splněný limit. Stačí jakýkoli záznam kdekoli v historii.

**Návrh opravy:** Úspěch počítat pouze pro explicitně zaznamenané dny. Víkendový odznak vyžadovat až po skončení víkendu a po doložení obou dnů; včerejší disciplínu jen při existenci včerejšího záznamu nebo jiného explicitního potvrzení nulové spotřeby.

### PL-PWA-01: Cache-first assety mohou zůstat po nasazení zastaralé (P2)

**Dopad:** Nainstalovaná PWA může dál používat starý `data.js`, ikony nebo další assety, pokud se při deployi nezmění také `sw.js`. To je kritické zejména pro opravy katalogu sáčků.

**Příčina:** Pevný `CACHE_NAME = 'pouchlog-v1.3'` a cache-first větev na `sw.js:57`. Service worker se znovu neinstaluje pouze kvůli změně souboru, který sám cachuje.

**Návrh opravy:** Verzi cache generovat nebo zvyšovat při každém releasu, případně pro vlastní statické assety použít stale-while-revalidate s aktualizací cache. Přidat test simulující druhé nasazení změněného `data.js`.

### PL-I18N-01: Česká registrace přepne nadpis na anglické „Register“ (P3)

**Dopad:** V českém rozhraní se po přepnutí na registraci zobrazí anglický nadpis. Stejně je natvrdo řetězec „Sync“.

**Příčina:** Pevné texty na `index.html:3306` místo překladových klíčů.

**Návrh opravy:** Přidat samostatné EN/CS klíče pro přihlášení a registraci a používat je i při změně jazyka v otevřeném dialogu.

## Co prošlo

- první spuštění, povinná volba cíle a persistence onboardingových hodnot;
- režim sledování a strategie `smooth`, `weekly` a `cutoff`;
- vyhledání katalogového sáčku, zápis, reload a jednotlivé mazání;
- HTML escapování názvu a značky vlastního sáčku;
- stránkování 16 záznamů jako 14 + 2 a dvojité potvrzení „Delete All“;
- JSON backup, poškozený import bez ztráty stávajících dat a přeskočení budoucích/neplatných záznamů;
- service worker, offline reload a offline lokální zápis;
- žádný horizontální overflow na 1440, 390 a 320 px;
- klávesová skip link, návrat focusu po dialogu, popisky viditelných polí a přístupné názvy ovládacích prvků;
- rozměry PWA ikon odpovídají manifestu;
- produkční homepage a Privacy Policy vracejí 200, lokální produkční zápis i úklid fungují a kontaktní formulář zprávu skutečně odeslal.

## Omezení a doporučené pořadí

1. Okamžitě opravit `PL-SEC-01` a doplnit regresní test importu.
2. Před propagací cloudového syncu opravit `PL-SYNC-01` a otestovat jej na čistém účtu ve dvou nezávislých relacích.
3. Vyřešit `PL-PRIV-01`, protože současný produkt neodpovídá vlastní Privacy Policy.
4. V jednom validačním balíku opravit `PL-VAL-01`, `PL-DATE-01`, `PL-CSV-01` a `PL-STORAGE-01`.
5. Následně opravit statistické interpretace, PWA aktualizaci a lokalizaci.

Pro kompletní regresi zbývá připojit uživatelův Chrome přes **Settings → Computer use** a zopakovat Google login, logout, merge lokální a cloudové historie, prázdný snapshot, sync mezi dvěma relacemi a selhání zápisu. Firefox/WebKit a fyzická mobilní instalace zůstaly mimo ověřený rozsah.
