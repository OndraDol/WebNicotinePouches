const rows = [
  { host: 'haypp.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group', owner_evidence_url: 'https://www.hayppgroup.com/' },
  { host: 'northerner.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group', owner_evidence_url: 'https://www.hayppgroup.com/' },
  { host: 'nicopodsuk.com', source_class: 'retailer', owner: 'NicoPODS UK', owner_group_id: 'nicopodsuk', owner_evidence_url: 'https://nicopodsuk.com/' },
  { host: 'snusdirect.com', source_class: 'retailer', owner: 'Snusdirect', owner_group_id: 'snusdirect', owner_evidence_url: 'https://www.snusdirect.com/' },
  { host: 'velo.com', source_class: 'official', owner: 'BAT / VELO', owner_group_id: 'bat-velo', owner_evidence_url: 'https://www.velo.com/' },
  { host: 'zyn.com', source_class: 'official', owner: 'Swedish Match / ZYN', owner_group_id: 'swedish-match-zyn', owner_evidence_url: 'https://www.zyn.com/' },
  { host: 'nordicspirit.co.uk', source_class: 'official', owner: 'JTI / Nordic Spirit', owner_group_id: 'jti-nordic-spirit', owner_evidence_url: 'https://nordicspirit.co.uk/' },
  { host: 'fumipods.com', source_class: 'official', owner: 'Helix Sweden / FUMI', owner_group_id: 'helix-fumi', owner_evidence_url: 'https://fumipods.com/' },
  { host: 'pablopouch.com', source_class: 'official', owner: 'Pablo', owner_group_id: 'pablo', owner_evidence_url: 'https://pablopouch.com/' },
  { host: 'fda.gov', source_class: 'regulator', owner: 'US FDA', owner_group_id: 'us-fda', owner_evidence_url: 'https://www.fda.gov/' },
  { host: 'accessdata.fda.gov', source_class: 'regulator', owner: 'US FDA', owner_group_id: 'us-fda', owner_evidence_url: 'https://www.fda.gov/' },
  { host: 'canada.ca', source_class: 'regulator', owner: 'Health Canada', owner_group_id: 'health-canada', owner_evidence_url: 'https://www.canada.ca/' },
  { host: 'folkhalsomyndigheten.se', source_class: 'regulator', owner: 'Swedish Public Health Agency', owner_group_id: 'swedish-ph', owner_evidence_url: 'https://www.folkhalsomyndigheten.se/' },
  { host: 'sik.dk', source_class: 'regulator', owner: 'Danish Safety Technology Authority', owner_group_id: 'danish-safety', owner_evidence_url: 'https://www.sik.dk/' },
];

export const SOURCE_REGISTRY = Object.freeze(rows.map((row) => Object.freeze({ ...row })));

export function sourceForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLocaleLowerCase('en-US').replace(/^www\./u, ''); }
  catch { return { host: null, source_class: 'unknown', owner: null, owner_group_id: null, owner_evidence_url: null }; }
  const row = SOURCE_REGISTRY.find((item) => host === item.host || host.endsWith(`.${item.host}`));
  return row ? { ...row, host } : { host, source_class: 'unknown', owner: null, owner_group_id: null, owner_evidence_url: null };
}

export function independentSourceBranches(sources) {
  const branches = new Map();
  for (const source of sources) {
    const key = source.owner_group_id ?? `unknown:${source.host}`;
    if (!branches.has(key)) branches.set(key, source);
  }
  return [...branches.values()];
}
