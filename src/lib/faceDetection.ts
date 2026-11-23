import * as faceapi from '@vladmandic/face-api';

let modelsLoaded = false;
let modelLoadingPromise: Promise<boolean> | null = null;

export function areFaceModelsLoaded(): boolean {
  return modelsLoaded;
}

export async function loadFaceDetectionModels(): Promise<boolean> {
  if (modelsLoaded) return true;
  if (modelLoadingPromise) return modelLoadingPromise;

  modelLoadingPromise = (async () => {
    try {
      const MODEL_URL = '/models';
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      modelsLoaded = true;
      return true;
    } catch (err) {
      console.error('Failed to load tiny face detection models:', err);
      try {
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
        ]);
        modelsLoaded = true;
        return true;
      } catch (fallbackErr) {
        console.error('Fallback face model loading failed:', fallbackErr);
        modelLoadingPromise = null;
        return false;
      }
    }
  })();

  return modelLoadingPromise;
}

export function preloadFaceModelsInBackground(): void {
  if (typeof window === 'undefined' || modelsLoaded || modelLoadingPromise) return;
  loadFaceDetectionModels().catch(() => {});
}

let currentActiveStream: MediaStream | null = null;
let inFlightAcquire: Promise<MediaStream> | null = null;
let lastStreamStoppedAt = 0;
let acquireSequence = 0;

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queryCameraPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      window.matchMedia?.('(display-mode: minimal-ui)').matches ||
      Boolean((window.navigator as unknown as { standalone?: boolean }).standalone)
    );
  } catch {
    return false;
  }
}

export function stopMediaStreamSafely(stream?: MediaStream | null): void {
  const targets = new Set<MediaStream>();
  if (stream) targets.add(stream);
  if (!stream && currentActiveStream) targets.add(currentActiveStream);

  let stoppedLiveTrack = false;
  targets.forEach((s) => {
    try {
      s.getTracks().forEach((track) => {
        if (track.readyState === 'live') {
          stoppedLiveTrack = true;
        }
        try {
          track.stop();
        } catch {
          // Ignore individual track stop errors
        }
      });
    } catch {
      // Ignore stream iteration errors
    }
    if (currentActiveStream === s) {
      currentActiveStream = null;
    }
  });

  if (stoppedLiveTrack) {
    lastStreamStoppedAt = Date.now();
  }
}

function requestLegacyOrModernUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacyNav = (typeof navigator !== 'undefined' ? navigator : {}) as {
    getUserMedia?: (c: MediaStreamConstraints, ok: (s: MediaStream) => void, err: (e: any) => void) => void;
    webkitGetUserMedia?: (c: MediaStreamConstraints, ok: (s: MediaStream) => void, err: (e: any) => void) => void;
    mozGetUserMedia?: (c: MediaStreamConstraints, ok: (s: MediaStream) => void, err: (e: any) => void) => void;
  };
  const legacyFn = legacyNav.getUserMedia || legacyNav.webkitGetUserMedia || legacyNav.mozGetUserMedia;
  if (legacyFn) {
    return new Promise((resolve, reject) => {
      legacyFn.call(navigator, constraints, resolve, reject);
    });
  }
  return Promise.reject(new Error('Browser atau aplikasi ini tidak mendukung akses kamera atau halaman tidak dibuka melalui HTTPS.'));
}

function pickPreferredVideoDeviceIds(
  devices: MediaDeviceInfo[],
  preferredFacingMode: 'user' | 'environment'
): string[] {
  const videoInputs = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  if (videoInputs.length === 0) return [];

  const isFrontLabel = (label: string) =>
    /front|depan|user|facetime|selfie|integrated|webcam/i.test(label);
  const isBackLabel = (label: string) =>
    /back|rear|belakang|environment|trid|wide|main/i.test(label);

  const ordered = [...videoInputs].sort((a, b) => {
    const aScore = preferredFacingMode === 'user'
      ? (isFrontLabel(a.label) ? 2 : isBackLabel(a.label) ? 0 : 1)
      : (isBackLabel(a.label) ? 2 : isFrontLabel(a.label) ? 0 : 1);
    const bScore = preferredFacingMode === 'user'
      ? (isFrontLabel(b.label) ? 2 : isBackLabel(b.label) ? 0 : 1)
      : (isBackLabel(b.label) ? 2 : isFrontLabel(b.label) ? 0 : 1);
    return bScore - aScore;
  });

  return ordered.map((d) => d.deviceId);
}

/**
 * Universal, serialized cross-device & installed-PWA camera stream acquisition.
 * Invokes the first getUserMedia() synchronously in the caller's callstack when idle
 * or when triggered from a user gesture so Safari/iOS PWA/Android WebAPK immediately display the permission prompt.
 */
export function acquireCameraStream(
  preferredFacingMode: 'user' | 'environment' = 'user',
  options?: { fromUserGesture?: boolean }
): Promise<MediaStream> {
  const mySeq = ++acquireSequence;

  const runAcquireSync = (): Promise<MediaStream> => {
    // Stop any lingering previous camera stream synchronously before requesting a new one
    stopMediaStreamSafely();

    const attempts: MediaStreamConstraints[] = [
      // Attempt 1: Wide 16:9 HD stream with preferred facing mode
      {
        video: {
          facingMode: { ideal: preferredFacingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      // Attempt 2: Ideal facing mode + light 480p resolution fallback
      {
        video: {
          facingMode: { ideal: preferredFacingMode },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      },
      // Attempt 3: Only ideal facingMode without resolution constraints
      {
        video: {
          facingMode: { ideal: preferredFacingMode },
        },
        audio: false,
      },
    ];

    const isPermissionFatal = (err: any) => {
      const n = err?.name || '';
      return n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError';
    };

    const registerAndReturn = (stream: MediaStream): MediaStream => {
      if (mySeq !== acquireSequence) {
        stopMediaStreamSafely(stream);
        throw new DOMException('Camera request superseded', 'AbortError');
      }
      currentActiveStream = stream;
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (currentActiveStream === stream) {
            currentActiveStream = null;
            lastStreamStoppedAt = Date.now();
          }
        });
      });
      return stream;
    };

    // Kick off Attempt 1 IMMEDIATELY in this synchronous tick to preserve browser user activation!
    const firstAttemptPromise = requestLegacyOrModernUserMedia(attempts[0]);

    return (async () => {
      let lastError: any = null;
      try {
        const firstStream = await firstAttemptPromise;
        return registerAndReturn(firstStream);
      } catch (err: any) {
        lastError = err;
        if (mySeq !== acquireSequence || isPermissionFatal(err)) {
          throw err;
        }
      }

      for (const constraints of attempts.slice(1)) {
        if (mySeq !== acquireSequence) {
          throw new DOMException('Camera request superseded', 'AbortError');
        }
        try {
          const stream = await requestLegacyOrModernUserMedia(constraints);
          return registerAndReturn(stream);
        } catch (err: any) {
          lastError = err;
          if (mySeq !== acquireSequence || isPermissionFatal(err)) {
            throw err;
          }
        }
      }

      // Attempt 4: Explicit deviceId fallback (helps on iPad/Android WebAPK/USB webcams where facingMode fails)
      try {
        if (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const candidateIds = pickPreferredVideoDeviceIds(devices, preferredFacingMode);
          for (const deviceId of candidateIds) {
            if (mySeq !== acquireSequence) {
              throw new DOMException('Camera request superseded', 'AbortError');
            }
            try {
              const stream = await requestLegacyOrModernUserMedia({
                video: { deviceId: { exact: deviceId } },
                audio: false,
              });
              return registerAndReturn(stream);
            } catch (err: any) {
              lastError = err;
              if (mySeq !== acquireSequence || isPermissionFatal(err)) {
                throw err;
              }
            }
          }
        }
      } catch (enumErr: any) {
        if (mySeq !== acquireSequence || isPermissionFatal(enumErr)) throw enumErr;
      }

      // Attempt 5: Universal basic video fallback
      try {
        const stream = await requestLegacyOrModernUserMedia({ video: true, audio: false });
        return registerAndReturn(stream);
      } catch (err: any) {
        lastError = err;
        if (mySeq !== acquireSequence || isPermissionFatal(err)) {
          throw err;
        }
      }

      // Attempt 6: Transient hardware-release retry after brief cooldown (handles mobile PWA camera daemon delay)
      const errName = lastError?.name || '';
      if (
        errName === 'NotReadableError' ||
        errName === 'TrackStartError' ||
        errName === 'AbortError' ||
        lastStreamStoppedAt > 0
      ) {
        await delayMs(420);
        if (mySeq !== acquireSequence) {
          throw new DOMException('Camera request superseded', 'AbortError');
        }
        for (const retryConstraints of [
          { video: { facingMode: { ideal: preferredFacingMode } }, audio: false },
          { video: true, audio: false },
        ] as MediaStreamConstraints[]) {
          try {
            const stream = await requestLegacyOrModernUserMedia(retryConstraints);
            return registerAndReturn(stream);
          } catch (retryErr: any) {
            lastError = retryErr;
            if (mySeq !== acquireSequence || isPermissionFatal(retryErr)) {
              throw retryErr;
            }
          }
        }
      }

      throw lastError || new Error('Gagal membuka kamera pada perangkat ini.');
    })();
  };

  const nextAcquire =
    options?.fromUserGesture || !inFlightAcquire
      ? runAcquireSync()
      : inFlightAcquire.then(() => runAcquireSync(), () => runAcquireSync());

  const tracked = nextAcquire.finally(() => {
    if (inFlightAcquire === tracked) {
      inFlightAcquire = null;
    }
  });
  inFlightAcquire = tracked;
  return tracked;
}

/**
 * Safely attach a MediaStream to an HTMLVideoElement across iOS standalone PWA, Android WebAPK, and Desktop.
 * Returns { needsUserTapToPlay } if browser autoplay policy paused playback without a direct tap.
 */
export async function attachStreamToVideo(
  video: HTMLVideoElement,
  stream: MediaStream
): Promise<{ needsUserTapToPlay: boolean }> {
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.setAttribute('autoplay', 'true');
  video.setAttribute('muted', 'true');
  video.playsInline = true;
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  if (video.readyState < 1 || video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', done);
        video.removeEventListener('canplay', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      video.addEventListener('loadedmetadata', done, { once: true });
      video.addEventListener('canplay', done, { once: true });
    });
  }

  try {
    await video.play();
    return { needsUserTapToPlay: false };
  } catch (err: any) {
    const errName = err?.name || '';
    if (errName === 'NotAllowedError') {
      return { needsUserTapToPlay: true };
    }
    if (errName === 'AbortError') {
      await delayMs(60);
      try {
        await video.play();
        return { needsUserTapToPlay: false };
      } catch (retryErr: any) {
        return { needsUserTapToPlay: retryErr?.name === 'NotAllowedError' };
      }
    }
    return { needsUserTapToPlay: false };
  }
}

/**
 * Monitors installed-PWA foreground resume (visibilitychange/pageshow) and OS track revocation
 * so camera streams automatically recover cleanly without staying black/frozen.
 */
export function attachCameraResumeListeners(opts: {
  getStream: () => MediaStream | null;
  getVideo: () => HTMLVideoElement | null;
  isCameraExpectedActive: () => boolean;
  onNeedRestart: () => void;
}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!opts.isCameraExpectedActive()) return;
      if (document.visibilityState === 'hidden') return;

      const stream = opts.getStream();
      const video = opts.getVideo();
      const hasLiveTrack = Boolean(
        stream && stream.getVideoTracks().some((t) => t.readyState === 'live')
      );

      if (!hasLiveTrack || (video && video.srcObject === stream && video.ended)) {
        opts.onNeedRestart();
        return;
      }

      if (video && stream && video.srcObject === stream && video.paused) {
        void video.play().catch(() => {});
      }
    }, 260);
  };

  document.addEventListener('visibilitychange', scheduleCheck);
  window.addEventListener('pageshow', scheduleCheck);
  const mediaDevices = navigator.mediaDevices;
  mediaDevices?.addEventListener?.('devicechange', scheduleCheck);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    document.removeEventListener('visibilitychange', scheduleCheck);
    window.removeEventListener('pageshow', scheduleCheck);
    mediaDevices?.removeEventListener?.('devicechange', scheduleCheck);
  };
}

export interface DetectedFaceResult {
  box: { x: number; y: number; width: number; height: number };
  descriptor: Float32Array;
  score: number;
}

// Multi-face detection in video frame
export async function detectFacesInVideo(
  video: HTMLVideoElement
): Promise<DetectedFaceResult[]> {
  if (!modelsLoaded || !video || video.readyState < 2 || video.videoWidth === 0) return [];

  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const detections = await faceapi
      .detectAllFaces(video, options)
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    return detections.map(d => ({
      box: {
        x: d.detection.box.x,
        y: d.detection.box.y,
        width: d.detection.box.width,
        height: d.detection.box.height,
      },
      descriptor: d.descriptor,
      score: d.detection.score,
    }));
  } catch (err) {
    console.debug('Frame detection skip:', err);
    return [];
  }
}

// Single face extraction for registration / teacher attendance
export async function detectSingleFaceDescriptor(
  video: HTMLVideoElement
): Promise<number[] | null> {
  if (!modelsLoaded) {
    await loadFaceDetectionModels();
  }
  if (!modelsLoaded || !video || video.readyState < 2 || video.videoWidth === 0) return null;

  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
    const detection = await faceapi
      .detectSingleFace(video, options)
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    if (!detection || !detection.descriptor) return null;
    return Array.from(detection.descriptor);
  } catch (err) {
    console.error('Single face detection error:', err);
    return null;
  }
}

// Extract face descriptor from an uploaded image or canvas element
export async function detectFaceDescriptorFromImage(
  image: HTMLImageElement | HTMLCanvasElement
): Promise<number[] | null> {
  if (!modelsLoaded) {
    await loadFaceDetectionModels();
  }
  if (!modelsLoaded) return null;

  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 });
    const detection = await faceapi
      .detectSingleFace(image, options)
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    if (!detection || !detection.descriptor) return null;
    return Array.from(detection.descriptor);
  } catch (err) {
    console.error('Image face detection error:', err);
    return null;
  }
}

// Calculate Euclidean distance between two 128-d face descriptors
export function computeDescriptorDistance(desc1: number[] | Float32Array, desc2: number[] | Float32Array): number {
  if (desc1.length !== desc2.length) return 1.0;
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    const diff = desc1[i] - desc2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Threshold: usually 0.55 - 0.6 is standard for face-api
export const MATCH_THRESHOLD = 0.55;

export interface FaceMatch {
  personId: string;
  distance: number;
  isMatch: boolean;
}

export function findBestFaceMatch(
  queryDescriptor: Float32Array | number[],
  enrolledTemplates: Array<{ personId: string; descriptor: number[] }>
): FaceMatch | null {
  if (!enrolledTemplates || enrolledTemplates.length === 0) return null;

  let bestMatch: FaceMatch | null = null;
  let minDistance = Infinity;

  for (const t of enrolledTemplates) {
    if (!t.descriptor || t.descriptor.length === 0) continue;
    const dist = computeDescriptorDistance(queryDescriptor, t.descriptor);
    if (dist < minDistance) {
      minDistance = dist;
      bestMatch = {
        personId: t.personId,
        distance: dist,
        isMatch: dist <= MATCH_THRESHOLD,
      };
    }
  }

  return bestMatch;
}

// Camera error interpreter with device- & installed-PWA-specific guidance
export function parseCameraError(err: any): { title: string; message: string } {
  if (typeof window !== 'undefined' && !window.isSecureContext && window.location.hostname !== 'localhost') {
    return {
      title: 'Kamera Membutuhkan HTTPS',
      message: 'Browser membatasi akses kamera hanya pada koneksi aman HTTPS atau localhost.',
    };
  }

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const standalone = isStandalonePWA();
  const name = err?.name || '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    if (standalone && isIOS) {
      return {
        title: 'Izin Kamera Aplikasi Terinstal iOS Ditolak',
        message:
          'Buka Pengaturan iPhone/iPad > Safari (atau Aplikasi) > Kamera > pilih "Tanya" atau "Izinkan", lalu buka kembali aplikasi dan ketuk Coba Lagi.',
      };
    }
    if (standalone && isAndroid) {
      return {
        title: 'Izin Kamera Aplikasi Terinstal Ditolak',
        message:
          'Tekan & tahan ikon aplikasi ini > Info Aplikasi > Izin > Kamera > Izinkan (atau Pengaturan Chrome > Setelan Situs > Kamera), lalu ketuk Coba Lagi.',
      };
    }
    if (standalone) {
      return {
        title: 'Izin Kamera Aplikasi Ditolak',
        message:
          'Klik tombol menu (⋮) di pojok kanan atas jendela aplikasi terinstal > Info Situs / Izin > ubah Kamera ke "Izinkan", lalu klik Coba Lagi.',
      };
    }
    return {
      title: 'Izin Kamera Ditolak',
      message: 'Harap izinkan akses kamera pada ikon gembok/pengaturan browser lalu tekan Coba Lagi.',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      title: 'Kamera Tidak Ditemukan',
      message: 'Tidak ada perangkat kamera yang terdeteksi atau terhubung pada perangkat ini.',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'Kamera Sedang Digunakan',
      message: 'Kamera sedang dipakai oleh aplikasi, tab, atau jendela lain. Tutup aplikasi tersebut lalu tekan Coba Lagi.',
    };
  }
  if (name === 'OverconstrainedError') {
    return {
      title: 'Resolusi Kamera Tidak Didukung',
      message: 'Coba ganti kamera depan/belakang atau tekan Coba Lagi.',
    };
  }

  return {
    title: 'Gagal Mengakses Kamera',
    message: err?.message || 'Terjadi kesalahan saat memulai video kamera. Silakan tekan Coba Lagi.',
  };
}
