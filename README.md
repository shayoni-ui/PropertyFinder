# 🏠 Chesterfield Property Finder

An interactive property research tool for house hunters in Chesterfield, Derbyshire. Cross-references Rightmove listings with IMD deprivation data and Ofsted school ratings, scoring every property with a composite **Best Value Score**.

## Features

- 🗺️ **Interactive Leaflet map** — Chesterfield properties plotted with colour-coded deprivation zone overlays
- 📊 **Best Value Score (0–100)** — algorithmic ranking combining location, price efficiency, schools, and property features
- 🏫 **School data** — Ofsted ratings, KS2 results, Attainment 8 / Progress 8 for 12 nearby schools
- 🎨 **IMD deprivation zones** — visual overlays showing IMD decile per area (decile 1–10)
- 🔍 **Filters** — price, beds, min. IMD decile, school Ofsted threshold, free-text search
- 📋 **Detail panel** — tabbed breakdown of score, nearby schools, and deprivation data per property

## Scoring Algorithm

Each property receives a **Best Value Score out of 100**:

| Component | Weight | Details |
|---|---|---|
| **Location (IMD Decile)** | 35% | Decile 10 = 35pts, Decile 1 = 0pts |
| **Price Efficiency** | 25% | Lower end of £250k–£350k budget = higher score |
| **School Quality** | 25% | Nearest primary + secondary Ofsted + KS2/Attainment 8 bonus |
| **Property Features** | 15% | Detached (+5), No chain (+4), Extended/Renovated (+3), 2+ baths (+2), Large plot (+1) |

## Data Sources

- **Properties**: Rightmove listings (Chesterfield, £250k–£350k, 3–4 beds)
- **IMD**: [English Indices of Deprivation 2025](https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025) — postcode-level data verified via `checkpostcode.uk`
- **Schools**: Ofsted reports, DfE school performance tables, `reports.ofsted.gov.uk`
- **Map**: Leaflet.js + OpenStreetMap / Esri satellite

## IMD Findings — Chesterfield

| Area | Postcodes | IMD Decile | Verdict |
|---|---|---|---|
| Loundsley Green | S40 4 | **10** | ✅ Least deprived |
| Walton | S40 2/3 | **9** | ✅ Least deprived |
| Brampton | S40 3 | **9** | ✅ Least deprived |
| Ashgate | S40 | **9** | ✅ Least deprived |
| Brockwell | S40 | **8** | ✅ Less deprived |
| Newbold S41 7 | S41 7 | **8** | ✅ Less deprived |
| Hasland | S41 0 | **6** | ⚠️ Middle |
| Hady/Spire | S41 0FG | **5** | ⚠️ Caution |
| Old Whittington | S41 9 | **4** | ❌ Avoid |
| Newbold S41 8 | S41 8 | **3** | ❌ Avoid |
| Dunston/Comley | S41 9SH | **2** | ❌ Avoid |

## Usage

Simply open `index.html` in any modern browser. No server or installation required.

## Screenshot

The tool shows:
- Left panel: filterable property list with score badges
- Map: colour-coded deprivation zones + property pins + school markers
- Right panel: tabbed detail view (Score breakdown / Schools / Deprivation)

---

Built with ❤️ for Shayoni | Data current as of March 2026
