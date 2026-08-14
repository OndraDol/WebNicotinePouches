import { fetchLive, parseSearchResponse } from './recheck-v3-transport.mjs';

function numeric(value) {
  const match = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/u);
  return match ? Number(match[0].replace(',', '.')) : null;
}

function jsonLdObjects(body) {
  const objects = [];
  for (const match of String(body ?? '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const parsed = JSON.parse(match[1]);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        objects.push(item);
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    } catch { /* malformed JSON-LD is not product evidence */ }
  }
  return objects;
}

function asProperties(product) {
  const properties = product?.additionalProperty ?? [];
  return Array.isArray(properties) ? properties : [properties];
}

function propertyClaims(product) {
  const claims = [];
  for (const property of asProperties(product)) {
    const label = String(property?.name ?? '');
    const rawValue = String(property?.value ?? '');
    const value = numeric(rawValue);
    if (!Number.isFinite(value)) continue;
    const context = `${label} ${rawValue}`;
    if (/nicotine.*(?:per\s*)?pouch|mg\s*\/\s*pouch|mg\s+per\s+portion/iu.test(context)) {
      claims.push({ value, unit: 'mg', basis: 'per_pouch', raw_label: label, raw_value: rawValue, method: 'json_ld' });
    } else if (/nicotine.*(?:per\s*)?g|mg\s*\/\s*g|mg\s+per\s+gram/iu.test(context)) {
      claims.push({ value, unit: 'mg', basis: 'per_g', raw_label: label, raw_value: rawValue, method: 'json_ld' });
    }
  }
  return claims;
}

export function parseProductFacts(response) {
  if (!response || response.status < 200 || response.status >= 300 || response.transport_error || response.cache_hit === true) {
    return { parse_status: 'not_parsed', page_kind: 'unknown', extracted: {} };
  }
  const products = jsonLdObjects(response.body).filter((item) => item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product')));
  const product = products[0] ?? null;
  const properties = asProperties(product);
  const propertyValue = (pattern) => properties.find((item) => pattern.test(String(item?.name ?? '')))?.value;
  if (!product) return { parse_status: 'not_parsed', page_kind: 'unknown', extracted: {} };
  const brandRaw = typeof product.brand === 'string' ? product.brand : product.brand?.name;
  const nameRaw = typeof product.name === 'string' ? product.name : null;
  const extracted = {
    brand_raw: brandRaw,
    brand_method: brandRaw ? 'json_ld' : null,
    product_name_raw: nameRaw,
    product_name_method: nameRaw ? 'json_ld' : null,
    product_id: product.sku ?? product.gtin ?? product.productID ?? null,
    strength_claims: propertyClaims(product),
    net_weight_g: numeric(propertyValue(/net\s*weight/iu)),
    pouch_count: numeric(propertyValue(/pouches?|portion\s*count/iu)),
    facts_method: 'json_ld',
  };
  return { parse_status: 'parsed', page_kind: 'product_detail', extracted };
}

export { fetchLive, parseSearchResponse };
