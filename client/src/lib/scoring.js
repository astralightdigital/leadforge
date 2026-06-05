const FREE_SUBDOMAINS = [
  '.wixsite.com', '.square.site', '.squareup.com',
  '.weebly.com', '.godaddysites.com', '.jimdofree.com',
  '.strikingly.com', '.carrd.co', '.webnode.com', '.site123.me',
  '.webstarts.com', '.yolasite.com',
  // Google free business sites
  '.business.site',
  // Directory / listing platforms used as "websites"
  'bizhub.com', 'manta.com', 'chamberofcommerce.com',
  'yellowpages.com', 'yelp.com', 'alignable.com',
  'thumbtack.com', 'bark.com', 'homeadvisor.com', 'houzz.com',
  // Free site builders
  '.place', 'sites.google.com', '.mystrikingly.com',
  '.wordpress.com', '.blogspot.com',
];

const BUILDER_SIGNALS = [
  'wix.com', 'squarespace.com', 'godaddy.com', 'weebly.com',
  'jimdo.com', 'strikingly.com', 'wordpress.com', 'blogspot.',
  'tumblr.com', 'webflow.io', 'mystrikingly.com',
  'business.site', 'sites.google.com',
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
  try {
    if (!new URL(websiteUrl).hostname.endsWith('.com')) return 2;
  } catch {}
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
