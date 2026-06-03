import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import Dashboard from './pages/Dashboard';
import FindLeads from './pages/FindLeads';
import Pipeline from './pages/Pipeline';
import MapView from './pages/MapView';
import Outreach from './pages/Outreach';

const NAV = [
  { to: '/',          label: 'Dashboard', icon: '▦' },
  { to: '/find',      label: 'Find',      icon: '⊕' },
  { to: '/pipeline',  label: 'Pipeline',  icon: '≡' },
  { to: '/outreach',  label: 'Outreach',  icon: '✉' },
  { to: '/map',       label: 'Map',       icon: '◎' },
];

function MobileNav() {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-[99999] bg-slate-900 border-t border-slate-700/60 flex">
      {NAV.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
              isActive ? 'text-teal-400' : 'text-slate-500'
            }`
          }
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <ToastContainer />
        <main className="flex-1 min-w-0 overflow-auto pb-16 md:pb-0">
          <Routes>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/find"      element={<FindLeads />} />
            <Route path="/pipeline"  element={<Pipeline />} />
            <Route path="/outreach"  element={<Outreach />} />
            <Route path="/map"       element={<MapView />} />
          </Routes>
        </main>
        <MobileNav />
      </div>
    </BrowserRouter>
  );
}
