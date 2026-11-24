import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import JSZip from 'jszip';
import { Student, SchoolClass } from '../types/index.ts';
import {
  DailyAttendanceIndex,
  DailyBreakdownRow,
  MonthBreakdownSummary,
  PeriodTotalsSummary,
  StudentPeriodTotals,
  formatIndoDate,
  formatIndoDateShort,
  getIndoDayName,
} from './homeroomRecap.ts';

export type HomeroomReportMode = 'today' | 'weekly' | 'monthly' | 'compare';

export interface PdfSchoolMeta {
  schoolName: string;
  schoolAddress?: string;
  academicYear?: string;
  classInfo?: SchoolClass;
  homeroomTeacherName: string;
  homeroomTeacherNip?: string;
  periodTitle: string;
  periodSubtitle: string;
  fileSlug: string;
  sessionLabel: string;
}

function sanitizeFilePart(str: string): string {
  return String(str || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getLastTableY(doc: jsPDF, fallbackY: number): number {
  const anyDoc = doc as unknown as { lastAutoTable?: { finalY?: number } };
  return typeof anyDoc.lastAutoTable?.finalY === 'number' ? anyDoc.lastAutoTable.finalY : fallbackY;
}

function drawReportHeader(doc: jsPDF, meta: PdfSchoolMeta, titleText: string): number {
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 14;

  // Top header bar accent
  doc.setFillColor(30, 58, 138); // Blue-900
  doc.rect(marginX, 11, pageW - marginX * 2, 1.5, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text((meta.schoolName || 'YAYASAN MAMBAUL ULUM').toUpperCase(), marginX, 18.5);

  if (meta.schoolAddress) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(doc.splitTextToSize(meta.schoolAddress, pageW - marginX * 2), marginX, 23);
  }

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.4);
  doc.line(marginX, 28, pageW - marginX, 28);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30, 64, 175);
  doc.text(titleText, marginX, 34.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  doc.text(
    `Kelas: ${meta.classInfo?.name || '-'}   |   Tahun Ajaran: ${meta.academicYear || '-'}   |   Sesi: ${meta.sessionLabel}`,
    marginX,
    39.5
  );
  doc.text(`Periode: ${meta.periodTitle} (${meta.periodSubtitle})`, marginX, 44);

  return 48;
}

function drawSignatureFooter(doc: jsPDF, meta: PdfSchoolMeta, startY: number): void {
  const pageH = doc.internal.pageSize.getHeight();
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 14;

  let sigY = startY + 8;
  if (sigY + 32 > pageH - 12) {
    doc.addPage();
    sigY = 20;
  }

  const rightCenterX = pageW - marginX - 32;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text(`Dicetak: ${formatIndoDate(new Date().toISOString().slice(0, 10))}`, marginX, sigY + 6);

  doc.setTextColor(15, 23, 42);
  doc.text('Mengetahui,', rightCenterX, sigY, { align: 'center' });
  doc.text(`Wali Kelas ${meta.classInfo?.name || ''}`, rightCenterX, sigY + 4.5, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.text(meta.homeroomTeacherName || '-', rightCenterX, sigY + 21, { align: 'center' });
  if (meta.homeroomTeacherNip) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`NIP. ${meta.homeroomTeacherNip}`, rightCenterX, sigY + 25.5, { align: 'center' });
  }
}

function renderStudentSectionIntoDoc(
  doc: jsPDF,
  params: {
    studentRow: StudentPeriodTotals;
    meta: PdfSchoolMeta;
    mode: HomeroomReportMode;
    selectedDate: string;
    activeDates: string[];
    dailyIndex: DailyAttendanceIndex;
    selectedMonths?: MonthBreakdownSummary[];
  }
): void {
  const { studentRow, meta, mode, selectedDate, activeDates, dailyIndex, selectedMonths = [] } = params;
  const student = studentRow.student;
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 14;

  let curY = drawReportHeader(doc, meta, 'LAPORAN REKAP PRESENSI SISWA');

  // Student Identity Card Box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(marginX, curY, pageW - marginX * 2, 18, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text(student.name.toUpperCase(), marginX + 4, curY + 6.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `NIS: ${student.nis}   |   NISN: ${student.nisn || '-'}   |   Jenis Kelamin: ${
      student.gender === 'L' ? 'Laki-laki' : 'Perempuan'
    }`,
    marginX + 4,
    curY + 12.5
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(29, 78, 216);
  doc.text(`${studentRow.attendanceRate}% Hadir`, pageW - marginX - 4, curY + 10, { align: 'right' });

  curY += 22;

  // Summary KPI Table for Student
  autoTable(doc, {
    startY: curY,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    head: [['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa', 'Total Tercatat', 'Hari Aktif Kelas', 'Persentase']],
    body: [
      [
        `${studentRow.hadir}`,
        `${studentRow.terlambat}`,
        `${studentRow.izin}`,
        `${studentRow.sakit}`,
        `${studentRow.alpa}`,
        `${studentRow.totalRecorded}`,
        mode === 'today' ? '1' : `${studentRow.effectiveDays}`,
        `${studentRow.attendanceRate}%`,
      ],
    ],
    headStyles: {
      fillColor: [30, 58, 138],
      textColor: 255,
      fontSize: 8,
      fontStyle: 'bold',
      halign: 'center',
    },
    bodyStyles: {
      fontSize: 9,
      fontStyle: 'bold',
      halign: 'center',
      textColor: [15, 23, 42],
    },
  });

  curY = getLastTableY(doc, curY + 16) + 5;

  // Optional Monthly breakdown if in Antar Bulanan mode
  if (mode === 'compare' && selectedMonths.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text('Rincian Per Bulan yang Dipilih (Acuan Rekap Harian)', marginX, curY);
    curY += 2.5;

    const monthRows = selectedMonths.map((m) => {
      const s = m.studentTotalsMap.get(student.id);
      return [
        m.monthLabel,
        `${s?.hadir || 0}`,
        `${s?.terlambat || 0}`,
        `${s?.izin || 0}`,
        `${s?.sakit || 0}`,
        `${s?.alpa || 0}`,
        `${s?.totalRecorded || 0}`,
        `${s?.attendanceRate || 0}%`,
      ];
    });

    autoTable(doc, {
      startY: curY,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      head: [['Bulan', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Alpa', 'Total', '%']],
      body: monthRows,
      foot: [
        [
          'TOTAL ANTAR BULAN',
          `${studentRow.hadir}`,
          `${studentRow.terlambat}`,
          `${studentRow.izin}`,
          `${studentRow.sakit}`,
          `${studentRow.alpa}`,
          `${studentRow.totalRecorded}`,
          `${studentRow.attendanceRate}%`,
        ],
      ],
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center' },
      footStyles: { fillColor: [239, 246, 255], textColor: [30, 58, 138], fontStyle: 'bold', halign: 'center' },
      columnStyles: {
        0: { halign: 'left' },
        1: { halign: 'center' },
        2: { halign: 'center' },
        3: { halign: 'center' },
        4: { halign: 'center' },
        5: { halign: 'center' },
        6: { halign: 'center' },
        7: { halign: 'center' },
      },
    });

    curY = getLastTableY(doc, curY + 20) + 6;
  }

  // Daily Detail Log Table (always anchored to daily attendance)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text('Rincian Presensi Harian (Acuan Utama)', marginX, curY);
  curY += 2.5;

  const datesToList =
    mode === 'today'
      ? [selectedDate]
      : activeDates.length > 0
      ? activeDates
      : [];

  const dailyBody =
    datesToList.length === 0
      ? [['-', 'Belum ada catatan presensi harian pada periode ini', '-', '-', '-', '-', '-', '-']]
      : datesToList.map((d, idx) => {
          const entry = dailyIndex.byStudent.get(student.id)?.get(d);
          const rec = entry?.primaryRecord;
          const sessionLabels = entry
            ? Array.from(new Set(entry.sessionRecords.map((r) => r.sessionName).filter(Boolean))).join(', ') || '-'
            : '-';
          return [
            `${idx + 1}`,
            formatIndoDateShort(d),
            getIndoDayName(d),
            entry ? entry.status : 'Belum Ada',
            rec?.timeIn || '-',
            rec?.method || '-',
            sessionLabels,
            rec?.notes || '-',
          ];
        });

  autoTable(doc, {
    startY: curY,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    head: [['No', 'Tanggal', 'Hari', 'Status', 'Jam Masuk', 'Metode', 'Sesi', 'Keterangan']],
    body: dailyBody,
    styles: { fontSize: 7.8, cellPadding: 1.8, textColor: [30, 41, 59] },
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { cellWidth: 23 },
      2: { cellWidth: 16 },
      3: { halign: 'center', cellWidth: 20, fontStyle: 'bold' },
      4: { halign: 'center', cellWidth: 18 },
      5: { cellWidth: 22 },
      6: { cellWidth: 24 },
      7: { cellWidth: 'auto' },
    },
  });

  drawSignatureFooter(doc, meta, getLastTableY(doc, curY + 25));
}

function renderClassSummarySectionIntoDoc(
  doc: jsPDF,
  params: {
    meta: PdfSchoolMeta;
    mode: HomeroomReportMode;
    selectedDate: string;
    totals: PeriodTotalsSummary;
    studentRows: StudentPeriodTotals[];
    dailyIndex: DailyAttendanceIndex;
    dailyBreakdown: DailyBreakdownRow[];
    selectedMonths?: MonthBreakdownSummary[];
  }
): void {
  const { meta, mode, selectedDate, totals, studentRows, dailyIndex, dailyBreakdown, selectedMonths = [] } = params;
  const marginX = 14;

  let curY = drawReportHeader(
    doc,
    meta,
    `REKAPITULASI PRESENSI KELAS ${String(meta.classInfo?.name || '').toUpperCase()}`
  );

  // Class Summary Box
  autoTable(doc, {
    startY: curY,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    head: [['Jumlah Siswa', 'Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa', 'Hari Aktif', 'Rata-rata Hadir']],
    body: [
      [
        `${studentRows.length}`,
        `${totals.hadir}`,
        `${totals.terlambat}`,
        `${totals.izin}`,
        `${totals.sakit}`,
        `${totals.alpa}`,
        mode === 'today' ? '1' : `${totals.activeDaysCount}`,
        `${totals.attendanceRate}%`,
      ],
    ],
    headStyles: { fillColor: [30, 58, 138], textColor: 255, fontSize: 8, halign: 'center' },
    bodyStyles: { fontSize: 9, fontStyle: 'bold', halign: 'center', textColor: [15, 23, 42] },
  });

  curY = getLastTableY(doc, curY + 16) + 5;

  if (mode === 'today') {
    // Daily Student Table
    const rows = studentRows.map((row, idx) => {
      const entry = dailyIndex.byDate.get(selectedDate)?.get(row.student.id);
      const rec = entry?.primaryRecord;
      const sessionsText = entry
        ? Array.from(new Set(entry.sessionRecords.map((r) => r.sessionName).filter(Boolean))).join(', ') || '-'
        : '-';
      return [
        `${idx + 1}`,
        row.student.nis,
        row.student.name,
        row.student.gender,
        entry ? entry.status : 'Belum Ada',
        rec?.timeIn || '-',
        sessionsText,
        rec?.method || '-',
        rec?.notes || '-',
      ];
    });

    autoTable(doc, {
      startY: curY,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      head: [['No', 'NIS', 'Nama Siswa', 'L/P', 'Status', 'Jam Masuk', 'Sesi', 'Metode', 'Keterangan']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold' },
      columnStyles: {
        0: { halign: 'center', cellWidth: 9 },
        1: { cellWidth: 22 },
        2: { cellWidth: 44 },
        3: { halign: 'center', cellWidth: 10 },
        4: { halign: 'center', cellWidth: 20, fontStyle: 'bold' },
        5: { halign: 'center', cellWidth: 18 },
        6: { cellWidth: 22 },
        7: { cellWidth: 20 },
        8: { cellWidth: 'auto' },
      },
    });
  } else {
    // Multi-day Student Matrix Table (Weekly / Monthly / Multi-Month)
    const rows = studentRows.map((row, idx) => [
      `${idx + 1}`,
      row.student.nis,
      row.student.name,
      row.student.gender,
      `${row.hadir}`,
      `${row.terlambat}`,
      `${row.izin}`,
      `${row.sakit}`,
      `${row.alpa}`,
      `${row.totalRecorded}`,
      `${row.attendanceRate}%`,
    ]);

    autoTable(doc, {
      startY: curY,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      head: [['No', 'NIS', 'Nama Siswa', 'L/P', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Alpa', 'Total', '% Hadir']],
      body: rows,
      foot: [
        [
          '',
          '',
          'TOTAL KESELURUHAN KELAS',
          '',
          `${totals.hadir}`,
          `${totals.terlambat}`,
          `${totals.izin}`,
          `${totals.sakit}`,
          `${totals.alpa}`,
          `${totals.totalRecorded}`,
          `${totals.attendanceRate}%`,
        ],
      ],
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold', halign: 'center' },
      footStyles: { fillColor: [239, 246, 255], textColor: [30, 58, 138], fontStyle: 'bold', halign: 'center' },
      columnStyles: {
        0: { halign: 'center', cellWidth: 9 },
        1: { cellWidth: 23 },
        2: { halign: 'left', cellWidth: 50 },
        3: { halign: 'center', cellWidth: 10 },
        4: { halign: 'center' },
        5: { halign: 'center' },
        6: { halign: 'center' },
        7: { halign: 'center' },
        8: { halign: 'center' },
        9: { halign: 'center' },
        10: { halign: 'center', fontStyle: 'bold' },
      },
    });

    curY = getLastTableY(doc, curY + 25) + 6;

    // If Compare mode, show Monthly Totals comparison proving sum === daily totals
    if (mode === 'compare' && selectedMonths.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text('Rekap Per Bulan yang Dipilih (Total dari Rekap Harian)', marginX, curY);
      curY += 2.5;

      autoTable(doc, {
        startY: curY,
        margin: { left: marginX, right: marginX },
        theme: 'grid',
        head: [['Bulan', 'Hari Aktif', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Alpa', 'Total', '% Hadir']],
        body: selectedMonths.map((m) => [
          m.monthLabel,
          `${m.totals.activeDaysCount}`,
          `${m.totals.hadir}`,
          `${m.totals.terlambat}`,
          `${m.totals.izin}`,
          `${m.totals.sakit}`,
          `${m.totals.alpa}`,
          `${m.totals.totalRecorded}`,
          `${m.totals.attendanceRate}%`,
        ]),
        styles: { fontSize: 8, cellPadding: 1.8 },
        headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center' },
        columnStyles: {
          0: { halign: 'left' },
          1: { halign: 'center' },
          2: { halign: 'center' },
          3: { halign: 'center' },
          4: { halign: 'center' },
          5: { halign: 'center' },
          6: { halign: 'center' },
          7: { halign: 'center' },
          8: { halign: 'center' },
        },
      });
      curY = getLastTableY(doc, curY + 20) + 6;
    }

    // Daily Breakdown proving exact daily sum
    if (dailyBreakdown.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text('Rincian Harian (Dasar Penjumlahan Periode)', marginX, curY);
      curY += 2.5;

      autoTable(doc, {
        startY: curY,
        margin: { left: marginX, right: marginX },
        theme: 'grid',
        head: [['No', 'Tanggal', 'Hari', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Alpa', 'Belum Ada', 'Tercatat']],
        body: dailyBreakdown.map((d, idx) => [
          `${idx + 1}`,
          formatIndoDateShort(d.date),
          d.dayName,
          `${d.hadir}`,
          `${d.terlambat}`,
          `${d.izin}`,
          `${d.sakit}`,
          `${d.alpa}`,
          `${d.belumAda}`,
          `${d.totalRecorded}`,
        ]),
        styles: { fontSize: 7.5, cellPadding: 1.5, halign: 'center' },
        headStyles: { fillColor: [71, 85, 105], textColor: 255 },
        columnStyles: {
          1: { halign: 'left' },
          2: { halign: 'left' },
        },
      });
    }
  }

  drawSignatureFooter(doc, meta, getLastTableY(doc, curY + 25));
}

export function exportSingleStudentPdf(params: {
  studentRow: StudentPeriodTotals;
  meta: PdfSchoolMeta;
  mode: HomeroomReportMode;
  selectedDate: string;
  activeDates: string[];
  dailyIndex: DailyAttendanceIndex;
  selectedMonths?: MonthBreakdownSummary[];
}): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderStudentSectionIntoDoc(doc, params);

  const safeStudent = sanitizeFilePart(params.studentRow.student.name);
  const safeNis = sanitizeFilePart(params.studentRow.student.nis);
  const safeClass = sanitizeFilePart(params.meta.classInfo?.name || 'Kelas');
  doc.save(`Presensi_${safeNis}_${safeStudent}_${safeClass}_${params.meta.fileSlug}.pdf`);
}

export function exportClassRecapPdf(params: {
  meta: PdfSchoolMeta;
  mode: HomeroomReportMode;
  selectedDate: string;
  totals: PeriodTotalsSummary;
  studentRows: StudentPeriodTotals[];
  dailyIndex: DailyAttendanceIndex;
  dailyBreakdown: DailyBreakdownRow[];
  selectedMonths?: MonthBreakdownSummary[];
}): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderClassSummarySectionIntoDoc(doc, params);

  const safeClass = sanitizeFilePart(params.meta.classInfo?.name || 'Kelas');
  doc.save(`Rekap_Presensi_Kelas_${safeClass}_${params.meta.fileSlug}.pdf`);
}

export function exportBulkClassCombinedPdf(params: {
  meta: PdfSchoolMeta;
  mode: HomeroomReportMode;
  selectedDate: string;
  activeDates: string[];
  totals: PeriodTotalsSummary;
  studentRows: StudentPeriodTotals[];
  dailyIndex: DailyAttendanceIndex;
  dailyBreakdown: DailyBreakdownRow[];
  selectedMonths?: MonthBreakdownSummary[];
}): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderClassSummarySectionIntoDoc(doc, params);

  params.studentRows.forEach((studentRow) => {
    doc.addPage();
    renderStudentSectionIntoDoc(doc, {
      studentRow,
      meta: params.meta,
      mode: params.mode,
      selectedDate: params.selectedDate,
      activeDates: params.activeDates,
      dailyIndex: params.dailyIndex,
      selectedMonths: params.selectedMonths,
    });
  });

  const safeClass = sanitizeFilePart(params.meta.classInfo?.name || 'Kelas');
  doc.save(`Rekap_Lengkap_Satu_Kelas_${safeClass}_${params.meta.fileSlug}.pdf`);
}

export async function exportBulkClassZipPdf(params: {
  meta: PdfSchoolMeta;
  mode: HomeroomReportMode;
  selectedDate: string;
  activeDates: string[];
  totals: PeriodTotalsSummary;
  studentRows: StudentPeriodTotals[];
  dailyIndex: DailyAttendanceIndex;
  dailyBreakdown: DailyBreakdownRow[];
  selectedMonths?: MonthBreakdownSummary[];
  onProgress?: (current: number, total: number, label: string) => void;
}): Promise<void> {
  const zip = new JSZip();
  const safeClass = sanitizeFilePart(params.meta.classInfo?.name || 'Kelas');
  const root = zip.folder(`PDF_Presensi_${safeClass}_${params.meta.fileSlug}`);

  // 1. Put class summary PDF at root
  const classDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderClassSummarySectionIntoDoc(classDoc, params);
  root?.file(`00_Rekap_Kelas_${safeClass}_${params.meta.fileSlug}.pdf`, classDoc.output('arraybuffer'));

  // 2. Put each student's individual PDF in Per_Siswa folder
  const studentFolder = root?.folder('Per_Siswa');
  for (let i = 0; i < params.studentRows.length; i++) {
    const studentRow = params.studentRows[i];
    params.onProgress?.(i + 1, params.studentRows.length, studentRow.student.name);

    const sDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    renderStudentSectionIntoDoc(sDoc, {
      studentRow,
      meta: params.meta,
      mode: params.mode,
      selectedDate: params.selectedDate,
      activeDates: params.activeDates,
      dailyIndex: params.dailyIndex,
      selectedMonths: params.selectedMonths,
    });

    const idxPrefix = String(i + 1).padStart(2, '0');
    const safeStudent = sanitizeFilePart(studentRow.student.name);
    const safeNis = sanitizeFilePart(studentRow.student.nis);
    studentFolder?.file(`${idxPrefix}_${safeNis}_${safeStudent}.pdf`, sDoc.output('arraybuffer'));

    if (i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 4));
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PDF_Presensi_Massal_${safeClass}_${params.meta.fileSlug}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
