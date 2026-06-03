import { useLeads } from '../hooks/useLeads';
import LeadMap from '../components/LeadMap';

const LEGEND = [
  { color: '#ef4444', label: 'Not Contacted' },
  { color: '#f59e0b', label: 'Messaged' },
  { color: '#22c55e', label: 'Replied / Meeting Set' },
  { color: '#3b82f6', label: 'Closed Won' },
  { color: '#6b7280', label: 'Closed Lost' },
];

export default function MapView() {
  const { leads, loading } = useLeads();
  const pinned = leads.filter(l => l.lat != null && l.lng != null);

  return (
    <div className="relative" style={{ height: '100vh' }}>
      {/* Map fills the full column */}
      {!loading && <LeadMap leads={leads} height="100vh" />}

      {/* Floating info panel */}
      <div className="absolute top-4 left-4 z-[1000] bg-slate-900/90 backdrop-blur-sm rounded-xl p-4 shadow-xl pointer-events-none">
        <h2 className="text-white font-bold text-sm mb-1">Lead Map</h2>
        <p className="text-slate-400 text-xs mb-3">{pinned.length} pinned location{pinned.length !== 1 ? 's' : ''}</p>
        <div className="space-y-1.5">
          {LEGEND.map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: color }}
              />
              <span className="text-slate-300 text-xs">{label}</span>
            </div>
          ))}
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
