import { SchoolLocation } from '../types/index.ts';

export const EARTH_RADIUS_METERS = 6371e3; // 6.371.000 meter
export const MAX_ACCEPTABLE_GPS_ACCURACY_METERS = 100;
export const MAX_GPS_AGE_MS = 5 * 60 * 1000; // 5 menit
export const GPS_INACCURATE_MESSAGE =
  'Lokasi GPS belum akurat, silakan coba kembali di dekat area terbuka.';

export type GeofenceStatus = 'VALID' | 'TIDAK AKURAT' | 'DI LUAR AREA';

export interface GpsReading {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  sampleCount: number;
}

export interface GeofenceEvaluation {
  status: GeofenceStatus;
  isValid: boolean;
  nearestLocation: SchoolLocation | null;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  allowedRadiusMeters: number | null;
  userCoords: { lat: number; lng: number } | null;
  officeCoords: { lat: number; lng: number } | null;
  message: string;
}

export function parseCoordinate(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(',', '.');
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function isValidLatLng(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (lat == null || lng == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * Menghitung jarak permukaan bumi antara dua koordinat GPS menggunakan rumus Haversine (satuan meter).
 * Parameter harus berurutan (lat1, lon1, lat2, lon2).
 */
export function calculateHaversineDistanceExactMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return Math.round(calculateHaversineDistanceExactMeters(lat1, lon1, lat2, lon2));
}

export interface AcquireLocationOptions {
  /** Jendela stabilisasi setelah pembacaan pertama masuk (ms) */
  stabilizeWindowMs?: number;
  /** Batas tunggu maksimal pembacaan pertama (ms) */
  timeoutMs?: number;
  /** Target akurasi ideal untuk berhenti lebih cepat jika sudah stabil (meter) */
  targetAccuracyMeters?: number;
  /** AbortSignal opsional agar permintaan lama batal saat pengguna menekan Perbarui Lokasi */
  signal?: AbortSignal;
  /** Callback progres pembacaan multi-sampel */
  onProgress?: (info: { sampleCount: number; bestAccuracy: number }) => void;
}

function formatGeolocationError(err: GeolocationPositionError | { code?: number; message?: string }): Error {
  const code = err?.code;
  if (code === 1) {
    return new Error(
      'Izin lokasi GPS ditolak oleh browser/perangkat. Aktifkan izin Lokasi pada pengaturan situs atau aplikasi.'
    );
  }
  if (code === 2) {
    return new Error(
      'Sinyal lokasi GPS tidak tersedia saat ini. Pastikan GPS/Lokasi perangkat aktif dan coba di dekat area terbuka.'
    );
  }
  if (code === 3) {
    return new Error(
      'Waktu tunggu deteksi GPS habis. Pastikan GPS aktif lalu tekan Perbarui Lokasi di dekat area terbuka.'
    );
  }
  return new Error(err?.message || 'Gagal membaca lokasi GPS perangkat.');
}

/**
 * Mengambil lokasi GPS terbaru tanpa cache (enableHighAccuracy: true, maximumAge: 0)
 * dengan beberapa pembacaan (multi-sample stabilization) untuk memilih akurasi terbaik.
 */
export function acquireAccurateLocation(options: AcquireLocationOptions = {}): Promise<GpsReading> {
  const stabilizeWindowMs = options.stabilizeWindowMs ?? 6000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const targetAccuracyMeters = options.targetAccuracyMeters ?? 20;

  return new Promise<GpsReading>((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Perangkat atau browser ini tidak mendukung Geolocation GPS.'));
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('Permintaan lokasi dibatalkan.'));
      return;
    }

    const startedAt = Date.now();
    const samples: Array<{ lat: number; lng: number; accuracy: number; timestamp: number }> = [];
    let settled = false;
    let watchId: number | null = null;
    let hardTimeoutTimer: number | null = null;
    let stabilizeTimer: number | null = null;

    const cleanup = () => {
      if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      if (hardTimeoutTimer !== null) {
        window.clearTimeout(hardTimeoutTimer);
        hardTimeoutTimer = null;
      }
      if (stabilizeTimer !== null) {
        window.clearTimeout(stabilizeTimer);
        stabilizeTimer = null;
      }
      options.signal?.removeEventListener('abort', handleAbort);
    };

    const pickBestSample = (): GpsReading | null => {
      if (samples.length === 0) return null;
      // Buang pembacaan yang jauh lebih tua (> 15 detik sebelum mulai) jika tersedia pembacaan baru
      const freshSamples = samples.filter((s) => s.timestamp >= startedAt - 15000);
      const pool = freshSamples.length > 0 ? freshSamples : samples;

      let best = pool[0];
      for (let i = 1; i < pool.length; i++) {
        const cur = pool[i];
        // Pilih akurasi terkecil (paling presisi). Jika selisih <= 2m, pilih yang terbaru.
        if (
          cur.accuracy < best.accuracy - 2 ||
          (Math.abs(cur.accuracy - best.accuracy) <= 2 && cur.timestamp >= best.timestamp)
        ) {
          best = cur;
        }
      }
      return {
        lat: best.lat,
        lng: best.lng,
        accuracy: best.accuracy,
        timestamp: best.timestamp,
        sampleCount: pool.length,
      };
    };

    const finishWithBest = () => {
      if (settled) return;
      const best = pickBestSample();
      if (!best) return;
      settled = true;
      cleanup();
      resolve(best);
    };

    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Permintaan lokasi dibatalkan.'));
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: timeoutMs,
    };

    const onPosition = (pos: GeolocationPosition) => {
      if (settled) return;
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 9999;
      const ts = pos.timestamp || Date.now();

      if (!isValidLatLng(lat, lng)) return;

      // Abaikan cached location lawas (> 20 detik sebelum request dimulai) bila ada peluang fix baru
      if (ts < startedAt - 20000 && samples.length === 0) {
        return;
      }

      samples.push({ lat, lng, accuracy, timestamp: ts });

      const currentBest = pickBestSample();
      if (currentBest) {
        options.onProgress?.({
          sampleCount: currentBest.sampleCount,
          bestAccuracy: Math.round(currentBest.accuracy),
        });
      }

      // Mulai timer jendela stabilisasi saat sampel valid pertama diterima
      if (stabilizeTimer === null) {
        stabilizeTimer = window.setTimeout(() => {
          finishWithBest();
        }, stabilizeWindowMs);
      }

      // Berhenti lebih cepat jika sudah mendapat minimal 2 sampel segar, akurasi ideal <= targetAccuracyMeters,
      // dan 2 pembacaan terakhir sudah stabil (selisih jarak <= 20 meter)
      if (samples.length >= 2 && currentBest && currentBest.accuracy <= targetAccuracyMeters) {
        const prev = samples[samples.length - 2];
        const curr = samples[samples.length - 1];
        const drift = calculateHaversineDistanceExactMeters(prev.lat, prev.lng, curr.lat, curr.lng);
        if (drift <= 20) {
          finishWithBest();
        }
      }
    };

    const onGeoError = (err: GeolocationPositionError) => {
      if (settled) return;
      // Jika sudah ada sampel yang terkumpul sebelum timeout/error sementara, gunakan yang terbaik
      if (samples.length > 0) {
        finishWithBest();
        return;
      }
      // Permission denied harus langsung gagal tanpa menunggu timeout
      if (err.code === 1) {
        settled = true;
        cleanup();
        reject(formatGeolocationError(err));
      }
    };

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, geoOptions);

    hardTimeoutTimer = window.setTimeout(() => {
      if (settled) return;
      if (samples.length > 0) {
        finishWithBest();
        return;
      }
      // Fallback satu kali getCurrentPosition high-accuracy jika watchPosition belum memancarkan sampel
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          if (!isValidLatLng(pos.coords.latitude, pos.coords.longitude)) {
            settled = true;
            cleanup();
            reject(new Error('Koordinat GPS tidak valid. Silakan coba kembali di dekat area terbuka.'));
            return;
          }
          settled = true;
          cleanup();
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 9999,
            timestamp: pos.timestamp || Date.now(),
            sampleCount: 1,
          });
        },
        (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(formatGeolocationError(err));
        },
        geoOptions
      );
    }, timeoutMs);
  });
}

/**
 * Mengevaluasi status geofence secara terpisah antara:
 * - Jarak aktual (Haversine) ke titik kantor terdekat
 * - Akurasi GPS perangkat (meter)
 * - Radius maksimal yang ditetapkan Admin (tanpa pernah mengubah radius otomatis)
 */
export function evaluateGeofence(
  reading: GpsReading | null,
  locations: SchoolLocation[],
  nowMs: number = Date.now(),
  maxAcceptableAccuracyMeters: number = MAX_ACCEPTABLE_GPS_ACCURACY_METERS
): GeofenceEvaluation {
  const activeLocs = (locations || []).filter((l) => {
    if (!l || l.isActive === false) return false;
    const lat = parseCoordinate(l.latitude);
    const lng = parseCoordinate(l.longitude);
    return isValidLatLng(lat, lng);
  });

  if (activeLocs.length === 0) {
    return {
      status: 'VALID',
      isValid: true,
      nearestLocation: null,
      distanceMeters: null,
      accuracyMeters: reading && Number.isFinite(reading.accuracy) ? Math.round(reading.accuracy) : null,
      allowedRadiusMeters: null,
      userCoords: reading && isValidLatLng(reading.lat, reading.lng) ? { lat: reading.lat, lng: reading.lng } : null,
      officeCoords: null,
      message: 'Belum ada titik geofence aktif yang diatur Admin.',
    };
  }

  if (!reading || !isValidLatLng(reading.lat, reading.lng)) {
    const firstLoc = activeLocs[0];
    const firstLat = parseCoordinate(firstLoc.latitude)!;
    const firstLng = parseCoordinate(firstLoc.longitude)!;
    return {
      status: 'TIDAK AKURAT',
      isValid: false,
      nearestLocation: firstLoc,
      distanceMeters: null,
      accuracyMeters: null,
      allowedRadiusMeters: Math.round(Number(firstLoc.radiusMeters || 150)),
      userCoords: null,
      officeCoords: { lat: firstLat, lng: firstLng },
      message: GPS_INACCURATE_MESSAGE,
    };
  }

  let bestLoc: SchoolLocation = activeLocs[0];
  let bestLat = parseCoordinate(bestLoc.latitude)!;
  let bestLng = parseCoordinate(bestLoc.longitude)!;
  let minDistance = Infinity;

  for (const loc of activeLocs) {
    const locLat = parseCoordinate(loc.latitude)!;
    const locLng = parseCoordinate(loc.longitude)!;
    const dist = calculateHaversineDistanceExactMeters(reading.lat, reading.lng, locLat, locLng);
    if (dist < minDistance) {
      minDistance = dist;
      bestLoc = loc;
      bestLat = locLat;
      bestLng = locLng;
    }
  }

  const distanceMeters = Math.round(minDistance);
  const accuracyMeters = Number.isFinite(reading.accuracy) ? Math.round(reading.accuracy) : 9999;
  const allowedRadiusMeters = Math.round(Number(bestLoc.radiusMeters || 150));
  const userCoords = { lat: reading.lat, lng: reading.lng };
  const officeCoords = { lat: bestLat, lng: bestLng };

  // 1. Cek kedaluwarsa pembacaan (tidak boleh pakai koordinat lama)
  const ageMs = nowMs - reading.timestamp;
  if (ageMs > MAX_GPS_AGE_MS) {
    return {
      status: 'TIDAK AKURAT',
      isValid: false,
      nearestLocation: bestLoc,
      distanceMeters,
      accuracyMeters,
      allowedRadiusMeters,
      userCoords,
      officeCoords,
      message: 'Data lokasi GPS sudah lama. Silakan tekan Perbarui Lokasi di dekat area terbuka.',
    };
  }

  // 2. Validasi kualitas akurasi GPS:
  // Jika akurasi > batas wajar (100m), ATAU jarak melewati radius tetapi error bar GPS (accuracy)
  // tumpang tindih dengan batas radius kantor, jangan langsung memvonis DI LUAR AREA.
  const isAccuracyTooPoor = !Number.isFinite(reading.accuracy) || reading.accuracy <= 0 || accuracyMeters > maxAcceptableAccuracyMeters;
  const isBoundaryAmbiguous =
    distanceMeters > allowedRadiusMeters &&
    accuracyMeters > 40 &&
    distanceMeters - accuracyMeters <= allowedRadiusMeters;

  if (isAccuracyTooPoor || isBoundaryAmbiguous) {
    return {
      status: 'TIDAK AKURAT',
      isValid: false,
      nearestLocation: bestLoc,
      distanceMeters,
      accuracyMeters,
      allowedRadiusMeters,
      userCoords,
      officeCoords,
      message: GPS_INACCURATE_MESSAGE,
    };
  }

  // 3. Bandingkan jarak aktual Haversine terhadap radius maksimal Admin
  if (distanceMeters <= allowedRadiusMeters) {
    return {
      status: 'VALID',
      isValid: true,
      nearestLocation: bestLoc,
      distanceMeters,
      accuracyMeters,
      allowedRadiusMeters,
      userCoords,
      officeCoords,
      message: `Lokasi VALID di dalam area ${bestLoc.name}.`,
    };
  }

  return {
    status: 'DI LUAR AREA',
    isValid: false,
    nearestLocation: bestLoc,
    distanceMeters,
    accuracyMeters,
    allowedRadiusMeters,
    userCoords,
    officeCoords,
    message: `Di luar area presensi: jarak ${distanceMeters}m dari ${bestLoc.name} (maksimal ${allowedRadiusMeters}m).`,
  };
}
