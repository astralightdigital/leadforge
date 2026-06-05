import { useState } from 'react';
import { useLeads } from '../hooks/useLeads';
import LeadMap from '../components/LeadMap';

const LEGEND = [
  { color: '#ef4444', label: 'Not Contacted' },
  { color: '#f59e0b', label: 'Messaged' },
  { color: '#22c55e', label: 'Replied / Meeting Set' },
  { color: '#3b82f6', label: 'Closed Won' },
  { color: '#6b7280', label: 'Closed Lost' },
  { color: '#a855f7', label: 'Custom' },
];

const SCORES = [
  { score: 5, label: 'No site',      color: '#dc2626' },
  { score: 4, label: 'Free builder', color: '#ea580c' },
  { score: 3, label: 'DIY builder',  color: '#d97706' },
  { score: 2, label: 'Non-.com',     color: '#2563eb' },
  { score: 1, label: 'Has site',     color: '#94a3b8' },
];

const ALL_RATINGS = new Set([1, 2, 3, 4, 5]);

export default function MapView() {
  const { leads, loading } = useLeads();
  const [showLegend, setShowLegend]   = useState(false);
  const [showRating, setShowRating]   = useState(false);
  const [activeRatings, setActiveRatings] = useState(new Set(ALL_RATINGS));

  function toggleRating(score) {
    setActiveRatings(prev => {
      const next = new Set(prev);
      next.has(score) ? next.delete(score) : next.add(score);
      return next;
    });
  }

  const allPinned     = leads.filter(l => l.lat != null && l.lng != null);
  const isFiltered    = activeRatings.size < 5;
  const visibleLeads  = isFiltered ? leads.filter(l => activeRatings.has(l.leadScore)) : leads;
  const visiblePinned = visibleLeads.filter(l => l.lat != null && l.lng != null);

  return (
    <div className="relative h-[calc(100vh-4rem)] md:h-screen">
      {!loading && <LeadMap leads={visibleLeads} height="100%" mini={false} />}

      {/* Floating control panel */}
      <div className="absolute top-3 left-3 z-[1000] bg-slate-900/90 backdrop-blur-sm rounded-xl shadow-xl overflow-hidden min-w-[170px]">

        {/* Header */}
        <div className="px-4 py-3">
          <p className="text-white font-bold text-sm leading-tight">Lead Map</p>
          <p className="text-slate-400 text-xs">
            {visiblePinned.length}{isFiltered ? ` of ${allPinned.length}` : ''} pin{allPinned.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Key section */}
        <div className="border-t border-slate-700/60">
          <button
            onClick={() => setShowLegend(prev => !prev)}
            className="flex items-center justify-between w-full px-4 py-2.5 text-left"
          >
            <span className="text-slate-300 text-xs font-medium">Key</span>
            <span className="text-slate-400 text-xs">{showLegend ? '▲' : '▼'}</span>
          </button>
          {showLegend && (
            <div className="px-4 pb-3 space-y-1.5">
              {LEGEND.map(({ color, label }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-slate-300 text-xs">{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Rating filter section */}
        <div className="border-t border-slate-700/60">
          <button
            onClick={() => setShowRating(prev => !prev)}
            className="flex items-center justify-between w-full px-4 py-2.5 text-left"
          >
            <span className="text-slate-300 text-xs font-medium">
              Rating{isFiltered ? ` (${activeRatings.size})` : ''}
            </span>
            <span className="text-slate-400 text-xs">{showRating ? '▲' : '▼'}</span>
          </button>
          {showRating && (
            <div className="px-4 pb-3 space-y-1.5">
              {SCORES.map(({ score, label, color }) => (
                <label key={score} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={activeRatings.has(score)}
                    onChange={() => toggleRating(score)}
                    className="w-3.5 h-3.5 rounded accent-teal-500 cursor-pointer"
                  />
                  <span
                    className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-[10px] text-white"
                    style={{ background: color }}
                  >
                    {score}
                  </span>
                  <span className="text-slate-300 text-xs group-hover:text-white transition-colors">{label}</span>
                </label>
              ))}
              {isFiltered && (
                <button
                  onClick={() => setActiveRatings(new Set(ALL_RATINGS))}
                  className="text-teal-400 text-[11px] hover:text-teal-300 transition-colors mt-0.5"
                >
                  Show all
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900 text-slate-400 text-sm">
          Loading map…
        </div>
      )}
    </div>
  );
}
