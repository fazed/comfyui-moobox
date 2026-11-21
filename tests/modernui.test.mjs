import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryPath, modernLoraPath, modernUiAvailable, resetModernUiProbe } from '../web/modernui.js';

const BASE = 'http://127.0.0.1:8188/proxy/';
const served = (status) => async () => ({ ok: status >= 200 && status < 300, status });

test('the library opens in the modern UI only when it was found', () => {
  assert.equal(libraryPath(true), 'lm-ui/loras');
  assert.equal(libraryPath(false), 'loras');
  assert.equal(libraryPath(null), 'loras');
});

test('modern LoRA links use forward slashes and encode every special character', () => {
  const cases = [
    ['C:\\models\\loras\\art\\ink.safetensors', 'C%3A%2Fmodels%2Floras%2Fart%2Fink.safetensors'],
    ['D:/My Models/a&b #1?.safetensors', 'D%3A%2FMy%20Models%2Fa%26b%20%231%3F.safetensors'],
    ['/home/me/lora/ünïcødé 日本.safetensors', '%2Fhome%2Fme%2Flora%2F%C3%BCn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC.safetensors'],
  ];
  for (const [path, encoded] of cases) {
    const url = new URL(modernLoraPath(path), BASE);
    assert.equal(url.href, `${BASE}lm-ui/loras?open=${encoded}`);
    assert.equal(url.searchParams.get('open'), path.replaceAll('\\', '/'));
    assert.equal(url.hash, '');
  }
  assert.equal(modernLoraPath(''), null);
  assert.equal(modernLoraPath(undefined), null);
});

test('a served /lm-ui/ means modern; the probe runs once and goes to the base path', async () => {
  resetModernUiProbe();
  const calls = [];
  const fetchFn = async (url, options) => { calls.push([String(url), options.method]); return { ok: true, status: 200 }; };
  assert.equal(await modernUiAvailable(BASE, fetchFn), true);
  assert.equal(await modernUiAvailable(BASE, fetchFn), true);
  assert.deepEqual(calls, [[`${BASE}lm-ui/`, 'HEAD']]);
});

for (const [label, fetchFn] of [
  ['404', served(404)],
  ['503 (UI not built)', served(503)],
  ['a network error', async () => { throw new TypeError('Failed to fetch'); }],
]) {
  test(`${label} falls back to the classic UI`, async () => {
    resetModernUiProbe();
    assert.equal(await modernUiAvailable(BASE, fetchFn), false);
  });
}

test('a probe that does not answer in time falls back to classic without cancelling the probe', async () => {
  resetModernUiProbe();
  let answer;
  const fetchFn = () => new Promise((resolve) => { answer = resolve; });
  assert.equal(await modernUiAvailable(BASE, fetchFn, 10), false);
  answer({ ok: true, status: 200 });
  assert.equal(await modernUiAvailable(BASE, fetchFn, 10), true);
});
