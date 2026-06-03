import express from 'express';
import cors from 'cors';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000', 'https://leadforge-leads-2026.web.app'] }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Provider rotation counter ─────────────────────────────────────────────────
let searchCounter = 0;

// ── OpenStreetMap / Overpass Places Search ────────────────────────────────────
// Free, no API key, no account — uses Nominatim for geocoding + Overpass for POI data.

async function geocodeCity(city, state) {
  // Strip any state abbreviation accidentally typed in the city field
  const cleanCity = city.replace(/,?\s+[A-Z]{2}$/, '').trim();
  const geoQuery = cleanCity ? `${cleanCity}, ${state}` : state;

  const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: geoQuery, format: 'json', limit: 1, countrycodes: 'us' },
    headers: {
      'User-Agent': 'LeadForge/1.0',
      'Accept': '*/*',
    },
    timeout: 10000,
  });

  if (!resp.data.length) throw new Error(`Location not found: ${geoQuery}. Try adding a city name.`);

  const { lat, lon } = resp.data[0];
  const clat = parseFloat(lat), clon = parseFloat(lon);
  const delta = 0.18; // ~20 km radius
  return { lat: clat, lon: clon, south: clat - delta, north: clat + delta, west: clon - delta, east: clon + delta };
}

function buildOverpassQuery(query, bbox) {
  const { south, west, north, east } = bbox;
  const bb = `${south},${west},${north},${east}`;
  const q = query.toLowerCase();

  // Map common business terms to OSM tags for better coverage
  const tagFilters = [];
  if (/restaurant|dining|food|eat/.test(q))            tagFilters.push('["amenity"="restaurant"]');
  if (/vietnamese/.test(q))                            tagFilters.push('["amenity"="restaurant"]["cuisine"~"vietnamese",i]');
  if (/chinese/.test(q))                               tagFilters.push('["amenity"="restaurant"]["cuisine"~"chinese",i]');
  if (/mexican/.test(q))                               tagFilters.push('["amenity"="restaurant"]["cuisine"~"mexican",i]');
  if (/sushi|japanese/.test(q))                        tagFilters.push('["amenity"="restaurant"]["cuisine"~"sushi|japanese",i]');
  if (/pizza/.test(q))                                 tagFilters.push('["amenity"="restaurant"]["cuisine"~"pizza",i]');
  if (/bbq|barbecue/.test(q))                          tagFilters.push('["amenity"="restaurant"]["cuisine"~"barbecue|bbq",i]');
  if (/cafe|coffee/.test(q))                           tagFilters.push('["amenity"~"cafe|coffee_shop"]');
  if (/bar|pub/.test(q))                               tagFilters.push('["amenity"~"bar|pub"]');
  if (/fast.?food|burger/.test(q))                     tagFilters.push('["amenity"="fast_food"]');
  if (/nail/.test(q))                                  tagFilters.push('["shop"~"beauty|nail_salon"]');
  if (/hair|salon|barber/.test(q))                     tagFilters.push('["shop"~"hairdresser|barber"]');
  if (/spa|massage/.test(q))                           tagFilters.push('["shop"~"massage|beauty"]', '["leisure"="spa"]');
  if (/gym|fitness|crossfit/.test(q))                  tagFilters.push('["leisure"~"fitness_centre|sports_centre"]', '["amenity"="gym"]');
  if (/auto|car repair|mechanic|oil change/.test(q))   tagFilters.push('["shop"~"car_repair|tyres"]', '["amenity"="car_repair"]');
  if (/car.?wash/.test(q))                             tagFilters.push('["amenity"="car_wash"]');
  if (/dentist|dental/.test(q))                        tagFilters.push('["amenity"="dentist"]');
  if (/doctor|clinic|urgent.?care/.test(q))            tagFilters.push('["amenity"~"doctors|clinic"]');
  if (/pharmacy/.test(q))                              tagFilters.push('["amenity"="pharmacy"]');
  if (/grocery|supermarket/.test(q))                   tagFilters.push('["shop"~"supermarket|grocery"]');
  if (/pet|veterinary/.test(q))                        tagFilters.push('["shop"~"pet|pet_grooming"]', '["amenity"="veterinary"]');
  if (/florist|flower/.test(q))                        tagFilters.push('["shop"="florist"]');
  if (/bakery/.test(q))                                tagFilters.push('["shop"="bakery"]');
  if (/laundry|dry.?clean/.test(q))                    tagFilters.push('["shop"~"laundry|dry_cleaning"]');
  if (/real.?estate|realtor/.test(q))                  tagFilters.push('["office"="real_estate"]');
  if (/lawyer|attorney|law/.test(q))                   tagFilters.push('["office"="lawyer"]');
  if (/accounting|cpa|tax/.test(q))                    tagFilters.push('["office"~"accountant|tax"]');
  if (/insurance/.test(q))                             tagFilters.push('["office"="insurance"]');

  // Name-based search always runs as a fallback
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameFilters = [`["name"~"${escaped}",i]`];

  const allFilters = [...new Set([...tagFilters, ...nameFilters])];
  const lines = allFilters.flatMap(f => [`  node${f}(${bb});`, `  way${f}(${bb});`]);

  return `[out:json][timeout:30];\n(\n${lines.join('\n')}\n);\nout center;`;
}

function mapOsmElement(el, query, city, state) {
  const t = el.tags || {};
  if (!t.name) return null;

  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const addrCity  = t['addr:city']  || city;
  const addrState = t['addr:state'] || state;
  const addrZip   = t['addr:postcode'] || '';
  const address = [street, addrCity, addrState, addrZip].filter(Boolean).join(', ') || `${addrCity}, ${addrState}`;

  const lat = el.type === 'node' ? el.lat  : el.center?.lat;
  const lng = el.type === 'node' ? el.lon  : el.center?.lon;

  const websiteUrl = t.website || t['contact:website'] || t.url || null;
  const phone      = t.phone   || t['contact:phone']   || t['contact:mobile'] || null;
  const osmType    = t.amenity || t.shop || t.leisure   || t.office || query;

  return {
    fsqId:         `osm-${el.type}-${el.id}`,
    businessName:  t.name,
    address,
    city:          `${addrCity}, ${addrState}`,
    lat:           lat  || null,
    lng:           lng  || null,
    phone:         phone || null,
    websiteUrl,
    businessType:  osmType,
    foursquareUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

async function nominatimFallback(query, city, state, res) {
  const osmTagMap = {
    restaurant: 'restaurant', cafe: 'cafe', coffee: 'cafe',
    bar: 'bar', pub: 'pub', dentist: 'dentist', doctor: 'doctors',
    clinic: 'clinic', pharmacy: 'pharmacy', gym: 'gym',
    'nail salon': 'beauty', nail: 'beauty', salon: 'hairdresser',
    barber: 'barber', 'auto repair': 'car_repair', mechanic: 'car_repair',
  };
  const q = query.toLowerCase();
  const amenity = Object.entries(osmTagMap).find(([k]) => q.includes(k))?.[1] || query;

  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { amenity, city, state, country: 'USA', format: 'json', limit: 20, countrycodes: 'us', addressdetails: 1 },
      headers: { 'User-Agent': 'LeadForge/1.0', 'Accept': '*/*' },
      timeout: 10000,
    });

    const businesses = (resp.data || []).map(p => ({
      fsqId:         `osm-${p.osm_type}-${p.osm_id}`,
      businessName:  p.name || p.display_name.split(',')[0],
      address:       p.display_name,
      city:          `${p.address?.city || p.address?.town || city}, ${state}`,
      lat:           parseFloat(p.lat),
      lng:           parseFloat(p.lon),
      phone:         null,
      websiteUrl:    null,
      businessType:  query,
      foursquareUrl: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`,
    })).filter(b => b.businessName);

    console.log(`[search] Nominatim fallback returned ${businesses.length} results`);
    res.json({ businesses, provider: 'osm-fallback', fallback: true });
  } catch (err) {
    res.status(500).json({ error: 'Search unavailable — all data sources are down. Try again in a few minutes.' });
  }
}

async function googleSearch(query, city, state) {
  const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
    params: {
      query: `${query} in ${city}, ${state}`,
      key: process.env.GOOGLE_PLACES_API_KEY,
    },
  });

  return (response.data.results || []).map(p => ({
    fsqId:         `google-${p.place_id}`,
    businessName:  p.name,
    address:       p.formatted_address || '',
    city:          `${city}, ${state}`,
    lat:           p.geometry?.location?.lat || null,
    lng:           p.geometry?.location?.lng || null,
    phone:         null,
    websiteUrl:    null,
    businessType:  query,
    foursquareUrl: null,
  }));
}

async function foursquareSearch(query, city, state) {
  // Geocode city first — new FSQ API requires ll=lat,lng instead of near=
  const geo = await geocodeCity(city, state);

  const response = await axios.get('https://places-api.foursquare.com/places/search', {
    headers: {
      Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
      Accept: 'application/json',
      'X-Places-Api-Version': '2025-06-17',
    },
    params: {
      query,
      ll: `${geo.lat},${geo.lon}`,
      radius: 20000,
      limit: 50,
    },
  });

  return (response.data.results || []).map(p => ({
    fsqId:         p.fsq_place_id,
    businessName:  p.name,
    address:       [p.location?.address, p.location?.locality, p.location?.region, p.location?.postcode].filter(Boolean).join(', '),
    city:          [p.location?.locality, p.location?.region].filter(Boolean).join(', '),
    lat:           p.latitude  || null,
    lng:           p.longitude || null,
    phone:         p.tel  || null,
    websiteUrl:    p.website || null,
    businessType:  p.categories?.[0]?.name || query,
    foursquareUrl: p.link || null,
  }));
}

app.get('/api/places-search', async (req, res) => {
  const { query, city = '', state } = req.query;
  if (!query || !state) {
    return res.status(400).json({ error: 'query and state are required' });
  }

  const hasFsq    = !!process.env.FOURSQUARE_API_KEY;
  const googleExpiry = process.env.GOOGLE_PLACES_EXPIRY ? new Date(process.env.GOOGLE_PLACES_EXPIRY) : null;
  const googleExpired = googleExpiry && new Date() > googleExpiry;
  const hasGoogle = !!process.env.GOOGLE_PLACES_API_KEY && !googleExpired;
  if (googleExpired) console.log('[search] Google trial expired — using Foursquare only');

  if (hasFsq || hasGoogle) {
    // Rotate providers on each search to spread credit usage
    const useFoursquare = hasFsq && hasGoogle
      ? searchCounter % 2 === 0   // alternate when both available
      : hasFsq;                   // use whichever is configured
    searchCounter++;

    const provider = useFoursquare ? 'foursquare' : 'google';
    try {
      console.log(`[search] using ${provider} for: ${query} in ${city}, ${state}`);
      const businesses = useFoursquare
        ? await foursquareSearch(query, city, state)
        : await googleSearch(query, city, state);
      console.log(`[search] ${provider} returned ${businesses.length} results`);
      return res.json({ businesses, provider });
    } catch (err) {
      console.error(`[search] ${provider} failed:`, err.message);
      // Try the other provider as fallback
      if (hasFsq && hasGoogle) {
        try {
          const fallbackBusinesses = useFoursquare
            ? await googleSearch(query, city, state)
            : await foursquareSearch(query, city, state);
          const fallbackProvider = useFoursquare ? 'google' : 'foursquare';
          console.log(`[search] fallback ${fallbackProvider} returned ${fallbackBusinesses.length} results`);
          return res.json({ businesses: fallbackBusinesses, provider: fallbackProvider });
        } catch (fallbackErr) {
          console.error('[search] both providers failed, falling back to OSM');
        }
      }
    }
  }

  try {
    console.log(`[search] using OSM for: ${query} in ${city}, ${state}`);
    const bbox = await geocodeCity(city, state);
    console.log(`[search] bbox: ${JSON.stringify(bbox)}`);

    const overpassQuery = buildOverpassQuery(query, bbox);
    console.log('[search] overpass query:\n', overpassQuery);
    const OVERPASS_MIRRORS = [
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];
    let overpassResp;
    for (const mirror of OVERPASS_MIRRORS) {
      try {
        overpassResp = await axios.get(
          `${mirror}?data=${encodeURIComponent(overpassQuery)}`,
          { timeout: 35000 }
        );
        console.log(`[search] overpass OK via ${mirror}`);
        break;
      } catch (mirrorErr) {
        console.warn(`[search] mirror ${mirror} failed (${mirrorErr.response?.status}), trying next...`);
      }
    }
    // Fallback to Nominatim if all mirrors are down or returned no US data
    if (!overpassResp || (overpassResp.data.elements?.length === 0)) {
      console.warn('[search] all Overpass mirrors down, falling back to Nominatim');
      return await nominatimFallback(query, city, state, res);
    }

    const elements = overpassResp.data.elements || [];
    console.log(`[search] overpass returned ${elements.length} elements`);

    const seen = new Set();
    const businesses = elements
      .map(el => mapOsmElement(el, query, city, state))
      .filter(Boolean)
      .filter(b => {
        const key = `${b.businessName}|${b.address}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 50);

    // TODO: Google Places enrichment — when API key is available, call Google Places API here
    // to find missing website URLs using businessName + address as the search query.
    // For each business where websiteUrl is null:
    //   const googleRes = await axios.get('https://maps.googleapis.com/maps/api/place/findplacefromtext/json', {
    //     params: { input: `${b.businessName} ${b.address}`, inputtype: 'textquery',
    //               fields: 'website', key: process.env.GOOGLE_PLACES_API_KEY }
    //   });
    //   b.websiteUrl = googleRes.data.candidates?.[0]?.website || null;

    res.json({ businesses });
  } catch (err) {
    const url = err.config?.url || 'unknown';
    const status = err.response?.status || 'no-status';
    console.error(`[search] ERROR at ${url} → HTTP ${status}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Email Extractor ────────────────────────────────────────────────────────────
app.get('/api/fetch-email', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ email: null });

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxContentLength: 500_000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    const html = typeof response.data === 'string' ? response.data : '';
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = html.match(emailRegex) || [];

    const blacklist = [
      'example.com', 'domain.com', 'email.com', 'yoursite.com',
      'sentry.io', 'w3.org', 'schema.org', 'wixpress.com',
      'squarespace.com', 'shopify.com',
    ];
    const validEmail = matches.find(e => !blacklist.some(d => e.includes(d)));

    res.json({ email: validEmail || null });
  } catch {
    res.json({ email: null });
  }
});

// ── Outreach Message Generator ─────────────────────────────────────────────────
app.post('/api/generate-message', async (req, res) => {
  const { name, businessType, city, issueDescription, type } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }

  const prompt = `You are a freelance web developer writing a cold outreach message.

Business: ${name}
Type: ${businessType}
City: ${city}
Website issue: ${issueDescription}
Message type: ${type}

Write a short, friendly, non-pushy message.
- Instagram DM: 3-4 sentences max, casual tone, mention one specific problem with their site or that they have no site, offer a free mockup as the hook.
- Cold Email: include a subject line, 5-7 sentences, slightly more formal but still human and personal.
- Walk-in Talking Points: bullet points the developer can reference in person — not a script, just key angles to hit.

Never be aggressive. Never use pressure tactics. Never mention deadlines or threats. Sound like a real person, not a salesperson.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ message: message.content[0].text });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LeadForge server → http://localhost:${PORT}`);
});
