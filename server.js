"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number.parseInt(process.env.PORT || "5080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PHOTO_SIZE = 3.5 * 1024 * 1024;
const SESSION_COOKIE = "Absensi.Admin";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_TIME_ZONE = "Asia/Makassar";
const configuredTimeZone = (process.env.APP_TIME_ZONE || "")
  .trim()
  .replace(/^(['"])(.*)\1$/, "$2")
  .trim();
let APP_TIME_ZONE = configuredTimeZone || DEFAULT_TIME_ZONE;
const STATIC_DIRECTORY = path.join(__dirname, "wwwroot");
const PHOTO_BUCKET = "attendance-photos";
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE, files: 1, fields: 4, fieldSize: 512 * 1024 }
});
let supabase;
let sessionSecret;

try {
  new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE });
} catch {
  console.warn(
    `Invalid APP_TIME_ZONE ${JSON.stringify(process.env.APP_TIME_ZONE)}; using ${DEFAULT_TIME_ZONE}.`
  );
  APP_TIME_ZONE = DEFAULT_TIME_ZONE;
}

function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.");
  }
  supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return supabase;
}

function getSessionSecret() {
  if (sessionSecret) return sessionSecret;
  const configuredSecret = process.env.SESSION_SECRET;
  if (!configuredSecret || Buffer.byteLength(configuredSecret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  sessionSecret = Buffer.from(configuredSecret, "utf8");
  return sessionSecret;
}

function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function fetchAllRows(queryFactory) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = unwrap(await queryFactory().range(offset, offset + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function zonedParts(value = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}

function localDate(value = new Date()) {
  const { year, month, day } = zonedParts(value);
  return `${year}-${month}-${day}`;
}

function dateOffset(value, offset) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function attendanceMinutes(createdAt) {
  const { hour, minute } = zonedParts(new Date(createdAt));
  return Number(hour) * 60 + Number(minute);
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

async function getAttendanceRules() {
  const row = unwrap(await getSupabase().from("attendance_rules")
    .select("start_time,end_time,tolerance_minutes,late_limit_minutes")
    .eq("id", 1)
    .single());
  return {
    startTime: row.start_time,
    endTime: row.end_time,
    toleranceMinutes: row.tolerance_minutes,
    lateLimitMinutes: row.late_limit_minutes
  };
}

function publicField(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    options: row.options_json,
    required: row.required
  };
}

function publicPerson(row) {
  return { id: row.id, name: row.name };
}

async function hasAdmin() {
  const result = await getSupabase().from("admins").select("id").eq("id", 1).maybeSingle();
  return Boolean(unwrap(result));
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
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

async function adminUser(request) {
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

  const admin = unwrap(await getSupabase().from("admins")
    .select("username,password_hash")
    .eq("id", 1)
    .maybeSingle());
  if (!admin || admin.username.toLowerCase() !== session.username.toLowerCase() ||
      admin.password_hash !== session.passwordHash) return null;
  return admin.username;
}

function setAdminCookie(request, response, username, passwordHash) {
  const payload = Buffer.from(JSON.stringify({
    username,
    passwordHash,
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000
  })).toString("base64url");
  const value = `${payload}.${signPayload(payload)}`;
  const secure = process.env.COOKIE_SECURE === "true" || request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_DURATION_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

function clearAdminCookie(request, response) {
  const secure = process.env.COOKIE_SECURE === "true" || request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

async function requireAdmin(request, response, next) {
  try {
    const username = await adminUser(request);
    if (!username) return sendError(response, 401, "Silakan masuk sebagai admin.");
    request.adminUsername = username;
    return next();
  } catch (error) {
    return next(error);
  }
}

function limitAttendanceRequest(request, response, next) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_SIZE + 576 * 1024) {
    return sendError(response, 413, "Ukuran formulir dan foto melebihi batas.");
  }
  return next();
}

async function limitAdminAuthentication(request, response, next) {
  try {
    const address = request.ip || request.socket.remoteAddress || "unknown";
    const attemptKey = crypto.createHmac("sha256", getSessionSecret()).update(address).digest("hex");
    const count = unwrap(await getSupabase().rpc("register_admin_auth_attempt", {
      p_attempt_key: attemptKey
    }));
    if (count > 5) return sendError(response, 429, "Terlalu banyak percobaan. Coba lagi dalam satu menit.");
    return next();
  } catch (error) {
    return next(error);
  }
}

async function dashboardData() {
  const today = localDate();
  const firstDay = dateOffset(today, -6);
  const database = getSupabase();
  const [totalResult, todayResult, weekResult, dailyRows, fieldsRows, recordsRows, peopleRows, rules] = await Promise.all([
    database.from("attendance").select("id", { count: "exact", head: true }),
    database.from("attendance").select("id", { count: "exact", head: true }).eq("created_local_date", today),
    database.from("attendance").select("id", { count: "exact", head: true }).gte("created_local_date", firstDay).lte("created_local_date", today),
    fetchAllRows(() => database.from("attendance").select("created_local_date").gte("created_local_date", firstDay).lte("created_local_date", today).order("created_local_date")),
    database.from("custom_fields").select("id,label,type,options_json,required").order("id"),
    database.from("attendance").select("id,person_name,attendance_type,note,values_json,photo_path,created_at").order("id", { ascending: false }).limit(300),
    database.from("people").select("id,name").order("name"),
    getAttendanceRules()
  ]);
  const dailyCountsMap = new Map();
  for (const row of dailyRows) {
    dailyCountsMap.set(row.created_local_date, (dailyCountsMap.get(row.created_local_date) ?? 0) + 1);
  }
  const dailyCounts = Array.from({ length: 7 }, (_, offset) => {
    const date = dateOffset(firstDay, offset);
    return { date, count: dailyCountsMap.get(date) ?? 0 };
  });
  const fields = unwrap(fieldsRows).map(publicField);
  const records = unwrap(recordsRows).map(record => ({
    id: record.id,
    name: record.person_name,
    type: record.attendance_type,
    note: record.note,
    values: record.values_json,
    hasPhoto: Boolean(record.photo_path),
    createdAt: record.created_at
  }));

  return {
    today,
    stats: {
      total: totalResult.count ?? 0,
      today: todayResult.count ?? 0,
      lastSevenDays: weekResult.count ?? 0
    },
    dailyCounts,
    records,
    rules,
    people: unwrap(peopleRows).map(publicPerson),
    fields
  };
}

async function monthlyAttendanceSummary(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const today = localDate();
  const now = zonedParts();
  const isCurrentMonth = month === today.slice(0, 7);
  const lastCalendarDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const rules = await getAttendanceRules();
  const currentDayIncluded = isCurrentMonth &&
    Number(now.hour) * 60 + Number(now.minute) >= timeToMinutes(rules.endTime);
  let daysToInclude = lastCalendarDay;
  if (isCurrentMonth) {
    daysToInclude = Number(today.slice(8, 10));
    if (!currentDayIncluded) daysToInclude -= 1;
  }

  const queryEndDay = isCurrentMonth ? Number(today.slice(8, 10)) : daysToInclude;
  const endDate = `${month}-${String(Math.max(queryEndDay, 1)).padStart(2, "0")}`;
  const database = getSupabase();
  const [records, people] = await Promise.all([
    queryEndDay > 0
      ? fetchAllRows(() => database.from("attendance")
        .select("person_name,attendance_type,created_at,created_local_date")
        .gte("created_local_date", `${month}-01`)
        .lte("created_local_date", endDate)
        .order("created_local_date")
        .order("created_at"))
      : Promise.resolve([]),
    fetchAllRows(() => database.from("people").select("name,created_local_date").order("name"))
  ]);
  const byPerson = new Map();
  for (const record of records) {
    const personKey = record.person_name.toLocaleLowerCase();
    if (!byPerson.has(personKey)) byPerson.set(personKey, new Map());
    const days = byPerson.get(personKey);
    if (!days.has(record.created_local_date)) days.set(record.created_local_date, {});
    const events = days.get(record.created_local_date);
    if (!events[record.attendance_type]) events[record.attendance_type] = [];
    events[record.attendance_type].push(record);
  }

  const startMinutes = timeToMinutes(rules.startTime);
  const endMinutes = timeToMinutes(rules.endTime);
  const employees = people.map(person => {
    const days = byPerson.get(person.name.toLocaleLowerCase()) ?? new Map();
    const summary = { name: person.name, late: 0, early: 0, lateDeparture: 0, absent: 0 };
    const joinedAfterMonth = person.created_local_date.slice(0, 7) > month;
    const firstEmployedDay = person.created_local_date.slice(0, 7) === month
      ? Number(person.created_local_date.slice(8, 10))
      : 1;

    for (let dayNumber = firstEmployedDay; !joinedAfterMonth && dayNumber <= daysToInclude; dayNumber += 1) {
      const date = `${month}-${String(dayNumber).padStart(2, "0")}`;
      const events = days.get(date);
      const arrival = events?.datang?.[0];
      const departures = events?.pulang ?? [];
      if (!arrival) {
        summary.absent += 1;
      } else {
        const minutesLate = attendanceMinutes(arrival.created_at) - startMinutes;
        if (minutesLate > rules.lateLimitMinutes) summary.absent += 1;
        else if (minutesLate > rules.toleranceMinutes) summary.late += 1;
        else if (minutesLate < 0) summary.early += 1;
      }
      if (departures.some(departure => attendanceMinutes(departure.created_at) > endMinutes)) {
        summary.lateDeparture += 1;
      }
    }

    if (isCurrentMonth && !currentDayIncluded && today >= person.created_local_date) {
      const todayEvents = days.get(today);
      const arrival = todayEvents?.datang?.[0];
      if (arrival) {
        const minutesLate = attendanceMinutes(arrival.created_at) - startMinutes;
        if (minutesLate > rules.lateLimitMinutes) summary.absent += 1;
        else if (minutesLate > rules.toleranceMinutes) summary.late += 1;
        else if (minutesLate < 0) summary.early += 1;
      }
      if ((todayEvents?.pulang ?? []).some(departure => attendanceMinutes(departure.created_at) > endMinutes)) {
        summary.lateDeparture += 1;
      }
    }
    return summary;
  });

  return {
    month,
    daysIncluded: Math.max(daysToInclude, 0),
    daysPending: isCurrentMonth ? lastCalendarDay - Math.max(daysToInclude, 0) : 0,
    currentDayIncluded,
    rules,
    employees
  };
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  return next();
});
app.use((request, response, next) => {
  if (!Buffer.isBuffer(request.body) || !request.is("application/json")) return next();
  if (request.body.length > 128 * 1024) {
    return sendError(response, 413, "Ukuran data yang dikirim melebihi batas.");
  }
  try {
    request.body = JSON.parse(request.body.toString("utf8"));
    return next();
  } catch {
    return sendError(response, 400, "Data JSON tidak valid.");
  }
});
app.use(express.json({ limit: "128kb" }));

app.get("/api/form", async (_request, response) => {
  const database = getSupabase();
  const [people, fields, rules] = await Promise.all([
    database.from("people").select("id,name").order("name"),
    database.from("custom_fields").select("id,label,type,options_json,required").order("id"),
    getAttendanceRules()
  ]);
  return response.json({
    people: unwrap(people).map(publicPerson),
    fields: unwrap(fields).map(publicField),
    rules
  });
});

app.get("/api/admin/status", async (_request, response) => {
  return response.json({ configured: await hasAdmin() });
});

app.post("/api/attendance", limitAttendanceRequest, upload.single("photo"), async (request, response) => {
  if (!request.is("multipart/form-data")) return sendError(response, 400, "Kirim data dalam format formulir.");
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const note = typeof request.body.note === "string" ? request.body.note.trim() : "";
  const attendanceType = request.body.attendanceType;
  if (name.length === 0 || name.length > 80) return sendError(response, 400, "Pilih nama yang valid.");
  if (note.length > 2000) return sendError(response, 400, "Keterangan maksimal 2.000 karakter.");
  if (attendanceType !== "datang" && attendanceType !== "pulang") {
    return sendError(response, 400, "Pilih jenis absensi: Datang atau Pulang.");
  }

  let values;
  try {
    values = JSON.parse(request.body.values ?? "{}");
    if (!values || Array.isArray(values) || typeof values !== "object") throw new Error();
  } catch {
    return sendError(response, 400, "Data kolom tambahan tidak valid.");
  }
  const database = getSupabase();
  const fields = unwrap(await database.from("custom_fields")
    .select("id,label,type,options_json,required")
    .order("id")).map(publicField);
  const fieldsById = new Map(fields.map(field => [String(field.id), field]));
  const savedValues = {};
  for (const field of fields) {
    const value = values[String(field.id)];
    const isMissing = value === undefined || value === null || value === "";
    if (field.required && (isMissing || (field.type === "checkbox" && value !== "true"))) {
      return sendError(response, 400, `Kolom “${field.label}” wajib diisi.`);
    }
  }
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

  const people = unwrap(await database.from("people").select("name"));
  const person = people.find(candidate => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!person) return sendError(response, 400, "Nama tidak ditemukan. Muat ulang formulir dan pilih nama yang tersedia.");
  if (!request.file) return sendError(response, 400, "Foto wajib diunggah.");
  const photoContentType = request.file.mimetype.toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(photoContentType) ||
      !hasValidImageSignature(request.file.buffer, photoContentType)) {
    return sendError(response, 400, "Gunakan foto JPG, PNG, atau WebP dengan format file yang valid.");
  }

  const today = localDate();
  const existing = await database.from("attendance")
    .select("id")
    .eq("person_name", person.name)
    .eq("created_local_date", today)
    .eq("attendance_type", attendanceType)
    .maybeSingle();
  unwrap(existing);
  if (existing.data) return sendError(response, 409, `Absensi ${attendanceType} sudah tercatat untuk nama ini hari ini.`);

  const photoPath = `${today}/${crypto.randomUUID()}.${photoContentType.split("/")[1]}`;
  unwrap(await database.storage.from(PHOTO_BUCKET).upload(photoPath, request.file.buffer, {
    contentType: photoContentType,
    upsert: false
  }));

  const createdAt = new Date().toISOString();
  const inserted = await database.from("attendance").insert({
    person_name: person.name,
    attendance_type: attendanceType,
    note,
    values_json: savedValues,
    photo_path: photoPath,
    photo_content_type: photoContentType,
    created_at: createdAt,
    created_local_date: today
  }).select("id").single();
  if (inserted.error) {
    const cleanup = await database.storage.from(PHOTO_BUCKET).remove([photoPath]);
    if (cleanup.error) console.error("Failed to clean up unattached attendance photo:", cleanup.error);
    if (inserted.error.code === "23505") {
      return sendError(response, 409, `Absensi ${attendanceType} sudah tercatat untuk nama ini hari ini.`);
    }
    throw inserted.error;
  }

  const rules = await getAttendanceRules();
  const minutesLate = attendanceMinutes(createdAt) - timeToMinutes(rules.startTime);
  let message = `Absensi ${attendanceType} berhasil disimpan.`;
  if (attendanceType === "datang" && minutesLate > rules.lateLimitMinutes) {
    message = "Absensi datang tercatat, tetapi melewati batas keterlambatan dan dihitung tidak masuk.";
  } else if (attendanceType === "datang" && minutesLate > rules.toleranceMinutes) {
    message = "Absensi datang tercatat sebagai terlambat.";
  } else if (attendanceType === "pulang" && attendanceMinutes(createdAt) > timeToMinutes(rules.endTime)) {
    message = "Absensi pulang tercatat terlambat.";
  }
  return response.json({ id: inserted.data.id, message });
});

app.post("/api/admin/setup", limitAdminAuthentication, async (request, response) => {
  if (await hasAdmin()) return sendError(response, 409, "Akun admin sudah dibuat. Silakan masuk.");
  const validation = validateCredentials(request.body?.username, request.body?.password);
  if (validation) return sendError(response, 400, validation);

  const username = request.body.username.trim();
  const salt = crypto.randomBytes(16);
  const passwordHash = await derivePasswordHash(request.body.password, salt);
  const inserted = await getSupabase().from("admins").insert({
    id: 1,
    username,
    salt: salt.toString("hex"),
    password_hash: passwordHash.toString("hex"),
    password_scheme: "scrypt"
  });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Akun admin sudah dibuat atau username sudah digunakan.");
  unwrap(inserted);
  setAdminCookie(request, response, username, passwordHash.toString("hex"));
  return response.json({ message: "Akun admin berhasil dibuat." });
});

app.post("/api/admin/login", limitAdminAuthentication, async (request, response) => {
  const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const admins = unwrap(await getSupabase().from("admins").select("username,salt,password_hash,password_scheme"));
  const admin = admins.find(candidate => candidate.username.toLowerCase() === username.toLowerCase());
  if (!admin || password.length > 200) return response.status(401).json({ error: "Username atau kata sandi salah." });
  const passwordHash = await verifyPasswordHash(password, Buffer.from(admin.salt, "hex"), admin.password_scheme);
  const expectedHash = Buffer.from(admin.password_hash, "hex");
  if (passwordHash.length !== expectedHash.length || !crypto.timingSafeEqual(passwordHash, expectedHash)) {
    return response.status(401).json({ error: "Username atau kata sandi salah." });
  }
  setAdminCookie(request, response, admin.username, admin.password_hash);
  return response.json({ message: "Berhasil masuk." });
});

const admin = express.Router();
admin.use(requireAdmin);

admin.post("/logout", (request, response) => {
  clearAdminCookie(request, response);
  return response.json({ message: "Anda telah keluar." });
});

admin.get("/data", async (_request, response) => response.json(await dashboardData()));

admin.get("/summary", async (request, response) => {
  const month = request.query.month;
  const currentMonth = localDate().slice(0, 7);
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return sendError(response, 400, "Pilih bulan rekap yang valid.");
  }
  if (month > currentMonth) return sendError(response, 400, "Rekap untuk bulan mendatang belum tersedia.");
  return response.json(await monthlyAttendanceSummary(month));
});

admin.post("/rules", async (request, response) => {
  const { startTime, endTime, toleranceMinutes, lateLimitMinutes } = request.body ?? {};
  const validTime = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime) || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    return sendError(response, 400, "Jam pulang harus lebih akhir daripada jam masuk.");
  }
  if (!Number.isInteger(toleranceMinutes) || toleranceMinutes < 0 || toleranceMinutes > 180) {
    return sendError(response, 400, "Toleransi keterlambatan harus antara 0 dan 180 menit.");
  }
  if (!Number.isInteger(lateLimitMinutes) || lateLimitMinutes < 1 ||
      lateLimitMinutes > 360 || lateLimitMinutes <= toleranceMinutes) {
    return sendError(response, 400, "Batas terlambat harus lebih besar daripada toleransi dan maksimal 360 menit.");
  }
  unwrap(await getSupabase().from("attendance_rules").update({
    start_time: startTime,
    end_time: endTime,
    tolerance_minutes: toleranceMinutes,
    late_limit_minutes: lateLimitMinutes
  }).eq("id", 1));
  return response.json({ message: "Aturan absensi berhasil disimpan.", rules: await getAttendanceRules() });
});

admin.post("/people", async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  if (name.length === 0 || name.length > 80) {
    return sendError(response, 400, "Nama wajib diisi (maksimal 80 karakter).");
  }
  const existingPeople = unwrap(await getSupabase().from("people").select("name"));
  if (existingPeople.some(person => person.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama tersebut sudah ada.");
  }
  const inserted = await getSupabase().from("people").insert({ name, created_local_date: localDate() });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Nama tersebut sudah ada.");
  unwrap(inserted);
  return response.json({ message: "Nama berhasil ditambahkan." });
});

admin.delete("/people/:id", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return sendError(response, 404, "Nama tidak ditemukan.");
  const deleted = unwrap(await getSupabase().from("people").delete().eq("id", id).select("id"));
  if (!deleted.length) return sendError(response, 404, "Nama tidak ditemukan.");
  return response.json({ message: "Nama berhasil dihapus." });
});

admin.post("/fields", async (request, response) => {
  const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
  const type = typeof request.body?.type === "string" ? request.body.type.trim().toLowerCase() : "";
  const required = request.body?.required === true;
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
  const existingFields = unwrap(await getSupabase().from("custom_fields").select("label"));
  if (existingFields.some(field => field.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama kolom tersebut sudah ada.");
  }
  const inserted = await getSupabase().from("custom_fields").insert({
    label,
    type,
    options_json: options,
    required
  });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Nama kolom tersebut sudah ada.");
  unwrap(inserted);
  return response.json({ message: "Kolom berhasil ditambahkan." });
});

admin.delete("/fields/:id", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return sendError(response, 404, "Kolom tidak ditemukan.");
  const deleted = unwrap(await getSupabase().from("custom_fields").delete().eq("id", id).select("id"));
  if (!deleted.length) return sendError(response, 404, "Kolom tidak ditemukan.");
  return response.json({ message: "Kolom berhasil dihapus." });
});

admin.post("/password", async (request, response) => {
  const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
  const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
  if (newPassword.length < 12 || newPassword.length > 200) {
    return sendError(response, 400, "Kata sandi baru harus terdiri dari minimal 12 karakter.");
  }
  const adminRow = unwrap(await getSupabase().from("admins")
    .select("username,salt,password_hash,password_scheme")
    .eq("id", 1)
    .maybeSingle());
  if (!adminRow || adminRow.username.toLowerCase() !== request.adminUsername.toLowerCase()) {
    return sendError(response, 400, "Kata sandi saat ini salah.");
  }
  const currentHash = await verifyPasswordHash(currentPassword, Buffer.from(adminRow.salt, "hex"), adminRow.password_scheme);
  const expectedHash = Buffer.from(adminRow.password_hash, "hex");
  if (currentHash.length !== expectedHash.length || !crypto.timingSafeEqual(currentHash, expectedHash)) {
    return sendError(response, 400, "Kata sandi saat ini salah.");
  }

  const salt = crypto.randomBytes(16);
  const passwordHash = await derivePasswordHash(newPassword, salt);
  unwrap(await getSupabase().from("admins").update({
    salt: salt.toString("hex"),
    password_hash: passwordHash.toString("hex"),
    password_scheme: "scrypt"
  }).eq("id", 1));
  clearAdminCookie(request, response);
  return response.json({ message: "Kata sandi berhasil diperbarui. Silakan masuk kembali." });
});

admin.get("/attendance/:id/photo", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return response.sendStatus(404);
  const record = unwrap(await getSupabase().from("attendance")
    .select("photo_path,photo_content_type")
    .eq("id", id)
    .maybeSingle());
  if (!record || !record.photo_path ||
      !["image/jpeg", "image/png", "image/webp"].includes(record.photo_content_type)) {
    return response.sendStatus(404);
  }
  const signed = unwrap(await getSupabase().storage.from(PHOTO_BUCKET).createSignedUrl(record.photo_path, 60));
  return response.redirect(signed.signedUrl);
});

app.use("/api/admin", admin);
app.use("/api", (_request, response) => sendError(response, 404, "Endpoint tidak ditemukan."));
app.use(express.static(STATIC_DIRECTORY, { index: "index.html" }));

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Ukuran foto maksimal 3,5 MiB."
      : "Batas formulir terlampaui. Periksa kembali data yang dikirim.";
    return sendError(response, 400, message);
  }
  if (error.type === "entity.too.large") return sendError(response, 413, "Ukuran data yang dikirim melebihi batas.");
  if (error.type === "entity.parse.failed") return sendError(response, 400, "Data JSON tidak valid.");
  console.error(error);
  return sendError(response, 500, "Terjadi kesalahan pada server.");
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Hadir berjalan di http://localhost:${PORT}`);
    console.log(`Zona waktu aplikasi: ${APP_TIME_ZONE}`);
  });
}

module.exports = app;
