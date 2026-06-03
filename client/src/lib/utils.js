export function formatPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

export function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

export function formatDate(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function copyForSheets(leads) {
  const headers = [
    'Business Name', 'Business Type', 'City', 'Address', 'Phone',
    'Website URL', 'Site Quality', 'Lead Score', 'Status',
    'Email', 'Date Added',
  ];

  const rows = leads.map(l => [
    l.businessName,
    l.businessType,
    l.city,
    l.address,
    l.phone || '',
    l.websiteUrl || '',
    l.siteQuality === 'none' ? 'No Website' : l.siteQuality === 'weak' ? 'Weak Site' : 'Has Website',
    l.leadScore,
    l.status,
    l.discoveredEmail || '',
    l.dateAdded ? new Date(l.dateAdded).toLocaleDateString() : '',
  ]);

  const tsv = [headers, ...rows]
    .map(row => row.map(cell => String(cell ?? '').replace(/\t/g, ' ')).join('\t'))
    .join('\n');

  return navigator.clipboard.writeText(tsv);
}

export function exportToCSV(leads) {
  const headers = [
    'Business Name', 'Business Type', 'City', 'Address', 'Phone',
    'Website URL', 'Site Quality', 'Lead Score', 'Status',
    'Email', 'Foursquare URL', 'Date Added', 'Notes',
  ];

  const rows = leads.map(l => [
    l.businessName,
    l.businessType,
    l.city,
    l.address,
    l.phone || '',
    l.websiteUrl || 'None',
    l.siteQuality,
    l.leadScore,
    l.status,
    l.discoveredEmail || '',
    l.foursquareUrl || '',
    l.dateAdded ? new Date(l.dateAdded).toLocaleDateString() : '',
    (l.notes || []).map(n => `[${new Date(n.timestamp).toLocaleString()}] ${n.text}`).join(' | '),
  ]);

  const csv = [headers, ...rows]
    .map(row =>
      row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    )
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leadforge-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
