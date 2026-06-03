import { NavLink } from 'react-router-dom';
import { useLeads } from '../hooks/useLeads';
import { daysSince } from '../lib/utils';

const NAV = [
  { to: '/',         label: 'Dashboard',  icon: '▦' },
  { to: '/find',     label: 'Find Leads', icon: '⊕' },
  { to: '/pipeline', label: 'Pipeline',   icon: '≡' },
  { to: '/map',      label: 'Map',        icon: '◎' },
];

export default function Sidebar() {
  const { leads } = useLeads();

  const followUpCount = leads.filter(
    l => l.status === 'Messaged' && l.contactedAt && daysSince(l.contactedAt) >= 5
  ).length;

  return (
    <aside className="w-56 flex-shrink-0 bg-slate-900 flex flex-col h-screen sticky top-0 z-10">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-700/60">
        <h1 className="text-teal-400 font-bold text-xl tracking-tight">LeadForge</h1>
        <p className="text-slate-500 text-xs mt-0.5">Local Business Prospecting</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`
            }
          >
            <span className="text-base w-5 text-center">{item.icon}</span>
            {item.label}
            {item.label === 'Pipeline' && followUpCount > 0 && (
              <span className="ml-auto bg-amber-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-mono font-bold">
                {followUpCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-slate-700/60">
        <p className="text-slate-600 text-xs">Powered by Foursquare + Claude</p>
      </div>
    </aside>
  );
}
