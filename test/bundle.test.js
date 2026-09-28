import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle, OUTPUT } from '../tools/bundle.mjs';

test('iluboard.mjs is up to date with tools/iluboard.mjs and src/core (run: npm run bundle)', () => {
  const current = readFileSync(new URL(`../${OUTPUT}`, import.meta.url), 'utf8');
  assert.equal(current, bundle());
});
