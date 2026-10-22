import { afterEach, describe, expect, test } from 'bun:test';
import { netease } from '../server/lyrics/netease';

/**
 * Fixtures follow the shape music.163.com returns: search gives metadata only,
 * and each song's lyrics come from a second request.
 */

const SONGS = [
  { id: 1, name: '紅蓮華', artists: [{ name: 'LiSA' }], album: { name: '紅蓮華' }, duration: 236000 },
  { id: 2, name: '孤勇者', artists: [{ name: '陈奕迅' }], album: null, duration: 256000 },
  { id: 3, name: '毒回り', artists: [{ name: 'harenuki' }], album: null, duration: 200000 },
];

const LYRICS: Record<number, string> = {
  1: '[00:00.000] 作词 : LiSA\n[00:00.193] 作曲 : 草野華余子\n[00:00.780]強くなれる理由を知った\n[00:07.298]僕を連れて　進め',
  2: '[00:00.000] 作词 : 唐恬\n[00:10.000]都是勇敢的\n[00:15.000]你额头的伤口',
  3: '',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/search/get')) {
      return Response.json({ result: { songs: SONGS } });
    }
    if (url.pathname.endsWith('/song/lyric')) {
      return Response.json({ lrc: { lyric: LYRICS[Number(url.searchParams.get('id'))] } });
    }
    if (url.pathname.endsWith('/song/detail')) {
      const id = Number(JSON.parse(url.searchParams.get('ids') ?? '[]')[0]);
      return Response.json({ songs: SONGS.filter((s) => s.id === id) });
    }
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

describe('netease', () => {
  test('search keeps only songs with Japanese lyrics and strips credit lines', async () => {
    stubFetch();
    const records = await netease.search('紅蓮華');
    expect(records).toEqual([
      {
        provider: 'netease',
        id: 1,
        trackName: '紅蓮華',
        artistName: 'LiSA',
        albumName: '紅蓮華',
        duration: 236,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: '[00:00.780]強くなれる理由を知った\n[00:07.298]僕を連れて　進め',
      },
    ]);
  });

  test('get by id returns the same record search did', async () => {
    stubFetch();
    const record = await netease.get(1);
    expect(record.trackName).toBe('紅蓮華');
    expect(record.syncedLyrics).toBe('[00:00.780]強くなれる理由を知った\n[00:07.298]僕を連れて　進め');
  });

  test('get rejects a song whose lyrics are empty', async () => {
    stubFetch();
    expect(netease.get(3)).rejects.toThrow('lyrics not found');
  });
});
