export type Role = 'superadmin' | 'admin' | 'kepala_sekolah' | 'wali_kelas' | 'bk' | 'kesiswaan' | 'guru';

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  email: string;
  classId?: string;
  nip?: string;
  teacherId?: string;
  subject?: string;
}

export type EducationLevel = 'SMK' | 'SMP/MTS' | 'SD/MI';

export interface LevelConfig {
  level: EducationLevel;
  unitName: string;
  principalName: string;
  principalNip: string;
  principalSignatureUrl?: string;
  signatureScale?: number;
  stampUrl?: string;
  hideStamp?: boolean;
  signaturePlaceDate?: string;
  logoUrl?: string;
  websiteUrl?: string;
  qrCodeUrl?: string;
  watermarkUrl?: string;
  schoolAddress?: string;
  schoolPhone?: string;
  vision: string;
  missions: string[];
  accentColor: string;
  headerColor: string;
  badgeText: string;
}

export interface Student {
  id: string;
  nis: string;
  nisn: string;
  name: string;
  gender: 'L' | 'P';
  classId: string;
  barcodeCard: string;
  parentPhone: string;
  photoFileId?: string;
  photoUrl?: string;
  level?: EducationLevel;
  birthPlace?: string;
  birthDate?: string;
  address?: string;
  bloodType?: string;
  isActive: boolean;
  hasFaceEnrolled?: boolean;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface Teacher {
  id: string;
  nip: string;
  name: string;
  email: string;
  phone: string;
  subject: string;
  isActive: boolean;
  hasFaceEnrolled?: boolean;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface SchoolClass {
  id: string;
  name: string;
  grade: string;
  academicYear: string;
  level?: EducationLevel;
  homeRoomTeacherId?: string;
  homeRoomTeacherName?: string;
  studentCount?: number;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export type SessionTargetType = 'student' | 'teacher';

export interface AttendanceSession {
  id: string;
  targetType: SessionTargetType;
  name: string;
  startTime: string; // HH:mm 24-jam WIB
  lateCutoffTime: string; // HH:mm 24-jam WIB
  endTime: string; // HH:mm 24-jam WIB
  sheetName: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  diubah_pada?: string;
  updatedBy?: string;
}

export type StudentAttendanceStatus = 'Hadir' | 'Terlambat' | 'Izin' | 'Sakit' | 'Alpa';
export type AttendanceMethod = 'FACE_SCAN' | 'MANUAL' | 'RFID_SCAN' | 'BARCODE_SCAN';

export interface StudentAttendance {
  id: string;
  sessionId?: string;
  sessionName?: string;
  studentId: string;
  studentName?: string;
  studentNis?: string;
  className?: string;
  classId?: string;
  date: string;
  timeIn: string;
  status: StudentAttendanceStatus;
  method: AttendanceMethod;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export type TeacherAttendanceStatus = 'Tepat Waktu' | 'Terlambat' | 'Izin' | 'Sakit' | 'Alpa';

export interface TeacherAttendance {
  id: string;
  sessionId?: string;
  sessionName?: string;
  teacherId: string;
  teacherName?: string;
  nip?: string;
  subject?: string;
  date: string;
  timeIn: string;
  timeOut?: string;
  status: TeacherAttendanceStatus;
  method: AttendanceMethod;
  latitude?: number;
  longitude?: number;
  distanceMeters?: number;
  accuracyMeters?: number;
  gpsStatus?: 'VALID' | 'TIDAK AKURAT' | 'DI LUAR AREA';
  notes?: string;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface ToiletPermit {
  id: string;
  studentId: string;
  studentName?: string;
  studentNis?: string;
  className?: string;
  date: string;
  timeOut: string;
  timeIn?: string;
  durationMinutes?: number;
  toiletType?: 'BAB' | 'BAK' | 'LAINNYA';
  reason?: string;
  durationLimitMinutes?: number;
  status: 'active' | 'returned';
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface FrequentToiletStudent {
  studentId: string;
  studentName: string;
  studentNis: string;
  className: string;
  totalCount: number;
  babCount: number;
  bakCount: number;
  otherCount?: number;
  exceededCount: number;
  lastDate?: string;
}

export interface SchoolLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface SchoolSettings {
  id?: string;
  schoolName: string;
  schoolLogo: string;
  academicYear: string;
  checkInTime: string;
  lateCutoffTime: string;
  checkOutTime: string;
  toiletMaxMinutes: number;
  toiletBabMinutes?: number;
  toiletBakMinutes?: number;
  warningThresholdAbsent: number;
  warningThresholdLate: number;
  warningThresholdToilet: number;
  parentNotificationEnabled: boolean;
  holidays: string[];
  foundationAddress?: string;
  foundationPhone?: string;
  foundationWebsite?: string;
  foundationWatermarkUrl?: string;
  foundationQrCodeUrl?: string;
  levelConfigsJson?: string;
  levels?: Record<EducationLevel, LevelConfig>;
  diubah_pada?: string;
}

export interface FaceTemplate {
  id: string;
  personId: string;
  personType: 'student' | 'teacher';
  descriptor: number[];
  photoFileId?: string;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  ipAddress?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface FollowUpNote {
  id: string;
  studentId: string;
  studentName?: string;
  studentNis?: string;
  date: string;
  category: 'Absensi' | 'Keterlambatan' | 'Toilet' | 'Perilaku' | 'Lainnya';
  notes: string;
  actionPlan: string;
  status: 'Open' | 'InProgress' | 'Resolved';
  counselorId: string;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface ProblemStudent {
  studentId: string;
  studentName: string;
  nis: string;
  className: string;
  parentPhone: string;
  alpaCount: number;
  lateCount: number;
  toiletExceededCount: number;
  totalToiletCount: number;
  warningLevel: 'KUNING' | 'MERAH';
  issues: string[];
}

export interface GuestBookEntry {
  id: string;
  date: string;
  time: string;
  name: string;
  address: string;
  phone: string;
  purpose?: string;
  signatureFileId?: string;
  signatureUrl?: string;
  createdAt: string;
  updatedAt: string;
  diubah_pada?: string;
  updatedBy: string;
}

export interface SystemCheckReport {
  success: boolean;
  serverTime?: string;
  missingConfig: string[];
  configuredKeys: string[];
  sheets: {
    ok: boolean;
    message: string;
    sheetCount?: number;
    latencyMs?: number;
  };
  drive: {
    ok: boolean;
    message: string;
    latencyMs?: number;
  };
  error?: string;
}
