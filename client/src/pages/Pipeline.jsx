import { useState } from 'react';
import { doc, updateDoc, deleteDoc, arrayUnion, collection, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { useLeads } from '../hooks/useLeads';
import { daysSince, formatDate, exportToCSV, copyForSheets } from '../lib/utils';
import { getIssueDescription, getSiteQuality, calculateLeadScore } from '../lib/scoring';
import { api } from '../lib/api';
import SiteQualityBadge from '../components/SiteQualityBadge';
import LeadScoreBadge from '../components/LeadScoreBadge';
import { showToast } from '../components/Toast';

const STATUSES = [
  'Not Contacted', 'Messaged', 'Replied',
  'Meeting Set', 'Closed Won', 'Closed Lost',
];

const MSG_TYPES = ['Instagram DM', 'Cold Email', 'Walk-in Talking Points'];

const SCORE_OPTIONS = [
  { score: 5, label: 'No site' },
  { score: 4, label: 'Free builder' },
  { score: 3, label: 'DIY builder' },
  { score: 2, label: 'Non-.com' },
  { score: 1, label: 'Has site' },
];

export default function Pipeline() {
  const { leads, loading } = useLeads();
  const [filters, setFilters] = useState({ status: '', quality: '', city: '', type: '', ratings: [], contact: [], contactSearch: '' });
  const [showRatingFilter, setShowRatingFilter]   = useState(false);
  const [showContactFilter, setShowContactFilter] = useState(false);
  const [sortBy, setSortBy]   = useState('dateAdded');
  const [sortDir, setSortDir] = useState('desc');
  const [expandedId, setExpandedId]     = useState(null);
  const [noteInputs, setNoteInputs]     = useState({});
  const [msgModal, setMsgModal]         = useState(null);
  const [copied, setCopied]             = useState(false);
  const [colModal, setColModal]         = useState(false);
  const [syncing, setSyncing]           = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);

  // ── Filtering ──────────────────────────────────────────────────────────────
  function toggleRating(score) {
    setFilters(f => {
      const next = f.ratings.includes(score)
        ? f.ratings.filter(r => r !== score)
        : [...f.ratings, score];
      return { ...f, ratings: next };
    });
  }

  const filtered = leads.filter(l => {
    if (filters.status  && l.status !== filters.status) return false;
    if (filters.quality && l.siteQuality !== filters.quality) return false;
    if (filters.city    && !l.city?.toLowerCase().includes(filters.city.toLowerCase())) return false;
    if (filters.type    && !l.businessType?.toLowerCase().includes(filters.type.toLowerCase())) return false;
    if (filters.ratings.length > 0 && !filters.ratings.includes(l.leadScore)) return false;
    if (filters.contactSearch) {
      const needle = filters.contactSearch.toLowerCase();
      const sm = l.socialMedia || {};
      const haystack = [
        l.discoveredEmail, l.phone,
        sm.instagram, sm.facebook, sm.twitter, sm.tiktok, sm.snapchat, sm.youtube,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.contact.length > 0) {
      const sm = l.socialMedia || {};
      const hasSocial = Object.values(sm).some(Boolean);
      const checks = {
        email:    !!l.discoveredEmail,
        phone:    !!l.phone,
        instagram:!!sm.instagram,
        facebook: !!sm.facebook,
        twitter:  !!sm.twitter,
        tiktok:   !!sm.tiktok,
        snapchat: !!sm.snapchat,
        youtube:  !!sm.youtube,
        noContact:!l.discoveredEmail && !l.phone && !hasSocial,
      };
      if (!filters.contact.some(c => checks[c])) return false;
    }
    return true;
  });

  // ── Sorting ────────────────────────────────────────────────────────────────
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'leadScore') return (b.leadScore - a.leadScore) * dir;
    if (sortBy === 'daysSince') {
      const dA = a.contactedAt ? daysSince(a.contactedAt) : -1;
      const dB = b.contactedAt ? daysSince(b.contactedAt) : -1;
      return (dB - dA) * dir;
    }
    // dateAdded default
    return (new Date(b.dateAdded) - new Date(a.dateAdded)) * dir;
  });

  function toggleSort(field) {
    if (sortBy === field) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('desc'); }
  }

  function sortIndicator(field) {
    if (sortBy !== field) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  // ── Firestore actions ──────────────────────────────────────────────────────
  async function updateStatus(id, status) {
    const update = { status };
    if (status === 'Messaged') update.contactedAt = new Date().toISOString();
    await updateDoc(doc(db, 'leads', id), update);
  }

  async function deleteLead(id) {
    await deleteDoc(doc(db, 'leads', id));
    if (expandedId === id) setExpandedId(null);
    showToast('Lead deleted', 'error');
  }

  async function fixJunkUrls() {
    setSyncing(true);
    setSyncProgress({ done: 0, total: '…' });

    try {
      const snapshot = await getDocs(collection(db, 'leads'));
      const toFix = [];

      snapshot.forEach(docSnap => {
        const url = docSnap.data().websiteUrl;
        if (!url) return;
        const low = url.toLowerCase();
        const bad = (
          (!url.startsWith('http://') && !url.startsWith('https://')) ||
          low.includes('amazonaws') || low.includes('hubbiz') ||
          low.includes('cloudfront') || low.includes('manta.com') ||
          low.includes('yellowpages') || low.includes('bizhub') ||
          low.includes('alignable') || low.includes('s3.') ||
          low.includes('.poi.place') || low.includes('poi.place') ||
          /\.(jpg|jpeg|png|gif|webp|svg|pdf)(\?|$)/.test(low)
        );
        if (bad) toFix.push(docSnap.id);
      });

      if (toFix.length > 0) {
        const b = writeBatch(db);
        toFix.forEach(id => b.update(doc(db, 'leads', id), { websiteUrl: null, siteQuality: 'none', leadScore: 5 }));
        await b.commit();
        showToast(`Fixed ${toFix.length} junk URLs`);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }

    setSyncing(false);
    setSyncProgress(null);
  }

  async function rescanEmails() {
    const toScan = leads.filter(l => !l.discoveredEmail);
    if (!toScan.length) { showToast('All leads already have emails'); return; }

    setSyncing(true);
    setSyncProgress({ done: 0, total: toScan.length });

    const BATCH = 4;
    for (let i = 0; i < toScan.length; i += BATCH) {
      await Promise.all(
        toScan.slice(i, i + BATCH).map(async lead => {
          try {
            const q = new URLSearchParams();
            if (lead.fsqId && !lead.fsqId.startsWith('osm-')) q.set('fsqId', lead.fsqId);
            if (lead.websiteUrl)            q.set('url',      lead.websiteUrl);
            if (lead.socialMedia?.facebook) q.set('facebook', lead.socialMedia.facebook);
            if (![...q.keys()].length) return;
            const res = await fetch(api(`/api/fetch-email?${q}`));
            const { email } = await res.json();
            if (email) await updateDoc(doc(db, 'leads', lead.id), { discoveredEmail: email, emailGuessed: !!guessed });
          } catch {}
        })
      );
      setSyncProgress({ done: Math.min(i + BATCH, toScan.length), total: toScan.length });
    }

    setSyncing(false);
    setSyncProgress(null);
    showToast('Email rescan complete');
  }

  async function syncSocials() {
    const toSync = leads.filter(l =>
      l.fsqId && !l.fsqId.startsWith('osm-') &&
      !Object.values(l.socialMedia || {}).some(Boolean)
    );
    if (!toSync.length) { showToast('All FSQ leads already synced'); return; }

    setSyncing(true);
    setSyncProgress({ done: 0, total: toSync.length });

    const BATCH = 5;
    for (let i = 0; i < toSync.length; i += BATCH) {
      await Promise.all(
        toSync.slice(i, i + BATCH).map(async lead => {
          try {
            const res  = await fetch(api(`/api/place-socials?fsqId=${lead.fsqId}`));
            const { socialMedia } = await res.json();
            if (Object.values(socialMedia).some(Boolean)) {
              await updateDoc(doc(db, 'leads', lead.id), { socialMedia });
            }
          } catch {}
        })
      );
      setSyncProgress({ done: Math.min(i + BATCH, toSync.length), total: toSync.length });
      if (i + BATCH < toSync.length) await new Promise(r => setTimeout(r, 350));
    }

    setSyncing(false);
    setSyncProgress(null);
    showToast('Social media sync complete');
  }

  async function addNote(leadId) {
    const text = (noteInputs[leadId] || '').trim();
    if (!text) return;
    await updateDoc(doc(db, 'leads', leadId), {
      notes: arrayUnion({ text, timestamp: new Date().toISOString() }),
    });
    setNoteInputs(prev => ({ ...prev, [leadId]: '' }));
  }

  // ── Message generation ─────────────────────────────────────────────────────
  async function generateMessage(lead, type) {
    setMsgModal({ leadId: lead.id, type, loading: true, result: null });

    try {
      const res = await fetch(api('/api/generate-message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: lead.businessName,
          businessType: lead.businessType,
          city: lead.city,
          issueDescription: getIssueDescription(lead.siteQuality, lead.websiteUrl),
          type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const keyMap = {
        'Instagram DM':          'instagram',
        'Cold Email':            'email',
        'Walk-in Talking Points':'walkin',
      };
      await updateDoc(doc(db, 'leads', lead.id), {
        [`generatedMessages.${keyMap[type]}`]: data.message,
      });

      setMsgModal(prev => ({ ...prev, loading: false, result: data.message }));
    } catch (err) {
      setMsgModal(prev => ({ ...prev, loading: false, result: `Error: ${err.message}` }));
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading pipeline…</div>;

  const hasFilters = filters.status || filters.quality || filters.city || filters.type || filters.ratings.length > 0 || filters.contact.length > 0 || filters.contactSearch;

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Pipeline</h2>
          <p className="text-slate-500 text-sm">
            {sorted.length} of {leads.length} lead{leads.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={fixJunkUrls}
            disabled={syncing}
            className="border border-slate-200 hover:border-slate-300 bg-white text-slate-600 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {syncing && syncProgress
              ? `Fixing ${syncProgress.done}/${syncProgress.total}…`
              : 'Fix URLs'}
          </button>
          <button
            onClick={rescanEmails}
            disabled={syncing}
            className="border border-slate-200 hover:border-slate-300 bg-white text-slate-600 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {syncing && syncProgress
              ? `Scanning ${syncProgress.done}/${syncProgress.total}…`
              : 'Rescan Emails'}
          </button>
          <button
            onClick={syncSocials}
            disabled={syncing}
            className="border border-slate-200 hover:border-slate-300 bg-white text-slate-600 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {syncing
              ? `Syncing ${syncProgress?.done}/${syncProgress?.total}…`
              : 'Sync Socials'}
          </button>
          <button
            onClick={() => setColModal(true)}
            className="bg-teal-600 hover:bg-teal-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            {copied ? '✓ Copied!' : 'Copy for Sheets'}
          </button>
          <button
            onClick={() => exportToCSV(filtered)}
            className="bg-slate-800 hover:bg-slate-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-400"
        >
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <select
          value={filters.quality}
          onChange={e => setFilters(f => ({ ...f, quality: e.target.value }))}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-400"
        >
          <option value="">All Site Quality</option>
          <option value="none">No Website</option>
          <option value="weak">Weak Site</option>
          <option value="has">Has Website</option>
        </select>

        <input
          type="text"
          placeholder="Filter by city…"
          value={filters.city}
          onChange={e => setFilters(f => ({ ...f, city: e.target.value }))}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />

        <input
          type="text"
          placeholder="Filter by type…"
          value={filters.type}
          onChange={e => setFilters(f => ({ ...f, type: e.target.value }))}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />

        <input
          type="text"
          placeholder="Search contact info…"
          value={filters.contactSearch}
          onChange={e => setFilters(f => ({ ...f, contactSearch: e.target.value }))}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />

        {/* Contact toggle */}
        <button
          onClick={() => setShowContactFilter(p => !p)}
          className={`border rounded-lg px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
            filters.contact.length > 0
              ? 'border-teal-400 bg-teal-50 text-teal-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }`}
        >
          Contact{filters.contact.length > 0 ? ` (${filters.contact.length})` : ''}
          <span className="text-xs text-slate-400">{showContactFilter ? '▲' : '▼'}</span>
        </button>

        {/* Rating toggle */}
        <button
          onClick={() => setShowRatingFilter(prev => !prev)}
          className={`border rounded-lg px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
            filters.ratings.length > 0
              ? 'border-teal-400 bg-teal-50 text-teal-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }`}
        >
          Rating{filters.ratings.length > 0 ? ` (${filters.ratings.length})` : ''}
          <span className="text-xs text-slate-400">{showRatingFilter ? '▲' : '▼'}</span>
        </button>

        {hasFilters && (
          <button
            onClick={() => { setFilters({ status: '', quality: '', city: '', type: '', ratings: [], contact: [], contactSearch: '' }); setShowRatingFilter(false); setShowContactFilter(false); }}
            className="text-sm text-red-400 hover:text-red-600"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Rating checkboxes (expanded) */}
      {showRatingFilter && (
        <div className="flex flex-wrap gap-3 mb-4 px-4 py-3 bg-white border border-slate-200 rounded-xl">
          {SCORE_OPTIONS.map(({ score, label }) => (
            <label key={score} className="flex items-center gap-2 cursor-pointer group select-none">
              <input
                type="checkbox"
                checked={filters.ratings.includes(score)}
                onChange={() => toggleRating(score)}
                className="w-4 h-4 rounded accent-teal-600 cursor-pointer"
              />
              <span className="text-sm text-slate-700 group-hover:text-slate-900">
                <span className="font-mono font-bold">{score}</span> — {label}
              </span>
            </label>
          ))}
          {filters.ratings.length > 0 && (
            <button
              onClick={() => setFilters(f => ({ ...f, ratings: [] }))}
              className="text-xs text-slate-400 hover:text-slate-600 ml-auto"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Contact checkboxes (expanded) */}
      {showContactFilter && (
        <div className="flex flex-wrap gap-3 mb-4 px-4 py-3 bg-white border border-slate-200 rounded-xl">
          {[
            { key: 'phone',    label: 'Phone' },
            { key: 'email',    label: 'Email' },
            { key: 'instagram',label: 'Instagram' },
            { key: 'facebook', label: 'Facebook' },
            { key: 'twitter',  label: 'X/Twitter' },
            { key: 'tiktok',   label: 'TikTok' },
            { key: 'snapchat', label: 'Snapchat' },
            { key: 'youtube',  label: 'YouTube' },
            { key: 'noContact',label: 'No Contact Info' },
          ].map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer group select-none">
              <input
                type="checkbox"
                checked={filters.contact.includes(key)}
                onChange={() => setFilters(f => ({
                  ...f,
                  contact: f.contact.includes(key)
                    ? f.contact.filter(c => c !== key)
                    : [...f.contact, key],
                }))}
                className="w-4 h-4 rounded accent-teal-600 cursor-pointer"
              />
              <span className="text-sm text-slate-700 group-hover:text-slate-900">{label}</span>
            </label>
          ))}
          {filters.contact.length > 0 && (
            <button
              onClick={() => setFilters(f => ({ ...f, contact: [] }))}
              className="text-xs text-slate-400 hover:text-slate-600 ml-auto"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Table */}
      {sorted.length === 0 ? (
        <div className="text-center py-20 text-slate-400 text-sm">
          {hasFilters ? 'No leads match your filters.' : 'No leads yet — search to find your first prospects.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <Th>Business</Th>
                  <Th>Website</Th>
                  <Th>Site Quality</Th>
                  <Th sortable onClick={() => toggleSort('leadScore')}>
                    Score{sortIndicator('leadScore')}
                  </Th>
                  <Th>Status</Th>
                  <Th>Contact</Th>
                  <Th sortable onClick={() => toggleSort('daysSince')}>
                    Last Contact{sortIndicator('daysSince')}
                  </Th>
                  <Th sortable onClick={() => toggleSort('dateAdded')}>
                    Added{sortIndicator('dateAdded')}
                  </Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map(lead => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    expanded={expandedId === lead.id}
                    onToggle={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                    onStatusChange={status => updateStatus(lead.id, status)}
                    onDelete={() => deleteLead(lead.id)}
                    noteInput={noteInputs[lead.id] || ''}
                    onNoteChange={t => setNoteInputs(prev => ({ ...prev, [lead.id]: t }))}
                    onAddNote={() => addNote(lead.id)}
                    onGenerate={type => generateMessage(lead, type)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Message modal */}
      {msgModal && (
        <MsgModal modal={msgModal} onClose={() => setMsgModal(null)} />
      )}

      {/* Copy for Sheets column picker */}
      {colModal && (
        <CopyModal
          leads={filtered}
          onClose={() => setColModal(false)}
          onCopied={() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Th({ children, sortable, onClick }) {
  return (
    <th
      onClick={onClick}
      className={`px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap ${
        sortable ? 'cursor-pointer select-none hover:text-slate-700' : ''
      }`}
    >
      {children}
    </th>
  );
}

function LeadRow({
  lead, expanded, onToggle, onStatusChange, onDelete,
  noteInput, onNoteChange, onAddNote, onGenerate,
}) {
  const [msgType, setMsgType] = useState('Instagram DM');
  const days = lead.contactedAt ? daysSince(lead.contactedAt) : null;
  const needsFollowUp = lead.status === 'Messaged' && days !== null && days >= 5;

  return (
    <>
      <tr className={`hover:bg-slate-50/80 transition-colors ${needsFollowUp ? 'bg-amber-50/60' : ''}`}>
        {/* Business */}
        <td className="px-4 py-3">
          <button
            onClick={onToggle}
            className="font-medium text-slate-800 hover:text-teal-600 text-left leading-tight"
          >
            {lead.businessName}
          </button>
          <p className="text-xs text-slate-500 mt-0.5">{lead.businessType} · {lead.city}</p>
        </td>

        {/* Website */}
        <td className="px-4 py-3 text-xs max-w-[180px]">
          {lead.websiteUrl ? (
            <a href={lead.websiteUrl} target="_blank" rel="noreferrer"
              className="text-blue-600 hover:underline truncate block"
              title={lead.websiteUrl}>
              {lead.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          ) : (
            <span className="text-red-400 font-medium">No website</span>
          )}
        </td>

        {/* Site quality */}
        <td className="px-4 py-3">
          <SiteQualityBadge quality={lead.siteQuality} />
        </td>

        {/* Score */}
        <td className="px-4 py-3">
          <LeadScoreBadge score={lead.leadScore} />
        </td>

        {/* Status */}
        <td className="px-4 py-3">
          <select
            value={lead.status}
            onChange={e => onStatusChange(e.target.value)}
            className="border border-slate-200 rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-teal-400"
          >
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>

        {/* Contact info */}
        <td className="px-4 py-3 text-xs">
          <div className="space-y-0.5">
            {lead.phone && <p className="text-slate-700">{lead.phone}</p>}
            {lead.discoveredEmail ? (
              lead.emailGuessed ? (
                <a href={`https://${lead.discoveredEmail}`} target="_blank" rel="noreferrer"
                  className="text-amber-600 hover:underline block truncate max-w-[160px]"
                  title="Website domain only — no email found">
                  {lead.discoveredEmail}
                </a>
              ) : (
                <a href={`mailto:${lead.discoveredEmail}`}
                  className="text-blue-600 hover:underline block truncate max-w-[160px]">
                  {lead.discoveredEmail}
                </a>
              )
            ) : (
              <span className="text-slate-400">No email found</span>
            )}
            {lead.socialMedia?.instagram && <a href={lead.socialMedia.instagram} target="_blank" rel="noreferrer" className="text-pink-500 hover:underline block">Instagram ↗</a>}
            {lead.socialMedia?.facebook  && <a href={lead.socialMedia.facebook}  target="_blank" rel="noreferrer" className="text-blue-500 hover:underline block">Facebook ↗</a>}
            {lead.socialMedia?.twitter   && <a href={lead.socialMedia.twitter}   target="_blank" rel="noreferrer" className="text-sky-500 hover:underline block">X/Twitter ↗</a>}
            {lead.socialMedia?.tiktok    && <a href={lead.socialMedia.tiktok}    target="_blank" rel="noreferrer" className="text-slate-800 hover:underline block">TikTok ↗</a>}
            {lead.socialMedia?.snapchat  && <a href={lead.socialMedia.snapchat}  target="_blank" rel="noreferrer" className="text-yellow-500 hover:underline block">Snapchat ↗</a>}
            {lead.socialMedia?.youtube   && <a href={lead.socialMedia.youtube}   target="_blank" rel="noreferrer" className="text-red-500 hover:underline block">YouTube ↗</a>}
          </div>
        </td>

        {/* Days since contact */}
        <td className="px-4 py-3 text-xs">
          {days !== null ? (
            <span className={needsFollowUp ? 'text-amber-600 font-semibold' : 'text-slate-600'}>
              {days}d ago{needsFollowUp ? ' ⚠ Follow up?' : ''}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>

        {/* Date added */}
        <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
          {formatDate(lead.dateAdded)}
        </td>

        {/* Actions */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={onToggle} className="text-xs text-slate-400 hover:text-slate-700">
              {expanded ? 'Collapse' : 'Expand'}
            </button>
            <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600">
              Delete
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr>
          <td colSpan={9} className="px-4 py-5 bg-slate-50 border-t border-b border-slate-200">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* Left: Details + Outreach */}
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Details</h4>
                  <div className="text-sm space-y-1 text-slate-700">
                    {lead.address && <p>{lead.address}</p>}
                    {lead.websiteUrl ? (
                      <a href={lead.websiteUrl} target="_blank" rel="noreferrer"
                        className="text-blue-600 hover:underline break-all block text-xs">
                        {lead.websiteUrl}
                      </a>
                    ) : (
                      <p className="text-xs text-red-500">No website</p>
                    )}
                    {lead.foursquareUrl && (
                      <a href={lead.foursquareUrl} target="_blank" rel="noreferrer"
                        className="text-xs text-slate-400 hover:underline">
                        View on Foursquare ↗
                      </a>
                    )}
                    {Object.values(lead.socialMedia || {}).some(Boolean) && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {lead.socialMedia?.instagram && <a href={lead.socialMedia.instagram} target="_blank" rel="noreferrer" className="text-xs text-pink-500 hover:underline">Instagram ↗</a>}
                        {lead.socialMedia?.facebook  && <a href={lead.socialMedia.facebook}  target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">Facebook ↗</a>}
                        {lead.socialMedia?.twitter   && <a href={lead.socialMedia.twitter}   target="_blank" rel="noreferrer" className="text-xs text-sky-500 hover:underline">X/Twitter ↗</a>}
                        {lead.socialMedia?.tiktok    && <a href={lead.socialMedia.tiktok}    target="_blank" rel="noreferrer" className="text-xs text-slate-800 hover:underline">TikTok ↗</a>}
                        {lead.socialMedia?.snapchat  && <a href={lead.socialMedia.snapchat}  target="_blank" rel="noreferrer" className="text-xs text-yellow-500 hover:underline">Snapchat ↗</a>}
                        {lead.socialMedia?.youtube   && <a href={lead.socialMedia.youtube}   target="_blank" rel="noreferrer" className="text-xs text-red-500 hover:underline">YouTube ↗</a>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Generate outreach */}
                <div>
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Generate Outreach</h4>
                  <div className="flex gap-2 mb-3">
                    <select
                      value={msgType}
                      onChange={e => setMsgType(e.target.value)}
                      className="flex-1 border border-slate-200 rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                    >
                      {MSG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button
                      onClick={() => onGenerate(msgType)}
                      className="bg-teal-600 hover:bg-teal-700 text-white rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors"
                    >
                      Generate ~$0.001
                    </button>
                  </div>

                  {/* Previously generated messages */}
                  {lead.generatedMessages && (
                    <div className="space-y-2">
                      {lead.generatedMessages.instagram && (
                        <SavedMsg label="Instagram DM" text={lead.generatedMessages.instagram} />
                      )}
                      {lead.generatedMessages.email && (
                        <SavedMsg label="Cold Email" text={lead.generatedMessages.email} />
                      )}
                      {lead.generatedMessages.walkin && (
                        <SavedMsg label="Walk-in Points" text={lead.generatedMessages.walkin} />
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Notes timeline */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Notes Timeline</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto mb-3 pr-1">
                  {(lead.notes || []).length === 0 ? (
                    <p className="text-xs text-slate-400">No notes yet.</p>
                  ) : (
                    [...(lead.notes || [])].reverse().map((note, i) => (
                      <div key={i} className="bg-white border border-slate-200 rounded-lg p-2.5">
                        <p className="text-xs text-slate-700">{note.text}</p>
                        <p className="text-xs text-slate-400 mt-1">
                          {new Date(note.timestamp).toLocaleString()}
                        </p>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Add a note…"
                    value={noteInput}
                    onChange={e => onNoteChange(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && onAddNote()}
                    className="flex-1 border border-slate-200 rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-teal-400"
                  />
                  <button
                    onClick={onAddNote}
                    className="bg-slate-700 hover:bg-slate-800 text-white rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SavedMsg({ label, text }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <button onClick={copy} className="text-xs text-teal-600 hover:underline">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-slate-700 whitespace-pre-wrap line-clamp-4">{text}</p>
    </div>
  );
}

function MsgModal({ modal, onClose }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!modal.result) return;
    navigator.clipboard.writeText(modal.result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">{modal.type}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6">
          {modal.loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <div className="mb-2">Generating with Claude…</div>
              <div className="text-xs text-slate-300">This costs approximately $0.001</div>
            </div>
          ) : (
            <>
              <pre className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-700 whitespace-pre-wrap font-sans max-h-72 overflow-y-auto">
                {modal.result}
              </pre>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={copy}
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white rounded-lg py-2 text-sm font-medium transition-colors"
                >
                  {copied ? '✓ Copied!' : 'Copy to Clipboard'}
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const ALL_COLUMNS = [
  { key: 'businessName',    label: 'Business Name' },
  { key: 'businessType',    label: 'Business Type' },
  { key: 'city',            label: 'City' },
  { key: 'address',         label: 'Address' },
  { key: 'phone',           label: 'Phone' },
  { key: 'websiteUrl',      label: 'Website URL' },
  { key: 'siteQuality',     label: 'Site Quality' },
  { key: 'leadScore',       label: 'Lead Score' },
  { key: 'status',          label: 'Status' },
  { key: 'discoveredEmail', label: 'Email' },
  { key: 'dateAdded',       label: 'Date Added' },
];

function CopyModal({ leads, onClose, onCopied }) {
  const [selected, setSelected] = useState(new Set(ALL_COLUMNS.map(c => c.key)));
  const [done, setDone] = useState(false);

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function doCopy() {
    const cols = ALL_COLUMNS.filter(c => selected.has(c.key));
    const headers = cols.map(c => c.label);
    const rows = leads.map(l =>
      cols.map(c => {
        if (c.key === 'siteQuality') {
          return l[c.key] === 'none' ? 'No Website' : l[c.key] === 'weak' ? 'Weak Site' : 'Has Website';
        }
        if (c.key === 'dateAdded') return l[c.key] ? new Date(l[c.key]).toLocaleDateString() : '';
        return String(l[c.key] ?? '').replace(/\t/g, ' ');
      })
    );
    const tsv = [headers, ...rows].map(r => r.join('\t')).join('\n');
    navigator.clipboard.writeText(tsv).then(() => {
      setDone(true);
      onCopied();
      setTimeout(onClose, 1200);
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">Copy for Google Sheets</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-500">Uncheck any columns you don't need.</p>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set(ALL_COLUMNS.map(c => c.key)))} className="text-xs text-teal-600 hover:underline">All</button>
              <button onClick={() => setSelected(new Set())} className="text-xs text-slate-400 hover:underline">None</button>
            </div>
          </div>
          <div className="space-y-2">
            {ALL_COLUMNS.map(col => (
              <label key={col.key} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={selected.has(col.key)}
                  onChange={() => toggle(col.key)}
                  className="w-4 h-4 rounded accent-teal-600"
                />
                <span className="text-sm text-slate-700 group-hover:text-slate-900">{col.label}</span>
              </label>
            ))}
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={doCopy}
              disabled={selected.size === 0}
              className="flex-1 bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              {done ? '✓ Copied!' : `Copy ${leads.length} row${leads.length !== 1 ? 's' : ''}`}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
