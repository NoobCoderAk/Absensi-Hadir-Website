"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const initSqlJs = require("sql.js");

const PORT = Number.parseInt(process.env.PORT || "5080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PHOTO_SIZE = 5 * 1024 * 1024;
const SESSION_COOKIE = "Absensi.Admin";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const ROOT = __dirname;
const DATA_DIRECTORY = path.join(ROOT, "data");
const DATABASE_PATH = path.join(DATA_DIRECTORY, "absensi.db");
const SECRET_PATH = path.join(DATA_DIRECTORY, "session-secret.key");
const STATIC_DIRECTORY = path.join(ROOT, "wwwroot");
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE, files: 1, fields: 3, fieldSize: 512 * 1024 }
});
const authAttempts = new Map();
let database;
let sessionSecret;

function run(sql, parameters = {}) {
  database.run(sql, parameters);
}

function all(sql, parameters = {}) {
  const statement = database.prepare(sql, parameters);
  const rows = [];
  try {
    while (statement.step()) rows.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  return rows;
}

function first(sql, parameters = {}) {
  return all(sql, parameters)[0] ?? null;
}

function saveDatabase() {
  const temporaryPath = `${DATABASE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(database.export()));
  fs.renameSync(temporaryPath, DATABASE_PATH);
}

function localDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function derivePasswordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 32_768, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function verifyPasswordHash(password, salt, scheme) {
  if (scheme === "pbkdf2") {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, 310_000, 32, "sha256", (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  }
  return derivePasswordHash(password, salt);
}

function initializeDatabase(SQL) {
  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
  database = fs.existsSync(DATABASE_PATH)
    ? new SQL.Database(fs.readFileSync(DATABASE_PATH))
    : new SQL.Database();
  database.run("PRAGMA foreign_keys = ON;");
  database.run(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    );
    CREATE TABLE IF NOT EXISTS custom_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL COLLATE NOCASE UNIQUE,
      type TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      values_json TEXT NOT NULL DEFAULT '{}',
      photo BLOB,
      photo_content_type TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      password_scheme TEXT NOT NULL DEFAULT 'scrypt'
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_created_at ON attendance(created_at);
  `);

  const columns = all("PRAGMA table_info(attendance);");
  if (!columns.some(column => column.name === "created_local_date")) {
    database.run("ALTER TABLE attendance ADD COLUMN created_local_date TEXT;");
  }
  const adminColumns = all("PRAGMA table_info(admins);");
  if (!adminColumns.some(column => column.name === "password_scheme")) {
    database.run("ALTER TABLE admins ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'pbkdf2';");
  }
  for (const record of all("SELECT id, created_at FROM attendance WHERE created_local_date IS NULL OR created_local_date = '';")) {
    const date = new Date(record.created_at);
    run(
      "UPDATE attendance SET created_local_date = $date WHERE id = $id;",
      { $date: Number.isNaN(date.getTime()) ? localDate() : localDate(date), $id: record.id }
    );
  }
  if (fs.existsSync(DATABASE_PATH)) saveDatabase();

  try {
    sessionSecret = fs.readFileSync(SECRET_PATH);
    if (sessionSecret.length !== 32) throw new Error("Invalid admin session secret length.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sessionSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, sessionSecret, { flag: "wx", mode: 0o600 });
  }
}

function publicField(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    options: JSON.parse(row.options_json)
  };
}

function publicPerson(row) {
  return { id: row.id, name: row.name };
}

function hasAdmin() {
  return Boolean(first("SELECT id FROM admins WHERE id = 1;"));
}

function hasValidImageSignature(bytes, contentType) {
  switch (contentType) {
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    case "image/webp":
      return bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
    default:
      return false;
  }
}

function sendError(response, status, message) {
  return response.status(status).json({ error: message });
}

function validateCredentials(username, password) {
  const trimmedUsername = typeof username === "string" ? username.trim() : "";
  if (trimmedUsername.length < 3 || trimmedUsername.length > 40 ||
      !/^[a-zA-Z0-9_.-]+$/.test(trimmedUsername)) {
    return "Username harus terdiri dari 3–40 huruf, angka, titik, garis bawah, atau tanda hubung.";
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 200) {
    return "Kata sandi harus terdiri dari minimal 12 karakter.";
  }
  return null;
}

function parseCookie(request, cookieName) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const prefix = `${cookieName}=`;
  const cookie = cookies.find(value => value.trim().startsWith(prefix));
  return cookie ? cookie.trim().slice(prefix.length) : null;
}

function signPayload(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function adminUser(request) {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(signPayload(payload), "base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!session || typeof session.username !== "string" ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) return null;
  const admin = first("SELECT username, password_hash FROM admins WHERE id = 1;");
  if (!admin || admin.username.toLowerCase() !== session.username.toLowerCase() ||
      Buffer.from(admin.password_hash).toString("hex") !== session.passwordHash) return null;
  return admin.username;
}

function setAdminCookie(response, username, passwordHash) {
  const payload = Buffer.from(JSON.stringify({
    username,
    passwordHash: Buffer.from(passwordHash).toString("hex"),
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000
  })).toString("base64url");
  const value = `${payload}.${signPayload(payload)}`;
  const secure = process.env.COOKIE_SECURE === "true" || response.req.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_DURATION_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

function clearAdminCookie(response) {
  const secure = process.env.COOKIE_SECURE === "true" || response.req.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

function requireAdmin(request, response, next) {
  const username = adminUser(request);
  if (!username) return sendError(response, 401, "Silakan masuk sebagai admin.");
  request.adminUsername = username;
  next();
}

function limitAttendanceRequest(request, response, next) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_SIZE + 576 * 1024) {
    return sendError(response, 413, "Ukuran formulir dan foto melebihi batas.");
  }
  next();
}

function limitAdminAuthentication(request, response, next) {
  const now = Date.now();
  const address = request.ip || request.socket.remoteAddress || "unknown";
  let attempt = authAttempts.get(address);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + 60_000 };
    authAttempts.set(address, attempt);
  }
  if (attempt.count >= 5) return sendError(response, 429, "Terlalu banyak percobaan. Coba lagi dalam satu menit.");
  attempt.count += 1;
  next();
}

function dashboardData() {
  const today = localDate();
  const todayDate = new Date(`${today}T00:00:00`);
  const firstDay = new Date(todayDate);
  firstDay.setDate(firstDay.getDate() - 6);
  const firstDayString = localDate(firstDay);
  const stats = first(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN created_local_date = $today THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN created_local_date >= $firstDay THEN 1 ELSE 0 END) AS lastSevenDays
     FROM attendance;`,
    { $today: today, $firstDay: firstDayString }
  );

  const counts = new Map(all(
    `SELECT created_local_date AS date, COUNT(*) AS count
     FROM attendance WHERE created_local_date >= $firstDay AND created_local_date <= $today
     GROUP BY created_local_date;`,
    { $firstDay: firstDayString, $today: today }
  ).map(row => [row.date, row.count]));
  const dailyCounts = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(firstDay);
    date.setDate(firstDay.getDate() + offset);
    const day = localDate(date);
    dailyCounts.push({ date: day, count: counts.get(day) ?? 0 });
  }

  const fields = all("SELECT id, label, type, options_json FROM custom_fields ORDER BY id;").map(publicField);
  const fieldLabels = new Map(fields.map(field => [String(field.id), field.label]));
  const records = all(
    `SELECT id, person_name, note, values_json, photo IS NOT NULL AS hasPhoto, created_at
     FROM attendance ORDER BY id DESC LIMIT 300;`
  ).map(record => {
    const storedValues = JSON.parse(record.values_json);
    const values = Object.fromEntries(Object.entries(storedValues).map(([key, value]) => [
      fieldLabels.get(key) ?? key,
      value
    ]));
    return {
      id: record.id,
      name: record.person_name,
      note: record.note,
      values,
      hasPhoto: Boolean(record.hasPhoto),
      createdAt: record.created_at
    };
  });

  return {
    stats: {
      total: stats.total ?? 0,
      today: stats.today ?? 0,
      lastSevenDays: stats.lastSevenDays ?? 0
    },
    dailyCounts,
    records,
    people: all("SELECT id, name FROM people ORDER BY name COLLATE NOCASE;").map(publicPerson),
    fields
  };
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "128kb" }));

app.get("/api/form", (_request, response) => {
  response.json({
    people: all("SELECT id, name FROM people ORDER BY name COLLATE NOCASE;").map(publicPerson),
    fields: all("SELECT id, label, type, options_json FROM custom_fields ORDER BY id;").map(publicField)
  });
});

app.get("/api/admin/status", (_request, response) => {
  response.json({ configured: hasAdmin() });
});

app.post("/api/attendance", limitAttendanceRequest, upload.single("photo"), (request, response, next) => {
  try {
    if (!request.is("multipart/form-data")) return sendError(response, 400, "Kirim data dalam format formulir.");
    const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
    const note = typeof request.body.note === "string" ? request.body.note.trim() : "";
    if (name.length === 0 || name.length > 80) return sendError(response, 400, "Pilih nama yang valid.");
    if (note.length > 2000) return sendError(response, 400, "Keterangan maksimal 2.000 karakter.");

    let values;
    try {
      values = JSON.parse(request.body.values ?? "{}");
      if (!values || Array.isArray(values) || typeof values !== "object") throw new Error();
    } catch {
      return sendError(response, 400, "Data kolom tambahan tidak valid.");
    }

    const fields = all("SELECT id, label, type, options_json FROM custom_fields ORDER BY id;").map(publicField);
    const fieldsById = new Map(fields.map(field => [String(field.id), field]));
    const savedValues = {};
    for (const [fieldId, value] of Object.entries(values)) {
      const field = fieldsById.get(fieldId);
      if (!field) return sendError(response, 400, "Kolom absensi telah berubah. Muat ulang formulir.");
      if (typeof value !== "string" || value.length > 4000) {
        return sendError(response, 400, "Isi kolom tambahan terlalu panjang atau tidak valid.");
      }
      if (field.type === "select" && !field.options.includes(value)) {
        return sendError(response, 400, `Pilihan untuk kolom “${field.label}” tidak valid.`);
      }
      if (field.type === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
        return sendError(response, 400, `Isi kolom “${field.label}” harus berupa angka.`);
      }
      if (field.type === "date" && !isValidDate(value)) {
        return sendError(response, 400, `Isi kolom “${field.label}” harus berupa tanggal yang valid.`);
      }
      if (field.type === "checkbox" && value !== "true" && value !== "false") {
        return sendError(response, 400, `Isi kolom “${field.label}” tidak valid.`);
      }
      if (value.length > 0) savedValues[field.label] = value;
    }

    const person = first("SELECT name FROM people WHERE name = $name;", { $name: name });
    if (!person) {
      return sendError(response, 400, "Nama tidak ditemukan. Muat ulang formulir dan pilih nama yang tersedia.");
    }

    let photo = null;
    let photoContentType = null;
    if (request.file) {
      photo = request.file.buffer;
      photoContentType = request.file.mimetype.toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(photoContentType) ||
          !hasValidImageSignature(photo, photoContentType)) {
        return sendError(response, 400, "Gunakan foto JPG, PNG, atau WebP dengan format file yang valid.");
      }
    }

    run(
      `INSERT INTO attendance
         (person_name, note, values_json, photo, photo_content_type, created_at, created_local_date)
       VALUES
         ($name, $note, $values, $photo, $contentType, $createdAt, $localDate);`,
      {
        $name: person.name,
        $note: note,
        $values: JSON.stringify(savedValues),
        $photo: photo,
        $contentType: photoContentType,
        $createdAt: new Date().toISOString(),
        $localDate: localDate()
      }
    );
    const id = first("SELECT last_insert_rowid() AS id;").id;
    saveDatabase();
    return response.json({ id, message: "Absensi berhasil disimpan." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/setup", limitAdminAuthentication, async (request, response, next) => {
  try {
    if (hasAdmin()) return sendError(response, 409, "Akun admin sudah dibuat. Silakan masuk.");
    const validation = validateCredentials(request.body?.username, request.body?.password);
    if (validation) return sendError(response, 400, validation);

    const username = request.body.username.trim();
    const salt = crypto.randomBytes(16);
    const passwordHash = await derivePasswordHash(request.body.password, salt);
    if (hasAdmin()) return sendError(response, 409, "Akun admin sudah dibuat. Silakan masuk.");
    run("INSERT INTO admins (id, username, salt, password_hash, password_scheme) VALUES (1, $username, $salt, $hash, 'scrypt');", {
      $username: username,
      $salt: salt,
      $hash: passwordHash
    });
    saveDatabase();
    setAdminCookie(response, username, passwordHash);
    return response.json({ message: "Akun admin berhasil dibuat." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", limitAdminAuthentication, async (request, response, next) => {
  try {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const admin = first("SELECT username, salt, password_hash, password_scheme FROM admins WHERE username = $username;", {
      $username: username
    });
    if (!admin || password.length > 200) return response.status(401).json({ error: "Username atau kata sandi salah." });
    const passwordHash = await verifyPasswordHash(password, Buffer.from(admin.salt), admin.password_scheme);
    const expectedHash = Buffer.from(admin.password_hash);
    if (!crypto.timingSafeEqual(passwordHash, expectedHash)) {
      return response.status(401).json({ error: "Username atau kata sandi salah." });
    }
    setAdminCookie(response, admin.username, expectedHash);
    return response.json({ message: "Berhasil masuk." });
  } catch (error) {
    next(error);
  }
});

const admin = express.Router();
admin.use(requireAdmin);

admin.post("/logout", (request, response) => {
  clearAdminCookie(response);
  response.json({ message: "Anda telah keluar." });
});

admin.get("/data", (_request, response) => response.json(dashboardData()));

admin.post("/people", (request, response, next) => {
  try {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (name.length === 0 || name.length > 80) {
      return sendError(response, 400, "Nama wajib diisi (maksimal 80 karakter).");
    }
    if (first("SELECT id FROM people WHERE name = $name;", { $name: name })) {
      return sendError(response, 409, "Nama tersebut sudah ada.");
    }
    run("INSERT INTO people (name) VALUES ($name);", { $name: name });
    saveDatabase();
    return response.json({ message: "Nama berhasil ditambahkan." });
  } catch (error) {
    next(error);
  }
});

admin.delete("/people/:id", (request, response, next) => {
  try {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1 || !first("SELECT id FROM people WHERE id = $id;", { $id: id })) {
      return sendError(response, 404, "Nama tidak ditemukan.");
    }
    run("DELETE FROM people WHERE id = $id;", { $id: id });
    saveDatabase();
    return response.json({ message: "Nama berhasil dihapus." });
  } catch (error) {
    next(error);
  }
});

admin.post("/fields", (request, response, next) => {
  try {
    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    const type = typeof request.body?.type === "string" ? request.body.type.trim().toLowerCase() : "";
    if (label.length === 0 || label.length > 60) {
      return sendError(response, 400, "Nama kolom wajib diisi (maksimal 60 karakter).");
    }
    if (!["text", "number", "date", "select", "checkbox"].includes(type)) {
      return sendError(response, 400, "Tipe kolom tidak didukung.");
    }
    let options = [];
    if (type === "select") {
      const rawOptions = typeof request.body.options === "string" ? request.body.options : "";
      options = [...new Map(rawOptions.split(",").map(option => option.trim()).filter(Boolean)
        .map(option => [option.toLowerCase(), option])).values()];
      if (options.length < 2 || options.some(option => option.length > 60)) {
        return sendError(response, 400, "Kolom pilihan memerlukan minimal dua opsi (pisahkan dengan koma).");
      }
    }
    if (first("SELECT id FROM custom_fields WHERE label = $label;", { $label: label })) {
      return sendError(response, 409, "Nama kolom tersebut sudah ada.");
    }
    run(
      "INSERT INTO custom_fields (label, type, options_json) VALUES ($label, $type, $options);",
      { $label: label, $type: type, $options: JSON.stringify(options) }
    );
    saveDatabase();
    return response.json({ message: "Kolom berhasil ditambahkan." });
  } catch (error) {
    next(error);
  }
});

admin.delete("/fields/:id", (request, response, next) => {
  try {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1 || !first("SELECT id FROM custom_fields WHERE id = $id;", { $id: id })) {
      return sendError(response, 404, "Kolom tidak ditemukan.");
    }
    run("DELETE FROM custom_fields WHERE id = $id;", { $id: id });
    saveDatabase();
    return response.json({ message: "Kolom berhasil dihapus." });
  } catch (error) {
    next(error);
  }
});

admin.post("/password", async (request, response, next) => {
  try {
    const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
    const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
    if (newPassword.length < 12 || newPassword.length > 200) {
      return sendError(response, 400, "Kata sandi baru harus terdiri dari minimal 12 karakter.");
    }
    const adminRow = first("SELECT username, salt, password_hash, password_scheme FROM admins WHERE id = 1;");
    if (!adminRow || adminRow.username.toLowerCase() !== request.adminUsername.toLowerCase()) {
      return sendError(response, 400, "Kata sandi saat ini salah.");
    }
    const currentHash = await verifyPasswordHash(currentPassword, Buffer.from(adminRow.salt), adminRow.password_scheme);
    const expectedHash = Buffer.from(adminRow.password_hash);
    if (!crypto.timingSafeEqual(currentHash, expectedHash)) {
      return sendError(response, 400, "Kata sandi saat ini salah.");
    }

    const salt = crypto.randomBytes(16);
    const passwordHash = await derivePasswordHash(newPassword, salt);
    run("UPDATE admins SET salt = $salt, password_hash = $hash, password_scheme = 'scrypt' WHERE id = 1;", {
      $salt: salt,
      $hash: passwordHash
    });
    saveDatabase();
    clearAdminCookie(response);
    return response.json({ message: "Kata sandi berhasil diperbarui. Silakan masuk kembali." });
  } catch (error) {
    next(error);
  }
});

admin.get("/attendance/:id/photo", (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return response.sendStatus(404);
  const photo = first(
    "SELECT photo, photo_content_type FROM attendance WHERE id = $id AND photo IS NOT NULL;",
    { $id: id }
  );
  if (!photo || !["image/jpeg", "image/png", "image/webp"].includes(photo.photo_content_type)) {
    return response.sendStatus(404);
  }
  response.type(photo.photo_content_type).send(Buffer.from(photo.photo));
});

app.use("/api/admin", admin);
app.use(express.static(STATIC_DIRECTORY, { index: "index.html" }));
app.get("*path", (_request, response) => response.sendFile(path.join(STATIC_DIRECTORY, "index.html")));

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Ukuran foto maksimal 5 MB."
      : "Batas formulir terlampaui. Periksa kembali data yang dikirim.";
    return sendError(response, 400, message);
  }
  if (error.type === "entity.too.large") {
    return sendError(response, 413, "Ukuran data yang dikirim melebihi batas.");
  }
  if (error.type === "entity.parse.failed") {
    return sendError(response, 400, "Data JSON tidak valid.");
  }
  console.error(error);
  return sendError(response, 500, "Terjadi kesalahan pada server.");
});

async function start() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(path.dirname(require.resolve("sql.js")), file)
  });
  initializeDatabase(SQL);
  app.listen(PORT, HOST, () => {
    console.log(`Hadir berjalan di http://localhost:${PORT}`);
    console.log(`Akses jaringan lokal: http://<IP-server>:${PORT}`);
  });
}

start().catch(error => {
  console.error("Gagal menjalankan aplikasi:", error);
  process.exitCode = 1;
});
