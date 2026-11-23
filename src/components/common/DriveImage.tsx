import React, { useEffect, useState } from 'react';
import {
  extractDriveFileId,
  fetchDrivePhotoDataUrl,
  getCachedDrivePhotoDataUrl,
  subscribeDrivePhotoCache,
} from '../../lib/api.ts';

export function useResolvedDriveImage(src?: string | null, fallback?: string): {
  resolvedSrc: string;
  isLoading: boolean;
} {
  const raw = String(src || '').trim();
  const driveId = extractDriveFileId(raw);
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => {
    if (!raw) return fallback || '';
    if (driveId) return getCachedDrivePhotoDataUrl(driveId) || fallback || '';
    return raw;
  });
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (!driveId) return false;
    return !getCachedDrivePhotoDataUrl(driveId);
  });

  useEffect(() => {
    let cancelled = false;
    if (!raw) {
      setResolvedSrc(fallback || '');
      setIsLoading(false);
      return;
    }
    if (!driveId) {
      setResolvedSrc(raw);
      setIsLoading(false);
      return;
    }

    const syncFromCache = () => {
      const hit = getCachedDrivePhotoDataUrl(driveId);
      if (hit && !cancelled) {
        setResolvedSrc(hit);
        setIsLoading(false);
        return true;
      }
      return false;
    };

    const unsubscribe = subscribeDrivePhotoCache(() => {
      syncFromCache();
    });

    if (!syncFromCache()) {
      setIsLoading(true);
      fetchDrivePhotoDataUrl(driveId)
        .then((dataUrl) => {
          if (cancelled) return;
          setResolvedSrc(dataUrl || fallback || '');
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [raw, driveId, fallback]);

  return { resolvedSrc, isLoading };
}

export async function preloadDriveImageUrls(urls: Array<string | undefined | null>): Promise<void> {
  const uniqueIds = Array.from(
    new Set(
      urls
        .map((u) => extractDriveFileId(u || undefined))
        .filter((id): id is string => Boolean(id))
    )
  );
  if (uniqueIds.length === 0) return;
  await Promise.all(uniqueIds.map((id) => fetchDrivePhotoDataUrl(id)));
}

interface DriveImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src?: string;
  fallbackSrc?: string;
}

export const DriveImage: React.FC<DriveImageProps> = ({ src, fallbackSrc, alt = '', ...rest }) => {
  const { resolvedSrc } = useResolvedDriveImage(src, fallbackSrc);
  if (!resolvedSrc) return null;
  return <img src={resolvedSrc} alt={alt} {...rest} />;
};
