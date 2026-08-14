import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../sw.js', import.meta.url));
const source = readFileSync(workerPath, 'utf8');

test('service worker versions the cache and includes the application core module', () => {
  assert.match(source, /const CACHE_NAME = 'pouchlog-v1\.4'/);
  assert.match(source, /['"]\.\/app-core\.mjs['"]/);
});

test('documents and mutable first-party application files use network-first', () => {
  assert.match(source, /function networkFirst\(/);
  assert.match(source, /function isMutableAppRequest\(/);
  assert.match(source, /['"]\/data\.js['"]/);
  assert.match(source, /['"]\/app-core\.mjs['"]/);
  assert.match(source, /isDocumentRequest\(event\.request\)\s*\|\|\s*isMutableAppRequest\(event\.request\)/);
  assert.match(source, /event\.respondWith\(networkFirst\(event\.request\)\)/);
});

test('remaining assets use stale-while-revalidate with a network fallback', () => {
  assert.match(source, /function staleWhileRevalidate\(/);
  assert.match(source, /event\.respondWith\(staleWhileRevalidate\(event\.request\)\)/);
  assert.match(source, /const networkResponse = fetch\(request\)/);
});
