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
  /** Places the vehicle stood still long enough to be worth asking about. */
  readonly stops?: TrackResponse['stops'];
  readonly height?: number;
  readonly label?: string;
}

/** Duration as a person would say it, for a marker tooltip. */
function spokenDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} мин`;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}

export function RouteMap({ track, stops = [], height = 420, label }: RouteMapProps) {
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
        /**
         * Wheel zoom is off until the map is clicked, then on until focus leaves.
         *
         * Both halves matter. A map that zooms whenever a wheel passes over it hijacks the page —
         * someone scrolling to the figures below ends up looking at a street. But zoom is the
         * whole point of a route: "where did they go" is a question you answer by going in. So the
         * gesture is armed by a deliberate click, which is also what a reader does before trying
         * to zoom, and disarmed when they leave.
         */
        scrollWheelZoom: false,
        // Two-finger pinch on a touch screen never has the ambiguity a wheel does.
        touchZoom: true,
        attributionControl: true,
      });
      mapRef.current = map;

      map.on('click focus', () => map?.scrollWheelZoom.enable());
      map.on('mouseout blur', () => map?.scrollWheelZoom.disable());

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

      /**
       * The stops, drawn on top of the line.
       *
       * A parked vehicle and a passing one draw the same pixel, so without these the forty
       * minutes in a yard are simply not in the picture. Sized by duration — a two-hour stop is a
       * bigger fact than a twenty-minute one — but clamped, because a marker that swallows the
       * route it sits on stops being information.
       *
       * The tooltip is permanently open rather than on hover: these are the reason the map was
       * opened, and hiding them behind a hover means they are invisible on a phone and invisible
       * in a screenshot.
       */
      for (const stop of stops) {
        const radius = Math.min(16, 8 + Math.round(stop.seconds / 1800) * 2);
        L.circleMarker([stop.latitude, stop.longitude], {
          radius,
          color: '#B45309',
          fillColor: '#F59E0B',
          fillOpacity: 0.85,
          weight: 2,
        })
          .addTo(map)
          .bindTooltip(
            `${spokenDuration(stop.seconds)} · ${clockTime(stop.startedAt)}–${clockTime(stop.endedAt)}`,
            { permanent: true, direction: 'top', className: 'ay-map-tooltip', opacity: 1 },
          );
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
  }, [track, stops]);

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
      <p className="ay-caption ay-subtle" style={{ marginTop: 'var(--ay-space-2)' }}>
        Приближавайте с бутоните + и −, с колелцето след щракване върху картата, или с два пръста.
      </p>
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
        {stops.length > 0 ? (
          <span className="ay-legend-item">
            <span
              className="ay-legend-swatch"
              style={{ background: '#F59E0B' }}
              aria-hidden="true"
            />
            Престой над 20 минути
          </span>
        ) : null}
      </div>
    </div>
  );
}
