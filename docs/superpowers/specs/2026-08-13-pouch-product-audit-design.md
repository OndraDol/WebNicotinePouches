# Pouch product audit design

## Cíl

Dokončit audit přesně 861 původně neověřených `input_id` z neměnného
`audit/pouches/input.json`, přičemž každý řádek dostane vlastní obnovitelnou
rešeršní stopu, konečný ledgerový stav a konzervativní rozhodnutí. Opravy se
aplikují pouze tehdy, když přesná produktová identita a síla na jeden sáček
dosáhnou požadovaného důkazního prahu.

## Architektura

- `unresolved-input.json` je jednorázově zmrazený seznam ID odvozený z
  původního ledgeru (`match_status=no_match` a `existence_status=ambiguous`).
- `research-log.jsonl` je append-only log; jeden dokončený záznam pro každý ID
  obsahuje dotazy, URL, vlastníky větví, explicitní hodnoty, SHA-256 odpovědí,
  omezení a `terminal_reason`.
- `.cache/pouch-audit/` ukládá pouze obnovitelné odpovědi a strukturované
  mezivýsledky. Hromadné discovery slouží k nalezení kandidátů, ale důkazem je
  až přesně spárovaná otevřená stránka/regulátor nebo dvě nezávislé retailerové
  větve.
- Auditní běh zpracovává značky a nejvýše 25 ID v checkpointu. Dokončené ID se
  při restartu neopakuje. Nedoložené identity skončí teprve po 600 sekundách
  skutečné aktivní rešerše jako `exhausted_10m/unverified`.
- `--apply-safe` mění jen přesně mapované řádky `data.js`: důkazem podložené mg,
  přesné duplicity a explicitně invalidní/ukončené identity podle pravidel.
  Neprovádí globální přegenerování ani přetřídění.

## Důkazní rozhodování

Párování zachovává celý název, variantu, sílu, formát a trh. Přímý údaj
`mg/pouch` od výrobce nebo regulátora stačí; jinak musí shodné údaje dodat dvě
nezávislé vlastnické větve. Přepočet z `mg/g` je povolen jen s přesnou čistou
hmotností jedné plechovky a počtem sáčků ze stejné varianty. Haypp a Northerner
se počítají jako jedna větev. Konflikty se neřeší hlasováním.

## Validace

Testy ověřují zmrazení ID, append-only/dokončené logování, checkpoint resume,
600sekundový stop, přesné párování, nezávislost důkazů, bezpečné změny a
idempotenci. Finální běh spouští `node --test`, auditní offline validaci,
syntaktické kontroly, `git diff --check` a kontrolu pracovního stromu.
