# Petunjuk Deploy Google Apps Script Web App (Database Tunggal Google Sheets + Drive)

Aplikasi ini menggunakan **Google Sheets** sebagai satu-satunya database dan **Google Drive** untuk menyimpan foto & database wajah secara privat dan rapi melalui **Google Apps Script (`doGet` dan `doPost`)** — **tanpa Service Account, tanpa Google Cloud Console, dan tanpa Firebase**.

Aplikasi **dapat membuat Google Spreadsheet & Folder Google Drive sendiri secara otomatis** (termasuk subfolder rapi `01_Database_Wajah_Siswa`, `02_Database_Wajah_Guru`, `03_Foto_Kartu_Siswa`).

---

## Langkah 1: Buat Proyek Google Apps Script
1. Buka [script.google.com](https://script.google.com) → klik **New project** (*Proyek baru*).
2. Beri nama proyek, misalnya `Backend Presensi Mambaul Ulum`.
3. Hapus seluruh isi bawaan `Code.gs`, lalu **salin & tempel** seluruh isi file `/google-apps-script/Code.gs` (atau salin dari menu **Admin → Pengaturan & Apps Script**).
4. Tekan **Ctrl+S** (*Simpan*).

---

## Langkah 2: Isi `SECRET_TOKEN` (Cukup Token Saja, Sheet & Drive Dibuat Otomatis!)
1. Di editor Apps Script sebelah kiri, klik ikon roda gigi **Project Settings** (*Setelan Proyek*).
2. Gulir ke bagian **Script Properties** (*Properti Skrip*) → klik **Add script property** (*Tambahkan properti skrip*).
3. Tambahkan properti wajib:
   - `SECRET_TOKEN` → buat token rahasia acak yang panjang/kuat (contoh: `mu-presensi-2026-rahasia-xyz987`).
4. *(Opsional)* Jika Anda ingin memakai Spreadsheet / Folder Drive yang sudah ada, Anda boleh menambahkan `SPREADSHEET_ID` dan `DRIVE_FOLDER_ID`. Jika dibiarkan kosong, **aplikasi akan membuatkannya secara otomatis** saat Anda menghubungkan Web App atau menekan tombol **Buat Database Sheet & Drive Otomatis**.
   - Anda juga bisa memilih fungsi `setupOtomatisDariEditor` di toolbar atas editor Apps Script lalu klik **Run** (*Jalankan*) untuk langsung membuat semuanya dari editor.
5. Klik **Save script properties**.

---

## Langkah 3: Deploy sebagai Web App
1. Klik tombol **Deploy** (kanan atas) → pilih **New deployment** (*Deploy baru*).
2. Pada **Select type** (ikon roda gigi), pilih **Web app** (*Aplikasi web*).
3. Isi konfigurasi berikut:
   - **Description**: `API Presensi v1`
   - **Execute as**: **Me** (*Saya*)
   - **Who has access**: **Anyone** (*Siapa saja — aman karena setiap request `doGet` & `doPost` wajib membawa `SECRET_TOKEN`*)
4. Klik **Deploy** dan berikan **Authorize access** (*Izinkan akses Sheets & Drive*).
5. Salin **Web app URL** yang berakhiran `/exec`.

---

## Langkah 4: Tempel & Kunci di Menu Superadmin (Sekali Saja — Berlaku di Lokal & Vercel)
1. Buka aplikasi Presensi → klik ikon **orang kecil** di pojok kanan atas bilah navigasi → login sebagai **Superadmin** (`superadmin` / `superadmin123`).
2. Tempelkan:
   - **URL Web App Google Apps Script** (`https://script.google.com/macros/s/.../exec`)
   - **Token Rahasia (`SECRET_TOKEN`)**
3. Klik **Simpan & Kunci URL + Token**.
   - Aplikasi otomatis menyimpan & mengunci konfigurasi secara lokal dan ke backend (`/api/gas-config`), serta menyediakan **Tautan Akses Terkunci (1-Klik)** maupun variabel **Vercel Environment Variables** (`APPS_SCRIPT_URL` & `APPS_SCRIPT_TOKEN` / `VITE_APPS_SCRIPT_URL` & `VITE_APPS_SCRIPT_TOKEN`) sehingga pengguna lain tidak perlu menempel ulang URL & Token.
   - Jika `SPREADSHEET_ID` dan `DRIVE_FOLDER_ID` masih kosong, klik tombol **Buat / Siapkan Database Sheet & Drive** agar aplikasi **langsung membuat Google Spreadsheet baru (12 sheet lengkap) beserta Folder Google Drive + subfolder rapi** untuk database wajah siswa & guru.
   - Setiap pendaftaran wajah otomatis tersimpan rapi di Drive:
     - `01_Database_Wajah_Siswa/<Kelas> - <NIS> - <Nama Siswa> - Wajah.jpg`
     - `02_Database_Wajah_Guru/<NIP> - <Nama Guru> - Wajah.jpg`

---

## Akun Default Awal
- **Superadmin**: `superadmin` / `superadmin123` *(ikon orang kecil di navbar → pengaturan & penguncian URL + Token)*
- **Admin**: `admin` / `admin123`
- **Kepala Sekolah**: `kepsek` / `kepsek123` *(akses menu **Kepala Sekolah → Cek Sistem**)*
- **Guru**: `guru1` / `guru123` *(masuk ke ruang kerja Presensi Guru & Riwayat)*
- **Wali Kelas**: `wali1` / `guru123` *(masuk ke ruang kerja kelas masing-masing)*
- **BK**: `bk1` / `bk123` *(masuk ke ruang kerja BK & Kesiswaan)*

> **Catatan Pembaruan Skrip**: Jika suatu saat Anda memperbarui kode `Code.gs`, pilih **Deploy → Manage deployments → Edit (ikon pensil) → New version → Deploy** agar URL `/exec` tetap sama.
