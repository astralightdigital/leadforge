const WEAK_PATTERNS = ['wix', 'square', 'squarespace', 'godaddy', 'weebly', 'wixsite'];

export function getSiteQuality(url) {
  if (!url) return 'none';
  const lower = url.toLowerCase();
  if (WEAK_PATTERNS.some(p => lower.includes(p))) return 'weak';
  return 'has';
}

export function calculateLeadScore({ websiteUrl, reviewCount = 0, rating = 0, phone }) {
  const quality = getSiteQuality(websiteUrl);
  let score = 0;

  if (quality === 'none') score += 3;
  else if (quality === 'weak') score += 2;

  if (reviewCount > 50) score += 2;
  if (reviewCount > 200) score += 1;
  if (rating >= 4.0) score += 1;
  if (phone) score += 1;

  return Math.min(score, 10);
}

export function getIssueDescription(siteQuality, websiteUrl) {
  if (siteQuality === 'none') return 'no website listed';
  if (siteQuality === 'weak') {
    const lower = (websiteUrl || '').toLowerCase();
    if (lower.includes('wix')) return 'their current site is built on Wix';
    if (lower.includes('squarespace')) return 'their current site is built on Squarespace';
    if (lower.includes('square')) return 'their current site is a Square page';
    if (lower.includes('godaddy')) return 'their current site is a basic GoDaddy page';
    if (lower.includes('weebly')) return 'their current site is built on Weebly';
    return 'their current site is on a DIY website builder';
  }
  return 'their website may have room for improvement';
}
