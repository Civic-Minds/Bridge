import { loadAtlasStatic } from '../atlasStatic';

describe('Atlas static-artifact adapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps route geometry and the longest ordered stop list', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/atlas/ttc.json')) {
        return {
          ok: true,
          json: async () => ({ type: 'FeatureCollection', features: [
            { geometry: { type: 'LineString', coordinates: [[-79.4, 43.6], [-79.41, 43.61]] }, properties: { routeShortName: '510', stopOrder: ['a'] } },
            { geometry: { type: 'LineString', coordinates: [[-79.41, 43.61], [-79.42, 43.62]] }, properties: { routeShortName: '510', stopOrder: ['a', 'b'] } },
            { geometry: { type: 'LineString', coordinates: [[-79.4, 43.6], [-79.41, 43.61]] }, properties: { routeShortName: '510', isCorridor: true, stopOrder: ['a', 'b', 'c'] } },
          ] }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ a: { name: 'Alpha', lat: 43.6, lon: -79.4 }, b: { name: 'Beta', lat: 43.61, lon: -79.41 } }),
      } as Response;
    }) as typeof fetch;

    const routes = await loadAtlasStatic(['510']);
    expect(routes.get('510')).toEqual({
      paths: [[[43.6, -79.4], [43.61, -79.41]], [[43.61, -79.41], [43.62, -79.42]]],
      stops: [
        { id: 'a', name: 'Alpha', lat: 43.6, lon: -79.4 },
        { id: 'b', name: 'Beta', lat: 43.61, lon: -79.41 },
      ],
    });
  });
});
