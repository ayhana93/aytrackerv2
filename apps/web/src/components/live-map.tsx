'use client';

import { useEffect, useRef } from 'react';
import type { CircleMarker, Map as LeafletMap } from 'leaflet';
// Leaflet's own stylesheet. Without it the tiles stack in a column instead of forming a map —
// a failure that looks like broken data rather than a missing import.
import 'leaflet/dist/leaflet.css';
import type { LiveSubject } from '../lib/admin';

/**
 * Everyone currently being tracked, on one map.
 *
 * Two rules shape this component.
 *
 * **Markers are moved, never redrawn.** A fleet of forty updates every fifteen seconds; tearing
 * down and rebuilding the layer each time makes the map flicker, throws away the popup somebody
 * had open, and fights the pan they were in the middle of. So each subject keeps its marker
 * across updates and only its position, colour and tooltip change.
 *
 * **Colour is semantic, never decorative.** It encodes the tracking state and nothing else —
 * green is "reporting now", amber is "late", grey is "we have not heard from this device". Grey
 * is not an accusation: a tunnel, a flat battery and a force-quit all land there, because from
 * the server they are the same thing.
 *
 * Leaflet is imported dynamically. It touches `window` at module scope, so a static import
 * breaks the server render.
 */

export interface LiveMapProps {
  readonly subjects: readonly LiveSubject[];
  readonly height?: number;
  readonly onSelect?: (subject: LiveSubject) => void;
}

/** The state colours. Read from the tokens so the map matches the badges beside it. */
const STATE_COLOR: Readonly<Record<string, string>> = {
  ACTIVE: '#10b981',
  DEGRADED: '#f59e0b',
  OFFLINE: '#f59e0b',
  INTERRUPTED: '#94a3b8',
  PAUSED: '#94a3b8',
  STOPPED: '#94a3b8',
};

function tooltip(subject: LiveSubject): string {
  const lines = [subject.name];
  if (subject.vehicle) {
    lines.push(
      `${subject.vehicle.registrationNumber} · ${subject.vehicle.make} ${subject.vehicle.model}`,
    );
  } else if (subject.position) {
    lines.push(subject.position);
  }
  if (subject.speedKph !== null) lines.push(`${subject.speedKph} км/ч`);
  if (subject.secondsSinceFix !== null) {
    lines.push(
      subject.secondsSinceFix < 60
        ? 'преди по-малко от минута'
        : `преди ${Math.round(subject.secondsSinceFix / 60)} мин`,
    );
  }
  // Escaped: a worker's name is data, and this string becomes HTML inside the tooltip.
  return lines.map((line) => escapeHtml(line)).join('<br>');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function LiveMap({ subjects, height = 480, onSelect }: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef(new Map<string, CircleMarker>());
  const fittedRef = useRef(false);
  // Held in a ref so a changing callback does not rebuild every marker's handler.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: LeafletMap | null = null;

    void (async () => {
      const L = await import('leaflet');
      if (cancelled || mapRef.current) return;

      map = L.map(container, { zoomControl: true, attributionControl: true });
      // Centred on Bulgaria until the first fix arrives, so an empty map is a map rather than
      // the middle of the Atlantic.
      map.setView([42.7339, 25.4858], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      fittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');
      const markers = markersRef.current;
      const seen = new Set<string>();

      for (const subject of subjects) {
        if (subject.latitude === null || subject.longitude === null) continue;
        seen.add(subject.id);
        const position: [number, number] = [subject.latitude, subject.longitude];
        const color = STATE_COLOR[subject.trackingState] ?? STATE_COLOR.STOPPED!;

        const existing = markers.get(subject.id);
        if (existing) {
          // Moved, not replaced. This is what keeps an open popup open and the map still.
          existing.setLatLng(position);
          existing.setStyle({ color, fillColor: color });
          existing.setTooltipContent(tooltip(subject));
          continue;
        }

        const marker = L.circleMarker(position, {
          radius: 9,
          weight: 3,
          color,
          fillColor: color,
          fillOpacity: 0.85,
        })
          .bindTooltip(tooltip(subject), { direction: 'top', offset: [0, -8] })
          .addTo(map);
        marker.on('click', () => onSelectRef.current?.(subject));
        markers.set(subject.id, marker);
      }

      // Anyone who stopped being tracked leaves the map with their session.
      for (const [id, marker] of markers) {
        if (seen.has(id)) continue;
        marker.remove();
        markers.delete(id);
      }

      /*
       * Fit once, then leave the viewport alone.
       *
       * Re-fitting on every poll would yank the map out from under someone who has zoomed in on
       * a van — the single most annoying thing a live map can do.
       */
      if (!fittedRef.current && markers.size > 0) {
        map.fitBounds(L.latLngBounds([...markers.values()].map((m) => m.getLatLng())), {
          padding: [48, 48],
          maxZoom: 14,
        });
        fittedRef.current = true;
      }
    })();
  }, [subjects]);

  return (
    <div
      ref={containerRef}
      style={{
        height,
        width: '100%',
        borderRadius: 'var(--ay-radius-lg, 12px)',
        overflow: 'hidden',
        background: 'var(--ay-surface-2)',
      }}
      role="application"
      aria-label="Карта на живо"
    />
  );
}
