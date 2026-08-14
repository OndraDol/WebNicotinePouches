# Pouch audit v3: auditovatelná kontrola 861 vstupů

## Cíl

Vytvořit nový, od historického `recheck-v2` oddělený auditní tok, který
umožní skutečně auditovatelnou kontrolu přesně 861 zmrazených `input_id`.
Kontrola je dokončená pouze tehdy, když jsou pro každé ID doložené všechny
povinné věcné kroky, každý kandidát je zkontrolovaný nebo deterministicky
odmítnutý, read-only validátor odvodí konečný stav z raw událostí a samostatná
QA ověří hash vstupní karty i hash kontrolovaných událostí.

Historické soubory `recheck-v2` zůstanou zachované, ale jejich evidence,
souhrnné booleany a `qa_status=passed` se do v3 nesmí převzít. `data.js` se
během pilotu nemění.

## Rozhodnutí o architektuře

Použije se nový v3 pipeline v `audit/pouches/recheck-v3/`, nikoli obal nad
v2 kartami ani nová databáze. JSONL zachová append-only stopu, snadnou kontrolu
diffem a návaznost na existující Node.js ESM nástroje. Komponenty spolu budou
komunikovat přes soubory a CLI kontrakty.

Tok dat:

```text
data.js + audit/pouches/input.json + audit/pouches/unresolved-input.json
        |
        v
freeze-v3.mjs
        |
        v
input-snapshot.json -----------------------+
                                            |
research-v3.mjs -- append --> raw-events.jsonl
                                            |
                                            v
                                 validator-v3.mjs
                                            |
                                            v
                                  derived-results.jsonl
                                            |
                                            v
                                      qa-v3.mjs
                                            |
                                            v
                                         qa.jsonl
```

Výzkumník pouze zapisuje raw události. Validátor neimportuje research modul a
nečte jeho souhrnné booleany. QA nečte pouze `outcome` ani
`protocol_complete`, ale ověřuje vstupy, události a pravidla nezávisle.

## Zmrazený vstup

`freeze-v3.mjs` vytvoří `audit/pouches/recheck-v3/input-snapshot.json`.

Snapshot obsahuje:

- `schema: 3`;
- cestu a SHA-256 zdrojového snapshotu;
- SHA-256 aktuálního `data.js` v okamžiku zmrazení;
- přesně 861 unikátních `input_id`;
- pro každý řádek `input_id`, `original_index`, původní `brand`, název,
  `mg` a `input_card_sha256`;
- kanonický `snapshot_sha256` celého pořadí a obsahu karet.

Množina ID se vezme z existujícího zmrazeného seznamu 861 nevyřešených vstupů,
ale každá karta se znovu porovná s aktuálním `input.json` a `data.js`. V3
nesmí převzít původní důkazní záznamy, HTTP údaje, hash odpovědí ani výsledky
z v2. Po vytvoření snapshotu validator odmítne jeho změnu.

Kanonický JSON používá UTF-8, deterministické pořadí klíčů, žádné zbytečné
mezery a přesný číselný zápis. Hash karty se počítá z objektu bez vlastního
hashového pole. Stejná pravidla platí pro události, QA záznamy a výsledný
snapshot.

## Raw event log

`raw-events.jsonl` je append-only log. Každý řádek obsahuje:

```json
{
  "event_id": "evt-000001",
  "input_id": "input-...",
  "event_type": "url_opened",
  "recorded_at": "2026-08-14T00:00:00.000Z",
  "previous_event_sha256": "...",
  "event_sha256": "...",
  "payload": {}
}
```

`event_sha256` je SHA-256 kanonického JSONu události bez vlastního hashového
pole. `previous_event_sha256` vytváří řetězec pořadí. Validator odmítne
duplicitní `event_id`, chybný hash, přerušený řetězec, změnu pořadí nebo
událost mimo zmrazenou množinu.

Povolené typy událostí:

- `search_attempt`: systém, přesný dotaz, request URL, HTTP stav, čas, finální
  URL, titul, SHA-256 odpovědi, stav parsování a všechny nalezené kandidátní
  URL;
- `catalog_lookup`: katalog/vlastník, item-specific lookup key, výsledek,
  nalezené URL nebo explicitní no-match a hash použitého snapshotu;
- `url_opened`: požadovaná a finální URL, HTTP stav, titul, SHA-256, stav
  parsování a extrahovaná produktová data;
- `candidate_decision`: konkrétní kandidátní URL, rozhodnutí
  `exact_match`, `near_match` nebo `wrong_variant` a individuální důvod;
- `owner_lookup`: raw výsledek owner-specific pokusu;
- `transport_event`: timeout, síťová chyba, cache hit, sleep nebo
  neparseovatelná odpověď.

Raw log nesmí obsahovat `protocol_complete`, `saturation`, `outcome`,
`qa_status`, `unreviewed_candidate_count` ani jejich aliasy. Výzkumník smí
zapsat pozorovanou hodnotu a rozhodnutí nad konkrétním kandidátem, ale nesmí
zapsat konečný stav karty.

## Read-only validator

`validator-v3.mjs` načte pouze `input-snapshot.json` a `raw-events.jsonl` a
vytvoří `derived-results.jsonl` a strojově čitelný validační report. Nesmí
importovat `research-v3.mjs`, volat jeho funkce pro dokončení protokolu ani
věřit uloženým souhrnným booleanům.

### Úspěšná akce

Za úspěšnou vyhledávací cestu se počítá pouze úspěšná parseovatelná odpověď
s HTTP 2xx. HTTP 429, síťová chyba, timeout, sleep, cache hit a
neparseovatelná odpověď se pro povinné brány nepočítají. Mohou zůstat
zachované v raw logu jako negativní auditní stopa.

### Katalogy a kandidáti

Obecný katalog nebo sitemap se počítá jen při současné existenci:

1. item-specific lookup key;
2. výsledku hledání;
3. nalezené kandidátní URL nebo explicitního no-match;
4. individuálního rozhodnutí nad každým nalezeným kandidátem.

Sdílený katalogový snapshot je povolen, pokud událost obsahuje jeho hash a
item-specific výsledek. Samotné připsání katalogového URL ke kartě se nepočítá.

Každý relevantní kandidát z úspěšného vyhledávání nebo katalogu musí mít
událost `url_opened` a `candidate_decision`. Bez otevření je odmítnutelný jen
podle explicitního deterministického pravidla, například zjevně
neproduktová doména; důvod musí být individuální. Výsledný
`unreviewed_candidate_count` je odvozený počet a pro úplnou kartu musí být 0.

Neznámá doména má klasifikaci `unknown`. Nesmí být automaticky označena jako
retailer ani jako product-detail zdroj. Zdroje se deduplikují podle
`owner_group_id`, nejen podle hostname; Haypp a Northerner tedy tvoří jednu
vlastnickou větev.

### Owner lookup a saturace

Owner-specific lookup musí proběhnout před tím, než validator povolí saturaci.
`owner=not_identified` je platné pouze po doložených úspěšných
owner-specific pokusech, nejméně v obou použitých nezávislých vyhledávacích
systémech, bez identifikace vlastníka.

Saturace se odvozuje až po dvou materiálně odlišných úspěšných dotazech,
které nepřinesly novou relevantní doménu ani kandidáta. Dotaz, který přinesl
novou doménu nebo kandidáta, nemůže současně doložit `no_new_domains` nebo
`no_new_candidates`. Stránkování, `exact continuation N` a pouhé
přeformátování téhož dotazu nejsou materiálně odlišné.

### Mg/sáček a výsledky

Produktová identita a síla musí být z jedné přesné produktové identity.
Přepočet z `mg/g` je platný pouze při přesné čisté hmotnosti a počtu sáčků ze
stejné varianty. Search snippet není produktový důkaz.

Validator odvodí:

- `verified`: přesná identita a mg/sáček z výrobce, vlastníka značky nebo
  regulátora, případně dva skutečně nezávislé přesné produktové zdroje;
- `conflicted`: dva nezávislé přesné důvěryhodné zdroje uvádějí různé
  mg/sáček;
- `unresolved_after_complete_search`: všechny akční brány jsou splněné,
  ale důkazní práh nebyl dosažen;
- `pending/incomplete`: chybí povinná akce, rozhodnutí kandidáta nebo
  validator nedokáže stav odvodit.

`unresolved_after_complete_search` se nikdy nesmí prezentovat jako
`verified` a nesmí navrhovat změnu `data.js`.

## Nezávislá QA

`qa-v3.mjs` vytvoří přesně jeden QA záznam na `input_id` v
`audit/pouches/recheck-v3/qa.jsonl`.

Každý záznam musí obsahovat:

- `input_id`;
- `input_card_sha256` přesné zmrazené karty;
- `raw_events_sha256` přesně kontrolované množiny/úseku událostí;
- `derived_result_sha256` kontrolovaného validačního výsledku;
- jednotlivé kontroly a jejich chyby;
- odvozený `qa_status`.

QA ověřuje přímo snapshot a raw log, nikoli pouze uložený `outcome`,
`protocol_complete`, `saturation` nebo podobné pole. QA nesmí měnit snapshot,
raw log ani kartu. Jakákoli pochybnost vede k `qa_failed` a návratu ID do
`pending` pro nový výzkumný průchod.

## Pilot a schválení

Před živou rešerší se spustí negativní testy pro:

1. druhý vyhledávač s HTTP 429;
2. tři obecné katalogy bez item-specific lookupu;
3. `owner=not_identified` bez owner pokusů;
4. neznámou doménu automaticky označenou jako retailer;
5. falešnou saturaci po nových doménách nebo kandidátech;
6. jediný nezkontrolovaný kandidát;
7. dvě URL stejné firemní skupiny jako údajně nezávislé zdroje;
8. QA, která pouze přečte uložené souhrny;
9. `verified` bez produktové stránky;
10. zkopírovanou stopu jiné produktové identity.

Pilotní příkazy jsou omezené na:

```text
node scripts/pouch-audit/recheck-v3.mjs --freeze
node scripts/pouch-audit/recheck-v3.mjs --pilot
node scripts/pouch-audit/recheck-v3.mjs --validate --pilot
node scripts/pouch-audit/recheck-v3.mjs --qa --pilot
```

Pilot zpracuje pouze pět položek značky `77 Pouches`. Report
`pilot-report.md` pro každou kartu zobrazí zmrazenou identitu a hash, raw
dotazy, kandidáty, otevřené a finální URL, tituly, HTTP stavy, SHA-256,
extrahované hodnoty, rozhodnutí kandidátů, odvozené brány, saturaci,
`unreviewed_candidate_count`, výsledek a QA hashe.

Po pilotním reportu se běh zastaví. Dalších 856 položek se nesmí zpracovat,
dokud uživatel výslovně neschválí pilot. Schválení se zaznamená do
`pilot-approval.json` s hashem snapshotu, hashem validatoru, seznamem pěti ID,
časem a důvodem `explicit user approval`. Změna validatoru po schválení
zneplatní schválení a vyžaduje nový pilot.

Po schválení se pokračuje po značkách v dávkách nejvýše 25 položek. Každá
dávka projde zmrazeným validátorem a čerstvou read-only QA dříve, než začne
další dávka.

## CLI a soubory

Nové implementační soubory budou mít tyto odpovědnosti:

- `scripts/pouch-audit/recheck-v3-schema.mjs`: kanonikalizace, hashování a
  kontrola tvaru raw událostí bez výzkumné logiky;
- `scripts/pouch-audit/recheck-v3-freeze.mjs`: vytvoření a ověření snapshotu;
- `scripts/pouch-audit/recheck-v3-research.mjs`: append-only sběr raw
  událostí, pilotní režim, resume a dávkové checkpointy;
- `scripts/pouch-audit/recheck-v3-validator.mjs`: read-only odvození stavů;
- `scripts/pouch-audit/recheck-v3-qa.mjs`: nezávislá QA;
- `scripts/pouch-audit/recheck-v3.test.mjs`: jednotkové a negativní testy;
- `audit/pouches/recheck-v3/input-snapshot.json`;
- `audit/pouches/recheck-v3/raw-events.jsonl`;
- `audit/pouches/recheck-v3/derived-results.jsonl`;
- `audit/pouches/recheck-v3/qa.jsonl`;
- `audit/pouches/recheck-v3/pilot-report.md`;
- `audit/pouches/recheck-v3/progress.json`;
- `audit/pouches/recheck-v3/pilot-approval.json` až po schválení pilotu.

Historické v2 soubory se nemažou a v3 je nepoužívá jako důkazní zdroj.
`data.js` se v pilotní fázi nemění.

## Globální stop podmínky

Audit lze označit za dokončený pouze při současném splnění všech podmínek:

- přesně 861 unikátních `input_id`;
- přesně jedna v3 karta, jeden validační výsledek a jeden QA záznam na ID;
- 0 `pending/incomplete`;
- 0 `unreviewed_candidate_count`;
- každá karta je hashově svázaná se snapshotem a raw událostmi;
- fail-closed validator skončí kódem 0 pro 861/861;
- samostatně jsou uvedeny počty `verified`, `conflicted` a
  `unresolved_after_complete_search`;
- unresolved výsledek není prezentován jako verified;
- `data.js` se změní jen podle přímo doloženého výsledku `verified` nebo
  jiného výslovně bezpečného, testy podloženého rozhodnutí;
- dokončení není založené pouze na počtu řádků, době běhu nebo uloženém
  `qa_status=passed`.

Pilot sám globální dokončení neznamená. Po jeho vytvoření se práce zastaví a
čeká na explicitní schválení uživatele.

## Ověření

Před pilotem musí projít v3 testy všech deseti negativních scénářů a testy
hashů, append-only integrity, exact identity setu, nezkontrolovaných
kandidátů, materiality dotazů, owner/group deduplikace, QA nezávislosti a
fail-closed návratových kódů. Po pilotu se ověřují pouze pilotní soubory a
report; živý výzkum dalších ID je zakázán.

Po globálním dokončení se provede cíleně:

```text
node --test scripts/pouch-audit/recheck-v3.test.mjs
node scripts/pouch-audit/recheck-v3.mjs --validate
node scripts/pouch-audit/recheck-v3.mjs --qa
node --check data.js
node --check sw.js
git diff --check
```

Případná změna validatoru po pilotním schválení znamená nový hash, neplatné
schválení a nový pětikaretní pilot.
