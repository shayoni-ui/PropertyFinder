# 🏠 Chesterfield Property Finder

An interactive property intelligence tool for house hunters in Chesterfield, Derbyshire. Scores every property 0–100 using a composite algorithm combining location quality, school ratings, live crime data, flood risk, planning activity, and property features — all in a single-page app with no backend required.

## Live App

Deployed on Vercel — push to `main` to publish, `staging` for preview.

---

## Features

| Feature | Details |
|---|---|
| 🗺️ **Interactive map** | Leaflet.js, colour-coded deprivation zone overlays, satellite toggle |
| 📊 **Best Value Score 0–100** | Composite algorithm: IMD + Schools + Crime + Features |
| 🎯 **Buyer persona** | FTB / Family / Buy-to-let / Explorer — reweights scoring on the fly |
| 🏫 **Schools tab** | Ofsted ratings, KS2/Attainment 8, walking time, GIAS deep links |
| 🛒 **Shops tab** | Nearest supermarkets via Overpass API (OSM), live on load |
| 🌊 **Flood & Planning tab** | EA Flood Zone 1/2/3, brownfield land, planning applications (planning.data.gov.uk) |
| 🚔 **Crime data** | police.uk API — crimes within ~1 mile, breakdown by category |
| 💰 **Sold prices** | HM Land Registry Price Paid Data per postcode |
| ⚡ **EPC + Broadband** | Verified EPC certificates + Ofcom coverage data |
| 🤖 **AI chatbot** | DeepSeek-powered Q&A with buyer persona context |
| 🔍 **Filters** | Price, beds, IMD decile, Ofsted threshold, free-text search |

---

## Scoring Algorithm

Each property gets a **Best Value Score out of 100**, weighted by buyer persona:

| Component | Max pts | Source |
|---|---|---|
| 📍 Location (IMD Decile) | 30 | English Indices of Deprivation 2025 |
| 🏫 School Quality | 30 | Ofsted + KS2 / Attainment 8 |
| 🚔 Crime Safety | 20 | police.uk API (live) |
| 🏠 Property Features | 20 | Beds, parking, EPC, chain-free, plot size |

Persona multipliers (e.g. Family buyer weights schools ×2.2, crime ×1.6) are applied and the total is normalised back to 0–100.

**Verdict thresholds:**

| Score | Verdict |
|---|---|
| 60–100 | ✅ Recommended |
| 30–59 | ⚠️ Consider Carefully |
| 0–29 | ❌ Avoid |

---

## Data Sources

| Data | Source |
|---|---|
| Properties | Rightmove (Chesterfield, £250k–£350k, 3–4 bed) |
| IMD | [English Indices of Deprivation 2025](https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025) |
| Schools | Ofsted reports, DfE performance tables, schools_uk.json |
| Crime | [police.uk API](https://data.police.uk/docs/) |
| Flood risk | [Environment Agency Flood Map for Planning](https://environment.data.gov.uk/arcgis/rest/services/EA) |
| Planning applications | [planning.data.gov.uk](https://www.planning.data.gov.uk/) |
| Shops | [OpenStreetMap via Overpass API](https://overpass-api.de/) |
| Sold prices | [HM Land Registry Price Paid](https://landregistry.data.gov.uk/) |
| Broadband | [Ofcom Connected Nations 2025](https://www.ofcom.org.uk/) |
| AI Q&A | DeepSeek API (proxied via `/api/chat` Vercel function) |

---

## Project Structure

```
PropertyFinder/
├── index.html          # Entire app — UI, map, scoring, all tab logic
├── schools_uk.json     # Pre-built school dataset (Ofsted + DfE)
├── greenspaces_gb.json # ONS green space proximity data
├── api/
│   ├── search.js       # Vercel serverless: Rightmove property search
│   └── chat.js         # Vercel serverless: DeepSeek API proxy
└── vercel.json         # Deployment config (main + staging branches)
```

---

## Local Development

No build step — just open `index.html` in a browser. For Vercel functions:

```bash
npm install -g vercel
vercel dev          # runs functions locally at localhost:3000
```

Set `DEEPSEEK_API_KEY` in Vercel environment variables (Dashboard → Settings → Environment Variables).

---

## Deployment

```bash
git push origin main      # → production
git push origin staging   # → preview URL
```

Vercel auto-deploys both branches (configured in `vercel.json`).

---

Built for Shayoni · Data current as of April 2026
