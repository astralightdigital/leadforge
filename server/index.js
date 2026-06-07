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

// ── Geocode cache — prevents hitting Nominatim repeatedly for the same city ───
const geocodeCache = new Map();
const GEOCODE_TTL = 20 * 60 * 1000; // 20 minutes

// ── Search result cache — repeat searches cost 0 FSQ credits ─────────────────
const searchCache = new Map();
const SEARCH_TTL = 30 * 60 * 1000; // 30 minutes

// ── OpenStreetMap / Overpass Places Search ────────────────────────────────────
// Free, no API key, no account — uses Nominatim for geocoding + Overpass for POI data.

async function geocodeCity(city, state) {
  // Strip any state abbreviation accidentally typed in the city field
  const cleanCity = city.replace(/,?\s+[A-Z]{2}$/, '').trim();
  const geoQuery = cleanCity ? `${cleanCity}, ${state}` : state;
  const cacheKey = geoQuery.toLowerCase();

  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GEOCODE_TTL) {
    console.log(`[geocode] cache hit for "${geoQuery}"`);
    return cached.data;
  }

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
  const result = { lat: clat, lon: clon, south: clat - delta, north: clat + delta, west: clon - delta, east: clon + delta };

  geocodeCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
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

// Top 5 population centers per state — capped at 5 to limit FSQ API call cost.
// (Each hub = 1 FSQ call, free tier = 1000/day.)
const STATE_HUBS = {
  AL: ['Birmingham','Montgomery','Huntsville','Mobile','Tuscaloosa'],
  AK: ['Anchorage','Fairbanks','Juneau','Sitka','Ketchikan'],
  AZ: ['Phoenix','Tucson','Mesa','Chandler','Scottsdale'],
  AR: ['Little Rock','Fayetteville','Fort Smith','Jonesboro','Springdale'],
  CA: ['Los Angeles','San Diego','San Jose','San Francisco','Sacramento'],
  CO: ['Denver','Colorado Springs','Aurora','Fort Collins','Lakewood'],
  CT: ['Bridgeport','New Haven','Hartford','Stamford','Waterbury'],
  DC: ['Washington'],
  DE: ['Wilmington','Dover','Newark','Middletown','Smyrna'],
  FL: ['Jacksonville','Miami','Tampa','Orlando','St. Petersburg'],
  GA: ['Atlanta','Augusta','Columbus','Macon','Savannah'],
  HI: ['Honolulu','Pearl City','Hilo','Kailua','Kaneohe'],
  ID: ['Boise','Nampa','Meridian','Idaho Falls','Pocatello'],
  IL: ['Chicago','Aurora','Rockford','Joliet','Naperville'],
  IN: ['Indianapolis','Fort Wayne','Evansville','South Bend','Carmel'],
  IA: ['Des Moines','Cedar Rapids','Davenport','Sioux City','Iowa City'],
  KS: ['Wichita','Overland Park','Kansas City','Topeka','Olathe'],
  KY: ['Louisville','Lexington','Bowling Green','Owensboro','Covington'],
  LA: ['New Orleans','Baton Rouge','Shreveport','Lafayette','Lake Charles'],
  ME: ['Portland','Lewiston','Bangor','South Portland','Auburn'],
  MD: ['Baltimore','Frederick','Rockville','Gaithersburg','Annapolis'],
  MA: ['Boston','Worcester','Springfield','Lowell','Cambridge'],
  MI: ['Detroit','Grand Rapids','Warren','Sterling Heights','Ann Arbor'],
  MN: ['Minneapolis','Saint Paul','Rochester','Duluth','Bloomington'],
  MS: ['Jackson','Gulfport','Southaven','Hattiesburg','Biloxi'],
  MO: ['Kansas City','Saint Louis','Springfield','Columbia','Independence'],
  MT: ['Billings','Missoula','Great Falls','Bozeman','Butte'],
  NE: ['Omaha','Lincoln','Bellevue','Grand Island','Kearney'],
  NV: ['Las Vegas','Henderson','Reno','North Las Vegas','Sparks'],
  NH: ['Manchester','Nashua','Concord','Dover','Rochester'],
  NJ: ['Newark','Jersey City','Paterson','Elizabeth','Trenton'],
  NM: ['Albuquerque','Las Cruces','Rio Rancho','Santa Fe','Roswell'],
  NY: ['New York City','Buffalo','Rochester','Yonkers','Syracuse'],
  NC: ['Charlotte','Raleigh','Greensboro','Durham','Winston-Salem'],
  ND: ['Fargo','Bismarck','Grand Forks','Minot','West Fargo'],
  OH: ['Columbus','Cleveland','Cincinnati','Toledo','Akron'],
  OK: ['Oklahoma City','Tulsa','Norman','Broken Arrow','Edmond'],
  OR: ['Portland','Eugene','Salem','Gresham','Hillsboro'],
  PA: ['Philadelphia','Pittsburgh','Allentown','Erie','Reading'],
  RI: ['Providence','Cranston','Warwick','Pawtucket','East Providence'],
  SC: ['Columbia','Charleston','North Charleston','Greenville','Spartanburg'],
  SD: ['Sioux Falls','Rapid City','Aberdeen','Brookings','Watertown'],
  TN: ['Memphis','Nashville','Knoxville','Chattanooga','Clarksville'],
  TX: ['Houston','San Antonio','Dallas','Austin','Fort Worth'],
  UT: ['Salt Lake City','West Valley City','Provo','West Jordan','Orem'],
  VT: ['Burlington','South Burlington','Rutland','Montpelier','Barre'],
  VA: ['Virginia Beach','Norfolk','Chesapeake','Richmond','Newport News'],
  WA: ['Seattle','Spokane','Tacoma','Vancouver','Bellevue'],
  WV: ['Charleston','Huntington','Morgantown','Parkersburg','Wheeling'],
  WI: ['Milwaukee','Madison','Green Bay','Kenosha','Racine'],
  WY: ['Cheyenne','Casper','Laramie','Gillette','Rock Springs'],
};

// Domains that appear in FSQ's website field but aren't actual business websites
const JUNK_WEBSITE_PATTERNS = [
  's3.amazonaws.com', 'cloudfront.net', 'amazonaws.com',
  'hubbiz', 'hub.biz', 'manta.com', 'yellowpages.com', 'yelp.com',
  'chamberofcommerce.com', 'alignable.com', 'thumbtack.com', 'bark.com',
  'homeadvisor.com', 'houzz.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'tiktok.com', 'maps.google.com', 'goo.gl',
  'poi.place', 'bizhub',
];
const JUNK_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf'];
const IMAGE_TLDS = new Set(['jpg','jpeg','png','gif','webp','svg','pdf']);

function sanitizeWebsite(url) {
  if (!url) return null;
  try {
    const lower = url.toLowerCase();
    if (JUNK_WEBSITE_PATTERNS.some(p => lower.includes(p))) return null;
    if (JUNK_EXTENSIONS.some(e => lower.split('?')[0].endsWith(e))) return null;
    // Must start with http — reject protocol-relative (//) and encoded (%2F) URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function mapFsqPlace(p, query) {
  const sm = p.social_media || {};
  return {
    fsqId:         p.fsq_place_id,
    businessName:  p.name,
    address:       [p.location?.address, p.location?.locality, p.location?.region, p.location?.postcode].filter(Boolean).join(', '),
    city:          [p.location?.locality, p.location?.region].filter(Boolean).join(', '),
    lat:           p.geocodes?.main?.latitude  || null,
    lng:           p.geocodes?.main?.longitude || null,
    phone:         p.tel  || null,
    websiteUrl:    sanitizeWebsite(p.website),
    businessType:  p.categories?.[0]?.name || query,
    foursquareUrl: p.link || null,
    socialMedia: {
      instagram: sm.instagram   ? `https://instagram.com/${sm.instagram}`      : null,
      facebook:  sm.facebook_id ? `https://facebook.com/${sm.facebook_id}`     : null,
      twitter:   sm.twitter     ? `https://twitter.com/${sm.twitter}`          : null,
      tiktok:    sm.tiktok      ? `https://tiktok.com/@${sm.tiktok}`           : null,
      snapchat:  sm.snapchat    ? `https://snapchat.com/add/${sm.snapchat}`    : null,
      youtube:   sm.youtube     ? `https://youtube.com/${sm.youtube}`          : null,
      linkedin:  null,
      whatsapp:  null,
    },
  };
}

const CLOSED_BUCKETS = new Set(['VeryLikelyClosed', 'LikelyClosed']);

// ── Geoapify Places ───────────────────────────────────────────────────────────
const GEOAPIFY_CATEGORY_MAP = [
  // Beauty & personal care (service.beauty.*)
  [/nail/,                                        'service.beauty'],
  [/hair|salon/,                                  'service.beauty.hairdresser'],
  [/barber/,                                      'service.beauty.hairdresser'],
  [/\bspa\b/,                                     'service.beauty.spa'],
  [/massage/,                                     'service.beauty.massage'],
  [/tanning/,                                     'service.beauty.tanning_salon'],
  [/tattoo/,                                      'service.beauty.tattoo'],
  [/beauty/,                                      'service.beauty'],
  // Fitness (sport.fitness.*)
  [/\bgym\b|crossfit/,                            'sport.fitness.gym'],
  [/fitness|yoga|pilates|aerobic/,                'sport.fitness'],
  // Food & drink — specific cuisines first
  [/pizza/,                                       'catering.restaurant.pizza'],
  [/burger/,                                      'catering.restaurant.burger'],
  [/korean/,                                      'catering.restaurant.korean'],
  [/chinese/,                                     'catering.restaurant.chinese'],
  [/vietnamese/,                                  'catering.restaurant.vietnamese'],
  [/filipino/,                                    'catering.restaurant.filipino'],
  [/japanese/,                                    'catering.restaurant.japanese'],
  [/ramen/,                                       'catering.restaurant.ramen'],
  [/mexican/,                                     'catering.restaurant.mexican'],
  [/sushi/,                                       'catering.restaurant.sushi'],
  [/thai/,                                        'catering.restaurant.thai'],
  [/indian/,                                      'catering.restaurant.indian'],
  [/asian/,                                       'catering.restaurant.asian,catering.restaurant.chinese,catering.restaurant.korean,catering.restaurant.japanese,catering.restaurant.vietnamese,catering.restaurant.thai,catering.restaurant.sushi,catering.restaurant.filipino,catering.restaurant.ramen,catering.restaurant.noodle'],
  [/bbq|barbecue/,                                'catering.restaurant.barbecue'],
  [/seafood/,                                     'catering.restaurant.seafood'],
  [/cafe|coffee/,                                 'catering.cafe'],
  [/bakery/,                                      'commercial.food_and_drink.bakery'],
  [/fast.?food/,                                  'catering.fast_food'],
  [/bar|pub/,                                     'catering.bar'],
  [/restaurant|dining|eatery/,                    'catering.restaurant'],
  // Healthcare
  [/dentist|dental|orthodontist/,                 'healthcare.dentist'],
  [/doctor|clinic|urgent|chiropractor|therapy/,   'healthcare.clinic_or_praxis'],
  [/pharmacy|drug\s?store/,                       'healthcare.pharmacy'],
  // Pets
  [/vet/,                                         'pet.veterinary'],
  [/pet|grooming/,                                'commercial.pet'],
  // Automotive
  [/auto|car repair|mechanic|oil change|tire/,    'service.vehicle.repair.car'],
  [/car.?wash/,                                   'service.vehicle.car_wash'],
  // Retail & commercial
  [/florist|flower/,                              'commercial.florist'],
  [/grocery|supermarket/,                         'commercial.supermarket'],
  [/optician|eyewear/,                            'commercial.health_and_beauty.optician'],
  [/pharmacy/,                                    'commercial.health_and_beauty.pharmacy'],
  // Cleaning & laundry
  [/laundry/,                                     'service.cleaning.laundry'],
  [/dry.?clean/,                                  'service.cleaning.dry_cleaning'],
  [/cleaning/,                                    'service.cleaning'],
  // Professional offices
  [/real.?estate|realtor/,                        'office.estate_agent'],
  [/lawyer|attorney/,                             'office.lawyer'],
  [/insurance/,                                   'office.insurance'],
  [/accounting|cpa|tax/,                          'office.accountant'],
  [/architect/,                                   'office.architect'],
  // Trades & services
  [/electrician/,                                 'service.electrician'],
  [/locksmith/,                                   'service.locksmith'],
  [/tailor|alteration/,                           'service.tailor'],
  [/photographer/,                                'service.photographer'],
  [/carpenter|shoemaker/,                         'service.carpenter'],
  // Childcare & education
  [/daycare|preschool|childcare/,                 'childcare'],
  [/tutoring|school/,                             'education'],
];

function queryToGeoapifyCategory(query) {
  const q = query.toLowerCase();
  const match = GEOAPIFY_CATEGORY_MAP.find(([re]) => re.test(q));
  return match ? match[1] : 'commercial';
}

function mapGeoapifyPlace(feature, query) {
  const p = feature.properties;
  const [lng, lat] = feature.geometry?.coordinates || [null, null];
  const street  = [p.housenumber, p.street].filter(Boolean).join(' ');
  const address = [street, p.city, p.state_code, p.postcode].filter(Boolean).join(', ') || p.formatted || '';
  const rawCat  = (p.categories || [])[0] || '';
  const bizType = rawCat.split('.').pop().replace(/_/g, ' ') || query;
  return {
    fsqId:         `geo-${p.place_id || Math.random().toString(36).slice(2)}`,
    businessName:  p.name || p.address_line1 || '',
    address,
    city:          [p.city, p.state_code].filter(Boolean).join(', '),
    lat:           lat   || null,
    lng:           lng   || null,
    phone:         p.phone     || p.contact?.phone    || null,
    websiteUrl:    sanitizeWebsite(p.website || p.contact?.website || null),
    businessType:  bizType,
    foursquareUrl: null,
    socialMedia:   { instagram: null, facebook: null, twitter: null, tiktok: null, snapchat: null, youtube: null, linkedin: null, whatsapp: null, pinterest: null, threads: null },
  };
}

async function geoapifySearchNear(query, lat, lng) {
  const category = queryToGeoapifyCategory(query);
  const response = await axios.get('https://api.geoapify.com/v2/places', {
    params: {
      categories: category,
      filter:     `circle:${lng},${lat},30000`,
      limit:      100,
      apiKey:     process.env.GEOAPIFY_API_KEY,
    },
    timeout: 20000,
  });
  return (response.data.features || [])
    .map(f => mapGeoapifyPlace(f, query))
    .filter(b => b.businessName);
}

async function geoapifySearch(query, city, state) {
  if (city.trim()) {
    const geo = await geocodeCity(city, state);
    return geoapifySearchNear(query, geo.lat, geo.lon);
  }
  const hubs = STATE_HUBS[state] || [state];
  console.log(`[search] state-wide Geoapify: querying ${hubs.length} hubs in ${state}`);
  const results = [];
  const seen = new Set();
  for (const hub of hubs) {
    try {
      const geo  = await geocodeCity(hub, state);
      const hits = await geoapifySearchNear(query, geo.lat, geo.lon);
      for (const b of hits) {
        if (!seen.has(b.fsqId)) { seen.add(b.fsqId); results.push(b); }
      }
    } catch (err) {
      console.error(`[geo] ${hub} failed: ${err.response?.status ?? 'err'} ${err.message} — ${JSON.stringify(err.response?.data)}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// ── HERE Places ───────────────────────────────────────────────────────────────
function mapHerePlace(item, query) {
  const contacts = item.contacts?.[0] || {};
  const phone      = contacts.phone?.[0]?.value || null;
  const rawSite    = contacts.www?.[0]?.value   || null;
  const addr       = item.address || {};
  const street     = [addr.houseNumber, addr.street].filter(Boolean).join(' ');
  const address    = [street, addr.city, addr.stateCode, addr.postalCode].filter(Boolean).join(', ') || addr.label || '';
  return {
    fsqId:         item.id,
    businessName:  item.title,
    address,
    city:          [addr.city, addr.stateCode].filter(Boolean).join(', '),
    lat:           item.position?.lat || null,
    lng:           item.position?.lng || null,
    phone,
    websiteUrl:    sanitizeWebsite(rawSite),
    businessType:  item.categories?.find(c => c.primary)?.name || query,
    foursquareUrl: null,
    socialMedia:   { instagram: null, facebook: null, twitter: null, tiktok: null, snapchat: null, youtube: null, linkedin: null, whatsapp: null, pinterest: null, threads: null },
  };
}

async function hereSearchNear(query, lat, lng) {
  const response = await axios.get('https://discover.search.hereapi.com/v1/discover', {
    params: { q: query, in: `circle:${lat},${lng};r=30000`, limit: 100, apiKey: process.env.HERE_API_KEY },
    timeout: 10000,
  });
  return (response.data.items || []).map(item => mapHerePlace(item, query));
}

async function hereSearch(query, city, state) {
  if (city.trim()) {
    const geo = await geocodeCity(city, state);
    return hereSearchNear(query, geo.lat, geo.lon);
  }
  const hubs = STATE_HUBS[state] || [state];
  console.log(`[search] state-wide HERE: querying ${hubs.length} hubs in ${state}`);
  const results = [];
  const seen = new Set();
  for (const hub of hubs) {
    try {
      const geo = await geocodeCity(hub, state);
      const hits = await hereSearchNear(query, geo.lat, geo.lon);
      for (const b of hits) {
        if (!seen.has(b.fsqId)) { seen.add(b.fsqId); results.push(b); }
      }
    } catch (err) {
      console.error(`[here] ${hub} failed: ${err.response?.status ?? 'err'} ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

async function fsqSearchNear(query, near) {
  const response = await axios.get('https://places-api.foursquare.com/places/search', {
    headers: {
      Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
      Accept: 'application/json',
      'X-Places-Api-Version': '2025-06-17',
    },
    params: { query, near, limit: 50 },
  });
  return (response.data.results || []).map(p => mapFsqPlace(p, query));
}

async function foursquareSearch(query, city, state) {
  if (city.trim()) {
    // City-level search — single FSQ call
    return fsqSearchNear(query, `${city.trim()}, ${state}, USA`);
  }

  // State-wide search — query all major hubs in parallel and deduplicate
  const hubs = STATE_HUBS[state];
  if (!hubs) return fsqSearchNear(query, `${state}, USA`);

  console.log(`[search] state-wide FSQ: querying ${hubs.length} hubs in ${state}`);
  const batches = [];
  for (const hub of hubs) {
    try {
      const results = await fsqSearchNear(query, `${hub}, ${state}, USA`);
      batches.push(results);
    } catch (err) {
      console.error(`[fsq] ${hub} failed — HTTP ${err.response?.status ?? 'no-response'}: ${err.message}`);
      batches.push([]);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const seen = new Set();
  return batches.flat().filter(b => {
    if (seen.has(b.fsqId)) return false;
    seen.add(b.fsqId);
    return true;
  });
}

app.get('/api/clear-cache', (req, res) => {
  const sc = searchCache.size;
  const gc = geocodeCache.size;
  searchCache.clear();
  geocodeCache.clear();
  console.log(`[cache] cleared ${sc} search + ${gc} geocode entries`);
  res.json({ cleared: { search: sc, geocode: gc } });
});

app.get('/api/places-search', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { query, city = '', state } = req.query;
  if (!query || !state) {
    return res.status(400).json({ error: 'query and state are required' });
  }

  const cacheKey = `${query.toLowerCase()}|${city.toLowerCase()}|${state.toUpperCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_TTL) {
    console.log(`[search] cache hit for "${query}" in ${city || state}`);
    return res.json({ ...cached.data, fromCache: true });
  }

  const hasGeo  = !!process.env.GEOAPIFY_API_KEY;
  const hasHere = !!process.env.HERE_API_KEY;
  const hasFsq  = !!process.env.FOURSQUARE_API_KEY;

  if (hasGeo) {
    try {
      console.log(`[search] using Geoapify for: ${query} in ${city || state}`);
      const businesses = await geoapifySearch(query, city, state);
      console.log(`[search] Geoapify returned ${businesses.length} results`);
      const payload = { businesses, provider: 'geoapify' };
      searchCache.set(cacheKey, { data: payload, ts: Date.now() });
      return res.json(payload);
    } catch (err) {
      console.error('[search] Geoapify failed, falling back:', err.message);
    }
  }

  if (hasHere) {
    try {
      console.log(`[search] using HERE for: ${query} in ${city || state}`);
      const businesses = await hereSearch(query, city, state);
      console.log(`[search] HERE returned ${businesses.length} results`);
      const payload = { businesses, provider: 'here' };
      searchCache.set(cacheKey, { data: payload, ts: Date.now() });
      return res.json(payload);
    } catch (err) {
      console.error('[search] HERE failed, falling back:', err.message);
    }
  }

  if (hasFsq) {
    try {
      console.log(`[search] using foursquare for: ${query} in ${city}, ${state}`);
      const businesses = await foursquareSearch(query, city, state);
      console.log(`[search] foursquare returned ${businesses.length} results`);
      const fsqPayload = { businesses, provider: 'foursquare' };
      searchCache.set(cacheKey, { data: fsqPayload, ts: Date.now() });
      return res.json(fsqPayload);
    } catch (err) {
      console.error('[search] foursquare failed, falling back to OSM:', err.message);
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
      .slice(0, 200);

    res.json({ businesses });
  } catch (err) {
    const url = err.config?.url || 'unknown';
    const status = err.response?.status || 'no-status';
    console.error(`[search] ERROR at ${url} → HTTP ${status}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Address Geocoding ──────────────────────────────────────────────────────────
app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.json({ lat: null, lng: null });
  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: address, format: 'json', limit: 1, countrycodes: 'us' },
      headers: { 'User-Agent': 'LeadForge/1.0', Accept: '*/*' },
      timeout: 8000,
    });
    const r = resp.data[0];
    res.json(r ? { lat: parseFloat(r.lat), lng: parseFloat(r.lon) } : { lat: null, lng: null });
  } catch {
    res.json({ lat: null, lng: null });
  }
});

// ── FSQ Place Status (closed_bucket) ──────────────────────────────────────────
app.get('/api/place-status', async (req, res) => {
  const { fsqId } = req.query;
  if (!fsqId || fsqId.startsWith('osm-') || fsqId.startsWith('here:') || fsqId.startsWith('geo-') || !process.env.FOURSQUARE_API_KEY) {
    return res.json({ status: 'unknown' });
  }
  try {
    const response = await axios.get(`https://places-api.foursquare.com/places/${fsqId}`, {
      headers: {
        Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
        Accept: 'application/json',
        'X-Places-Api-Version': '2025-06-17',
      },
      params: { fields: 'closed_bucket,name' },
      timeout: 6000,
    });
    res.json({ status: response.data.closed_bucket || 'unknown', name: response.data.name });
  } catch {
    res.json({ status: 'unknown' });
  }
});

// ── FSQ Place Social Media Lookup ─────────────────────────────────────────────
app.get('/api/place-socials', async (req, res) => {
  const { fsqId } = req.query;
  if (!fsqId || fsqId.startsWith('osm-') || fsqId.startsWith('here:') || fsqId.startsWith('geo-') || !process.env.FOURSQUARE_API_KEY) {
    return res.json({ socialMedia: {} });
  }
  try {
    const response = await axios.get(`https://places-api.foursquare.com/places/${fsqId}`, {
      headers: {
        Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
        Accept: 'application/json',
        'X-Places-Api-Version': '2025-06-17',
      },
      params: { fields: 'social_media,email,geocodes' },
      timeout: 8000,
    });
    const sm  = response.data.social_media || {};
    const geo = response.data.geocodes?.main || {};
    res.json({
      email: response.data.email || null,
      lat:   geo.latitude  || null,
      lng:   geo.longitude || null,
      socialMedia: {
        instagram: sm.instagram   ? `https://instagram.com/${sm.instagram}`  : null,
        facebook:  sm.facebook_id ? `https://facebook.com/${sm.facebook_id}` : null,
        twitter:   sm.twitter     ? `https://twitter.com/${sm.twitter}`      : null,
        tiktok:    sm.tiktok      ? `https://tiktok.com/@${sm.tiktok}`       : null,
        snapchat:  sm.snapchat    ? `https://snapchat.com/add/${sm.snapchat}` : null,
        youtube:   sm.youtube     ? `https://youtube.com/${sm.youtube}`       : null,
      },
    });
  } catch {
    res.json({ socialMedia: {} });
  }
});

// ── Email Extractor ────────────────────────────────────────────────────────────
const EMAIL_BLACKLIST = [
  'example.com','domain.com','email.com','yoursite.com','sentry.io',
  'w3.org','schema.org','wixpress.com','squarespace.com','shopify.com',
  'googleapis.com','gstatic.com','facebook.com','instagram.com','twitter.com',
  'tiktok.com','youtube.com','apple.com','microsoft.com','adobe.com',
  'bizhub.com','manta.com','yelp.com','yellowpages.com','thumbtack.com',
  'wix.com','godaddy.com','weebly.com','business.site','sites.google.com',
];
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Cloudflare protects emails with a simple XOR cipher — decode it back
function decodeCfEmail(hex) {
  if (!hex || hex.length < 4) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

// Link-in-bio hosts — these pages are full of social links but no email
const LINKINBIO_HOSTS = new Set([
  'linktr.ee', 'linktree.com', 'bio.link', 'beacons.ai',
  'allmy.bio', 'taplink.cc', 'milkshake.app', 'shorby.com',
  'bento.me', 'koji.com', 'later.com', 'campsite.bio',
]);

function isLinkInBio(url) {
  try { return LINKINBIO_HOSTS.has(new URL(url).hostname.replace('www.', '')); }
  catch { return false; }
}

function extractEmail(html) {
  if (typeof html !== 'string') return null;

  function clean(e) {
    if (!e) return null;
    if (!e.includes('@')) return null;
    if (EMAIL_BLACKLIST.some(d => e.toLowerCase().includes(d))) return null;
    // Reject if TLD looks like an image/file extension (e.g. heartburn.jpg)
    const tld = e.split('.').pop().toLowerCase().split('?')[0];
    if (IMAGE_TLDS.has(tld)) return null;
    // Must look like a real email: word@word.tld
    if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e)) return null;
    return e;
  }

  // 1. mailto: href (most reliable — it's intentionally placed)
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
  if (mailtoMatch) { const e = clean(mailtoMatch[1]); if (e) return e; }

  // 2. JSON-LD structured data (schema.org LocalBusiness often has email)
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const traverse = obj => {
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.email === 'string') return obj.email.replace(/^mailto:/i, '').trim();
        for (const v of Object.values(obj)) { const f = traverse(v); if (f) return f; }
        return null;
      };
      const e = clean(traverse(JSON.parse(m[1])));
      if (e) return e;
    } catch {}
  }

  // 3. Cloudflare email protection (#data-cfemail and /cdn-cgi/l/email-protection)
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const e = clean(decodeCfEmail(m[1])); if (e) return e;
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const e = clean(decodeCfEmail(m[1])); if (e) return e;
  }

  // 4. Deobfuscate common patterns before regex scan
  const deob = html
    .replace(/\[at\]/gi, '@').replace(/\(at\)/gi, '@').replace(/\bat\b/g, '@')
    .replace(/\[dot\]/gi, '.').replace(/\(dot\)/gi, '.');
  const e = (deob.match(EMAIL_RE) || []).map(clean).find(Boolean);
  if (e) return e;

  return null;
}

const SOCIAL_SKIP = new Set(['sharer','share','dialog','photo','photos','p','reel','reels',
  'hashtag','explore','stories','watch','shorts','intent','home','login','signup',
  'about','help','privacy','terms','ads','business','developers','plugins']);

function parseSocialLink(raw, socials) {
  const link = raw.replace(/[?#].*$/, '').replace(/[/.,)'"\s]+$/, '');
  const low  = link.toLowerCase();
  if (!socials.instagram && low.includes('instagram.com')) {
    const m = link.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase())) socials.instagram = `https://instagram.com/${m[1]}`;
  }
  if (!socials.facebook && low.includes('facebook.com')) {
    const m = link.match(/facebook\.com\/(?:pages\/[^/]+\/)?([A-Za-z0-9_.%-]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase()) && !/^\d{10,}$/.test(m[1]) && m[1].length > 2)
      socials.facebook = `https://facebook.com/${m[1]}`;
  }
  if (!socials.twitter && (low.includes('twitter.com') || low.includes('x.com'))) {
    const m = link.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase())) socials.twitter = `https://twitter.com/${m[1]}`;
  }
  if (!socials.tiktok && low.includes('tiktok.com')) {
    const m = link.match(/tiktok\.com\/@?([A-Za-z0-9_.]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase())) socials.tiktok = `https://tiktok.com/@${m[1]}`;
  }
  if (!socials.youtube && low.includes('youtube.com')) {
    const m = link.match(/youtube\.com\/(?:channel\/|user\/|c\/|@)?([A-Za-z0-9_@-]+)/);
    if (m && m[1] && !SOCIAL_SKIP.has(m[1].toLowerCase())) socials.youtube = link;
  }
  if (!socials.linkedin && low.includes('linkedin.com/company/')) {
    const m = link.match(/linkedin\.com\/company\/([\w-]+)/);
    if (m && m[1]) socials.linkedin = `https://linkedin.com/company/${m[1]}`;
  }
  if (!socials.whatsapp && (low.includes('wa.me/') || low.includes('whatsapp.com/send'))) {
    const m = link.match(/wa\.me\/(\d+)/) || link.match(/[?&]phone=(\d+)/);
    if (m) socials.whatsapp = `https://wa.me/${m[1]}`;
  }
  if (!socials.pinterest && low.includes('pinterest.com')) {
    const m = link.match(/pinterest\.com\/([A-Za-z0-9_.-]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase()) && m[1] !== 'pin') {
      socials.pinterest = `https://pinterest.com/${m[1]}`;
    }
  }
  if (!socials.threads && low.includes('threads.net')) {
    const m = link.match(/threads\.net\/@?([A-Za-z0-9_.-]+)/);
    if (m && !SOCIAL_SKIP.has(m[1].toLowerCase())) {
      socials.threads = `https://threads.net/@${m[1].replace(/^@/, '')}`;
    }
  }
}

function extractSocials(html) {
  if (typeof html !== 'string') return { socials: {}, phone: null };
  const socials = {};
  let phone = null;

  // Priority 1: JSON-LD sameAs — the most authoritative social link source
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const traverse = obj => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.sameAs) {
          (Array.isArray(obj.sameAs) ? obj.sameAs : [obj.sameAs])
            .filter(l => typeof l === 'string')
            .forEach(l => parseSocialLink(l, socials));
        }
        if (obj.telephone && !phone) phone = obj.telephone;
        Object.values(obj).forEach(traverse);
      };
      traverse(JSON.parse(m[1]));
    } catch {}
  }

  // Priority 2: meta tags (twitter:creator, twitter:site)
  for (const m of html.matchAll(/<meta[^>]*name=["']twitter:(creator|site)["'][^>]*content=["'](@?[A-Za-z0-9_]+)["']/gi)) {
    if (!socials.twitter) socials.twitter = `https://twitter.com/${m[2].replace('@', '')}`;
  }

  // Priority 3: rel="me" (IndieWeb social identity assertions)
  for (const m of html.matchAll(/<a[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]+href=["']([^"']+)["']/gi)) {
    parseSocialLink(m[1], socials);
  }

  // Priority 4: generic href scan
  for (const raw of (html.match(/https?:\/\/(?:www\.)?(?:instagram|facebook|twitter|x|tiktok|youtube|snapchat|linkedin|pinterest)\.com\/[^\s"'<>)]+|https?:\/\/(?:www\.)?threads\.net\/[^\s"'<>)]+|https?:\/\/wa\.me\/\d+/gi) || [])) {
    parseSocialLink(raw, socials);
  }

  // tel: href — most reliable phone source outside JSON-LD
  if (!phone) {
    const m = html.match(/href=["']tel:([+\d\s\-().]{7,20})["']/i);
    if (m) {
      const raw = m[1].trim();
      if (raw.replace(/\D/g, '').length >= 10) phone = raw;
    }
  }

  // Plain-text US phone pattern as last resort
  if (!phone) {
    const m = html.match(/\(?\b\d{3}\b\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/);
    if (m) phone = m[0].trim();
  }

  return { socials, phone };
}

const SOCIAL_SEARCH_SKIP_FB = new Set(['search','sharer','dialog','share','login','help','legal','about','privacy','groups','events','marketplace','watch','hashtag','stories','notifications','settings','find-friends','people','ad']);
const SOCIAL_SEARCH_SKIP_IG = new Set(['p','explore','reel','tv','stories','reels','accounts','help','direct','_explore','hashtag']);

async function searchSocialMedia(name, city) {
  const socials = {};
  if (!name) return socials;
  const location = city ? city.split(',')[0].trim() : '';

  // Bing Web Search API (free 1000/mo on Azure F1)
  if (process.env.BING_API_KEY) {
    try {
      const q = `"${name}" ${location} site:facebook.com OR site:instagram.com`;
      const r = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
        params: { q, count: 10, responseFilter: 'Webpages' },
        headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_API_KEY },
        timeout: 6000,
      });
      for (const result of r.data.webPages?.value || []) {
        const u = result.url || '';
        if (!socials.facebook && u.includes('facebook.com')) {
          const m = u.match(/facebook\.com\/(pages\/[^/?&]+\/\d+|[a-zA-Z0-9._-]+)/);
          const slug = m?.[1]?.split('/')[0];
          if (slug && !SOCIAL_SEARCH_SKIP_FB.has(slug.toLowerCase())) socials.facebook = `https://facebook.com/${m[1]}`;
        }
        if (!socials.instagram && u.includes('instagram.com')) {
          const m = u.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
          if (m && !SOCIAL_SEARCH_SKIP_IG.has(m[1].toLowerCase())) socials.instagram = `https://instagram.com/${m[1]}`;
        }
        if (socials.facebook && socials.instagram) break;
      }
      return socials;
    } catch (e) { console.error('[social-search] Bing API:', e.message); }
  }

  // DuckDuckGo HTML — run separate site: searches for FB and IG
  const ddgSearch = async (query) => {
    const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const matches = html.match(/uddg=([^&"'\s]+)/g) || [];
    return matches.map(m => { try { return decodeURIComponent(m.replace('uddg=', '')); } catch { return ''; } });
  };

  try {
    // Facebook-specific search first
    if (!socials.facebook) {
      const urls = await ddgSearch(`"${name}" ${location} site:facebook.com`);
      for (const u of urls) {
        if (!u.includes('facebook.com')) continue;
        const slug = u.split('facebook.com/')[1]?.split(/[/?#]/)[0];
        if (slug && !SOCIAL_SEARCH_SKIP_FB.has(slug.toLowerCase())) {
          socials.facebook = `https://facebook.com/${slug}`;
          break;
        }
      }
    }
    // Instagram-specific search
    if (!socials.instagram) {
      const urls = await ddgSearch(`"${name}" ${location} site:instagram.com`);
      for (const u of urls) {
        if (!u.includes('instagram.com')) continue;
        const slug = u.split('instagram.com/')[1]?.split(/[/?#]/)[0];
        if (slug && !SOCIAL_SEARCH_SKIP_IG.has(slug.toLowerCase())) {
          socials.instagram = `https://instagram.com/${slug}`;
          break;
        }
      }
    }
    if (socials.facebook || socials.instagram)
      console.log(`[social-search] DDG "${name}" ${location}: fb=${socials.facebook} ig=${socials.instagram}`);
  } catch (e) { console.error('[social-search] DDG:', e.message); }

  // Yelp scraping — listings often have FB/IG links in the business info section
  if (!socials.facebook && !socials.instagram) {
    try {
      const yelpQ = encodeURIComponent(`${name} ${location}`);
      const searchHtml = await fetchHtml(`https://www.yelp.com/search?find_desc=${yelpQ}&find_loc=${encodeURIComponent(location)}`);
      const bizPath = searchHtml.match(/href="(\/biz\/[^"?#]+)"/)?.[1];
      if (bizPath) {
        const bizHtml = await fetchHtml(`https://www.yelp.com${bizPath}`);
        const { socials: yelpSocials } = extractSocials(bizHtml);
        Object.entries(yelpSocials).forEach(([k, v]) => { if (v && !socials[k]) socials[k] = v; });
        if (socials.facebook || socials.instagram)
          console.log(`[social-search] Yelp "${name}": fb=${socials.facebook} ig=${socials.instagram}`);
      }
    } catch (e) { console.error('[social-search] Yelp:', e.message); }
  }

  // Yellow Pages scraping — another directory with social links
  if (!socials.facebook && !socials.instagram) {
    try {
      const ypQ  = encodeURIComponent(name);
      const ypLoc = encodeURIComponent(location);
      const ypHtml = await fetchHtml(`https://www.yellowpages.com/search?search_terms=${ypQ}&geo_location_terms=${ypLoc}`);
      const ypPath = ypHtml.match(/href="(\/[^"?#]*?\/bp\/[^"?#]+)"/)?.[1];
      if (ypPath) {
        const ypBiz = await fetchHtml(`https://www.yellowpages.com${ypPath}`);
        const { socials: ypSocials } = extractSocials(ypBiz);
        Object.entries(ypSocials).forEach(([k, v]) => { if (v && !socials[k]) socials[k] = v; });
        if (socials.facebook || socials.instagram)
          console.log(`[social-search] YP "${name}": fb=${socials.facebook} ig=${socials.instagram}`);
      }
    } catch (e) { console.error('[social-search] YP:', e.message); }
  }

  // Broader DDG fallback — no quotes, catches name variations
  if (!socials.facebook && !socials.instagram) {
    try {
      const urls = await ddgSearch(`${name} ${location} site:facebook.com`);
      for (const u of urls) {
        if (!u.includes('facebook.com')) continue;
        const slug = u.split('facebook.com/')[1]?.split(/[/?#]/)[0];
        if (slug && !SOCIAL_SEARCH_SKIP_FB.has(slug.toLowerCase())) {
          socials.facebook = `https://facebook.com/${slug}`;
          break;
        }
      }
      if (!socials.instagram) {
        const urls2 = await ddgSearch(`${name} ${location} site:instagram.com`);
        for (const u of urls2) {
          if (!u.includes('instagram.com')) continue;
          const slug = u.split('instagram.com/')[1]?.split(/[/?#]/)[0];
          if (slug && !SOCIAL_SEARCH_SKIP_IG.has(slug.toLowerCase())) {
            socials.instagram = `https://instagram.com/${slug}`;
            break;
          }
        }
      }
      if (socials.facebook || socials.instagram)
        console.log(`[social-search] DDG broad "${name}": fb=${socials.facebook} ig=${socials.instagram}`);
    } catch (e) { console.error('[social-search] DDG broad:', e.message); }
  }

  return socials;
}

async function fetchHtml(pageUrl) {
  const resp = await axios.get(pageUrl, {
    timeout: 8000,
    maxContentLength: 500_000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  return typeof resp.data === 'string' ? resp.data : '';
}

app.get('/api/fetch-email', async (req, res) => {
  const { url, facebook, fsqId, name, city } = req.query;
  if (!url && !facebook && !fsqId && !name) return res.json({ email: null });

  // Priority 1: FSQ place data (structured, authoritative)
  if (fsqId && !fsqId.startsWith('osm-') && !fsqId.startsWith('here:') && !fsqId.startsWith('geo-') && process.env.FOURSQUARE_API_KEY) {
    try {
      const r = await axios.get(`https://places-api.foursquare.com/places/${fsqId}`, {
        headers: {
          Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
          Accept: 'application/json',
          'X-Places-Api-Version': '2025-06-17',
        },
        params: { fields: 'email' },
        timeout: 6000,
      });
      const fsqEmail = r.data.email;
      if (fsqEmail && !EMAIL_BLACKLIST.some(d => fsqEmail.toLowerCase().includes(d))) {
        return res.json({ email: fsqEmail, source: 'foursquare' });
      }
    } catch {}
  }

  // Priority 2: Geoapify Place Details — richer contact info for geo- leads
  let detailsWebsite = null;
  const detailsSocials = {};
  let detailsPhone = null;

  if (fsqId && fsqId.startsWith('geo-') && process.env.GEOAPIFY_API_KEY) {
    try {
      const placeId = fsqId.replace(/^geo-/, '');
      const r = await axios.get('https://api.geoapify.com/v2/place-details', {
        params: { id: placeId, features: 'contact,details', apiKey: process.env.GEOAPIFY_API_KEY },
        timeout: 8000,
      });
      const c = r.data.features?.[0]?.properties?.contact || {};

      // Direct email
      if (c.email) {
        const e = c.email.replace(/^mailto:/i, '').trim();
        if (e.includes('@') && !EMAIL_BLACKLIST.some(d => e.toLowerCase().includes(d))) {
          return res.json({ email: e, source: 'geoapify', socials: {}, phone: c.phone || null });
        }
      }
      // Website for scraping
      if (!url && c.website) detailsWebsite = sanitizeWebsite(c.website);
      // Phone
      if (c.phone) detailsPhone = c.phone;
      // Socials
      const socialPrefixes = { facebook: 'https://facebook.com/', instagram: 'https://instagram.com/', twitter: 'https://twitter.com/', linkedin: 'https://linkedin.com/company/' };
      Object.entries(socialPrefixes).forEach(([k, prefix]) => {
        if (c[k]) detailsSocials[k] = c[k].startsWith('http') ? c[k] : `${prefix}${c[k]}`;
      });
    } catch {}

  }

  // Priority 3: Scrape website pages + Facebook in parallel
  const effectiveUrl = url || detailsWebsite;
  const candidates = [];
  if (effectiveUrl) {
    try {
      const origin = new URL(effectiveUrl).origin;
      candidates.push(
        effectiveUrl,
        `${origin}/contact`, `${origin}/contact-us`, `${origin}/contactus`,
        `${origin}/about`,   `${origin}/about-us`,
        `${origin}/reach-us`,`${origin}/get-in-touch`,
        `${origin}/team`,    `${origin}/staff`,
        `${origin}/location`,`${origin}/locations`,
        `${origin}/find-us`, `${origin}/info`,
      );
    } catch { candidates.push(effectiveUrl); }
  }
  if (facebook) candidates.push(facebook);

  // If the URL is a link-in-bio service (Linktree, Beacons, etc.), fetch it and
  // collect all external links — these are the business's actual profiles + real site
  if (effectiveUrl && isLinkInBio(effectiveUrl)) {
    try {
      const bioHtml = await fetchHtml(url).catch(() => '');
      const bioLinks = [];
      for (const m of (bioHtml.match(/href=["'](https?:\/\/[^"']+)["']/gi) || [])) {
        const href = m.match(/href=["'](https?:\/\/[^"']+)["']/i)?.[1];
        if (!href) continue;
        try {
          const host = new URL(href).hostname.replace('www.', '');
          if (LINKINBIO_HOSTS.has(host)) continue; // skip other bio pages
          bioLinks.push(href);
        } catch {}
      }
      // Dedupe and add non-social links as extra scrape candidates (real website)
      const socialHosts = new Set(['instagram.com','facebook.com','twitter.com','x.com','tiktok.com','youtube.com','pinterest.com','threads.net','linkedin.com','snapchat.com','wa.me','whatsapp.com']);
      for (const link of [...new Set(bioLinks)]) {
        const host = new URL(link).hostname.replace('www.', '');
        if (!socialHosts.has(host) && !candidates.includes(link)) {
          candidates.push(link);
        }
      }
    } catch {}
  }

  // Try sitemap.xml to find real contact page URLs
  if (effectiveUrl) {
    try {
      const origin = new URL(effectiveUrl).origin;
      const sitemap = await fetchHtml(`${origin}/sitemap.xml`).catch(() => '');
      const contactUrls = (sitemap.match(/<loc>([^<]*(?:contact|about|team|reach)[^<]*)<\/loc>/gi) || [])
        .map(l => l.replace(/<\/?loc>/gi, '').trim())
        .slice(0, 3);
      contactUrls.forEach(u => { if (!candidates.includes(u)) candidates.push(u); });
    } catch {}
  }

  const htmlResults = await Promise.allSettled(candidates.map(fetchHtml));
  const allHtml = htmlResults.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);

  // Extract email + socials + phone from all pages
  let foundEmail = null;
  const foundSocials = { ...detailsSocials }; // seed with Place Details socials
  let foundPhone = detailsPhone || null;      // seed with Place Details phone

  for (const html of allHtml) {
    if (!foundEmail) { const e = extractEmail(html); if (e) foundEmail = e; }
    const { socials, phone } = extractSocials(html);
    Object.entries(socials).forEach(([k, v]) => { if (v && !foundSocials[k]) foundSocials[k] = v; });
    if (phone && !foundPhone) foundPhone = phone;
  }

  // Web search for Facebook/Instagram when website scraping found nothing
  if (name && !foundSocials.facebook && !foundSocials.instagram) {
    const searched = await searchSocialMedia(name, city);
    Object.entries(searched).forEach(([k, v]) => { if (v && !foundSocials[k]) foundSocials[k] = v; });
  }

  if (foundEmail) return res.json({ email: foundEmail, socials: foundSocials, phone: foundPhone });

  // Last resort: guess common prefixes on the domain and verify with MX lookup
  if (effectiveUrl) {
    try {
      const { hostname } = new URL(effectiveUrl);
      const domain = hostname.replace(/^www\./, '');
      // Skip free-builder domains — guessing emails there is meaningless
      const skipDomains = ['wix.com','squarespace.com','godaddy.com','weebly.com','business.site','sites.google.com','bizhub.com'];
      if (!skipDomains.some(d => domain.includes(d))) {
        const dns = await import('dns').then(m => m.promises);
        const mx = await dns.resolveMx(domain).catch(() => []);
        if (mx.length > 0) {
          return res.json({ email: domain, guessed: true, socials: foundSocials, phone: foundPhone });
        }
      }
    } catch {}
  }

  res.json({ email: null, socials: foundSocials, phone: foundPhone });
});

// ── Google Places Enrichment ───────────────────────────────────────────────────
// Looks up a business by name + address and returns website + phone from Google.
// Many no-website businesses list their Instagram URL as their "website" in GMB.
app.get('/api/google-enrich', async (req, res) => {
  const { name, address } = req.query;
  if (!name || !process.env.GOOGLE_PLACES_API_KEY) {
    return res.json({ website: null, phone: null });
  }
  try {
    const input = [name, address].filter(Boolean).join(' ');
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/findplacefromtext/json', {
      params: {
        input,
        inputtype:  'textquery',
        fields:     'website,formatted_phone_number,name',
        key:        process.env.GOOGLE_PLACES_API_KEY,
      },
      timeout: 8000,
    });
    const c = r.data.candidates?.[0];
    if (!c) return res.json({ website: null, phone: null });

    const raw = c.website || null;
    const website = sanitizeWebsite(raw) || (raw?.includes('instagram.com') ? raw : null);
    res.json({ website, phone: c.formatted_phone_number || null });
  } catch (err) {
    console.error('[google-enrich]', err.message);
    res.json({ website: null, phone: null });
  }
});

// ── AI Website Auditor ─────────────────────────────────────────────────────────
app.get('/api/audit-website', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const origin = new URL(url).origin;
    const pages = await Promise.allSettled([
      fetchHtml(url),
      fetchHtml(`${origin}/contact`).catch(() => ''),
      fetchHtml(`${origin}/about`).catch(() => ''),
    ]);
    const html = pages
      .flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
      .join('\n')
      .slice(0, 12000);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Analyze this small business website for a freelance web developer pitching a redesign.
URL: ${url}
HTML:
${html}

List 3-5 specific, concrete problems visible in the HTML or detectable from the URL. Be precise.
Examples: "No mobile viewport meta tag", "No contact form or email found", "Built on Wix subdomain", "No phone number on homepage", "No HTTPS"

Reply with ONLY a JSON array of short strings.`,
      }],
    });

    let issues;
    try { issues = JSON.parse(response.content[0].text.trim()); }
    catch { issues = [response.content[0].text.trim()]; }

    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Outreach Message Generator ─────────────────────────────────────────────────
app.post('/api/generate-message', async (req, res) => {
  const { name, businessType, city, issueDescription, type, issues } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }

  const issueText = Array.isArray(issues) && issues.length
    ? `Specific website problems found:\n${issues.map(i => `- ${i}`).join('\n')}`
    : `Website issue: ${issueDescription}`;

  const prompt = `You are a freelance web developer writing a cold outreach message.

Business: ${name}
Type: ${businessType}
City: ${city}
${issueText}
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
