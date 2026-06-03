const STYLES = {
  'Not Contacted': 'bg-slate-100 text-slate-600',
  'Messaged':      'bg-amber-100 text-amber-700',
  'Replied':       'bg-blue-100 text-blue-700',
  'Meeting Set':   'bg-purple-100 text-purple-700',
  'Closed Won':    'bg-emerald-100 text-emerald-700',
  'Closed Lost':   'bg-red-100 text-red-600',
};

export default function StatusPill({ status }) {
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STYLES[status] || 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
}
