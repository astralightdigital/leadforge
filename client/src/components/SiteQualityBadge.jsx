const CONFIG = {
  none: { label: 'No Website', bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  weak: { label: 'Weak Site', bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  has: { label: 'Has Website', bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
};

export default function SiteQualityBadge({ quality }) {
  const c = CONFIG[quality] || CONFIG.has;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
      {c.label}
    </span>
  );
}
