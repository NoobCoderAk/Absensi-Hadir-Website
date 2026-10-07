const $ = (selector, root = document) => root.querySelector(selector);
const attendanceView = $("#attendance-view");
const adminView = $("#admin-view");
const attendanceNav = $("#attendance-nav");
const adminNav = $("#admin-nav");
const toast = $("#toast");
let currentForm = { people: [], fields: [] };
let adminData = null;
let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { "Content-Type": "application/json", ...options.headers }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || (response.status === 401 ? "Silakan masuk sebagai admin." : "Permintaan tidak berhasil."));
    error.status = response.status;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast${isError ? " toast-error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3600);
}

function setView(view) {
  const isAdmin = view === "admin";
  attendanceView.classList.toggle("hidden", isAdmin);
  adminView.classList.toggle("hidden", !isAdmin);
  attendanceNav.classList.toggle("active", !isAdmin);
  adminNav.classList.toggle("active", isAdmin);
  if (isAdmin) {
    window.location.hash = "admin";
    openAdmin();
  } else {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

function renderCustomInput(field) {
  const id = `custom-${field.id}`;
  const label = `<label class="field-label" for="${id}">${escapeHtml(field.label)} <span class="optional-label">Opsional</span></label>`;
  if (field.type === "select") {
    const choices = field.options.map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
    return `${label}<div class="select-wrap"><select id="${id}" data-field-id="${field.id}"><option value="">Pilih opsi</option>${choices}</select><span class="select-chevron" aria-hidden="true">⌄</span></div>`;
  }
  if (field.type === "checkbox") {
    return `<label class="checkbox-field" for="${id}"><input id="${id}" type="checkbox" data-field-id="${field.id}"><span>${escapeHtml(field.label)}</span></label>`;
  }
  return `${label}<input id="${id}" type="${escapeHtml(field.type)}" data-field-id="${field.id}" ${field.type === "number" ? 'step="any"' : ""} placeholder="${field.type === "text" ? "Isi " + escapeHtml(field.label.toLowerCase()) : ""}">`;
}

async function loadForm() {
  currentForm = await api("/api/form");
  const select = $("#person-select");
  select.innerHTML = `<option value="">Pilih namamu</option>${currentForm.people.map(person =>
    `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)}</option>`
  ).join("")}`;
  $("#custom-fields").innerHTML = currentForm.fields.map(renderCustomInput).join("");
  if (!currentForm.people.length) {
    select.disabled = true;
    select.innerHTML = `<option value="">Nama belum ditambahkan oleh admin</option>`;
    if (!$(".inline-hint")) {
      const hint = document.createElement("p");
      hint.className = "inline-hint";
      hint.innerHTML = 'Belum ada nama. Minta admin menambahkan nama lewat <button type="button" data-open-admin>panel admin</button>.';
      select.closest(".select-wrap").after(hint);
    }
  } else {
    select.disabled = false;
    $(".inline-hint")?.remove();
  }
}

function renderAuth(configured) {
  const title = configured ? "Masuk ke panel admin" : "Siapkan akun admin";
  const subtitle = configured
    ? "Pengaturan dan analisis hanya tersedia untuk admin."
    : "Buat akun admin pertama sebelum membagikan tautan absensi.";
  $("#admin-auth").innerHTML = `
    <section class="auth-card">
      <span class="step-label">AREA TERBATAS <span>ADMIN</span></span>
      <div class="auth-symbol" aria-hidden="true">⌑</div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
      <form id="${configured ? "admin-login-form" : "admin-setup-form"}" class="stacked-form">
        <label class="field-label" for="admin-username">Username</label>
        <input id="admin-username" name="username" autocomplete="username" minlength="3" maxlength="40" required>
        <label class="field-label" for="admin-password">${configured ? "Kata sandi" : "Buat kata sandi"}</label>
        <input id="admin-password" name="password" type="password" autocomplete="${configured ? "current-password" : "new-password"}" ${configured ? "" : 'minlength="12"'} required>
        ${configured ? "" : '<p class="form-hint">Gunakan minimal 12 karakter. Simpan dengan aman; akun ini tidak memiliki fitur pemulihan otomatis.</p>'}
        <button class="button button-primary" type="submit">${configured ? "Masuk ke panel" : "Buat akun admin"} <span aria-hidden="true">→</span></button>
        <div class="auth-error" id="auth-error" role="alert"></div>
      </form>
    </section>`;
}

async function openAdmin() {
  adminData = null;
  $("#admin-dashboard").classList.add("hidden");
  $("#admin-auth").classList.remove("hidden");
  try {
    const data = await api("/api/admin/data");
    adminData = data;
    renderDashboard(data);
    $("#admin-auth").classList.add("hidden");
    $("#admin-dashboard").classList.remove("hidden");
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message, true);
      return;
    }
    try {
      const status = await api("/api/admin/status");
      renderAuth(status.configured);
    } catch (statusError) {
      showToast(statusError.message, true);
    }
  }
}

function renderRecord(record) {
  const values = record.values || {};
  const custom = Object.entries(values).map(([label, value]) =>
    `<span class="record-extra"><b>${escapeHtml(label)}:</b> ${escapeHtml(value === "true" ? "Ya" : value === "false" ? "Tidak" : value)}</span>`
  ).join("");
  const photo = record.hasPhoto
    ? `<a class="photo-link" href="/api/admin/attendance/${record.id}/photo" target="_blank" rel="noopener">Lihat foto ↗</a>`
    : `<span class="muted-cell">—</span>`;
  return `<tr>
    <td><span class="record-date">${escapeHtml(formatDate(record.createdAt))}</span><span class="record-time">${escapeHtml(formatTime(record.createdAt))}</span></td>
    <td><strong>${escapeHtml(record.name)}</strong></td>
    <td><span class="record-note">${escapeHtml(record.note || "—")}</span>${custom}</td>
    <td>${photo}</td>
  </tr>`;
}

function renderDashboard(data) {
  const days = data.dailyCounts || [];
  const maxCount = Math.max(1, ...days.map(day => day.count));
  const fieldTypes = { text: "Teks", number: "Angka", date: "Tanggal", select: "Pilihan", checkbox: "Centang" };
  $("#admin-dashboard").innerHTML = `
    <div class="admin-heading">
      <div>
        <div class="eyebrow"><span class="live-dot"></span> RUANG ADMIN</div>
        <h1>Ringkasan absensi<span class="brand-period">.</span></h1>
        <p class="hero-copy">Pantau kehadiran dan kelola formulir dari satu tempat.</p>
      </div>
      <button class="button button-quiet" id="logout-button" type="button">Keluar <span aria-hidden="true">↗</span></button>
    </div>
    <div class="admin-tabs" role="tablist">
      <button class="admin-tab active" data-admin-tab="analysis" type="button">Analisis</button>
      <button class="admin-tab" data-admin-tab="settings" type="button">Pengaturan formulir</button>
    </div>
    <section id="analysis-panel" class="admin-panel">
      <div class="stats-grid">
        <article class="stat-card"><span>Total absensi</span><strong>${data.stats.total.toLocaleString("id-ID")}</strong><small>Semua waktu</small></article>
        <article class="stat-card stat-highlight"><span>Hari ini</span><strong>${data.stats.today.toLocaleString("id-ID")}</strong><small>Absensi masuk hari ini</small></article>
        <article class="stat-card"><span>7 hari terakhir</span><strong>${data.stats.lastSevenDays.toLocaleString("id-ID")}</strong><small>Termasuk hari ini</small></article>
      </div>
      <div class="analysis-grid">
        <section class="panel-card">
          <div class="panel-title"><div><span class="step-label">TREN KEHADIRAN</span><h2>7 hari terakhir</h2></div><span class="chart-unit">jumlah</span></div>
          <div class="bar-chart">${days.map(day => `<div class="bar-column"><span class="bar-value">${day.count}</span><div class="bar-track"><div class="bar-fill" style="height:${Math.max(4, day.count / maxCount * 100)}%"></div></div><span class="bar-label">${escapeHtml(formatShortDate(day.date))}</span></div>`).join("")}</div>
        </section>
        <section class="panel-card quick-info">
          <span class="step-label">FORMULIR AKTIF</span>
          <strong>${data.people.length} <span>nama</span></strong>
          <p>${data.fields.length} kolom tambahan tersedia di formulir absensi.</p>
          <button class="text-button" data-admin-tab="settings" type="button">Kelola formulir <span aria-hidden="true">→</span></button>
        </section>
      </div>
      <section class="panel-card records-card">
        <div class="panel-title records-title"><div><span class="step-label">AKTIVITAS TERBARU</span><h2>Riwayat absensi</h2></div><span class="records-count">${data.records.length} terbaru</span></div>
        <div class="table-scroll"><table><thead><tr><th>Waktu</th><th>Nama</th><th>Keterangan &amp; kolom</th><th>Foto</th></tr></thead>
          <tbody>${data.records.length ? data.records.map(renderRecord).join("") : '<tr><td colspan="4" class="empty-cell">Belum ada data absensi.</td></tr>'}</tbody>
        </table></div>
      </section>
    </section>
    <section id="settings-panel" class="admin-panel hidden">
      <div class="settings-grid">
        <section class="panel-card settings-card">
          <div class="panel-title"><div><span class="step-label">DAFTAR PILIHAN</span><h2>Nama peserta</h2></div><span class="settings-count">${data.people.length}</span></div>
          <p class="settings-description">Nama ini akan muncul di dropdown formulir absensi.</p>
          <form id="add-person-form" class="inline-form"><input name="name" maxlength="80" placeholder="Contoh: Andi Saputra" required><button class="button button-primary" type="submit">Tambah</button></form>
          <ul class="manage-list">${data.people.length ? data.people.map(person => `<li><span>${escapeHtml(person.name)}</span><button class="icon-button" data-delete-person="${person.id}" type="button" aria-label="Hapus ${escapeHtml(person.name)}">×</button></li>`).join("") : '<li class="list-empty">Belum ada nama.</li>'}</ul>
        </section>
        <section class="panel-card settings-card">
          <div class="panel-title"><div><span class="step-label">SESUAIKAN FORM</span><h2>Kolom tambahan</h2></div><span class="settings-count">${data.fields.length}</span></div>
          <p class="settings-description">Tambahkan isian khusus seperti divisi, status, atau jam datang.</p>
          <form id="add-field-form" class="field-builder">
            <label class="field-label" for="field-label">Nama kolom</label><input id="field-label" name="label" maxlength="60" placeholder="Contoh: Divisi" required>
            <label class="field-label" for="field-type">Jenis input</label>
            <div class="select-wrap"><select id="field-type" name="type"><option value="text">Teks</option><option value="number">Angka</option><option value="date">Tanggal</option><option value="select">Dropdown pilihan</option><option value="checkbox">Centang</option></select><span class="select-chevron" aria-hidden="true">⌄</span></div>
            <div id="field-options-wrap" class="hidden"><label class="field-label" for="field-options">Pilihan dropdown</label><input id="field-options" name="options" placeholder="Hadir, Izin, Sakit"><span class="form-hint">Pisahkan setiap pilihan dengan koma.</span></div>
            <button class="button button-primary" type="submit">Tambah kolom <span aria-hidden="true">+</span></button>
          </form>
          <ul class="manage-list field-list">${data.fields.length ? data.fields.map(field => `<li><span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(fieldTypes[field.type] || field.type)}${field.type === "select" ? ` · ${field.options.map(escapeHtml).join(", ")}` : ""}</small></span><button class="icon-button" data-delete-field="${field.id}" type="button" aria-label="Hapus kolom ${escapeHtml(field.label)}">×</button></li>`).join("") : '<li class="list-empty">Belum ada kolom tambahan.</li>'}</ul>
        </section>
        <section class="panel-card settings-card password-card">
          <div><span class="step-label">KEAMANAN</span><h2>Ubah kata sandi admin</h2><p class="settings-description">Gunakan kata sandi baru minimal 12 karakter.</p></div>
          <form id="change-password-form" class="field-builder">
            <label class="field-label" for="current-password">Kata sandi saat ini</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required>
            <label class="field-label" for="new-password">Kata sandi baru</label><input id="new-password" name="newPassword" type="password" minlength="12" autocomplete="new-password" required>
            <button class="button button-secondary" type="submit">Perbarui kata sandi</button>
          </form>
        </section>
      </div>
    </section>`;
  $("#field-type").addEventListener("change", event => $("#field-options-wrap").classList.toggle("hidden", event.target.value !== "select"));
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
function formatTime(value) {
  return new Date(value).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}
function formatShortDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

async function refreshDashboard() {
  adminData = await api("/api/admin/data");
  renderDashboard(adminData);
  setAdminTab("settings");
}

function setAdminTab(tab) {
  document.querySelectorAll("#admin-dashboard .admin-tab").forEach(button => button.classList.toggle("active", button.dataset.adminTab === tab));
  $("#analysis-panel").classList.toggle("hidden", tab !== "analysis");
  $("#settings-panel").classList.toggle("hidden", tab !== "settings");
}

attendanceNav.addEventListener("click", () => setView("attendance"));
adminNav.addEventListener("click", () => setView("admin"));
$("#today-date").textContent = new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });

$("#attendance-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $(".submit-button", form);
  const feedback = $("#attendance-feedback");
  const values = {};
  for (const field of currentForm.fields) {
    const input = $(`[data-field-id="${field.id}"]`, form);
    if (field.type === "checkbox") values[field.id] = input.checked ? "true" : "false";
    else if (input.value) values[field.id] = input.value;
  }
  const body = new FormData();
  body.append("name", $("#person-select").value);
  body.append("note", $("#attendance-note").value);
  body.append("values", JSON.stringify(values));
  const photo = $("#photo-input").files[0];
  if (photo) body.append("photo", photo);
  submit.disabled = true;
  feedback.className = "feedback hidden";
  try {
    const result = await api("/api/attendance", { method: "POST", body });
    form.reset();
    $("#photo-name").textContent = "";
    $("#photo-preview").classList.add("hidden");
    feedback.textContent = result.message;
    feedback.className = "feedback feedback-success";
  } catch (error) {
    feedback.textContent = error.message;
    feedback.className = "feedback feedback-error";
  } finally {
    submit.disabled = false;
  }
});

$("#photo-input").addEventListener("change", event => {
  const file = event.target.files[0];
  const preview = $("#photo-preview");
  if (!file) {
    $("#photo-name").textContent = "";
    preview.classList.add("hidden");
    preview.removeAttribute("src");
    return;
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    event.target.value = "";
    showToast("Pilih foto JPG, PNG, atau WebP dengan ukuran maksimal 5 MB.", true);
    return;
  }
  $("#photo-name").textContent = file.name;
  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
});

document.addEventListener("click", async event => {
  const adminLink = event.target.closest("[data-open-admin]");
  if (adminLink) return setView("admin");
  const tab = event.target.closest("[data-admin-tab]");
  if (tab && adminData) return setAdminTab(tab.dataset.adminTab);
  if (event.target.closest("#logout-button")) {
    try {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      showToast("Anda telah keluar dari panel admin.");
      await openAdmin();
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }
  const removePerson = event.target.closest("[data-delete-person]");
  const removeField = event.target.closest("[data-delete-field]");
  if (removePerson || removeField) {
    const button = removePerson || removeField;
    const isPerson = Boolean(removePerson);
    const id = button.dataset[isPerson ? "deletePerson" : "deleteField"];
    if (!window.confirm(isPerson ? "Hapus nama ini dari pilihan absensi?" : "Hapus kolom ini dari formulir absensi?")) return;
    try {
      await api(`/api/admin/${isPerson ? "people" : "fields"}/${id}`, { method: "DELETE" });
      await refreshDashboard();
      await loadForm();
      showToast(isPerson ? "Nama berhasil dihapus." : "Kolom berhasil dihapus.");
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

document.addEventListener("submit", async event => {
  const form = event.target;
  if (form.id === "admin-login-form" || form.id === "admin-setup-form") {
    event.preventDefault();
    const isSetup = form.id === "admin-setup-form";
    const data = Object.fromEntries(new FormData(form));
    const errorBox = $("#auth-error");
    try {
      await api(`/api/admin/${isSetup ? "setup" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ username: data.username, password: data.password })
      });
      await openAdmin();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  } else if (form.id === "add-person-form") {
    event.preventDefault();
    try {
      await api("/api/admin/people", { method: "POST", body: JSON.stringify({ name: new FormData(form).get("name") }) });
      await refreshDashboard();
      await loadForm();
      showToast("Nama berhasil ditambahkan.");
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "add-field-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api("/api/admin/fields", { method: "POST", body: JSON.stringify(data) });
      await refreshDashboard();
      await loadForm();
      showToast("Kolom berhasil ditambahkan.");
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "change-password-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/admin/password", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      showToast(result.message);
      await openAdmin();
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

if (window.location.hash === "#admin") setView("admin");
else loadForm().catch(error => showToast(error.message, true));
