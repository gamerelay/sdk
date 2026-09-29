/**
 * Print a version's notes from CHANGELOG.md: everything under its `## <version>` heading, up to
 * the next one. CI uses it for the GitHub release; `release:sdk` checks the section exists.
 *
 *   bun scripts/release-notes.ts               # the version in package.json
 *   bun scripts/release-notes.ts 0.1.0-alpha.2
 */
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** The notes under `## <version>` (a date after it is fine), or null if there's no such heading. */
export function releaseNotes(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

if (import.meta.main) {
  const version = process.argv[2] ?? (await Bun.file(join(root, 'package.json')).json()).version;
  const notes = releaseNotes(await Bun.file(join(root, 'CHANGELOG.md')).text(), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no "## ${version}" section`);
    process.exit(1);
  }
  console.log(notes);
}
