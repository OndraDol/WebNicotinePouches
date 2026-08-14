# Návrh odstranění chyb z QA auditu

## Cíl a hranice

Cílem je odstranit všech 11 potvrzených chyb popsaných v `docs/qa/2026-08-14-pouchlog-qa-report.md`. Součástí změny bude skutečná funkce pro odstranění účtu a všech jeho cloudových dat. Při vývoji se nesmí odstranit reálný účet ani reálná data, volat produkční mazací funkce nebo nasadit změny do Firebase.

Opravy zachovají současnou jednosouborovou podobu uživatelského rozhraní. Sdílená čistá logika se přesune do malého modulu `app-core.mjs`, aby ji šlo ověřit bez prohlížeče a bez nových závislostí.

## Bezpečné načtení a validace dat

`app-core.mjs` bude obsahovat čisté funkce pro bezpečné parsování JSON, validaci nastavení a záloh, práci s místním datem, tvorbu CSV, slučování historie a vyhodnocení odznaků.

Čtení z `localStorage` nesmí volat `JSON.parse` přímo. Neplatný obsah se ignoruje, aplikace použije bezpečnou výchozí hodnotu a zapíše diagnostické varování do konzole. Původní poškozená hodnota se během inicializace nemaže.

Průvodce přijme nastavení pouze tehdy, když:

- měna po oříznutí obsahuje 1 až 8 znaků;
- cena balení je konečné číslo větší než nula;
- počet sáčků v balení je celé číslo od 1 do 1000;
- denní limit je celé nezáporné číslo;
- cíl odvykání nemá datum před dnešním místním datem.

Import bude atomický. Kořen zálohy, nastavení i každý záznam historie musí projít stejnou validací; při chybě se současný stav nezmění. ID historie musí odpovídat formátu `[A-Za-z0-9_-]{1,128}`, textová pole musí být neprázdná a omezená délkou, síla musí být konečné nezáporné číslo a datum musí být platné. Uživatelská data se nikdy nevkládají do inline obsluhy události nebo do HTML řetězce.

## Historie, datum a export

Úplný seznam historie se vytvoří pomocí DOM uzlů. Tlačítka pro úpravu a odstranění dostanou obsluhu přes `addEventListener`, takže importované ID nebude možné spustit jako JavaScript.

Editor převede čas záznamu na místní datum a čas pomocí metod `Date`, nikoli pomocí výřezu UTC řetězce. Uložení znovu vytvoří místní `Date` a až poté ISO čas pro databázi.

CSV bude odpovídat běžnému formátu RFC 4180. Uvozovky se zdvojí a každé textové pole se uzavře do uvozovek. Hodnota začínající znaky `=`, `+`, `-` nebo `@` dostane před exportem apostrof, aby tabulkový editor nespustil vzorec. Soubor začne UTF-8 BOM kvůli správnému otevření českých znaků.

## Synchronizace a oddělení účtů

Klíč `nt_history_owner` určí, zda místní historie patří hostovi, nebo konkrétnímu Firebase UID.

Při přihlášení se nejprve jednorázově načte cloudový stav:

- hostovská historie se sloučí s cloudovou podle ID; při konfliktu stejného ID má přednost cloudová verze;
- historie označená jiným nebo stejným UID se nepřenáší do účtu a cloudový stav ji nahradí, včetně prázdné historie;
- chybějící hostovské záznamy se odešlou do cloudu před spuštěním posluchače;
- posluchač následně přijme každý snapshot, včetně prázdného, takže odstranění z jiného zařízení nezůstane skryté;
- před změnou účtu nebo odhlášením se předchozí posluchač odpojí.

Po odhlášení se místní historie a vlastní sáčky účtu odstraní pouze z prohlížeče a úložiště se přepne na prázdného hosta. Cloudová data se běžným odhlášením nemažou. Tento postup brání smíchání historie dvou účtů i opětovnému nahrání dříve odstraněných cloudových záznamů.

Zápisy, úpravy a odstranění budou `await`ované a chyby se zobrazí uživateli. Už potvrzená místní změna se při chybě cloudu nepředstírá jako synchronizovaná.

## Odstranění účtu

Klient zobrazí samostatný dialog jen přihlášenému uživateli. Uživatel musí znovu napsat e-mail účtu a čerstvě ověřit identitu:

- Google účet přes `reauthenticateWithPopup`;
- účet s heslem přes `reauthenticateWithCredential` a zadané heslo.

Po úspěšném ověření klient zavolá callable funkci `deleteAccount`. Backend odmítne anonymní požadavek a token s `auth_time` starším než pět minut. Potom rekurzivně odstraní `users/{uid}` včetně všech podkolekcí a odstraní uživatele z Firebase Authentication. Neexistující autentizační účet se při opakování považuje za dokončený stav. Po úspěšné odpovědi klient vyčistí pouze klíče PouchLogu s prefixem `nt_` a vrátí aplikaci do odhlášeného výchozího stavu.

Serverová logika bude oddělena v `functions/delete-account.js` a dostane databázi, autentizaci a čas jako závislosti. Jednotkové testy proto použijí pouze falešné adaptéry. Testy nesmějí připojit produkční Firebase projekt ani skutečně odstranit účet.

## Statistiky a odznaky

Benchmark se při prázdné historii nevypočítá. Uživatelské rozhraní místo elitního percentilu zobrazí neutrální zprávu o chybějících datech.

Odznak za včerejší disciplínu vyžaduje, aby sledování začalo nejpozději včera. Čistý víkend se vyhodnotí jen pro poslední dokončenou sobotu a neděli a pouze tehdy, když sledování začalo nejpozději v sobotu. Chybějící historie před začátkem sledování se tak nebude vydávat za úspěch.

## PWA a lokalizace

Service worker dostane novou verzi cache. Navigace, `index.html`, `data.js` a `app-core.mjs` použijí síťový požadavek s návratem ke cache při nedostupnosti. Ostatní statické prostředky použijí stale-while-revalidate. Změněný datový soubor se proto obnoví bez nutnosti ručně měnit service worker při každé další aktualizaci.

Český registrační dialog bude používat překladové klíče pro registraci i synchronizaci. Žádný titulek se nebude nastavovat natvrdo anglickým řetězcem.

## Ověření

Každá oprava začne selhávajícím regresním testem. Čisté funkce ověří Node `node:test`; serverové mazání použije falešné závislosti; stávající testy auditu, streaku a kontaktu musí zůstat zelené. Nakonec proběhne lokální prohlížečová kontrola hlavních nedestruktivních cest, mobilního rozvržení, konzole a offline PWA. Produkční nasazení, přihlášení do skutečného účtu a skutečné odstranění účtu zůstanou mimo ověření.
