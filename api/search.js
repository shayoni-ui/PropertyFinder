// Vercel serverless function — proxies Rightmove search + enriches with IMD 2025 + EPC data
// Route: GET /api/search?postcode=CV37+8FH&radius=1.0&minBeds=3&minPrice=0&maxPrice=500000

// IMD 2025 lookup: LSOA code (2021) → decile (1=most deprived, 10=least deprived)
const IMD2025 = require('./imd2025.json');

// ── EPC helpers ───────────────────────────────────────────────────────────────
const EPC_AUTH = Buffer.from(
  `${process.env.EPC_EMAIL || 'shayoni08@gmail.com'}:${process.env.EPC_KEY || '6d4a0050956a985b5a27f7a8251f7f02130a1db1'}`
).toString('base64');

// Normalise address string for fuzzy matching
function normAddr(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find best matching EPC cert for a property address within a postcode's certs
function matchEPC(address, certs) {
  if (!certs || !certs.length) return null;
  const target = normAddr(address);

  let best = null, bestScore = 0;
  for (const cert of certs) {
    const certAddr = normAddr(
      [cert['address1'], cert['address2'], cert['address3']].filter(Boolean).join(' ')
    );
    if (!certAddr) continue;

    // Extract house number from both — must match if present
    const numT = (target.match(/^\d+/) || [])[0];
    const numC = (certAddr.match(/^\d+/) || [])[0];
    if (numT && numC && numT !== numC) continue;

    // Score by common leading characters of street name
    let score = 0;
    const minLen = Math.min(certAddr.length, target.length);
    for (let i = 0; i < minLen; i++) {
      if (certAddr[i] === target[i]) score++; else break;
    }
    if (score > bestScore) { bestScore = score; best = cert; }
  }

  return bestScore >= 4 ? best : null; // require at least 4 chars match
}

// Fetch all EPC certs for a set of unique postcodes
async function fetchEPCByPostcodes(postcodes) {
  const epcMap = {}; // postcode → array of certs
  await Promise.allSettled(postcodes.map(async pc => {
    try {
      const url = `https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${encodeURIComponent(pc)}&size=100`;
      const r = await fetch(url, {
        headers: { 'Authorization': `Basic ${EPC_AUTH}`, 'Accept': 'application/json' },
      });
      if (!r.ok) return;
      const data = await r.json();
      // Sort by lodgement date desc so we match to most recent cert
      const rows = (data.rows || []).sort((a, b) =>
        (b['lodgement-date'] || '').localeCompare(a['lodgement-date'] || '')
      );
      epcMap[pc.replace(/\s+/g, '').toUpperCase()] = rows;
    } catch { /* skip */ }
  }));
  return epcMap;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    postcode = '',
    radius = '1.0',
    minBeds = '0',
    minPrice = '0',
    maxPrice = '2000000',
  } = req.query;

  if (!postcode.trim()) {
    return res.status(400).json({ error: 'postcode is required' });
  }

  try {
    // ── Step 1: Resolve postcode → Rightmove locationIdentifier ────────────
    const taUrl = `https://los.rightmove.co.uk/typeahead?query=${encodeURIComponent(postcode)}&limit=6&exclude=STREET`;
    const taResp = await fetch(taUrl, {
      headers: { ...BASE_HEADERS, 'Accept': 'application/xml, text/xml, */*' },
    });
    const taText = await taResp.text();
    console.log('[typeahead] status:', taResp.status, '| body:', taText.slice(0, 300));

    let locationId, locationName;

    // Try JSON first (Rightmove occasionally returns JSON)
    try {
      const taJson = JSON.parse(taText);
      const first = Array.isArray(taJson) ? taJson[0] : taJson?.typeAheadLocations?.[0];
      if (first?.locationIdentifier) {
        locationId = first.locationIdentifier;
        locationName = first.displayName || postcode;
      }
    } catch { /* not JSON — fall through to XML */ }

    // Parse XML — extract each field independently (order doesn't matter)
    if (!locationId) {
      const idEl    = taText.match(/<id>(\d+)<\/id>/);
      const typeEl  = taText.match(/<type>([A-Z_]+)<\/type>/);
      const nameEl  = taText.match(/<displayName>(.*?)<\/displayName>/);
      if (idEl && typeEl) {
        locationId   = `${typeEl[1]}^${idEl[1]}`;
        locationName = nameEl ? nameEl[1] : postcode;
      }
    }

    if (!locationId) {
      console.error('[typeahead] parse failed. Raw:', taText.slice(0, 500));
      return res.status(404).json({ error: `Postcode "${postcode}" not found — typeahead returned: ${taText.slice(0,120)}` });
    }

    // ── Step 2: Fetch listings — up to 2 pages (48 properties) ─────────────
    const rawProps = [];
    for (let index = 0; index <= 24; index += 24) {
      const url = buildSearchUrl(locationId, radius, minBeds, minPrice, maxPrice, index);
      try {
        const html = await fetchHtml(url);
        const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!match) break;
        const nd = JSON.parse(match[1]);
        const batch = nd.props?.pageProps?.searchResults?.properties ?? [];
        if (!batch.length) break;
        rawProps.push(...batch);
      } catch {
        break;
      }
    }

    if (!rawProps.length) {
      return res.json({ properties: [], total: 0, locationName });
    }

    // ── Step 4: Bulk reverse-geocode lat/lng → LSOA codes via postcodes.io ──
    // postcodes.io returns codes.lsoa21 (2021 census LSOA) which matches IMD 2025
    const geoWithIndex = rawProps
      .map((p, i) => ({ i, lat: p.location?.latitude, lng: p.location?.longitude }))
      .filter(g => g.lat && g.lng);

    const imdByIndex = {};
    try {
      const bulkResp = await fetch('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geolocations: geoWithIndex.map(g => ({
            longitude: g.lng,
            latitude: g.lat,
            limit: 1,
            radius: 300,
          })),
        }),
      });
      const bulkData = await bulkResp.json();
      bulkData.result?.forEach((item, bi) => {
        // Prefer 2021 LSOA code; fall back to generic lsoa code
        const lsoa = item.result?.[0]?.codes?.lsoa21 || item.result?.[0]?.codes?.lsoa;
        if (lsoa && IMD2025[lsoa] !== undefined) {
          imdByIndex[geoWithIndex[bi].i] = IMD2025[lsoa];
        }
      });
    } catch { /* IMD will fall back to 5 */ }

    // ── Step 5: Fetch EPC certificates by postcode ───────────────────────────
    // Collect unique postcodes from the bulk reverse-geocode results then query
    // the EPC Open Data Communities API (free, authenticated)
    const postcodeByIndex2 = {};
    try {
      const bulkResp2 = await fetch('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geolocations: geoWithIndex.map(g => ({
            longitude: g.lng, latitude: g.lat, limit: 1, radius: 300,
          })),
        }),
      });
      const bd2 = await bulkResp2.json();
      bd2.result?.forEach((item, bi) => {
        const pc = item.result?.[0]?.postcode;
        if (pc) postcodeByIndex2[geoWithIndex[bi].i] = pc.replace(/\s+/g, '').toUpperCase();
      });
    } catch { /* EPC will be skipped */ }

    const uniquePostcodes = [...new Set(Object.values(postcodeByIndex2))];
    const epcMap = uniquePostcodes.length ? await fetchEPCByPostcodes(uniquePostcodes) : {};

    // ── Step 6: Assemble final property objects ──────────────────────────────
    const properties = rawProps.map((p, i) => {
      const featureArr = p.keyFeatures ?? [];
      const summary = p.summary ?? '';
      const fl = [...featureArr, summary].join(' ').toLowerCase();

      // EPC certificate match
      const pc = postcodeByIndex2[i];
      const certs = pc ? (epcMap[pc] || []) : [];
      const cert = matchEPC(p.displayAddress, certs);

      // Floor area: EPC cert (m² → sqft) preferred; fall back to listing text
      const epcSqm = cert ? parseFloat(cert['total-floor-area']) : null;
      const epcSqft = epcSqm ? Math.round(epcSqm * 10.764) : null;
      const listingSqft = (() => {
        const m = fl.match(/(\d[\d,]*)\s*sq\.?\s*ft/i);
        return m ? parseInt(m[1].replace(/,/g, '')) : null;
      })();
      const sqft = epcSqft || listingSqft;

      // EPC rating: cert preferred over inferred from text
      const epcRating = cert?.['current-energy-rating'] || inferEPC(fl);
      const epcPotential = cert?.['potential-energy-rating'] || null;
      const heatingType = cert?.['main-fuel'] || null;
      const epcDate = cert?.['lodgement-date'] || null;
      const propertyForm = cert?.['built-form'] || null;

      return {
        id: +(p.id ?? p.propertyId ?? (i + 100000)),
        address: p.displayAddress,
        area: p.displayAddress.split(',').slice(-2).join(',').trim(),
        price: p.price?.amount ?? 0,
        beds: p.bedrooms ?? 0,
        baths: p.bathrooms ?? 1,
        ptype: normaliseType(p.propertySubType),
        parking: inferParking(fl),
        epc: epcRating,
        epcPotential,
        heatingType,
        epcDate,
        propertyForm,
        epcVerified: !!cert,
        ctax: inferCTax(fl),
        nochain: /no chain|chain[- ]free|no onward chain|vacant possession/i.test(fl),
        culdesac: /cul[- ]de[- ]sac/i.test(fl),
        extended: /\bextended\b|single.storey extension|rear extension/i.test(fl),
        renovated: /renovated|refurbished|modernised|modernized/i.test(fl),
        largeplot: /large (?:garden|plot)|substantial (?:garden|plot)|generous (?:garden|plot)/i.test(fl),
        sqft,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        imd: imdByIndex[i] ?? 5,
        agent: p.formattedBranchName ?? '',
        status: '🏠 For Sale',
        url: `https://www.rightmove.co.uk${p.propertyUrl}`,
        image: p.propertyImages?.images?.[0]?.srcUrl ?? p.images?.[0]?.srcUrl ?? null,
        addedDate: p.firstVisibleDate ?? null,
        summary: summary.slice(0, 400),
        custom: false,
      };
    });

    return res.json({ properties, total: properties.length, locationName });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSearchUrl(locationId, radius, minBeds, minPrice, maxPrice, index) {
  let url =
    `https://www.rightmove.co.uk/property-for-sale/find.html` +
    `?searchType=SALE&locationIdentifier=${encodeURIComponent(locationId)}` +
    `&radius=${radius}&sortType=6&channel=BUY&index=${index}`;
  if (minBeds && minBeds !== '0') url += `&minBedrooms=${minBeds}`;
  if (minPrice && minPrice !== '0') url += `&minPrice=${minPrice}`;
  if (maxPrice && maxPrice !== '2000000') url += `&maxPrice=${maxPrice}`;
  return url;
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.rightmove.co.uk/',
    },
  });
  return r.text();
}

function normaliseType(s) {
  if (!s) return 'Other';
  const l = s.toLowerCase();
  if (l.includes('detached') && !l.includes('semi')) return 'Detached';
  if (l.includes('semi')) return 'Semi-Detached';
  if (l.includes('terrac')) return 'Terraced';
  if (l.includes('flat') || l.includes('apartment')) return 'Flat';
  if (l.includes('bungalow')) return 'Bungalow';
  if (l.includes('cottage')) return 'Detached';
  return s;
}

function inferParking(fl) {
  if (/\bgarage\b/.test(fl)) return 'garage';
  if (/driveway|off[- ]street parking|private parking|allocated parking|parking space/.test(fl)) return 'driveway';
  return 'onroad';
}

function inferEPC(fl) {
  const m = fl.match(/epc\s*(?:rating\s*)?([a-g])\b|energy\s+(?:performance\s+)?(?:rating\s+)?([a-g])\b/);
  return m ? (m[1] || m[2]).toUpperCase() : 'D';
}

function inferCTax(fl) {
  const m = fl.match(/council\s+tax\s+band\s+([a-h])\b/i);
  return m ? m[1].toUpperCase() : 'D';
}
