/**
 * The npm dist-tag a version publishes under. npm refuses a prerelease without `--tag`, and a plain
 * `npm publish` would make it `latest`, which is what `npm i @gamerelay/sdk` installs.
 *
 *   0.1.0-alpha.0 → alpha      1.0.0-rc.1 → rc      1.0.0 → latest
 *
 *   npm publish --tag "$(bun scripts/dist-tag.ts)"          # prints the tag for ./package.json
 *   bun scripts/dist-tag.ts --moves-latest <current latest>  # prints true or false
 */
export function distTag(version: string): string {
  const pre = version.split('+')[0]!.split('-').slice(1).join('-');
  if (!pre) return 'latest';
  return pre.match(/^[a-z]+/i)?.[0].toLowerCase() ?? 'next';
}

/**
 * Whether publishing `version` should also point `latest` at it: every alpha does, while there's
 * no stable release yet, so `npm i @gamerelay/sdk` gets the newest alpha (the one llms.txt
 * describes). Once a stable version is `latest`, alphas stay on `alpha`.
 */
export function movesLatest(version: string, currentLatest: string | undefined): boolean {
  if (distTag(version) !== 'alpha') return false;
  return !currentLatest || distTag(currentLatest) !== 'latest';
}

if (import.meta.main) {
  const { version } = await Bun.file('package.json').json();
  const at = process.argv.indexOf('--moves-latest');
  console.log(at === -1 ? distTag(version) : String(movesLatest(version, process.argv[at + 1] || undefined)));
}
