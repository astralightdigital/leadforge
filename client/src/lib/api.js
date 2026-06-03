const base = import.meta.env.VITE_API_URL || '';
export const api = (path) => `${base}${path}`;
