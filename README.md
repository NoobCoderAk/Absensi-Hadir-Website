# Hadir — aplikasi absensi

Aplikasi absensi berbasis JavaScript dengan Node.js, Express, dan SQLite. Formulir absensi dapat dibuka tanpa login; pengaturan, riwayat, foto, dan analisis hanya tersedia setelah admin masuk.

## Menjalankan aplikasi

1. Pasang Node.js 20 atau yang lebih baru.
2. Dari folder proyek, pasang dependensi dan jalankan di PowerShell menggunakan `npm.cmd`. Di Windows, perintah `npm` dapat memilih skrip PowerShell `npm.ps1`, yang mungkin diblokir oleh Execution Policy:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

3. Buka `http://localhost:5080`.
4. Buka **Admin** untuk membuat username dan kata sandi admin pertama (minimal 12 karakter). Lakukan ini sebelum membagikan alamat aplikasi.
5. Tambahkan nama peserta dan kolom formulir dari **Pengaturan formulir**.

Server mendengarkan di semua antarmuka jaringan pada port `5080`, agar perangkat lain di jaringan yang sama dapat mengaksesnya melalui alamat IP komputer server, misalnya `http://192.168.1.10:5080`. Atur firewall jaringan seperlunya. Untuk akses melalui internet, tempatkan aplikasi di belakang reverse proxy dengan HTTPS dan setel `COOKIE_SECURE=true` serta `TRUST_PROXY=true`; formulir absensi memang tidak meminta login.

## Penyimpanan dan fitur

- Database berada di `data/absensi.db`; foto JPG, PNG, dan WebP (maksimal 5 MB) tersimpan sebagai BLOB di database.
- SQLite memakai WebAssembly melalui paket `sql.js`, sehingga tidak memerlukan kompilasi native.
- Admin dapat menambah/menghapus nama, serta menambahkan kolom bertipe teks, angka, tanggal, dropdown, atau centang.
- Panel admin menampilkan jumlah absensi, tren tujuh hari, riwayat terbaru, dan foto yang diunggah.
- Perhitungan harian dan tren mengikuti zona waktu komputer server.
- Kata sandi admin disimpan sebagai hash scrypt, bukan teks biasa. Sesi admin ditandatangani server, memakai cookie HTTP-only, dan kedaluwarsa setelah delapan jam.
- Autentikasi admin dibatasi hingga lima percobaan per menit per alamat IP.
- Data admin dari database versi C# lama yang menggunakan PBKDF2 tetap dapat dipakai; perubahan kata sandi mengalihkannya ke scrypt.
- Untuk mencadangkan data, hentikan aplikasi lalu salin `data/absensi.db` ke lokasi cadangan yang aman.

Jangan menghapus `data/absensi.db` atau `data/session-secret.key` jika ingin mempertahankan data dan sesi admin. Database SQLite dari versi C# sebelumnya dapat digunakan langsung. Jika lupa kata sandi admin, administrator server dapat menghapus baris admin dari tabel `admins` menggunakan SQLite; setelah itu admin dapat membuat akun baru tanpa menghapus data absensi. Setiap perubahan database disimpan ke disk secara langsung.
