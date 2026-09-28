/**
 * The npm dist-tag a version publishes under. npm refuses a prerelease without `--tag`, and a plain
 * `npm publish` would make it `latest`, which is what `npm i @gamerelay/sdk` installs.
 *
 *   0.1.0-alpha.0 → alpha      1.0.0-rc.1 → rc      1.0.0 → latest
 *
 *   npm publish --tag "$(bun scripts/dist-tag.ts)"    # prints the tag for ./package.json
 */
export function distTag(version: string): string {
  const pre = version.split('+')[0]!.split('-').slice(1).join('-');
  if (!pre) return 'latest';
  return pre.match(/^[a-z]+/i)?.[0].toLowerCase() ?? 'next';
}

if (import.meta.main) {
  const { version } = await Bun.file('package.json').json();
  console.log(distTag(version));
}
