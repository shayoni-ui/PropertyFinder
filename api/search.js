// Vercel serverless function — proxies Rightmove search + enriches with IMD decile
// Route: GET /api/search?postcode=CV37+8FH&radius=1.0&minBeds=3&minPrice=0&maxPrice=500000

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
    // New endpoint (los.rightmove.co.uk) returns XML, no cookies needed
    const taUrl = `https://los.rightmove.co.uk/typeahead?query=${encodeURIComponent(postcode)}&limit=6&exclude=STREET`;
    const taResp = await fetch(taUrl, {
      headers: { ...BASE_HEADERS, 'Accept': 'application/xml, text/xml, */*' },
    });
    const taText = await taResp.text();

    let locationId, locationName;
    // Parse XML: <id>4201441</id><type>POSTCODE</type><displayName>CV37 8FH</displayName>
    const idMatch = taText.match(/<id>(\d+)<\/id>[\s\S]*?<type>([A-Z_]+)<\/type>[\s\S]*?<displayName>(.*?)<\/displayName>/);
    if (!idMatch) {
      return res.status(404).json({ error: `Postcode "${postcode}" not found on Rightmove` });
    }
    locationId = `${idMatch[2]}^${idMatch[1]}`;   // e.g. "POSTCODE^4201441"
    locationName = idMatch[3];                      // e.g. "CV37 8FH"

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

    // ── Step 4: Bulk reverse-geocode all properties lat/lng → postcodes ─────
    const geoWithIndex = rawProps
      .map((p, i) => ({ i, lat: p.location?.latitude, lng: p.location?.longitude }))
      .filter(g => g.lat && g.lng);

    let postcodeByIndex = {};
    try {
      const bulkResp = await fetch('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geolocations: geoWithIndex.map(g => ({
            longitude: g.lng,
            latitude: g.lat,
            limit: 1,
            radius: 200,
          })),
        }),
      });
      const bulkData = await bulkResp.json();
      bulkData.result?.forEach((item, bi) => {
        const pc = item.result?.[0]?.postcode;
        if (pc) postcodeByIndex[geoWithIndex[bi].i] = pc;
      });
    } catch { /* IMD will fall back to 5 */ }

    // ── Step 5: Fetch IMD decile for each postcode (parallel) ───────────────
    // findthatpostcode.uk returns raw IMD rank (1=most deprived, 32844=least)
    // Convert to decile 1-10: Math.ceil(rank * 10 / 32844)
    const imdByIndex = {};
    await Promise.allSettled(
      Object.entries(postcodeByIndex).map(async ([idx, pc]) => {
        try {
          const r = await fetch(
            `https://findthatpostcode.uk/postcodes/${encodeURIComponent(pc)}.json`
          );
          const j = await r.json();
          const rank = j?.data?.attributes?.imd;
          if (rank) {
            imdByIndex[Number(idx)] = Math.min(10, Math.max(1, Math.ceil((rank * 10) / 32844)));
          }
        } catch { /* leave as default */ }
      })
    );

    // ── Step 6: Assemble final property objects ──────────────────────────────
    const properties = rawProps.map((p, i) => {
      const featureArr = p.keyFeatures ?? [];
      const summary = p.summary ?? '';
      const fl = [...featureArr, summary].join(' ').toLowerCase();

      return {
        id: p.id,
        address: p.displayAddress,
        area: p.displayAddress.split(',').slice(-2).join(',').trim(),
        price: p.price?.amount ?? 0,
        beds: p.bedrooms ?? 0,
        baths: p.bathrooms ?? 1,
        ptype: normaliseType(p.propertySubType),
        parking: inferParking(fl),
        epc: inferEPC(fl),
        ctax: inferCTax(fl),
        nochain: /no chain|chain[- ]free|no onward chain|vacant possession/i.test(fl),
        culdesac: /cul[- ]de[- ]sac/i.test(fl),
        extended: /\bextended\b|single.storey extension|rear extension/i.test(fl),
        renovated: /renovated|refurbished|modernised|modernized/i.test(fl),
        largeplot: /large (?:garden|plot)|substantial (?:garden|plot)|generous (?:garden|plot)/i.test(fl),
        sqft: null,
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
