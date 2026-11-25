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
  readOnly?: boolean;
}

interface StrokePoint {
  x: number;
  y: number;
}

export const GuestBookView: React.FC<GuestBookViewProps> = ({
  onReturnToPortal,
  readOnly = false,
}) => {
  const { user, isAuthenticated } = useAuth();
  const {
    settings,
    guestBook: syncedGuestBook,
    serverVersion,
    notifyFaceDatabaseChanged,
  } = useSync();

  const canManageEntries =
    isAuthenticated &&
    (user?.role === 'admin' || user?.role === 'kepala_sekolah' || user?.role === 'superadmin');

  // Form state
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [purpose, setPurpose] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Signature pad state & refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef<StrokePoint[][]>([]);
  const currentStrokeRef = useRef<StrokePoint[] | null>(null);
  const isDrawingRef = useRef<boolean>(false);
  const [hasSignature, setHasSignature] = useState(false);

  // List & filter state
  const [entries, setEntries] = useState<GuestBookEntry[]>(syncedGuestBook);
  const [loadingList, setLoadingList] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [previewEntry, setPreviewEntry] = useState<GuestBookEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuestBookEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setEntries(syncedGuestBook);
  }, [syncedGuestBook]);

  const fetchGuestBook = useCallback(async (silent = true) => {
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
  }, [dateFilter]);

  useEffect(() => {
    void fetchGuestBook(true);
  }, [serverVersion, fetchGuestBook]);

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

    // Subtle signing baseline
    ctx.strokeStyle = '#e2e8f0';
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

  // Size canvas cleanly on mount and resize without clearing existing strokes
  useEffect(() => {
    if (readOnly) return;
    const syncCanvasSize = () => {
      const canvas = canvasRef.current;
      const box = containerRef.current;
      if (!canvas || !box) return;
      const rect = box.getBoundingClientRect();
      const targetW = Math.max(260, Math.floor(rect.width));
      const targetH = 200;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== Math.floor(targetW * dpr) || canvas.height !== Math.floor(targetH * dpr)) {
        canvas.width = Math.floor(targetW * dpr);
        canvas.height = Math.floor(targetH * dpr);
        canvas.style.width = `${targetW}px`;
        canvas.style.height = `${targetH}px`;
      }
      redrawCanvas();
    };

    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);
    return () => window.removeEventListener('resize', syncCanvasSize);
  }, [readOnly, redrawCanvas]);

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

  const exportCleanSignatureDataUrl = (): string => {
    const canvas = canvasRef.current;
    if (!canvas) return '';
    // Export clean white-background PNG (without dashed baseline guide)
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
    if (isSubmitting) return;
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
      const res = await gasPost<GuestBookEntry>('saveGuestEntry', {
        name: trimmedName,
        phone: trimmedPhone,
        address: trimmedAddress,
        purpose: trimmedPurpose,
        signatureDataUrl,
        actor: user?.name || trimmedName,
      });

      if (res.success && res.data) {
        if (res.data.signatureFileId) {
          primeDrivePhotoCache(res.data.signatureFileId, signatureDataUrl);
        }
        setEntries((prev) => [res.data!, ...prev.filter((item) => item.id !== res.data!.id)]);
        setName('');
        setPhone('');
        setAddress('');
        setPurpose('');
        handleClearSignature();
        const msg = `Kunjungan "${trimmedName}" & tanda tangan digital tersimpan ke Google Sheets & Drive.`;
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
      setEntries((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      const deletedName = deleteTarget.name;
      setDeleteTarget(null);
      emitActionToast({
        type: 'deleted',
        title: 'Terhapus',
        message: `Data tamu "${deletedName}" & file tanda tangan Drive telah dihapus bersih.`,
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
  }, [entries, searchQuery, dateFilter]);

  const todayStr = getWibTodayStr();
  const todayCount = useMemo(
    () => entries.filter((item) => item.date === todayStr).length,
    [entries, todayStr]
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
      ID_File_TTD_Drive: item.signatureFileId || '-',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Buku_Tamu_Sekolah');
    XLSX.writeFile(wb, `Buku_Tamu_Sekolah_${dateFilter || todayStr}.xlsx`);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      {!readOnly && (
        <div className="rounded-3xl bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 p-6 sm:p-8 text-white shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-teal-200">
                <BookOpen className="w-4 h-4" />
                <span>Buku Tamu Digital • {settings?.schoolName || 'Yayasan Mambaul Ulum'}</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
                Menu Tamu Sekolah
              </h1>
              <p className="text-xs sm:text-sm text-slate-200 max-w-2xl">
                Pencatatan identitas tamu sekolah beserta tanda tangan digital langsung tersimpan aman ke database Google Sheets &amp; folder Google Drive.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 self-start sm:self-center">
              <div className="px-4 py-2.5 rounded-2xl bg-white/10 border border-white/15 text-xs">
                <div className="text-slate-300 text-[11px]">Tamu Hari Ini</div>
                <div className="text-lg font-black text-white">{todayCount} Pengunjung</div>
              </div>
              {onReturnToPortal && (
                <button
                  type="button"
                  onClick={onReturnToPortal}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-bold transition min-h-[44px]"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Kembali ke Menu</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={`grid grid-cols-1 ${readOnly ? '' : 'lg:grid-cols-12'} gap-6 items-start`}>
        {/* Form Pencatatan Tamu & Tanda Tangan Digital */}
        {!readOnly && (
          <div className="lg:col-span-5 p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <PenTool className="w-4 h-4 text-teal-600" />
                <span>Formulir Kunjungan Tamu</span>
              </h2>
              <p className="text-xs text-slate-500">
                Lengkapi nama, alamat, nomor HP, serta tanda tangan digital sebelum menyimpan.
              </p>
            </div>

            {formMessage && (
              <div
                className={`p-3.5 rounded-2xl text-xs font-semibold flex items-start gap-2.5 border ${
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

            <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
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
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  No. HP / WhatsApp <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Contoh: 081234567890"
                    className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
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
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
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
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-semibold disabled:opacity-40 transition"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Urungkan</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleClearSignature}
                      disabled={!hasSignature || isSubmitting}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 dark:bg-red-950/40 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 text-[11px] font-semibold disabled:opacity-40 transition"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Hapus TTD</span>
                    </button>
                  </div>
                </div>

                <div
                  ref={containerRef}
                  className="relative rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white overflow-hidden select-none"
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
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-medium text-slate-400">
                      Goreskan tanda tangan di area ini (sentuh layar atau mouse)
                    </div>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-5 min-h-[44px] rounded-2xl bg-teal-600 hover:bg-teal-700 text-white text-xs sm:text-sm font-bold shadow-md shadow-teal-600/20 disabled:opacity-60 transition flex items-center justify-center gap-2 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Menyimpan ke Sheet &amp; Drive...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Simpan Kunjungan &amp; Tanda Tangan</span>
                  </>
                )}
              </button>
            </form>
          </div>
        )}

        {/* Daftar & Riwayat Buku Tamu */}
        <div
          className={`${
            readOnly ? '' : 'lg:col-span-7'
          } p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-teal-600" />
                <span>Daftar Tamu Sekolah ({filteredEntries.length})</span>
              </h2>
              <p className="text-xs text-slate-500">
                Database sheet <code className="font-mono">GuestBook</code> &amp; file PNG di folder Drive{' '}
                <code className="font-mono">06_Tanda_Tangan_Tamu_Sekolah</code>.
              </p>
            </div>

            <button
              type="button"
              onClick={handleExportExcel}
              disabled={filteredEntries.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-40 transition self-start sm:self-center cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Ekspor Excel</span>
            </button>
          </div>

          {/* Search & Date Filter */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
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
                className="text-xs font-semibold bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none"
              />
            </div>

            {dateFilter && (
              <button
                type="button"
                onClick={() => setDateFilter('')}
                className="px-3 py-2 min-h-[40px] rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 transition"
              >
                Semua Tanggal
              </button>
            )}
          </div>

          {/* Table */}
          {loadingList && filteredEntries.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">Memuat daftar tamu...</div>
          ) : filteredEntries.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
              Belum ada catatan tamu sekolah{dateFilter ? ` pada tanggal ${formatIndoDate(dateFilter)}` : ''}.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[540px]">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 uppercase font-semibold">
                    <th className="py-2.5 pr-3">Tanggal &amp; Jam</th>
                    <th className="py-2.5 pr-3">Nama &amp; No. HP</th>
                    <th className="py-2.5 pr-3">Alamat &amp; Keperluan</th>
                    <th className="py-2.5 pr-3 text-center">Tanda Tangan</th>
                    {canManageEntries && <th className="py-2.5 text-right">Aksi</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredEntries.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {formatIndoDate(item.date)}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">{item.time || '-'} WIB</div>
                      </td>
                      <td className="py-3 pr-3 min-w-[150px]">
                        <div className="font-bold text-slate-900 dark:text-white">{item.name}</div>
                        <div className="text-[11px] font-mono text-teal-700 dark:text-teal-400 mt-0.5">
                          {item.phone}
                        </div>
                      </td>
                      <td className="py-3 pr-3 max-w-[240px]">
                        <div className="text-slate-700 dark:text-slate-300 leading-snug">{item.address}</div>
                        {item.purpose && (
                          <div className="text-[11px] text-slate-500 mt-1">
                            Keperluan: <span className="font-medium text-slate-700 dark:text-slate-300">{item.purpose}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-center">
                        {item.signatureUrl || item.signatureFileId ? (
                          <button
                            type="button"
                            onClick={() => setPreviewEntry(item)}
                            className="group relative inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 bg-white p-1 hover:border-teal-500 transition cursor-pointer"
                            title="Klik untuk perbesar tanda tangan"
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
                      {canManageEntries && (
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(item)}
                            className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition"
                            title="Hapus catatan tamu & TTD Drive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Signature Zoom Modal */}
      {previewEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
          onClick={() => setPreviewEntry(null)}
        >
          <div
            className="w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-slate-900 dark:text-white">{previewEntry.name}</h3>
                <p className="text-xs text-slate-500">
                  {formatIndoDate(previewEntry.date)} • {previewEntry.time} WIB • {previewEntry.phone}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewEntry(null)}
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1 bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700">
              <div><strong>Alamat:</strong> {previewEntry.address}</div>
              {previewEntry.purpose && <div><strong>Keperluan:</strong> {previewEntry.purpose}</div>}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center justify-center min-h-[180px]">
              <DriveImage
                src={previewEntry.signatureUrl || `gas-photo://${previewEntry.signatureFileId}`}
                alt={`Tanda Tangan ${previewEntry.name}`}
                className="max-w-full max-h-[220px] object-contain"
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Data Tamu Sekolah"
        message={`Hapus catatan kunjungan "${deleteTarget?.name || ''}" beserta file tanda tangan digital dari Google Drive?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
