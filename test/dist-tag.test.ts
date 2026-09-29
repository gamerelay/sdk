import { expect, test } from 'bun:test';
import { distTag, movesLatest } from '../scripts/dist-tag';

test('a prerelease publishes under its label; a plain version is latest', () => {
  expect(distTag('0.1.0-alpha.0')).toBe('alpha');
  expect(distTag('0.2.0-beta.3')).toBe('beta');
  expect(distTag('1.0.0-rc.1')).toBe('rc');
  expect(distTag('1.0.0-alpha')).toBe('alpha');
  expect(distTag('1.0.0')).toBe('latest');
  expect(distTag('1.0.0+build.5')).toBe('latest'); // build metadata isn't a prerelease
});

test('a prerelease without a word label still stays off latest', () => {
  expect(distTag('1.0.0-0')).toBe('next');
});

test('every alpha also moves latest, until a stable version is latest', () => {
  expect(movesLatest('0.1.0-alpha.2', '0.1.0-alpha.1')).toBe(true);
  expect(movesLatest('0.1.0-alpha.0', undefined)).toBe(true); // first publish
  expect(movesLatest('0.2.0-beta.0', '0.1.0-alpha.3')).toBe(false); // only alphas
  expect(movesLatest('1.1.0-alpha.0', '1.0.0')).toBe(false); // never replaces a stable release
  expect(movesLatest('1.0.0', '0.9.0-alpha.4')).toBe(false); // published as latest already
});
