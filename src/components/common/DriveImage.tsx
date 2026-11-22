import React, { useEffect, useState } from 'react';
import { extractDriveFileId, fetchDrivePhotoDataUrl } from '../../lib/api.ts';

export function useResolvedDriveImage(src?: string | null, fallback?: string): {
  resolvedSrc: string;
  isLoading: boolean;
} {
  const raw = String(src || '').trim();
  const driveId = extractDriveFileId(raw);
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => {
    if (!raw) return fallback || '';
    if (driveId) return fallback || '';
    return raw;
  });
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(driveId));

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

    setIsLoading(true);
    fetchDrivePhotoDataUrl(driveId)
      .then((dataUrl) => {
        if (cancelled) return;
        setResolvedSrc(dataUrl || fallback || '');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
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
