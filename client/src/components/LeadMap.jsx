import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useState } from 'react';

const STATUS_COLORS = {
  'Not Contacted': '#ef4444',
  'Messaged':      '#f59e0b',
  'Replied':       '#22c55e',
  'Meeting Set':   '#22c55e',
  'Closed Won':    '#3b82f6',
  'Closed Lost':   '#6b7280',
  'Custom':        '#a855f7',
};

const STATUSES = [
  'Not Contacted', 'Messaged', 'Replied',
  'Meeting Set', 'Closed Won', 'Closed Lost', 'Custom',
];

function LeadPin({ lead, mini }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(lead.status);
  const [saving, setSaving] = useState(false);

  async function changeStatus(newStatus) {
    setStatus(newStatus);
    setSaving(true);
    const update = { status: newStatus };
    if (newStatus === 'Messaged') update.contactedAt = new Date().toISOString();
    await updateDoc(doc(db, 'leads', lead.id), update);
    setSaving(false);
  }

  const color = STATUS_COLORS[status] || '#ef4444';

  return (
    <CircleMarker
      key={lead.id}
      center={[lead.lat, lead.lng]}
      radius={mini ? 5 : 11}
      fillColor={color}
      color="#ffffff"
      weight={2.5}
      fillOpacity={0.95}
      pathOptions={{ className: '' }}
    >
      {!mini && (
        <Popup minWidth={240} maxWidth={280}>
          <div className="text-sm space-y-2 py-1">
            {/* Header */}
            <div>
              <p className="font-bold text-slate-800 text-base leading-tight">{lead.businessName}</p>
              <p className="text-xs text-slate-500 mt-0.5">{lead.businessType} · {lead.city}</p>
            </div>

            <hr className="border-slate-200" />

            {/* Contact info */}
            <div className="space-y-1">
              {lead.phone && <p className="text-xs text-slate-600">{lead.phone}</p>}
              {lead.websiteUrl ? (
                <a href={lead.websiteUrl} target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline block truncate">
                  {lead.websiteUrl}
                </a>
              ) : (
                <p className="text-xs text-red-400 font-medium">No website</p>
              )}
            </div>

            {/* Status changer */}
            <div>
              <p className="text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Status</p>
              <select
                value={status}
                onChange={e => changeStatus(e.target.value)}
                disabled={saving}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-teal-400"
                style={{ borderLeft: `3px solid ${color}` }}
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {saving && <p className="text-xs text-slate-400 mt-1">Saving…</p>}
            </div>

            {/* Actions */}
            <button
              onClick={() => navigate('/pipeline')}
              className="w-full text-xs bg-slate-800 hover:bg-slate-700 text-white rounded-lg px-3 py-1.5 transition-colors"
            >
              Open in Pipeline →
            </button>
          </div>
        </Popup>
      )}
    </CircleMarker>
  );
}

export default function LeadMap({ leads, height = '100%', mini = false }) {
  const pinned = leads.filter(l => l.lat != null && l.lng != null);

  return (
    <MapContainer
      center={[39.5, -98.35]}
      zoom={mini ? 3 : 4}
      style={{ height, width: '100%' }}
      scrollWheelZoom={!mini}
      dragging={!mini}
      zoomControl={!mini}
      doubleClickZoom={!mini}
      touchZoom={!mini}
      attributionControl={!mini}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
      />
      {pinned.map(lead => (
        <LeadPin key={lead.id} lead={lead} mini={mini} />
      ))}
    </MapContainer>
  );
}
