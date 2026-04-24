# PropertyFinder — CLAUDE.md

Single-page property intelligence app deployed on Vercel. All app logic lives in `index.html`. There is no build step, no bundler, and no framework.

## Architecture

```
index.html          ← entire app (~3 500 lines): HTML + CSS + JS
schools_uk.json     ← static school data loaded at runtime via fetch()
greenspaces_gb.json ← ONS green space data
api/search.js       ← Vercel serverless function (CommonJS, module.exports)
api/chat.js         ← Vercel serverless function (DeepSeek proxy)
vercel.json         ← branch deploy config
```

## Key globals (JavaScript)

| Variable | Type | Purpose |
|---|---|---|
| `PROPERTIES` | Array | All properties with computed scores |
| `PROPERTIES_RAW` | Array | Source data before `calcScore()` runs |
| `SCHOOLS` | Array | Loaded from schools_uk.json |
| `SUPERMARKETS` | Array | Populated by fetchSupermarkets() from Overpass API |
| `PERSONA` | Object | Buyer profile — weights scoring algorithm |
| `PERSONA_PRESETS` | Object | FTB / Family / BTL / Explore weight multipliers |
| `selectedId` | Number | Currently open property id |
| `markers` | Array | Leaflet marker objects |
| `shopMarkers` | Array | Leaflet shop marker objects |

**Critical ordering**: `PERSONA` and `PERSONA_PRESETS` must be declared BEFORE `calcScore()` is called. `calcScore()` is called inside `PROPERTIES_RAW.map(...)` at init time. TDZ error will occur if declaration order changes.

## Tab system

Each property detail tab follows this pattern:
1. Template string in `selectProperty()` inserts a **static placeholder** `<div id="tab-X-body">⏳ Loading…</div>`
2. After template is set, a dedicated `populateXTab(lat, lng)` function is called
3. That function does async work and writes into `#tab-X-body`

**Never render async data directly inside the main `innerHTML = \`...\`` template.** Any exception inside a template literal silently blanks the entire panel.

Current tabs and their populate functions:

| Tab id | Populate function | Data source |
|---|---|---|
| `tab-score` | inline in template (sync) | calcScore() |
| `tab-schools` | `populateSchoolsTab(lat, lng)` | schools_uk.json |
| `tab-shops` | `populateShopsTab(lat, lng)` | Overpass API |
| `tab-depriv` | inline in template (sync) | PROPERTIES data |
| `tab-sold` | `fetchSoldPrices(postcode)` | Land Registry API |
| `tab-flood` | `populateFloodPlanningTab(lat, lng, postcode)` | EA ArcGIS + planning.data.gov.uk |

## External APIs (all called client-side)

| API | Endpoint | Notes |
|---|---|---|
| Overpass | `https://overpass-api.de/api/interpreter` | POST, `application/x-www-form-urlencoded`, nwr query |
| police.uk | `https://data.police.uk/api/crimes-at-location` | lat/lng, date param |
| Land Registry | `https://landregistry.data.gov.uk/data/ppi/...` | JSON-LD |
| EA Flood Zones | `https://environment.data.gov.uk/arcgis/rest/services/EA/FloodMapForPlanningRiversAndSea...` | Zone 2 + Zone 3 queries in parallel |
| planning.data.gov.uk | `https://www.planning.data.gov.uk/api/v1/entity.json` | planning-application + brownfield-land datasets |
| DeepSeek | via `/api/chat` proxy | Never call directly from client |

## Vercel functions

Both functions use **CommonJS** (`module.exports = async function handler(req, res)`). Do NOT use ESM `export default` — Vercel Node runtime will throw.

`DEEPSEEK_API_KEY` is set as a Vercel environment variable. Never hardcode it in client JS.

## Deployment

```bash
git push origin main      # production
git push origin staging   # preview (separate Vercel URL)
```

Always run a JS syntax check before pushing:
```bash
python3 -c "
import re
with open('index.html') as f: c = f.read()
scripts = re.findall(r'<script[^>]*>(.*?)</script>', c, re.DOTALL)
open('/tmp/x.js','w').write('\n'.join(scripts))
"
node -e "try{new Function(require('fs').readFileSync('/tmp/x.js','utf8'));console.log('OK')}catch(e){console.log(e.message)}"
```

## Common pitfalls

- **TDZ crash**: PERSONA declared after calcScore call — always keep PERSONA at top of script
- **Overpass timeouts**: use POST not GET, `nwr` not separate node/way/relation queries, `name~` not `brand~` (brand index causes server-busy HTML responses)
- **Template literal silent crash**: never put async/fallible expressions directly in the 300-line innerHTML template
- **switchSchoolFilter**: takes `filter` string only — reads lat/lng from PROPERTIES via selectedId
- **Schools async race**: schools_uk.json loads async; after load, if selectedId is set, call populateSchoolsTab() again
