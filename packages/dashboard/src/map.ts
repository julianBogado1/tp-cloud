/**
 * Pure helpers behind the units map (kept DOM-free and Leaflet-free for tests).
 *
 * Everything that can be decided without a browser lives here: which units are
 * positioned, what status each one has, how to frame them, and which CSS class
 * paints them. UnitsMap.tsx is left with the imperative Leaflet calls only.
 */

import type { IngestedReading } from '@snowball/shared';
import type { UnitWithReading } from './api';
import { readingStatus, type UnitStatus } from './status';

/** One unit rendered on the map: already positioned and already classified. */
export interface MapPoint {
  unit_id: string;
  lat: number;
  lon: number;
  status: UnitStatus;
}

/** Plain bounds, so this module stays free of Leaflet types. */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Where an empty map looks: the origin of the simulated fleet
 * (packages/simulator/src/telemetry.ts), not an arbitrary point, so the view
 * already shows the region where the first markers will appear.
 */
export const FALLBACK_CENTER: [number, number] = [-34.6037, -58.3816];
export const FALLBACK_ZOOM = 10;

/** The live tail wins over the snapshot from /api/units; mirrors UnitCard. */
export function latestReading(unit: UnitWithReading, history: IngestedReading[]): IngestedReading | null {
  return history.length > 0 ? history[history.length - 1] : unit.last_reading;
}

/**
 * Stricter than the card's GPS guard on purpose: L.latLng throws on NaN and
 * App has no error boundary, so one bad item would blank the whole dashboard.
 * Out-of-range values do not throw but project garbage, hence the range check.
 */
function hasPosition(reading: IngestedReading | null): reading is IngestedReading {
  return (
    !!reading &&
    Number.isFinite(reading.lat) &&
    Number.isFinite(reading.lon) &&
    Math.abs(reading.lat) <= 90 &&
    Math.abs(reading.lon) <= 180
  );
}

/** Single pass: positioned points (with status) and the ids left out. */
export function mapPoints(
  units: UnitWithReading[],
  history: Record<string, IngestedReading[]>,
  nowMs: number,
): { points: MapPoint[]; unpositioned: string[] } {
  const points: MapPoint[] = [];
  const unpositioned: string[] = [];

  for (const unit of units) {
    const last = latestReading(unit, history[unit.unit_id] ?? []);
    if (!hasPosition(last)) {
      unpositioned.push(unit.unit_id);
      continue;
    }
    points.push({
      unit_id: unit.unit_id,
      lat: last.lat,
      lon: last.lon,
      // Same call the card makes, so marker and card can never disagree.
      status: readingStatus(last, unit, nowMs),
    });
  }

  return { points, unpositioned };
}

/** null when there is nothing to frame. */
export function boundsOf(points: MapPoint[]): MapBounds | null {
  if (points.length === 0) return null;

  let south = points[0].lat;
  let north = points[0].lat;
  let west = points[0].lon;
  let east = points[0].lon;

  for (const point of points) {
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
  }

  return { south, west, north, east };
}

/**
 * The only place that names a marker CSS class. The colour itself comes from
 * styles.css (var(--ok|--excursion|--stale)): Leaflet writes stroke/fill as
 * presentation *attributes*, which lose against any stylesheet rule, so no
 * colour literal is ever needed here.
 */
export function markerClass(status: UnitStatus, selected: boolean): string {
  return `unit-marker unit-marker-${status}${selected ? ' unit-marker-selected' : ''}`;
}
