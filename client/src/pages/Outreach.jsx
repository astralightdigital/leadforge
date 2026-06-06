import { useState, useMemo } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useLeads } from '../hooks/useLeads';
import { showToast } from '../components/Toast';
import SiteQualityBadge from '../components/SiteQualityBadge';

const STATUSES = [
  'Not Contacted', 'Messaged', 'Replied',
  'Meeting Set', 'Closed Won', 'Closed Lost', 'Custom',
];

export default function Outreach() {
  const { leads, loading } = useLeads();
  const [search, setSearch]           = useState('');
  const [cityFilter, setCityFilter]   = useState('');
  const [typeFilter, setTypeFilter]   = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = useMemo(() => {
    return leads.filter(l => {
      if (search       && !l.businessName?.toLowerCase().includes(search.toLowerCase())) return false;
      if (cityFilter   && !l.city?.toLowerCase().includes(cityFilter.toLowerCase())) return false;
      if (typeFilter   && !l.businessType?.toLowerCase().includes(typeFilter.toLowerCase())) return false;
      if (statusFilter && l.status !== statusFilter) return false;
      return true;
    });
  }, [leads, search, cityFilter, typeFilter, statusFilter]);

  async function markMessaged(leadId) {
    await updateDoc(doc(db, 'leads', leadId), {
      status:      'Messaged',
      contactedAt: new Date().toISOString(),
    });
    showToast('Marked as Messaged');
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>;

  const hasFilters = search || cityFilter || typeFilter || statusFilter;

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <h2 className="text-2xl font-bold text-slate-800 mb-1">Outreach</h2>
      <p className="text-slate-500 text-sm mb-6">
        Quick-access contact links for leads in your pipeline.
      </p>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by business name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />
        <input
          type="text"
          placeholder="Filter by city…"
          value={cityFilter}
          onChange={e => setCityFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />
        <input
          type="text"
          placeholder="Filter by type…"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-400"
        >
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setCityFilter(''); setTypeFilter(''); setStatusFilter(''); }}
            className="text-sm text-red-400 hover:text-red-600"
          >
            Clear
          </button>
        )}
      </div>

      <p className="text-xs text-slate-400 mb-4">
        {filtered.length} of {leads.length} lead{leads.length !== 1 ? 's' : ''}
      </p>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400 text-sm">
          {hasFilters
            ? 'No leads match your filters.'
            : 'No leads in pipeline yet — add some from Find Leads.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(lead => (
            <OutreachCard key={lead.id} lead={lead} onMarkMessaged={() => markMessaged(lead.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function OutreachCard({ lead, onMarkMessaged }) {
  const emailBody = lead.generatedMessages?.email || '';
  const igMessage = lead.generatedMessages?.instagram || '';
  const sm        = lead.socialMedia || {};

  const gmailHref = lead.discoveredEmail
    ? `mailto:${lead.discoveredEmail}?subject=${encodeURIComponent('Quick question about your website')}&body=${encodeURIComponent(emailBody)}`
    : null;

  const igHref = sm.instagram
    ? sm.instagram
    : `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(lead.businessName)}`;

  const fbHref = sm.facebook
    ? sm.facebook
    : `https://www.facebook.com/search/top/?q=${encodeURIComponent([lead.businessName, lead.city].filter(Boolean).join(' '))}`;

  const yelpHref = `https://www.yelp.com/search?find_desc=${encodeURIComponent(lead.businessName)}&find_loc=${encodeURIComponent(lead.city || '')}`;

  const alreadyMessaged = lead.status === 'Messaged' || lead.status === 'Replied' || lead.status === 'Meeting Set' || lead.status === 'Closed Won';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <h3 className="font-semibold text-slate-800 text-sm">{lead.businessName}</h3>
            <SiteQualityBadge quality={lead.siteQuality} />
            <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">{lead.status}</span>
          </div>
          <p className="text-xs text-slate-500">
            {[lead.businessType, lead.city].filter(Boolean).join(' · ')}
          </p>
          {lead.discoveredEmail && (
            <p className="text-xs text-teal-600 mt-0.5">{lead.discoveredEmail}</p>
          )}
          {lead.phone && (
            <p className="text-xs text-slate-500 mt-0.5">{lead.phone}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {gmailHref ? (
            <a
              href={gmailHref}
              className="inline-flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              ✉ Gmail
            </a>
          ) : (
            <span className="inline-flex items-center bg-slate-50 text-slate-400 border border-slate-200 rounded-lg px-3 py-1.5 text-xs cursor-not-allowed select-none">
              ✉ No Email
            </span>
          )}

          <a
            href={igHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          >
            📸 {sm.instagram ? 'Instagram' : 'Find on IG'}
          </a>

          <a
            href={fbHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          >
            👥 {sm.facebook ? 'Facebook' : 'Find on FB'}
          </a>

          {sm.linkedin && (
            <a
              href={sm.linkedin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              LinkedIn ↗
            </a>
          )}

          {sm.whatsapp && (
            <a
              href={sm.whatsapp}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              WhatsApp ↗
            </a>
          )}

          {sm.tiktok && (
            <a
              href={sm.tiktok}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              TikTok ↗
            </a>
          )}

          {sm.pinterest && (
            <a
              href={sm.pinterest}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Pinterest ↗
            </a>
          )}

          {sm.threads && (
            <a
              href={sm.threads}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Threads ↗
            </a>
          )}

          <a
            href={yelpHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          >
            ⭐ Yelp
          </a>

          {!alreadyMessaged && (
            <button
              onClick={onMarkMessaged}
              className="inline-flex items-center gap-1.5 bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              ✓ Mark Messaged
            </button>
          )}
        </div>
      </div>

      {igMessage && (
        <div className="mt-3 bg-purple-50 border border-purple-100 rounded-lg p-2.5">
          <p className="text-xs font-medium text-purple-600 mb-1">Instagram DM Template</p>
          <p className="text-xs text-slate-700 line-clamp-2">{igMessage}</p>
        </div>
      )}
    </div>
  );
}
