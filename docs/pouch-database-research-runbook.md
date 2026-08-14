# Pouch database research runbook

Tento dokument je trvalý kontrakt pro auditované rozšiřování `POUCH_DB`. Každá relace přidává právě 100 nových SKU a končí jediným commitem a pushem celé dávky. Neúplná nebo neověřená dávka se necommitne ani nepushne.

## Rozsah a pořadí trhů

Postupuj podle `pouch-research-state.json`: `US+CA` → `Europe excluding CZ` → `CZ`. `market` znamená trh, kde je SKU aktuálně nabízeno, nikoli zemi původu značky. Aktivní maloobchodní nabídka dokládá dostupnost, nikoli regulatorní autorizaci; regulatorní status netvrď bez samostatného oficiálního důkazu.

Zařazuj pouze aktivní nikotinové sáčky s doloženou hodnotou mg nikotinu na jeden sáček. Vyřaď snus, dip, sáčky s tabákovým listem, kofeinové a beznikotinové sáčky, mixpacky bez jednoznačného SKU, ukončené produkty a varianty pouze s nejasným nebo konfliktním údajem. Do nové dávky neprováděj úklid starých dat.

## Důkazy

Preferuj aktuální stránku výrobce nebo regulátora. Jinak použij zavedeného specializovaného prodejce, jehož stránka výslovně uvádí plný obchodní název, dostupnou sílu a mg na sáček. Výsledek vyhledávače, marketplace, sociální síť, fórum ani obecný agregátor nejsou finální důkaz.

Hodnotu mg/g přepočítej pouze tehdy, když stejný zdroj pro přesně tutéž variantu uvádí také čistou hmotnost a počet sáčků. Do `calculation` zapiš vzorec a vstupy; jinak kandidáta přeskoč. U přímého údaje používej `direct mg/pouch`.

## Identita a zápis SKU

Jeden SKU je kombinace značky, úplného obchodního názvu včetně řady/příchutě/formátu a síly. Pro kontrolu duplicity normalizuj značku a název pomocí Unicode NFKD, odstranění diakritiky, malých písmen, sjednocení `&`/`and`, interpunkce a mezer. Sjednoť také zápis celé síly (`3.0`, `3 mg`, `3mg`), ale zachovej její číselnou hodnotu. Před vložením proveď i sémantickou kontrolu zkrácených a přejmenovaných variant; pouhá změna formátování není nový SKU.

Pro existující značku zachovej její současné `b`; v `n` použij úplný současný obchodní název. `mg` musí být konečné kladné číslo vyjadřující mg na jeden sáček. Nové řádky přidej na konec pole `POUCH_DB` v `data.js` a starých 987+ řádků se nedotýkej.

## Ledger a stav

Každý nový řádek musí mít právě jeden odpovídající řádek v `pouch-source-ledger.csv` se sloupci:

`batch,market,brand,product_name,mg_per_pouch,source_type,source_url,checked_at,calculation`

CSV zapisuj jako platné UTF-8; hodnoty s čárkou nebo uvozovkou řádně escapuj. `checked_at` je datum kontroly ve formátu `YYYY-MM-DD`. Pracovní kontrolní body ukládej po 20, 40, 60, 80 a 100 položkách změnou `in_progress.checkpoint`. Po úspěchu nastav `next_batch` na další číslo, `last_completed_total` na nový počet, aktualizuj `completed_catalogs` a odstraň `in_progress`. Dokud zůstává dost ověřitelných kandidátů, ponech `current_market`; jinak jej posuň na další položku fronty.

## Povinná validace

Před výzkumem ověř čistý `main`, proveď `git pull --ff-only origin main` a zkontroluj, že počet v `data.js` odpovídá `last_completed_total`. Ulož si parsovaný výchozí seznam v paměti nebo do dočasného souboru mimo commit.

Před dokončením musí současně platit:

1. `POUCH_DB` lze importovat a má přesně `last_completed_total + 100` řádků.
2. Všechny parsované výchozí záznamy mají stejné hodnoty a pořadí jako před dávkou; jediná dovolená syntaktická změna v jejich zdroji je oddělovací čárka za dříve posledním objektem.
3. Právě 100 nových řádků má konečné kladné `mg` a unikátní normalizovanou identitu vůči výchozím i novým řádkům.
4. Ledger obsahuje pro číslo dávky právě 100 unikátních řádků a `brand`, `product_name` i `mg_per_pouch` se přesně párují s novými položkami.
5. Všechny URL jsou `https://`, JSON i CSV jsou syntakticky platné a `pouch-research-state.json` odpovídá dokončenému stavu.
6. Projde `node --check data.js`, `node --test --test-concurrency=1 tests/*.test.mjs scripts/pouch-audit/*.test.mjs` a `git diff --check`.
7. Běžná dávka mění pouze `data.js`, `pouch-source-ledger.csv`, `pouch-research-state.json` a `sw.js`; první zavedení workflow smí navíc přidat tento runbook a jednorázově zobecnit test cache verze v `tests/service-worker.test.mjs`.

Až po splnění celé stovky zvyš `CACHE_NAME` v `sw.js` právě o jednu verzi. Commit použij ve tvaru `data: add 100 verified nicotine pouch SKUs (batch N)`, pushni bez force na `origin main` a ověř shodu lokálního a vzdáleného HEAD. Při zamítnutém pushi konflikt neobcházej a pokračovací prompt nevydávej.

## Výstup po úspěchu

Stručně uveď číslo dávky, trhy, značky, změnu počtu, commit a ověření pushnutí. Potom samostatně vypiš pokračovací `/goal` prompt, který odkáže pouze na tento runbook a stavový JSON a požaduje další přesnou stovku. Pokud validace, commit nebo push nejsou úplné, reportuj blokaci a prompt pro další dávku nevydávej.
