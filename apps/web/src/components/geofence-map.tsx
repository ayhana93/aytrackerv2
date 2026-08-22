'use client';

import { useEffect, useRef } from 'react';
import type { Circle, Map as LeafletMap, Marker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeofenceRow } from '../lib/admin';

/**
 * The fences on a map, and a click to place a new one.
 *
 * A geofence is a place, and a place is chosen by pointing at it. Typing two coordinates to six
 * decimals is how a dispatcher ends up with a customer in the Gulf of Guinea because the latitude
 * and longitude were the wrong way round — an error a map makes obvious and a form does not.
 *
 * The draft fence is drawn at its real radius as it is typed, so "200 metres" stops being an
 * abstract number and becomes a circle that either covers the yard or does not.
 *
 * Leaflet is imported dynamically: it touches `window` at module scope, so a static import breaks
 * the server render.
 */

export interface GeofenceMapProps {
  readonly fences: readonly GeofenceRow[];
  /** The fence being drawn, if any. Rendered distinctly from the saved ones. */
  readonly draft: { latitude: number; longitude: number; radiusMeters: number } | null;
  readonly onPick: (position: { latitude: number; longitude: number }) => void;
  readonly height?: number;
}

const SAVED = '#2563eb';
const SAVED_INACTIVE = '#94a3b8';
const DRAFT = '#10b981';

export function GeofenceMap({ fences, draft, onPick, height = 420 }: GeofenceMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const circlesRef = useRef(new Map<string, Circle>());
  const draftRef = useRef<{ circle: Circle; marker: Marker } | null>(null);
  const fittedRef = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    void (async () => {
      const L = await import('leaflet');
      if (cancelled || mapRef.current) return;

      const map = L.map(container, { zoomControl: true });
      map.setView([42.7339, 25.4858], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      map.on('click', (event) => {
        onPickRef.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
      });
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      circlesRef.current.clear();
      draftRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');
      const circles = circlesRef.current;
      const seen = new Set<string>();

      for (const fence of fences) {
        seen.add(fence.id);
        const color = fence.isActive ? SAVED : SAVED_INACTIVE;
        const existing = circles.get(fence.id);
        if (existing) {
          existing.setLatLng([fence.latitude, fence.longitude]);
          existing.setRadius(fence.radiusMeters);
          existing.setStyle({ color, fillColor: color });
          continue;
        }
        const circle = L.circle([fence.latitude, fence.longitude], {
          radius: fence.radiusMeters,
          color,
          fillColor: color,
          fillOpacity: 0.12,
          weight: 2,
        })
          .bindTooltip(`${escapeHtml(fence.name)} · ${fence.radiusMeters} м`, { direction: 'top' })
          .addTo(map);
        circles.set(fence.id, circle);
      }

      for (const [id, circle] of circles) {
        if (seen.has(id)) continue;
        circle.remove();
        circles.delete(id);
      }

      if (!fittedRef.current && circles.size > 0) {
        const bounds = L.latLngBounds([...circles.values()].map((circle) => circle.getLatLng()));
        map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
        fittedRef.current = true;
      }
    })();
  }, [fences]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    void (async () => {
      const L = await import('leaflet');
      if (!draft) {
        draftRef.current?.circle.remove();
        draftRef.current?.marker.remove();
        draftRef.current = null;
        return;
      }

      const position: [number, number] = [draft.latitude, draft.longitude];
      if (draftRef.current) {
        draftRef.current.circle.setLatLng(position);
        draftRef.current.circle.setRadius(draft.radiusMeters);
        draftRef.current.marker.setLatLng(position);
      } else {
        const circle = L.circle(position, {
          radius: draft.radiusMeters,
          color: DRAFT,
          fillColor: DRAFT,
          fillOpacity: 0.18,
          weight: 2,
          dashArray: '6 4',
        }).addTo(map);
        const marker = L.circleMarker(position, {
          radius: 6,
          color: DRAFT,
          fillColor: DRAFT,
          fillOpacity: 1,
        }).addTo(map) as unknown as Marker;
        draftRef.current = { circle, marker };
      }
      map.panTo(position, { animate: true });
    })();
  }, [draft]);

  return (
    <div
      ref={containerRef}
      style={{
        height,
        width: '100%',
        borderRadius: 'var(--ay-radius-lg, 12px)',
        overflow: 'hidden',
        background: 'var(--ay-surface-2)',
        cursor: 'crosshair',
      }}
      role="application"
      aria-label="Карта на зоните"
    />
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
