/**
 * ============================================================================
 * GOOGLE APPS SCRIPT WEB APP BACKEND
 * Sistem Presensi Siswa & Guru - Yayasan Mambaul Ulum
 *
 * Arsitektur:
 * - Google Sheets sebagai satu-satunya database (tanpa Firebase / Service Account / GCP).
 * - Google Drive (DriveApp) untuk menyimpan foto siswa/wajah secara privat.
 * - Script Properties menyimpan: SPREADSHEET_ID, DRIVE_FOLDER_ID, SECRET_TOKEN.
 * - Setiap request doGet & doPost wajib membawa token yang valid.
 * - Setiap baris memiliki kolom A = 'id' unik, kolom 'status' (soft delete = 'dihapus'),
 *   dan kolom 'diubah_pada' (optimistic concurrency lock).
 * - Penulisan dibungkus LockService.getScriptLock() dan dicatat ke sheet 'Log'.
 * ============================================================================
 */

var TIMEZONE = 'Asia/Jakarta';
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
var PROP_DRIVE_FOLDER_ID = 'DRIVE_FOLDER_ID';
var PROP_SECRET_TOKEN = 'SECRET_TOKEN';
var PROP_DATA_VERSION = 'DATA_VERSION';
var CACHE_PRESENCE_KEY = 'PRESENSI_ACTIVE_USERS_V1';
var SCHEMA_BOOT_CACHE_PREFIX = 'SCHEMA_BOOT_V3_';
var DRIVE_BLOB_PREFIX = '__DRIVE_BLOB__:';
var CACHE_BLOB_PREFIX = 'PRESENSI_BLOB_V1_';
var CELL_DRIVE_SPILL_THRESHOLD = 4500;
var _EXEC_HEADER_CACHE = {};
var _EXEC_BLOB_CACHE = {};

var SHEET_SCHEMAS = {
  Settings: [
    'id', 'schoolName', 'schoolLogo', 'academicYear', 'checkInTime', 'lateCutoffTime',
    'checkOutTime', 'toiletMaxMinutes', 'toiletBabMinutes', 'toiletBakMinutes',
    'warningThresholdAbsent', 'warningThresholdLate',
    'warningThresholdToilet', 'parentNotificationEnabled', 'holidaysJson',
    'foundationAddress', 'foundationWebsite', 'foundationWatermarkUrl', 'foundationQrCodeUrl',
    'levelConfigsJson', 'status', 'diubah_pada', 'updatedBy'
  ],
  Users: [
    'id', 'username', 'passwordHash', 'name', 'role', 'email', 'classId', 'nip',
    'isActive', 'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Teachers: [
    'id', 'nip', 'name', 'email', 'phone', 'subject', 'isActive',
    'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Classes: [
    'id', 'name', 'grade', 'academicYear', 'level', 'homeRoomTeacherId', 'homeRoomTeacherName',
    'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Students: [
    'id', 'nis', 'nisn', 'name', 'gender', 'classId', 'barcodeCard', 'parentPhone',
    'photoFileId', 'photoUrl', 'level', 'birthPlace', 'birthDate', 'address', 'bloodType',
    'isActive', 'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  FaceTemplates: [
    'id', 'personId', 'personType', 'descriptorJson', 'photoFileId',
    'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Sessions: [
    'id', 'targetType', 'name', 'startTime', 'lateCutoffTime', 'endTime',
    'sheetName', 'sortOrder', 'isActive', 'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  StudentAttendance: [
    'id', 'studentId', 'nis', 'nama', 'classId', 'className', 'date', 'timeIn',
    'status', 'method', 'notes', 'clientScanId', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  TeacherAttendance: [
    'id', 'teacherId', 'nama', 'nip', 'subject', 'date', 'timeIn', 'timeOut',
    'status', 'method', 'latitude', 'longitude', 'distanceMeters', 'notes',
    'createdAt', 'diubah_pada', 'updatedBy'
  ],
  ToiletPermits: [
    'id', 'studentId', 'studentName', 'studentNis', 'className', 'date', 'timeOut',
    'timeIn', 'durationMinutes', 'toiletType', 'reason', 'durationLimitMinutes', 'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Locations: [
    'id', 'name', 'latitude', 'longitude', 'radiusMeters', 'isActive',
    'status', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  FollowUpNotes: [
    'id', 'studentId', 'studentName', 'studentNis', 'date', 'category', 'notes',
    'actionPlan', 'status', 'counselorId', 'createdAt', 'diubah_pada', 'updatedBy'
  ],
  Log: [
    'id', 'waktu', 'pengguna', 'aksi', 'entitas', 'id_entitas', 'detail',
    'status', 'diubah_pada'
  ]
};

var STUDENT_SESSION_ATT_HEADERS = [
  'id', 'sessionId', 'sessionName', 'studentId', 'nis', 'nama', 'classId', 'className', 'date', 'timeIn',
  'status', 'method', 'notes', 'clientScanId', 'createdAt', 'diubah_pada', 'updatedBy'
];

var TEACHER_SESSION_ATT_HEADERS = [
  'id', 'sessionId', 'sessionName', 'teacherId', 'nama', 'nip', 'subject', 'date', 'timeIn', 'timeOut',
  'status', 'method', 'latitude', 'longitude', 'distanceMeters', 'notes',
  'createdAt', 'diubah_pada', 'updatedBy'
];

var STUDENT_LEVEL_SHEETS = {
  'SD/MI': 'Siswa_SD_MI',
  'SMP/MTS': 'Siswa_SMP_MTS',
  'SMK': 'Siswa_SMK'
};

var STUDENT_LEVEL_SHEET_HEADERS = [
  'id', 'nis', 'nisn', 'name', 'gender', 'classId', 'className', 'level',
  'address', 'parentPhone', 'barcodeCard', 'birthPlace', 'birthDate',
  'isActive', 'status', 'createdAt', 'diubah_pada', 'updatedBy'
];

function normalizeEducationLevel_(rawLevel) {
  var up = String(rawLevel || '').toUpperCase().replace(/\s+/g, '');
  if (!up) return '';
  if (up === 'SD/MI' || up === 'SD' || up === 'MI' || up.indexOf('SD') === 0 || up.indexOf('MI') === 0) {
    return 'SD/MI';
  }
  if (up === 'SMP/MTS' || up === 'SMP' || up === 'MTS' || up.indexOf('SMP') === 0 || up.indexOf('MTS') === 0) {
    return 'SMP/MTS';
  }
  if (up === 'SMK' || up === 'SMA/MA' || up === 'SMA' || up === 'MA' || up.indexOf('SMK') === 0 || up.indexOf('SMA') === 0 || up.indexOf('MA') === 0) {
    return 'SMK';
  }
  return '';
}

function inferEducationLevel_(rawLevel, gradeStr, classNameStr) {
  var direct = normalizeEducationLevel_(rawLevel);
  if (direct) return direct;

  var gradeNum = Number(String(gradeStr || '').replace(/[^0-9]/g, ''));
  if (!isNaN(gradeNum) && gradeNum >= 1 && gradeNum <= 12) {
    if (gradeNum <= 6) return 'SD/MI';
    if (gradeNum <= 9) return 'SMP/MTS';
    return 'SMK';
  }

  var clsUp = String(classNameStr || '').toUpperCase().trim();
  if (clsUp) {
    if (/\b(SMK|SMA|MA)\b/.test(clsUp)) return 'SMK';
    if (/\b(SMP|MTS)\b/.test(clsUp)) return 'SMP/MTS';
    if (/\b(SD|MI)\b/.test(clsUp)) return 'SD/MI';
    if (/\b(XII|XI|X)\b/.test(clsUp) || /(?:^|[\s\-_/])(12|11|10)(?![0-9])/.test(clsUp)) return 'SMK';
    if (/\b(IX|VIII|VII)\b/.test(clsUp) || /(?:^|[\s\-_/])(9|8|7)(?![0-9])/.test(clsUp)) return 'SMP/MTS';
    if (/\b(VI|V|IV|III|II|I)\b/.test(clsUp) || /(?:^|[\s\-_/])(6|5|4|3|2|1)(?![0-9])/.test(clsUp)) return 'SD/MI';
  }
  return '';
}

function inferGradeNumber_(level, gradeStr, classNameStr) {
  var explicitNum = Number(String(gradeStr || '').replace(/[^0-9]/g, ''));
  if (!isNaN(explicitNum) && explicitNum >= 1 && explicitNum <= 12) {
    return String(explicitNum);
  }
  var clsUp = String(classNameStr || '').toUpperCase().trim();
  if (/\bXII\b/.test(clsUp) || /(?:^|[\s\-_/])12(?![0-9])/.test(clsUp)) return '12';
  if (/\bXI\b/.test(clsUp) || /(?:^|[\s\-_/])11(?![0-9])/.test(clsUp)) return '11';
  if (/\bX\b/.test(clsUp) || /(?:^|[\s\-_/])10(?![0-9])/.test(clsUp)) return '10';
  if (/\bIX\b/.test(clsUp) || /(?:^|[\s\-_/])9(?![0-9])/.test(clsUp)) return '9';
  if (/\bVIII\b/.test(clsUp) || /(?:^|[\s\-_/])8(?![0-9])/.test(clsUp)) return '8';
  if (/\bVII\b/.test(clsUp) || /(?:^|[\s\-_/])7(?![0-9])/.test(clsUp)) return '7';
  if (/\bVI\b/.test(clsUp) || /(?:^|[\s\-_/])6(?![0-9])/.test(clsUp)) return '6';
  if (/\bV\b/.test(clsUp) || /(?:^|[\s\-_/])5(?![0-9])/.test(clsUp)) return '5';
  if (/\bIV\b/.test(clsUp) || /(?:^|[\s\-_/])4(?![0-9])/.test(clsUp)) return '4';
  if (/\bIII\b/.test(clsUp) || /(?:^|[\s\-_/])3(?![0-9])/.test(clsUp)) return '3';
  if (/\bII\b/.test(clsUp) || /(?:^|[\s\-_/])2(?![0-9])/.test(clsUp)) return '2';
  if (/\bI\b/.test(clsUp) || /(?:^|[\s\-_/])1(?![0-9])/.test(clsUp)) return '1';
  if (level === 'SD/MI') return '1';
  if (level === 'SMP/MTS') return '7';
  return '10';
}

function resolveOrAutoCreateClassForStudent_(ss, rawClassId, rawClassName, rawLevel, rawGrade, actor) {
  var existingClasses = readActiveRows_(ss, 'Classes');
  var clsIdStr = String(rawClassId || '').trim();
  var clsNameStr = String(rawClassName || '').trim();
  var reqLevel = normalizeEducationLevel_(rawLevel);
  var nameLevelHint = inferEducationLevel_('', rawGrade, clsNameStr);

  if (clsNameStr) {
    var lookupKey = clsNameStr.toLowerCase().replace(/\s+/g, ' ');
    var targetLevel = reqLevel || nameLevelHint || 'SMK';

    // 1. Exact match by name + matching level
    for (var i = 0; i < existingClasses.length; i++) {
      var ex = existingClasses[i];
      var exKey = String(ex.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      var exLevel = inferEducationLevel_(ex.level, ex.grade, ex.name) || 'SMK';
      if (exKey === lookupKey && exLevel === targetLevel) {
        return { classObj: ex, autoCreated: false };
      }
    }

    // 2. Match by name regardless of level (avoid duplicate class names when level wasn't distinct)
    for (var j = 0; j < existingClasses.length; j++) {
      var exAny = existingClasses[j];
      var exAnyKey = String(exAny.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (exAnyKey === lookupKey) {
        return { classObj: exAny, autoCreated: false };
      }
    }

    // 3. Auto-create new class in Classes sheet
    var classesSheet = ss.getSheetByName('Classes');
    if (classesSheet) {
      var parts = nowWibParts_();
      var stRowsYear = readActiveRows_(ss, 'Settings');
      var activeYear = (stRowsYear.length > 0 && stRowsYear[0].academicYear) ? String(stRowsYear[0].academicYear) : '2026/2027';
      var newClsLevel = nameLevelHint || reqLevel || 'SMK';
      if (reqLevel && !nameLevelHint) newClsLevel = reqLevel;
      var newClsGrade = inferGradeNumber_(newClsLevel, rawGrade, clsNameStr);
      var newClsObj = {
        id: generateId_('cls'),
        name: clsNameStr,
        grade: newClsGrade,
        academicYear: activeYear,
        level: newClsLevel,
        homeRoomTeacherId: '',
        homeRoomTeacherName: '',
        status: 'aktif',
        createdAt: parts.iso,
        diubah_pada: parts.iso,
        updatedBy: actor || 'admin'
      };
      appendObjectRow_(classesSheet, 'Classes', newClsObj);
      writeAuditLog_(ss, actor || 'admin', 'CREATE', 'Classes', newClsObj.id, 'Tambah kelas otomatis "' + newClsObj.name + '" (' + newClsLevel + ') dari Data Siswa');
      return { classObj: newClsObj, autoCreated: true };
    }
  }

  if (clsIdStr) {
    for (var k = 0; k < existingClasses.length; k++) {
      if (String(existingClasses[k].id) === clsIdStr) {
        return { classObj: existingClasses[k], autoCreated: false };
      }
    }
  }

  return { classObj: null, autoCreated: false };
}

function ensureStudentLevelSheetsExist_(ss) {
  // Seamless migration: rename legacy Siswa_SMA_MA tab to Siswa_SMK if needed
  var legacySmaSheet = ss.getSheetByName('Siswa_SMA_MA');
  if (legacySmaSheet && !ss.getSheetByName('Siswa_SMK')) {
    legacySmaSheet.setName('Siswa_SMK');
  }
  var levels = Object.keys(STUDENT_LEVEL_SHEETS);
  var anyNewlyCreated = false;
  for (var i = 0; i < levels.length; i++) {
    var sheetName = STUDENT_LEVEL_SHEETS[levels[i]];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(STUDENT_LEVEL_SHEET_HEADERS);
      sheet.getRange(1, 1, 1, STUDENT_LEVEL_SHEET_HEADERS.length).setFontWeight('bold');
      applyTextFormatForNewSheet_(sheet, STUDENT_LEVEL_SHEET_HEADERS);
      anyNewlyCreated = true;
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(STUDENT_LEVEL_SHEET_HEADERS);
      sheet.getRange(1, 1, 1, STUDENT_LEVEL_SHEET_HEADERS.length).setFontWeight('bold');
      applyTextFormatForNewSheet_(sheet, STUDENT_LEVEL_SHEET_HEADERS);
      anyNewlyCreated = true;
    }
  }
  return anyNewlyCreated;
}

function buildStudentLevelRow_(st, classById) {
  var cls = classById[String(st.classId)] || null;
  var lvl = inferEducationLevel_(
    st.level,
    cls ? cls.grade : '',
    cls ? cls.name : ''
  );
  if (!lvl && cls) {
    lvl = inferEducationLevel_(cls.level, cls.grade, cls.name);
  }
  if (!lvl) lvl = 'SMK';

  return {
    level: lvl,
    row: [
      String(st.id || ''),
      String(st.nis || ''),
      String(st.nisn || ''),
      String(st.name || ''),
      String(st.gender || 'L'),
      String(st.classId || ''),
      cls ? String(cls.name || '') : '',
      lvl,
      String(st.address || ''),
      String(st.parentPhone || ''),
      String(st.barcodeCard || ''),
      String(st.birthPlace || ''),
      String(st.birthDate || ''),
      st.isActive === false ? false : true,
      String(st.status || 'aktif'),
      String(st.createdAt || ''),
      String(st.diubah_pada || ''),
      String(st.updatedBy || '')
    ]
  };
}

function syncSingleStudentInLevelSheets_(ss, studentOrId, isRemoved) {
  ensureStudentLevelSheetsExist_(ss);

  var targetId = typeof studentOrId === 'object' && studentOrId !== null
    ? String(studentOrId.id || '')
    : String(studentOrId || '');
  if (!targetId) return;

  var studentObj = null;
  if (!isRemoved) {
    if (typeof studentOrId === 'object' && studentOrId !== null && studentOrId.name) {
      studentObj = studentOrId;
    } else {
      var stdSheet = ss.getSheetByName('Students');
      if (stdSheet) {
        var rIdx = findRowById_(stdSheet, targetId);
        if (rIdx > 0) {
          var hdrs = getHeaders_(stdSheet, 'Students');
          var vals = stdSheet.getRange(rIdx, 1, 1, hdrs.length).getValues()[0];
          var obj = {};
          for (var c = 0; c < hdrs.length; c++) {
            if (hdrs[c]) obj[hdrs[c]] = normalizeSheetCellValue_(hdrs[c], vals[c]);
          }
          if (String(obj.status || '').toLowerCase() !== 'dihapus') {
            studentObj = obj;
          }
        }
      }
    }
  }

  var isActiveStudent = studentObj &&
    !(studentObj.isActive === false || String(studentObj.isActive).toLowerCase() === 'false');

  var targetLevel = '';
  var builtRow = null;
  if (isActiveStudent) {
    var classById = {};
    if (studentObj.classId) {
      var classes = readActiveRows_(ss, 'Classes');
      for (var c = 0; c < classes.length; c++) {
        classById[String(classes[c].id)] = classes[c];
      }
    }
    var built = buildStudentLevelRow_(studentObj, classById);
    targetLevel = built.level;
    builtRow = built.row;
  }

  var levels = Object.keys(STUDENT_LEVEL_SHEETS);
  for (var k = 0; k < levels.length; k++) {
    var levelKey = levels[k];
    var sheetName = STUDENT_LEVEL_SHEETS[levelKey];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    var existingRowIdx = findRowById_(sheet, targetId);
    if (isActiveStudent && levelKey === targetLevel) {
      if (existingRowIdx > 0) {
        sheet.getRange(existingRowIdx, 1, 1, builtRow.length).setValues([builtRow]);
      } else {
        sheet.appendRow(builtRow);
      }
    } else if (existingRowIdx > 0) {
      sheet.deleteRow(existingRowIdx);
    }
  }
}

function syncStudentLevelSheets_(ss) {
  ensureStudentLevelSheetsExist_(ss);

  var classes = readActiveRows_(ss, 'Classes');
  var classById = {};
  for (var c = 0; c < classes.length; c++) {
    classById[String(classes[c].id)] = classes[c];
  }

  var students = readActiveRows_(ss, 'Students');
  var grouped = {
    'SD/MI': [],
    'SMP/MTS': [],
    'SMK': []
  };

  for (var i = 0; i < students.length; i++) {
    var st = students[i];
    if (st.isActive === false || String(st.isActive).toLowerCase() === 'false') continue;
    var built = buildStudentLevelRow_(st, classById);
    grouped[built.level].push(built.row);
  }

  var levels = Object.keys(STUDENT_LEVEL_SHEETS);
  for (var k = 0; k < levels.length; k++) {
    var levelKey = levels[k];
    var sheetName = STUDENT_LEVEL_SHEETS[levelKey];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    var rowsForLevel = grouped[levelKey] || [];
    var existingLastRow = sheet.getLastRow();
    if (existingLastRow > 1) {
      sheet.getRange(2, 1, existingLastRow - 1, STUDENT_LEVEL_SHEET_HEADERS.length).clearContent();
    }
    sheet.getRange(1, 1, 1, STUDENT_LEVEL_SHEET_HEADERS.length).setValues([STUDENT_LEVEL_SHEET_HEADERS]).setFontWeight('bold');
    if (rowsForLevel.length > 0) {
      applyTextFormatForNewSheet_(sheet, STUDENT_LEVEL_SHEET_HEADERS, rowsForLevel.length);
      sheet.getRange(2, 1, rowsForLevel.length, STUDENT_LEVEL_SHEET_HEADERS.length).setValues(rowsForLevel);
    }
  }
}

// ============================================================================
// HTTP ENTRY POINTS: doGet & doPost
// ============================================================================

function doGet(e) {
  _EXEC_HEADER_CACHE = {};
  _EXEC_BLOB_CACHE = {};
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var tokenCheck = verifyRequestToken_(params.token);
    if (!tokenCheck.ok) {
      return jsonOutput_({ success: false, error: tokenCheck.error, unauthorized: true });
    }

    var action = String(params.action || 'sync');

    if (action === 'checkSystem') {
      return jsonOutput_(handleCheckSystem_());
    }

    var ssRes = getSpreadsheet_();
    if (!ssRes.ok) {
      return jsonOutput_({ success: false, error: ssRes.error });
    }
    var ss = ssRes.ss;
    ensureAllSheets_(ss, false);

    if (action === 'getPhoto') {
      return jsonOutput_(handleGetPhoto_(params.fileId));
    }

    if (action === 'sync') {
      updatePresenceFromParams_(params);
      return jsonOutput_(handleSync_(ss, params));
    }

    if (action === 'teacherHistory') {
      return jsonOutput_(handleGetTeacherHistory_(ss, params));
    }

    if (action === 'teacherRecap') {
      return jsonOutput_(handleGetTeacherRecap_(ss, params));
    }

    if (action === 'studentRecap') {
      return jsonOutput_(handleGetStudentRecap_(ss, params));
    }

    if (action === 'counselingRadar') {
      return jsonOutput_(handleGetCounselingRadar_(ss));
    }

    if (action === 'auditLog') {
      return jsonOutput_(handleGetLogs_(ss, Number(params.limit || 100)));
    }

    return jsonOutput_({ success: false, error: 'Aksi GET tidak dikenal: ' + action });
  } catch (err) {
    return jsonOutput_({ success: false, error: 'Server error (doGet): ' + (err && err.message ? err.message : String(err)) });
  }
}

function isPlainObject_(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function doPost(e) {
  _EXEC_HEADER_CACHE = {};
  _EXEC_BLOB_CACHE = {};
  var lock = null;
  var acquired = false;
  try {
    var rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      return jsonOutput_({ success: false, error: 'Body JSON tidak valid (gunakan Content-Type: text/plain).' });
    }

    if (!isPlainObject_(payload)) {
      return jsonOutput_({ success: false, error: 'Payload JSON harus berupa objek.' });
    }

    var tokenCheck = verifyRequestToken_(payload.token);
    if (!tokenCheck.ok) {
      return jsonOutput_({ success: false, error: tokenCheck.error, unauthorized: true });
    }

    var action = String(payload.action || '').trim();
    if (!action) {
      return jsonOutput_({ success: false, error: 'Parameter action wajib diisi.' });
    }

    // Read-only POST actions (no write lock required — fast & non-blocking)
    if (action === 'checkSystem') {
      return jsonOutput_(handleCheckSystem_());
    }

    if (action === 'heartbeat') {
      try { updatePresence_(payload); } catch (presErr) {}
      return jsonOutput_({ success: true, activeUsers: getActiveUsers_(), serverVersion: getDataVersion_() });
    }

    if (action === 'login' || action === 'me') {
      var ssReadRes = getSpreadsheet_();
      if (!ssReadRes.ok) {
        return jsonOutput_({ success: false, error: ssReadRes.error });
      }
      var ssRead = ssReadRes.ss;
      ensureAllSheets_(ssRead, false);
      var authResult = action === 'login'
        ? handleLogin_(ssRead, payload)
        : handleGetUserById_(ssRead, payload.userId);
      return jsonOutput_(authResult);
    }

    lock = LockService.getScriptLock();
    acquired = lock.tryLock(15000);
    if (!acquired) {
      return jsonOutput_({
        success: false,
        retryable: true,
        error: 'Server sedang sibuk memproses antrean simpan lain. Mencoba ulang...'
      });
    }

    var actor = String(payload.actor || payload.updatedBy || 'system');
    if (action === 'setupDatabase') {
      var provRes = provisionDatabaseResources_(payload, actor);
      if (provRes && provRes.success) {
        try { SpreadsheetApp.flush(); } catch (flushErr0) {}
        try { provRes.serverVersion = bumpDataVersion_(); } catch (verErr0) { provRes.serverVersion = getDataVersion_(); }
        provRes.serverTime = new Date().toISOString();
      }
      return jsonOutput_(provRes);
    }

    var ssRes = getSpreadsheet_();
    if (!ssRes.ok) {
      return jsonOutput_({ success: false, error: ssRes.error });
    }
    var ss = ssRes.ss;
    ensureAllSheets_(ss, false);

    var safeData = isPlainObject_(payload.data) ? payload.data : {};
    var result;

    switch (action) {
      case 'updateSettings':
        result = handleUpdateSettings_(ss, safeData, actor);
        break;
      case 'batchStudentAttendance':
        result = handleBatchStudentAttendance_(ss, Array.isArray(payload.scans) ? payload.scans : [], actor);
        break;
      case 'manualStudentAttendance':
        result = handleManualStudentAttendance_(ss, payload, actor);
        break;
      case 'teacherAttendance':
        result = handleTeacherAttendance_(ss, payload, actor);
        break;
      case 'toiletStart':
        result = handleToiletStart_(ss, payload, actor);
        break;
      case 'toiletReturn':
        result = handleToiletReturn_(ss, payload, actor);
        break;
      case 'saveFaceTemplate':
        result = handleSaveFaceTemplate_(ss, payload, actor);
        break;
      case 'uploadPhoto':
        result = handleUploadPhoto_(ss, payload, actor);
        break;
      case 'deletePhoto':
        result = handleDeletePhoto_(ss, payload, actor);
        break;
      case 'createRecord':
        result = handleCreateGeneric_(ss, String(payload.entity || ''), safeData, actor);
        break;
      case 'updateRecord':
        result = handleUpdateGeneric_(ss, String(payload.entity || ''), payload.id, safeData, payload.expectedUpdatedAt, actor);
        break;
      case 'softDeleteRecord':
        result = handleSoftDeleteGeneric_(ss, String(payload.entity || ''), payload.id, payload.expectedUpdatedAt, actor);
        break;
      case 'resetUserPassword':
        result = handleResetPassword_(ss, payload.id, payload.newPassword, payload.expectedUpdatedAt, actor);
        break;
      case 'bulkImportStudents':
        result = handleBulkImportStudents_(
          ss,
          Array.isArray(payload.rows) ? payload.rows : [],
          payload.classId,
          payload.defaultLevel,
          actor,
          Boolean(payload.forceDefaultLevel)
        );
        break;
      case 'promoteClass':
        result = handlePromoteClass_(ss, payload, actor);
        break;
      default:
        result = { success: false, error: 'Aksi POST tidak dikenal: ' + action };
    }

    if (result && result.success && result.mutated !== false) {
      try { SpreadsheetApp.flush(); } catch (flushErr) {}
      try {
        result.serverVersion = bumpDataVersion_();
      } catch (verErr) {
        result.serverVersion = getDataVersion_();
      }
      result.serverTime = new Date().toISOString();
    }

    return jsonOutput_(result || { success: false, error: 'Hasil eksekusi server kosong.' });
  } catch (err) {
    return jsonOutput_({
      success: false,
      error: 'Server error (doPost): ' + (err && err.message ? err.message : String(err))
    });
  } finally {
    if (acquired && lock) {
      try {
        lock.releaseLock();
      } catch (releaseErr) {}
    }
  }
}

// ============================================================================
// SECURITY & CONFIGURATION HELPERS
// ============================================================================

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getScriptProps_() {
  return PropertiesService.getScriptProperties();
}

function verifyRequestToken_(providedToken) {
  var secret = getScriptProps_().getProperty(PROP_SECRET_TOKEN);
  if (!secret || String(secret).trim() === '') {
    return {
      ok: false,
      error: 'SECRET_TOKEN belum diatur pada Script Properties Apps Script.'
    };
  }
  if (!providedToken || String(providedToken).trim() !== String(secret).trim()) {
    return {
      ok: false,
      error: 'Unauthorized: Token tidak valid.'
    };
  }
  return { ok: true };
}

function getSpreadsheet_() {
  var ssId = getScriptProps_().getProperty(PROP_SPREADSHEET_ID);
  if (!ssId || String(ssId).trim() === '') {
    return { ok: false, error: 'SPREADSHEET_ID belum diatur di Script Properties.' };
  }
  try {
    var ss = SpreadsheetApp.openById(String(ssId).trim());
    return { ok: true, ss: ss };
  } catch (e) {
    return { ok: false, error: 'Gagal membuka Google Spreadsheet: ' + e.message };
  }
}

function getDriveFolder_() {
  var folderId = getScriptProps_().getProperty(PROP_DRIVE_FOLDER_ID);
  if (!folderId || String(folderId).trim() === '') {
    return { ok: false, error: 'DRIVE_FOLDER_ID belum diatur di Script Properties.' };
  }
  try {
    var folder = DriveApp.getFolderById(String(folderId).trim());
    if (folder.isTrashed()) {
      return { ok: false, error: 'Folder Google Drive sudah dihapus ke sampah.' };
    }
    return { ok: true, folder: folder };
  } catch (e) {
    return { ok: false, error: 'Gagal membuka Folder Google Drive: ' + e.message };
  }
}

function sanitizeDriveName_(rawName) {
  return String(rawName || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getOrCreateSubfolder_(parentFolder, folderName) {
  var it = parentFolder.getFoldersByName(folderName);
  while (it.hasNext()) {
    var existing = it.next();
    if (!existing.isTrashed()) {
      return existing;
    }
  }
  return parentFolder.createFolder(folderName);
}

function ensureDriveFolders_(allowCreateRoot, customFolderName) {
  var props = getScriptProps_();
  var folderId = String(props.getProperty(PROP_DRIVE_FOLDER_ID) || '').trim();
  var rootFolder = null;
  var createdRoot = false;

  if (folderId) {
    try {
      var candidate = DriveApp.getFolderById(folderId);
      if (!candidate.isTrashed()) {
        rootFolder = candidate;
      }
    } catch (e) {
      rootFolder = null;
    }
  }

  if (!rootFolder) {
    if (!allowCreateRoot) {
      return { ok: false, error: 'DRIVE_FOLDER_ID belum diatur di Script Properties.' };
    }
    var rootTitle = sanitizeDriveName_(customFolderName || 'Database Presensi - Yayasan Mambaul Ulum') || 'Database Presensi - Yayasan Mambaul Ulum';
    rootFolder = DriveApp.createFolder(rootTitle);
    props.setProperty(PROP_DRIVE_FOLDER_ID, rootFolder.getId());
    createdRoot = true;
  }

  var studentFaceFolder = getOrCreateSubfolder_(rootFolder, '01_Database_Wajah_Siswa');
  var teacherFaceFolder = getOrCreateSubfolder_(rootFolder, '02_Database_Wajah_Guru');
  var cardPhotoFolder = getOrCreateSubfolder_(rootFolder, '03_Foto_Kartu_Siswa');
  var cardAssetsFolder = getOrCreateSubfolder_(rootFolder, '04_Logo_TTD_dan_Aset_Kartu');
  var blobDataFolder = getOrCreateSubfolder_(rootFolder, '05_Data_Sistem_Teks');

  return {
    ok: true,
    createdRoot: createdRoot,
    rootFolder: rootFolder,
    studentFaceFolder: studentFaceFolder,
    teacherFaceFolder: teacherFaceFolder,
    cardPhotoFolder: cardPhotoFolder,
    cardAssetsFolder: cardAssetsFolder,
    blobDataFolder: blobDataFolder
  };
}

function provisionDatabaseResources_(payload, actor) {
  var opts = payload || {};
  var driveRes = ensureDriveFolders_(true, opts.folderName);
  if (!driveRes.ok) {
    return { success: false, mutated: false, error: driveRes.error };
  }

  var props = getScriptProps_();
  var ssId = String(props.getProperty(PROP_SPREADSHEET_ID) || '').trim();
  var ss = null;
  var createdSpreadsheet = false;

  if (ssId) {
    try {
      ss = SpreadsheetApp.openById(ssId);
    } catch (e) {
      ss = null;
    }
  }

  if (!ss) {
    var ssTitle = String(opts.spreadsheetName || 'Database Presensi - Yayasan Mambaul Ulum').trim();
    ss = SpreadsheetApp.create(ssTitle);
    props.setProperty(PROP_SPREADSHEET_ID, ss.getId());
    createdSpreadsheet = true;

    try {
      var ssFile = DriveApp.getFileById(ss.getId());
      ssFile.moveTo(driveRes.rootFolder);
    } catch (moveErr) {}
  }

  ensureAllSheets_(ss, true);
  writeAuditLog_(
    ss,
    actor || 'admin',
    'AUTO_PROVISION',
    'System',
    ss.getId(),
    'Siapkan database otomatis (Sheet baru: ' + createdSpreadsheet + ', Folder Drive baru: ' + driveRes.createdRoot + ')'
  );

  return {
    success: true,
    mutated: true,
    createdSpreadsheet: createdSpreadsheet,
    createdDriveFolder: driveRes.createdRoot,
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    folderName: driveRes.rootFolder.getName(),
    folderUrl: driveRes.rootFolder.getUrl(),
    subfolders: [
      '01_Database_Wajah_Siswa',
      '02_Database_Wajah_Guru',
      '03_Foto_Kartu_Siswa',
      '04_Logo_TTD_dan_Aset_Kartu',
      '05_Data_Sistem_Teks'
    ],
    message:
      'Database Google Sheets ("' + ss.getName() + '") & Folder Drive ("' + driveRes.rootFolder.getName() + '") beserta subfolder aset & wajah siap digunakan!'
  };
}

/**
 * Opsional: Jalankan fungsi ini langsung dari Editor Google Apps Script
 * untuk membuat Spreadsheet, Folder Drive, & SECRET_TOKEN secara otomatis.
 */
function setupOtomatisDariEditor() {
  var props = getScriptProps_();
  var token = String(props.getProperty(PROP_SECRET_TOKEN) || '').trim();
  if (!token) {
    token = 'mu-presensi-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty(PROP_SECRET_TOKEN, token);
  }
  var res = provisionDatabaseResources_({}, 'apps_script_editor');
  Logger.log('=== HASIL SETUP OTOMATIS ===');
  Logger.log('Spreadsheet: ' + res.spreadsheetName + ' (' + res.spreadsheetUrl + ')');
  Logger.log('Folder Drive: ' + res.folderName + ' (' + res.folderUrl + ')');
  Logger.log('SECRET_TOKEN tersimpan di Script Properties.');
  return res;
}

function handleCheckSystem_() {
  var props = getScriptProps_();
  var ssId = String(props.getProperty(PROP_SPREADSHEET_ID) || '').trim();
  var folderId = String(props.getProperty(PROP_DRIVE_FOLDER_ID) || '').trim();
  var token = String(props.getProperty(PROP_SECRET_TOKEN) || '').trim();

  var missingConfig = [];
  var configuredKeys = [];

  if (!ssId) missingConfig.push(PROP_SPREADSHEET_ID); else configuredKeys.push(PROP_SPREADSHEET_ID);
  if (!folderId) missingConfig.push(PROP_DRIVE_FOLDER_ID); else configuredKeys.push(PROP_DRIVE_FOLDER_ID);
  if (!token) missingConfig.push(PROP_SECRET_TOKEN); else configuredKeys.push(PROP_SECRET_TOKEN);

  var sheetsStatus = { ok: false, message: '', sheetCount: 0 };
  if (!ssId) {
    sheetsStatus = { ok: false, message: 'SPREADSHEET_ID masih kosong di Script Properties.', sheetCount: 0 };
  } else {
    var t0 = Date.now();
    try {
      var ss = SpreadsheetApp.openById(ssId);
      ensureAllSheets_(ss, true);
      sheetsStatus = {
        ok: true,
        message: 'Terhubung ke Spreadsheet (' + ss.getSheets().length + ' sheet siap)',
        sheetCount: ss.getSheets().length,
        latencyMs: Date.now() - t0
      };
    } catch (e) {
      sheetsStatus = { ok: false, message: 'Gagal terhubung ke Spreadsheet: ' + e.message, sheetCount: 0 };
    }
  }

  var driveStatus = { ok: false, message: '' };
  if (!folderId) {
    driveStatus = { ok: false, message: 'DRIVE_FOLDER_ID masih kosong di Script Properties.' };
  } else {
    var t1 = Date.now();
    try {
      var folder = DriveApp.getFolderById(folderId);
      var folderTitle = folder.getName();
      driveStatus = {
        ok: true,
        message: 'Terhubung ke Folder Drive ("' + folderTitle + '")',
        latencyMs: Date.now() - t1
      };
    } catch (e) {
      driveStatus = { ok: false, message: 'Gagal terhubung ke Folder Drive: ' + e.message };
    }
  }

  return {
    success: true,
    serverTime: new Date().toISOString(),
    missingConfig: missingConfig,
    configuredKeys: configuredKeys,
    sheets: sheetsStatus,
    drive: driveStatus
  };
}

var CACHE_VERSION_KEY = 'PRESENSI_DATA_VERSION_V1';

function getDataVersion_() {
  try {
    var cached = CacheService.getScriptCache().get(CACHE_VERSION_KEY);
    if (cached) {
      var cv = Number(cached);
      if (!isNaN(cv) && cv >= 1) return cv;
    }
  } catch (e) {}
  var v = Number(getScriptProps_().getProperty(PROP_DATA_VERSION) || '1');
  var clean = isNaN(v) || v < 1 ? 1 : v;
  try {
    CacheService.getScriptCache().put(CACHE_VERSION_KEY, String(clean), 3600);
  } catch (e) {}
  return clean;
}

function bumpDataVersion_() {
  var props = getScriptProps_();
  var propV = Number(props.getProperty(PROP_DATA_VERSION) || '1');
  var cacheV = 1;
  try {
    cacheV = Number(CacheService.getScriptCache().get(CACHE_VERSION_KEY) || '1');
  } catch (e) {}
  var current = Math.max(isNaN(propV) ? 1 : propV, isNaN(cacheV) ? 1 : cacheV, 1);
  var next = current + 1;
  props.setProperty(PROP_DATA_VERSION, String(next));
  try {
    CacheService.getScriptCache().put(CACHE_VERSION_KEY, String(next), 3600);
  } catch (e) {}
  return next;
}

function nowWibParts_() {
  var d = new Date();
  return {
    iso: d.toISOString(),
    date: Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd'),
    time: Utilities.formatDate(d, TIMEZONE, 'HH:mm:ss'),
    hhmm: Utilities.formatDate(d, TIMEZONE, 'HH:mm')
  };
}

function generateId_(prefix) {
  return (prefix || 'id') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

function hashPassword_(plain) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'mambaul_ulum_salt::' + String(plain));
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

// ============================================================================
// SHEET INITIALIZATION & LOW-LEVEL CRUD (Rule: Col A = id, appendRow, delta update, soft delete)
// ============================================================================

var TEXT_FORMAT_COLUMNS = {
  nis: true,
  nisn: true,
  nip: true,
  barcodeCard: true,
  parentPhone: true,
  phone: true,
  date: true,
  birthDate: true,
  timeIn: true,
  timeOut: true,
  checkInTime: true,
  lateCutoffTime: true,
  checkOutTime: true,
  startTime: true,
  endTime: true,
  createdAt: true,
  diubah_pada: true,
  waktu: true
};

function applyTextFormatForNewSheet_(sheet, headers, rowCountOptional) {
  var rowsToFormat = rowCountOptional && rowCountOptional > 0
    ? rowCountOptional
    : Math.max(1, sheet.getMaxRows() - 1);
  for (var hc = 0; hc < headers.length; hc++) {
    if (TEXT_FORMAT_COLUMNS[headers[hc]]) {
      sheet.getRange(2, hc + 1, rowsToFormat, 1).setNumberFormat('@');
    }
  }
}

function ensureAllSheets_(ss, forceFullCheck) {
  var bootKey = SCHEMA_BOOT_CACHE_PREFIX + ss.getId();
  if (!forceFullCheck) {
    try {
      if (CacheService.getScriptCache().get(bootKey) === '1') {
        if (ss.getSheetByName('Settings') && ss.getSheetByName('Students') && (ss.getSheetByName('Siswa_SMK') || ss.getSheetByName('Siswa_SMA_MA'))) {
          return;
        }
      }
    } catch (cacheBootErr) {}
  }

  var names = Object.keys(SHEET_SCHEMAS);
  var initialized = false;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var headers = SHEET_SCHEMAS[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      applyTextFormatForNewSheet_(sheet, headers);
      _EXEC_HEADER_CACHE[name] = headers.slice();
      initialized = true;
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      applyTextFormatForNewSheet_(sheet, headers);
      _EXEC_HEADER_CACHE[name] = headers.slice();
      initialized = true;
    } else {
      var lastCol = sheet.getLastColumn();
      var existingHeaders = lastCol > 0
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
        : [];
      for (var hc = 0; hc < headers.length; hc++) {
        if (existingHeaders.indexOf(headers[hc]) === -1) {
          lastCol++;
          var cell = sheet.getRange(1, lastCol);
          cell.setValue(headers[hc]);
          cell.setFontWeight('bold');
          if (TEXT_FORMAT_COLUMNS[headers[hc]]) {
            sheet.getRange(2, lastCol, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
          }
          existingHeaders.push(headers[hc]);
        }
      }
      _EXEC_HEADER_CACHE[name] = existingHeaders.slice();
    }
  }

  // Seed default Settings & Users ONLY if Settings or Users has no rows yet
  var settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet.getLastRow() <= 1) {
    seedInitialSettings_(settingsSheet);
    initialized = true;
  }

  var usersSheet = ss.getSheetByName('Users');
  if (usersSheet.getLastRow() <= 1) {
    seedInitialSchoolData_(ss);
    initialized = true;
  } else {
    // Ensure Superadmin account exists on upgraded spreadsheets
    var existingUsersCheck = readActiveRows_(ss, 'Users');
    var hasSuperadmin = false;
    for (var su = 0; su < existingUsersCheck.length; su++) {
      if (String(existingUsersCheck[su].role || '').toLowerCase() === 'superadmin' ||
          String(existingUsersCheck[su].username || '').toLowerCase() === 'superadmin') {
        hasSuperadmin = true;
        break;
      }
    }
    if (!hasSuperadmin) {
      var nowSa = nowWibParts_().iso;
      appendObjectRow_(usersSheet, 'Users', {
        id: 'usr-superadmin',
        username: 'superadmin',
        passwordHash: hashPassword_('superadmin123'),
        name: 'Superadmin Konfigurasi',
        role: 'superadmin',
        email: 'superadmin@mambaululum.sch.id',
        classId: '',
        nip: '',
        isActive: true,
        status: 'aktif',
        createdAt: nowSa,
        diubah_pada: nowSa,
        updatedBy: 'system'
      });
      initialized = true;
    }
  }

  var sessionsSheet = ss.getSheetByName('Sessions');
  if (sessionsSheet && sessionsSheet.getLastRow() <= 1) {
    seedDefaultSessions_(ss, settingsSheet);
    initialized = true;
  } else {
    ensureAllSessionSheets_(ss);
  }

  var levelSheetsCreated = ensureStudentLevelSheetsExist_(ss);
  if (levelSheetsCreated) {
    var existingStudentsCheck = ss.getSheetByName('Students');
    if (existingStudentsCheck && existingStudentsCheck.getLastRow() > 1) {
      syncStudentLevelSheets_(ss);
    }
    initialized = true;
  }

  if (initialized && !getScriptProps_().getProperty(PROP_DATA_VERSION)) {
    getScriptProps_().setProperty(PROP_DATA_VERSION, '1');
  }

  try {
    CacheService.getScriptCache().put(bootKey, '1', 1800);
  } catch (cachePutErr) {}
}

function seedInitialSettings_(sheet) {
  var now = nowWibParts_().iso;
  appendObjectRow_(sheet, 'Settings', {
    id: 'settings-default',
    schoolName: 'Yayasan Mambaul Ulum',
    schoolLogo: '',
    academicYear: '2026/2027',
    checkInTime: '07:00',
    lateCutoffTime: '07:15',
    checkOutTime: '15:00',
    toiletMaxMinutes: 10,
    toiletBabMinutes: 10,
    toiletBakMinutes: 5,
    warningThresholdAbsent: 3,
    warningThresholdLate: 3,
    warningThresholdToilet: 4,
    parentNotificationEnabled: true,
    holidaysJson: '[]',
    foundationAddress: 'Jl. Pesantren Mambaul Ulum No. 45, Diwek, Jombang, Jawa Timur 61471',
    foundationWebsite: 'https://mambaululum.sch.id',
    foundationWatermarkUrl: '',
    foundationQrCodeUrl: '',
    levelConfigsJson: '',
    status: 'aktif',
    diubah_pada: now,
    updatedBy: 'system'
  });
}

function seedInitialSchoolData_(ss) {
  var now = nowWibParts_().iso;
  var usersSheet = ss.getSheetByName('Users');
  var teachersSheet = ss.getSheetByName('Teachers');
  var classesSheet = ss.getSheetByName('Classes');
  var studentsSheet = ss.getSheetByName('Students');
  var locSheet = ss.getSheetByName('Locations');

  var defaultUsers = [
    { id: 'usr-superadmin', username: 'superadmin', passwordHash: hashPassword_('superadmin123'), name: 'Superadmin Konfigurasi', role: 'superadmin', email: 'superadmin@mambaululum.sch.id', classId: '', nip: '', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-admin', username: 'admin', passwordHash: hashPassword_('admin123'), name: 'Administrator Utama', role: 'admin', email: 'admin@mambaululum.sch.id', classId: '', nip: '', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-kepsek', username: 'kepsek', passwordHash: hashPassword_('kepsek123'), name: 'Kepala Sekolah Mambaul Ulum', role: 'kepala_sekolah', email: 'kepsek@mambaululum.sch.id', classId: '', nip: '197805122005011003', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-wali1', username: 'wali1', passwordHash: hashPassword_('guru123'), name: 'Ust. Budi Santoso, S.Pd', role: 'wali_kelas', email: 'budi@mambaululum.sch.id', classId: 'cls-10-a', nip: '198501012010011001', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-bk1', username: 'bk1', passwordHash: hashPassword_('bk123'), name: 'Ustadzah Siti Rahmah, M.Pd', role: 'bk', email: 'bk@mambaululum.sch.id', classId: '', nip: '198702022012012002', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-kesiswaan1', username: 'kesiswaan1', passwordHash: hashPassword_('kes123'), name: 'Bagian Kesiswaan', role: 'kesiswaan', email: 'kesiswaan@mambaululum.sch.id', classId: '', nip: '198803032014011003', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'usr-guru1', username: 'guru1', passwordHash: hashPassword_('guru123'), name: 'Ahmad Fauzan, M.Kom', role: 'guru', email: 'fauzan@mambaululum.sch.id', classId: '', nip: '199005152015011004', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' }
  ];
  for (var i = 0; i < defaultUsers.length; i++) {
    appendObjectRow_(usersSheet, 'Users', defaultUsers[i]);
  }

  var defaultTeachers = [
    { id: 'tch-1', nip: '199005152015011004', name: 'Ahmad Fauzan, M.Kom', email: 'fauzan@mambaululum.sch.id', phone: '081234567801', subject: 'Informatika & Koding', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'tch-2', nip: '198501012010011001', name: 'Ust. Budi Santoso, S.Pd', email: 'budi@mambaululum.sch.id', phone: '081234567802', subject: 'Pendidikan Agama Islam', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'tch-3', nip: '198702022012012002', name: 'Ustadzah Siti Rahmah, M.Pd', email: 'bk@mambaululum.sch.id', phone: '081234567803', subject: 'Bimbingan Konseling', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' }
  ];
  for (var t = 0; t < defaultTeachers.length; t++) {
    appendObjectRow_(teachersSheet, 'Teachers', defaultTeachers[t]);
  }

  var defaultClasses = [
    { id: 'cls-10-a', name: 'X SMK A', grade: '10', academicYear: '2026/2027', level: 'SMK', homeRoomTeacherId: 'tch-2', homeRoomTeacherName: 'Ust. Budi Santoso, S.Pd', status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'cls-7-a', name: 'VII SMP A', grade: '7', academicYear: '2026/2027', level: 'SMP/MTS', homeRoomTeacherId: 'tch-1', homeRoomTeacherName: 'Ahmad Fauzan, M.Kom', status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' }
  ];
  for (var c = 0; c < defaultClasses.length; c++) {
    appendObjectRow_(classesSheet, 'Classes', defaultClasses[c]);
  }

  var defaultStudents = [
    { id: 'std-1', nis: '2026001', nisn: '0091234501', name: 'Muhammad Rizki Pratama', gender: 'L', classId: 'cls-10-a', barcodeCard: 'CARD-2026001', parentPhone: '081234567890', photoFileId: '', photoUrl: '', level: 'SMK', birthPlace: 'Jombang', birthDate: '12-08-2009', address: 'Diwek, Jombang', bloodType: 'O', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'std-2', nis: '2026002', nisn: '0091234502', name: 'Aisyah Nurul Hidayah', gender: 'P', classId: 'cls-10-a', barcodeCard: 'CARD-2026002', parentPhone: '081234567891', photoFileId: '', photoUrl: '', level: 'SMK', birthPlace: 'Jombang', birthDate: '04-03-2010', address: 'Peterongan, Jombang', bloodType: 'A', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' },
    { id: 'std-3', nis: '2026003', nisn: '0091234503', name: 'Zainal Abidin', gender: 'L', classId: 'cls-7-a', barcodeCard: 'CARD-2026003', parentPhone: '081234567892', photoFileId: '', photoUrl: '', level: 'SMP/MTS', birthPlace: 'Mojokerto', birthDate: '19-11-2012', address: 'Mojoagung, Jombang', bloodType: 'B', isActive: true, status: 'aktif', createdAt: now, diubah_pada: now, updatedBy: 'system' }
  ];
  for (var s = 0; s < defaultStudents.length; s++) {
    appendObjectRow_(studentsSheet, 'Students', defaultStudents[s]);
  }

  if (locSheet.getLastRow() <= 1) {
    appendObjectRow_(locSheet, 'Locations', {
      id: 'loc-main',
      name: 'Kampus Utama Yayasan Mambaul Ulum',
      latitude: -7.5892,
      longitude: 112.2385,
      radiusMeters: 250,
      isActive: true,
      status: 'aktif',
      createdAt: now,
      diubah_pada: now,
      updatedBy: 'system'
    });
  }

  writeAuditLog_(ss, 'system', 'INIT', 'System', 'seed', 'Inisialisasi struktur sheet & data awal');
}

function getHeaders_(sheet, schemaName) {
  var cacheKey = (sheet && sheet.getName()) ? sheet.getName() : String(schemaName || '');
  if (cacheKey && _EXEC_HEADER_CACHE[cacheKey]) {
    return _EXEC_HEADER_CACHE[cacheKey].slice();
  }
  var schema = SHEET_SCHEMAS[schemaName];
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    var fallback = schema
      ? schema.slice()
      : (String(schemaName).indexOf('Presensi_Guru_') === 0 ? TEACHER_SESSION_ATT_HEADERS.slice() : STUDENT_SESSION_ATT_HEADERS.slice());
    if (cacheKey) _EXEC_HEADER_CACHE[cacheKey] = fallback.slice();
    return fallback;
  }
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (cacheKey) _EXEC_HEADER_CACHE[cacheKey] = headerRow.slice();
  return headerRow;
}

function isDateValue_(val) {
  return val instanceof Date || Object.prototype.toString.call(val) === '[object Date]';
}

function padHhMm_(raw, fallback) {
  var str = String(raw || '').trim();
  if (!str) return fallback || '';
  var m = str.match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return fallback || str;
  var hh = Number(m[1]);
  var mm = Number(m[2]);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback || str;
  return (hh < 10 ? '0' + hh : String(hh)) + ':' + (mm < 10 ? '0' + mm : String(mm));
}

function extractDriveFileIdFromRef_(raw) {
  var str = String(raw || '').trim();
  if (!str) return '';
  if (str.indexOf('gas-photo://') === 0) {
    return str.slice('gas-photo://'.length).trim();
  }
  if (str.indexOf(DRIVE_BLOB_PREFIX) === 0) {
    return str.slice(DRIVE_BLOB_PREFIX.length).trim();
  }
  var idMatch = str.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || str.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idMatch && idMatch[1]) {
    return idMatch[1];
  }
  return '';
}

function collectDriveFileIdsFromString_(raw) {
  var str = String(raw || '');
  if (!str) return [];
  var found = {};
  var rePhoto = /gas-photo:\/\/([a-zA-Z0-9_-]+)/g;
  var m;
  while ((m = rePhoto.exec(str)) !== null) {
    if (m[1]) found[m[1]] = true;
  }
  var reBlob = /__DRIVE_BLOB__:([a-zA-Z0-9_-]+)/g;
  while ((m = reBlob.exec(str)) !== null) {
    if (m[1]) found[m[1]] = true;
  }
  return Object.keys(found);
}

function trashDriveFileSafely_(rawIdOrRef) {
  var fileId = extractDriveFileIdFromRef_(rawIdOrRef) || String(rawIdOrRef || '').trim();
  if (!fileId || fileId.length < 8) return false;
  delete _EXEC_BLOB_CACHE[fileId];
  try {
    CacheService.getScriptCache().remove(CACHE_BLOB_PREFIX + fileId);
  } catch (cacheRemErr) {}
  try {
    var file = DriveApp.getFileById(fileId);
    if (!file.isTrashed()) {
      file.setTrashed(true);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function writeDriveBlobText_(content, label) {
  var driveRes = ensureDriveFolders_(true);
  if (!driveRes.ok || !driveRes.blobDataFolder) {
    throw new Error(driveRes.error || 'Folder penyimpanan teks Drive belum siap.');
  }
  var safeLabel = sanitizeDriveName_(label || 'data') || 'data';
  var fileName = safeLabel + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.txt';
  var blob = Utilities.newBlob(String(content), 'text/plain; charset=utf-8', fileName);
  var file = driveRes.blobDataFolder.createFile(blob);
  var fileId = file.getId();
  _EXEC_BLOB_CACHE[fileId] = String(content);
  if (String(content).length <= 90000) {
    try {
      CacheService.getScriptCache().put(CACHE_BLOB_PREFIX + fileId, String(content), 21600);
    } catch (cErr) {}
  }
  return DRIVE_BLOB_PREFIX + fileId;
}

function readDriveBlobText_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return '';
  if (_EXEC_BLOB_CACHE.hasOwnProperty(id)) {
    return _EXEC_BLOB_CACHE[id];
  }
  try {
    var cached = CacheService.getScriptCache().get(CACHE_BLOB_PREFIX + id);
    if (cached !== null && cached !== undefined) {
      _EXEC_BLOB_CACHE[id] = cached;
      return cached;
    }
  } catch (cGetErr) {}
  try {
    var file = DriveApp.getFileById(id);
    if (file.isTrashed()) return '';
    var text = file.getBlob().getDataAsString('UTF-8');
    _EXEC_BLOB_CACHE[id] = text;
    if (text.length <= 90000) {
      try {
        CacheService.getScriptCache().put(CACHE_BLOB_PREFIX + id, text, 21600);
      } catch (cPutErr) {}
    }
    return text;
  } catch (e) {
    return '';
  }
}

function prepareCellValueForSheet_(val, label) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string' && val.indexOf(DRIVE_BLOB_PREFIX) !== 0 && val.length > CELL_DRIVE_SPILL_THRESHOLD) {
    return writeDriveBlobText_(val, label);
  }
  return val;
}

function normalizeSheetCellValue_(key, val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string' && val.indexOf(DRIVE_BLOB_PREFIX) === 0) {
    var blobId = val.slice(DRIVE_BLOB_PREFIX.length).trim();
    return readDriveBlobText_(blobId);
  }
  if (isDateValue_(val) && !isNaN(val.getTime())) {
    if (key === 'date' || key === 'birthDate') {
      return Utilities.formatDate(val, TIMEZONE, 'yyyy-MM-dd');
    }
    if (key === 'timeIn' || key === 'timeOut') {
      return Utilities.formatDate(val, TIMEZONE, 'HH:mm:ss');
    }
    if (key === 'checkInTime' || key === 'lateCutoffTime' || key === 'checkOutTime' || key === 'startTime' || key === 'endTime') {
      return Utilities.formatDate(val, TIMEZONE, 'HH:mm');
    }
    if (key === 'diubah_pada' || key === 'createdAt' || key === 'waktu') {
      return val.toISOString();
    }
    return Utilities.formatDate(val, TIMEZONE, 'yyyy-MM-dd');
  }
  if (key === 'checkInTime' || key === 'lateCutoffTime' || key === 'checkOutTime' || key === 'startTime' || key === 'endTime') {
    return padHhMm_(val, '');
  }
  return val;
}

// ============================================================================
// ATTENDANCE SESSIONS HELPERS (Siswa vs Guru terpisah, 24-Jam, Sheet Per Sesi)
// ============================================================================

function sanitizeSessionSheetName_(targetType, sessionName, customSheetName) {
  var prefix = targetType === 'teacher' ? 'Presensi_Guru_' : 'Presensi_Siswa_';
  var raw = String(customSheetName || '').trim();
  if (!raw) {
    var cleanTitle = String(sessionName || 'Sesi')
      .replace(/[\\\/?*\[\]:]+/g, ' ')
      .trim()
      .replace(/\s+/g, '_');
    raw = prefix + (cleanTitle || 'Baru');
  } else {
    raw = raw.replace(/[\\\/?*\[\]:]+/g, '_').replace(/\s+/g, '_').trim();
  }
  return raw.slice(0, 90);
}

function ensureUniqueSessionSheetName_(ss, sessionsList, baseName, excludeId) {
  var taken = {};
  var sysKeys = Object.keys(SHEET_SCHEMAS);
  for (var k = 0; k < sysKeys.length; k++) {
    taken[sysKeys[k].toLowerCase()] = true;
  }
  for (var i = 0; i < sessionsList.length; i++) {
    var item = sessionsList[i];
    if (excludeId && String(item.id) === String(excludeId)) continue;
    if (item.sheetName) {
      taken[String(item.sheetName).toLowerCase()] = true;
    }
  }
  var cleanBase = String(baseName || 'Presensi_Sesi').slice(0, 88);
  var candidate = cleanBase;
  var counter = 2;
  while (taken[candidate.toLowerCase()] || (!excludeId && ss.getSheetByName(candidate))) {
    candidate = cleanBase.slice(0, 84) + '_' + counter;
    counter++;
  }
  return candidate;
}

function ensureSessionSheet_(ss, sessionObj) {
  if (!sessionObj || !sessionObj.sheetName) return null;
  var sheetName = String(sessionObj.sheetName).trim();
  var headers = sessionObj.targetType === 'teacher'
    ? TEACHER_SESSION_ATT_HEADERS
    : STUDENT_SESSION_ATT_HEADERS;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    applyTextFormatForNewSheet_(sheet, headers);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    applyTextFormatForNewSheet_(sheet, headers);
  } else {
    var lastCol = sheet.getLastColumn();
    var existingHeaders = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
      : [];
    for (var hc = 0; hc < headers.length; hc++) {
      if (existingHeaders.indexOf(headers[hc]) === -1) {
        lastCol++;
        var cell = sheet.getRange(1, lastCol);
        cell.setValue(headers[hc]);
        cell.setFontWeight('bold');
        if (TEXT_FORMAT_COLUMNS[headers[hc]]) {
          sheet.getRange(2, lastCol, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
        }
        existingHeaders.push(headers[hc]);
      }
    }
    _EXEC_HEADER_CACHE[sheetName] = existingHeaders.slice();
  }
  return sheet;
}

function ensureAllSessionSheets_(ss) {
  var rows = readActiveRows_(ss, 'Sessions');
  for (var i = 0; i < rows.length; i++) {
    var s = formatSessionRow_(rows[i]);
    if (s.sheetName) {
      ensureSessionSheet_(ss, s);
    }
  }
}

function seedDefaultSessions_(ss, settingsSheet) {
  var sessionsSheet = ss.getSheetByName('Sessions');
  if (!sessionsSheet) return;
  var now = nowWibParts_().iso;
  var cutoffDefault = '07:15';
  if (settingsSheet && settingsSheet.getLastRow() > 1) {
    var setRows = readActiveRows_(ss, 'Settings');
    if (setRows.length > 0 && setRows[0].lateCutoffTime) {
      cutoffDefault = padHhMm_(setRows[0].lateCutoffTime, '07:15');
    }
  }

  var defaults = [
    {
      id: 'ses-std-pagi',
      targetType: 'student',
      name: 'Sesi Pagi',
      startTime: '05:00',
      lateCutoffTime: cutoffDefault,
      endTime: '12:00',
      sheetName: 'Presensi_Siswa_Sesi_Pagi',
      sortOrder: 1,
      isActive: true,
      status: 'aktif',
      createdAt: now,
      diubah_pada: now,
      updatedBy: 'system'
    },
    {
      id: 'ses-std-siang',
      targetType: 'student',
      name: 'Sesi Siang',
      startTime: '12:01',
      lateCutoffTime: '13:00',
      endTime: '18:00',
      sheetName: 'Presensi_Siswa_Sesi_Siang',
      sortOrder: 2,
      isActive: true,
      status: 'aktif',
      createdAt: now,
      diubah_pada: now,
      updatedBy: 'system'
    },
    {
      id: 'ses-tch-pagi',
      targetType: 'teacher',
      name: 'Sesi Pagi',
      startTime: '05:00',
      lateCutoffTime: cutoffDefault,
      endTime: '12:00',
      sheetName: 'Presensi_Guru_Sesi_Pagi',
      sortOrder: 1,
      isActive: true,
      status: 'aktif',
      createdAt: now,
      diubah_pada: now,
      updatedBy: 'system'
    },
    {
      id: 'ses-tch-siang',
      targetType: 'teacher',
      name: 'Sesi Siang',
      startTime: '12:01',
      lateCutoffTime: '13:00',
      endTime: '18:00',
      sheetName: 'Presensi_Guru_Sesi_Siang',
      sortOrder: 2,
      isActive: true,
      status: 'aktif',
      createdAt: now,
      diubah_pada: now,
      updatedBy: 'system'
    }
  ];

  for (var i = 0; i < defaults.length; i++) {
    appendObjectRow_(sessionsSheet, 'Sessions', defaults[i]);
    ensureSessionSheet_(ss, defaults[i]);
  }
}

function formatSessionRow_(row) {
  var tType = String(row.targetType || '').toLowerCase() === 'teacher' ? 'teacher' : 'student';
  var name = String(row.name || 'Sesi Utama').trim();
  return {
    id: String(row.id || ''),
    targetType: tType,
    name: name,
    startTime: padHhMm_(row.startTime, '06:00'),
    lateCutoffTime: padHhMm_(row.lateCutoffTime, '07:15'),
    endTime: padHhMm_(row.endTime, '12:00'),
    sheetName: String(row.sheetName || sanitizeSessionSheetName_(tType, name, '')),
    sortOrder: Number(row.sortOrder) || 1,
    isActive: row.isActive === true || String(row.isActive).toLowerCase() === 'true' || row.isActive === '',
    createdAt: row.createdAt || '',
    updatedAt: row.diubah_pada || '',
    diubah_pada: row.diubah_pada || '',
    updatedBy: row.updatedBy || ''
  };
}

function readSortedSessions_(ss) {
  return readActiveRows_(ss, 'Sessions')
    .map(formatSessionRow_)
    .sort(function (a, b) {
      var ord = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (ord !== 0) return ord;
      return String(a.startTime || '').localeCompare(String(b.startTime || ''));
    });
}

function parseHhMmMinutes_(hhmm) {
  var str = String(hhmm || '').trim();
  var m = str.match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  var hh = Number(m[1]);
  var mm = Number(m[2]);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isTimeInSession_(hhmm, startTime, endTime) {
  var nowMin = parseHhMmMinutes_(hhmm);
  var startMin = parseHhMmMinutes_(startTime);
  var endMin = parseHhMmMinutes_(endTime);
  if (nowMin === null || startMin === null || endMin === null) return false;
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin <= endMin;
  }
  return nowMin >= startMin || nowMin <= endMin;
}

function resolveActiveSession_(sessions, targetType, hhmm) {
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (s.targetType === targetType && s.isActive && isTimeInSession_(hhmm, s.startTime, s.endTime)) {
      return s;
    }
  }
  return null;
}

function resolveSessionForAttendance_(ss, targetType, requestedSessionId, hhmm, allowClosedById) {
  var sessions = readSortedSessions_(ss);
  var reqId = String(requestedSessionId || '').trim();
  if (reqId) {
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (String(s.id) === reqId && s.targetType === targetType && s.isActive) {
        if (allowClosedById || isTimeInSession_(hhmm, s.startTime, s.endTime)) {
          return s;
        }
        break;
      }
    }
  }
  var auto = resolveActiveSession_(sessions, targetType, hhmm);
  if (auto) return auto;
  if (allowClosedById) {
    for (var j = 0; j < sessions.length; j++) {
      if (sessions[j].targetType === targetType && sessions[j].isActive) {
        return sessions[j];
      }
    }
  }
  return null;
}

function readAttendanceAcrossSessionSheets_(ss, targetType, optionalSessionId) {
  var sessions = readSortedSessions_(ss).filter(function (s) {
    if (s.targetType !== targetType) return false;
    if (optionalSessionId && String(s.id) !== String(optionalSessionId)) return false;
    return true;
  });

  var rows = [];
  var seenIds = {};
  var seenSheets = {};

  for (var i = 0; i < sessions.length; i++) {
    var ses = sessions[i];
    if (!ses.sheetName || seenSheets[ses.sheetName]) continue;
    seenSheets[ses.sheetName] = true;
    if (!ss.getSheetByName(ses.sheetName)) continue;
    var sheetRows = readActiveRows_(ss, ses.sheetName);
    for (var r = 0; r < sheetRows.length; r++) {
      var rec = sheetRows[r];
      if (seenIds[String(rec.id)]) continue;
      seenIds[String(rec.id)] = true;
      if (!rec.sessionId) rec.sessionId = ses.id;
      if (!rec.sessionName) rec.sessionName = ses.name;
      rows.push(rec);
    }
  }

  // Also include legacy sheet records only when no specific sessionId filter is applied
  if (!optionalSessionId) {
    var legacyName = targetType === 'teacher' ? 'TeacherAttendance' : 'StudentAttendance';
    if (ss.getSheetByName(legacyName)) {
      var legacyRows = readActiveRows_(ss, legacyName);
      for (var lr = 0; lr < legacyRows.length; lr++) {
        var lrec = legacyRows[lr];
        if (seenIds[String(lrec.id)]) continue;
        seenIds[String(lrec.id)] = true;
        if (!lrec.sessionName) lrec.sessionName = 'Riwayat Umum';
        rows.push(lrec);
      }
    }
  }

  return rows;
}

function readActiveRows_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var rowArr = values[r];
    var id = String(rowArr[0] || '').trim();
    if (!id) continue;
    // Guard against duplicate header rows accidentally inserted in Sheets
    if (id.toLowerCase() === 'id' && (String(rowArr[1] || '').trim() === headers[1] || String(rowArr[headers.indexOf('status')] || '').toLowerCase() === 'status')) {
      continue;
    }

    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = headers[c];
      if (!key) continue;
      obj[key] = normalizeSheetCellValue_(key, rowArr[c]);
    }

    if (String(obj.status || '').toLowerCase() === 'dihapus') {
      continue;
    }

    rows.push(obj);
  }
  return rows;
}

function appendObjectRow_(sheet, schemaName, dataObj) {
  var headers = getHeaders_(sheet, schemaName);
  var rowValues = [];
  for (var c = 0; c < headers.length; c++) {
    var key = headers[c];
    var val = dataObj.hasOwnProperty(key) ? dataObj[key] : '';
    rowValues.push(prepareCellValueForSheet_(val, schemaName + '_' + key));
  }
  sheet.appendRow(rowValues);
}

function findRowById_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var target = String(id);
  for (var i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0]) === target) {
      return i + 2; // 1-indexed sheet row
    }
  }
  return -1;
}

function updateRowCellsById_(sheet, schemaName, id, patchObj, expectedUpdatedAt) {
  if (!sheet) {
    return { success: false, error: 'Sheet "' + schemaName + '" tidak ditemukan.' };
  }
  var rowIndex = findRowById_(sheet, id);
  if (rowIndex === -1) {
    return { success: false, error: 'Data dengan ID "' + id + '" tidak ditemukan.' };
  }

  var headers = getHeaders_(sheet, schemaName);
  var rowRange = sheet.getRange(rowIndex, 1, 1, headers.length);
  var currentValues = rowRange.getValues()[0];

  var statusCol = headers.indexOf('status');
  if (statusCol >= 0 && String(currentValues[statusCol] || '').toLowerCase() === 'dihapus') {
    return { success: false, alreadyDeleted: true, error: 'Data sudah dihapus.' };
  }

  var updatedCol = headers.indexOf('diubah_pada');
  var currentUpdatedAt = updatedCol >= 0
    ? String(normalizeSheetCellValue_('diubah_pada', currentValues[updatedCol]) || '').trim()
    : '';

  var expStr = (expectedUpdatedAt === undefined || expectedUpdatedAt === null) ? '' : String(expectedUpdatedAt).trim();
  if (expStr === 'undefined' || expStr === 'null') expStr = '';

  if (expStr && currentUpdatedAt && expStr !== currentUpdatedAt) {
    var expMs = Date.parse(expStr);
    var curMs = Date.parse(currentUpdatedAt);
    if (isNaN(expMs) || isNaN(curMs) || Math.abs(expMs - curMs) >= 1000) {
      return {
        success: false,
        conflict: true,
        serverUpdatedAt: currentUpdatedAt,
        error: 'Konflik edit: Data ini sudah diubah pengguna lain pada ' + currentUpdatedAt + '. Data telah dimuat ulang otomatis.'
      };
    }
  }

  var nowIso = nowWibParts_().iso;
  patchObj.diubah_pada = nowIso;

  var changedIndices = [];
  var nextRow = currentValues.slice();
  var oldBlobIdsToTrash = [];

  for (var c = 0; c < headers.length; c++) {
    var key = headers[c];
    if (!patchObj.hasOwnProperty(key) || key === 'id') continue;
    var nextVal = patchObj[key] === undefined || patchObj[key] === null ? '' : patchObj[key];
    var rawPrev = currentValues[c];
    var prevVal = normalizeSheetCellValue_(key, rawPrev);

    if (String(prevVal) !== String(nextVal)) {
      if (typeof rawPrev === 'string' && rawPrev.indexOf(DRIVE_BLOB_PREFIX) === 0) {
        var oldBlobId = rawPrev.slice(DRIVE_BLOB_PREFIX.length).trim();
        if (oldBlobId) oldBlobIdsToTrash.push(oldBlobId);
      }
      nextRow[c] = prepareCellValueForSheet_(nextVal, schemaName + '_' + key);
      changedIndices.push(c);
    }
  }

  if (changedIndices.length === 1) {
    var colIdx = changedIndices[0];
    var singleCell = sheet.getRange(rowIndex, colIdx + 1);
    if (TEXT_FORMAT_COLUMNS[headers[colIdx]]) {
      singleCell.setNumberFormat('@');
    }
    singleCell.setValue(nextRow[colIdx]);
  } else if (changedIndices.length === 2) {
    for (var ci = 0; ci < changedIndices.length; ci++) {
      var idx = changedIndices[ci];
      var pairCell = sheet.getRange(rowIndex, idx + 1);
      if (TEXT_FORMAT_COLUMNS[headers[idx]]) {
        pairCell.setNumberFormat('@');
      }
      pairCell.setValue(nextRow[idx]);
    }
  } else if (changedIndices.length > 2) {
    for (var mc = 0; mc < changedIndices.length; mc++) {
      var mIdx = changedIndices[mc];
      if (TEXT_FORMAT_COLUMNS[headers[mIdx]]) {
        sheet.getRange(rowIndex, mIdx + 1).setNumberFormat('@');
      }
    }
    rowRange.setValues([nextRow]);
  }

  for (var ob = 0; ob < oldBlobIdsToTrash.length; ob++) {
    trashDriveFileSafely_(oldBlobIdsToTrash[ob]);
  }

  return { success: true, rowIndex: rowIndex, changedCount: changedIndices.length, diubah_pada: nowIso };
}

function collectRowDriveIds_(headers, rowValues) {
  var collected = {};
  for (var c = 0; c < rowValues.length; c++) {
    var key = headers[c] || '';
    var raw = rowValues[c];
    if (key === 'photoFileId' && raw) {
      var directId = String(raw).trim();
      if (directId) collected[directId] = true;
    }
    if (typeof raw === 'string' && raw) {
      var ids = collectDriveFileIdsFromString_(raw);
      for (var ii = 0; ii < ids.length; ii++) {
        collected[ids[ii]] = true;
      }
      if (raw.indexOf(DRIVE_BLOB_PREFIX) === 0) {
        var hydrated = normalizeSheetCellValue_(key, raw);
        var innerIds = collectDriveFileIdsFromString_(hydrated);
        for (var hi = 0; hi < innerIds.length; hi++) {
          collected[innerIds[hi]] = true;
        }
      }
    }
  }
  return Object.keys(collected);
}

function softDeleteRowById_(sheet, schemaName, id, expectedUpdatedAt, actor) {
  if (!sheet) {
    return { success: false, error: 'Sheet "' + schemaName + '" tidak ditemukan.' };
  }
  var rowIndex = findRowById_(sheet, id);
  if (rowIndex === -1) {
    return { success: true, alreadyDeleted: true, mutated: false, message: 'Data sudah tidak ada atau sudah terhapus.' };
  }
  var headers = getHeaders_(sheet, schemaName);
  var rowValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var driveIds = collectRowDriveIds_(headers, rowValues);
  var trashedFiles = 0;
  for (var d = 0; d < driveIds.length; d++) {
    if (trashDriveFileSafely_(driveIds[d])) trashedFiles++;
  }
  sheet.deleteRow(rowIndex);
  return {
    success: true,
    mutated: true,
    deletedRowIndex: rowIndex,
    trashedFiles: trashedFiles,
    message: 'Data bersih terhapus dari Google Sheet & Drive.'
  };
}

function writeAuditLog_(ss, actor, action, entity, entityId, details) {
  var sheet = ss.getSheetByName('Log');
  if (!sheet) return;
  var parts = nowWibParts_();
  appendObjectRow_(sheet, 'Log', {
    id: generateId_('log'),
    waktu: parts.iso,
    pengguna: actor || 'system',
    aksi: action,
    entitas: entity,
    id_entitas: entityId || '',
    detail: details || '',
    status: 'aktif',
    diubah_pada: parts.iso
  });
}

// ============================================================================
// PRESENCE (Multi-User via ScriptCache - super fast, zero sheet write lag)
// ============================================================================

function updatePresenceFromParams_(params) {
  if (!params.clientId) return;
  updatePresence_({
    clientId: params.clientId,
    userId: params.userId || '',
    name: params.userName || (params.activeTab === 'kiosk' ? 'Terminal Kiosk Siswa' : 'Pengunjung'),
    role: params.userRole || 'kiosk',
    activeTab: params.activeTab || 'portal',
    deviceLabel: params.deviceLabel || 'Web Browser'
  }, true);
}

function updatePresence_(info, skipIfRecent) {
  if (!info || !info.clientId) return;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(CACHE_PRESENCE_KEY);
  var map = {};
  if (raw) {
    try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; }
  }
  var nowMs = Date.now();
  var existing = map[info.clientId] || {};

  // Throttle repeated polling writes (< 8s with identical tab & userId) to keep polling sub-second fast
  if (skipIfRecent && existing._ts && (nowMs - existing._ts) < 8000 &&
      existing.activeTab === (info.activeTab || existing.activeTab) &&
      existing.userId === (info.userId || existing.userId)) {
    return;
  }

  var nowIso = new Date(nowMs).toISOString();

  map[info.clientId] = {
    clientId: info.clientId,
    userId: info.userId || existing.userId || ('guest-' + String(info.clientId).slice(0, 6)),
    username: info.username || existing.username || 'kiosk',
    name: info.name || existing.name || 'Pengguna',
    role: info.role || existing.role || 'kiosk',
    activeTab: info.activeTab || existing.activeTab || 'portal',
    deviceLabel: info.deviceLabel || existing.deviceLabel || 'Web Browser',
    connectedAt: existing.connectedAt || nowIso,
    lastSeenAt: nowIso,
    _ts: nowMs
  };

  // Sweep entries older than 35 seconds
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    if (nowMs - (map[keys[i]]._ts || 0) > 35000) {
      delete map[keys[i]];
    }
  }

  try {
    cache.put(CACHE_PRESENCE_KEY, JSON.stringify(map), 120);
  } catch (e) {}
}

function getActiveUsers_() {
  var cache = CacheService.getScriptCache();
  var raw = cache.get(CACHE_PRESENCE_KEY);
  if (!raw) return [];
  try {
    var map = JSON.parse(raw) || {};
    var nowMs = Date.now();
    var list = [];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var u = map[keys[i]];
      if (nowMs - (u._ts || 0) <= 35000) {
        list.push({
          clientId: u.clientId,
          userId: u.userId,
          username: u.username,
          name: u.name,
          role: u.role,
          activeTab: u.activeTab,
          deviceLabel: u.deviceLabel,
          connectedAt: u.connectedAt,
          lastSeenAt: u.lastSeenAt
        });
      }
    }
    return list;
  } catch (e) {
    return [];
  }
}

// ============================================================================
// SYNC HANDLER (Two-way sub-second delta check)
// ============================================================================

function formatSettingsRow_(row) {
  var holidays = [];
  try {
    holidays = row.holidaysJson ? JSON.parse(row.holidaysJson) : [];
  } catch (e) {
    holidays = [];
  }
  var safeLevelConfigsJson = '';
  try {
    var rawLvl = String(row.levelConfigsJson || '').trim();
    if (rawLvl && rawLvl.charAt(0) === '{') {
      JSON.parse(rawLvl);
      safeLevelConfigsJson = rawLvl;
    }
  } catch (e) {
    safeLevelConfigsJson = '';
  }

  return {
    id: row.id || 'settings-default',
    schoolName: row.schoolName || 'Yayasan Mambaul Ulum',
    schoolLogo: row.schoolLogo || '',
    academicYear: row.academicYear || '2026/2027',
    checkInTime: padHhMm_(row.checkInTime, '07:00'),
    lateCutoffTime: padHhMm_(row.lateCutoffTime, '07:15'),
    checkOutTime: padHhMm_(row.checkOutTime, '15:00'),
    toiletMaxMinutes: Number(row.toiletMaxMinutes) || 10,
    toiletBabMinutes: Number(row.toiletBabMinutes) || 10,
    toiletBakMinutes: Number(row.toiletBakMinutes) || 5,
    warningThresholdAbsent: Number(row.warningThresholdAbsent) || 3,
    warningThresholdLate: Number(row.warningThresholdLate) || 3,
    warningThresholdToilet: Number(row.warningThresholdToilet) || 4,
    parentNotificationEnabled: String(row.parentNotificationEnabled) === 'true' || row.parentNotificationEnabled === true,
    holidays: holidays,
    foundationAddress: row.foundationAddress || '',
    foundationWebsite: row.foundationWebsite || '',
    foundationWatermarkUrl: row.foundationWatermarkUrl || '',
    foundationQrCodeUrl: row.foundationQrCodeUrl || '',
    levelConfigsJson: safeLevelConfigsJson,
    diubah_pada: row.diubah_pada || ''
  };
}

function handleSync_(ss, params) {
  var serverVersion = getDataVersion_();
  var sinceVersion = Number(params.sinceVersion || 0);
  var force = String(params.force || '') === '1';
  var parts = nowWibParts_();
  var activeUsers = getActiveUsers_();

  if (!force && sinceVersion === serverVersion && sinceVersion > 0) {
    return {
      success: true,
      hasChanges: false,
      serverVersion: serverVersion,
      serverTime: parts.iso,
      serverDate: parts.date,
      activeUsers: activeUsers
    };
  }

  var settingsRows = readActiveRows_(ss, 'Settings');
  var settings = settingsRows.length > 0 ? formatSettingsRow_(settingsRows[0]) : formatSettingsRow_({});

  var rawFaceTemplates = readActiveRows_(ss, 'FaceTemplates');
  var enrolledSet = {};
  var faceTemplates = rawFaceTemplates.map(function (f) {
    var desc = [];
    try {
      desc = typeof f.descriptorJson === 'string' && f.descriptorJson ? JSON.parse(f.descriptorJson) : [];
    } catch (e) { desc = []; }
    enrolledSet[String(f.personId)] = true;
    return {
      id: f.id,
      personId: f.personId,
      personType: f.personType || 'student',
      descriptor: desc,
      photoFileId: f.photoFileId || '',
      createdAt: f.createdAt || '',
      updatedAt: f.diubah_pada || '',
      diubah_pada: f.diubah_pada || '',
      updatedBy: f.updatedBy || ''
    };
  });

  var classes = readActiveRows_(ss, 'Classes').map(function (c) {
    return {
      id: c.id,
      name: c.name,
      grade: String(c.grade || ''),
      academicYear: c.academicYear || '',
      level: c.level || '',
      homeRoomTeacherId: c.homeRoomTeacherId || '',
      homeRoomTeacherName: c.homeRoomTeacherName || '',
      createdAt: c.createdAt || '',
      updatedAt: c.diubah_pada || '',
      diubah_pada: c.diubah_pada || '',
      updatedBy: c.updatedBy || ''
    };
  });

  var students = readActiveRows_(ss, 'Students').map(function (s) {
    var active = s.isActive === true || String(s.isActive).toLowerCase() === 'true' || s.isActive === '';
    return {
      id: s.id,
      nis: String(s.nis || ''),
      nisn: String(s.nisn || ''),
      name: s.name || '',
      gender: s.gender === 'P' ? 'P' : 'L',
      classId: s.classId || '',
      barcodeCard: String(s.barcodeCard || ''),
      parentPhone: String(s.parentPhone || ''),
      photoFileId: s.photoFileId || '',
      photoUrl: s.photoFileId ? ('gas-photo://' + s.photoFileId) : (s.photoUrl || ''),
      level: s.level || '',
      birthPlace: s.birthPlace || '',
      birthDate: s.birthDate || '',
      address: s.address || '',
      bloodType: s.bloodType || '',
      isActive: active,
      hasFaceEnrolled: !!enrolledSet[String(s.id)],
      createdAt: s.createdAt || '',
      updatedAt: s.diubah_pada || '',
      diubah_pada: s.diubah_pada || '',
      updatedBy: s.updatedBy || ''
    };
  });

  var teachers = readActiveRows_(ss, 'Teachers').map(function (t) {
    var active = t.isActive === true || String(t.isActive).toLowerCase() === 'true' || t.isActive === '';
    return {
      id: t.id,
      nip: String(t.nip || ''),
      name: t.name || '',
      email: t.email || '',
      phone: String(t.phone || ''),
      subject: t.subject || '',
      isActive: active,
      hasFaceEnrolled: !!enrolledSet[String(t.id)],
      createdAt: t.createdAt || '',
      updatedAt: t.diubah_pada || '',
      diubah_pada: t.diubah_pada || '',
      updatedBy: t.updatedBy || ''
    };
  });

  var locations = readActiveRows_(ss, 'Locations').map(function (l) {
    return {
      id: l.id,
      name: l.name,
      latitude: Number(l.latitude || 0),
      longitude: Number(l.longitude || 0),
      radiusMeters: Number(l.radiusMeters || 150),
      isActive: l.isActive === true || String(l.isActive).toLowerCase() === 'true' || l.isActive === '',
      createdAt: l.createdAt || '',
      updatedAt: l.diubah_pada || '',
      diubah_pada: l.diubah_pada || '',
      updatedBy: l.updatedBy || ''
    };
  });

  var sessions = readSortedSessions_(ss);
  var activeStudentSession = resolveActiveSession_(sessions, 'student', parts.hhmm);
  var activeTeacherSession = resolveActiveSession_(sessions, 'teacher', parts.hhmm);

  var todayAttendance = [];
  if (activeStudentSession && activeStudentSession.sheetName) {
    ensureSessionSheet_(ss, activeStudentSession);
    var studentAttSessionRows = readActiveRows_(ss, activeStudentSession.sheetName);
    for (var i = 0; i < studentAttSessionRows.length; i++) {
      var a = studentAttSessionRows[i];
      if (String(a.date) === parts.date) {
        todayAttendance.push({
          id: a.id,
          sessionId: a.sessionId || activeStudentSession.id,
          sessionName: a.sessionName || activeStudentSession.name,
          studentId: a.studentId,
          studentName: a.nama,
          studentNis: String(a.nis || ''),
          classId: a.classId || '',
          className: a.className || '',
          date: String(a.date),
          timeIn: String(a.timeIn || ''),
          status: a.status,
          method: a.method || 'FACE_SCAN',
          notes: a.notes || '',
          createdAt: a.createdAt || '',
          updatedAt: a.diubah_pada || '',
          diubah_pada: a.diubah_pada || '',
          updatedBy: a.updatedBy || ''
        });
      }
    }
    todayAttendance.sort(function (x, y) { return String(y.timeIn).localeCompare(String(x.timeIn)); });
  }

  var allPermits = readActiveRows_(ss, 'ToiletPermits');
  var activePermits = [];
  var frequentMap = {};
  for (var p = 0; p < allPermits.length; p++) {
    var pr = allPermits[p];
    var rawPType = String(pr.toiletType || '').toUpperCase();
    var pType = rawPType === 'BAB' ? 'BAB' : (rawPType === 'LAINNYA' || rawPType === 'OTHER') ? 'LAINNYA' : 'BAK';
    var pLimit = Number(pr.durationLimitMinutes) ||
      (pType === 'BAB' ? settings.toiletBabMinutes : pType === 'BAK' ? settings.toiletBakMinutes : settings.toiletMaxMinutes);

    var sid = String(pr.studentId || '');
    if (sid) {
      if (!frequentMap[sid]) {
        frequentMap[sid] = {
          studentId: sid,
          studentName: pr.studentName || 'Siswa',
          studentNis: String(pr.studentNis || ''),
          className: pr.className || '',
          totalCount: 0,
          babCount: 0,
          bakCount: 0,
          otherCount: 0,
          exceededCount: 0,
          lastDate: String(pr.date || '')
        };
      }
      frequentMap[sid].totalCount++;
      if (pType === 'BAB') frequentMap[sid].babCount++;
      else if (pType === 'LAINNYA') frequentMap[sid].otherCount++;
      else frequentMap[sid].bakCount++;
      if (Number(pr.durationMinutes || 0) > pLimit) {
        frequentMap[sid].exceededCount++;
      }
      if (String(pr.date || '') > frequentMap[sid].lastDate) {
        frequentMap[sid].lastDate = String(pr.date || '');
      }
    }

    if (String(pr.date) === parts.date && pr.status === 'active') {
      activePermits.push({
        id: pr.id,
        studentId: pr.studentId,
        studentName: pr.studentName,
        studentNis: String(pr.studentNis || ''),
        className: pr.className || '',
        date: String(pr.date),
        timeOut: String(pr.timeOut || ''),
        timeIn: pr.timeIn || '',
        durationMinutes: pr.durationMinutes ? Number(pr.durationMinutes) : undefined,
        toiletType: pType,
        reason: pr.reason || '',
        durationLimitMinutes: pLimit,
        status: pr.status,
        createdAt: pr.createdAt || '',
        updatedAt: pr.diubah_pada || '',
        diubah_pada: pr.diubah_pada || '',
        updatedBy: pr.updatedBy || ''
      });
    }
  }

  var frequentToiletStudents = Object.keys(frequentMap).map(function (k) {
    return frequentMap[k];
  }).sort(function (x, y) {
    if (y.totalCount !== x.totalCount) return y.totalCount - x.totalCount;
    return y.exceededCount - x.exceededCount;
  }).slice(0, 20);

  var users = readActiveRows_(ss, 'Users')
    .filter(function (u) {
      return String(u.role || '').toLowerCase() !== 'superadmin' &&
        String(u.username || '').toLowerCase() !== 'superadmin';
    })
    .map(function (u) {
      return {
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        email: u.email || '',
        classId: u.classId || '',
        nip: String(u.nip || ''),
        isActive: u.isActive === true || String(u.isActive).toLowerCase() === 'true',
        createdAt: u.createdAt || '',
        updatedAt: u.diubah_pada || '',
        diubah_pada: u.diubah_pada || '',
        updatedBy: u.updatedBy || ''
      };
    });

  var logsAll = readActiveRows_(ss, 'Log');
  var recentLogs = logsAll.slice(-100).reverse().map(function (lg) {
    return {
      id: lg.id,
      userId: lg.pengguna || 'system',
      action: lg.aksi || '',
      entity: lg.entitas || '',
      entityId: lg.id_entitas || '',
      details: lg.detail || '',
      createdAt: lg.waktu || lg.diubah_pada || '',
      updatedAt: lg.diubah_pada || '',
      updatedBy: lg.pengguna || 'system'
    };
  });

  var followUpNotes = readActiveRows_(ss, 'FollowUpNotes').map(function (fn) {
    return {
      id: fn.id,
      studentId: fn.studentId,
      studentName: fn.studentName || '',
      studentNis: String(fn.studentNis || ''),
      date: String(fn.date || ''),
      category: fn.category || 'Lainnya',
      notes: fn.notes || '',
      actionPlan: fn.actionPlan || '',
      status: fn.status || 'Open',
      counselorId: fn.counselorId || '',
      createdAt: fn.createdAt || '',
      updatedAt: fn.diubah_pada || '',
      diubah_pada: fn.diubah_pada || '',
      updatedBy: fn.updatedBy || ''
    };
  }).reverse();

  return {
    success: true,
    hasChanges: true,
    serverVersion: serverVersion,
    serverTime: parts.iso,
    serverDate: parts.date,
    serverHhmm: parts.hhmm,
    activeUsers: activeUsers,
    settings: settings,
    sessions: sessions,
    activeStudentSession: activeStudentSession,
    activeTeacherSession: activeTeacherSession,
    faceTemplates: faceTemplates,
    classes: classes,
    students: students,
    teachers: teachers,
    locations: locations,
    todayAttendance: todayAttendance,
    activePermits: activePermits,
    frequentToiletStudents: frequentToiletStudents,
    users: users,
    auditLogs: recentLogs,
    followUpNotes: followUpNotes
  };
}

// ============================================================================
// AUTH HANDLERS
// ============================================================================

function resolveTeacherProfileForUser_(ss, u) {
  if (!u) return null;
  var teachers = readActiveRows_(ss, 'Teachers');
  var uNip = String(u.nip || '').trim();
  var uEmail = String(u.email || '').trim().toLowerCase();
  var uName = String(u.name || '').trim().toLowerCase();
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    if (
      (uNip && String(t.nip || '').trim() === uNip) ||
      (uEmail && String(t.email || '').trim().toLowerCase() === uEmail) ||
      (uName && String(t.name || '').trim().toLowerCase() === uName)
    ) {
      return t;
    }
  }
  return null;
}

function handleLogin_(ss, payload) {
  var username = String(payload.username || '').trim().toLowerCase();
  var password = String(payload.password || '');
  if (!username || !password) {
    return { success: false, mutated: false, error: 'Username dan password wajib diisi.' };
  }

  var users = readActiveRows_(ss, 'Users');
  var found = null;
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username || '').trim().toLowerCase() === username) {
      found = users[i];
      break;
    }
  }

  if (!found) {
    return { success: false, mutated: false, error: 'Username atau password salah.' };
  }
  var active = found.isActive === true || String(found.isActive).toLowerCase() === 'true';
  if (!active) {
    return { success: false, mutated: false, error: 'Akun ini sedang dinonaktifkan oleh admin.' };
  }

  var expectedHash = hashPassword_(password);
  if (String(found.passwordHash || '') !== expectedHash) {
    return { success: false, mutated: false, error: 'Username atau password salah.' };
  }

  var teacherMatch = resolveTeacherProfileForUser_(ss, found);
  writeAuditLog_(ss, found.username, 'LOGIN', 'Users', found.id, 'Login berhasil (' + found.role + ')');

  return {
    success: true,
    mutated: false,
    user: {
      id: found.id,
      username: found.username,
      name: found.name,
      role: found.role,
      email: found.email || '',
      classId: found.classId || '',
      nip: String(found.nip || (teacherMatch ? teacherMatch.nip : '') || ''),
      teacherId: teacherMatch ? teacherMatch.id : '',
      subject: teacherMatch ? (teacherMatch.subject || '') : ''
    }
  };
}

function handleGetUserById_(ss, userId) {
  var users = readActiveRows_(ss, 'Users');
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].id) === String(userId)) {
      var u = users[i];
      var active = u.isActive === true || String(u.isActive).toLowerCase() === 'true';
      if (!active) break;
      var teacherMatch = resolveTeacherProfileForUser_(ss, u);
      return {
        success: true,
        mutated: false,
        user: {
          id: u.id,
          username: u.username,
          name: u.name,
          role: u.role,
          email: u.email || '',
          classId: u.classId || '',
          nip: String(u.nip || (teacherMatch ? teacherMatch.nip : '') || ''),
          teacherId: teacherMatch ? teacherMatch.id : '',
          subject: teacherMatch ? (teacherMatch.subject || '') : ''
        }
      };
    }
  }
  return { success: false, mutated: false, error: 'Sesi pengguna tidak ditemukan atau nonaktif.' };
}

// ============================================================================
// ATTENDANCE HANDLERS (Server Time, Duplicate Check, Batch 3s, No Photo)
// ============================================================================

function handleBatchStudentAttendance_(ss, scans, actor) {
  if (!Array.isArray(scans) || scans.length === 0) {
    return { success: false, mutated: false, error: 'Daftar scan kosong.' };
  }

  var parts = nowWibParts_();
  var students = readActiveRows_(ss, 'Students');
  var classes = readActiveRows_(ss, 'Classes');

  var studentById = {};
  var studentByCode = {};
  for (var i = 0; i < students.length; i++) {
    var st = students[i];
    studentById[String(st.id)] = st;
    if (st.barcodeCard) studentByCode[String(st.barcodeCard).trim().toLowerCase()] = st;
    if (st.nis) studentByCode[String(st.nis).trim().toLowerCase()] = st;
  }

  var classMap = {};
  for (var c = 0; c < classes.length; c++) {
    classMap[String(classes[c].id)] = classes[c].name;
  }

  var sessionStateCache = {};
  function getSessionContext(requestedSessionId) {
    var ses = resolveSessionForAttendance_(ss, 'student', requestedSessionId, parts.hhmm, false);
    if (!ses) return null;
    if (sessionStateCache[ses.id]) return sessionStateCache[ses.id];

    var sheet = ensureSessionSheet_(ss, ses);
    var attRows = readActiveRows_(ss, ses.sheetName);
    var alreadyToday = {};
    var seenClientScanIds = {};
    for (var a = 0; a < attRows.length; a++) {
      if (attRows[a].clientScanId) {
        seenClientScanIds[String(attRows[a].clientScanId)] = attRows[a];
      }
      if (String(attRows[a].date) === parts.date) {
        alreadyToday[String(attRows[a].studentId)] = attRows[a];
      }
    }
    sessionStateCache[ses.id] = {
      session: ses,
      sheet: sheet,
      alreadyToday: alreadyToday,
      seenClientScanIds: seenClientScanIds
    };
    return sessionStateCache[ses.id];
  }

  var results = [];
  var addedCount = 0;

  for (var k = 0; k < scans.length; k++) {
    var item = scans[k] || {};
    var cScanId = String(item.clientScanId || '');
    var sesCtx = getSessionContext(item.sessionId);

    if (!sesCtx) {
      results.push({
        clientScanId: cScanId,
        success: false,
        outsideSession: true,
        error: 'Di luar jam sesi presensi siswa (' + parts.hhmm + ' WIB). Tidak ada sesi siswa yang sedang aktif.'
      });
      continue;
    }

    var targetSes = sesCtx.session;
    var cutoff = targetSes.lateCutoffTime || '07:15';

    if (cScanId && sesCtx.seenClientScanIds[cScanId]) {
      var prevRec = sesCtx.seenClientScanIds[cScanId];
      results.push({
        clientScanId: cScanId,
        success: true,
        deduped: true,
        studentName: prevRec.nama,
        attendance: {
          id: prevRec.id,
          sessionId: prevRec.sessionId || targetSes.id,
          sessionName: prevRec.sessionName || targetSes.name,
          studentId: prevRec.studentId,
          studentName: prevRec.nama,
          studentNis: String(prevRec.nis || ''),
          classId: prevRec.classId || '',
          className: prevRec.className || '',
          date: String(prevRec.date || ''),
          timeIn: String(prevRec.timeIn || ''),
          status: prevRec.status || 'Hadir',
          method: prevRec.method || 'FACE_SCAN'
        },
        message: prevRec.nama + ' sudah tercatat pada ' + targetSes.name + '.'
      });
      continue;
    }

    var student = null;
    if (item.studentId && studentById[String(item.studentId)]) {
      student = studentById[String(item.studentId)];
    } else if (item.barcodeCard) {
      student = studentByCode[String(item.barcodeCard).trim().toLowerCase()];
    }

    if (!student) {
      results.push({
        clientScanId: cScanId,
        success: false,
        error: 'Siswa atau kartu tidak ditemukan.'
      });
      continue;
    }

    var studentIsActive = student.isActive === true || String(student.isActive).toLowerCase() === 'true' || student.isActive === '';
    if (!studentIsActive) {
      results.push({
        clientScanId: cScanId,
        success: false,
        studentName: student.name,
        error: 'Siswa ' + student.name + ' berstatus nonaktif/alumni.'
      });
      continue;
    }

    if (sesCtx.alreadyToday[String(student.id)]) {
      results.push({
        clientScanId: cScanId,
        success: false,
        duplicate: true,
        studentName: student.name,
        error: student.name + ' sudah melakukan presensi ' + targetSes.name + ' hari ini (' + sesCtx.alreadyToday[String(student.id)].timeIn + ' WIB).'
      });
      continue;
    }

    var attStatus = parts.hhmm > cutoff ? 'Terlambat' : 'Hadir';
    var clsName = classMap[String(student.classId)] || '';
    var newId = generateId_('satt');

    var record = {
      id: newId,
      sessionId: targetSes.id,
      sessionName: targetSes.name,
      studentId: student.id,
      nis: String(student.nis || ''),
      nama: student.name,
      classId: student.classId || '',
      className: clsName,
      date: parts.date,
      timeIn: parts.time,
      status: attStatus,
      method: item.method || 'FACE_SCAN',
      notes: item.notes || '',
      clientScanId: item.clientScanId || '',
      createdAt: parts.iso,
      diubah_pada: parts.iso,
      updatedBy: actor || 'kiosk'
    };

    appendObjectRow_(sesCtx.sheet, targetSes.sheetName, record);
    sesCtx.alreadyToday[String(student.id)] = record;
    addedCount++;

    results.push({
      clientScanId: item.clientScanId || '',
      success: true,
      student: {
        id: student.id,
        nis: student.nis,
        name: student.name,
        classId: student.classId,
        className: clsName
      },
      attendance: {
        id: record.id,
        sessionId: targetSes.id,
        sessionName: targetSes.name,
        studentId: record.studentId,
        studentName: record.nama,
        studentNis: record.nis,
        classId: record.classId,
        className: record.className,
        date: record.date,
        timeIn: record.timeIn,
        status: record.status,
        method: record.method
      },
      message: student.name + ' berhasil presensi ' + targetSes.name + ' (' + attStatus + ')'
    });
  }

  if (addedCount > 0) {
    writeAuditLog_(ss, actor || 'kiosk', 'BATCH_ATTENDANCE', 'Sessions', parts.date, 'Presensi batch ' + addedCount + ' siswa ke sheet sesi');
  }

  return {
    success: true,
    mutated: addedCount > 0,
    serverDate: parts.date,
    serverTime: parts.time,
    addedCount: addedCount,
    results: results
  };
}

function handleManualStudentAttendance_(ss, payload, actor) {
  var studentId = String(payload.studentId || '');
  var targetStatus = String(payload.status || 'Hadir');
  var notes = String(payload.notes || '');
  var parts = nowWibParts_();
  var targetDate = String(payload.date || parts.date);

  var targetSession = resolveSessionForAttendance_(ss, 'student', payload.sessionId, parts.hhmm, true);
  if (!targetSession) {
    return { success: false, mutated: false, error: 'Belum ada sesi presensi siswa yang aktif diatur di menu Admin.' };
  }

  var students = readActiveRows_(ss, 'Students');
  var classes = readActiveRows_(ss, 'Classes');
  var student = null;
  for (var i = 0; i < students.length; i++) {
    if (String(students[i].id) === studentId) { student = students[i]; break; }
  }
  if (!student) return { success: false, mutated: false, error: 'Siswa tidak ditemukan.' };

  var clsName = '';
  for (var c = 0; c < classes.length; c++) {
    if (String(classes[c].id) === String(student.classId)) { clsName = classes[c].name; break; }
  }

  var attSheet = ensureSessionSheet_(ss, targetSession);
  var existingRows = readActiveRows_(ss, targetSession.sheetName);
  var existing = null;
  for (var a = 0; a < existingRows.length; a++) {
    if (String(existingRows[a].studentId) === studentId && String(existingRows[a].date) === targetDate) {
      existing = existingRows[a];
      break;
    }
  }

  if (existing) {
    var upd = updateRowCellsById_(attSheet, targetSession.sheetName, existing.id, {
      status: targetStatus,
      notes: notes || existing.notes || '',
      method: 'MANUAL',
      updatedBy: actor
    }, payload.expectedUpdatedAt);
    if (!upd.success) return { success: false, mutated: false, conflict: upd.conflict, error: upd.error };
    writeAuditLog_(ss, actor, 'UPDATE', targetSession.sheetName, existing.id, 'Koreksi status ' + student.name + ' (' + targetSession.name + ') -> ' + targetStatus);
    return { success: true, message: 'Status presensi ' + student.name + ' (' + targetSession.name + ') diperbarui menjadi ' + targetStatus };
  }

  var newId = generateId_('satt');
  appendObjectRow_(attSheet, targetSession.sheetName, {
    id: newId,
    sessionId: targetSession.id,
    sessionName: targetSession.name,
    studentId: student.id,
    nis: String(student.nis || ''),
    nama: student.name,
    classId: student.classId || '',
    className: clsName,
    date: targetDate,
    timeIn: parts.time,
    status: targetStatus,
    method: 'MANUAL',
    notes: notes,
    clientScanId: '',
    createdAt: parts.iso,
    diubah_pada: parts.iso,
    updatedBy: actor
  });

  writeAuditLog_(ss, actor, 'CREATE', targetSession.sheetName, newId, 'Presensi manual ' + student.name + ' (' + targetSession.name + ': ' + targetStatus + ')');
  return { success: true, message: 'Presensi manual ' + student.name + ' pada ' + targetSession.name + ' tersimpan.' };
}

function handleTeacherAttendance_(ss, payload, actor) {
  var actionType = String(payload.actionType || 'checkIn'); // checkIn | checkOut | permit
  var parts = nowWibParts_();

  var targetSession = resolveSessionForAttendance_(ss, 'teacher', payload.sessionId, parts.hhmm, false);
  if (!targetSession) {
    return {
      success: false,
      mutated: false,
      outsideSession: true,
      error: 'Saat ini (' + parts.hhmm + ' WIB) di luar jam sesi presensi guru yang aktif. Silakan cek jadwal sesi guru di menu Admin.'
    };
  }

  var cutoff = targetSession.lateCutoffTime || '07:15';

  // Resolve teacher record by teacherId, email, nip, or name
  var teachers = readActiveRows_(ss, 'Teachers');
  var teacher = null;
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    if (
      (payload.teacherId && String(t.id) === String(payload.teacherId)) ||
      (payload.teacherEmail && String(t.email || '').toLowerCase() === String(payload.teacherEmail).toLowerCase()) ||
      (payload.teacherNip && String(t.nip || '') === String(payload.teacherNip)) ||
      (payload.teacherName && String(t.name || '').toLowerCase() === String(payload.teacherName).toLowerCase())
    ) {
      teacher = t;
      break;
    }
  }

  var teacherId = teacher ? teacher.id : String(payload.teacherId || payload.userId || actor);
  var teacherName = teacher ? teacher.name : String(payload.teacherName || actor);
  var teacherNip = teacher ? String(teacher.nip || '') : String(payload.teacherNip || '');
  var teacherSubject = teacher ? String(teacher.subject || '') : '';

  var attSheet = ensureSessionSheet_(ss, targetSession);
  var existingRows = readActiveRows_(ss, targetSession.sheetName);
  var todayRow = null;
  for (var r = 0; r < existingRows.length; r++) {
    if (String(existingRows[r].teacherId) === String(teacherId) && String(existingRows[r].date) === parts.date) {
      todayRow = existingRows[r];
      break;
    }
  }

  if (actionType === 'checkIn') {
    if (todayRow) {
      return {
        success: false,
        mutated: false,
        error: 'Presensi masuk ' + targetSession.name + ' hari ini sudah tercatat pada ' + todayRow.timeIn + ' WIB (' + todayRow.status + '). Tidak dapat presensi ganda di sesi yang sama.'
      };
    }

    // Optional GPS validation if coordinates & active locations exist
    var distanceMeters = payload.distanceMeters !== undefined ? Number(payload.distanceMeters) : '';
    var lat = payload.latitude !== undefined ? Number(payload.latitude) : '';
    var lng = payload.longitude !== undefined ? Number(payload.longitude) : '';

    var locations = readActiveRows_(ss, 'Locations').filter(function (l) {
      return l.isActive === true || String(l.isActive).toLowerCase() === 'true';
    });
    if (locations.length > 0 && lat !== '' && lng !== '') {
      var minD = Infinity;
      var bestLoc = null;
      for (var li = 0; li < locations.length; li++) {
        var d = haversineMeters_(lat, lng, Number(locations[li].latitude), Number(locations[li].longitude));
        if (d < minD) { minD = d; bestLoc = locations[li]; }
      }
      distanceMeters = Math.round(minD);
      if (bestLoc && distanceMeters > Number(bestLoc.radiusMeters || 150)) {
        return {
          success: false,
          mutated: false,
          error: 'Di luar radius sekolah (' + distanceMeters + 'm dari ' + bestLoc.name + ', batas ' + bestLoc.radiusMeters + 'm).'
        };
      }
    }

    var status = parts.hhmm > cutoff ? 'Terlambat' : 'Tepat Waktu';
    var newId = generateId_('tatt');
    var rowObj = {
      id: newId,
      sessionId: targetSession.id,
      sessionName: targetSession.name,
      teacherId: teacherId,
      nama: teacherName,
      nip: teacherNip,
      subject: teacherSubject,
      date: parts.date,
      timeIn: parts.time,
      timeOut: '',
      status: status,
      method: payload.faceVerified ? 'FACE_SCAN' : 'MANUAL',
      latitude: lat,
      longitude: lng,
      distanceMeters: distanceMeters,
      notes: String(payload.notes || ''),
      createdAt: parts.iso,
      diubah_pada: parts.iso,
      updatedBy: actor
    };

    appendObjectRow_(attSheet, targetSession.sheetName, rowObj);
    writeAuditLog_(ss, actor, 'TEACHER_CHECKIN', targetSession.sheetName, newId, teacherName + ' (NIP: ' + (teacherNip || '-') + ') masuk ' + targetSession.name + ' ' + parts.time + ' (' + status + ')');

    return {
      success: true,
      message: 'Presensi masuk ' + targetSession.name + ' berhasil dicatat pada ' + parts.time + ' WIB (' + status + ').',
      attendance: {
        id: rowObj.id,
        sessionId: targetSession.id,
        sessionName: targetSession.name,
        teacherId: rowObj.teacherId,
        teacherName: rowObj.nama,
        nip: rowObj.nip,
        subject: rowObj.subject,
        date: rowObj.date,
        timeIn: rowObj.timeIn,
        status: rowObj.status,
        method: rowObj.method
      }
    };
  }

  if (actionType === 'checkOut') {
    if (!todayRow) {
      return { success: false, mutated: false, error: 'Anda belum melakukan presensi masuk pada ' + targetSession.name + ' hari ini.' };
    }
    if (todayRow.status === 'Izin' || todayRow.status === 'Sakit') {
      return { success: false, mutated: false, error: 'Anda tercatat ' + todayRow.status + ' pada ' + targetSession.name + ', tidak perlu presensi pulang.' };
    }
    if (todayRow.timeOut) {
      return { success: false, mutated: false, error: 'Presensi pulang ' + targetSession.name + ' sudah tercatat pada ' + todayRow.timeOut + ' WIB.' };
    }

    var updOut = updateRowCellsById_(attSheet, targetSession.sheetName, todayRow.id, {
      timeOut: parts.time,
      updatedBy: actor
    });
    if (!updOut.success) return { success: false, mutated: false, error: updOut.error };

    writeAuditLog_(ss, actor, 'TEACHER_CHECKOUT', targetSession.sheetName, todayRow.id, teacherName + ' (NIP: ' + (teacherNip || '-') + ') pulang ' + targetSession.name + ' ' + parts.time);
    return {
      success: true,
      message: 'Presensi pulang ' + targetSession.name + ' berhasil dicatat pada ' + parts.time + ' WIB.'
    };
  }

  if (actionType === 'permit') {
    if (todayRow) {
      return { success: false, mutated: false, error: 'Presensi ' + targetSession.name + ' hari ini sudah tercatat (' + todayRow.status + '). Tidak dapat mengajukan izin ganda di sesi ini.' };
    }
    var permitType = payload.permitType === 'Sakit' ? 'Sakit' : 'Izin';
    var pId = generateId_('tatt');
    appendObjectRow_(attSheet, targetSession.sheetName, {
      id: pId,
      sessionId: targetSession.id,
      sessionName: targetSession.name,
      teacherId: teacherId,
      nama: teacherName,
      nip: teacherNip,
      subject: teacherSubject,
      date: parts.date,
      timeIn: parts.time,
      timeOut: '',
      status: permitType,
      method: 'MANUAL',
      latitude: '',
      longitude: '',
      distanceMeters: '',
      notes: String(payload.notes || ''),
      createdAt: parts.iso,
      diubah_pada: parts.iso,
      updatedBy: actor
    });

    writeAuditLog_(ss, actor, 'TEACHER_PERMIT', targetSession.sheetName, pId, teacherName + ' mengajukan ' + permitType + ' pada ' + targetSession.name);
    return {
      success: true,
      message: 'Pengajuan ' + permitType + ' (' + targetSession.name + ') berhasil disimpan.'
    };
  }

  return { success: false, mutated: false, error: 'actionType guru tidak dikenal.' };
}

function haversineMeters_(lat1, lon1, lat2, lon2) {
  var R = 6371e3;
  var toRad = function (deg) { return deg * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================================
// TOILET PERMIT HANDLERS
// ============================================================================

function handleToiletStart_(ss, payload, actor) {
  var studentId = String(payload.studentId || '');
  var parts = nowWibParts_();
  var students = readActiveRows_(ss, 'Students');
  var classes = readActiveRows_(ss, 'Classes');

  var settingsRows = readActiveRows_(ss, 'Settings');
  var settings = settingsRows.length > 0 ? formatSettingsRow_(settingsRows[0]) : formatSettingsRow_({});
  var rawType = String(payload.toiletType || 'BAK').toUpperCase();
  var toiletType = rawType === 'BAB' ? 'BAB' : (rawType === 'LAINNYA' || rawType === 'OTHER') ? 'LAINNYA' : 'BAK';
  var reason = String(payload.reason || '').trim();
  var limitMinutes = toiletType === 'BAB'
    ? (settings.toiletBabMinutes || 10)
    : toiletType === 'BAK'
      ? (settings.toiletBakMinutes || 5)
      : (settings.toiletMaxMinutes || 10);

  var student = null;
  for (var i = 0; i < students.length; i++) {
    if (String(students[i].id) === studentId) { student = students[i]; break; }
  }
  if (!student) return { success: false, mutated: false, error: 'Siswa tidak ditemukan.' };

  var clsName = '';
  for (var c = 0; c < classes.length; c++) {
    if (String(classes[c].id) === String(student.classId)) { clsName = classes[c].name; break; }
  }

  var activePermits = readActiveRows_(ss, 'ToiletPermits');
  for (var p = 0; p < activePermits.length; p++) {
    if (String(activePermits[p].studentId) === studentId && String(activePermits[p].date) === parts.date && activePermits[p].status === 'active') {
      return { success: false, mutated: false, error: student.name + ' masih memiliki izin keluar kelas yang aktif.' };
    }
  }

  var id = generateId_('tlt');
  var sheet = ss.getSheetByName('ToiletPermits');
  var permit = {
    id: id,
    studentId: student.id,
    studentName: student.name,
    studentNis: String(student.nis || ''),
    className: clsName,
    date: parts.date,
    timeOut: parts.time,
    timeIn: '',
    durationMinutes: '',
    toiletType: toiletType,
    reason: reason,
    durationLimitMinutes: limitMinutes,
    status: 'active',
    createdAt: parts.iso,
    diubah_pada: parts.iso,
    updatedBy: actor || 'kiosk'
  };
  appendObjectRow_(sheet, 'ToiletPermits', permit);
  var typeLabel = toiletType === 'LAINNYA' && reason ? ('Izin Lainnya (' + reason + ')') : toiletType;
  writeAuditLog_(ss, actor || 'kiosk', 'TOILET_START', 'ToiletPermits', id, student.name + ' ' + typeLabel + ' (maks ' + limitMinutes + 'm) pukul ' + parts.time);

  return { success: true, permit: permit, message: student.name + ' tercatat izin ' + typeLabel + ' (' + limitMinutes + ' menit).' };
}

function handleToiletReturn_(ss, payload, actor) {
  var permitId = String(payload.permitId || '');
  if (!permitId) return { success: false, mutated: false, error: 'Parameter permitId wajib diisi.' };
  var parts = nowWibParts_();
  var sheet = ss.getSheetByName('ToiletPermits');
  var rows = readActiveRows_(ss, 'ToiletPermits');
  var target = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === permitId) { target = rows[i]; break; }
  }
  if (!target) return { success: false, mutated: false, error: 'Data izin toilet tidak ditemukan.' };
  if (String(target.status || '').toLowerCase() === 'returned') {
    return {
      success: true,
      mutated: false,
      alreadyReturned: true,
      durationMinutes: Number(target.durationMinutes || 1),
      message: target.studentName + ' sudah tercatat kembali pada ' + (target.timeIn || '-') + '.'
    };
  }

  var settingsRows = readActiveRows_(ss, 'Settings');
  var settings = settingsRows.length > 0 ? formatSettingsRow_(settingsRows[0]) : formatSettingsRow_({});
  var tType = String(target.toiletType || '').toUpperCase();
  var maxMin = Number(target.durationLimitMinutes) ||
    (tType === 'BAB' ? settings.toiletBabMinutes : tType === 'BAK' ? settings.toiletBakMinutes : settings.toiletMaxMinutes) ||
    10;

  var durMin = 1;
  var computedFromIso = false;
  if (target.createdAt) {
    var startedMs = Date.parse(String(target.createdAt));
    if (!isNaN(startedMs)) {
      durMin = Math.max(1, Math.round((Date.now() - startedMs) / 60000));
      computedFromIso = true;
    }
  }
  if (!computedFromIso) {
    try {
      var outParts = String(target.timeOut || '00:00:00').split(':').map(Number);
      var inParts = String(parts.time).split(':').map(Number);
      var secDiff = (inParts[0] * 3600 + inParts[1] * 60 + (inParts[2] || 0)) - (outParts[0] * 3600 + outParts[1] * 60 + (outParts[2] || 0));
      durMin = Math.max(1, Math.round(secDiff / 60));
    } catch (e) {}
  }

  var upd = updateRowCellsById_(sheet, 'ToiletPermits', permitId, {
    timeIn: parts.time,
    durationMinutes: durMin,
    status: 'returned',
    updatedBy: actor || 'kiosk'
  });
  if (!upd.success) return { success: false, mutated: false, error: upd.error };

  var exceeded = durMin > maxMin;
  writeAuditLog_(ss, actor || 'kiosk', 'TOILET_RETURN', 'ToiletPermits', permitId, target.studentName + ' kembali (' + durMin + ' menit / batas ' + maxMin + 'm)');
  return {
    success: true,
    exceeded: exceeded,
    durationMinutes: durMin,
    message: target.studentName + ' kembali ke kelas (' + durMin + ' menit).' + (exceeded ? ' Melebihi batas ' + maxMin + ' menit!' : '')
  };
}

// ============================================================================
// FACE DATABASE & PRIVATE DRIVE PHOTO ENDPOINTS
// ============================================================================

function handleSaveFaceTemplate_(ss, payload, actor) {
  var personId = String(payload.personId || '');
  var personType = String(payload.personType || 'student');
  var descriptor = payload.descriptor;
  if (!personId || !Array.isArray(descriptor) || descriptor.length === 0) {
    return { success: false, mutated: false, error: 'Data personId dan descriptor wajah wajib diisi.' };
  }

  var parts = nowWibParts_();
  var sheet = ss.getSheetByName('FaceTemplates');
  var existing = readActiveRows_(ss, 'FaceTemplates');
  var found = null;
  for (var i = 0; i < existing.length; i++) {
    if (String(existing[i].personId) === personId && String(existing[i].personType || 'student') === personType) {
      found = existing[i];
      break;
    }
  }

  var descJson = JSON.stringify(descriptor);
  if (found) {
    var upd = updateRowCellsById_(sheet, 'FaceTemplates', found.id, {
      descriptorJson: descJson,
      photoFileId: payload.photoFileId !== undefined ? String(payload.photoFileId) : found.photoFileId,
      updatedBy: actor
    });
    if (!upd.success) return { success: false, mutated: false, error: upd.error };
    writeAuditLog_(ss, actor, 'UPDATE', 'FaceTemplates', found.id, 'Perbarui vektor wajah ' + personType + ' ' + personId);
    return { success: true, id: found.id, message: 'Template wajah diperbarui.' };
  }

  var newId = generateId_('face');
  appendObjectRow_(sheet, 'FaceTemplates', {
    id: newId,
    personId: personId,
    personType: personType,
    descriptorJson: descJson,
    photoFileId: payload.photoFileId ? String(payload.photoFileId) : '',
    status: 'aktif',
    createdAt: parts.iso,
    diubah_pada: parts.iso,
    updatedBy: actor
  });
  writeAuditLog_(ss, actor, 'CREATE', 'FaceTemplates', newId, 'Daftar wajah baru ' + personType + ' ' + personId);
  return { success: true, id: newId, message: 'Template wajah tersimpan.' };
}

function handleUploadPhoto_(ss, payload, actor) {
  var driveRes = ensureDriveFolders_(true);
  if (!driveRes.ok) {
    return { success: false, mutated: false, error: driveRes.error };
  }

  var base64Input = String(payload.base64Data || payload.dataUrl || '');
  if (!base64Input) {
    return { success: false, mutated: false, error: 'Data gambar base64 kosong.' };
  }

  var mimeType = String(payload.mimeType || 'image/jpeg');
  var cleanBase64 = base64Input;
  var dataUrlMatch = base64Input.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    cleanBase64 = dataUrlMatch[2];
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(cleanBase64);
  } catch (decodeErr) {
    return { success: false, mutated: false, error: 'Format base64 foto tidak valid.' };
  }

  var ext = 'jpg';
  if (mimeType.indexOf('png') >= 0) ext = 'png';
  else if (mimeType.indexOf('webp') >= 0) ext = 'webp';
  else if (mimeType.indexOf('svg') >= 0) ext = 'svg';
  else if (mimeType.indexOf('gif') >= 0) ext = 'gif';

  var purpose = String(payload.purpose || 'face').toLowerCase();
  var isCardOrSchoolAsset =
    purpose === 'card_asset' ||
    purpose === 'school_logo' ||
    purpose === 'logo' ||
    purpose === 'signature' ||
    purpose === 'stamp' ||
    purpose === 'watermark' ||
    purpose === 'qr' ||
    purpose === 'foundation_watermark' ||
    purpose === 'foundation_qr' ||
    (!payload.personId && !payload.targetId && purpose !== 'face');

  var targetType = String(payload.targetType || 'student');
  var personType = String(payload.personType || (targetType === 'teacher' ? 'teacher' : 'student'));
  var targetId = String(payload.personId || payload.targetId || '');

  var targetFolder = driveRes.studentFaceFolder;
  var neatBaseName = '';
  var previousFileId = extractDriveFileIdFromRef_(payload.previousFileId || payload.previousUrl || '') || String(payload.previousFileId || '');
  var trashPreviousExplicit = payload.trashPrevious === true;

  if (isCardOrSchoolAsset) {
    targetFolder = driveRes.cardAssetsFolder;
  } else if (personType === 'teacher' && targetId) {
    targetFolder = driveRes.teacherFaceFolder;
    var teachers = readActiveRows_(ss, 'Teachers');
    var teacherObj = null;
    for (var ti = 0; ti < teachers.length; ti++) {
      if (String(teachers[ti].id) === targetId) {
        teacherObj = teachers[ti];
        break;
      }
    }
    if (teacherObj) {
      var tNip = sanitizeDriveName_(teacherObj.nip || '') || 'TanpaNIP';
      var tName = sanitizeDriveName_(teacherObj.name || 'Guru');
      neatBaseName = tNip + ' - ' + tName + ' - Wajah';
    }
  } else if (targetId) {
    targetFolder = purpose === 'card' ? driveRes.cardPhotoFolder : driveRes.studentFaceFolder;
    var students = readActiveRows_(ss, 'Students');
    var studentObj = null;
    for (var si = 0; si < students.length; si++) {
      if (String(students[si].id) === targetId) {
        studentObj = students[si];
        break;
      }
    }
    if (studentObj) {
      if (!previousFileId) previousFileId = String(studentObj.photoFileId || '');
      var classes = readActiveRows_(ss, 'Classes');
      var clsName = '';
      for (var ci = 0; ci < classes.length; ci++) {
        if (String(classes[ci].id) === String(studentObj.classId)) {
          clsName = classes[ci].name;
          break;
        }
      }
      var sClass = sanitizeDriveName_(clsName || studentObj.level || 'Siswa');
      var sNis = sanitizeDriveName_(studentObj.nis || '') || 'TanpaNIS';
      var sName = sanitizeDriveName_(studentObj.name || 'Siswa');
      neatBaseName = sClass + ' - ' + sNis + ' - ' + sName + (purpose === 'card' ? ' - Foto' : ' - Wajah');
    }
  }

  // Fallback check on FaceTemplates for previous photoFileId to replace cleanly
  if (!isCardOrSchoolAsset && targetId) {
    var faceRows = readActiveRows_(ss, 'FaceTemplates');
    for (var fi = 0; fi < faceRows.length; fi++) {
      if (String(faceRows[fi].personId) === targetId && String(faceRows[fi].personType || 'student') === personType) {
        if (faceRows[fi].photoFileId) {
          previousFileId = String(faceRows[fi].photoFileId);
        }
        break;
      }
    }
  }

  var safeRawFileName = sanitizeDriveName_(String(payload.fileName || '').replace(/\.(jpg|jpeg|png|webp|svg|gif)$/i, ''));
  var defaultAssetName = (isCardOrSchoolAsset ? ('Aset_' + purpose + '_' + Date.now()) : ('Wajah_' + (targetId || Date.now())));
  var finalFileName = (neatBaseName || safeRawFileName || defaultAssetName) + (isCardOrSchoolAsset ? ('_' + String(Date.now()).slice(-6)) : '') + '.' + ext;

  // Trash duplicate exact-name files for student/teacher face photos
  if (!isCardOrSchoolAsset) {
    try {
      var sameNameFiles = targetFolder.getFilesByName(finalFileName);
      while (sameNameFiles.hasNext()) {
        sameNameFiles.next().setTrashed(true);
      }
    } catch (dupErr) {}
  }

  // Trash previous photo version if replacing a student/teacher photo or explicit draft asset
  if (previousFileId && (!isCardOrSchoolAsset || trashPreviousExplicit)) {
    trashDriveFileSafely_(previousFileId);
  }

  var blob = Utilities.newBlob(bytes, mimeType, finalFileName);
  var file = targetFolder.createFile(blob);
  var fileId = file.getId();

  if (!isCardOrSchoolAsset && personType === 'student' && targetId) {
    var stdSheet = ss.getSheetByName('Students');
    updateRowCellsById_(stdSheet, 'Students', targetId, {
      photoFileId: fileId,
      photoUrl: 'gas-photo://' + fileId,
      updatedBy: actor
    });
  }

  if (!isCardOrSchoolAsset && targetId) {
    var faceSheet = ss.getSheetByName('FaceTemplates');
    var allFaces = readActiveRows_(ss, 'FaceTemplates');
    for (var fIdx = 0; fIdx < allFaces.length; fIdx++) {
      if (String(allFaces[fIdx].personId) === targetId && String(allFaces[fIdx].personType || 'student') === personType) {
        updateRowCellsById_(faceSheet, 'FaceTemplates', allFaces[fIdx].id, {
          photoFileId: fileId,
          updatedBy: actor
        });
        break;
      }
    }
  }

  writeAuditLog_(
    ss,
    actor,
    isCardOrSchoolAsset ? 'UPLOAD_ASSET' : 'UPLOAD_PHOTO',
    isCardOrSchoolAsset ? 'Settings' : (personType === 'student' ? 'Students' : 'Teachers'),
    targetId || fileId,
    'Simpan gambar ke Drive "' + targetFolder.getName() + '/' + finalFileName + '" (ID: ' + fileId + ')'
  );

  return {
    success: true,
    fileId: fileId,
    fileName: finalFileName,
    folderName: targetFolder.getName(),
    photoUrl: 'gas-photo://' + fileId,
    message: 'Gambar "' + finalFileName + '" berhasil disimpan ke folder Drive "' + targetFolder.getName() + '".'
  };
}

function handleDeletePhoto_(ss, payload, actor) {
  var targetFileId = extractDriveFileIdFromRef_(payload.fileId || payload.photoUrl || '') || String(payload.fileId || '').trim();
  if (!targetFileId) {
    return { success: false, mutated: false, error: 'Parameter fileId atau URL foto Drive wajib diisi.' };
  }
  var trashed = trashDriveFileSafely_(targetFileId);

  if (payload.entity && payload.id && payload.field && SHEET_SCHEMAS[payload.entity]) {
    var sheet = ss.getSheetByName(String(payload.entity));
    if (sheet) {
      var patch = { updatedBy: actor };
      patch[String(payload.field)] = '';
      if (payload.entity === 'Students' && String(payload.field) === 'photoUrl') {
        patch.photoFileId = '';
      }
      updateRowCellsById_(sheet, String(payload.entity), String(payload.id), patch, null);
    }
  }

  writeAuditLog_(ss, actor, 'DELETE_PHOTO', String(payload.entity || 'Drive'), targetFileId, 'Hapus file gambar dari Google Drive (ID: ' + targetFileId + ')');
  return {
    success: true,
    mutated: true,
    deletedFileId: targetFileId,
    trashed: trashed,
    message: 'Gambar berhasil dihapus dari Google Drive.'
  };
}

function handleGetPhoto_(fileId) {
  var cleanId = extractDriveFileIdFromRef_(fileId) || String(fileId || '').trim();
  if (!cleanId) {
    return { success: false, error: 'Parameter fileId wajib diisi.' };
  }
  try {
    var file = DriveApp.getFileById(cleanId);
    if (file.isTrashed()) {
      return { success: false, error: 'File foto sudah dihapus.' };
    }
    var blob = file.getBlob();
    var mimeType = blob.getContentType() || 'image/jpeg';
    var b64 = Utilities.base64Encode(blob.getBytes());
    return {
      success: true,
      fileId: file.getId(),
      mimeType: mimeType,
      dataUrl: 'data:' + mimeType + ';base64,' + b64
    };
  } catch (e) {
    return { success: false, error: 'Gagal mengambil foto dari Drive: ' + e.message };
  }
}

// ============================================================================
// GENERIC CRUD & SETTINGS & BULK & PROMOTE
// ============================================================================

function collectSettingsAssetIds_(settingsRow) {
  if (!settingsRow) return [];
  var fields = ['schoolLogo', 'foundationWatermarkUrl', 'foundationQrCodeUrl', 'levelConfigsJson'];
  var map = {};
  for (var i = 0; i < fields.length; i++) {
    var val = settingsRow[fields[i]];
    if (!val) continue;
    var ids = collectDriveFileIdsFromString_(String(val));
    for (var j = 0; j < ids.length; j++) {
      map[ids[j]] = true;
    }
  }
  return Object.keys(map);
}

function handleUpdateSettings_(ss, data, actor) {
  var sheet = ss.getSheetByName('Settings');
  var rows = readActiveRows_(ss, 'Settings');
  var prevSettings = rows.length > 0 ? rows[0] : {};
  var prevAssetIds = collectSettingsAssetIds_(prevSettings);
  var targetId = rows.length > 0 ? rows[0].id : 'settings-default';

  var patch = { updatedBy: actor };
  var allowed = [
    'schoolName', 'schoolLogo', 'academicYear', 'checkInTime', 'lateCutoffTime',
    'checkOutTime', 'toiletMaxMinutes', 'toiletBabMinutes', 'toiletBakMinutes',
    'warningThresholdAbsent', 'warningThresholdLate',
    'warningThresholdToilet', 'parentNotificationEnabled', 'foundationAddress',
    'foundationWebsite', 'foundationWatermarkUrl', 'foundationQrCodeUrl', 'levelConfigsJson'
  ];
  for (var i = 0; i < allowed.length; i++) {
    var k = allowed[i];
    if (data.hasOwnProperty(k)) {
      patch[k] = data[k];
    }
  }
  if (Array.isArray(data.holidays)) {
    patch.holidaysJson = JSON.stringify(data.holidays);
  }

  var upd = updateRowCellsById_(sheet, 'Settings', targetId, patch, data.expectedUpdatedAt);
  if (!upd.success) return { success: false, mutated: false, conflict: upd.conflict, error: upd.error };

  var updatedRows = readActiveRows_(ss, 'Settings');
  var nextSettingsRaw = updatedRows.length > 0 ? updatedRows[0] : {};
  var nextAssetSet = {};
  var nextAssetIds = collectSettingsAssetIds_(nextSettingsRaw);
  for (var na = 0; na < nextAssetIds.length; na++) {
    nextAssetSet[nextAssetIds[na]] = true;
  }

  // Delete orphaned logo/signature/watermark/QR files from Drive if removed/replaced
  var trashedOrphans = 0;
  for (var pa = 0; pa < prevAssetIds.length; pa++) {
    if (!nextAssetSet[prevAssetIds[pa]]) {
      if (trashDriveFileSafely_(prevAssetIds[pa])) trashedOrphans++;
    }
  }

  writeAuditLog_(
    ss,
    actor,
    'UPDATE',
    'Settings',
    targetId,
    'Perbarui pengaturan sekolah' + (trashedOrphans > 0 ? (' (' + trashedOrphans + ' gambar lama dihapus dari Drive)') : '')
  );
  return {
    success: true,
    data: updatedRows.length > 0 ? formatSettingsRow_(updatedRows[0]) : formatSettingsRow_({}),
    trashedOrphans: trashedOrphans,
    message: 'Pengaturan berhasil disimpan ke Google Sheets & Google Drive.'
  };
}

function handleCreateGeneric_(ss, entity, data, actor) {
  if (!SHEET_SCHEMAS[entity]) {
    return { success: false, mutated: false, error: 'Entitas tidak dikenal: ' + entity };
  }
  var sheet = ss.getSheetByName(entity);
  var parts = nowWibParts_();
  var newId = String(data.id || generateId_(entity.slice(0, 3).toLowerCase()));

  var obj = {};
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    obj[keys[i]] = data[keys[i]];
  }

  if (entity === 'Users') {
    var uname = String(data.username || '').trim();
    var urole = String(data.role || 'guru').trim().toLowerCase();
    if (!uname) {
      return { success: false, mutated: false, error: 'Username wajib diisi.' };
    }
    if (urole === 'superadmin' || uname.toLowerCase() === 'superadmin') {
      return { success: false, mutated: false, error: 'Akun Superadmin tidak dapat dibuat atau diatur oleh Admin.' };
    }
    var existingUsers = readActiveRows_(ss, 'Users');
    for (var u = 0; u < existingUsers.length; u++) {
      if (String(existingUsers[u].username).toLowerCase() === uname.toLowerCase()) {
        return { success: false, mutated: false, error: 'Username sudah digunakan.' };
      }
    }
    obj.username = uname;
    obj.passwordHash = hashPassword_(data.password || '123456');
    delete obj.password;
    obj.isActive = data.isActive === undefined ? true : !!data.isActive;
  }

  var autoCreatedClassObj = null;
  if (entity === 'Students') {
    var sNis = String(data.nis || '').trim();
    var sName = String(data.name || '').trim();
    if (!sNis || !sName) {
      return { success: false, mutated: false, error: 'NIS dan Nama siswa wajib diisi.' };
    }
    var existingStudents = readActiveRows_(ss, 'Students');
    for (var s = 0; s < existingStudents.length; s++) {
      if (String(existingStudents[s].nis) === sNis) {
        return { success: false, mutated: false, error: 'NIS siswa sudah terdaftar.' };
      }
    }
    var clsResolvedCreate = resolveOrAutoCreateClassForStudent_(
      ss,
      data.classId,
      data.className || data.kelas,
      data.level,
      data.grade,
      actor
    );
    var clsForStudent = clsResolvedCreate.classObj;
    if (clsResolvedCreate.autoCreated) {
      autoCreatedClassObj = clsForStudent;
    }
    obj.nis = sNis;
    obj.nisn = String(data.nisn || '').trim();
    obj.name = sName;
    obj.classId = clsForStudent ? String(clsForStudent.id) : String(data.classId || '').trim();
    obj.birthPlace = String(data.birthPlace || '').trim();
    obj.birthDate = String(data.birthDate || '').trim();
    obj.address = String(data.address || '').trim();
    obj.level = inferEducationLevel_(clsForStudent ? (clsForStudent.level || data.level) : data.level, clsForStudent ? clsForStudent.grade : '', clsForStudent ? clsForStudent.name : '') || '';
    obj.barcodeCard = data.barcodeCard || ('CARD-' + sNis);
    obj.isActive = true;
    delete obj.className;
    delete obj.kelas;
    delete obj.grade;
  }

  if (entity === 'Classes') {
    obj.level = inferEducationLevel_(data.level, data.grade, data.name) || 'SMK';
    if (!obj.academicYear) {
      var stRowsYear = readActiveRows_(ss, 'Settings');
      obj.academicYear = (stRowsYear.length > 0 && stRowsYear[0].academicYear) ? String(stRowsYear[0].academicYear) : '2026/2027';
    }
    if (data.homeRoomTeacherId && !data.homeRoomTeacherName) {
      var teachers = readActiveRows_(ss, 'Teachers');
      for (var t = 0; t < teachers.length; t++) {
        if (String(teachers[t].id) === String(data.homeRoomTeacherId)) {
          obj.homeRoomTeacherName = teachers[t].name;
          break;
        }
      }
    }
  }

  if (entity === 'Sessions') {
    var sesName = String(data.name || '').trim();
    if (!sesName) {
      return { success: false, mutated: false, error: 'Nama sesi wajib diisi.' };
    }
    var sesTarget = String(data.targetType || '').toLowerCase() === 'teacher' ? 'teacher' : 'student';
    var sStart = padHhMm_(data.startTime, '');
    var sCutoff = padHhMm_(data.lateCutoffTime, '');
    var sEnd = padHhMm_(data.endTime, '');
    if (!sStart || !sCutoff || !sEnd) {
      return { success: false, mutated: false, error: 'Format jam sesi wajib 24-jam HH:mm (contoh 07:00).' };
    }
    var existingSessions = readSortedSessions_(ss);
    var baseSheetName = sanitizeSessionSheetName_(sesTarget, sesName, data.sheetName);
    var uniqueSheetName = ensureUniqueSessionSheetName_(ss, existingSessions, baseSheetName, '');

    obj.targetType = sesTarget;
    obj.name = sesName;
    obj.startTime = sStart;
    obj.lateCutoffTime = sCutoff;
    obj.endTime = sEnd;
    obj.sheetName = uniqueSheetName;
    obj.sortOrder = Number(data.sortOrder) || (existingSessions.filter(function (x) { return x.targetType === sesTarget; }).length + 1);
    obj.isActive = data.isActive === undefined ? true : !!data.isActive;
  }

  if (entity === 'FollowUpNotes') {
    var students = readActiveRows_(ss, 'Students');
    for (var f = 0; f < students.length; f++) {
      if (String(students[f].id) === String(data.studentId)) {
        obj.studentName = students[f].name;
        obj.studentNis = students[f].nis;
        break;
      }
    }
    obj.date = data.date || parts.date;
    obj.counselorId = actor;
    obj.status = data.status || 'Open';
  } else {
    obj.status = obj.status || 'aktif';
  }

  obj.id = newId;
  obj.createdAt = parts.iso;
  obj.diubah_pada = parts.iso;
  obj.updatedBy = actor;
  if (obj.isActive === undefined && SHEET_SCHEMAS[entity].indexOf('isActive') >= 0) {
    obj.isActive = true;
  }

  var subjectInput = String(data.subject || '');
  if (entity !== 'Teachers') {
    delete obj.subject;
  }

  appendObjectRow_(sheet, entity, obj);
  if (entity === 'Sessions') {
    ensureSessionSheet_(ss, obj);
  }
  if (entity === 'Students') {
    syncSingleStudentInLevelSheets_(ss, obj, false);
  }
  writeAuditLog_(ss, actor, 'CREATE', entity, newId, entity === 'Sessions' ? ('Buat sesi "' + obj.name + '" (' + obj.targetType + ') -> Sheet ' + obj.sheetName) : ('Tambah data baru pada ' + entity));

  // Auto-sync teacher profile when Admin creates a Guru / Wali Kelas / BK / Kesiswaan user
  if (entity === 'Users') {
    var roleStr = String(obj.role || '').toLowerCase();
    if (roleStr === 'guru' || roleStr === 'wali_kelas' || roleStr === 'bk' || roleStr === 'kesiswaan') {
      var teachersSheet = ss.getSheetByName('Teachers');
      var existingTeachers = readActiveRows_(ss, 'Teachers');
      var uNip = String(obj.nip || '').trim();
      var uEmail = String(obj.email || '').trim().toLowerCase();
      var uName = String(obj.name || '').trim().toLowerCase();
      var alreadyTeacher = false;
      for (var et = 0; et < existingTeachers.length; et++) {
        var rowT = existingTeachers[et];
        if ((uNip && String(rowT.nip || '').trim() === uNip) ||
            (uEmail && String(rowT.email || '').trim().toLowerCase() === uEmail) ||
            (uName && String(rowT.name || '').trim().toLowerCase() === uName)) {
          alreadyTeacher = true;
          break;
        }
      }
      if (!alreadyTeacher && teachersSheet) {
        var tchId = generateId_('tch');
        appendObjectRow_(teachersSheet, 'Teachers', {
          id: tchId,
          nip: uNip,
          name: obj.name || obj.username,
          email: obj.email || '',
          phone: '',
          subject: subjectInput || (roleStr === 'bk' ? 'Bimbingan Konseling' : roleStr === 'kesiswaan' ? 'Kesiswaan' : 'Guru'),
          isActive: obj.isActive,
          status: 'aktif',
          createdAt: parts.iso,
          diubah_pada: parts.iso,
          updatedBy: actor
        });
      }
    }
  }

  return { success: true, id: newId, data: obj, autoCreatedClass: autoCreatedClassObj, message: 'Data berhasil ditambahkan.' };
}

function handleUpdateGeneric_(ss, entity, id, data, expectedUpdatedAt, actor) {
  if (!SHEET_SCHEMAS[entity]) {
    return { success: false, mutated: false, error: 'Entitas tidak dikenal: ' + entity };
  }
  if (!id || String(id).trim() === '') {
    return { success: false, mutated: false, error: 'Parameter id wajib diisi.' };
  }
  var sheet = ss.getSheetByName(entity);
  var patch = {};
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    patch[keys[i]] = data[keys[i]];
  }
  patch.updatedBy = actor;

  var updatedSessionSheetTarget = null;
  if (entity === 'Sessions') {
    var allSessions = readSortedSessions_(ss);
    var curSession = null;
    for (var si = 0; si < allSessions.length; si++) {
      if (String(allSessions[si].id) === String(id)) {
        curSession = allSessions[si];
        break;
      }
    }
    if (!curSession) {
      return { success: false, mutated: false, error: 'Data sesi tidak ditemukan.' };
    }
    if (patch.hasOwnProperty('targetType')) {
      patch.targetType = String(patch.targetType).toLowerCase() === 'teacher' ? 'teacher' : 'student';
    }
    if (patch.hasOwnProperty('startTime')) {
      var st24 = padHhMm_(patch.startTime, '');
      if (!st24) return { success: false, mutated: false, error: 'Format jam mulai harus HH:mm (24 jam).' };
      patch.startTime = st24;
    }
    if (patch.hasOwnProperty('lateCutoffTime')) {
      var lc24 = padHhMm_(patch.lateCutoffTime, '');
      if (!lc24) return { success: false, mutated: false, error: 'Format batas terlambat harus HH:mm (24 jam).' };
      patch.lateCutoffTime = lc24;
    }
    if (patch.hasOwnProperty('endTime')) {
      var en24 = padHhMm_(patch.endTime, '');
      if (!en24) return { success: false, mutated: false, error: 'Format jam selesai harus HH:mm (24 jam).' };
      patch.endTime = en24;
    }
    if (patch.hasOwnProperty('sheetName') && String(patch.sheetName).trim()) {
      var reqSheet = sanitizeSessionSheetName_(patch.targetType || curSession.targetType, patch.name || curSession.name, patch.sheetName);
      if (reqSheet !== curSession.sheetName) {
        var uniqueNext = ensureUniqueSessionSheetName_(ss, allSessions, reqSheet, id);
        var oldSheet = ss.getSheetByName(curSession.sheetName);
        if (oldSheet && oldSheet.getLastRow() <= 1 && !ss.getSheetByName(uniqueNext)) {
          try { oldSheet.setName(uniqueNext); } catch (renErr) {}
        }
        patch.sheetName = uniqueNext;
      } else {
        patch.sheetName = curSession.sheetName;
      }
    }
    updatedSessionSheetTarget = {
      targetType: patch.targetType || curSession.targetType,
      name: patch.name || curSession.name,
      sheetName: patch.sheetName || curSession.sheetName
    };
  }

  if (entity === 'Users') {
    var curUsersCheck = readActiveRows_(ss, 'Users');
    for (var ui = 0; ui < curUsersCheck.length; ui++) {
      if (String(curUsersCheck[ui].id) === String(id)) {
        if (String(curUsersCheck[ui].role || '').toLowerCase() === 'superadmin' ||
            String(curUsersCheck[ui].username || '').toLowerCase() === 'superadmin') {
          return { success: false, mutated: false, error: 'Akun Superadmin dilindungi dan tidak dapat diubah oleh Admin.' };
        }
        break;
      }
    }
    if (String(patch.role || '').toLowerCase() === 'superadmin' ||
        String(patch.username || '').toLowerCase() === 'superadmin') {
      return { success: false, mutated: false, error: 'Peran Superadmin tidak dapat ditetapkan oleh Admin.' };
    }
    if (patch.hasOwnProperty('username')) {
      var nextUsername = String(patch.username || '').trim();
      if (!nextUsername) {
        return { success: false, mutated: false, error: 'Username wajib diisi.' };
      }
      for (var un = 0; un < curUsersCheck.length; un++) {
        if (String(curUsersCheck[un].id) !== String(id) &&
            String(curUsersCheck[un].username || '').trim().toLowerCase() === nextUsername.toLowerCase()) {
          return { success: false, mutated: false, error: 'Username "' + nextUsername + '" sudah digunakan akun lain.' };
        }
      }
      patch.username = nextUsername;
    }
    if (patch.hasOwnProperty('password')) {
      var plainPwd = String(patch.password || '');
      if (plainPwd.length > 0) {
        if (plainPwd.length < 5) {
          return { success: false, mutated: false, error: 'Password baru minimal 5 karakter.' };
        }
        patch.passwordHash = hashPassword_(plainPwd);
      }
      delete patch.password;
    }
    delete patch.subject;
  }

  var autoCreatedClassOnUpdate = null;
  if (entity === 'Students') {
    var curStudentsCheck = readActiveRows_(ss, 'Students');
    var selfStudentRow = null;
    for (var scSelf = 0; scSelf < curStudentsCheck.length; scSelf++) {
      if (String(curStudentsCheck[scSelf].id) === String(id)) {
        selfStudentRow = curStudentsCheck[scSelf];
        break;
      }
    }

    if (patch.hasOwnProperty('nis')) {
      var nextNis = String(patch.nis || '').trim();
      if (!nextNis) {
        return { success: false, mutated: false, error: 'NIS siswa wajib diisi.' };
      }
      var selfCurrentNis = selfStudentRow ? String(selfStudentRow.nis || '').trim() : '';
      // Only enforce duplicate NIS check if NIS actually changed from this student's existing NIS
      if (nextNis !== selfCurrentNis) {
        for (var stc = 0; stc < curStudentsCheck.length; stc++) {
          if (String(curStudentsCheck[stc].id) !== String(id) &&
              String(curStudentsCheck[stc].nis || '').trim() === nextNis) {
            return { success: false, mutated: false, error: 'NIS "' + nextNis + '" sudah terdaftar pada siswa lain.' };
          }
        }
      }
      patch.nis = nextNis;
    }
    if (patch.hasOwnProperty('nisn')) {
      patch.nisn = String(patch.nisn || '').trim();
    }
    if (patch.hasOwnProperty('birthPlace')) {
      patch.birthPlace = String(patch.birthPlace || '').trim();
    }
    if (patch.hasOwnProperty('birthDate')) {
      patch.birthDate = String(patch.birthDate || '').trim();
    }
    if (patch.hasOwnProperty('address')) {
      patch.address = String(patch.address || '').trim();
    }

    var incomingClassName = String(patch.className || patch.kelas || '').trim();
    if (incomingClassName) {
      var lvlForResolve = patch.hasOwnProperty('level')
        ? patch.level
        : (selfStudentRow ? selfStudentRow.level : '');
      var clsResolvedUpd = resolveOrAutoCreateClassForStudent_(
        ss,
        patch.classId,
        incomingClassName,
        lvlForResolve,
        patch.grade,
        actor
      );
      if (clsResolvedUpd.classObj) {
        patch.classId = String(clsResolvedUpd.classObj.id);
        if (!patch.hasOwnProperty('level') || !String(patch.level || '').trim()) {
          patch.level = inferEducationLevel_(clsResolvedUpd.classObj.level, clsResolvedUpd.classObj.grade, clsResolvedUpd.classObj.name);
        }
      }
      if (clsResolvedUpd.autoCreated) {
        autoCreatedClassOnUpdate = clsResolvedUpd.classObj;
      }
    }
    delete patch.className;
    delete patch.kelas;
    delete patch.grade;

    if (patch.hasOwnProperty('level')) {
      patch.level = normalizeEducationLevel_(patch.level);
    }
  }

  if (entity === 'Classes') {
    if (patch.hasOwnProperty('level') || patch.hasOwnProperty('grade') || patch.hasOwnProperty('name')) {
      var normClsLvl = inferEducationLevel_(patch.level, patch.grade, patch.name);
      if (normClsLvl) {
        patch.level = normClsLvl;
      }
    }
    if (patch.hasOwnProperty('homeRoomTeacherId')) {
      var resolvedTeacherName = '';
      if (patch.homeRoomTeacherId) {
        var tchRows = readActiveRows_(ss, 'Teachers');
        for (var tc = 0; tc < tchRows.length; tc++) {
          if (String(tchRows[tc].id) === String(patch.homeRoomTeacherId)) {
            resolvedTeacherName = tchRows[tc].name;
            break;
          }
        }
      }
      patch.homeRoomTeacherName = resolvedTeacherName;
    }
  }

  var res = updateRowCellsById_(sheet, entity, id, patch, expectedUpdatedAt);
  if (!res.success) {
    return { success: false, mutated: false, conflict: res.conflict, error: res.error };
  }

  if (updatedSessionSheetTarget) {
    ensureSessionSheet_(ss, updatedSessionSheetTarget);
  }
  if (entity === 'Students') {
    syncSingleStudentInLevelSheets_(ss, id, false);
  } else if (entity === 'Classes') {
    syncStudentLevelSheets_(ss);
  }

  writeAuditLog_(ss, actor, 'UPDATE', entity, id, 'Perbarui ' + res.changedCount + ' sel pada ' + entity);
  return {
    success: true,
    changedCount: res.changedCount,
    diubah_pada: res.diubah_pada,
    autoCreatedClass: autoCreatedClassOnUpdate,
    message: 'Data berhasil diperbarui.'
  };
}

function deleteMatchingFaceTemplatesAndDrive_(ss, personId, personTypeFilter) {
  var faceSheet = ss.getSheetByName('FaceTemplates');
  if (!faceSheet || faceSheet.getLastRow() <= 1) return 0;
  var headers = getHeaders_(faceSheet, 'FaceTemplates');
  var vals = faceSheet.getRange(2, 1, faceSheet.getLastRow() - 1, headers.length).getValues();
  var pidCol = headers.indexOf('personId');
  var ptypeCol = headers.indexOf('personType');
  if (pidCol < 0) return 0;

  var trashedCount = 0;
  for (var r = vals.length - 1; r >= 0; r--) {
    var rowPid = String(vals[r][pidCol] || '');
    var rowPtype = ptypeCol >= 0 ? String(vals[r][ptypeCol] || 'student') : 'student';
    if (rowPid === String(personId) && (!personTypeFilter || rowPtype === personTypeFilter)) {
      var driveIds = collectRowDriveIds_(headers, vals[r]);
      for (var d = 0; d < driveIds.length; d++) {
        if (trashDriveFileSafely_(driveIds[d])) trashedCount++;
      }
      faceSheet.deleteRow(r + 2);
    }
  }
  return trashedCount;
}

function sweepLegacyDeletedRowsOnSheet_(sheet, schemaName) {
  if (!sheet || sheet.getLastRow() <= 1) return 0;
  var headers = getHeaders_(sheet, schemaName);
  var statusCol = headers.indexOf('status');
  if (statusCol < 0) return 0;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var trashed = 0;
  for (var r = vals.length - 1; r >= 0; r--) {
    if (String(vals[r][statusCol] || '').toLowerCase() === 'dihapus') {
      var driveIds = collectRowDriveIds_(headers, vals[r]);
      for (var d = 0; d < driveIds.length; d++) {
        if (trashDriveFileSafely_(driveIds[d])) trashed++;
      }
      sheet.deleteRow(r + 2);
    }
  }
  return trashed;
}

function handleSoftDeleteGeneric_(ss, entity, id, expectedUpdatedAt, actor) {
  if (!SHEET_SCHEMAS[entity]) {
    return { success: false, mutated: false, error: 'Entitas tidak dikenal: ' + entity };
  }
  if (!id || String(id).trim() === '') {
    return { success: false, mutated: false, error: 'Parameter id wajib diisi.' };
  }
  if (entity === 'Users') {
    var delUsersCheck = readActiveRows_(ss, 'Users');
    for (var dui = 0; dui < delUsersCheck.length; dui++) {
      if (String(delUsersCheck[dui].id) === String(id)) {
        if (String(delUsersCheck[dui].role || '').toLowerCase() === 'superadmin' ||
            String(delUsersCheck[dui].username || '').toLowerCase() === 'superadmin') {
          return { success: false, mutated: false, error: 'Akun Superadmin dilindungi dan tidak dapat dihapus oleh Admin.' };
        }
        break;
      }
    }
  }

  var sheet = ss.getSheetByName(entity);
  if (!sheet) {
    return { success: false, mutated: false, error: 'Sheet "' + entity + '" tidak ditemukan.' };
  }

  // Inspect target row before deletion for cascading cleanup
  var rowIndex = findRowById_(sheet, id);
  if (rowIndex === -1) {
    sweepLegacyDeletedRowsOnSheet_(sheet, entity);
    return { success: true, mutated: false, alreadyDeleted: true, message: 'Data sudah tidak ada atau sudah terhapus.' };
  }
  var headers = getHeaders_(sheet, entity);
  var rowVals = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var rowMap = {};
  for (var hc = 0; hc < headers.length; hc++) {
    if (headers[hc]) rowMap[headers[hc]] = rowVals[hc];
  }

  var totalTrashed = 0;

  if (entity === 'Students') {
    totalTrashed += deleteMatchingFaceTemplatesAndDrive_(ss, id, 'student');
  } else if (entity === 'Teachers') {
    totalTrashed += deleteMatchingFaceTemplatesAndDrive_(ss, id, 'teacher');
  } else if (entity === 'FaceTemplates') {
    var fPid = String(rowMap.personId || '').trim();
    var fPtype = String(rowMap.personType || 'student');
    var fPhotoId = String(rowMap.photoFileId || '').trim();
    if (fPid && fPtype === 'student') {
      var stdSheet = ss.getSheetByName('Students');
      if (stdSheet) {
        var stdIdx = findRowById_(stdSheet, fPid);
        if (stdIdx > 0) {
          var stdHeaders = getHeaders_(stdSheet, 'Students');
          var stdVals = stdSheet.getRange(stdIdx, 1, 1, stdHeaders.length).getValues()[0];
          var pIdCol = stdHeaders.indexOf('photoFileId');
          var pUrlCol = stdHeaders.indexOf('photoUrl');
          var existingStdFileId = pIdCol >= 0 ? String(stdVals[pIdCol] || '').trim() : '';
          var existingStdUrlId = pUrlCol >= 0 ? extractDriveFileIdFromRef_(stdVals[pUrlCol]) : '';
          if (existingStdFileId && existingStdFileId !== fPhotoId && trashDriveFileSafely_(existingStdFileId)) totalTrashed++;
          if (existingStdUrlId && existingStdUrlId !== fPhotoId && existingStdUrlId !== existingStdFileId && trashDriveFileSafely_(existingStdUrlId)) totalTrashed++;
          updateRowCellsById_(stdSheet, 'Students', fPid, {
            photoFileId: '',
            photoUrl: '',
            updatedBy: actor
          }, null);
        }
      }
    }
  }

  var delRes = softDeleteRowById_(sheet, entity, id, expectedUpdatedAt, actor);
  if (!delRes.success) {
    return { success: false, mutated: false, conflict: delRes.conflict, error: delRes.error };
  }
  totalTrashed += (delRes.trashedFiles || 0);
  totalTrashed += sweepLegacyDeletedRowsOnSheet_(sheet, entity);

  if (entity === 'Students') {
    syncSingleStudentInLevelSheets_(ss, id, true);
  } else if (entity === 'Classes') {
    syncStudentLevelSheets_(ss);
  } else if (entity === 'Sessions') {
    var deletedSheetName = String(rowMap.sheetName || '').trim();
    if (deletedSheetName && !SHEET_SCHEMAS[deletedSheetName] && ss.getSheets().length > 1) {
      var otherSessions = readActiveRows_(ss, 'Sessions');
      var stillInUse = false;
      for (var os = 0; os < otherSessions.length; os++) {
        if (String(otherSessions[os].sheetName || '').trim() === deletedSheetName) {
          stillInUse = true;
          break;
        }
      }
      if (!stillInUse) {
        var sesSheet = ss.getSheetByName(deletedSheetName);
        if (sesSheet) {
          try { ss.deleteSheet(sesSheet); } catch (delSesErr) {}
        }
      }
    }
  }

  writeAuditLog_(
    ss,
    actor,
    'DELETE',
    entity,
    id,
    'Hapus bersih data Sheet & ' + totalTrashed + ' file Drive pada ' + entity
  );
  return {
    success: true,
    deletedId: id,
    trashedFiles: totalTrashed,
    message: 'Data & file gambar/foto terkait berhasil dihapus bersih dari Sheet dan Drive.'
  };
}

function handleResetPassword_(ss, id, newPassword, expectedUpdatedAt, actor) {
  if (!newPassword || String(newPassword).length < 5) {
    return { success: false, mutated: false, error: 'Password minimal 5 karakter.' };
  }
  var usersListForReset = readActiveRows_(ss, 'Users');
  for (var rui = 0; rui < usersListForReset.length; rui++) {
    if (String(usersListForReset[rui].id) === String(id)) {
      if (String(usersListForReset[rui].role || '').toLowerCase() === 'superadmin' ||
          String(usersListForReset[rui].username || '').toLowerCase() === 'superadmin') {
        return { success: false, mutated: false, error: 'Admin tidak diizinkan mengatur atau mereset sandi Superadmin.' };
      }
      break;
    }
  }
  var sheet = ss.getSheetByName('Users');
  var res = updateRowCellsById_(sheet, 'Users', id, {
    passwordHash: hashPassword_(newPassword),
    updatedBy: actor
  }, expectedUpdatedAt);
  if (!res.success) return { success: false, mutated: false, conflict: res.conflict, error: res.error };
  writeAuditLog_(ss, actor, 'RESET_PASSWORD', 'Users', id, 'Reset kata sandi pengguna');
  return { success: true, message: 'Kata sandi berhasil direset.' };
}

function handleBulkImportStudents_(ss, rows, defaultClassId, defaultLevel, actor, forceDefaultLevel) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, mutated: false, error: 'Data import kosong.' };
  }

  var sheet = ss.getSheetByName('Students');
  var classesSheet = ss.getSheetByName('Classes');
  var existing = readActiveRows_(ss, 'Students');
  var nisSet = {};
  for (var i = 0; i < existing.length; i++) {
    nisSet[String(existing[i].nis)] = true;
  }

  var existingClasses = readActiveRows_(ss, 'Classes');
  var classById = {};
  var classByNameKey = {};
  for (var ci = 0; ci < existingClasses.length; ci++) {
    var exCls = existingClasses[ci];
    classById[String(exCls.id)] = exCls;
    var nameKey = String(exCls.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (nameKey && !classByNameKey[nameKey]) {
      classByNameKey[nameKey] = exCls;
    }
  }

  var settingsRows = readActiveRows_(ss, 'Settings');
  var activeAcademicYear = (settingsRows.length > 0 && settingsRows[0].academicYear)
    ? String(settingsRows[0].academicYear)
    : '2026/2027';

  var fallbackLevel = normalizeEducationLevel_(defaultLevel) || '';
  var parts = nowWibParts_();
  var importedCount = 0;
  var createdClassesCount = 0;
  var createdClassNames = [];
  var errorRows = [];

  var pendingClassObjs = [];
  var pendingStudentObjs = [];

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r] || {};
    var nis = String(row.nis || row.NIS || '').trim();
    var name = String(row.nama || row.name || row.Nama || '').trim();
    if (!nis || !name) {
      errorRows.push({ rowNumber: r + 2, reason: 'NIS atau Nama kosong.' });
      continue;
    }
    if (nisSet[nis]) {
      errorRows.push({ rowNumber: r + 2, reason: 'Duplikasi NIS (' + nis + ').' });
      continue;
    }

    var genderRaw = String(row.jenisKelamin || row.gender || 'L').toUpperCase();
    var gender = genderRaw.indexOf('P') === 0 ? 'P' : 'L';
    var rawClassName = String(row.kelas || row.className || row.class || row.Kelas || '').trim();
    var rowClassIdInput = String(row.classId || '').trim();
    var rawRowLevel = String(row.jenjang || row.level || row.Jenjang || '').trim();
    var rawGrade = String(row.tingkat || row.grade || '').trim();
    var address = String(row.alamat || row.address || row.Alamat || row.alamatLengkap || '').trim();

    var rowInferredLevel = (forceDefaultLevel && fallbackLevel)
      ? fallbackLevel
      : inferEducationLevel_(rawRowLevel || fallbackLevel, rawGrade, rawClassName);

    var resolvedClass = null;
    if (rowClassIdInput && classById[rowClassIdInput]) {
      resolvedClass = classById[rowClassIdInput];
    } else if (rawClassName) {
      var lookupKey = rawClassName.toLowerCase().replace(/\s+/g, ' ');
      if (classByNameKey[lookupKey]) {
        resolvedClass = classByNameKey[lookupKey];
      } else if (classesSheet) {
        var newClsLevel = rowInferredLevel || fallbackLevel || 'SMK';
        var newClsGrade = inferGradeNumber_(newClsLevel, rawGrade, rawClassName);
        var newClsObj = {
          id: generateId_('cls') + r,
          name: rawClassName,
          grade: newClsGrade,
          academicYear: activeAcademicYear,
          level: newClsLevel,
          homeRoomTeacherId: '',
          homeRoomTeacherName: '',
          status: 'aktif',
          createdAt: parts.iso,
          diubah_pada: parts.iso,
          updatedBy: actor
        };
        pendingClassObjs.push(newClsObj);
        classById[newClsObj.id] = newClsObj;
        classByNameKey[lookupKey] = newClsObj;
        resolvedClass = newClsObj;
        createdClassesCount++;
        createdClassNames.push(rawClassName);
      }
    }

    if (!resolvedClass && defaultClassId && classById[String(defaultClassId)]) {
      resolvedClass = classById[String(defaultClassId)];
    }

    var clsId = resolvedClass ? String(resolvedClass.id) : String(rowClassIdInput || defaultClassId || '').trim();
    var finalLevel = (forceDefaultLevel && fallbackLevel)
      ? fallbackLevel
      : (
        normalizeEducationLevel_(rawRowLevel) ||
        (resolvedClass ? inferEducationLevel_(resolvedClass.level, resolvedClass.grade, resolvedClass.name) : '') ||
        fallbackLevel ||
        'SMK'
      );

    pendingStudentObjs.push({
      id: generateId_('std') + r,
      nis: nis,
      nisn: String(row.nisn || row.NISN || '').trim(),
      name: name,
      gender: gender,
      classId: clsId,
      barcodeCard: String(row.barcodeCard || ('CARD-' + nis)).trim(),
      parentPhone: String(row.noHpOrtu || row.parentPhone || '').trim(),
      photoFileId: '',
      photoUrl: '',
      level: finalLevel,
      birthPlace: String(row.tempatLahir || row.birthPlace || '').trim(),
      birthDate: String(row.tanggalLahir || row.birthDate || '').trim(),
      address: address,
      bloodType: '',
      isActive: true,
      status: 'aktif',
      createdAt: parts.iso,
      diubah_pada: parts.iso,
      updatedBy: actor
    });

    nisSet[nis] = true;
    importedCount++;
  }

  // Batch write auto-created Classes in ONE setValues RPC
  if (pendingClassObjs.length > 0 && classesSheet) {
    var clsHeaders = getHeaders_(classesSheet, 'Classes');
    var clsMatrix = [];
    for (var pc = 0; pc < pendingClassObjs.length; pc++) {
      var cObj = pendingClassObjs[pc];
      var cRow = [];
      for (var ch = 0; ch < clsHeaders.length; ch++) {
        var cKey = clsHeaders[ch];
        var cVal = cObj.hasOwnProperty(cKey) ? cObj[cKey] : '';
        cRow.push(prepareCellValueForSheet_(cVal, 'Classes_' + cKey));
      }
      clsMatrix.push(cRow);
    }
    var clsStartRow = classesSheet.getLastRow() + 1;
    classesSheet.getRange(clsStartRow, 1, clsMatrix.length, clsHeaders.length).setValues(clsMatrix);
  }

  // Batch write Students in ONE setValues RPC
  if (pendingStudentObjs.length > 0 && sheet) {
    var stdHeaders = getHeaders_(sheet, 'Students');
    var stdMatrix = [];
    for (var ps = 0; ps < pendingStudentObjs.length; ps++) {
      var sObj = pendingStudentObjs[ps];
      var sRow = [];
      for (var sh = 0; sh < stdHeaders.length; sh++) {
        var sKey = stdHeaders[sh];
        var sVal = sObj.hasOwnProperty(sKey) ? sObj[sKey] : '';
        sRow.push(prepareCellValueForSheet_(sVal, 'Students_' + sKey));
      }
      stdMatrix.push(sRow);
    }
    var stdStartRow = sheet.getLastRow() + 1;
    sheet.getRange(stdStartRow, 1, stdMatrix.length, stdHeaders.length).setValues(stdMatrix);
  }

  if (importedCount > 0 || createdClassesCount > 0) {
    syncStudentLevelSheets_(ss);
  }

  writeAuditLog_(
    ss,
    actor,
    'BULK_IMPORT',
    'Students',
    'bulk',
    'Import massal ' + importedCount + ' siswa, ' + createdClassesCount + ' kelas otomatis (' + errorRows.length + ' error)'
  );
  return {
    success: true,
    mutated: importedCount > 0 || createdClassesCount > 0,
    importedCount: importedCount,
    createdClassesCount: createdClassesCount,
    createdClassNames: createdClassNames,
    errorCount: errorRows.length,
    errorRows: errorRows,
    message:
      'Berhasil mengimpor ' + importedCount + ' siswa' +
      (createdClassesCount > 0 ? (', membuat ' + createdClassesCount + ' kelas baru otomatis (' + createdClassNames.join(', ') + ')') : '') +
      ', serta memperbarui sheet jenjang (' + errorRows.length + ' baris gagal).'
  };
}

function handlePromoteClass_(ss, payload, actor) {
  var sourceClassId = String(payload.sourceClassId || '').trim();
  var targetClassId = String(payload.targetClassId || '').trim();
  var rawAct = String(payload.promoteAction || payload.actionType || 'promote');
  var actionType = (rawAct === 'graduate' || rawAct === 'promote') ? rawAct : 'promote';

  if (!sourceClassId) {
    return { success: false, mutated: false, error: 'Kelas asal wajib dipilih.' };
  }
  if (actionType === 'promote' && !targetClassId) {
    return { success: false, mutated: false, error: 'Kelas tujuan wajib dipilih.' };
  }

  var classesList = readActiveRows_(ss, 'Classes');
  var targetClsObj = null;
  for (var tc = 0; tc < classesList.length; tc++) {
    if (String(classesList[tc].id) === targetClassId) {
      targetClsObj = classesList[tc];
      break;
    }
  }
  var targetLevel = targetClsObj ? inferEducationLevel_(targetClsObj.level, targetClsObj.grade, targetClsObj.name) : '';

  var stdSheet = ss.getSheetByName('Students');
  var students = readActiveRows_(ss, 'Students');
  var moved = 0;

  for (var i = 0; i < students.length; i++) {
    if (String(students[i].classId) === sourceClassId && (students[i].isActive === true || String(students[i].isActive).toLowerCase() === 'true')) {
      if (actionType === 'graduate') {
        updateRowCellsById_(stdSheet, 'Students', students[i].id, { isActive: false, updatedBy: actor });
      } else {
        var upd = { classId: targetClassId, updatedBy: actor };
        if (targetLevel) upd.level = targetLevel;
        updateRowCellsById_(stdSheet, 'Students', students[i].id, upd);
      }
      moved++;
    }
  }

  if (moved > 0) {
    syncStudentLevelSheets_(ss);
  }

  writeAuditLog_(ss, actor, 'PROMOTE', 'Students', sourceClassId, (actionType === 'graduate' ? 'Kelulusan ' : 'Kenaikan kelas ') + moved + ' siswa');
  return {
    success: true,
    mutated: moved > 0,
    message: moved + ' siswa berhasil diproses (' + (actionType === 'graduate' ? 'Lulus' : 'Naik Kelas') + ').'
  };
}

// ============================================================================
// REPORTS & RECAPS (Teacher History/Recap, Student Recap, Counseling Radar)
// ============================================================================

function handleGetTeacherHistory_(ss, params) {
  var userId = String(params.userId || '');
  var teacherIdParam = String(params.teacherId || '');
  var userNip = String(params.userNip || '').trim();
  var userEmail = String(params.userEmail || '').trim().toLowerCase();
  var userName = String(params.userName || '').trim().toLowerCase();

  var teachers = readActiveRows_(ss, 'Teachers');
  var matchedTeacher = null;
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    if ((teacherIdParam && String(t.id) === teacherIdParam) ||
        (userNip && String(t.nip || '').trim() === userNip) ||
        (userEmail && String(t.email || '').trim().toLowerCase() === userEmail) ||
        (userName && String(t.name || '').trim().toLowerCase() === userName) ||
        (userId && String(t.id) === userId)) {
      matchedTeacher = t;
      break;
    }
  }

  var sessionIdFilter = String(params.sessionId || '').trim();
  var allRows = readAttendanceAcrossSessionSheets_(ss, 'teacher', sessionIdFilter === 'ALL' ? '' : sessionIdFilter);
  var mine = [];
  for (var r = 0; r < allRows.length; r++) {
    var row = allRows[r];
    var match = (matchedTeacher && String(row.teacherId) === String(matchedTeacher.id)) ||
                (teacherIdParam && String(row.teacherId) === teacherIdParam) ||
                (userId && String(row.teacherId) === userId) ||
                (userNip && String(row.nip || '').trim() === userNip) ||
                (userName && String(row.nama || '').trim().toLowerCase() === userName);
    if (match) {
      mine.push({
        id: row.id,
        sessionId: row.sessionId || '',
        sessionName: row.sessionName || '',
        teacherId: row.teacherId,
        teacherName: row.nama,
        nip: String(row.nip || ''),
        subject: row.subject || '',
        date: String(row.date),
        timeIn: String(row.timeIn || ''),
        timeOut: row.timeOut ? String(row.timeOut) : '',
        status: row.status,
        method: row.method || 'FACE_SCAN',
        latitude: row.latitude !== '' ? Number(row.latitude) : undefined,
        longitude: row.longitude !== '' ? Number(row.longitude) : undefined,
        distanceMeters: row.distanceMeters !== '' ? Number(row.distanceMeters) : undefined,
        notes: row.notes || '',
        createdAt: row.createdAt || '',
        updatedAt: row.diubah_pada || '',
        updatedBy: row.updatedBy || ''
      });
    }
  }
  mine.sort(function (a, b) {
    var dCmp = String(b.date).localeCompare(String(a.date));
    if (dCmp !== 0) return dCmp;
    return String(b.timeIn || '').localeCompare(String(a.timeIn || ''));
  });

  return {
    success: true,
    teacherId: matchedTeacher ? matchedTeacher.id : (teacherIdParam || userId),
    teacherName: matchedTeacher ? matchedTeacher.name : (params.userName || ''),
    teacherNip: matchedTeacher ? String(matchedTeacher.nip || '') : userNip,
    data: mine
  };
}

function handleGetTeacherRecap_(ss, params) {
  var parts = nowWibParts_();
  var period = String(params.period || 'daily');
  var targetDate = String(params.date || parts.date);
  var month = String(params.month || targetDate.slice(0, 7));
  var sessionIdFilter = String(params.sessionId || '').trim();

  var rangeStart = targetDate;
  var rangeEnd = targetDate;
  if (period === 'weekly') {
    var dParts = targetDate.split('-').map(Number);
    var dt = new Date(Date.UTC(dParts[0], dParts[1] - 1, dParts[2]));
    var diffToMon = (dt.getUTCDay() + 6) % 7;
    var st = new Date(dt); st.setUTCDate(dt.getUTCDate() - diffToMon);
    var en = new Date(st); en.setUTCDate(st.getUTCDate() + 6);
    rangeStart = st.toISOString().split('T')[0];
    rangeEnd = en.toISOString().split('T')[0];
  } else if (period === 'monthly') {
    rangeStart = month + '-01';
    rangeEnd = month + '-31';
  }

  var teachers = readActiveRows_(ss, 'Teachers').filter(function (t) {
    return t.isActive === true || String(t.isActive).toLowerCase() === 'true' || t.isActive === '';
  });
  var allAtt = readAttendanceAcrossSessionSheets_(ss, 'teacher', (sessionIdFilter && sessionIdFilter !== 'ALL') ? sessionIdFilter : '');
  var filtered = [];
  for (var i = 0; i < allAtt.length; i++) {
    var r = allAtt[i];
    var dtStr = String(r.date || '');
    if (dtStr >= rangeStart && dtStr <= rangeEnd) {
      filtered.push({
        id: r.id,
        sessionId: r.sessionId || '',
        sessionName: r.sessionName || '',
        teacherId: r.teacherId,
        teacherName: r.nama || '',
        nip: String(r.nip || ''),
        subject: r.subject || '',
        date: dtStr,
        timeIn: String(r.timeIn || ''),
        timeOut: r.timeOut ? String(r.timeOut) : '',
        status: r.status,
        method: r.method || '',
        notes: r.notes || ''
      });
    }
  }

  var totals = {
    totalTeachers: teachers.length,
    totalRecords: filtered.length,
    tepatWaktu: 0, terlambat: 0, izin: 0, sakit: 0,
    hadirTotal: 0, belumPresensi: 0, attendanceRate: 0
  };

  var dailyMap = {};
  var byTeacher = {};
  for (var f = 0; f < filtered.length; f++) {
    var rec = filtered[f];
    if (rec.status === 'Tepat Waktu') totals.tepatWaktu++;
    else if (rec.status === 'Terlambat') totals.terlambat++;
    else if (rec.status === 'Izin') totals.izin++;
    else if (rec.status === 'Sakit') totals.sakit++;

    if (!dailyMap[rec.date]) dailyMap[rec.date] = { date: rec.date, tepatWaktu: 0, terlambat: 0, izin: 0, sakit: 0, total: 0 };
    dailyMap[rec.date].total++;
    if (rec.status === 'Tepat Waktu') dailyMap[rec.date].tepatWaktu++;
    else if (rec.status === 'Terlambat') dailyMap[rec.date].terlambat++;
    else if (rec.status === 'Izin') dailyMap[rec.date].izin++;
    else if (rec.status === 'Sakit') dailyMap[rec.date].sakit++;

    if (!byTeacher[rec.teacherId]) byTeacher[rec.teacherId] = [];
    byTeacher[rec.teacherId].push(rec);
  }
  totals.hadirTotal = totals.tepatWaktu + totals.terlambat;

  var teacherSummaries = teachers.map(function (t) {
    var recs = (byTeacher[t.id] || []).sort(function (a, b) {
      var dCmp = String(b.date).localeCompare(String(a.date));
      if (dCmp !== 0) return dCmp;
      return String(b.timeIn || '').localeCompare(String(a.timeIn || ''));
    });
    var tw = 0, tl = 0, iz = 0, sk = 0;
    for (var j = 0; j < recs.length; j++) {
      if (recs[j].status === 'Tepat Waktu') tw++;
      else if (recs[j].status === 'Terlambat') tl++;
      else if (recs[j].status === 'Izin') iz++;
      else if (recs[j].status === 'Sakit') sk++;
    }
    var latest = recs[0] || null;
    if (!latest && period === 'daily') totals.belumPresensi++;
    var totalRec = recs.length;
    var hadir = tw + tl;
    return {
      teacherId: t.id,
      teacherName: t.name,
      nip: String(t.nip || ''),
      subject: t.subject || '',
      email: t.email || '',
      tepatWaktu: tw,
      terlambat: tl,
      izin: iz,
      sakit: sk,
      totalHadir: hadir,
      totalRecorded: totalRec,
      belumPresensi: totalRec === 0 ? 1 : 0,
      attendanceRate: totalRec > 0 ? Math.round((hadir / totalRec) * 100) : 0,
      latestDate: latest ? latest.date : null,
      latestTimeIn: latest ? latest.timeIn : null,
      latestTimeOut: latest ? latest.timeOut : null,
      latestStatus: latest ? latest.status : 'Belum Presensi',
      latestMethod: latest ? latest.method : null,
      latestSessionName: latest ? latest.sessionName : null,
      notes: latest ? latest.notes : null
    };
  });

  if (totals.totalTeachers > 0) {
    totals.attendanceRate = period === 'daily'
      ? Math.round((totals.hadirTotal / totals.totalTeachers) * 100)
      : (totals.totalRecords > 0 ? Math.round((totals.hadirTotal / totals.totalRecords) * 100) : 0);
  }

  return {
    success: true,
    period: period,
    targetDate: targetDate,
    month: month,
    rangeStart: rangeStart,
    rangeEnd: rangeEnd,
    totals: totals,
    teacherSummaries: teacherSummaries,
    records: filtered,
    dailyBreakdown: Object.keys(dailyMap).sort().map(function (k) { return dailyMap[k]; })
  };
}

function handleGetStudentRecap_(ss, params) {
  var classIdFilter = String(params.classId || '');
  var sessionIdFilter = String(params.sessionId || '').trim();
  var classes = readActiveRows_(ss, 'Classes');
  var students = readActiveRows_(ss, 'Students').filter(function (s) {
    var active = s.isActive === true || String(s.isActive).toLowerCase() === 'true' || s.isActive === '';
    return active && (!classIdFilter || String(s.classId) === classIdFilter);
  });
  var attRows = readAttendanceAcrossSessionSheets_(ss, 'student', sessionIdFilter);

  var attByStudent = {};
  for (var i = 0; i < attRows.length; i++) {
    var a = attRows[i];
    if (!attByStudent[a.studentId]) attByStudent[a.studentId] = [];
    attByStudent[a.studentId].push({
      id: a.id,
      sessionId: a.sessionId || '',
      sessionName: a.sessionName || '',
      studentId: a.studentId,
      studentName: a.nama,
      studentNis: String(a.nis || ''),
      classId: a.classId || '',
      className: a.className || '',
      date: String(a.date),
      timeIn: String(a.timeIn || ''),
      status: a.status,
      method: a.method || '',
      notes: a.notes || ''
    });
  }

  var studentSummaries = students.map(function (s) {
    var recs = (attByStudent[s.id] || []).sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); });
    return {
      studentId: s.id,
      studentName: s.name,
      nis: s.nis,
      recentRecords: recs.slice(0, 30)
    };
  });

  var classSummaries = classes.map(function (c) {
    var clsStudents = students.filter(function (s) { return String(s.classId) === String(c.id); });
    var hadir = 0, terlambat = 0, alpa = 0;
    for (var si = 0; si < clsStudents.length; si++) {
      var recs = attByStudent[clsStudents[si].id] || [];
      for (var ri = 0; ri < recs.length; ri++) {
        if (recs[ri].status === 'Hadir') hadir++;
        else if (recs[ri].status === 'Terlambat') terlambat++;
        else if (recs[ri].status === 'Alpa') alpa++;
      }
    }
    var total = hadir + terlambat + alpa;
    return {
      classId: c.id,
      className: c.name,
      totalStudents: clsStudents.length,
      hadir: hadir,
      terlambat: terlambat,
      alpa: alpa,
      attendanceRate: total > 0 ? Math.round(((hadir + terlambat) / total) * 100) : 100
    };
  });

  return {
    success: true,
    studentSummaries: studentSummaries,
    classSummaries: classSummaries
  };
}

function handleGetCounselingRadar_(ss) {
  var settingsRows = readActiveRows_(ss, 'Settings');
  var settings = settingsRows.length > 0 ? formatSettingsRow_(settingsRows[0]) : formatSettingsRow_({});
  var maxAlpa = settings.warningThresholdAbsent || 3;
  var maxLate = settings.warningThresholdLate || 3;
  var maxToilet = settings.warningThresholdToilet || 4;
  var maxToiletMin = settings.toiletMaxMinutes || 10;

  var students = readActiveRows_(ss, 'Students').filter(function (s) {
    return s.isActive === true || String(s.isActive).toLowerCase() === 'true' || s.isActive === '';
  });
  var classes = readActiveRows_(ss, 'Classes');
  var classMap = {};
  for (var c = 0; c < classes.length; c++) classMap[String(classes[c].id)] = classes[c].name;

  var attRows = readAttendanceAcrossSessionSheets_(ss, 'student', '');
  var permitRows = readActiveRows_(ss, 'ToiletPermits');

  var problems = [];
  for (var i = 0; i < students.length; i++) {
    var st = students[i];
    var alpaCount = 0;
    var lateCount = 0;
    for (var a = 0; a < attRows.length; a++) {
      if (String(attRows[a].studentId) === String(st.id)) {
        if (attRows[a].status === 'Alpa') alpaCount++;
        if (attRows[a].status === 'Terlambat') lateCount++;
      }
    }

    var totalToilet = 0;
    var exceededToilet = 0;
    for (var p = 0; p < permitRows.length; p++) {
      if (String(permitRows[p].studentId) === String(st.id)) {
        totalToilet++;
        var pTypeC = String(permitRows[p].toiletType || '').toUpperCase();
        var pLimitC = Number(permitRows[p].durationLimitMinutes) ||
          (pTypeC === 'BAB' ? settings.toiletBabMinutes : pTypeC === 'BAK' ? settings.toiletBakMinutes : maxToiletMin) ||
          maxToiletMin;
        if (Number(permitRows[p].durationMinutes || 0) > pLimitC) exceededToilet++;
      }
    }

    var issues = [];
    if (alpaCount >= maxAlpa) issues.push('Alpa ' + alpaCount + 'x');
    if (lateCount >= maxLate) issues.push('Terlambat ' + lateCount + 'x');
    if (exceededToilet >= maxToilet || totalToilet >= maxToilet * 2) issues.push('Izin Toilet ' + totalToilet + 'x (' + exceededToilet + 'x melebihi batas)');

    if (issues.length > 0) {
      var isRed = alpaCount >= maxAlpa * 2 || lateCount >= maxLate * 2 || exceededToilet >= maxToilet * 2;
      problems.push({
        studentId: st.id,
        studentName: st.name,
        nis: String(st.nis || ''),
        className: classMap[String(st.classId)] || '-',
        parentPhone: String(st.parentPhone || ''),
        alpaCount: alpaCount,
        lateCount: lateCount,
        toiletExceededCount: exceededToilet,
        totalToiletCount: totalToilet,
        warningLevel: isRed ? 'MERAH' : 'KUNING',
        issues: issues
      });
    }
  }

  return { success: true, data: problems };
}

function handleGetLogs_(ss, limit) {
  var rows = readActiveRows_(ss, 'Log');
  var sliced = rows.slice(-Math.min(500, limit || 100)).reverse().map(function (lg) {
    return {
      id: lg.id,
      userId: lg.pengguna || 'system',
      action: lg.aksi || '',
      entity: lg.entitas || '',
      entityId: lg.id_entitas || '',
      details: lg.detail || '',
      createdAt: lg.waktu || lg.diubah_pada || '',
      updatedAt: lg.diubah_pada || '',
      updatedBy: lg.pengguna || 'system'
    };
  });
  return { success: true, data: sliced };
}
