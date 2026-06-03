const FREE_SUBDOMAINS = [
  '.wixsite.com', '.square.site', '.squareup.com',
  '.weebly.com', '.godaddysites.com', '.jimdofree.com',
  '.strikingly.com', '.carrd.co', '.webnode.com', '.site123.me',
  '.webstarts.com', '.yolasite.com',
];

const BUILDER_SIGNALS = [
  'wix.com', 'squarespace.com', 'godaddy.com', 'weebly.com',
  'jimdo.com', 'strikingly.com', 'wordpress.com', 'blogspot.',
  'tumblr.com', 'webflow.io', 'mystrikingly.com',
];

export function getSiteQuality(url) {
  if (!url) return 'none';
  const lower = url.toLowerCase();
  if (FREE_SUBDOMAINS.some(d => lower.includes(d))) return 'weak';
  if (BUILDER_SIGNALS.some(b => lower.includes(b))) return 'weak';
  return 'has';
}

// 5 = no website (best lead), 4 = free builder subdomain,
// 3 = builder with custom domain, 1 = real custom domain
export function calculateLeadScore(websiteUrl) {
  if (!websiteUrl) return 5;
  const url = websiteUrl.toLowerCase();
  if (FREE_SUBDOMAINS.some(d => url.includes(d))) return 4;
  if (BUILDER_SIGNALS.some(b => url.includes(b))) return 3;
  return 1;
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
