import { useState, useEffect } from 'react';

let toastFn = null;

export function showToast(message, type = 'success') {
  if (toastFn) toastFn(message, type);
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    toastFn = (message, type) => {
      const id = Date.now();
      setToasts(prev => [...prev, { id, message, type }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2800);
    };
    return () => { toastFn = null; };
  }, []);

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white animate-toast"
          style={{ background: toast.type === 'success' ? '#0d9488' : '#ef4444' }}
        >
          <span>{toast.type === 'success' ? '✓' : '✕'}</span>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
