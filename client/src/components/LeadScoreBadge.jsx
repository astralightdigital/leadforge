export default function LeadScoreBadge({ score }) {
  const color =
    score >= 8
      ? 'text-emerald-700 bg-emerald-50 border-emerald-300'
      : score >= 5
      ? 'text-amber-700 bg-amber-50 border-amber-300'
      : 'text-red-700 bg-red-50 border-red-300';

  return (
    <span
      className={`inline-flex items-center justify-center w-8 h-8 rounded-full border-2 font-mono font-bold text-sm flex-shrink-0 ${color}`}
    >
      {score}
    </span>
  );
}
