import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLeads } from '../hooks/useLeads';
import { daysSince, formatDate } from '../lib/utils';
import SiteQualityBadge from '../components/SiteQualityBadge';
import LeadScoreBadge from '../components/LeadScoreBadge';
import LeadMap from '../components/LeadMap';

export default function Dashboard() {
  const { leads, loading } = useLeads();
  const navigate = useNavigate();
  const [quickTerm, setQuickTerm] = useState('');
  const [quickCity, setQuickCity] = useState('');
  const [quickState, setQuickState] = useState('');

  const stats = {
    total:         leads.length,
    noWebsite:     leads.filter(l => l.siteQuality === 'none').length,
    weakSite:      leads.filter(l => l.siteQuality === 'weak').length,
    messaged:      leads.filter(l => l.status === 'Messaged').length,
    replied:       leads.filter(l => l.status === 'Replied' || l.status === 'Meeting Set').length,
    needsFollowUp: leads.filter(l => l.status === 'Messaged' && l.contactedAt && daysSince(l.contactedAt) >= 5).length,
  };

  const conversionRate =
    stats.messaged > 0 ? ((stats.replied / stats.messaged) * 100).toFixed(1) : '0.0';

  const recentLeads = leads.slice(0, 5);

  function handleQuickSearch(e) {
    e.preventDefault();
    navigate('/find', { state: { prefillTerm: quickTerm, prefillCity: quickCity, prefillState: quickState } });
  }

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Dashboard</h2>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {[
          { label: 'Total Leads',  value: stats.total,          color: 'text-slate-800' },
          { label: 'No Website',   value: stats.noWebsite,      color: 'text-red-600' },
          { label: 'Weak Site',    value: stats.weakSite,       color: 'text-amber-600' },
          { label: 'Messaged',     value: stats.messaged,       color: 'text-blue-600' },
          { label: 'Replied',      value: stats.replied,        color: 'text-emerald-600' },
          { label: 'Conversion',   value: `${conversionRate}%`, color: 'text-purple-600' },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500 uppercase tracking-wide font-medium">{stat.label}</p>
            <p className={`text-2xl font-bold font-mono mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Follow-up alert */}
      {stats.needsFollowUp > 0 && (
        <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <span className="text-amber-600 font-semibold text-sm">
            ⚠ {stats.needsFollowUp} lead{stats.needsFollowUp > 1 ? 's' : ''} need{stats.needsFollowUp === 1 ? 's' : ''} follow-up
          </span>
          <button
            onClick={() => navigate('/pipeline')}
            className="text-sm text-amber-700 underline underline-offset-2"
          >
            View in Pipeline →
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Mini Map */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-700 text-sm">Lead Coverage Map</h3>
            <button onClick={() => navigate('/map')} className="text-xs text-teal-600 hover:underline">
              Full map →
            </button>
          </div>
          <div style={{ height: 260 }}>
            {!loading && <LeadMap leads={leads} height="260px" mini />}
          </div>
        </div>

        {/* Quick Search */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 flex flex-col gap-4">
          <h3 className="font-semibold text-slate-700 text-sm">Quick Lead Search</h3>
          <form onSubmit={handleQuickSearch} className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Business type (e.g. nail salon)"
              value={quickTerm}
              onChange={e => setQuickTerm(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="City (e.g. Frisco)"
                value={quickCity}
                onChange={e => setQuickCity(e.target.value)}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <input
                type="text"
                placeholder="TX"
                value={quickState}
                onChange={e => setQuickState(e.target.value.toUpperCase())}
                maxLength={2}
                className="w-16 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 uppercase"
              />
            </div>
            <button
              type="submit"
              className="bg-teal-600 hover:bg-teal-700 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              Find Leads →
            </button>
          </form>
          <button
            onClick={() => navigate('/find')}
            className="text-xs text-slate-400 hover:text-slate-600 text-left"
          >
            Open bulk search mode →
          </button>
        </div>
      </div>

      {/* Recent Leads */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-700 text-sm">Recent Leads</h3>
          <button onClick={() => navigate('/pipeline')} className="text-xs text-teal-600 hover:underline">
            View all →
          </button>
        </div>

        {loading ? (
          <p className="px-6 py-8 text-slate-400 text-sm">Loading…</p>
        ) : recentLeads.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-slate-400 text-sm">No leads yet.</p>
            <button
              onClick={() => navigate('/find')}
              className="mt-2 text-teal-600 text-sm hover:underline"
            >
              Find your first leads →
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentLeads.map(lead => (
              <div key={lead.id} className="px-6 py-3 flex items-center gap-4">
                <LeadScoreBadge score={lead.leadScore} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{lead.businessName}</p>
                  <p className="text-xs text-slate-500 truncate">{lead.businessType} · {lead.city}</p>
                </div>
                <SiteQualityBadge quality={lead.siteQuality} />
                <p className="text-xs text-slate-400 whitespace-nowrap hidden sm:block">
                  {formatDate(lead.dateAdded)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
