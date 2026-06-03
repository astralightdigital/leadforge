const functions = require('firebase-functions');
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const FOURSQUARE_KEY  = () => process.env.FOURSQUARE_API_KEY;
const GOOGLE_KEY      = () => process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_EXPIRY   = () => process.env.GOOGLE_PLACES_EXPIRY;
const ANTHROPIC_KEY   = () => process.env.ANTHROPIC_API_KEY;

let searchCounter = 0;

// ── Geocoding ──────────────────────────────────────────────────────────────────
async function geocodeCity(city, state) {
  const cleanCity = city.replace(/,?\s+[A-Z]{2}$/, '').trim();
  const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: `${cleanCity}, ${state}`, format: 'json', limit: 1, countrycodes: 'us' },
    headers: { 'User-Agent': 'LeadForge/1.0', Accept: '*/*' },
    timeout: 10000,
  });
  if (!resp.data.length) throw new Error(`City not found: ${cleanCity}, ${state}`);
  const { lat, lon } = resp.data[0];
  const clat = parseFloat(lat), clon = parseFloat(lon);
  const delta = 0.18;
  return { lat: clat, lon: clon, south: clat - delta, north: clat + delta, west: clon - delta, east: clon + delta };
}

// ── Foursquare ─────────────────────────────────────────────────────────────────
async function foursquareSearch(query, city, state) {
  const geo = await geocodeCity(city, state);
  const response = await axios.get('https://places-api.foursquare.com/places/search', {
    headers: { Authorization: `Bearer ${FOURSQUARE_KEY()}`, Accept: 'application/json', 'X-Places-Api-Version': '2025-06-17' },
    params: { query, ll: `${geo.lat},${geo.lon}`, radius: 20000, limit: 50 },
  });
  return (response.data.results || []).map(p => ({
    fsqId:        p.fsq_place_id,
    businessName: p.name,
    address:      [p.location?.address, p.location?.locality, p.location?.region, p.location?.postcode].filter(Boolean).join(', '),
    city:         [p.location?.locality, p.location?.region].filter(Boolean).join(', '),
    lat:          p.latitude  || null,
    lng:          p.longitude || null,
    phone:        p.tel       || null,
    websiteUrl:   p.website   || null,
    businessType: p.categories?.[0]?.name || query,
    foursquareUrl: p.link     || null,
  }));
}

// ── Google ─────────────────────────────────────────────────────────────────────
async function googleSearch(query, city, state) {
  const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
    params: { query: `${query} in ${city}, ${state}`, key: GOOGLE_KEY() },
  });
  return (response.data.results || []).map(p => ({
    fsqId:        `google-${p.place_id}`,
    businessName: p.name,
    address:      p.formatted_address || '',
    city:         `${city}, ${state}`,
    lat:          p.geometry?.location?.lat || null,
    lng:          p.geometry?.location?.lng || null,
    phone:        null,
    websiteUrl:   null,
    businessType: query,
    foursquareUrl: null,
  }));
}

// ── OSM Overpass ───────────────────────────────────────────────────────────────
function buildOverpassQuery(query, bbox) {
  const { south, west, north, east } = bbox;
  const bb = `${south},${west},${north},${east}`;
  const q  = query.toLowerCase();
  const tagFilters = [];
  if (/restaurant|dining|food|eat/.test(q))          tagFilters.push('["amenity"="restaurant"]');
  if (/vietnamese/.test(q))                          tagFilters.push('["amenity"="restaurant"]["cuisine"~"vietnamese",i]');
  if (/chinese/.test(q))                             tagFilters.push('["amenity"="restaurant"]["cuisine"~"chinese",i]');
  if (/mexican/.test(q))                             tagFilters.push('["amenity"="restaurant"]["cuisine"~"mexican",i]');
  if (/sushi|japanese/.test(q))                      tagFilters.push('["amenity"="restaurant"]["cuisine"~"sushi|japanese",i]');
  if (/cafe|coffee/.test(q))                         tagFilters.push('["amenity"~"cafe|coffee_shop"]');
  if (/nail/.test(q))                                tagFilters.push('["shop"~"beauty|nail_salon"]');
  if (/hair|salon|barber/.test(q))                   tagFilters.push('["shop"~"hairdresser|barber"]');
  if (/gym|fitness/.test(q))                         tagFilters.push('["leisure"~"fitness_centre|sports_centre"]');
  if (/auto|car repair|mechanic/.test(q))            tagFilters.push('["shop"~"car_repair|tyres"]');
  if (/dentist|dental/.test(q))                      tagFilters.push('["amenity"="dentist"]');
  if (/pharmacy/.test(q))                            tagFilters.push('["amenity"="pharmacy"]');
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allFilters = [...new Set([...tagFilters, `["name"~"${escaped}",i]`])];
  const lines = allFilters.flatMap(f => [`  node${f}(${bb});`, `  way${f}(${bb});`]);
  return `[out:json][timeout:30];\n(\n${lines.join('\n')}\n);\nout center;`;
}

function mapOsmElement(el, query, city, state) {
  const t = el.tags || {};
  if (!t.name) return null;
  const street   = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const addrCity = t['addr:city']  || city;
  const addrSt   = t['addr:state'] || state;
  const address  = [street, addrCity, addrSt, t['addr:postcode']].filter(Boolean).join(', ') || `${addrCity}, ${addrSt}`;
  return {
    fsqId:        `osm-${el.type}-${el.id}`,
    businessName: t.name,
    address,
    city:         `${addrCity}, ${addrSt}`,
    lat:          el.type === 'node' ? el.lat : el.center?.lat || null,
    lng:          el.type === 'node' ? el.lon : el.center?.lon || null,
    phone:        t.phone || t['contact:phone'] || null,
    websiteUrl:   t.website || t['contact:website'] || null,
    businessType: t.amenity || t.shop || t.leisure || query,
    foursquareUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

// ── Places Search Route ────────────────────────────────────────────────────────
app.get('/api/places-search', async (req, res) => {
  const { query, city, state } = req.query;
  if (!query || !city || !state) return res.status(400).json({ error: 'query, city, and state required' });

  const hasFsq    = !!FOURSQUARE_KEY();
  const expiry    = GOOGLE_EXPIRY();
  const expired   = expiry && new Date() > new Date(expiry);
  const hasGoogle = !!GOOGLE_KEY() && !expired;

  if (hasFsq || hasGoogle) {
    const useFsq = hasFsq && hasGoogle ? searchCounter % 2 === 0 : hasFsq;
    searchCounter++;
    const provider = useFsq ? 'foursquare' : 'google';
    try {
      const businesses = useFsq ? await foursquareSearch(query, city, state) : await googleSearch(query, city, state);
      return res.json({ businesses, provider });
    } catch (err) {
      if (hasFsq && hasGoogle) {
        try {
          const fb = useFsq ? await googleSearch(query, city, state) : await foursquareSearch(query, city, state);
          return res.json({ businesses: fb, provider: useFsq ? 'google' : 'foursquare' });
        } catch {}
      }
    }
  }

  // OSM fallback
  try {
    const bbox = await geocodeCity(city, state);
    const q    = buildOverpassQuery(query, bbox);
    const mirrors = ['https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    let resp;
    for (const m of mirrors) {
      try { resp = await axios.get(`${m}?data=${encodeURIComponent(q)}`, { timeout: 35000 }); break; } catch {}
    }
    if (!resp || !resp.data.elements?.length) {
      const nr = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { q: `${query} in ${city} ${state}`, format: 'json', limit: 20, countrycodes: 'us', addressdetails: 1 },
        headers: { 'User-Agent': 'LeadForge/1.0', Accept: '*/*' },
      });
      const businesses = (nr.data || []).filter(p => p.name).map(p => ({
        fsqId: `osm-${p.osm_type}-${p.osm_id}`, businessName: p.name,
        address: p.display_name, city: `${city}, ${state}`,
        lat: parseFloat(p.lat), lng: parseFloat(p.lon),
        phone: null, websiteUrl: null, businessType: query,
        foursquareUrl: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`,
      }));
      return res.json({ businesses, provider: 'osm', fallback: true });
    }
    const seen = new Set();
    const businesses = (resp.data.elements || []).map(el => mapOsmElement(el, query, city, state)).filter(Boolean)
      .filter(b => { const k = `${b.businessName}|${b.address}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 50);
    res.json({ businesses, provider: 'osm' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email Extractor ────────────────────────────────────────────────────────────
app.get('/api/fetch-email', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ email: null });
  try {
    const r = await axios.get(url, {
      timeout: 8000, maxContentLength: 500_000, maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html' },
    });
    const html = typeof r.data === 'string' ? r.data : '';
    const blacklist = ['example.com','sentry.io','w3.org','schema.org','wixpress.com','squarespace.com'];
    const email = (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
      .find(e => !blacklist.some(d => e.includes(d)));
    res.json({ email: email || null });
  } catch { res.json({ email: null }); }
});

// ── Message Generator ──────────────────────────────────────────────────────────
app.post('/api/generate-message', async (req, res) => {
  const { name, businessType, city, issueDescription, type } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const key = ANTHROPIC_KEY();
  if (!key) return res.status(400).json({ error: 'Anthropic API key not configured' });
  try {
    const anthropic = new Anthropic({ apiKey: key });
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 600,
      messages: [{ role: 'user', content: `You are a freelance web developer writing a cold outreach message.\n\nBusiness: ${name}\nType: ${businessType}\nCity: ${city}\nWebsite issue: ${issueDescription}\nMessage type: ${type}\n\nWrite a short, friendly, non-pushy message.\n- Instagram DM: 3-4 sentences max, casual tone, mention one specific problem with their site or that they have no site, offer a free mockup as the hook.\n- Cold Email: include a subject line, 5-7 sentences, slightly more formal but still human and personal.\n- Walk-in Talking Points: bullet points the developer can reference in person.\n\nNever be aggressive or use pressure tactics.` }],
    });
    res.json({ message: msg.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

exports.api = functions.https.onRequest(app);
