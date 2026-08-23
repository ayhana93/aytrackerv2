'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createLocationCollector,
  detectCapabilities,
  type BackgroundCapability,
  type CollectorStatus,
  type LocationCollector,
  type RawPoint,
} from '@aytracker/tracking-client';
import { apiRequest } from './api';
import { actionId } from './worker';

/**
 * `/api/v1/tracking` — the one place a device reports where it is.
 *
 * Used by both portals. A worker's phone on shift and a driver's phone on a trip post the same
 * body to the same URL, and the server decides which session owns the points and whether a trip
 * was running when each fix was taken. The client never names a session: it could not be trusted
 * to, and it does not need to.
 */

export interface TrackingStateResponse {
  readonly serverTime: string;
  readonly session: {
    readonly id: string;
    readonly context: 'WORK' | 'DRIVER_TRIP';
    readonly startedAt: string;
    readonly distanceMeters: number;
    readonly trackingState: string;
    readonly lastPointAt: string | null;
  } | null;
  readonly samplingPolicy: {
    readonly minIntervalSeconds: number;
    readonly minDistanceMeters: number;
  };
}

export const trackingApi = {
  state: () => apiRequest<TrackingStateResponse>('/tracking/state'),

  /**
   * Uploads a batch.
   *
   * Throws on failure, deliberately: the collector owns retry, and points stay in the device
   * queue until the server has acknowledged them. Swallowing the error here would lose a route.
   */
  submit: (points: readonly RawPoint[], device: DeviceReport) =>
    apiRequest<{ accepted: number; rejected: number; state: string }>('/tracking/points', {
      method: 'POST',
      body: {
        clientActionId: actionId(),
        deviceReported: device.online ? 'ONLINE' : 'OFFLINE',
        batteryLevel: device.batteryLevel,
        isCharging: device.isCharging,
        permission: device.permission,
        points: points.map((point) => ({
          timestamp: new Date(point.timestamp).toISOString(),
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyMeters: point.accuracyMeters,
          speedMps: point.speedMps,
          heading: point.heading,
          altitude: point.altitude,
          source: point.source,
        })),
      },
    }),
};

export interface DeviceReport {
  readonly online: boolean;
  readonly batteryLevel: number | null;
  readonly isCharging: boolean | null;
  readonly permission: 'granted' | 'denied' | 'prompt' | 'unknown' | null;
}

/**
 * What the device can tell us about itself.
 *
 * Only what changes what the system does: battery decides the sampling interval, and the
 * permission state explains silence that would otherwise look like somebody hiding. The Battery
 * Status API is absent in Safari and behind a flag elsewhere, so every field is optional and its
 * absence is normal rather than an error.
 */
export async function readDevice(): Promise<DeviceReport> {
  const online = typeof navigator === 'undefined' || navigator.onLine;

  let batteryLevel: number | null = null;
  let isCharging: boolean | null = null;
  try {
    const battery = await (
      navigator as Navigator & {
        getBattery?: () => Promise<{ level: number; charging: boolean }>;
      }
    ).getBattery?.();
    if (battery) {
      batteryLevel = battery.level;
      isCharging = battery.charging;
    }
  } catch {
    // Not available on this browser. Not knowing is a valid answer.
  }

  let permission: DeviceReport['permission'] = null;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    permission = status?.state ?? null;
  } catch {
    permission = null;
  }

  return { online, batteryLevel, isCharging, permission };
}

/**
 * Runs the collector for as long as there is a session to report into.
 *
 * Started when a session id appears and stopped when it goes away, which covers ending a shift,
 * ending a trip, navigating away and closing the tab. The collector owns the queue and the
 * retry; this hook owns only its lifetime, so there is exactly one place a running watch can
 * leak.
 *
 * **Nothing is collected without a session.** That is not a convention here — the server refuses
 * a batch with no open session, so a client bug cannot turn this into background surveillance.
 */
export function useTrackingCollector(
  sessionId: string | null,
  policy: { minIntervalSeconds: number; minDistanceMeters: number } | null,
  options: { holdScreenAwake?: boolean } = {},
): CollectorStatus | null {
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const collectorRef = useRef<LocationCollector | null>(null);

  const minIntervalSeconds = policy?.minIntervalSeconds ?? 15;
  const minDistanceMeters = policy?.minDistanceMeters ?? 50;
  const holdScreenAwake = options.holdScreenAwake ?? false;

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      return;
    }

    const collector = createLocationCollector({
      sessionId,
      minIntervalSeconds,
      minDistanceMeters,
      holdScreenAwake,
      upload: async (points) => {
        await trackingApi.submit(points, await readDevice());
      },
      onStatusChange: setStatus,
    });

    collectorRef.current = collector;
    void collector.start();

    return () => {
      collectorRef.current = null;
      // Flushes what is queued before releasing the watch and any wake lock.
      void collector.stop();
    };
  }, [sessionId, minIntervalSeconds, minDistanceMeters, holdScreenAwake]);

  return status;
}

/**
 * What this device can actually do about recording with the screen off.
 *
 * Detected on the client only: rendering it on the server would mean guessing, and guessing here
 * means telling somebody their day is being recorded when it is not.
 */
export function useCapabilities(): BackgroundCapability | null {
  const [capability, setCapability] = useState<BackgroundCapability | null>(null);
  useEffect(() => {
    setCapability(detectCapabilities().background);
  }, []);
  return capability;
}

/**
 * Asks for location permission, once, from a gesture.
 *
 * Browsers only prompt from a user gesture, and only for a real position request — so this is
 * the same call the collector makes, used deliberately as the prompt. Resolves to what the
 * browser decided rather than throwing: a refusal is an answer, and the interface has something
 * honest to say about it.
 */
export function requestLocationPermission(): Promise<'granted' | 'denied' | 'unavailable'> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve('unavailable');
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (error) => resolve(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}

/**
 * What to tell the person about the screen going off. Never a promise the platform will not keep.
 *
 * Takes the application's name rather than hardcoding one: this product is white-label, and to
 * the worker reading this the application is their employer's — it is that name on the bar above
 * the text, so it has to be that name in the sentence too.
 */
export function backgroundNotice(capability: BackgroundCapability, appName: string): string {
  switch (capability) {
    case 'WAKE_LOCK':
      return `Записът работи, докато екранът е включен. ${appName} го задържа буден, докато си на работа.`;
    case 'FOREGROUND_ONLY':
      return `Дръж ${appName} отворен, за да се записва. Прекъсванията се отбелязват на маршрута.`;
    case 'NONE':
      return 'Това устройство не поддържа проследяване на местоположението.';
  }
}
