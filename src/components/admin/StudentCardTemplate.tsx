import React, { useState, useEffect, useId } from 'react';
import { Student, SchoolClass, EducationLevel, LevelConfig } from '../../types/index.ts';
import { generateBarcodeSvg } from '../../lib/barcodeGenerator.ts';
import {
  extractDriveFileId,
  fetchDrivePhotoDataUrl,
  fetchExternalImageAsDataUrl,
  getCachedDrivePhotoDataUrl,
} from '../../lib/api.ts';
import { useResolvedDriveImage } from '../common/DriveImage.tsx';

export const DEFAULT_LEVEL_CONFIGS: Record<EducationLevel, LevelConfig> = {
  SMK: {
    level: 'SMK',
    unitName: 'SMK MAMBAUL ULUM',
    principalName: 'Drs. H. Ahmad Fauzi, M.Pd.I',
    principalNip: 'NIY. 19780512 200501 1 003',
    signaturePlaceDate: 'Jombang, 15 Juli 2026',
    websiteUrl: 'https://smk.mambaululum.sch.id',
    schoolAddress: 'Jl. Pesantren Mambaul Ulum Gedung A, Diwek, Jombang',
    vision: "Terwujudnya Generasi Qur'ani, Berakhlakul Karimah, Unggul dalam IPTEK, Vokasi, dan Berdaya Saing Global.",
    missions: [
      'Menyeimbangkan pendidikan kejuruan modern, IPTEK, dan pendalaman kitab kuning.',
      'Mengembangkan kompetensi vokasi unggul, riset ilmiah, tahfidz, dan bahasa internasional.',
      'Membentuk lulusan santri yang terampil, mandiri, berakhlak, dan siap kerja.'
    ],
    accentColor: '#1e40af', // Blue-800
    headerColor: '#1e3a8a',
    badgeText: 'JENJANG MENENGAH KEJURUAN'
  },
  'SMP/MTS': {
    level: 'SMP/MTS',
    unitName: 'SMP / MTs MAMBAUL ULUM',
    principalName: 'Hj. Siti Masruroh, S.Ag., M.Pd.',
    principalNip: 'NIY. 19820315 200801 2 004',
    signaturePlaceDate: 'Jombang, 15 Juli 2026',
    websiteUrl: 'https://smp.mambaululum.sch.id',
    schoolAddress: 'Jl. Pesantren Mambaul Ulum Gedung B, Diwek, Jombang',
    vision: "Membentuk Insan Beriman, Berbudi Pekerti Luhur, Cerdas, dan Terampil Berlandaskan Aswaja.",
    missions: [
      'Menanamkan nilai-nilai keislaman dan pembiasaan ibadah praktis harian.',
      'Melaksanakan pembelajaran interaktif, berkarakter, dan ramah anak.',
      'Mendorong prestasi akademik, tahfidz Al-Qur\'an, dan keolahragaan.'
    ],
    accentColor: '#065f46', // Emerald-800
    headerColor: '#064e3b',
    badgeText: 'JENJANG MENENGAH PERTAMA'
  },
  'SD/MI': {
    level: 'SD/MI',
    unitName: 'SD / MI MAMBAUL ULUM',
    principalName: 'Muhammad Ridwan, S.Pd.I',
    principalNip: 'NIY. 19880720 201201 1 005',
    signaturePlaceDate: 'Jombang, 15 Juli 2026',
    websiteUrl: 'https://sd.mambaululum.sch.id',
    schoolAddress: 'Jl. Pesantren Mambaul Ulum Gedung C, Diwek, Jombang',
    vision: "Ceria, Berkarakter Islami, Gemar Membaca Al-Qur'an dan Cinta Lingkungan.",
    missions: [
      'Menanamkan pondasi aqidah dan akhlak mulia sejak usia dini.',
      'Menumbuhkan kecintaan membaca Al-Qur\'an dan literasi dasar.',
      'Menciptakan lingkungan madrasah yang asri, aman, dan penuh kasih sayang.'
    ],
    accentColor: '#991b1b', // Red-800
    headerColor: '#7f1d1d',
    badgeText: 'JENJANG PENDIDIKAN DASAR'
  }
};

// Official Seal Stamp SVG
export const FoundationSealSvg: React.FC<{ color?: string }> = ({ color = '#047857' }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const topId = `sealTop-${uid}`;
  const bottomId = `sealBottom-${uid}`;
  return (
    <svg viewBox="0 0 100 100" className="w-14 h-14 opacity-85 select-none pointer-events-none">
      <circle cx="50" cy="50" r="46" fill="none" stroke={color} strokeWidth="2.5" strokeDasharray="3 1.5" />
      <circle cx="50" cy="50" r="41" fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx="50" cy="50" r="28" fill="none" stroke={color} strokeWidth="1.2" />
      <path id={topId} d="M 18,50 A 32,32 0 0,1 82,50" fill="none" />
      <path id={bottomId} d="M 82,50 A 32,32 0 0,1 18,50" fill="none" />
      <text fill={color} fontSize="6.8" fontWeight="bold" letterSpacing="0.8">
        <textPath href={`#${topId}`} startOffset="50%" textAnchor="middle">
          YAYASAN MAMBAUL ULUM
        </textPath>
      </text>
      <text fill={color} fontSize="6.2" fontWeight="bold" letterSpacing="0.6">
        <textPath href={`#${bottomId}`} startOffset="50%" textAnchor="middle">
          ★ RESMI TERAKREDITASI ★
        </textPath>
      </text>
      {/* Center Star & Book */}
      <polygon points="50,38 53,44 60,45 55,49 56,56 50,52 44,56 45,49 40,45 47,44" fill={color} opacity="0.9" />
    </svg>
  );
};

// Principal Calligraphic Signature SVG
export const PrincipalSignatureSvg: React.FC<{ color?: string }> = ({ color = '#1e3a8a' }) => (
  <svg viewBox="0 0 140 45" className="w-24 h-9 select-none pointer-events-none">
    <path
      d="M10,32 Q25,8 42,22 T70,18 Q90,5 105,25 Q120,40 135,15 M38,20 L65,36 M85,15 Q95,30 115,20"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.92"
    />
  </svg>
);

// School Emblem SVG
export const SchoolEmblemSvg: React.FC<{ className?: string }> = ({ className = 'w-10 h-10' }) => (
  <div className={`${className} rounded-full bg-gradient-to-tr from-emerald-600 via-teal-600 to-blue-700 p-0.5 shadow-sm flex items-center justify-center flex-shrink-0`}>
    <div className="w-full h-full rounded-full bg-white flex items-center justify-center border border-amber-300">
      <svg viewBox="0 0 36 36" className="w-7 h-7 text-emerald-700" fill="currentColor">
        <path d="M18 3L4 9v7c0 8.5 6 16.5 14 18 8-1.5 14-9.5 14-18V9L18 3zm0 4.5l9 3.8v4.7c0 6-4 11.5-9 13-5-1.5-9-7-9-13v-4.7l9-3.8z" />
        <path d="M18 10l-4 4h3v5h2v-5h3l-4-4zm-4 11h8v1.5h-8V21z" fill="#047857" />
      </svg>
    </div>
  </div>
);

export function formatStudentBirthDateForCard(raw?: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[3].padStart(2, '0')}-${isoMatch[2].padStart(2, '0')}-${isoMatch[1]}`;
  }
  return s;
}

export function formatStudentBirthLineForCard(birthPlace?: string, birthDate?: string): string {
  const place = String(birthPlace || '').trim();
  const date = formatStudentBirthDateForCard(birthDate);
  if (place && date) return `${place}, ${date}`;
  if (place) return place;
  if (date) return date;
  return '-';
}

// Offline-safe initial avatar SVG data URL (never fails CORS / rate limits)
export function getStudentInitialAvatarDataUrl(name: string, gender: 'L' | 'P'): string {
  const words = String(name || 'S')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials =
    words.length >= 2
      ? `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase()
      : (words[0]?.slice(0, 2) || 'SW').toUpperCase();
  const bg = gender === 'P' ? '#fbcfe8' : '#bfdbfe';
  const ring = gender === 'P' ? '#f472b6' : '#60a5fa';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="320" viewBox="0 0 256 320">
    <rect width="256" height="320" fill="${bg}" />
    <circle cx="128" cy="112" r="56" fill="#ffffff" fill-opacity="0.72" stroke="${ring}" stroke-width="4" />
    <text x="128" y="128" text-anchor="middle" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#1e3a8a">${initials}</text>
    <path d="M56 290c0-44 32-72 72-72s72 28 72 72" fill="#1e3a8a" fill-opacity="0.16" />
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Offline-safe deterministic QR-style fallback SVG if external QR endpoint is unreachable
export function getFallbackQrSvgDataUrl(seedText: string): string {
  const str = String(seedText || 'https://mambaululum.sch.id');
  const size = 21;
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const rects: string[] = [];
  const isFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

  const drawFinder = (r0: number, c0: number) => {
    rects.push(`<rect x="${c0}" y="${r0}" width="7" height="7" fill="#1e3a8a"/>`);
    rects.push(`<rect x="${c0 + 1}" y="${r0 + 1}" width="5" height="5" fill="#ffffff"/>`);
    rects.push(`<rect x="${c0 + 2}" y="${r0 + 2}" width="3" height="3" fill="#1e3a8a"/>`);
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFinder(r, c)) continue;
      hash ^= (r * 31 + c * 17) + 1;
      hash = Math.imul(hash, 16777619);
      if ((hash >>> 0) % 2 === 0) {
        rects.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="#1e3a8a"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 25 25" width="150" height="150"><rect x="-2" y="-2" width="25" height="25" fill="#ffffff"/>${rects.join('')}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Helper to determine student photo url (fallback to offline-safe avatar if none)
export function getStudentPhotoUrl(student: Student): string {
  if (student.photoUrl && student.photoUrl.trim().length > 10) {
    return student.photoUrl;
  }
  return getStudentInitialAvatarDataUrl(student.name, student.gender);
}

export interface ResolvedCardAssetOverrides {
  logo?: string;
  signature?: string;
  stamp?: string;
  watermark?: string;
  qr?: string;
  studentPhoto?: string;
}

interface StudentCardProps {
  student: Student;
  schoolClass?: SchoolClass;
  schoolName: string;
  schoolAddress?: string;
  schoolLogo?: string;
  foundationWebsite?: string;
  watermarkUrl?: string;
  hasFaceEnrolled?: boolean;
  config?: LevelConfig;
  cardSide?: 'front' | 'back';
  cardIdPrefix?: string;
  resolvedAssetOverrides?: ResolvedCardAssetOverrides;
}

// ============================================================================
// 1. SISI DEPAN KARTU PELAJAR (FRONT SIDE)
// ============================================================================
export const StudentCardFront: React.FC<StudentCardProps> = ({
  student,
  schoolClass,
  schoolName,
  schoolAddress,
  schoolLogo,
  watermarkUrl,
  config = DEFAULT_LEVEL_CONFIGS['SMK'],
  cardIdPrefix = '',
  resolvedAssetOverrides,
}) => {
  const barcodeValue = student.nisn || student.barcodeCard || student.nis;
  const barcodeSvg = generateBarcodeSvg(barcodeValue, 34);
  const fallbackPhotoUrl = getStudentInitialAvatarDataUrl(student.name, student.gender);
  const overridePhoto = resolvedAssetOverrides?.studentPhoto;

  const [photoUrl, setPhotoUrl] = useState<string>(() => {
    if (overridePhoto) return overridePhoto;
    const driveId = extractDriveFileId(student.photoUrl) || student.photoFileId;
    if (driveId) {
      return getCachedDrivePhotoDataUrl(driveId) || fallbackPhotoUrl;
    }
    return getStudentPhotoUrl(student);
  });

  useEffect(() => {
    if (overridePhoto) {
      setPhotoUrl(overridePhoto);
      return;
    }
    let cancelled = false;
    const driveId = extractDriveFileId(student.photoUrl) || student.photoFileId;
    if (driveId) {
      const cached = getCachedDrivePhotoDataUrl(driveId);
      if (cached) {
        setPhotoUrl(cached);
        return;
      }
      fetchDrivePhotoDataUrl(driveId).then(dataUrl => {
        if (!cancelled && dataUrl) {
          setPhotoUrl(dataUrl);
        }
      });
    } else if (student.photoUrl && student.photoUrl.trim().length > 10 && !student.photoUrl.startsWith('data:')) {
      fetchExternalImageAsDataUrl(student.photoUrl).then(dataUrl => {
        if (!cancelled) {
          setPhotoUrl(dataUrl || student.photoUrl || fallbackPhotoUrl);
        }
      });
    } else {
      setPhotoUrl(getStudentPhotoUrl(student));
    }
    return () => {
      cancelled = true;
    };
  }, [student, overridePhoto, fallbackPhotoUrl]);

  const activeWatermark = config.watermarkUrl || watermarkUrl;
  const activeLogo = config.logoUrl || schoolLogo;
  const { resolvedSrc: resolvedWatermarkHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.watermark !== undefined ? undefined : activeWatermark
  );
  const { resolvedSrc: resolvedLogoHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.logo !== undefined ? undefined : activeLogo
  );
  const { resolvedSrc: resolvedSignatureHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.signature !== undefined ? undefined : config.principalSignatureUrl
  );
  const { resolvedSrc: resolvedStampHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.stamp !== undefined ? undefined : config.stampUrl
  );

  const resolvedWatermark = resolvedAssetOverrides?.watermark !== undefined ? resolvedAssetOverrides.watermark : resolvedWatermarkHook;
  const resolvedLogo = resolvedAssetOverrides?.logo !== undefined ? resolvedAssetOverrides.logo : resolvedLogoHook;
  const resolvedSignature = resolvedAssetOverrides?.signature !== undefined ? resolvedAssetOverrides.signature : resolvedSignatureHook;
  const resolvedStamp = resolvedAssetOverrides?.stamp !== undefined ? resolvedAssetOverrides.stamp : resolvedStampHook;

  const sigScalePct = Math.min(180, Math.max(60, Number(config.signatureScale ?? 100)));
  const sigScale = sigScalePct / 100;
  const hasCustomSignature = Boolean(config.principalSignatureUrl && String(config.principalSignatureUrl).trim());
  const shouldHideDefaultStamp = config.hideStamp ?? hasCustomSignature;

  return (
    <div
      id={`${cardIdPrefix}card-front-${student.id}`}
      style={{
        width: '425px',
        height: '272px',
        backgroundColor: '#ffffff',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
      className="relative rounded-2xl overflow-hidden border-2 border-slate-300 shadow-xl flex flex-col justify-between select-none text-slate-800"
    >
      {/* Dynamic Watermark Background (Auto-adjusting) */}
      {resolvedWatermark ? (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden z-0">
          <img
            src={resolvedWatermark}
            alt="Watermark"
            crossOrigin={resolvedWatermark.startsWith('data:') ? undefined : 'anonymous'}
            className="w-56 h-56 object-contain opacity-[0.08] select-none pointer-events-none filter grayscale"
          />
        </div>
      ) : (
        <div className="absolute inset-0 pointer-events-none opacity-[0.035] flex items-center justify-center z-0">
          <svg viewBox="0 0 100 100" className="w-64 h-64" fill="currentColor">
            <circle cx="50" cy="50" r="45" />
          </svg>
        </div>
      )}

      {/* Top Header Bar */}
      <div
        style={{ backgroundColor: config.headerColor }}
        className="px-3.5 py-2 text-white flex items-center justify-between border-b-2 border-amber-400 relative z-10"
      >
        <div className="flex items-center gap-2.5">
          {/* Custom Uploaded Logo or Default Emblem */}
          {resolvedLogo ? (
            <img
              src={resolvedLogo}
              alt="Logo"
              crossOrigin={resolvedLogo.startsWith('data:') ? undefined : 'anonymous'}
              className="w-9 h-9 object-contain rounded-full bg-white p-0.5 border border-amber-300 shadow-xs flex-shrink-0"
            />
          ) : (
            <SchoolEmblemSvg className="w-9 h-9" />
          )}

          <div className="leading-tight">
            <div className="text-[10px] font-black tracking-widest text-amber-300 uppercase">
              {schoolName.toUpperCase()}
            </div>
            <div className="text-xs font-black tracking-tight">{config.unitName}</div>
            <div className="text-[7.5px] text-blue-100 opacity-90 truncate max-w-[210px]">
              {config.schoolAddress || schoolAddress || 'Jl. Pesantren Mambaul Ulum, Diwek, Jombang • Terakreditasi "A"'}
            </div>
          </div>
        </div>

        <div className="text-right flex flex-col items-end">
          <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider bg-amber-400 text-slate-900 shadow-xs">
            {config.level}
          </span>
          <span className="text-[7.5px] text-blue-200 mt-0.5 font-semibold">KARTU PELAJAR</span>
        </div>
      </div>

      {/* Center & Bottom Body: Photo + Info on Top, Barcode (Left) + Principal Signature (Right) on Bottom */}
      <div className="px-3.5 pt-1.5 pb-1.5 flex-1 flex flex-col justify-between relative z-10">
        {/* Top Row: Student Photo + Info Fields */}
        <div className="flex items-start gap-3">
          {/* Student Portrait Box with Formal Blue Background (Standar Pas Foto Biru) */}
          <div className="flex flex-col items-center flex-shrink-0">
            <div
              style={{ backgroundColor: '#1e40af' }}
              className="w-[78px] h-[98px] rounded-lg overflow-hidden border-2 border-slate-300 shadow-sm relative flex items-center justify-center"
            >
              <img
                src={photoUrl}
                alt={student.name}
                crossOrigin={photoUrl.startsWith('data:') ? undefined : 'anonymous'}
                className="w-full h-full object-cover object-top"
              />
            </div>
            <span className="text-[7.5px] font-bold text-slate-500 mt-0.5 uppercase tracking-wider">
              {student.gender === 'L' ? 'LAKI-LAKI' : 'PEREMPUAN'}
            </span>
          </div>

          {/* Student Data Fields */}
          <div className="flex-1 min-w-0 space-y-1 text-[10px]">
            <div>
              <div className="text-[7.5px] uppercase font-bold text-slate-400 leading-none">Nama Lengkap</div>
              <div className="text-[11.5px] font-black text-slate-900 tracking-tight truncate">
                {student.name.toUpperCase()}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-0.5">
              <div>
                <div className="text-[7.5px] font-bold text-slate-400 leading-none">NIS / NISN</div>
                <div className="font-mono text-[9px] font-black text-slate-800">
                  {student.nis} / <span className="text-blue-700">{student.nisn || student.nis}</span>
                </div>
              </div>

              <div>
                <div className="text-[7.5px] font-bold text-slate-400 leading-none">Kelas & Unit</div>
                <div className="text-[9px] font-bold text-slate-800 truncate">
                  {schoolClass?.name || 'Reguler'} ({config.level})
                </div>
              </div>

              <div>
                <div className="text-[7.5px] font-bold text-slate-400 leading-none">Tempat, Tgl Lahir</div>
                <div className="text-[8.5px] font-semibold text-slate-700 truncate">
                  {formatStudentBirthLineForCard(student.birthPlace, student.birthDate)}
                </div>
              </div>

              <div>
                <div className="text-[7.5px] font-bold text-slate-400 leading-none">Masa Berlaku</div>
                <div className="text-[8.5px] font-semibold text-emerald-700">
                  Selama Menjadi Santri
                </div>
              </div>
            </div>

            {student.address && (
              <div className="pt-0.5">
                <div className="text-[7px] font-bold text-slate-400 leading-none">Alamat</div>
                <div className="text-[8px] font-medium text-slate-700 truncate">{student.address}</div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Row: Barcode NISN (Sebelah Kiri, posisi naik) & Tanda Tangan Kepala Sekolah (Sebelah Kanan) */}
        <div className="flex-1 flex items-end justify-between gap-2 pt-0.5 pb-0.5">
          {/* Barcode NISN positioned cleanly higher to the left of the principal signature */}
          <div className="self-start mt-1.5 flex-1 max-w-[205px] bg-white rounded-xl border border-slate-300 px-2.5 py-1.5 shadow-2xs flex flex-col items-center justify-center">
            <div
              className="w-full flex items-center justify-center overflow-hidden h-8"
              dangerouslySetInnerHTML={{ __html: barcodeSvg }}
            />
            <div className="text-center font-mono text-[9.5px] font-black tracking-widest text-slate-900 mt-1 leading-none">
              NISN: {student.nisn || student.nis}
            </div>
          </div>

          {/* Principal Signature & Optional Custom Stamp Box (Pojok Kanan Bawah) */}
          <div className="self-end text-right text-[7.5px] leading-tight relative pr-0.5 flex-shrink-0 max-w-[196px]">
            <div className="text-slate-500 font-medium truncate">
              {config.signaturePlaceDate?.trim() || 'Jombang, 15 Juli 2026'}
            </div>
            <div className="text-[7.5px] font-bold text-slate-700 truncate">Kepala {config.unitName}</div>

            {/* Signature & Stamp Layer */}
            <div className="min-h-[34px] relative my-0.5 flex justify-end items-center">
              {resolvedStamp ? (
                <div className="absolute right-12 -top-2 pointer-events-none opacity-85 z-0">
                  <img
                    src={resolvedStamp}
                    alt="Stempel Sekolah"
                    crossOrigin={resolvedStamp.startsWith('data:') ? undefined : 'anonymous'}
                    className="max-h-14 max-w-14 w-auto h-auto object-contain select-none pointer-events-none"
                  />
                </div>
              ) : !shouldHideDefaultStamp ? (
                <div className="absolute right-10 -top-2 pointer-events-none z-0">
                  <FoundationSealSvg color="#047857" />
                </div>
              ) : null}

              <div className="relative z-10 flex items-center justify-end">
                {resolvedSignature ? (
                  <img
                    src={resolvedSignature}
                    alt={`TTD ${config.principalName}`}
                    crossOrigin={resolvedSignature.startsWith('data:') ? undefined : 'anonymous'}
                    style={
                      sigScalePct !== 100
                        ? {
                            height: `${Math.round(44 * sigScale)}px`,
                            width: 'auto',
                            maxWidth: `${Math.min(194, Math.round(170 * sigScale))}px`,
                          }
                        : {
                            width: 'auto',
                            height: 'auto',
                            maxHeight: '54px',
                            maxWidth: '175px',
                          }
                    }
                    className="object-contain select-none pointer-events-none block"
                  />
                ) : (
                  <PrincipalSignatureSvg color="#1e3a8a" />
                )}
              </div>
            </div>

            <div className="font-bold text-slate-900 underline text-[8px] truncate">{config.principalName}</div>
            <div className="text-[7px] text-slate-500 font-mono truncate">{config.principalNip}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. SISI BELAKANG KARTU PELAJAR (BACK SIDE)
// Dilengkapi Ruang Kode QR Website Sekolah/Yayasan & Visi-Misi
// ============================================================================
export const StudentCardBack: React.FC<StudentCardProps> = ({
  student,
  schoolName,
  schoolAddress,
  schoolLogo,
  foundationWebsite,
  watermarkUrl,
  config = DEFAULT_LEVEL_CONFIGS['SMK'],
  cardIdPrefix = '',
  resolvedAssetOverrides,
}) => {
  const activeWatermark = config.watermarkUrl || watermarkUrl;
  const activeLogo = config.logoUrl || schoolLogo;
  const targetWebsite = config.websiteUrl || foundationWebsite || 'https://mambaululum.sch.id';
  const cleanWebsiteUrl = targetWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const { resolvedSrc: resolvedWatermarkHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.watermark !== undefined ? undefined : activeWatermark
  );
  const { resolvedSrc: resolvedLogoHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.logo !== undefined ? undefined : activeLogo
  );
  const { resolvedSrc: resolvedCustomQrHook } = useResolvedDriveImage(
    resolvedAssetOverrides?.qr !== undefined ? undefined : config.qrCodeUrl
  );

  const resolvedWatermark = resolvedAssetOverrides?.watermark !== undefined ? resolvedAssetOverrides.watermark : resolvedWatermarkHook;
  const resolvedLogo = resolvedAssetOverrides?.logo !== undefined ? resolvedAssetOverrides.logo : resolvedLogoHook;
  const resolvedCustomQr = resolvedAssetOverrides?.qr !== undefined ? resolvedAssetOverrides.qr : resolvedCustomQrHook;

  const remoteQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(targetWebsite)}&bgcolor=ffffff&color=1e3a8a`;
  const [inlinedAutoQr, setInlinedAutoQr] = useState<string>(() => getFallbackQrSvgDataUrl(targetWebsite));

  useEffect(() => {
    if (resolvedAssetOverrides?.qr || config.qrCodeUrl) return;
    let cancelled = false;
    fetchExternalImageAsDataUrl(remoteQrUrl).then((dataUrl) => {
      if (!cancelled && dataUrl) {
        setInlinedAutoQr(dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [remoteQrUrl, resolvedAssetOverrides?.qr, config.qrCodeUrl]);

  const qrImageSrc =
    resolvedAssetOverrides?.qr ||
    resolvedCustomQr ||
    (!config.qrCodeUrl ? inlinedAutoQr : getFallbackQrSvgDataUrl(targetWebsite));

  return (
    <div
      id={`${cardIdPrefix}card-back-${student.id}`}
      style={{
        width: '425px',
        height: '272px',
        backgroundColor: '#ffffff',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
      className="relative rounded-2xl overflow-hidden border-2 border-slate-300 shadow-xl flex flex-col justify-between select-none text-slate-800 p-3.5"
    >
      {/* Dynamic Watermark Background */}
      {resolvedWatermark ? (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden z-0">
          <img
            src={resolvedWatermark}
            alt="Watermark"
            crossOrigin={resolvedWatermark.startsWith('data:') ? undefined : 'anonymous'}
            className="w-56 h-56 object-contain opacity-[0.08] select-none pointer-events-none filter grayscale"
          />
        </div>
      ) : (
        <div className="absolute inset-0 pointer-events-none opacity-[0.035] flex items-center justify-center z-0">
          <svg viewBox="0 0 100 100" className="w-64 h-64" fill="currentColor">
            <circle cx="50" cy="50" r="45" />
          </svg>
        </div>
      )}

      {/* Header Back Side */}
      <div className="border-b-2 border-slate-200 pb-1.5 flex items-center justify-between relative z-10">
        <div className="flex items-center gap-2">
          {resolvedLogo ? (
            <img
              src={resolvedLogo}
              alt="Logo"
              crossOrigin={resolvedLogo.startsWith('data:') ? undefined : 'anonymous'}
              className="w-6 h-6 object-contain rounded-full bg-white p-0.5 border border-slate-300 flex-shrink-0"
            />
          ) : (
            <SchoolEmblemSvg className="w-6 h-6" />
          )}

          <div>
            <div className="text-[10px] font-black text-slate-900 leading-none">
              {schoolName.toUpperCase()}
            </div>
            <div className="text-[8.5px] font-bold text-blue-700 leading-tight">
              {config.unitName}
            </div>
          </div>
        </div>
        <span className="px-2 py-0.5 rounded text-[7.5px] font-bold bg-slate-100 text-slate-600 border border-slate-300 uppercase">
          VISI, MISI & TATA TERTIB
        </span>
      </div>

      {/* Center Body: Two Columns (Left: Visi/Misi/Ketentuan, Right: QR Code Website) */}
      <div className="py-1 flex items-start gap-3 relative z-10 flex-1">
        {/* Left Column: Visi & Misi & Ketentuan */}
        <div className="flex-1 space-y-1 text-[7.5px] leading-tight">
          <div>
            <span className="font-black text-slate-900 text-[8px] uppercase text-blue-800 block mb-0.5">
              ★ VISI SEKOLAH:
            </span>
            <p className="italic text-slate-700 font-medium pl-1.5 border-l-2 border-blue-500">
              "{config.vision}"
            </p>
          </div>

          <div>
            <span className="font-black text-slate-900 text-[8px] uppercase text-blue-800 block mb-0.5">
              ★ MISI SEKOLAH:
            </span>
            <ol className="list-decimal list-inside space-y-0.5 text-slate-700 pl-0.5">
              {config.missions.map((m, idx) => (
                <li key={idx} className="line-clamp-1">{m}</li>
              ))}
            </ol>
          </div>

          {/* Tata Tertib Kartu */}
          <div className="pt-0.5 border-t border-slate-200">
            <span className="font-black text-slate-900 text-[8px] uppercase text-amber-800 block mb-0.5">
              ★ KETENTUAN KARTU PELAJAR:
            </span>
            <ul className="list-disc list-inside space-y-0.5 text-slate-600 text-[7px]">
              <li>Wajib dibawa setiap hari untuk presensi smart kiosk deteksi barcode & RFID.</li>
              <li>Kartu tidak boleh dipinjamkan atau dialihkan kepada pihak lain.</li>
              <li>Jika kartu hilang/rusak, segera lapor ke bagian Tata Usaha Yayasan.</li>
            </ul>
          </div>
        </div>

        {/* Right Column: Dedicated QR Code Box for School/Foundation Website */}
        <div className="w-[104px] flex-shrink-0 flex flex-col items-center justify-center bg-slate-50/90 rounded-xl border border-slate-200 p-2 text-center shadow-2xs">
          <div className="text-[7.5px] font-black text-slate-800 uppercase tracking-tight mb-1">
            KODE QR WEBSITE
          </div>

          <div className="w-18 h-18 bg-white p-1 rounded-lg border border-slate-300 shadow-2xs flex items-center justify-center overflow-hidden">
            <img
              src={qrImageSrc}
              alt="QR Website"
              crossOrigin={qrImageSrc.startsWith('data:') ? undefined : 'anonymous'}
              className="w-full h-full object-contain"
            />
          </div>

          <div className="mt-1 text-[6.5px] text-blue-800 font-mono font-bold truncate max-w-[95px]" title={targetWebsite}>
            {cleanWebsiteUrl}
          </div>
          <div className="text-[6px] text-slate-400 font-medium">
            Scan untuk Info Resmi
          </div>
        </div>
      </div>

      {/* Footer Contact Info (Address and Website dynamically customized) */}
      <div className="pt-1 border-t border-slate-200 flex items-center justify-between text-[7px] text-slate-500 font-medium relative z-10">
        <div className="truncate max-w-[230px]">
          <span>Alamat: {config.schoolAddress || schoolAddress || 'Jl. Pesantren Mambaul Ulum, Diwek, Jombang'}</span>
        </div>
        <div className="text-right">
          <span>Web: {cleanWebsiteUrl} • Telp: (0321) 876543</span>
        </div>
      </div>
    </div>
  );
};
