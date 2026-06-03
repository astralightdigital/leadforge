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

export default function FindLeads() {
  const location = useLocation();
  const { leads } = useLeads();
  const existingFsqIds = useMemo(() => new Set(leads.map(l => l.fsqId).filter(Boolean)), [leads]);
  const [searches, setSearches] = useState([{ term: '', city: '', state: '' }]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [addedIds, setAddedIds] = useState(new Set());
  const [sortOrder, setSortOrder] = useState('quality');
  const [isFallback, setIsFallback] = useState(false);

  // Pre-fill from dashboard quick search
  useEffect(() => {
    if (location.state?.prefillTerm || location.state?.prefillCity) {
      setSearches([{
        term: location.state.prefillTerm || '',
        city: location.state.prefillCity || '',
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

      // Deduplicate across searches by name + address
      const seen = new Set();
      const deduped = allResults.flat().filter(b => {
        const key = `${b.businessName}|${b.address}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Enrich with computed fields
      const enriched = deduped.map(b => {
        const quality = getSiteQuality(b.websiteUrl);
        return {
          ...b,
          businessType: b.searchTerm || b.businessType,
          phone: formatPhone(b.phone),
          siteQuality: quality,
          leadScore: calculateLeadScore({
            websiteUrl: b.websiteUrl,
            reviewCount: b.reviewCount || 0,
            rating: b.rating || 0,
            phone: b.phone,
          }),
        };
      });

      setResults(enriched);
    } catch (err) {
      setError(`Search failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function addToPipeline(lead) {
    if (addedIds.has(lead.fsqId) || existingFsqIds.has(lead.fsqId)) return;
    const docData = {
      fsqId:            lead.fsqId,
      businessName:     lead.businessName,
      businessType:     lead.businessType,
      city:             lead.city,
      address:          lead.address,
      lat:              lead.lat,
      lng:              lead.lng,
      phone:            lead.phone || null,
      websiteUrl:       lead.websiteUrl || null,
      siteQuality:      lead.siteQuality,
      leadScore:        lead.leadScore,
      foursquareUrl:    lead.foursquareUrl || null,
      discoveredEmail:  null,
      status:           'Not Contacted',
      contactedAt:      null,
      notes:            [],
      generatedMessages: {},
      dateAdded:        new Date().toISOString(),
    };

    const docRef = await addDoc(collection(db, 'leads'), docData);
    setAddedIds(prev => new Set([...prev, lead.fsqId]));
    showToast(`${lead.businessName} added to pipeline`);

    // Background email extraction
    if (lead.websiteUrl) {
      fetch(api(`/api/fetch-email?url=${encodeURIComponent(lead.websiteUrl)}`))
        .then(r => r.json())
        .then(({ email }) => {
          if (email) {
            updateDoc(doc(db, 'leads', docRef.id), { discoveredEmail: email }).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }

  const sorted = [...results].sort((a, b) => {
    if (sortOrder === 'score') return b.leadScore - a.leadScore;
    return QUALITY_ORDER[a.siteQuality] - QUALITY_ORDER[b.siteQuality] || b.leadScore - a.leadScore;
  });

  const validCount = searches.filter(s => s.term.trim() && s.state.trim()).length;

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <h2 className="text-2xl font-bold text-slate-800 mb-1">Find Leads</h2>
      <p className="text-slate-500 text-sm mb-6">
        Search for local businesses with weak or no websites. Queue multiple searches to run them simultaneously.
      </p>

      {/* Search builder */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <div className="space-y-3 mb-4">
          {searches.map((s, i) => (
            <div key={i} className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:items-center">
              <input
                type="text"
                placeholder="Business type (e.g. nail salon)"
                value={s.term}
                onChange={e => updateRow(i, 'term', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runSearches()}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
              />

              {/* State */}
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

              {/* City */}
              <SplitCombo
                value={s.city}
                onChange={val => updateRow(i, 'city', val)}
                options={CITIES_BY_STATE[s.state] || []}
                placeholder="City (optional)"
                onEnter={runSearches}
                className="flex-1"
              />

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

        <div className="flex items-center gap-4">
          <button
            onClick={addRow}
            className="text-sm text-teal-600 hover:text-teal-700 font-medium"
          >
            + Add another search
          </button>
          <button
            onClick={runSearches}
            disabled={loading || validCount === 0}
            className="ml-auto bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg px-6 py-2 text-sm font-medium transition-colors"
          >
            {loading
              ? 'Searching…'
              : `Run ${validCount} Search${validCount !== 1 ? 'es' : ''}`}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {/* Results */}
      {isFallback && results.length > 0 && (
        <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-700">
          ⚠ Running on free OSM data — website URLs unavailable. Add your Foursquare key to <code className="font-mono bg-amber-100 px-1 rounded">.env</code> for full data.
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium">{results.length}</span> results ·{' '}
              <span className="text-teal-600 font-medium">{addedIds.size}</span> added to pipeline
            </p>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-slate-500 mr-1">Sort:</span>
              {['quality', 'score'].map(opt => (
                <button
                  key={opt}
                  onClick={() => setSortOrder(opt)}
                  className={`px-2.5 py-1 rounded-md capitalize transition-colors ${
                    sortOrder === opt
                      ? 'bg-slate-800 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {opt === 'quality' ? 'Site quality' : 'Lead score'}
                </button>
              ))}
            </div>
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
          </div>
        </div>
      </div>

      <button
        onClick={handleAdd}
        disabled={added}
        className={`mt-3 w-full sm:w-auto sm:float-right py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
          added
            ? 'bg-teal-500 text-white cursor-default'
            : 'bg-slate-800 hover:bg-slate-700 active:scale-95 text-white'
        } ${popping ? 'animate-pop' : ''}`}
      >
        {added ? '✓ Added' : 'Add to Pipeline'}
      </button>
    </div>
  );
}

function SplitCombo({ value, onChange, options, placeholder, onEnter, maxLength, className = '', inputClassName = '' }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('filter'); // 'filter' = type-to-search | 'all' = arrow opened
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
      {/* Text / search area */}
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
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

      {/* Divider + arrow */}
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

      {/* Dropdown list */}
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
