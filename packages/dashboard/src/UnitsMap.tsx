import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as L from 'leaflet';
import type { IngestedReading } from '@snowball/shared';
import type { UnitWithReading } from './api';
import { boundsOf, FALLBACK_CENTER, FALLBACK_ZOOM, mapPoints, markerClass, type MapPoint } from './map';
import type { UnitStatus } from './status';

/**
 * Fleet map: one dot per positioned unit, coloured by the very same
 * readingStatus() the cards use. It accompanies the cards, it does not replace
 * them — temperature, battery, humidity and the sparkline only live there.
 *
 * Plain Leaflet inside two effects, no react-leaflet: the whole surface is one
 * tile layer plus N circle markers, so the wrapper would not pay for itself
 * (same reasoning as Sparkline.tsx about chart libraries).
 *
 * circleMarker, never L.marker: L.Icon.Default guesses its PNG URLs from the
 * background-image of .leaflet-default-icon-path, and the hashed asset names
 * Vite emits break that heuristic (broken/invisible pins). Circle markers are
 * also the only thing we can paint from CSS, which is what keeps every colour
 * in styles.css instead of hardcoded here.
 */

interface Props {
  units: UnitWithReading[];
  history: Record<string, IngestedReading[]>;
  nowMs: number;
  selected: string | null;
  onSelect: (unitId: string) => void;
}

const TILE_URL: string = import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
/** Required by the OSM tile usage policy: always visible, never hidden. */
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MARKER_RADIUS = 7;
const FIT_OPTIONS: L.FitBoundsOptions = { padding: [24, 24], maxZoom: 16 };

interface MarkerEntry {
  marker: L.CircleMarker;
  status: UnitStatus;
  selected: boolean;
}

export function UnitsMap({ units, history, nowMs, selected, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef(new Map<string, MarkerEntry>());
  const didFitRef = useRef(false);
  const lastSelectedRef = useRef<string | null>(null);
  // onSelect is an inline arrow in App, so it changes on every render; keeping
  // it in a ref lets the marker handlers stay fresh without re-running effects.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const { points, unpositioned } = useMemo(() => mapPoints(units, history, nowMs), [units, history, nowMs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // preferCanvas stays false on purpose: the canvas renderer draws every
    // marker into one element, so there would be no per-marker node to style
    // and the CSS colours above could not work.
    const map = L.map(container, { preferCanvas: false });
    map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);

    return () => {
      // Mandatory: without remove() the StrictMode double mount (main.tsx)
      // throws "Map container is already initialized" in dev.
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      // The markers belonged to the map that just died, and the next mount has
      // to frame itself again from scratch.
      markersRef.current.clear();
      didFitRef.current = false;
      lastSelectedRef.current = null;
    };
  }, []);

  const fit = useCallback((framed: MapPoint[]) => {
    const map = mapRef.current;
    const bounds = boundsOf(framed);
    if (!map || !bounds) return;
    map.fitBounds([
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ], FIT_OPTIONS);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    const markers = markersRef.current;
    const live = new Set<string>();

    for (const point of points) {
      live.add(point.unit_id);
      const isSelected = point.unit_id === selected;
      const entry = markers.get(point.unit_id);

      if (!entry) {
        // No `weight` here: Leaflet writes it as a presentation attribute, which
        // loses against the stylesheet, so .unit-marker's stroke-width is what
        // actually applies. Setting it in both places would be a second, dead
        // definition of the same thing.
        const marker = L.circleMarker([point.lat, point.lon], {
          radius: MARKER_RADIUS,
          className: markerClass(point.status, isSelected),
        });
        // The very same callback (and toggle) the cards use, so clicking a
        // marker and clicking a card cannot end up with different selections.
        marker.on('click', () => onSelectRef.current(point.unit_id));
        marker.addTo(layer);
        markers.set(point.unit_id, { marker, status: point.status, selected: isSelected });
        if (isSelected) marker.bringToFront();
        continue;
      }

      entry.marker.setLatLng([point.lat, point.lon]);
      if (entry.status !== point.status || entry.selected !== isSelected) {
        // setStyle() cannot do this: Leaflet applies options.className only in
        // _initPath. Diffing the two class strings keeps markerClass() the one
        // place that names a class and leaves Leaflet's own classes (notably
        // leaflet-interactive, which is what makes the click work) untouched.
        const before = markerClass(entry.status, entry.selected).split(' ');
        const after = markerClass(point.status, isSelected).split(' ');
        const element = entry.marker.getElement();
        // The bookkeeping only advances once the DOM actually changed. If it were
        // updated unconditionally and getElement() ever returned nothing, the entry
        // would claim the new status while the element kept the old classes, the
        // next diff would find nothing to do, and the marker would stay the wrong
        // colour for good -- an excursion drawn green, which is the one failure
        // this map must not have.
        if (element) {
          for (const name of before) if (!after.includes(name)) element.classList.remove(name);
          for (const name of after) if (!before.includes(name)) element.classList.add(name);
          entry.marker.options.className = after.join(' ');
          entry.status = point.status;
          entry.selected = isSelected;
        }
      }
      if (isSelected) entry.marker.bringToFront();
    }

    for (const [unitId, entry] of markers) {
      if (live.has(unitId)) continue;
      layer.removeLayer(entry.marker);
      markers.delete(unitId);
    }

    // Framed once, on the first render that has something to frame. New
    // readings only move the markers: re-framing on every live reading would
    // yank the map out of the user's hands several times a minute.
    if (!didFitRef.current && points.length > 0) {
      didFitRef.current = true;
      fit(points);
    }

    // Pan only when the selection actually changed, otherwise the 5 s clock
    // tick in App would keep re-centring the map.
    if (selected !== lastSelectedRef.current) {
      lastSelectedRef.current = selected;
      const target = points.find((p) => p.unit_id === selected);
      if (target) map.panTo([target.lat, target.lon], { animate: true });
    }
  }, [points, selected, fit]);

  return (
    <>
      <div className="map-toolbar">
        <button className="link" onClick={() => fit(points)} disabled={points.length === 0}>
          Encuadrar
        </button>
      </div>
      <div className="units-map" ref={containerRef} />
      {unpositioned.length > 0 && (
        <p className="empty">
          {unpositioned.length} unidad(es) sin posición: {unpositioned.join(', ')}
        </p>
      )}
    </>
  );
}
