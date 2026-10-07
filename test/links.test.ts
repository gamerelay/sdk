import { afterEach, describe, expect, test } from 'bun:test';
import { answerRoom, connectFake, settle } from './fakeRelay';
import { control } from '../src/internal';

// Short links in the SDK: `room.shareLink()`, `relay.joinLink()`, and `joinInvite()` reading
// `?join=` (the server side, and the link page, are apps/server/test/links.test.ts).

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  delete (globalThis as { location?: unknown }).location;
});

async function inRoom() {
  const f = await connectFake('pa');
  cleanup = f.done;
  const entering = f.relay.createRoom({ linkOnly: true });
  await settle();
  expect(f.socket().sentOf('create_room').at(-1)).toMatchObject({ linkOnly: true });
  answerRoom(f.socket(), 'create_room', 'pa');
  return { ...f, room: await entering };
}

describe('short links', () => {
  test("shareLink: the server's URL, asked once for the room's life", async () => {
    const { room, socket } = await inRoom();
    const a = room.shareLink();
    const b = room.shareLink();
    await settle();
    expect(socket().sentOf('share_link')).toHaveLength(1);
    socket().deliver({ t: 'reply', rid: socket().sentOf('share_link')[0]!.rid, data: { link: 'ZumXpZzDsgo', url: 'https://gamerelay.io/racer/ZumXpZzDsgo' } });
    expect(await a).toBe('https://gamerelay.io/racer/ZumXpZzDsgo');
    expect(await b).toBe(await a);
  });

  test("without a slug (no URL from the server): this page's URL with ?join= in place of ?room=", async () => {
    (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play?room=ABCD&mode=1' };
    const { room, socket } = await inRoom();
    const p = room.shareLink();
    await settle();
    socket().deliver({ t: 'reply', rid: socket().sentOf('share_link')[0]!.rid, data: { link: 'ZumXpZzDsgo', url: null } });
    expect(await p).toBe('https://mygame.com/play?mode=1&join=ZumXpZzDsgo');
  });

  test("in a page, the link is fetched on entering, so shareInvite shares within the tap", async () => {
    (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
    const copied: string[] = [];
    const nav = globalThis.navigator as unknown as { clipboard?: unknown };
    const saved = nav.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    try {
      const { room, socket } = await inRoom();
      await settle();
      // Asked for without anyone calling shareLink.
      expect(socket().sentOf('share_link')).toHaveLength(1);
      socket().deliver({ t: 'reply', rid: socket().sentOf('share_link')[0]!.rid, data: { link: 'ZumXpZzDsgo', url: 'https://gamerelay.io/racer/ZumXpZzDsgo' } });
      await settle();
      // No round trip before the copy now.
      const done = room.shareInvite();
      expect(copied).toEqual(['https://gamerelay.io/racer/ZumXpZzDsgo']);
      expect(await done).toBe('copied');
      expect(socket().sentOf('share_link')).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: saved, configurable: true });
    }
  });

  test('a refused share_link (an older server) can be asked again', async () => {
    const { room, socket } = await inRoom();
    const p = room.shareLink();
    await settle();
    socket().deliver({ t: 'error', rid: socket().sentOf('share_link')[0]!.rid, code: 'bad_request', message: 'unknown message' });
    await expect(p).rejects.toMatchObject({ code: 'bad_request' });
    void room.shareLink().catch(() => {});
    await settle();
    expect(socket().sentOf('share_link')).toHaveLength(2);
  });

  test("a link-only room whose link can't be had isn't shared by its code (review notes, PR #61)", async () => {
    (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
    const copied: string[] = [];
    const nav = globalThis.navigator as unknown as { clipboard?: unknown };
    const saved = nav.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    try {
      const { room, socket } = await inRoom();
      control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: true, maxPlayers: 6, from: 'pa' });
      expect(room.linkOnly).toBe(true);
      await settle();
      socket().deliver({ t: 'error', rid: socket().sentOf('share_link')[0]!.rid, code: 'internal', message: 'blip' });
      await settle();
      const done = room.shareInvite();
      await settle();
      socket().deliver({ t: 'error', rid: socket().sentOf('share_link')[1]!.rid, code: 'internal', message: 'blip' });
      await expect(done).rejects.toMatchObject({ code: 'internal' });
      expect(copied).toEqual([]);
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: saved, configurable: true });
    }
  });

  describe('shareInvite fallbacks (review notes, PR #61)', () => {
    let copied: string[];
    let saved: unknown;
    const withClipboard = async (fn: () => Promise<void>) => {
      copied = [];
      const nav = globalThis.navigator as unknown as { clipboard?: unknown };
      saved = nav.clipboard;
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
      try {
        await fn();
      } finally {
        Object.defineProperty(globalThis.navigator, 'clipboard', { value: saved, configurable: true });
      }
    };
    const refuse = (socket: () => { sentOf(t: string): { rid?: number }[]; deliver(m: unknown): void }, i: number) =>
      socket().deliver({ t: 'error', rid: socket().sentOf('share_link')[i]!.rid, code: 'bad_request', message: 'unknown message' });

    test("an open room on a server without short links shares its code's link", () =>
      withClipboard(async () => {
        (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
        const { room, socket } = await inRoom();
        control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: false, maxPlayers: 6, from: 'pa' });
        await settle();
        refuse(socket, 0);
        await settle();
        const done = room.shareInvite();
        await settle();
        refuse(socket, 1);
        expect(await done).toBe('copied');
        expect(copied).toEqual([`https://mygame.com/play?room=${room.code}`]);
      }));

    test('a link-only room shares its link once it has it, with no fallback needed', () =>
      withClipboard(async () => {
        (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
        const { room, socket } = await inRoom();
        control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: true, maxPlayers: 6, from: 'pa' });
        await settle();
        socket().deliver({ t: 'reply', rid: socket().sentOf('share_link')[0]!.rid, data: { link: 'ZumXpZzDsgo', url: null } });
        await settle();
        expect(await room.shareInvite()).toBe('copied');
        expect(copied).toEqual(['https://mygame.com/play?join=ZumXpZzDsgo']);
        expect(copied[0]).not.toContain('room=');
      }));

    test('a room made link-only after it was entered gets no fallback either', () =>
      withClipboard(async () => {
        (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
        const { room, socket } = await inRoom();
        control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: false, maxPlayers: 6, from: 'pa' });
        await settle();
        refuse(socket, 0);
        await settle();
        // The host turns link-only on: from now on its code gets nobody in.
        control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: true, maxPlayers: 6, from: 'pa' });
        const done = room.shareInvite();
        await settle();
        refuse(socket, 1);
        await expect(done).rejects.toMatchObject({ code: 'bad_request' });
        expect(copied).toEqual([]);
      }));

    test('a link-only room that fails once can share on the next try', () =>
      withClipboard(async () => {
        (globalThis as { location?: unknown }).location = { href: 'https://mygame.com/play' };
        const { room, socket } = await inRoom();
        control(room).handle({ v: 1, t: 'access', locked: false, public: false, linkOnly: true, maxPlayers: 6, from: 'pa' });
        await settle();
        refuse(socket, 0);
        await settle();
        const first = room.shareInvite();
        await settle();
        refuse(socket, 1);
        await expect(first).rejects.toBeDefined();
        const second = room.shareInvite();
        await settle();
        socket().deliver({ t: 'reply', rid: socket().sentOf('share_link')[2]!.rid, data: { link: 'ZumXpZzDsgo', url: 'https://play.gamerelay.io/racer/ZumXpZzDsgo' } });
        expect(await second).toBe('copied');
        expect(copied).toEqual(['https://play.gamerelay.io/racer/ZumXpZzDsgo']);
      }));
  });

  test('joinLink, and joinInvite with ?join= (before ?room=)', async () => {
    const f = await connectFake('pb');
    cleanup = f.done;
    const joining = f.relay.joinInvite('https://mygame.com/play?room=ABCD&join=ZumXpZzDsgo');
    await settle();
    expect(f.socket().sentOf('join_link').at(-1)).toMatchObject({ link: 'ZumXpZzDsgo' });
    expect(f.socket().sentOf('join_room')).toHaveLength(0);
    answerRoom(f.socket(), 'join_link', 'pb');
    expect((await joining)?.code).toBe('ABCD');
    expect(await f.relay.joinInvite('https://mygame.com/play')).toBeNull();
  });

  test('setAccess sends linkOnly', async () => {
    const { room, socket } = await inRoom();
    void room.setAccess({ linkOnly: false }).catch(() => {});
    await settle();
    expect(socket().sentOf('set_access').at(-1)).toMatchObject({ linkOnly: false });
  });
});
