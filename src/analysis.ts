import { Vehicle } from './types';

export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function detectBunching(vehicles: Vehicle[]): number {
  let bunchingCount = 0;
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const v1 = vehicles[i];
      const v2 = vehicles[j];
      if (v1.dirTag && v2.dirTag && v1.dirTag === v2.dirTag) {
        if (getDistance(v1.lat, v1.lon, v2.lat, v2.lon) < 150) {
          bunchingCount++;
        }
      }
    }
  }
  return bunchingCount;
}
