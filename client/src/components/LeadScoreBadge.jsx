const CONFIG = {
  5: { label: 'No site',     color: 'text-red-700 bg-red-50 border-red-300' },
  4: { label: 'Free builder',color: 'text-orange-700 bg-orange-50 border-orange-300' },
  3: { label: 'DIY builder', color: 'text-amber-700 bg-amber-50 border-amber-300' },
  2: { label: 'Non-.com',    color: 'text-blue-700 bg-blue-50 border-blue-300' },
  1: { label: 'Has site',    color: 'text-slate-500 bg-slate-50 border-slate-300' },
};

export default function LeadScoreBadge({ score }) {
  const { label, color } = CONFIG[score] ?? CONFIG[1];
  return (
    <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full border-2 font-mono font-bold text-sm ${color}`}>
        {score}
      </span>
      <span className="text-[9px] text-slate-400 leading-none text-center whitespace-nowrap">{label}</span>
    </div>
  );
}
