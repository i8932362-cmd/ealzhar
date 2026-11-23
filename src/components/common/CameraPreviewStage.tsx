import React, { useEffect, useRef, useState } from 'react';

export interface CameraPreviewOrientationConfig {
  readonly mirrorHorizontal: boolean;
  readonly transform: 'none' | 'scaleX(-1)';
}

// Default preview flips front camera horizontally so user's right side appears on the right and left on the left,
// strictly separated from raw unflipped HTMLVideoElement frames used by AI face processing.
export const DEFAULT_CAMERA_PREVIEW_ORIENTATION: CameraPreviewOrientationConfig = {
  mirrorHorizontal: true,
  transform: 'scaleX(-1)',
};

export function getCameraPreviewOrientation(mirrorPreview: boolean): CameraPreviewOrientationConfig {
  return mirrorPreview
    ? { mirrorHorizontal: true, transform: 'scaleX(-1)' }
    : { mirrorHorizontal: false, transform: 'none' };
}

interface CameraPreviewStageProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  isActive: boolean;
  showGuideFrame?: boolean;
  mirrorPreview?: boolean;
  maxHeightClass?: string;
  needsPlayTap?: boolean;
  onTapToPlay?: () => void;
  onVideoDimensions?: (width: number, height: number) => void;
  children?: React.ReactNode;
}

export const CameraPreviewStage: React.FC<CameraPreviewStageProps> = ({
  videoRef,
  canvasRef,
  isActive,
  showGuideFrame = true,
  mirrorPreview = true,
  maxHeightClass = 'h-[56dvh] min-h-[340px] max-h-[600px] sm:h-[480px] lg:h-[560px]',
  needsPlayTap = false,
  onTapToPlay,
  onVideoDimensions,
  children,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostSize, setHostSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [videoDims, setVideoDims] = useState<{ width: number; height: number }>({ width: 1280, height: 720 });

  useEffect(() => {
    const hostEl = hostRef.current;
    if (!hostEl) return;

    const measureHost = () => {
      const rect = hostEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setHostSize((prev) =>
          Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
            ? prev
            : { width: rect.width, height: rect.height }
        );
      }
    };

    measureHost();
    const rafId = requestAnimationFrame(measureHost);

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => measureHost());
      observer.observe(hostEl);
      return () => {
        cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    }

    window.addEventListener('resize', measureHost);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', measureHost);
    };
  }, [isActive]);

  const syncVideoDimensions = (videoEl: HTMLVideoElement | null) => {
    if (!videoEl || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) return;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    setVideoDims((prev) => (prev.width === vw && prev.height === vh ? prev : { width: vw, height: vh }));
    onVideoDimensions?.(vw, vh);
  };

  useEffect(() => {
    if (!isActive) return;
    const videoEl = videoRef.current;
    if (!videoEl) return;
    syncVideoDimensions(videoEl);
  }, [isActive, videoRef]);

  const orientation = getCameraPreviewOrientation(mirrorPreview);

  // Compute symmetrical centered dimensions locked strictly to videoDims aspect ratio.
  // Uses adaptive cover-fit so desktop/mobile fills the wide frame edge-to-edge without stretching or black gaps,
  // while capping extreme portrait-vs-landscape zoom so faces remain comfortably framed and centered.
  let stageStyle: React.CSSProperties;
  if (hostSize.width > 0 && hostSize.height > 0 && videoDims.width > 0 && videoDims.height > 0) {
    const containScale = Math.min(hostSize.width / videoDims.width, hostSize.height / videoDims.height);
    const coverScale = Math.max(hostSize.width / videoDims.width, hostSize.height / videoDims.height);
    const targetScale =
      coverScale / containScale <= 1.45 ? coverScale : containScale * 1.25;
    const fittedW = Math.max(1, Math.round(videoDims.width * targetScale));
    const fittedH = Math.max(1, Math.round(videoDims.height * targetScale));
    stageStyle = {
      width: `${fittedW}px`,
      height: `${fittedH}px`,
      flexShrink: 0,
    };
  } else {
    stageStyle = {
      width: '100%',
      height: '100%',
    };
  }

  return (
    <div
      ref={hostRef}
      className={`relative w-full ${maxHeightClass} flex items-center justify-center overflow-hidden rounded-2xl bg-slate-950`}
    >
      {/* Centered aspect-locked stage keeping video and AI canvas overlay pixel-synced */}
      <div
        className="relative flex items-center justify-center overflow-hidden"
        style={stageStyle}
      >
        {/* Raw video element kept untransformed by default (no mirroring) so orientation matches real life */}
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          onLoadedMetadata={(e) => syncVideoDimensions(e.currentTarget)}
          onLoadedData={(e) => syncVideoDimensions(e.currentTarget)}
          onCanPlay={(e) => syncVideoDimensions(e.currentTarget)}
          onPlaying={(e) => syncVideoDimensions(e.currentTarget)}
          onResize={(e) => syncVideoDimensions(e.currentTarget)}
          style={{
            transform: orientation.transform,
            WebkitTransform: orientation.transform,
          }}
          className={`w-full h-full ${hostSize.width > 0 && hostSize.height > 0 ? 'object-fill' : 'object-contain'} block`}
        />

        {/* Overlay canvas stays non-flipped so drawn name labels remain legible and aligned */}
        {canvasRef && (
          <canvas
            ref={canvasRef}
            style={{
              transform: 'none',
              WebkitTransform: 'none',
            }}
            className="absolute inset-0 w-full h-full pointer-events-none block"
          />
        )}
      </div>

      {/* Symmetrical wide edge corner brackets & exact center alignment reticle anchored to visible viewport */}
      {isActive && showGuideFrame && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative w-[calc(100%-24px)] h-[calc(100%-24px)] sm:w-[calc(100%-40px)] sm:h-[calc(100%-40px)] rounded-2xl">
            <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-sky-400/85 rounded-tl-xl" />
            <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-sky-400/85 rounded-tr-xl" />
            <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-sky-400/85 rounded-bl-xl" />
            <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-sky-400/85 rounded-br-xl" />
          </div>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center opacity-55">
            <span className="absolute w-5 h-[1.5px] bg-sky-300/85 rounded-full" />
            <span className="absolute h-5 w-[1.5px] bg-sky-300/85 rounded-full" />
          </div>
        </div>
      )}

      {isActive && needsPlayTap && onTapToPlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-4">
          <button
            type="button"
            onClick={onTapToPlay}
            className="px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold shadow-xl cursor-pointer transition"
          >
            Ketuk untuk Tampilkan Preview Kamera
          </button>
        </div>
      )}

      {children}
    </div>
  );
};
