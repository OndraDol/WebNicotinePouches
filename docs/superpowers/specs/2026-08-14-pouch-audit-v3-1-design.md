# Pouch audit v3.1 design

## Cíl

Pouch audit v3.1 opraví důkazní cestu, která v live běhu v3 nemohla vytvořit
žádný `exact_match`. Vytvoří nový, izolovaný a reprodukovatelný audit všech
přesně 861 zmrazených `input_id`, bezpečně aplikuje pouze přímo doložené
opravy do `data.js` a zveřejní implementaci i konečné auditní artefakty na
větvi `main`.

Současný `audit/pouches/recheck-v3` zůstane beze změny jako diagnostický
záznam. Historický recheck-v2 ani současný v3 raw log se nesmějí použít jako
důkaz pro v3.1.

## Potvrzená kořenová příčina

Live parser v3 nikdy nevytváří `extracted.brand`, zatímco research writer i
validator vyžadují značku pro přesnou identitu. Stávající testy tuto mezeru
neodhalily, protože fixture události vkládají `brand` ručně a neprocházejí
reálným parserem.

Další potvrzené problémy:

- parser používá titul stránky jako celý produktový název;
- validator porovnává titul doslova s názvem ve frozen card;
- první výskyt čísla s `mg` může být zaměněn za `mg/sáček`;
- broken katalogové endpointy vytvořily 1 722 HTTP 404 a žádný platný
  `catalog_lookup`;
- owner lookup nikdy neodvodil vlastníka;
- známé zdroje a jejich vlastnické skupiny pokrývají jen malou část trhu.

V3.1 proto neopraví pouze jednu podmínku. Opraví celý tok od získání
produktových faktů po nezávislé odvození identity a síly.

## Zvolená varianta

Vznikne nový běh v adresáři `audit/pouches/recheck-v3.1`. Nebude se přepisovat
ani opravovat existující raw řetězec v3. Pět položek `77 Pouches` bude použito
jako interní pilotní checkpoint, ale běh se po něm nezastaví: uživatel dne
2026-08-14 výslovně předem schválil zpracování všech 861 položek a push na
`main`.

Po finální validaci se do Git historie uloží čitelné výsledky, QA, snapshot,
manifest a souhrn. Velké raw a reportové artefakty se uloží také jako
deterministické gzip archivy. Lokální nekomprimované soubory zůstanou
primárním vstupem validatoru a QA, ale nebudou zbytečně zvětšovat Git.

## Architektura

```text
data.js + frozen inputs
        |
        v
v3.1 immutable snapshot (861 IDs)
        |
        v
research + live transport -- append only --> v3.1/raw-events.jsonl
        |                                      |
        |                                      v
        |                           independent validator
        |                                      |
        |                                      v
        +---------------------------- independent QA
                                               |
                                               v
                              report + manifest + safe apply
                                               |
                                               v
                                 exact staged commit + main push
```

Research smí zapisovat pouze raw fakta. Validator nesmí importovat research
ani důvěřovat uloženému `match_decision` jako důkazu správnosti. QA nesmí
importovat research ani validator a musí z raw faktů znovu ověřit identitu,
sílu, zdrojovou nezávislost, kandidátní pokrytí a hashe.

V3.1 vznikne v samostatných modulech `recheck-v3-1-*`. Může importovat čisté
hash-chain a transportní primitivy v3, ale nesmí měnit chování historického
v3 CLI ani zpětně přepisovat jeho události. Hlavní vstup bude
`scripts/pouch-audit/recheck-v3-1.mjs` a samostatná testovací sada
`recheck-v3-1.test.mjs`.

## Verze a izolace dat

- Nový běh používá vlastní `run_id` a adresář `recheck-v3.1`.
- Před prvním zápisem se vytvoří nový snapshot přesně 861 unikátních ID.
- Snapshot se váže na počáteční SHA-256 `data.js`, na každou frozen card a na
  zdrojové soubory vstupu.
- Před zahájením se uloží hashe všech souborů současného `recheck-v3`; po
  skončení se ověří, že jsou stejné.
- V2 a v3 události, rozhodnutí, hashe odpovědí ani odvozené výsledky nejsou
  vstupem v3.1.
- V3.1 raw log je append-only hash chain. Oprava poškozeného konce smí pouze
  uchovat původní soubor a vytvořit nový validní prefix podle stávajícího
  repair protokolu.

## Extrakce produktových faktů

Parser vrací raw produktové skutečnosti s původem každé hodnoty, nikoli
hodnoty doplněné z frozen card. Upřednostněné zdroje jsou:

1. JSON-LD objekt typu `Product`, včetně `brand`, `name`, `sku` a varianty;
2. explicitně označené produktové atributy a tabulky;
3. produktový nadpis, breadcrumbs a URL slug;
4. HTML title pouze jako podpůrný fallback, nikdy jako jediný důkaz přesné
   varianty, pokud obsahuje neoddělený marketingový text.

`url_opened.payload.extracted` bude obsahovat podle dostupnosti:

- `brand_raw` a `brand_method`;
- `product_name_raw` a `product_name_method`;
- `variant_raw`;
- `strength_claims`, kde každý záznam uchovává hodnotu, jednotku, význam
  (`mg_per_pouch`, `mg_per_g`, `total_mg`), krátký raw label a metodu;
- `net_weight_g`, `pouch_count` a jejich původ;
- produktový identifikátor, pokud jej stránka poskytuje;
- minimální evidenční text potřebný pro audit a hash celé odpovědi.

Parser nesmí převzít značku, název ani sílu ze vstupní karty. Žádný obecný
regex typu „první číslo před mg“ nesmí vytvořit `mg_per_pouch` bez labelu nebo
strukturovaného kontextu.

## Kanonická identita produktu

Samostatný modul identity bude sdílet pouze čisté, deterministické pomocné
funkce a immutable registry. Research jej použije pro předběžnou klasifikaci;
validator a QA provedou vlastní odvození z raw hodnot.

Kanonizace:

- dekóduje HTML entity, Unicode a běžnou interpunkci;
- odstraní pouze explicitní marketingové prefixy a suffixy, například cenu,
  dopravu, „buy“ nebo „order online“;
- oddělí přímo označenou sílu od názvu;
- zachová příchuť, formát, velikost, `strong`, `slim`, `mini`, `white` a další
  potenciálně variantní tokeny;
- používá explicitní registry aliasů značek. Pro `77 Pouches` je povolen alias
  `77`, protože jde o doloženou podobu značky, nikoli o automatické doplnění
  ze vstupní karty.

Přesná identita vyžaduje:

1. doloženou a kanonicky shodnou značku;
2. shodné produktové jádro a všechny přítomné variantní tokeny;
3. item-specific `product_detail` stránku;
4. úspěšně parsovanou odpověď;
5. přesnou sílu s platnou sémantikou.

Pokud zdroj uvádí další nevysvětlený variantní token, výsledek je `near_match`,
nikoli `exact_match`.

## Síla v mg na sáček

Přímé tvrzení `mg/pouch`, `mg per pouch` nebo jednoznačný ekvivalent má
přednost. Přepočet z `mg/g` je povolen pouze tehdy, když stejný produktový
blok nebo stejný strukturovaný `Product` objekt poskytuje čistou hmotnost a
počet sáčků stejné varianty:

```text
mg_per_pouch = mg_per_g * net_weight_g / pouch_count
```

Nejednoznačné údaje, celkový nikotin, síla jiné varianty, data z product-list
stránky a čísla z marketingového textu se nepoužijí. Validator uchová výpočet
a zdroj každé vstupní hodnoty.

## Zdroje, vlastnictví a vyhledávání

Prahy zůstávají fail-closed:

- jeden přesný výrobce, vlastník značky nebo regulátor stačí pro `verified`;
- jinak jsou potřeba dva přesné a skutečně nezávislé zdroje;
- dvě domény stejné vlastnické skupiny tvoří jednu větev;
- search snippet není produktový důkaz.

Registry domén a `owner_group_id` se rozšíří pouze po doloženém vlastnictví.
Neznámá doména zůstane `unknown` a sama nemůže vytvořit ověřený výsledek.

Discovery bude po značkách používat:

1. oficiální web a item-specific site search;
2. dostupné regulatorní katalogy nebo veřejné datasety;
3. auditované nezávislé retailery;
4. dva nezávislé obecné vyhledávače s materiálně odlišnými dotazy;
5. browser/HTML fallback pro JavaScript, age gate nebo anti-bot stránku, vždy
   s raw transportní událostí.

Broken katalogový endpoint se nepoužije opakovaně pro každou kartu. Jeho stav
se ověří jednou; následně se použije doložený náhradní endpoint nebo se zdroj
označí jako nedostupný.

Owner lookup smí nastavit vlastníka pouze z explicitního zdroje, například
oficiálního legal/about záznamu nebo regulatorních dat. Neúspěšné hledání
zůstane `not_identified`.

## Výsledky a bezpečná aplikace

Validator odvodí stejné čtyři stavy jako v3:

- `verified`;
- `conflicted`;
- `unresolved_after_complete_search`;
- `pending`.

Globální gate vyžaduje přesně 861 výsledků, 861 QA řádků, nula `pending`, nula
nezkontrolovaných kandidátů, validní raw chain a odpovídající hashe.

`data.js` se může změnit až po tomto gate a pouze řádkově:

- shodná potvrzená hodnota se pouze zaznamená, soubor se nemění;
- odlišná hodnota se změní jen při výsledku `verified` s přímými URL a
  odvozením mg/sáček;
- `conflicted` a `unresolved_after_complete_search` se nikdy automaticky
  neaplikují;
- druhé spuštění safe apply musí být idempotentní.

## Pilot a plný běh

Pilot obsahuje přesně pět frozen karet značky `77 Pouches`. Musí prokázat:

- funkční live extrakci bez systémové absence značky, názvu nebo strength
  semantics na stránkách, které tyto údaje skutečně obsahují;
- nulový počet nezkontrolovaných kandidátů;
- shodné validator a QA hashe;
- žádný zápis do `data.js` před globálním gate.

Pokud pilot selže kvůli implementační chybě, plný běh se zastaví. Pokud pouze
vrátí věcně `unresolved` po funkční přesné důkazní cestě, může pokračovat.
Nulový počet live `exact_match` je přípustný jen tehdy, když žádná otevřená
pilotní stránka neposkytla všechny povinné raw hodnoty; report musí tuto
podmínku doložit. Integrační fixture musí schopnost vytvořit `exact_match`
prokázat vždy.
Výslovné uživatelské schválení v tomto vlákně dovoluje automaticky pokračovat
zbývajícími 856 položkami bez další pauzy.

## TDD a testovací matice

Každá změna produkčního kódu vznikne až po testu, který byl spuštěn a selhal
ze správného důvodu.

Povinné RED→GREEN případy:

1. live HTML/JSON-LD fixture `77 Cola & Cherry` extrahuje značku, kanonický
   název a 10,4 mg/sáček;
2. marketingový suffix v title nebrání shodě identity;
3. podobná příchuť nebo extra variantní token zůstane `near_match`;
4. první nesouvisející číslo s `mg` se nesmí stát mg/sáček;
5. `mg/g` bez společné hmotnosti a pouch count není přesný důkaz;
6. jeden přesný retailer není `verified`;
7. dva retailery stejné vlastnické skupiny nejsou nezávislé;
8. dva nezávislé přesné retailery nebo jeden official/regulator vytvoří
   `verified`;
9. writerem uložené falešné `exact_match` validator odmítne;
10. parser nikdy nedoplňuje identitu ze frozen card;
11. v3.1 zapisuje pouze do nového raw logu;
12. safe apply mění jen přímo ověřené řádky a je idempotentní.

Poté musí projít celá existující v3 sada, nové v3.1 testy, syntax checks,
validator, QA, report coverage, hash checks a `git diff --check`.

## Artefakty

Lokální audit vytvoří:

- `audit/pouches/recheck-v3.1/input-snapshot.json`;
- `raw-events.jsonl`;
- `derived-results.jsonl`;
- `qa.jsonl`;
- `report.md`;
- `progress.json`;
- `approval.json`;
- `manifest.json`;
- `summary.md`;
- deterministické `raw-events.jsonl.gz` a `report.md.gz`.

Manifest uvede SHA-256 všech nekomprimovaných i komprimovaných artefaktů,
zdrojové a validator/QA hashe, příkazové verze, počty výsledků, změny
`data.js`, nedostupné zdroje a použité fallbacky.

Na `main` se commitnou snapshot, výsledky, QA, progress, approval, manifest,
summary a gzip archivy. Nekomprimovaný raw log a plný report zůstanou lokálně
a budou ignorované. Každý gzip archiv musí po rozbalení odpovídat hashi v
manifestu.

## Git a publikace

- Práce proběhne na aktuální větvi `main`, jak uživatel výslovně požadoval.
- Staging bude podle explicitního allowlistu; současné v3 artefakty ani
  nesouvisející změny se nepřidají.
- Před commitem se zkontroluje celý staged diff a velikosti souborů.
- Před push se provede `git fetch origin` a ověří divergence.
- Pokud `origin/main` postoupil, lokální auditní commity se rebasují bez
  force-pushe a po rebase se zopakuje relevantní verifikace.
- Push je pouze fast-forward na `origin/main`; force push je zakázán.

## Nový goal prompt

Součástí předání bude copy-paste `/goal` prompt a soubor
`docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md`. Prompt bude
odkazovat na tuto specifikaci a implementační plán, vyžadovat TDD, izolovaný
v3.1 log, plných 861 položek, bezpečnou aplikaci, artefakty, verifikaci a push
na `main` bez dalšího pilotního schválení.

## Akceptační kritéria

- současné artefakty `audit/pouches/recheck-v3` a v2 zůstanou byte-for-byte
  stejné;
- nový snapshot obsahuje přesně 861 unikátních ID;
- live parser umí z reálné fixture vytvořit doloženou značku, identitu a
  sílu;
- validator může vytvořit `exact_match`, ale pouze při splnění všech bran;
- pilot pěti `77 Pouches` prokáže funkční důkazní cestu;
- všech 861 položek má finální derived a QA řádek;
- globálně je nula `pending` a nula nezkontrolovaných kandidátů;
- každý `verified` nebo `conflicted` výsledek má přímé URL, raw facts a
  nezávisle odvozenou sílu;
- `data.js` obsahuje pouze bezpečně aplikované ověřené změny a druhý apply je
  no-op;
- manifest a gzip archivy projdou hash a decompression kontrolou;
- všechny testy a statické kontroly projdou;
- staged commit obsahuje pouze schválený rozsah;
- commit je bez force-pushe zveřejněn na `origin/main`;
- konečný report nepředstavuje `unresolved` jako správná data.
