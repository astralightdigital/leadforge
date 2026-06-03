import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import Dashboard from './pages/Dashboard';
import FindLeads from './pages/FindLeads';
import Pipeline from './pages/Pipeline';
import MapView from './pages/MapView';

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <ToastContainer />
        <main className="flex-1 min-w-0 overflow-auto">
          <Routes>
            <Route path="/"         element={<Dashboard />} />
            <Route path="/find"     element={<FindLeads />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/map"      element={<MapView />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
