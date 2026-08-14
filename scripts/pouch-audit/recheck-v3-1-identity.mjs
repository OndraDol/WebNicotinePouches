const BRAND_ALIASES = new Map([
  ['77 pouches', new Set(['77 pouches', '77'])],
]);

const MARKETING_TOKENS = new Set([
  'buy', 'from', 'online', 'order', 'save', 'shipping', 'delivery',
  'next', 'day', 'fast', 'stock', 'now', 'shop', 'today',
]);

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&amp;|&#x26;/giu, '&')
    .replace(/&quot;|&#x22;/giu, '"')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)));
}

export function normalizeIdentityText(value) {
  return decodeEntities(value).normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\b\d+(?:[.,]\d+)?\s*mg(?:\s*\/\s*(?:g|pouch))?\b/giu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim().replace(/\s+/gu, ' ');
}

export function canonicalBrand(rawBrand) {
  const normalized = normalizeIdentityText(rawBrand);
  for (const [key, aliases] of BRAND_ALIASES) {
    if (aliases.has(normalized)) return key;
  }
  return normalized || null;
}

export function canonicalProductCore(rawName, brandKey) {
  const normalized = normalizeIdentityText(rawName);
  const tokens = normalized.split(' ').filter(Boolean);
  const aliases = BRAND_ALIASES.get(brandKey) ?? new Set(brandKey ? [brandKey] : []);
  const aliasTokens = [...aliases].sort((a, b) => b.length - a.length)
    .find((alias) => normalized === alias || normalized.startsWith(`${alias} `))?.split(' ') ?? [];
  const withoutBrand = aliasTokens.length ? tokens.slice(aliasTokens.length) : tokens;
  return withoutBrand
    .filter((token) => !MARKETING_TOKENS.has(token) && !/^\d+$/u.test(token))
    .join(' ');
}

export function compareProductIdentity(frozen, extracted) {
  const expectedBrand = canonicalBrand(frozen?.b);
  const actualBrand = extracted?.brand_raw ? canonicalBrand(extracted.brand_raw) : null;
  const expectedCore = canonicalProductCore(frozen?.n, expectedBrand);
  const actualCore = canonicalProductCore(extracted?.product_name_raw, actualBrand ?? expectedBrand);
  const expected = new Set(expectedCore.split(' ').filter(Boolean));
  const actual = new Set(actualCore.split(' ').filter(Boolean));
  const missing = [...expected].filter((token) => !actual.has(token));
  const extra = [...actual].filter((token) => !expected.has(token));
  const brandMatches = actualBrand !== null && actualBrand === expectedBrand;
  return {
    identity_match: brandMatches && missing.length === 0 && extra.length === 0 ? 'exact' : missing.length === 0 ? 'near' : 'wrong',
    brand_key: actualBrand,
    product_core: actualCore,
    missing_variant_tokens: missing,
    extra_variant_tokens: extra,
  };
}

export { BRAND_ALIASES };
