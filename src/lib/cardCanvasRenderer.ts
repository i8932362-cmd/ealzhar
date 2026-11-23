import { Student, SchoolClass, LevelConfig } from '../types/index.ts';
import { getCode128Pattern } from './barcodeGenerator.ts';
import {
  formatStudentBirthLineForCard,
  getFallbackQrSvgDataUrl,
  getStudentInitialAvatarDataUrl,
} from '../components/admin/StudentCardTemplate.tsx';

export interface CardExportAssets {
  logo?: string;
  signature?: string;
  stamp?: string;
  watermark?: string;
  qr?: string;
  studentPhoto?: string;
}

export interface RenderCardParams {
  student: Student;
  schoolClass?: SchoolClass;
  schoolName: string;
  schoolAddress?: string;
  foundationWebsite?: string;
  config: LevelConfig;
  assets: CardExportAssets;
}

const CARD_W = 425;
const CARD_H = 272;
const EXPORT_SCALE = 3; // 1275 x 816 px (>= 300 DPI)
const FONT_SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const decodedImageCache = new Map<string, HTMLImageElement>();
const grayscaleCanvasCache = new Map<string, HTMLCanvasElement>();

const DEFAULT_EMBLEM_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="108" height="108">
    <defs>
      <linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="#059669"/>
        <stop offset="50%" stop-color="#0d9488"/>
        <stop offset="100%" stop-color="#1d4ed8"/>
      </linearGradient>
    </defs>
    <circle cx="18" cy="18" r="18" fill="url(#g)"/>
    <circle cx="18" cy="18" r="15.5" fill="#ffffff" stroke="#fcd34d" stroke-width="1"/>
    <path d="M18 6L7 10.6v5.4c0 6.6 4.7 12.8 11 14 6.3-1.2 11-7.4 11-14v-5.4L18 6zm0 3.5l7 3v3.6c0 4.6-3.1 8.9-7 10.1-3.9-1.2-7-5.5-7-10.1v-3.6l7-3z" fill="#047857"/>
    <path d="M18 11.5l-3.2 3.2h2.2v4h2v-4h2.2L18 11.5zm-3.2 8.8h6.4v1.3h-6.4v-1.3z" fill="#047857"/>
  </svg>`
)}`;

const DEFAULT_SEAL_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="168" height="168">
    <circle cx="50" cy="50" r="46" fill="none" stroke="#047857" stroke-width="2.5" stroke-dasharray="3 1.5"/>
    <circle cx="50" cy="50" r="41" fill="none" stroke="#047857" stroke-width="1.5"/>
    <circle cx="50" cy="50" r="28" fill="none" stroke="#047857" stroke-width="1.2"/>
    <path id="ct" d="M 18,50 A 32,32 0 0,1 82,50" fill="none"/>
    <path id="cb" d="M 82,50 A 32,32 0 0,1 18,50" fill="none"/>
    <text fill="#047857" font-family="Arial, sans-serif" font-size="6.8" font-weight="bold" letter-spacing="0.8">
      <textPath href="#ct" startOffset="50%" text-anchor="middle">YAYASAN MAMBAUL ULUM</textPath>
    </text>
    <text fill="#047857" font-family="Arial, sans-serif" font-size="6.2" font-weight="bold" letter-spacing="0.6">
      <textPath href="#cb" startOffset="50%" text-anchor="middle">★ RESMI TERAKREDITASI ★</textPath>
    </text>
    <polygon points="50,38 53,44 60,45 55,49 56,56 50,52 44,56 45,49 40,45 47,44" fill="#047857" opacity="0.9"/>
  </svg>`
)}`;

const DEFAULT_SIGNATURE_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 45" width="280" height="90">
    <path d="M10,32 Q25,8 42,22 T70,18 Q90,5 105,25 Q120,40 135,15 M38,20 L65,36 M85,15 Q95,30 115,20" fill="none" stroke="#1e3a8a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>
  </svg>`
)}`;

export async function loadDecodedImage(src?: string): Promise<HTMLImageElement | null> {
  const clean = String(src || '').trim();
  if (!clean) return null;
  const cached = decodedImageCache.get(clean);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return cached;
  }

  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 6000);

    if (!clean.startsWith('data:') && !clean.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.decoding = 'async';
    img.onload = async () => {
      clearTimeout(timer);
      try {
        if (typeof img.decode === 'function') {
          await img.decode();
        }
      } catch {
        // Ignore decode rejection for inline SVG data URLs already loaded
      }
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        if (decodedImageCache.size > 150) {
          decodedImageCache.clear();
        }
        decodedImageCache.set(clean, img);
        done(img);
      } else {
        done(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    img.src = clean;
  });
}

function getGrayscaleImageCanvas(img: HTMLImageElement): HTMLCanvasElement | HTMLImageElement {
  const key = img.src;
  const cached = grayscaleCanvasCache.get(key);
  if (cached) return cached;

  try {
    const maxDim = 420;
    const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 200) * ratio));
    const h = Math.max(1, Math.round((img.naturalHeight || 200) * ratio));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const gctx = c.getContext('2d');
    if (!gctx) return img;
    gctx.drawImage(img, 0, 0, w, h);
    const imgData = gctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    }
    gctx.putImageData(imgData, 0, 0);
    if (grayscaleCanvasCache.size > 24) {
      grayscaleCanvasCache.clear();
    }
    grayscaleCanvasCache.set(key, c);
    return c;
  } catch {
    return img;
  }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function fitContain(srcW: number, srcH: number, boxW: number, boxH: number) {
  const sW = Math.max(1, srcW);
  const sH = Math.max(1, srcH);
  const scale = Math.min(boxW / sW, boxH / sH);
  const drawW = sW * scale;
  const drawH = sH * scale;
  return {
    drawW,
    drawH,
    offsetX: (boxW - drawW) / 2,
    offsetY: (boxH - drawH) / 2,
  };
}

function drawCoverTop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const sw = Math.max(1, img.naturalWidth || dw);
  const sh = Math.max(1, img.naturalHeight || dh);
  const srcRatio = sw / sh;
  const dstRatio = dw / dh;
  let sx = 0;
  let sy = 0;
  let cropW = sw;
  let cropH = sh;
  if (srcRatio > dstRatio) {
    cropW = sh * dstRatio;
    sx = (sw - cropW) / 2;
  } else {
    cropH = sw / dstRatio;
    sy = 0; // object-top preserves face & head framing cleanly
  }
  ctx.drawImage(img, sx, sy, cropW, cropH, dx, dy, dw, dh);
}

function truncateTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const str = String(text || '');
  if (!str || ctx.measureText(str).width <= maxWidth) return str;
  const ellipsis = '…';
  const ellipsisW = ctx.measureText(ellipsis).width;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(str.slice(0, mid)).width + ellipsisW <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, Math.max(0, lo)) + ellipsis;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(candidate).width <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) {
        lines.push(cur);
        cur = words[i];
      } else {
        lines.push(truncateTextToWidth(ctx, words[i], maxWidth));
        cur = '';
      }
      if (lines.length >= maxLines) {
        break;
      }
    }
  }
  if (cur && lines.length < maxLines) {
    lines.push(cur);
  } else if (cur && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = truncateTextToWidth(ctx, `${last} ${cur}`, maxWidth);
  }
  return lines;
}

function drawWatermarkLayer(ctx: CanvasRenderingContext2D, watermarkImg: HTMLImageElement | null) {
  ctx.save();
  if (watermarkImg) {
    const graySource = getGrayscaleImageCanvas(watermarkImg);
    const naturalW = watermarkImg.naturalWidth || 224;
    const naturalH = watermarkImg.naturalHeight || 224;
    const fitted = fitContain(naturalW, naturalH, 224, 224);
    const wx = (CARD_W - fitted.drawW) / 2;
    const wy = (CARD_H - fitted.drawH) / 2;
    ctx.globalAlpha = 0.095;
    ctx.drawImage(graySource, wx, wy, fitted.drawW, fitted.drawH);
  } else {
    ctx.globalAlpha = 0.035;
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(CARD_W / 2, CARD_H / 2, 114, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export async function renderStudentCardFrontJpeg(params: RenderCardParams): Promise<string> {
  const { student, schoolClass, schoolName, schoolAddress, config, assets } = params;
  const fallbackAvatar = getStudentInitialAvatarDataUrl(student.name, student.gender);

  const [logoImg, watermarkImg, signatureImg, stampImg, rawPhotoImg] = await Promise.all([
    loadDecodedImage(assets.logo),
    loadDecodedImage(assets.watermark),
    loadDecodedImage(assets.signature),
    loadDecodedImage(assets.stamp),
    loadDecodedImage(assets.studentPhoto || fallbackAvatar),
  ]);
  const [fallbackEmblemImg, fallbackSealImg, fallbackSigImg] = await Promise.all([
    logoImg ? Promise.resolve(null) : loadDecodedImage(DEFAULT_EMBLEM_SVG),
    stampImg ? Promise.resolve(null) : loadDecodedImage(DEFAULT_SEAL_SVG),
    signatureImg ? Promise.resolve(null) : loadDecodedImage(DEFAULT_SIGNATURE_SVG),
  ]);

  const photoImg = rawPhotoImg || (await loadDecodedImage(fallbackAvatar));

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * EXPORT_SCALE;
  canvas.height = CARD_H * EXPORT_SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context tidak tersedia');

  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Clip rounded card interior
  ctx.save();
  roundedRectPath(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 15);
  ctx.clip();

  // Base white
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 1. Watermark Layer
  drawWatermarkLayer(ctx, watermarkImg);

  // 2. Top Header Bar
  const headerH = 56;
  ctx.fillStyle = config.headerColor || '#1e3a8a';
  ctx.fillRect(0, 0, CARD_W, headerH);

  // Amber bottom accent border on header
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(0, headerH - 2, CARD_W, 2);

  // Logo circle at left (x=14, y=9, size=36)
  const logoX = 14;
  const logoY = 9;
  const logoSize = 36;
  const logoCx = logoX + logoSize / 2;
  const logoCy = logoY + logoSize / 2;
  if (logoImg) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(logoCx, logoCy, logoSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fcd34d';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Inner padded clip so transparent/square logos look crisp inside circular frame
    ctx.beginPath();
    ctx.arc(logoCx, logoCy, logoSize / 2 - 2.5, 0, Math.PI * 2);
    ctx.clip();
    const fitLogo = fitContain(logoImg.naturalWidth, logoImg.naturalHeight, logoSize - 5, logoSize - 5);
    ctx.drawImage(
      logoImg,
      logoX + 2.5 + fitLogo.offsetX,
      logoY + 2.5 + fitLogo.offsetY,
      fitLogo.drawW,
      fitLogo.drawH
    );
    ctx.restore();
  } else if (fallbackEmblemImg) {
    ctx.drawImage(fallbackEmblemImg, logoX, logoY, logoSize, logoSize);
  }

  // Right Jenjang Pill & "KARTU PELAJAR"
  ctx.save();
  ctx.font = `900 8px ${FONT_SANS}`;
  const pillText = String(config.level || 'SMK').toUpperCase();
  const pillTextW = ctx.measureText(pillText).width;
  const pillW = Math.max(36, pillTextW + 16);
  const pillH = 15;
  const pillX = CARD_W - 14 - pillW;
  const pillY = 12;

  roundedRectPath(ctx, pillX, pillY, pillW, pillH, 7.5);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  ctx.fillStyle = '#0f172a';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(pillText, pillX + pillW / 2, pillY + pillH / 2 + 0.5);

  ctx.font = `600 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#bfdbfe';
  ctx.textAlign = 'right';
  ctx.fillText('KARTU PELAJAR', CARD_W - 14, 37);
  ctx.restore();

  // Header Titles (x=60, bounded before pillX - 8)
  const titleMaxW = Math.max(150, pillX - 68);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.font = `900 9.5px ${FONT_SANS}`;
  ctx.fillStyle = '#fcd34d';
  ctx.fillText(truncateTextToWidth(ctx, schoolName.toUpperCase(), titleMaxW), 60, 8);

  ctx.font = `900 12px ${FONT_SANS}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncateTextToWidth(ctx, config.unitName, titleMaxW), 60, 21);

  const addrHeaderText =
    config.schoolAddress || schoolAddress || 'Jl. Pesantren Mambaul Ulum, Diwek, Jombang • Terakreditasi "A"';
  ctx.font = `500 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#dbeafe';
  ctx.fillText(truncateTextToWidth(ctx, addrHeaderText, Math.min(220, titleMaxW)), 60, 38);
  ctx.restore();

  // 3. Top Content Row: Student Portrait + Data Fields
  const photoX = 14;
  const photoY = 63;
  const photoW = 78;
  const photoH = 98;

  ctx.save();
  roundedRectPath(ctx, photoX, photoY, photoW, photoH, 8);
  ctx.fillStyle = '#1e40af';
  ctx.fill();
  ctx.clip();
  if (photoImg) {
    drawCoverTop(ctx, photoImg, photoX, photoY, photoW, photoH);
  }
  ctx.restore();

  // Border around portrait
  ctx.save();
  roundedRectPath(ctx, photoX, photoY, photoW, photoH, 8);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Gender caption
  ctx.font = `700 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(student.gender === 'L' ? 'LAKI-LAKI' : 'PEREMPUAN', photoX + photoW / 2, photoY + photoH + 4);
  ctx.restore();

  // Right Data Fields (x = 104 .. 411)
  const fieldX = 104;
  const fieldMaxW = CARD_W - 14 - fieldX;
  const colGap = 8;
  const colW = (fieldMaxW - colGap) / 2;
  const col2X = fieldX + colW + colGap;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Nama Lengkap
  ctx.font = `700 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Nama Lengkap', fieldX, 63);

  ctx.font = `900 11.5px ${FONT_SANS}`;
  ctx.fillStyle = '#0f172a';
  ctx.fillText(truncateTextToWidth(ctx, student.name.toUpperCase(), fieldMaxW), fieldX, 72);

  // NIS / NISN & Kelas & Unit
  ctx.font = `700 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('NIS / NISN', fieldX, 92);
  ctx.fillText('Kelas & Unit', col2X, 92);

  ctx.font = `900 9px ${FONT_MONO}`;
  const nisPrefix = `${student.nis} / `;
  ctx.fillStyle = '#1e293b';
  ctx.fillText(nisPrefix, fieldX, 102);
  const nisPrefixW = ctx.measureText(nisPrefix).width;
  ctx.fillStyle = '#1d4ed8';
  ctx.fillText(truncateTextToWidth(ctx, student.nisn || student.nis, Math.max(30, colW - nisPrefixW)), fieldX + nisPrefixW, 102);

  ctx.font = `700 9px ${FONT_SANS}`;
  ctx.fillStyle = '#1e293b';
  ctx.fillText(truncateTextToWidth(ctx, `${schoolClass?.name || 'Reguler'} (${config.level})`, colW), col2X, 102);

  // Tempat, Tgl Lahir & Masa Berlaku
  ctx.font = `700 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Tempat, Tgl Lahir', fieldX, 120);
  ctx.fillText('Masa Berlaku', col2X, 120);

  ctx.font = `600 8.5px ${FONT_SANS}`;
  ctx.fillStyle = '#334155';
  ctx.fillText(truncateTextToWidth(ctx, formatStudentBirthLineForCard(student.birthPlace, student.birthDate), colW), fieldX, 130);

  ctx.fillStyle = '#047857';
  ctx.fillText('Selama Menjadi Santri', col2X, 130);

  // Alamat
  if (student.address) {
    ctx.font = `700 7px ${FONT_SANS}`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Alamat', fieldX, 148);

    ctx.font = `500 8px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(truncateTextToWidth(ctx, student.address, fieldMaxW), fieldX, 157);
  }
  ctx.restore();

  // 4. Bottom Row: Barcode NISN (Left, raised cleanly) & Principal Signature + Stamp (Right)
  const barcodeBoxX = 14;
  const barcodeBoxY = 186;
  const barcodeBoxW = 200;
  const barcodeBoxH = 58;

  ctx.save();
  roundedRectPath(ctx, barcodeBoxX, barcodeBoxY, barcodeBoxW, barcodeBoxH, 11);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw crisp Code128 vector bars
  const barcodeVal = student.nisn || student.barcodeCard || student.nis;
  const pattern = getCode128Pattern(barcodeVal);
  let totalUnits = 0;
  for (let i = 0; i < pattern.length; i++) {
    totalUnits += parseInt(pattern[i], 10) || 1;
  }
  const innerBarPadX = 10;
  const availBarW = barcodeBoxW - innerBarPadX * 2;
  const unitW = availBarW / Math.max(1, totalUnits);
  let bx = barcodeBoxX + innerBarPadX;
  const by = barcodeBoxY + 7;
  const bh = 30;
  ctx.fillStyle = '#111827';
  for (let i = 0; i < pattern.length; i++) {
    const wUnits = parseInt(pattern[i], 10) || 1;
    const bw = wUnits * unitW;
    if (i % 2 === 0) {
      ctx.fillRect(bx, by, Math.max(0.6, bw), bh);
    }
    bx += bw;
  }

  ctx.font = `900 9.5px ${FONT_MONO}`;
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`NISN: ${student.nisn || student.nis}`, barcodeBoxX + barcodeBoxW / 2, barcodeBoxY + 41);
  ctx.restore();

  // Principal Signature & Stamp (Bottom Right)
  const sigRightX = CARD_W - 15;
  const sigMaxTextW = 192;
  const hasCustomSignature = Boolean(config.principalSignatureUrl && String(config.principalSignatureUrl).trim()) || Boolean(signatureImg);
  const shouldHideDefaultStamp = config.hideStamp ?? hasCustomSignature;

  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';

  ctx.font = `500 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#64748b';
  ctx.fillText(
    truncateTextToWidth(ctx, config.signaturePlaceDate?.trim() || 'Jombang, 15 Juli 2026', sigMaxTextW),
    sigRightX,
    181
  );

  ctx.font = `700 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#334155';
  ctx.fillText(truncateTextToWidth(ctx, `Kepala ${config.unitName}`, sigMaxTextW), sigRightX, 191);

  // Stamp behind signature
  if (stampImg) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    const fitSt = fitContain(stampImg.naturalWidth, stampImg.naturalHeight, 56, 56);
    ctx.drawImage(stampImg, sigRightX - 48 - fitSt.drawW, 194 + fitSt.offsetY, fitSt.drawW, fitSt.drawH);
    ctx.restore();
  } else if (!shouldHideDefaultStamp && fallbackSealImg) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.drawImage(fallbackSealImg, sigRightX - 96, 194, 56, 56);
    ctx.restore();
  }

  // Signature on top of stamp (following signatureScale)
  const sigSlotTop = 201;
  const sigSlotBottom = 247;
  const sigSlotMidY = (sigSlotTop + sigSlotBottom) / 2;
  const sigScalePct = Math.min(180, Math.max(60, Number(config.signatureScale ?? 100)));
  const sigScale = sigScalePct / 100;

  if (signatureImg) {
    const maxSigH = sigScalePct !== 100 ? Math.round(44 * sigScale) : 54;
    const maxSigW = sigScalePct !== 100 ? Math.min(194, Math.round(170 * sigScale)) : 175;
    const fitSig = fitContain(signatureImg.naturalWidth, signatureImg.naturalHeight, maxSigW, maxSigH);
    const drawSigX = sigRightX - fitSig.drawW;
    const drawSigY = Math.max(186, Math.min(sigSlotBottom - fitSig.drawH, sigSlotMidY - fitSig.drawH / 2));
    ctx.drawImage(signatureImg, drawSigX, drawSigY, fitSig.drawW, fitSig.drawH);
  } else if (fallbackSigImg) {
    ctx.drawImage(fallbackSigImg, sigRightX - 96, 206, 96, 36);
  }

  // Principal Name (underlined) + NIP
  const pNameText = truncateTextToWidth(ctx, config.principalName, sigMaxTextW);
  ctx.font = `700 8px ${FONT_SANS}`;
  ctx.fillStyle = '#0f172a';
  ctx.fillText(pNameText, sigRightX, 248);
  const pNameW = ctx.measureText(pNameText).width;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(sigRightX - pNameW, 257.5);
  ctx.lineTo(sigRightX, 257.5);
  ctx.stroke();

  ctx.font = `500 7px ${FONT_MONO}`;
  ctx.fillStyle = '#64748b';
  ctx.fillText(truncateTextToWidth(ctx, config.principalNip, sigMaxTextW), sigRightX, 259.5);
  ctx.restore();

  // Restore interior clip and draw outer crisp border
  ctx.restore();
  roundedRectPath(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 15);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  return canvas.toDataURL('image/jpeg', 0.96);
}

export async function renderStudentCardBackJpeg(params: RenderCardParams): Promise<string> {
  const { schoolName, schoolAddress, foundationWebsite, config, assets } = params;
  const targetWebsite = config.websiteUrl || foundationWebsite || 'https://mambaululum.sch.id';
  const cleanWebsiteUrl = targetWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const fallbackQrUrl = getFallbackQrSvgDataUrl(targetWebsite);

  const [logoImg, watermarkImg, rawQrImg] = await Promise.all([
    loadDecodedImage(assets.logo),
    loadDecodedImage(assets.watermark),
    loadDecodedImage(assets.qr || fallbackQrUrl),
  ]);
  const [qrImg, fallbackEmblemImg] = await Promise.all([
    rawQrImg ? Promise.resolve(rawQrImg) : loadDecodedImage(fallbackQrUrl),
    logoImg ? Promise.resolve(null) : loadDecodedImage(DEFAULT_EMBLEM_SVG),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * EXPORT_SCALE;
  canvas.height = CARD_H * EXPORT_SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context tidak tersedia');

  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  ctx.save();
  roundedRectPath(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 15);
  ctx.clip();

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 1. Watermark Layer
  drawWatermarkLayer(ctx, watermarkImg);

  // 2. Header Back Side
  const pad = 14;
  ctx.save();
  if (logoImg) {
    const cx = pad + 12;
    const cy = 26;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.clip();
    const fitL = fitContain(logoImg.naturalWidth, logoImg.naturalHeight, 20, 20);
    ctx.drawImage(logoImg, cx - 10 + fitL.offsetX, cy - 10 + fitL.offsetY, fitL.drawW, fitL.drawH);
  } else if (fallbackEmblemImg) {
    ctx.drawImage(fallbackEmblemImg, pad, 14, 24, 24);
  }
  ctx.restore();

  // Header Badge on Right
  ctx.save();
  ctx.font = `700 7.5px ${FONT_SANS}`;
  const badgeLbl = 'VISI, MISI & TATA TERTIB';
  const badgeW = ctx.measureText(badgeLbl).width + 14;
  const badgeX = CARD_W - pad - badgeW;
  roundedRectPath(ctx, badgeX, 16, badgeW, 17, 4);
  ctx.fillStyle = '#f1f5f9';
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#475569';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeLbl, badgeX + badgeW / 2, 24.5);

  // Header Titles
  const backTitleMaxW = Math.max(120, badgeX - (pad + 32) - 8);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `900 10px ${FONT_SANS}`;
  ctx.fillStyle = '#0f172a';
  ctx.fillText(truncateTextToWidth(ctx, schoolName.toUpperCase(), backTitleMaxW), pad + 31, 15);

  ctx.font = `700 8.5px ${FONT_SANS}`;
  ctx.fillStyle = '#1d4ed8';
  ctx.fillText(truncateTextToWidth(ctx, config.unitName, backTitleMaxW), pad + 31, 27);

  // Divider under header
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, 45);
  ctx.lineTo(CARD_W - pad, 45);
  ctx.stroke();
  ctx.restore();

  // 3. Body Two Columns
  const qrBoxW = 104;
  const qrBoxX = CARD_W - pad - qrBoxW;
  const qrBoxY = 56;
  const qrBoxH = 148;
  const leftColW = qrBoxX - pad - 12;

  // Left Column: Visi, Misi & Ketentuan
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let curY = 54;

  ctx.font = `900 8px ${FONT_SANS}`;
  ctx.fillStyle = '#1e40af';
  ctx.fillText('★ VISI SEKOLAH:', pad, curY);
  curY += 12;

  ctx.font = `italic 500 7.5px ${FONT_SANS}`;
  const visionLines = wrapTextLines(ctx, `"${config.vision}"`, leftColW - 10, 3);
  const visionBlockH = Math.max(12, visionLines.length * 10);
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(pad + 1, curY, 2, visionBlockH - 2);
  ctx.fillStyle = '#334155';
  visionLines.forEach((line, idx) => {
    ctx.fillText(line, pad + 7, curY + idx * 10);
  });
  curY += visionBlockH + 6;

  // Misi
  ctx.font = `900 8px ${FONT_SANS}`;
  ctx.fillStyle = '#1e40af';
  ctx.fillText('★ MISI SEKOLAH:', pad, curY);
  curY += 12;

  ctx.font = `500 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#334155';
  (config.missions || []).slice(0, 3).forEach((m, idx) => {
    const mText = truncateTextToWidth(ctx, `${idx + 1}. ${m}`, leftColW - 4);
    ctx.fillText(mText, pad + 2, curY);
    curY += 10.5;
  });

  curY += 5;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, curY);
  ctx.lineTo(pad + leftColW, curY);
  ctx.stroke();
  curY += 6;

  // Ketentuan
  ctx.font = `900 8px ${FONT_SANS}`;
  ctx.fillStyle = '#92400e';
  ctx.fillText('★ KETENTUAN KARTU PELAJAR:', pad, curY);
  curY += 11.5;

  const rules = [
    '• Wajib dibawa setiap hari untuk presensi smart kiosk deteksi barcode & RFID.',
    '• Kartu tidak boleh dipinjamkan atau dialihkan kepada pihak lain.',
    '• Jika kartu hilang/rusak, segera lapor ke bagian Tata Usaha Yayasan.',
  ];
  ctx.font = `500 7px ${FONT_SANS}`;
  ctx.fillStyle = '#475569';
  rules.forEach((rText) => {
    const rLines = wrapTextLines(ctx, rText, leftColW - 2, 2);
    rLines.forEach((rl) => {
      if (curY < 236) {
        ctx.fillText(rl, pad + 1, curY);
        curY += 9.5;
      }
    });
  });
  ctx.restore();

  // Right Column: QR Website Box
  ctx.save();
  roundedRectPath(ctx, qrBoxX, qrBoxY, qrBoxW, qrBoxH, 12);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `900 7.5px ${FONT_SANS}`;
  ctx.fillStyle = '#1e293b';
  ctx.fillText('KODE QR WEBSITE', qrBoxX + qrBoxW / 2, qrBoxY + 10);

  const qrInnerW = 72;
  const qrInnerX = qrBoxX + (qrBoxW - qrInnerW) / 2;
  const qrInnerY = qrBoxY + 24;
  roundedRectPath(ctx, qrInnerX, qrInnerY, qrInnerW, qrInnerW, 8);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (qrImg) {
    const fitQ = fitContain(qrImg.naturalWidth, qrImg.naturalHeight, qrInnerW - 8, qrInnerW - 8);
    ctx.drawImage(qrImg, qrInnerX + 4 + fitQ.offsetX, qrInnerY + 4 + fitQ.offsetY, fitQ.drawW, fitQ.drawH);
  }

  ctx.font = `700 6.5px ${FONT_MONO}`;
  ctx.fillStyle = '#1e40af';
  ctx.fillText(truncateTextToWidth(ctx, cleanWebsiteUrl, qrBoxW - 10), qrBoxX + qrBoxW / 2, qrInnerY + qrInnerW + 7);

  ctx.font = `500 6px ${FONT_SANS}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Scan untuk Info Resmi', qrBoxX + qrBoxW / 2, qrInnerY + qrInnerW + 17);
  ctx.restore();

  // 4. Footer Contact Info
  ctx.save();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, 245);
  ctx.lineTo(CARD_W - pad, 245);
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.font = `500 7px ${FONT_SANS}`;
  ctx.fillStyle = '#64748b';

  ctx.textAlign = 'right';
  const rightFooter = `Web: ${cleanWebsiteUrl} • Telp: (0321) 876543`;
  const rightFooterW = ctx.measureText(rightFooter).width;
  ctx.fillText(rightFooter, CARD_W - pad, 251);

  ctx.textAlign = 'left';
  const leftFooterMaxW = Math.max(100, CARD_W - pad * 2 - rightFooterW - 10);
  const footAddr = `Alamat: ${config.schoolAddress || schoolAddress || 'Jl. Pesantren Mambaul Ulum, Diwek, Jombang'}`;
  ctx.fillText(truncateTextToWidth(ctx, footAddr, leftFooterMaxW), pad, 251);
  ctx.restore();

  // Outer card border
  ctx.restore();
  roundedRectPath(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 15);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  return canvas.toDataURL('image/jpeg', 0.96);
}
