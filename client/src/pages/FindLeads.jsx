import { useState, useEffect, useRef, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { collection, addDoc, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { getSiteQuality, calculateLeadScore } from '../lib/scoring';
import { formatPhone } from '../lib/utils';
import SiteQualityBadge from '../components/SiteQualityBadge';
import LeadScoreBadge from '../components/LeadScoreBadge';
import { showToast } from '../components/Toast';
import { useLeads } from '../hooks/useLeads';
import { api } from '../lib/api';
import { CITIES_BY_STATE } from '../lib/usaCities';

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY',
];

const QUALITY_ORDER = { none: 0, weak: 1, has: 2 };

const COMMON_BUSINESS_TYPES = [
  'nail salon', 'hair salon', 'barber shop', 'beauty salon', 'eyelash extensions',
  'restaurant', 'pizza', 'cafe', 'coffee shop', 'bakery', 'sushi', 'taco shop',
  'bar', 'pub', 'fast food', 'food truck',
  'gym', 'fitness center', 'yoga studio', 'pilates', 'crossfit',
  'auto repair', 'car wash', 'oil change', 'mechanic', 'tire shop',
  'dentist', 'dental office', 'orthodontist',
  'doctor', 'clinic', 'urgent care', 'chiropractor', 'physical therapy',
  'pharmacy', 'veterinary', 'pet grooming',
  'florist', 'flower shop', 'gift shop',
  'laundry', 'dry cleaning', 'alterations',
  'real estate', 'realtor', 'property management',
  'lawyer', 'attorney', 'law office',
  'accounting', 'CPA', 'tax preparer', 'bookkeeping',
  'insurance', 'financial advisor',
  'plumber', 'electrician', 'HVAC', 'contractor', 'roofer',
  'tutoring', 'daycare', 'preschool',
  'massage', 'spa', 'acupuncture', 'tanning salon',
  'cleaning service', 'landscaping', 'pest control',
  'photography', 'printing', 'sign shop',
  'catering', 'event planning', 'wedding venue',
];

export default function FindLeads() {
  const location = useLocation();
  const { leads } = useLeads();
  const existingFsqIds = useMemo(() => new Set(leads.map(l => l.fsqId).filter(Boolean)), [leads]);
  const [searches, setSearches] = useState([{ term: '', city: '', state: '' }]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [addedIds, setAddedIds] = useState(new Set());
  const sortOrder = 'quality';
  const [isFallback, setIsFallback] = useState(false);
  const [requirePhone,  setRequirePhone]  = useState(false);
  const [requireSocial, setRequireSocial] = useState(false);
  const [requireEmail,  setRequireEmail]  = useState(false);

  // US Bulk Scan
  const [showUSScan, setShowUSScan]         = useState(false);
  const [scanTerm, setScanTerm]             = useState('');
  const [scanMinScore, setScanMinScore]     = useState(4);
  const [scanning, setScanning]             = useState(false);
  const [scanProgress, setScanProgress]     = useState(null);
  const [scanResults, setScanResults]       = useState([]);
  const [bulkAdding, setBulkAdding]         = useState(false);
  const [bulkAddedCount, setBulkAddedCount] = useState(0);
  const [showScanPreview, setShowScanPreview] = useState(false);
  const scanAbortRef = useRef(false);
  const [enrichingTotal, setEnrichingTotal]   = useState(0);
  const [enrichingDone,  setEnrichingDone]    = useState(0);
  const enrichAbortRef = useRef(false);

  // Saved searches (localStorage)
  const [savedSearches, setSavedSearches] = useState(() => {
    try { return JSON.parse(localStorage.getItem('lf_saved_searches') || '[]'); }
    catch { return []; }
  });

  // Pre-fill from dashboard quick search
  useEffect(() => {
    if (location.state?.prefillTerm || location.state?.prefillCity) {
      setSearches([{
        term:  location.state.prefillTerm  || '',
        city:  location.state.prefillCity  || '',
        state: location.state.prefillState || '',
      }]);
    }
  }, [location.state]);

  function addRow() {
    setSearches(prev => [...prev, { term: '', city: '', state: '' }]);
  }

  function removeRow(i) {
    setSearches(prev => prev.filter((_, idx) => idx !== i));
  }

  function updateRow(i, field, value) {
    setSearches(prev => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }

  function saveSearch(s) {
    if (!s.term.trim()) return;
    const key = `${s.term.toLowerCase()}|${s.city}|${s.state}`;
    setSavedSearches(prev => {
      const deduped = prev.filter(x => `${x.term.toLowerCase()}|${x.city}|${x.state}` !== key);
      const next = [{ term: s.term, city: s.city, state: s.state }, ...deduped].slice(0, 12);
      localStorage.setItem('lf_saved_searches', JSON.stringify(next));
      return next;
    });
    showToast('Search saved');
  }

  function removeSavedSearch(idx) {
    setSavedSearches(prev => {
      const next = prev.filter((_, i) => i !== idx);
      localStorage.setItem('lf_saved_searches', JSON.stringify(next));
      return next;
    });
  }

  async function runUSScan() {
    const term = scanTerm.trim();
    if (!term) return;
    scanAbortRef.current = false;
    setScanning(true);
    setScanResults([]);
    setBulkAddedCount(0);
    setShowScanPreview(false);

    const accumulated = [];
    const seenIds = new Set([...existingFsqIds]);

    for (let i = 0; i < STATES.length; i++) {
      if (scanAbortRef.current) break;
      const state = STATES[i];
      setScanProgress({ state, done: i, total: STATES.length, found: accumulated.length });
      try {
        const res  = await fetch(api(`/api/places-search?query=${encodeURIComponent(term)}&city=&state=${encodeURIComponent(state)}`));
        const data = await res.json();
        const hits = (data.businesses || [])
          .map(b => ({
            ...b,
            businessType: term,
            phone:        formatPhone(b.phone),
            siteQuality:  getSiteQuality(b.websiteUrl),
            leadScore:    calculateLeadScore(b.websiteUrl),
          }))
          .filter(b => b.leadScore >= scanMinScore && !seenIds.has(b.fsqId));
        hits.forEach(b => seenIds.add(b.fsqId));
        accumulated.push(...hits);
      } catch {}
    }

    setScanProgress(p => ({ ...p, done: STATES.length, found: accumulated.length, complete: true }));
    setScanResults(accumulated);
    setScanning(false);
  }

  async function bulkAddToFirestore() {
    if (!scanResults.length) return;
    setBulkAdding(true);
    setBulkAddedCount(0);

    const BATCH = 5;
    for (let i = 0; i < scanResults.length; i += BATCH) {
      await Promise.all(
        scanResults.slice(i, i + BATCH).map(async lead => {
          try {
            const docData = {
              fsqId:             lead.fsqId,
              businessName:      lead.businessName,
              businessType:      lead.businessType,
              city:              lead.city,
              address:           lead.address,
              lat:               lead.lat,
              lng:               lead.lng,
              phone:             lead.phone || null,
              websiteUrl:        lead.websiteUrl || null,
              siteQuality:       lead.siteQuality,
              leadScore:         lead.leadScore,
              foursquareUrl:     lead.foursquareUrl || null,
              socialMedia:       lead.socialMedia || {},
              discoveredEmail:   null,
              status:            'Not Contacted',
              contactedAt:       null,
              notes:             [],
              generatedMessages: {},
              dateAdded:         new Date().toISOString(),
            };
            const docRef = await addDoc(collection(db, 'leads'), docData);
            const q = new URLSearchParams();
            if (lead.fsqId && !lead.fsqId.startsWith('osm-') && !lead.fsqId.startsWith('here:')) q.set('fsqId', lead.fsqId);
            if (lead.websiteUrl)            q.set('url',      lead.websiteUrl);
            if (lead.socialMedia?.facebook) q.set('facebook', lead.socialMedia.facebook);
            if (lead.businessName)          q.set('name',     lead.businessName);
            if (lead.city)                  q.set('city',     lead.city);
            if ([...q.keys()].length) {
              fetch(api(`/api/fetch-email?${q}`))
                .then(r => r.json())
                .then(({ email, guessed, socials, phone }) => {
                  const upd = {};
                  if (email) { upd.discoveredEmail = email; upd.emailGuessed = !!guessed; }
                  if (socials) {
                    Object.entries(socials).forEach(([k, v]) => { if (v) upd[`socialMedia.${k}`] = v; });
                  }
                  if (phone) upd.discoveredPhone = phone;
                  if (Object.keys(upd).length) updateDoc(doc(db, 'leads', docRef.id), upd).catch(() => {});
                })
                .catch(() => {});
            }
          } catch {}
        })
      );
      setBulkAddedCount(Math.min(i + BATCH, scanResults.length));
    }

    setBulkAdding(false);
    showToast(`${scanResults.length} leads added to pipeline`);
    setScanResults([]);
    setScanProgress(null);
    setShowScanPreview(false);
  }

  async function runSearches() {
    const valid = searches.filter(s => s.term.trim() && s.state.trim());
    if (!valid.length) {
      setError('Fill in business type and state for at least one row.');
      return;
    }
    setError('');
    setLoading(true);
    setResults([]);
    setIsFallback(false);
    enrichAbortRef.current = true;
    setEnrichingTotal(0);

    try {
      const allResults = await Promise.all(
        valid.map(s =>
          fetch(api(`/api/places-search?query=${encodeURIComponent(s.term)}&city=${encodeURIComponent(s.city)}&state=${encodeURIComponent(s.state)}`))
            .then(r => r.json())
            .then(data => {
              if (data.error) throw new Error(data.error);
              if (data.fallback) setIsFallback(true);
              return (data.businesses || []).map(b => ({ ...b, searchTerm: s.term }));
            })
        )
      );

      const seen = new Set();
      const deduped = allResults.flat().filter(b => {
        const key = `${b.businessName}|${b.address}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const enriched = deduped.map(b => {
        const quality = getSiteQuality(b.websiteUrl);
        return {
          ...b,
          businessType: b.searchTerm || b.businessType,
          phone:        formatPhone(b.phone),
          siteQuality:  quality,
          leadScore:    calculateLeadScore(b.websiteUrl),
        };
      });

      setResults(enriched);
      enrichAbortRef.current = false;
      setEnrichingDone(0);
      setEnrichingTotal(enriched.length);
      enrichInBackground(enriched);
    } catch (err) {
      setError(`Search failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function enrichInBackground(leads) {
    const BATCH = 10;
    const DELAY = 300;
    for (let i = 0; i < leads.length; i += BATCH) {
      if (enrichAbortRef.current) break;
      const batch = leads.slice(i, i + BATCH);
      await Promise.all(batch.map(async lead => {
        if (enrichAbortRef.current) return;
        try {
          const q = new URLSearchParams();
          if (lead.businessName) q.set('name', lead.businessName);
          if (lead.city)         q.set('city', lead.city);
          const data = await fetch(api(`/api/fetch-email?${q}`)).then(r => r.json());
          const update = {};
          if (data.socials) Object.entries(data.socials).forEach(([k, v]) => { if (v) update[k] = v; });
          if (Object.keys(update).length) {
            setResults(prev => prev.map(r =>
              r.fsqId === lead.fsqId
                ? { ...r, socialMedia: { ...r.socialMedia, ...update } }
                : r
            ));
          }
        } catch {}
      }));
      setEnrichingDone(prev => Math.min(prev + BATCH, leads.length));
      if (i + BATCH < leads.length) await new Promise(res => setTimeout(res, DELAY));
    }
    setEnrichingTotal(0);
  }

  async function addToPipeline(lead) {
    if (addedIds.has(lead.fsqId) || existingFsqIds.has(lead.fsqId)) return;
    const docData = {
      fsqId:             lead.fsqId,
      businessName:      lead.businessName,
      businessType:      lead.businessType,
      city:              lead.city,
      address:           lead.address,
      lat:               lead.lat,
      lng:               lead.lng,
      phone:             lead.phone || null,
      websiteUrl:        lead.websiteUrl || null,
      siteQuality:       lead.siteQuality,
      leadScore:         lead.leadScore,
      foursquareUrl:     lead.foursquareUrl || null,
      socialMedia:       lead.socialMedia || {},
      discoveredEmail:   null,
      status:            'Not Contacted',
      contactedAt:       null,
      notes:             [],
      generatedMessages: {},
      dateAdded:         new Date().toISOString(),
    };

    const docRef = await addDoc(collection(db, 'leads'), docData);
    setAddedIds(prev => new Set([...prev, lead.fsqId]));
    showToast(`${lead.businessName} added to pipeline`);

    const q = new URLSearchParams();
    if (lead.fsqId && !lead.fsqId.startsWith('osm-') && !lead.fsqId.startsWith('here:')) q.set('fsqId', lead.fsqId);
    if (lead.websiteUrl)            q.set('url',      lead.websiteUrl);
    if (lead.socialMedia?.facebook) q.set('facebook', lead.socialMedia.facebook);
    if (lead.businessName)          q.set('name',     lead.businessName);
    if (lead.city)                  q.set('city',     lead.city);
    if ([...q.keys()].length) fetch(api(`/api/fetch-email?${q}`))
      .then(r => r.json())
      .then(({ email, guessed, socials, phone }) => {
        const upd = {};
        if (email) { upd.discoveredEmail = email; upd.emailGuessed = !!guessed; }
        if (socials) {
          Object.entries(socials).forEach(([k, v]) => { if (v) upd[`socialMedia.${k}`] = v; });
        }
        if (phone) upd.discoveredPhone = phone;
        if (Object.keys(upd).length) updateDoc(doc(db, 'leads', docRef.id), upd).catch(() => {});
      })
      .catch(() => {});
  }

  const displayResults = results.filter(b => {
    const anyChecked = requirePhone || requireSocial || requireEmail;
    if (!anyChecked) return true;
    if (requirePhone  && b.phone) return true;
    if (requireSocial && Object.values(b.socialMedia || {}).some(Boolean)) return true;
    if (requireEmail  && b.discoveredEmail) return true;
    return false;
  });

  const sorted = [...displayResults].sort((a, b) => {
    if (sortOrder === 'score') return b.leadScore - a.leadScore;
    return QUALITY_ORDER[a.siteQuality] - QUALITY_ORDER[b.siteQuality] || b.leadScore - a.leadScore;
  });

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <h2 className="text-2xl font-bold text-slate-800 mb-1">Find Leads</h2>
      <p className="text-slate-500 text-sm mb-6">
        Search for local businesses with weak or no websites. Add rows to search multiple business types at once — results are combined and deduplicated.
      </p>

      {/* Saved search chips */}
      {savedSearches.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-slate-400 shrink-0">Saved:</span>
          {savedSearches.map((s, i) => (
            <div key={i} className="flex items-center gap-0.5 bg-slate-100 hover:bg-slate-200 rounded-full pl-3 pr-1 py-1 transition-colors">
              <button
                onClick={() => setSearches([{ term: s.term, city: s.city, state: s.state }])}
                className="text-xs text-slate-700 hover:text-teal-600 transition-colors"
              >
                {s.term}{s.city ? ` · ${s.city}` : ''}{s.state ? `, ${s.state}` : ''}
              </button>
              <button
                onClick={() => removeSavedSearch(i)}
                className="ml-1 w-4 h-4 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-100 flex items-center justify-center text-xs leading-none transition-colors"
                aria-label="Remove saved search"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Datalist for business type autocomplete */}
      <datalist id="biz-types">
        {COMMON_BUSINESS_TYPES.map(t => <option key={t} value={t} />)}
      </datalist>

      {/* Search builder */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <div className="space-y-3 mb-4">
          {searches.map((s, i) => (
            <div key={i} className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:items-center">
              <input
                type="text"
                list="biz-types"
                placeholder="Business type (e.g. nail salon)"
                value={s.term}
                onChange={e => updateRow(i, 'term', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runSearches()}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
              />

              <SplitCombo
                value={s.state}
                onChange={val => {
                  const v = val.toUpperCase().slice(0, 2);
                  updateRow(i, 'state', v);
                  if (!CITIES_BY_STATE[v]) updateRow(i, 'city', '');
                }}
                options={STATES}
                placeholder="State"
                onEnter={runSearches}
                maxLength={2}
                className="sm:w-32"
                inputClassName="uppercase"
              />

              <SplitCombo
                value={s.city}
                onChange={val => updateRow(i, 'city', val)}
                options={CITIES_BY_STATE[s.state] || []}
                placeholder="City (optional)"
                onEnter={runSearches}
                className="flex-1"
              />

              <button
                onClick={() => saveSearch(s)}
                disabled={!s.term.trim()}
                title="Save this search"
                className="text-slate-400 hover:text-teal-500 disabled:opacity-20 text-base px-1 transition-colors"
                aria-label="Save search"
              >
                ☆
              </button>

              {searches.length > 1 && (
                <button
                  onClick={() => removeRow(i)}
                  className="text-slate-400 hover:text-red-500 px-1 text-lg leading-none"
                  aria-label="Remove search"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={addRow}
            className="text-sm text-teal-600 hover:text-teal-700 font-medium"
          >
            + Add another search
          </button>
          {[
            { label: 'Has Phone',  state: requirePhone,  set: setRequirePhone },
            { label: 'Has Social', state: requireSocial, set: setRequireSocial },
            { label: 'Has Email',  state: requireEmail,  set: setRequireEmail },
          ].map(({ label, state, set }) => (
            <label key={label} className="flex items-center gap-1.5 cursor-pointer select-none text-sm text-slate-600">
              <input type="checkbox" checked={state} onChange={e => set(e.target.checked)} className="w-4 h-4 rounded accent-teal-600" />
              {label}
            </label>
          ))}
          <button
            onClick={runSearches}
            disabled={loading}
            className="ml-auto bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg px-6 py-2 text-sm font-medium transition-colors"
          >
            {loading ? 'Searching…' : 'Run Search'}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {/* US Bulk Scan */}
      <div className="bg-white rounded-xl border border-slate-200 mb-6 overflow-hidden">
        <button
          onClick={() => setShowUSScan(p => !p)}
          className="flex items-center justify-between w-full px-6 py-4 text-left"
        >
          <div>
            <p className="font-semibold text-slate-700 text-sm">US Bulk Scan</p>
            <p className="text-xs text-slate-400">Search all 50 states and auto-add matching leads to pipeline</p>
          </div>
          <span className="text-slate-400 text-xs">{showUSScan ? '▲' : '▼'}</span>
        </button>

        {showUSScan && (
          <div className="px-6 pb-6 border-t border-slate-100 pt-4 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                list="biz-types"
                placeholder="Business type (e.g. nail salon)"
                value={scanTerm}
                onChange={e => setScanTerm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !scanning && runUSScan()}
                disabled={scanning}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-slate-50"
              />
              <select
                value={scanMinScore}
                onChange={e => setScanMinScore(Number(e.target.value))}
                disabled={scanning}
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-slate-50"
              >
                <option value={5}>Score 5 only — No website</option>
                <option value={4}>Score 4+ — No website or free builder</option>
                <option value={3}>Score 3+ — Includes DIY builders</option>
                <option value={2}>Score 2+ — Anything below custom .com</option>
              </select>
              {scanning ? (
                <button
                  onClick={() => { scanAbortRef.current = true; }}
                  className="bg-red-500 hover:bg-red-600 text-white rounded-lg px-5 py-2 text-sm font-medium transition-colors"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={runUSScan}
                  disabled={!scanTerm.trim()}
                  className="bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 text-white rounded-lg px-5 py-2 text-sm font-medium transition-colors"
                >
                  Scan All US
                </button>
              )}
            </div>

            {/* Progress */}
            {scanProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {scanProgress.complete
                      ? `Complete — ${scanProgress.found} score ${scanMinScore}+ leads found across all states`
                      : `Scanning ${scanProgress.state}… (${scanProgress.done + 1}/${scanProgress.total})`}
                  </span>
                  <span className="font-medium text-teal-600">{scanProgress.found} found</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div
                    className="bg-teal-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${(scanProgress.done / scanProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Results + bulk add */}
            {scanResults.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between bg-teal-50 border border-teal-200 rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-teal-800">
                      {scanResults.length} score {scanMinScore}+ leads ready
                    </p>
                    <p className="text-xs text-teal-600">None of these are already in your pipeline</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowScanPreview(p => !p)}
                      className="border border-teal-300 hover:border-teal-400 text-teal-700 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                    >
                      {showScanPreview ? 'Hide' : 'Preview'}
                    </button>
                    <button
                      onClick={bulkAddToFirestore}
                      disabled={bulkAdding}
                      className="bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap"
                    >
                      {bulkAdding
                        ? `Adding ${bulkAddedCount}/${scanResults.length}…`
                        : `Add All ${scanResults.length}`}
                    </button>
                  </div>
                </div>

                {showScanPreview && (
                  <div className="max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
                    {scanResults.map(lead => (
                      <div key={lead.fsqId} className="flex items-center gap-3 px-4 py-2">
                        <LeadScoreBadge score={lead.leadScore} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{lead.businessName}</p>
                          <p className="text-xs text-slate-500">{lead.city}</p>
                        </div>
                        {lead.websiteUrl ? (
                          <span className="text-xs text-slate-400 truncate max-w-[140px] hidden sm:block">
                            {lead.websiteUrl.replace(/^https?:\/\//, '')}
                          </span>
                        ) : (
                          <span className="text-xs text-red-400 font-medium">No site</span>
                        )}
                        <SiteQualityBadge quality={lead.siteQuality} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Fallback banner */}
      {isFallback && results.length > 0 && (
        <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-700">
          ⚠ Running on free OSM data — website URLs unavailable. Add your Foursquare key to <code className="font-mono bg-amber-100 px-1 rounded">.env</code> for full data.
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium">{displayResults.length}</span>
              {displayResults.length < results.length && (
                <span className="text-slate-400"> of {results.length}</span>
              )}
              {' '}results ·{' '}
              <span className="text-teal-600 font-medium">{addedIds.size}</span> added to pipeline
              {enrichingTotal > 0 && (
                <span className="ml-3 text-slate-400">· finding socials {enrichingDone}/{enrichingTotal}</span>
              )}
            </p>
          </div>

          <div className="space-y-3">
            {sorted.map(lead => (
              <LeadCard
                key={lead.fsqId}
                lead={lead}
                added={addedIds.has(lead.fsqId) || existingFsqIds.has(lead.fsqId)}
                onAdd={() => addToPipeline(lead)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LeadCard({ lead, added, onAdd }) {
  const [popping, setPopping] = useState(false);

  function handleAdd() {
    if (added) return;
    setPopping(true);
    setTimeout(() => setPopping(false), 300);
    onAdd();
  }

  return (
    <div
      className={`bg-white rounded-xl border p-4 transition-all duration-300 ${
        added ? 'border-teal-400 bg-teal-50/60 animate-flash' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-start gap-3">
        <LeadScoreBadge score={lead.leadScore} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-start gap-2 mb-1">
            <h3 className="font-semibold text-slate-800 text-sm">{lead.businessName}</h3>
            <SiteQualityBadge quality={lead.siteQuality} />
          </div>
          <p className="text-xs text-slate-500 mb-2">{lead.businessType} · {lead.address}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {lead.phone && <span>{lead.phone}</span>}
            {lead.websiteUrl ? (
              <a href={lead.websiteUrl} target="_blank" rel="noreferrer"
                className="text-blue-600 hover:underline truncate max-w-xs">
                {lead.websiteUrl}
              </a>
            ) : (
              <span className="text-red-500 font-medium">No website</span>
            )}
            {lead.foursquareUrl && (
              <a href={lead.foursquareUrl} target="_blank" rel="noreferrer"
                className="text-slate-400 hover:text-slate-600">
                Foursquare ↗
              </a>
            )}
            {lead.socialMedia?.instagram && <a href={lead.socialMedia.instagram} target="_blank" rel="noreferrer" className="text-pink-500 hover:text-pink-700">Instagram ↗</a>}
            {lead.socialMedia?.facebook  && <a href={lead.socialMedia.facebook}  target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700">Facebook ↗</a>}
            {lead.socialMedia?.twitter   && <a href={lead.socialMedia.twitter}   target="_blank" rel="noreferrer" className="text-sky-500 hover:text-sky-700">X/Twitter ↗</a>}
            {lead.socialMedia?.tiktok    && <a href={lead.socialMedia.tiktok}    target="_blank" rel="noreferrer" className="text-slate-800 hover:text-slate-600">TikTok ↗</a>}
            {lead.socialMedia?.snapchat  && <a href={lead.socialMedia.snapchat}  target="_blank" rel="noreferrer" className="text-yellow-500 hover:text-yellow-700">Snapchat ↗</a>}
            {lead.socialMedia?.youtube   && <a href={lead.socialMedia.youtube}   target="_blank" rel="noreferrer" className="text-red-500 hover:text-red-700">YouTube ↗</a>}
            {lead.socialMedia?.linkedin  && <a href={lead.socialMedia.linkedin}  target="_blank" rel="noreferrer" className="text-sky-700 hover:text-sky-900">LinkedIn ↗</a>}
            {lead.socialMedia?.whatsapp  && <a href={lead.socialMedia.whatsapp}  target="_blank" rel="noreferrer" className="text-green-500 hover:text-green-700">WhatsApp ↗</a>}
            {lead.socialMedia?.pinterest && <a href={lead.socialMedia.pinterest} target="_blank" rel="noreferrer" className="text-red-500 hover:text-red-700">Pinterest ↗</a>}
            {lead.socialMedia?.threads   && <a href={lead.socialMedia.threads}   target="_blank" rel="noreferrer" className="text-slate-600 hover:text-slate-800">Threads ↗</a>}
          </div>
        </div>
      </div>

      <div className="flex justify-end mt-3">
        <button
          onClick={handleAdd}
          disabled={added}
          className={`py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
            added
              ? 'bg-teal-500 text-white cursor-default'
              : 'bg-slate-800 hover:bg-slate-700 active:scale-95 text-white'
          } ${popping ? 'animate-pop' : ''}`}
        >
          {added ? '✓ Added' : 'Add to Pipeline'}
        </button>
      </div>
    </div>
  );
}

function SplitCombo({ value, onChange, options, placeholder, onEnter, maxLength, className = '', inputClassName = '' }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('filter');
  const ref = useRef(null);

  const shown = mode === 'all'
    ? options
    : options.filter(o => o.toLowerCase().includes(value.toLowerCase()));

  useEffect(() => {
    function onDown(e) {
      if (!ref.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div ref={ref} className={`relative flex rounded-lg border border-slate-200 focus-within:ring-2 focus-within:ring-teal-400 bg-white ${className}`}>
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onFocus={() => { setMode('all'); setOpen(true); }}
        onChange={e => {
          onChange(e.target.value);
          setMode('filter');
          setOpen(true);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setOpen(false); onEnter?.(); }
          if (e.key === 'Escape') setOpen(false);
        }}
        className={`flex-1 min-w-0 bg-transparent px-3 py-2 text-sm focus:outline-none ${inputClassName}`}
      />

      <div className="flex items-stretch shrink-0">
        <div className="w-px bg-slate-200 my-1.5" />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => { setMode('all'); setOpen(o => !o); }}
          className="w-6 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-r-lg transition-colors"
        >
          <svg className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {open && shown.length > 0 && (
        <ul className="absolute top-[calc(100%+4px)] left-0 right-0 z-50 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto text-sm">
          {shown.map(opt => (
            <li
              key={opt}
              onMouseDown={e => { e.preventDefault(); onChange(opt); setOpen(false); }}
              className={`px-3 py-1.5 cursor-pointer hover:bg-teal-50 ${opt === value ? 'text-teal-600 font-medium bg-teal-50/50' : 'text-slate-700'}`}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
