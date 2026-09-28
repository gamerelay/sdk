import type { PlayerId } from '@gamerelay/protocol/types';

/** Where the host keeps teams in `room.state` (read them with `room.teamOf(id)`). */
export const TEAMS_KEY = '$teams';
/** How many teams: set by `room.assignTeams(n)`; while set, the host places joiners automatically. */
export const TEAM_COUNT_KEY = '$teamCount';

/**
 * Everyone in `players` (join order) on one of `n` teams. Keeps current teams (nobody moves
 * mid-round) and puts newcomers on the smallest team, lowest index on a tie. With `rebalance`, it
 * also moves the latest joiners off the biggest teams until sizes differ by at most one. Players
 * not in `players` drop out.
 */
export function balanceTeams(players: PlayerId[], current: Record<PlayerId, number>, n: number, rebalance: boolean): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  const members: PlayerId[][] = Array.from({ length: n }, () => []);
  const smallest = () => members.reduce((best, m, i) => (m.length < members[best]!.length ? i : best), 0);
  for (const id of players) {
    const team = current[id];
    if (typeof team === 'number' && Number.isInteger(team) && team >= 0 && team < n) members[team]!.push(id);
  }
  for (const id of players) {
    if (members.some((m) => m.includes(id))) continue;
    members[smallest()]!.push(id);
  }
  if (rebalance) {
    for (;;) {
      const big = members.reduce((best, m, i) => (m.length > members[best]!.length ? i : best), 0);
      const small = smallest();
      if (members[big]!.length - members[small]!.length <= 1) break;
      // The latest joiner on the big team moves.
      const order = members[big]!.slice().sort((x, y) => players.indexOf(x) - players.indexOf(y));
      const mover = order.at(-1)!;
      members[big] = members[big]!.filter((id) => id !== mover);
      members[small]!.push(mover);
    }
  }
  members.forEach((m, team) => m.forEach((id) => (out[id] = team)));
  // Join order, so the result reads naturally.
  return Object.fromEntries(players.filter((id) => id in out).map((id) => [id, out[id]!]));
}
