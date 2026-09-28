import { expect, test } from 'bun:test';
import { distTag } from '../scripts/dist-tag';

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
