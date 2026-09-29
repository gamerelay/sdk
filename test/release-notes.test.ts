import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { releaseNotes } from '../scripts/release-notes';

const changelog = ['# Changelog', '', '## Unreleased', '', '- next', '', '## 0.1.0 (2026-10-01)', '', '- one', '- two', '', '## 0.1.0-alpha.1', '', '- old', ''].join('\n');

describe('release notes', () => {
  test("a version's section, with or without a date after the heading", () => {
    expect(releaseNotes(changelog, '0.1.0')).toBe('- one\n- two');
    expect(releaseNotes(changelog, '0.1.0-alpha.1')).toBe('- old');
    expect(releaseNotes(changelog, 'Unreleased')).toBe('- next');
  });

  test("a version with no heading has no notes, and a prefix doesn't match", () => {
    expect(releaseNotes(changelog, '0.2.0')).toBeNull();
    expect(releaseNotes(changelog, '0.1')).toBeNull();
  });

  test('CHANGELOG.md has a section for every version on npm so far', async () => {
    const text = await Bun.file(join(import.meta.dir, '../CHANGELOG.md')).text();
    for (const v of ['0.1.0-alpha.0', '0.1.0-alpha.1']) expect(releaseNotes(text, v)).toBeTruthy();
  });
});
