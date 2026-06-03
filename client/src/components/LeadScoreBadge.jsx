const CONFIG = {
  5: { label: 'No site',     color: 'text-red-700 bg-red-50 border-red-300' },
  4: { label: 'Free builder',color: 'text-orange-700 bg-orange-50 border-orange-300' },
  3: { label: 'DIY builder', color: 'text-amber-700 bg-amber-50 border-amber-300' },
  1: { label: 'Has site',    color: 'text-slate-500 bg-slate-50 border-slate-300' },
};

export default function LeadScoreBadge({ score }) {
  const { label, color } = CONFIG[score] ?? CONFIG[1];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${color}`}>
      <span className="font-bold font-mono">{score}</span>
      <span>{label}</span>
    </span>
  );
}
