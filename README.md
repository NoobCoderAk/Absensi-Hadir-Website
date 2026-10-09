# Hadir — aplikasi absensi

Aplikasi absensi berbasis JavaScript. Frontend statis di-host Netlify, API berjalan sebagai Netlify Function, database menggunakan Supabase PostgreSQL, dan foto disimpan di Supabase Storage. Form absensi tidak memerlukan login; panel pengaturan dan analisis hanya tersedia untuk admin.

## Deploy ke Netlify dan Supabase

### 1. Siapkan database Supabase

1. Buat project Supabase baru.
2. Buka **SQL Editor**, lalu jalankan seluruh isi [`supabase/schema.sql`](./supabase/schema.sql). Langkah ini membuat tabel kosong, lima kategori shift, aturan default absensi, pembatasan akses, rate limiter admin, dan bucket privat `attendance-photos`.
3. Dari **Project Settings → API**, salin **Project URL** dan **service_role key**. Jangan pernah menaruh service role key di kode browser, repositori, atau variabel yang berawalan `VITE_`/`NEXT_PUBLIC_`.

### 2. Deploy situs di Netlify

1. Hubungkan repositori ini ke Netlify. Konfigurasi pada `netlify.toml` mengatur folder publik, fungsi API, serta rewrite `/api/*`.
2. Di **Site configuration → Environment variables**, tambahkan:
   - `SUPABASE_URL`: Project URL Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service role key dari Supabase.
   - `SESSION_SECRET`: secret acak minimal 32 byte. Buat dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
   - `APP_TIME_ZONE` (opsional): `Asia/Makassar` untuk zona UTC+08. Jika tidak disetel atau nilainya tidak valid, server memakai `Asia/Makassar`; nilai tidak valid akan dicatat sebagai peringatan pada log fungsi. Zona waktu lain yang valid misalnya `Asia/Jakarta` atau `Asia/Jayapura`.
   - `COOKIE_SECURE`: `true`.
   - `TRUST_PROXY`: `true`.
3. Deploy ulang setelah mengisi environment variables.
4. Buka situs, masuk ke tab **Admin**, lalu buat akun admin pertama dengan kata sandi minimal 12 karakter. Buat akun sebelum membagikan tautan absensi.
5. Tambahkan nama karyawan dan kolom formulir dari **Pengaturan formulir**.

Database Supabase baru dimulai kosong. Database SQLite lokal di `data/absensi.db` dan kunci sesi lokal tidak dipindahkan maupun dihapus.

### Memperbarui project Supabase yang sudah dibuat

Jika skema dasar atau migrasi jadwal sebelumnya sudah pernah dijalankan, jangan jalankan ulang schema penuh. Jalankan [`supabase/migrations/20261009_employee_selected_schedule.sql`](./supabase/migrations/20261009_employee_selected_schedule.sql) melalui **SQL Editor** Supabase sebelum deploy kode terbaru. Migrasi aman dijalankan ulang dan menambahkan shift pada setiap catatan absensi. Catatan lama memakai kategori yang dahulu ditetapkan untuk karyawan; jika informasi itu tidak tersedia, catatan lama diisi kategori **Karyawan Shift Pagi**. Migrasi juga membuat pengunci database agar satu karyawan tidak dapat menyimpan dua kategori shift berbeda pada tanggal yang sama, termasuk bila dua permintaan masuk bersamaan.

### Pengembangan lokal

1. Pasang Node.js 22 atau yang lebih baru.
2. Salin `.env.example` menjadi `.env`, lalu isi variabel Supabase dan secret di atas. File `.env` diabaikan Git.
3. Instal dependensi dan jalankan server:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

4. Buka `http://localhost:5080`. Untuk menguji rewrite dan fungsi Netlify secara lokal, instal Netlify CLI secara terpisah lalu jalankan `netlify dev`.

## Fitur dan aturan

- Foto JPG, PNG, atau WebP wajib diunggah. Batas file adalah 3,5 MiB agar formulir multipart tetap di bawah batas payload Netlify Functions.
- Setiap absensi wajib memilih shift aktif dan jenis **Datang** atau **Pulang**. Shift yang dipilih pada absensi pertama hari itu dikunci; absensi berikutnya pada tanggal yang sama harus menggunakan shift tersebut. Pada tanggal berikutnya, karyawan bebas memilih shift yang sedang dijalani. Setiap karyawan hanya dapat mengirim satu absensi untuk tiap jenis pada tanggal yang sama.
- Admin dapat menambah/menghapus nama, menambahkan kolom bertipe teks, angka, tanggal, dropdown, atau centang, serta memilih apakah kolom tambahan wajib diisi.
- Tersedia lima kategori shift yang jamnya dapat diedit admin: Karyawan Shift Pagi (07.00–17.00), Karyawan Shift Siang (14.00–22.00), Admin 1 (07.00–17.00), Admin 2 (09.00–18.00), dan Koordinator (11.00–19.30). Karyawan memilih kategori yang sesuai dengan rolling shift mereka ketika mengisi formulir.
- Toleransi awal 5 menit dan batas terlambat 15 menit berlaku untuk semua kategori; admin dapat mengubahnya. Jam pulang tiap kategori harus lebih akhir daripada jam masuk pada hari yang sama.
- Datang sampai batas toleransi tidak dihitung terlambat; lewat toleransi sampai batas terlambat dihitung terlambat; setelah batas terlambat dihitung tidak masuk. Aturan aktif juga diterapkan pada rekap bulan sebelumnya.
- Rekap bulanan menampilkan kategori shift yang digunakan serta terlambat, masuk awal, pulang terlambat, dan tidak masuk/libur per karyawan. Tidak masuk dihitung bila tidak ada absensi Datang atau absensi Datang melewati batas. Untuk hari ini, karyawan tanpa absensi baru dihitung tidak masuk setelah jam pulang kategori yang paling akhir.
- Jam kategori yang sedang aktif digunakan untuk menilai absensi lama saat rekap dihitung ulang; perubahan jam jadwal memengaruhi perhitungan bulan-bulan sebelumnya.
- Tanggal dan jam absensi dihitung memakai `APP_TIME_ZONE` (default `Asia/Makassar`), bukan zona waktu sementara mesin server Netlify.
- Data foto berada di bucket Supabase Storage privat. Tautan foto panel admin ditandatangani dan hanya berlaku singkat.
- Tabel database mengaktifkan Row Level Security tanpa akses langsung untuk pengguna anonim; API memakai service role key hanya di lingkungan server.
- Kata sandi admin disimpan sebagai hash scrypt. Sesi memakai cookie HTTP-only, SameSite Strict, berdurasi delapan jam, serta ditandatangani `SESSION_SECRET`.
- Percobaan pembuatan akun dan login admin dibatasi hingga lima kali per menit per alamat IP dengan penghitung atomik di database.

## Operasional dan keamanan

- Simpan `SUPABASE_SERVICE_ROLE_KEY` dan `SESSION_SECRET` sebagai rahasia environment Netlify. Jika `SESSION_SECRET` berubah, sesi admin aktif akan tidak berlaku.
- Atur backup database dan Storage dari project Supabase, dan pantau kuota penyimpanan karena foto tetap menambah penggunaan storage.
- Jangan membuat bucket foto publik atau menambahkan policy anonim untuk tabel aplikasi.
- Untuk menonaktifkan akses, hapus atau ubah environment variables di Netlify dan gunakan pengaturan project Supabase.
