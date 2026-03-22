import { getDistance, detectBunching } from '../analysis';
import { Vehicle } from '../types';

function makeVehicle(overrides: Partial<Vehicle>): Vehicle {
  return {
    id: 'v1',
    routeTag: '510',
    lat: 43.6482,
    lon: -79.3962,
    speed: 10,
    heading: 90,
    dirTag: '0',
    isStalled: false,
    ...overrides,
  };
}

describe('getDistance', () => {
  it('returns ~0 for identical coordinates', () => {
    expect(getDistance(43.6482, -79.3962, 43.6482, -79.3962)).toBeCloseTo(0, 1);
  });

  it('returns approximately correct distance for two known coords', () => {
    // Spadina & Queen to King & Spadina — roughly 280m apart
    const d = getDistance(43.6482, -79.3962, 43.6457, -79.3952);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(400);
  });

  it('returns approximately 111 km per degree of latitude', () => {
    const d = getDistance(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe('detectBunching', () => {
  it('returns 0 for an empty array', () => {
    expect(detectBunching([])).toBe(0);
  });

  it('returns 1 when two vehicles are < 150m apart on the same dirTag', () => {
    // ~50m apart (small lat offset)
    const v1 = makeVehicle({ id: 'v1', lat: 43.6482, lon: -79.3962, dirTag: '0' });
    const v2 = makeVehicle({ id: 'v2', lat: 43.6482 + 0.0004, lon: -79.3962, dirTag: '0' });
    expect(detectBunching([v1, v2])).toBe(1);
  });

  it('returns 0 when two vehicles are > 150m apart on the same dirTag', () => {
    // ~280m apart
    const v1 = makeVehicle({ id: 'v1', lat: 43.6482, lon: -79.3962, dirTag: '0' });
    const v2 = makeVehicle({ id: 'v2', lat: 43.6457, lon: -79.3952, dirTag: '0' });
    expect(detectBunching([v1, v2])).toBe(0);
  });

  it('returns 0 when two vehicles are < 150m apart but on different dirTags', () => {
    const v1 = makeVehicle({ id: 'v1', lat: 43.6482, lon: -79.3962, dirTag: '0' });
    const v2 = makeVehicle({ id: 'v2', lat: 43.6482 + 0.0004, lon: -79.3962, dirTag: '1' });
    expect(detectBunching([v1, v2])).toBe(0);
  });

  it('returns 0 when vehicles have empty dirTags', () => {
    const v1 = makeVehicle({ id: 'v1', lat: 43.6482, lon: -79.3962, dirTag: '' });
    const v2 = makeVehicle({ id: 'v2', lat: 43.6482 + 0.0004, lon: -79.3962, dirTag: '' });
    expect(detectBunching([v1, v2])).toBe(0);
  });
});
