import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  BookOpen,
  PenTool,
  RotateCcw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Search,
  Calendar,
  Download,
  Phone,
  MapPin,
  User,
  FileText,
  ArrowLeft,
  Loader2,
  X,
  ZoomIn,
  Camera,
  Upload,
  Image as ImageIcon,
  Plus,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import { GuestBookEntry } from '../../types/index.ts';
import {
  gasGet,
  gasPost,
  getWibTodayStr,
  primeDrivePhotoCache,
  invalidateDrivePhotoCache,
} from '../../lib/api.ts';
import { emitActionToast } from '../../lib/toast.ts';
import { formatIndoDate } from '../../lib/homeroomRecap.ts';
import { DriveImage } from '../common/DriveImage.tsx';
import { ConfirmModal } from '../common/ConfirmModal.tsx';

interface GuestBookViewProps {
  onReturnToPortal?: () => void;
  showHistory?: boolean;
  embedded?: boolean;
}

interface StrokePoint {
  x: number;
  y: number;
}

async function compressGuestPhotoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Gagal membaca file foto yang dipilih.'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('File bukan gambar yang valid.'));
      img.onload = () => {
        const maxDim = 960;
        let targetW = img.width || 640;
        let targetH = img.height || 480;
        if (targetW > maxDim || targetH > maxDim) {
          if (targetW >= targetH) {
            targetH = Math.round((targetH * maxDim) / targetW);
            targetW = maxDim;
          } else {
            targetW = Math.round((targetW * maxDim) / targetH);
            targetH = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, targetW);
        canvas.height = Math.max(1, targetH);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export const GuestBookView: React.FC<GuestBookViewProps> = ({
  onReturnToPortal,
  showHistory = false,
  embedded = false,
}) => {
  const { user, isAuthenticated } = useAuth();
  const {
    settings,
    guestBook: syncedGuestBook,
    serverVersion,
    notifyFaceDatabaseChanged,
  } = useSync();

  const canManageHistory =
    showHistory &&
    isAuthenticated &&
    (user?.role === 'admin' || user?.role === 'kepala_sekolah' || user?.role === 'superadmin');

  // Inside Principal / Admin dashboards, show history prominently and allow toggling quick entry form
  const [showEmbeddedForm, setShowEmbeddedForm] = useState(false);
  const shouldRenderForm = !canManageHistory || showEmbeddedForm;

  // Form state
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [purpose, setPurpose] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [photoLabel, setPhotoLabel] = useState('');
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const photoUploadInputRef = useRef<HTMLInputElement | null>(null);
  const photoCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Signature pad state & refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef<StrokePoint[][]>([]);
  const currentStrokeRef = useRef<StrokePoint[] | null>(null);
  const isDrawingRef = useRef<boolean>(false);
  const [hasSignature, setHasSignature] = useState(false);

  // History & filter state (only active for Principal / Admin)
  const [entries, setEntries] = useState<GuestBookEntry[]>(canManageHistory ? syncedGuestBook : []);
  const [loadingList, setLoadingList] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [previewEntry, setPreviewEntry] = useState<GuestBookEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuestBookEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (canManageHistory) {
      setEntries(syncedGuestBook);
    } else {
      setEntries([]);
    }
  }, [canManageHistory, syncedGuestBook]);

  const fetchGuestBook = useCallback(async (silent = true) => {
    if (!canManageHistory) return;
    if (!silent) setLoadingList(true);
    try {
      const res = await gasGet<GuestBookEntry[]>('guestBook', {
        date: dateFilter || undefined,
      });
      if (res.success && Array.isArray(res.data)) {
        setEntries(res.data);
      }
    } catch {
      // Fall back to syncedGuestBook
    } finally {
      setLoadingList(false);
    }
  }, [canManageHistory, dateFilter]);

  useEffect(() => {
    if (canManageHistory) {
      void fetchGuestBook(true);
    }
  }, [canManageHistory, serverVersion, fetchGuestBook]);

  // Redraw canvas helper from stored strokes
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Signing baseline
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(20, height - 34);
    ctx.lineTo(width - 20, height - 34);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawPolyline = (pts: StrokePoint[]) => {
      if (pts.length === 0) return;
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, 1.3, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        return;
      }
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const midX = (pts[i].x + pts[i + 1].x) / 2;
        const midY = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    };

    for (const s of strokesRef.current) {
      drawPolyline(s);
    }
    if (currentStrokeRef.current) {
      drawPolyline(currentStrokeRef.current);
    }
    ctx.restore();
  }, []);

  // Size canvas cleanly on mount, form toggle, and window resize
  useEffect(() => {
    if (!shouldRenderForm) return;
    const syncCanvasSize = () => {
      const canvas = canvasRef.current;
      const box = containerRef.current;
      if (!canvas || !box) return;
      const rect = box.getBoundingClientRect();
      const targetW = Math.max(260, Math.floor(rect.width));
      const targetH = 190;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== Math.floor(targetW * dpr) || canvas.height !== Math.floor(targetH * dpr)) {
        canvas.width = Math.floor(targetW * dpr);
        canvas.height = Math.floor(targetH * dpr);
        canvas.style.width = `${targetW}px`;
        canvas.style.height = `${targetH}px`;
      }
      redrawCanvas();
    };

    const raf = requestAnimationFrame(syncCanvasSize);
    window.addEventListener('resize', syncCanvasSize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncCanvasSize);
    };
  }, [shouldRenderForm, redrawCanvas]);

  const getPointerCoords = (e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isSubmitting) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getPointerCoords(e);
    isDrawingRef.current = true;
    currentStrokeRef.current = [pt];
    setHasSignature(true);
    redrawCanvas();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !currentStrokeRef.current) return;
    e.preventDefault();
    const pt = getPointerCoords(e);
    const prev = currentStrokeRef.current[currentStrokeRef.current.length - 1];
    if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) >= 1.2) {
      currentStrokeRef.current.push(pt);
      redrawCanvas();
    }
  };

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (e && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    }
    if (currentStrokeRef.current && currentStrokeRef.current.length > 0) {
      strokesRef.current.push(currentStrokeRef.current);
      currentStrokeRef.current = null;
      setHasSignature(strokesRef.current.length > 0);
      redrawCanvas();
    }
  };

  const handleUndoSignature = () => {
    if (strokesRef.current.length === 0) return;
    strokesRef.current.pop();
    setHasSignature(strokesRef.current.length > 0);
    redrawCanvas();
  };

  const handleClearSignature = () => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    isDrawingRef.current = false;
    setHasSignature(false);
    redrawCanvas();
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFormMessage({ type: 'error', text: 'File yang dipilih harus berupa gambar (JPG/PNG/WEBP).' });
      return;
    }

    setIsProcessingPhoto(true);
    setFormMessage(null);
    try {
      const compressed = await compressGuestPhotoFile(file);
      setPhotoDataUrl(compressed);
      setPhotoLabel(file.name || 'foto-tamu.jpg');
    } catch (err: any) {
      setFormMessage({ type: 'error', text: err?.message || 'Gagal memproses foto tamu.' });
    } finally {
      setIsProcessingPhoto(false);
    }
  };

  const handleClearPhoto = () => {
    setPhotoDataUrl('');
    setPhotoLabel('');
  };

  const exportCleanSignatureDataUrl = (): string => {
    const canvas = canvasRef.current;
    if (!canvas) return '';
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 640;
    exportCanvas.height = 240;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return canvas.toDataURL('image/png');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const srcW = Math.max(1, canvas.width / dpr);
    const srcH = Math.max(1, canvas.height / dpr);
    const scaleX = exportCanvas.width / srcW;
    const scaleY = exportCanvas.height / srcH;

    ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#0f172a';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      if (stroke.length === 1) {
        ctx.arc(stroke[0].x * scaleX, stroke[0].y * scaleY, 1.8, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.moveTo(stroke[0].x * scaleX, stroke[0].y * scaleY);
      for (let i = 1; i < stroke.length - 1; i++) {
        const midX = ((stroke[i].x + stroke[i + 1].x) / 2) * scaleX;
        const midY = ((stroke[i].y + stroke[i + 1].y) / 2) * scaleY;
        ctx.quadraticCurveTo(stroke[i].x * scaleX, stroke[i].y * scaleY, midX, midY);
      }
      const last = stroke[stroke.length - 1];
      ctx.lineTo(last.x * scaleX, last.y * scaleY);
      ctx.stroke();
    }

    return exportCanvas.toDataURL('image/png');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isProcessingPhoto) return;
    setFormMessage(null);

    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const trimmedAddress = address.trim();
    const trimmedPurpose = purpose.trim();

    if (!trimmedName) {
      setFormMessage({ type: 'error', text: 'Nama lengkap tamu wajib diisi.' });
      return;
    }
    if (!trimmedPhone) {
      setFormMessage({ type: 'error', text: 'Nomor HP / WhatsApp tamu wajib diisi.' });
      return;
    }
    if (!trimmedAddress) {
      setFormMessage({ type: 'error', text: 'Alamat lengkap tamu wajib diisi.' });
      return;
    }
    if (!hasSignature || strokesRef.current.length === 0) {
      setFormMessage({ type: 'error', text: 'Silakan bubuhkan tanda tangan digital pada kotak tanda tangan.' });
      return;
    }

    setIsSubmitting(true);
    try {
      const signatureDataUrl = exportCleanSignatureDataUrl();
      const uploadedPhoto = photoDataUrl;
      const res = await gasPost<GuestBookEntry>('saveGuestEntry', {
        name: trimmedName,
        phone: trimmedPhone,
        address: trimmedAddress,
        purpose: trimmedPurpose,
        photoDataUrl: uploadedPhoto || undefined,
        signatureDataUrl,
        actor: user?.name || trimmedName,
      });

      if (res.success && res.data) {
        if (res.data.signatureFileId) {
          primeDrivePhotoCache(res.data.signatureFileId, signatureDataUrl);
        }
        if (res.data.photoFileId && uploadedPhoto) {
          primeDrivePhotoCache(res.data.photoFileId, uploadedPhoto);
        }
        if (canManageHistory) {
          setEntries((prev) => [res.data!, ...prev.filter((item) => item.id !== res.data!.id)]);
          setShowEmbeddedForm(false);
        }
        setName('');
        setPhone('');
        setAddress('');
        setPurpose('');
        handleClearPhoto();
        handleClearSignature();
        const msg = `Kunjungan "${trimmedName}"${uploadedPhoto ? ', foto tamu,' : ''} dan tanda tangan digital berhasil disimpan ke Google Sheets & Drive.`;
        setFormMessage({ type: 'success', text: msg });
        emitActionToast({ type: 'saved', title: 'Tamu Tercatat', message: msg });
        await notifyFaceDatabaseChanged();
      } else {
        const errMsg = res.error || 'Gagal menyimpan data buku tamu.';
        setFormMessage({ type: 'error', text: errMsg });
        emitActionToast({ type: 'error', title: 'Gagal', message: errMsg });
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menyimpan data buku tamu.';
      setFormMessage({ type: 'error', text: errMsg });
      emitActionToast({ type: 'error', title: 'Gagal', message: errMsg });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    try {
      const res = await gasPost('softDeleteRecord', {
        entity: 'GuestBook',
        id: deleteTarget.id,
        expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
      });
      if (!res?.success) {
        throw new Error(res?.error || 'Gagal menghapus data tamu.');
      }
      if (deleteTarget.signatureFileId) {
        invalidateDrivePhotoCache(deleteTarget.signatureFileId);
      }
      if (deleteTarget.photoFileId) {
        invalidateDrivePhotoCache(deleteTarget.photoFileId);
      }
      setEntries((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      const deletedName = deleteTarget.name;
      setDeleteTarget(null);
      emitActionToast({
        type: 'deleted',
        title: 'Terhapus',
        message: `Data tamu "${deletedName}" beserta file foto & tanda tangan di Drive telah dihapus.`,
      });
      await notifyFaceDatabaseChanged();
    } catch (err: any) {
      emitActionToast({
        type: 'error',
        title: 'Gagal',
        message: err?.message || 'Gagal menghapus data tamu.',
      });
      setDeleteTarget(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const filteredEntries = useMemo(() => {
    if (!canManageHistory) return [];
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((item) => {
      if (dateFilter && item.date !== dateFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.address.toLowerCase().includes(q) ||
        item.phone.toLowerCase().includes(q) ||
        String(item.purpose || '').toLowerCase().includes(q)
      );
    });
  }, [canManageHistory, entries, searchQuery, dateFilter]);

  const todayStr = getWibTodayStr();
  const todayCount = useMemo(
    () => entries.filter((item) => item.date === todayStr).length,
    [entries, todayStr]
  );
  const withPhotoCount = useMemo(
    () => entries.filter((item) => Boolean(item.photoFileId || item.photoUrl)).length,
    [entries]
  );

  const handleExportExcel = () => {
    const rows = filteredEntries.map((item, idx) => ({
      No: idx + 1,
      Tanggal: item.date,
      Waktu_WIB: item.time,
      Nama_Tamu: item.name,
      No_HP: item.phone,
      Alamat: item.address,
      Keperluan: item.purpose || '-',
      Foto: item.photoFileId || item.photoUrl ? 'Ada (Drive)' : 'Tidak Ada',
      ID_File_Foto_Drive: item.photoFileId || '-',
      ID_File_TTD_Drive: item.signatureFileId || '-',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Riwayat_Tamu_Sekolah');
    XLSX.writeFile(wb, `Riwayat_Tamu_Sekolah_${dateFilter || todayStr}.xlsx`);
  };

  const formCard = (
    <div className="p-5 sm:p-7 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            Formulir Daftar Tamu Sekolah
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Isi identitas kunjungan, unggah foto tamu (jika tersedia), dan bubuhkan tanda tangan digital.
          </p>
        </div>
        {canManageHistory && showEmbeddedForm && (
          <button
            type="button"
            onClick={() => setShowEmbeddedForm(false)}
            className="p-2 min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-white flex items-center justify-center cursor-pointer"
            title="Tutup formulir"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {formMessage && (
        <div
          className={`p-3.5 rounded-xl text-xs font-medium flex items-start gap-2.5 border ${
            formMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {formMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          )}
          <span>{formMessage.text}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Nama Lengkap Tamu <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contoh: H. Ahmad Fauzi"
                className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                required
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              No. HP / WhatsApp <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Contoh: 081234567890"
                className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30 font-mono tabular-nums"
                required
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            Alamat Lengkap <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <textarea
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Contoh: Jl. Merdeka No. 12, Kec. Diwek, Kab. Jombang"
              className="w-full pl-9 pr-3.5 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              required
            />
          </div>
        </div>

        <div>
          <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            Keperluan / Bertemu Siapa (Opsional)
          </label>
          <div className="relative">
            <FileText className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Contoh: Wali Murid Kelas X / Kunjungan Dinas"
              className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
          </div>
        </div>

        {/* Upload Foto Tamu */}
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="font-semibold text-slate-700 dark:text-slate-300">
              Foto Tamu / Identitas (Opsional)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={photoUploadInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoFileChange}
                className="hidden"
              />
              <input
                ref={photoCameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoFileChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={isSubmitting || isProcessingPhoto}
                onClick={() => photoUploadInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold whitespace-nowrap transition cursor-pointer disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Foto</span>
              </button>
              <button
                type="button"
                disabled={isSubmitting || isProcessingPhoto}
                onClick={() => photoCameraInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-xl bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/50 dark:hover:bg-teal-900/50 text-teal-800 dark:text-teal-200 border border-teal-200 dark:border-teal-800 font-semibold whitespace-nowrap transition cursor-pointer disabled:opacity-50"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Ambil Kamera</span>
              </button>
            </div>
          </div>

          {isProcessingPhoto ? (
            <div className="flex items-center gap-2 p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
              <span>Memproses dan mengompres foto tamu...</span>
            </div>
          ) : photoDataUrl ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={photoDataUrl}
                  alt="Preview foto tamu"
                  className="w-16 h-16 rounded-lg object-cover border border-slate-200 dark:border-slate-700 flex-shrink-0 bg-white"
                />
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 dark:text-white truncate">
                    {photoLabel || 'Foto Tamu Siap Diunggah'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Siap disimpan ke folder Drive 07_Foto_Tamu_Sekolah
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClearPhoto}
                disabled={isSubmitting}
                className="inline-flex items-center gap-1 px-3 py-2 min-h-[40px] rounded-xl text-red-700 dark:text-red-300 bg-red-50 hover:bg-red-100 dark:bg-red-950/40 font-semibold whitespace-nowrap transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Hapus</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 p-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400">
              <ImageIcon className="w-4 h-4 flex-shrink-0 text-slate-400" />
              <span>Belum ada foto dipilih. Gunakan tombol Upload Foto atau Ambil Kamera di atas.</span>
            </div>
          )}
        </div>

        {/* Signature Canvas Pad */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between gap-2">
            <label className="font-semibold text-slate-700 dark:text-slate-300">
              Tanda Tangan Digital <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleUndoSignature}
                disabled={!hasSignature || isSubmitting}
                className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[40px] rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold disabled:opacity-40 whitespace-nowrap transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Urungkan</span>
              </button>
              <button
                type="button"
                onClick={handleClearSignature}
                disabled={!hasSignature || isSubmitting}
                className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[40px] rounded-xl bg-red-50 hover:bg-red-100 dark:bg-red-950/40 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 text-xs font-semibold disabled:opacity-40 whitespace-nowrap transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Hapus TTD</span>
              </button>
            </div>
          </div>

          <div
            ref={containerRef}
            className="relative rounded-xl border border-slate-300 dark:border-slate-700 bg-white overflow-hidden select-none"
          >
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              className="block w-full touch-none cursor-crosshair"
            />
            {!hasSignature && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-medium text-slate-400 px-4 text-center">
                Goreskan tanda tangan di area ini (sentuh layar atau mouse)
              </div>
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={isSubmitting || isProcessingPhoto}
          className="w-full py-3 px-5 min-h-[44px] rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-bold disabled:opacity-60 transition flex items-center justify-center gap-2 cursor-pointer"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Menyimpan ke Sheet &amp; Drive...</span>
            </>
          ) : (
            <>
              <PenTool className="w-4 h-4" />
              <span>Simpan Daftar Tamu</span>
            </>
          )}
        </button>
      </form>
    </div>
  );

  // PUBLIC GUEST KIOSK VIEW (Form Only — History restricted to Principal & Admin)
  if (!canManageHistory) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {!embedded && (
          <div className="rounded-2xl bg-slate-900 dark:bg-slate-900 border border-slate-800 p-6 sm:p-7 text-white">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-teal-300">
                  Buku Tamu Digital · {settings?.schoolName || 'Yayasan Mambaul Ulum'}
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                  Daftar Tamu Sekolah
                </h1>
                <p className="text-xs sm:text-sm text-slate-300 max-w-xl">
                  Silakan lengkapi data kunjungan, unggah foto tamu, dan bubuhkan tanda tangan digital. Riwayat kunjungan diarsipkan aman untuk Kepala Sekolah &amp; Admin.
                </p>
              </div>
              {onReturnToPortal && (
                <button
                  type="button"
                  onClick={onReturnToPortal}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold whitespace-nowrap transition self-start sm:self-center cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Kembali ke Menu</span>
                </button>
              )}
            </div>
          </div>
        )}

        {formCard}
      </div>
    );
  }

  // PRINCIPAL & ADMIN MANAGEMENT VIEW (Full Guest History + Optional Quick Add Form)
  return (
    <div className={`${embedded ? 'space-y-6' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6'}`}>
      {showEmbeddedForm && formCard}

      <div className="p-5 sm:p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-teal-600" />
              <span>Riwayat Tamu Sekolah</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>{filteredEntries.length} Tampil</span>
              <span aria-hidden="true">·</span>
              <span>{todayCount} Hari Ini</span>
              <span aria-hidden="true">·</span>
              <span>{withPhotoCount} Dengan Foto</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">Sheet GuestBook &amp; Drive</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEmbeddedForm((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold whitespace-nowrap transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showEmbeddedForm ? 'Tutup Formulir' : 'Catat Tamu Baru'}</span>
            </button>

            <button
              type="button"
              onClick={handleExportExcel}
              disabled={filteredEntries.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-40 whitespace-nowrap transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Ekspor Excel</span>
            </button>
          </div>
        </div>

        {/* Search & Date Filter */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama, alamat, nomor HP, atau keperluan..."
              className="w-full pl-8 pr-3 py-2 min-h-[40px] text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 min-h-[40px] rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <Calendar className="w-3.5 h-3.5 text-teal-600" />
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="text-xs font-semibold bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none font-mono tabular-nums"
            />
          </div>

          {dateFilter && (
            <button
              type="button"
              onClick={() => setDateFilter('')}
              className="px-3.5 py-2 min-h-[40px] rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 whitespace-nowrap transition cursor-pointer"
            >
              Semua Tanggal
            </button>
          )}
        </div>

        {/* Guest History Table */}
        {loadingList && filteredEntries.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">Memuat riwayat tamu sekolah...</div>
        ) : filteredEntries.length === 0 ? (
          <div className="py-12 px-4 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl space-y-3">
            <div>
              Belum ada catatan tamu sekolah{dateFilter ? ` pada tanggal ${formatIndoDate(dateFilter)}` : ''}.
            </div>
            {!showEmbeddedForm && (
              <button
                type="button"
                onClick={() => setShowEmbeddedForm(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold whitespace-nowrap transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Catat Kunjungan Pertama</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 font-semibold">
                  <th className="py-3 pr-3 whitespace-nowrap">Tanggal &amp; Jam</th>
                  <th className="py-3 pr-3 whitespace-nowrap">Foto Tamu</th>
                  <th className="py-3 pr-3 whitespace-nowrap">Nama &amp; No. HP</th>
                  <th className="py-3 pr-3 whitespace-nowrap">Alamat &amp; Keperluan</th>
                  <th className="py-3 pr-3 text-center whitespace-nowrap">Tanda Tangan</th>
                  <th className="py-3 text-right whitespace-nowrap">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredEntries.map((item) => {
                  const hasPhoto = Boolean(item.photoUrl || item.photoFileId);
                  const hasSig = Boolean(item.signatureUrl || item.signatureFileId);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {formatIndoDate(item.date)}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-500">
                          {item.time || '-'} WIB
                        </div>
                      </td>

                      <td className="py-3 pr-3">
                        {hasPhoto ? (
                          <button
                            type="button"
                            onClick={() => setPreviewEntry(item)}
                            className="group relative inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 hover:border-teal-500 transition cursor-pointer"
                            title="Klik untuk perbesar foto & detail tamu"
                          >
                            <DriveImage
                              src={item.photoUrl || `gas-photo://${item.photoFileId}`}
                              alt={`Foto ${item.name}`}
                              className="w-12 h-12 rounded-lg object-cover"
                            />
                            <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-slate-900/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                              <ZoomIn className="w-3 h-3" />
                            </span>
                          </button>
                        ) : (
                          <div className="w-12 h-12 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-center text-slate-400">
                            <User className="w-4 h-4" />
                          </div>
                        )}
                      </td>

                      <td className="py-3 pr-3 min-w-[150px]">
                        <div className="font-bold text-slate-900 dark:text-white">{item.name}</div>
                        <div className="text-[11px] font-mono tabular-nums text-teal-700 dark:text-teal-400 mt-0.5">
                          {item.phone}
                        </div>
                      </td>

                      <td className="py-3 pr-3 max-w-[260px]">
                        <div className="text-slate-700 dark:text-slate-300 leading-snug">{item.address}</div>
                        {item.purpose && (
                          <div className="text-[11px] text-slate-500 mt-1">
                            Keperluan: <span className="font-medium text-slate-700 dark:text-slate-300">{item.purpose}</span>
                          </div>
                        )}
                      </td>

                      <td className="py-3 pr-3 text-center">
                        {hasSig ? (
                          <button
                            type="button"
                            onClick={() => setPreviewEntry(item)}
                            className="group relative inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 bg-white p-1 hover:border-teal-500 transition cursor-pointer"
                            title="Klik untuk perbesar foto & tanda tangan"
                          >
                            <DriveImage
                              src={item.signatureUrl || `gas-photo://${item.signatureFileId}`}
                              alt={`TTD ${item.name}`}
                              className="w-24 h-10 object-contain"
                            />
                            <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-slate-900/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                              <ZoomIn className="w-3 h-3" />
                            </span>
                          </button>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>

                      <td className="py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setPreviewEntry(item)}
                            className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-slate-500 hover:text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/40 transition cursor-pointer"
                            title="Lihat detail, foto & tanda tangan"
                          >
                            <ZoomIn className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(item)}
                            className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition cursor-pointer"
                            title="Hapus catatan tamu, foto & TTD di Drive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Guest Photo & Signature Detail Modal */}
      {previewEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
          onClick={() => setPreviewEntry(null)}
        >
          <div
            className="w-full max-w-xl max-h-[90dvh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">{previewEntry.name}</h3>
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  {formatIndoDate(previewEntry.date)} · {previewEntry.time} WIB · {previewEntry.phone}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewEntry(null)}
                className="p-2 min-h-[40px] min-w-[40px] rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1.5 bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-700">
              <div><strong>Alamat:</strong> {previewEntry.address}</div>
              {previewEntry.purpose && <div><strong>Keperluan:</strong> {previewEntry.purpose}</div>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Foto Tamu</div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 flex items-center justify-center min-h-[170px]">
                  {previewEntry.photoUrl || previewEntry.photoFileId ? (
                    <DriveImage
                      src={previewEntry.photoUrl || `gas-photo://${previewEntry.photoFileId}`}
                      alt={`Foto ${previewEntry.name}`}
                      className="max-w-full max-h-[220px] rounded-lg object-contain"
                    />
                  ) : (
                    <div className="text-xs text-slate-400 flex flex-col items-center gap-1.5">
                      <User className="w-6 h-6" />
                      <span>Tidak ada foto terunggah</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Tanda Tangan Digital</div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white p-3 flex items-center justify-center min-h-[170px]">
                  {previewEntry.signatureUrl || previewEntry.signatureFileId ? (
                    <DriveImage
                      src={previewEntry.signatureUrl || `gas-photo://${previewEntry.signatureFileId}`}
                      alt={`Tanda Tangan ${previewEntry.name}`}
                      className="max-w-full max-h-[200px] object-contain"
                    />
                  ) : (
                    <span className="text-xs text-slate-400">Tidak ada tanda tangan</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Data Tamu Sekolah"
        message={`Hapus catatan kunjungan "${deleteTarget?.name || ''}" beserta file foto dan tanda tangan digital dari Google Drive?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
