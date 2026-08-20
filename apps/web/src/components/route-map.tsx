'use client';

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap, Polyline } from 'leaflet';
// Leaflet's own stylesheet. Without it the tiles stack in a column instead of forming a map —
// a failure that looks like broken data rather than a missing import.
import 'leaflet/dist/leaflet.css';
import type { TrackResponse } from '../lib/admin';

/**
 * A driven route, drawn from the points the vehicle actually reported.
 *
 * The whole design of this component is one rule: **the line breaks where the data breaks.**
 *
 * `gapAfterIndices` names the points after which the server refused to bridge — a silence longer
 * than five minutes, where a straight line would be a guess about a road the vehicle may never
 * have taken. So the track is drawn as several polylines rather than one, with a dashed hint
 * across each hole so a reader can see that something is missing rather than wonder why the line
 * stops. The dash is deliberately a different colour and style: it says "we do not know", not
 * "this is where they went".
 *
 * Leaflet is loaded dynamically. It touches `window` on import, so a static import would break
 * the server render; and a map is a heavy thing to ship to a phone that only ever opens the
 * worker portal.
 */

export interface RouteMapProps {
  readonly track: TrackResponse['track'];
  readonly height?: number;
  readonly label?: string;
}

export function RouteMap({ track, height = 420, label }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: LeafletMap | null = null;

    void (async () => {
      const L = await import('leaflet');
      // A second effect run (React 18 strict mode, or a prop change) must not initialise a map
      // into a container that already has one — Leaflet throws on that.
      if (cancelled || !containerRef.current) return;

      map = L.map(container, {
        // Nothing here is a gesture the reader needs, and a map that zooms when someone scrolls
        // past it hijacks the page. Zoom stays on the buttons.
        scrollWheelZoom: false,
        attributionControl: true,
      });
      mapRef.current = map;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        // Required by the OpenStreetMap tile usage policy, and simply correct: these are
        // somebody else's tiles.
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const points = track.points.map(
        (point) => [point.latitude, point.longitude] as [number, number],
      );
      if (points.length === 0) {
        // Sofia, so an empty map is still a map rather than the middle of the Atlantic.
        map.setView([42.6977, 23.3219], 11);
        return;
      }

      const breaks = new Set(track.gapAfterIndices);
      const segments: [number, number][][] = [];
      let current: [number, number][] = [];

      for (const [index, point] of points.entries()) {
        current.push(point);
        if (breaks.has(index)) {
          segments.push(current);
          current = [];
        }
      }
      if (current.length > 0) segments.push(current);

      const drawn: Polyline[] = [];
      for (const segment of segments) {
        if (segment.length < 2) {
          // A lone point between two gaps is still evidence the vehicle was there. Drawn as a
          // dot rather than dropped, because dropping it would hide a reported position.
          const only = segment[0];
          if (only) {
            L.circleMarker(only, { radius: 4, color: '#2563EB', fillOpacity: 1 }).addTo(map);
          }
          continue;
        }
        drawn.push(L.polyline(segment, { color: '#2563EB', weight: 4, opacity: 0.9 }).addTo(map));
      }

      // The holes, shown as what they are: an unknown. Dashed, grey, and never counted as
      // distance — the figures beside the map exclude these entirely.
      for (let i = 0; i < segments.length - 1; i += 1) {
        const endOfSegment = segments[i]?.at(-1);
        const startOfNext = segments[i + 1]?.[0];
        if (!endOfSegment || !startOfNext) continue;
        L.polyline([endOfSegment, startOfNext], {
          color: '#94A3B8',
          weight: 2,
          opacity: 0.7,
          dashArray: '6 8',
        }).addTo(map);
      }

      const start = points[0];
      const end = points.at(-1);
      if (start) {
        L.circleMarker(start, { radius: 7, color: '#22C55E', fillColor: '#22C55E', fillOpacity: 1 })
          .addTo(map)
          .bindTooltip('Начало');
      }
      if (end && points.length > 1) {
        L.circleMarker(end, { radius: 7, color: '#DC2626', fillColor: '#DC2626', fillOpacity: 1 })
          .addTo(map)
          .bindTooltip('Край');
      }

      const bounds =
        drawn.length > 0
          ? drawn.reduce(
              (accumulated, line) => accumulated.extend(line.getBounds()),
              drawn[0]!.getBounds(),
            )
          : L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [24, 24] });
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [track]);

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          height,
          width: '100%',
          borderRadius: 'var(--ay-radius-lg)',
          // Leaflet paints its own white ground. Without this the map's corners escape the card
          // in dark mode and it reads as a rendering bug.
          overflow: 'hidden',
          background: 'var(--ay-surface-sunken)',
        }}
        role="img"
        aria-label={label ?? 'Карта на маршрута'}
      />
      <div className="ay-legend" style={{ marginTop: 'var(--ay-space-3)' }}>
        <span className="ay-legend-item">
          <span className="ay-legend-swatch" style={{ background: '#2563EB' }} aria-hidden="true" />
          Записан маршрут
        </span>
        <span className="ay-legend-item">
          <span
            className="ay-legend-swatch"
            style={{ background: '#94A3B8', opacity: 0.7 }}
            aria-hidden="true"
          />
          Без данни — не се брои за разстояние
        </span>
      </div>
    </div>
  );
}
