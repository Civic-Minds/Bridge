export interface Vehicle {
  id: string;
  routeTag: string;
  lat: number;
  lon: number;
  speed: number;
  heading: number;
  dirTag: string;
  isStalled: boolean;
}

export interface RouteMetrics {
  activeCount: number;
  bunching: number;
  slow: number;
}

export interface RouteState {
  tag: string;
  title: string;
  color: string;
  stops: unknown[];
  paths: unknown[];
  vehicles: Vehicle[];
  metrics: RouteMetrics;
  lastUpdated: number | null;
}

export interface ConflictZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
}
