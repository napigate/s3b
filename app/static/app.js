const state = {
  profiles: [],
  activeProfile: null,
  view: "browser",
  buckets: [],
  bucket: "",
  prefix: "",
  objects: [],
  modal: null,
  policyText: "",
  mcArgs: "ls {alias}",
  output: "",
  status: "",
  error: "",
  busy: false,
};

const app = document.querySelector("#app");
const profileDbName = "s3b-browser-profiles";
const profileStoreName = "profiles";
const sessionStorageKey = "s3b.session.v1";

const navItems = [
  ["browser", "Object Browser"],
  ["buckets", "Buckets"],
  ["policies", "Policies"],
  ["mc", "MC"],
  ["settings", "Settings"],
];

const providers = [
  ["seaweedfs", "SeaweedFS"],
  ["minio", "MinIO"],
  ["generic", "Generic S3"],
];

const pathStyles = [
  ["on", "Path-style"],
  ["auto", "Auto"],
  ["off", "Virtual-hosted"],
];

const routeViews = new Set(navItems.map(([id]) => id));

function normalizeView(view) {
  return routeViews.has(view) ? view : "browser";
}

function readStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(sessionStorageKey) || "{}") || {};
  } catch {
    return {};
  }
}

function readRouteSession() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (!raw) return { hasRoute: false };
  const [rawView, rawQuery = ""] = raw.split("?");
  const params = new URLSearchParams(rawQuery);
  return {
    hasRoute: true,
    profileId: params.get("profile") || "",
    view: rawView === "profiles" ? "profiles" : normalizeView(rawView),
    bucket: params.get("bucket") || "",
    prefix: params.get("prefix") || "",
  };
}

function restoreTarget() {
  const stored = readStoredSession();
  const route = readRouteSession();
  const hasRoute = route.hasRoute;
  return {
    profileId: hasRoute ? route.profileId || stored.profileId || "" : stored.profileId || localStorage.getItem("s3b.lastProfile") || "",
    view: hasRoute ? route.view : stored.view || "browser",
    bucket: hasRoute ? route.bucket : stored.bucket || "",
    prefix: hasRoute ? route.prefix : stored.prefix || "",
    hasRoute,
  };
}

function persistSession() {
  const view = state.activeProfile ? normalizeView(state.view) : "profiles";
  const session = {
    profileId: state.activeProfile?.id || "",
    view,
    bucket: state.bucket || "",
    prefix: state.prefix || "",
  };
  localStorage.setItem(sessionStorageKey, JSON.stringify(session));
  if (state.activeProfile?.id) {
    localStorage.setItem("s3b.lastProfile", state.activeProfile.id);
  }
  const params = new URLSearchParams();
  if (session.profileId) params.set("profile", session.profileId);
  if (session.bucket) params.set("bucket", session.bucket);
  if (session.prefix) params.set("prefix", session.prefix);
  const query = params.toString();
  const hash = `#/${view}${query ? `?${query}` : ""}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function qs(value) {
  return encodeURIComponent(value ?? "");
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openProfileDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Browser profile database is unavailable."));
      return;
    }
    const request = indexedDB.open(profileDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(profileStoreName)) {
        db.createObjectStore(profileStoreName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function listStoredProfiles() {
  const db = await openProfileDb();
  try {
    const tx = db.transaction(profileStoreName, "readonly");
    const request = tx.objectStore(profileStoreName).getAll();
    const profiles = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    await txDone(tx);
    return profiles.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  } finally {
    db.close();
  }
}

async function getStoredProfile(id) {
  const db = await openProfileDb();
  try {
    const tx = db.transaction(profileStoreName, "readonly");
    const request = tx.objectStore(profileStoreName).get(id);
    const profile = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    await txDone(tx);
    return profile;
  } finally {
    db.close();
  }
}

async function saveStoredProfile(profile) {
  const db = await openProfileDb();
  try {
    const tx = db.transaction(profileStoreName, "readwrite");
    tx.objectStore(profileStoreName).put(profile);
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function deleteStoredProfile(id) {
  const db = await openProfileDb();
  try {
    const tx = db.transaction(profileStoreName, "readwrite");
    tx.objectStore(profileStoreName).delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
}

function newProfileId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function capabilitiesForProvider(provider) {
  const minio = provider === "minio";
  return {
    object_browser: true,
    buckets: true,
    minio_anonymous_policy: minio,
    minio_admin_commands: minio,
  };
}

function buildProfileFromForm(form, existing = null) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const provider = String(payload.provider || existing?.provider || "generic").trim();
  const now = new Date().toISOString();
  const secret = String(payload.secret_key || "").trim() || existing?.secret_key || "";
  const profile = {
    id: existing?.id || newProfileId(),
    name: String(payload.name || "").trim(),
    provider,
    endpoint: String(payload.endpoint || "").trim(),
    access_key: String(payload.access_key || "").trim(),
    secret_key: secret,
    path_style: String(payload.path_style || (provider === "seaweedfs" ? "on" : "auto")).trim(),
    insecure: form.querySelector("[name=insecure]").checked,
    created_at: existing?.created_at || now,
    updated_at: now,
    capabilities: capabilitiesForProvider(provider),
  };
  return profile;
}

function mergePublicProfile(localProfile, publicProfile) {
  return {
    ...localProfile,
    ...publicProfile,
    secret_key: localProfile.secret_key,
  };
}

function profileForRequest(profile = state.activeProfile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    endpoint: profile.endpoint,
    access_key: profile.access_key,
    secret_key: profile.secret_key,
    path_style: profile.path_style,
    insecure: Boolean(profile.insecure),
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function encodeBase64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function profileRequestHeaders(profile = state.activeProfile) {
  const headers = new Headers();
  const requestProfile = profileForRequest(profile);
  if (requestProfile) {
    headers.set("X-S3B-Profile", encodeBase64Json(requestProfile));
  }
  return headers;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const requestProfile = options.profile === false ? null : options.profile || state.activeProfile;
  if (requestProfile) {
    headers.set("X-S3B-Profile", encodeBase64Json(profileForRequest(requestProfile)));
  }
  const fetchOptions = { ...options, headers };
  delete fetchOptions.profile;
  const response = await fetch(path, {
    ...fetchOptions,
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.stderr || response.statusText);
  }
  return data;
}

function setBusy(value) {
  state.busy = value;
  render();
}

function setStatus(message, isError = false) {
  state.status = message || "";
  state.error = isError ? message || "" : "";
  render();
}

function openModal(name) {
  state.modal = name;
  render();
  requestAnimationFrame(() => {
    document.querySelector("[data-modal-close]")?.focus();
  });
}

function closeModal() {
  state.modal = null;
  render();
}

async function selectBucket(bucket) {
  if (!bucket || state.bucket === bucket) {
    state.modal = null;
    render();
    return;
  }
  state.bucket = bucket;
  state.prefix = "";
  state.modal = null;
  await loadObjects();
}

function providerLabel(provider) {
  return providers.find(([value]) => value === provider)?.[1] || "Generic S3";
}

function profileProvider(profile = state.activeProfile) {
  return profile?.provider || "generic";
}

function isMinioProfile(profile = state.activeProfile) {
  return profileProvider(profile) === "minio";
}

function supportsMinioPolicy() {
  return isMinioProfile() || Boolean(state.activeProfile?.capabilities?.minio_anonymous_policy);
}

async function loadProfiles() {
  try {
    state.profiles = await listStoredProfiles();
  } catch (error) {
    state.error = error.message;
  }
  const target = restoreTarget();
  if (!state.activeProfile && target.profileId && target.view !== "profiles") {
    const canRestore = state.profiles.some((profile) => profile.id === target.profileId);
    if (canRestore) {
      await login(target.profileId, { restore: target });
      return;
    }
  }
  render();
}

async function login(profileId, options = {}) {
  setBusy(true);
  try {
    const profile = await getStoredProfile(profileId);
    if (!profile) {
      throw new Error("Profile was not found in this browser.");
    }
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ profile: profileForRequest(profile) }),
      profile: false,
    });
    state.activeProfile = mergePublicProfile(profile, data.profile);
    const restore = options.restore || null;
    state.view = restore ? normalizeView(restore.view) : "browser";
    state.bucket = restore?.bucket || "";
    state.prefix = restore?.prefix || "";
    state.output = "";
    await loadBuckets(false);
    persistSession();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function createProfile(form) {
  setBusy(true);
  const profile = buildProfileFromForm(form);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ profile: profileForRequest(profile) }),
      profile: false,
    });
    const storedProfile = mergePublicProfile(profile, data.profile);
    await saveStoredProfile(storedProfile);
    state.profiles = await listStoredProfiles();
    state.activeProfile = storedProfile;
    state.view = "browser";
    state.bucket = "";
    state.prefix = "";
    state.output = "";
    await loadBuckets(false);
    persistSession();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function updateProfile(form) {
  if (!state.activeProfile) return;
  setBusy(true);
  const profile = buildProfileFromForm(form, state.activeProfile);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ profile: profileForRequest(profile) }),
      profile: false,
    });
    const storedProfile = mergePublicProfile(profile, data.profile);
    await saveStoredProfile(storedProfile);
    state.activeProfile = storedProfile;
    state.profiles = await listStoredProfiles();
    setStatus("Saved.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteProfile() {
  if (!state.activeProfile || !confirm("Delete this profile?")) return;
  setBusy(true);
  try {
    await deleteStoredProfile(state.activeProfile.id);
    localStorage.removeItem("s3b.lastProfile");
    state.activeProfile = null;
    state.buckets = [];
    state.bucket = "";
    state.prefix = "";
    state.objects = [];
    state.profiles = await listStoredProfiles();
    persistSession();
    render();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadBuckets(shouldRender = true) {
  if (!state.activeProfile) return;
  if (shouldRender) setBusy(true);
  try {
    const data = await api("/api/buckets");
    state.buckets = normalizeBuckets(data.items || []);
    const hasCurrentBucket = state.buckets.some((bucket) => bucket.name === state.bucket);
    if (state.bucket && !hasCurrentBucket) {
      state.prefix = "";
      state.bucket = "";
    }
    if (!state.bucket && state.buckets.length) {
      state.bucket = state.buckets[0].name;
    }
    if (state.bucket) {
      await loadObjects(false);
    }
    persistSession();
  } catch (error) {
    state.buckets = [];
    state.objects = [];
    setStatus(error.message, true);
  } finally {
    if (shouldRender) setBusy(false);
  }
}

function normalizeBuckets(items) {
  return items
    .map((item) => {
      const key = String(item.key || item.name || item.raw || "").replaceAll("/", "");
      return {
        name: key,
        size: item.size || 0,
        updated: item.lastModified || item.time || "",
        raw: item,
      };
    })
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function createBucket(form) {
  if (!state.activeProfile) return;
  setBusy(true);
  const bucket = new FormData(form).get("bucket");
  try {
    await api("/api/buckets", {
      method: "POST",
      body: JSON.stringify({ bucket }),
    });
    form.reset();
    state.bucket = bucket;
    state.prefix = "";
    await loadBuckets(false);
    persistSession();
    setStatus("Bucket created.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function createFolder(form) {
  if (!state.activeProfile || !state.bucket) return;
  setBusy(true);
  const folder = new FormData(form).get("folder");
  try {
    const data = await api("/api/folder", {
      method: "POST",
      body: JSON.stringify({ bucket: state.bucket, prefix: state.prefix, folder }),
    });
    form.reset();
    state.modal = null;
    await loadObjects(false);
    setStatus(`Folder created: ${data.key}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteBucket(bucket, force = false) {
  if (!confirm(`Delete bucket ${bucket}?`)) return;
  setBusy(true);
  try {
    await api(`/api/buckets/${qs(bucket)}?force=${force ? "1" : "0"}`, {
      method: "DELETE",
    });
    if (state.bucket === bucket) {
      state.bucket = "";
      state.prefix = "";
      state.objects = [];
    }
    await loadBuckets(false);
    persistSession();
    setStatus("Bucket deleted.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadObjects(shouldRender = true) {
  if (!state.activeProfile || !state.bucket) return;
  if (shouldRender) setBusy(true);
  try {
    const data = await api(`/api/objects?bucket=${qs(state.bucket)}&prefix=${qs(state.prefix)}`);
    state.objects = normalizeObjects(data.items || []);
    persistSession();
  } catch (error) {
    state.objects = [];
    setStatus(error.message, true);
  } finally {
    if (shouldRender) setBusy(false);
  }
}

function normalizeObjects(items) {
  return items
    .map((item) => {
      const rawKey = String(item.key || item.name || item.raw || "");
      const key = state.prefix && rawKey && !rawKey.startsWith(state.prefix) ? `${state.prefix}${rawKey}` : rawKey;
      const isFolder = item.type === "folder" || key.endsWith("/");
      const name = displayObjectName(key, isFolder);
      return {
        key,
        name,
        isFolder,
        size: Number(item.size || 0),
        updated: item.lastModified || item.time || "",
        raw: item,
      };
    })
    .filter((item) => item.key)
    .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
}

function displayObjectName(key, isFolder) {
  let value = key;
  if (state.prefix && value.startsWith(state.prefix)) {
    value = value.slice(state.prefix.length);
  }
  value = value.replace(/\/$/, "");
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] || (isFolder ? key.replace(/\/$/, "") : key);
}

async function uploadObject(input) {
  if (!state.activeProfile || !state.bucket || !input.files.length) return;
  const files = Array.from(input.files);
  state.status = `Uploading ${files.length} file${files.length === 1 ? "" : "s"}...`;
  state.error = "";
  setBusy(true);
  const body = new FormData();
  body.append("profile", JSON.stringify(profileForRequest()));
  body.append("bucket", state.bucket);
  body.append("prefix", state.prefix);
  files.forEach((file) => {
    body.append("file", file, file.name);
  });
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body,
    });
    const data = await response.json();
    input.value = "";
    await loadObjects(false);
    const uploaded = Number(data.count || data.uploaded?.length || 0);
    const failed = Number(data.failed?.length || 0);
    if (!response.ok || data.ok === false) {
      const failedNames = (data.failed || []).map((item) => item.name).filter(Boolean).slice(0, 5).join(", ");
      const suffix = failedNames ? ` Failed: ${failedNames}${failed > 5 ? ", ..." : ""}` : "";
      setStatus(`Uploaded ${uploaded}/${files.length} files.${suffix}`, true);
      return;
    }
    setStatus(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteObject(key, recursive = false) {
  if (!confirm("Delete this object?")) return;
  setBusy(true);
  try {
    await api(`/api/object?bucket=${qs(state.bucket)}&key=${qs(key)}&recursive=${recursive ? "1" : "0"}`, { method: "DELETE" });
    await loadObjects(false);
    setStatus("Deleted.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function downloadObject(key) {
  if (!state.activeProfile || !state.bucket) return;
  setBusy(true);
  try {
    const headers = profileRequestHeaders();
    headers.set("Content-Type", "application/json");
    const response = await fetch("/api/download", {
      method: "POST",
      headers,
      body: JSON.stringify({ bucket: state.bucket, key }),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : {};
      throw new Error(data.error || response.statusText);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = key.split("/").filter(Boolean).pop() || "object";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("Downloaded.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadPolicy() {
  if (!state.activeProfile || !state.bucket) return;
  if (!supportsMinioPolicy()) {
    setStatus("Anonymous bucket policies are MinIO-specific for this app.", true);
    return;
  }
  setBusy(true);
  try {
    const data = await api(`/api/policy?bucket=${qs(state.bucket)}`);
    state.policyText = data.policy || "";
    setStatus("Loaded.");
  } catch (error) {
    state.policyText = "";
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function setPolicy(policy) {
  if (!state.activeProfile || !state.bucket) return;
  if (!supportsMinioPolicy()) {
    setStatus("Anonymous bucket policies are MinIO-specific for this app.", true);
    return;
  }
  setBusy(true);
  try {
    const data = await api("/api/policy", {
      method: "POST",
      body: JSON.stringify({ bucket: state.bucket, policy }),
    });
    state.output = [data.stdout, data.stderr].filter(Boolean).join("\n");
    await loadPolicy();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function runMc(form) {
  if (!state.activeProfile) return;
  setBusy(true);
  const args = new FormData(form).get("args");
  state.mcArgs = args;
  try {
    const data = await api("/api/mc", {
      method: "POST",
      body: JSON.stringify({ args }),
    });
    const command = `$ ${escapeForOutput(["mc", ...(data.command || []).slice(1)].join(" "))}`;
    const stdout = data.stdout || "";
    const stderr = data.stderr ? `\n[stderr]\n${data.stderr}` : "";
    state.output = `${command}\n\n${stdout}${stderr}`;
    setStatus(data.ok ? "Command completed." : "Command failed.", !data.ok);
  } catch (error) {
    state.output = "";
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function escapeForOutput(value) {
  let output = String(value);
  for (const secret of [state.activeProfile?.access_key, state.activeProfile?.secret_key]) {
    if (secret) {
      output = output.replaceAll(secret, "******");
    }
  }
  return output;
}

function formatSize(size) {
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function render() {
  if (!state.activeProfile) {
    renderLogin();
    return;
  }
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <strong>S3B</strong>
          <span class="badge">mc</span>
        </div>
        <div>
          <div>${escapeHtml(state.activeProfile.name)}</div>
          <div class="profile-pill ltr">${escapeHtml(state.activeProfile.endpoint)}</div>
          <div class="profile-pill">${escapeHtml(providerLabel(profileProvider()))} · ${escapeHtml(state.activeProfile.path_style || "auto")} path</div>
        </div>
        <nav class="nav">
          ${navItems
            .map(
              ([id, label]) =>
                `<button class="${state.view === id ? "active" : ""}" data-nav="${id}">${escapeHtml(label)}</button>`
            )
            .join("")}
        </nav>
        <button class="ghost" data-action="switch-profile">Switch Profile</button>
      </aside>
      <main class="main">
        <div class="topbar">
          <h1>${escapeHtml(navItems.find(([id]) => id === state.view)?.[1] || "")}</h1>
          <div class="status ${state.error ? "error" : ""}">${escapeHtml(state.busy ? "Running..." : state.status)}</div>
        </div>
        ${renderView()}
      </main>
    </div>
    ${renderModal()}
  `;
  bindCommon();
  bindView();
}

function renderLogin() {
  const lastProfile = localStorage.getItem("s3b.lastProfile");
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-grid">
        <section class="login-card">
          <div class="topbar">
            <h1>S3B</h1>
            <span class="badge">${state.profiles.length} browser profiles</span>
          </div>
          <p class="muted">Profiles are stored only in this browser.</p>
          ${
            state.profiles.length
              ? `<div class="profile-list">
                  ${state.profiles
                    .map(
                      (profile) => `
                        <article class="profile-card">
                          <header>
                            <h3>${escapeHtml(profile.name)}</h3>
                            ${profile.id === lastProfile ? '<span class="badge">Last used</span>' : ""}
                          </header>
                          <div class="muted ltr">${escapeHtml(profile.endpoint)}</div>
                          <div class="muted">${escapeHtml(providerLabel(profile.provider))}</div>
                          <button class="primary" data-login="${escapeHtml(profile.id)}" ${state.busy ? "disabled" : ""}>Open</button>
                        </article>
                      `
                    )
                    .join("")}
                </div>`
              : `<div class="empty">Create your first profile.</div>`
          }
          <div class="status ${state.error ? "error" : ""}">${escapeHtml(state.busy ? "Running..." : state.status)}</div>
        </section>
        <section class="login-card">
          <h2>New Profile</h2>
          ${profileForm()}
        </section>
      </div>
    </div>
  `;
  document.querySelectorAll("[data-login]").forEach((button) => {
    button.addEventListener("click", () => login(button.dataset.login));
  });
  document.querySelector("#profile-create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    createProfile(event.currentTarget);
  });
  bindProfileControls(document.querySelector("#profile-create-form"));
}

function profileForm(profile = {}) {
  const provider = profile.provider || "seaweedfs";
  const pathStyle = profile.path_style || (provider === "seaweedfs" ? "on" : "auto");
  return `
    <form id="${profile.id ? "profile-update-form" : "profile-create-form"}">
      <label>Name
        <input name="name" value="${escapeHtml(profile.name || "")}" required autocomplete="off" />
      </label>
      <label>Provider
        <select name="provider" data-provider-select>
          ${providers
            .map(([value, label]) => `<option value="${value}" ${value === provider ? "selected" : ""}>${escapeHtml(label)}</option>`)
            .join("")}
        </select>
      </label>
      <label>Endpoint
        <input class="ltr" name="endpoint" value="${escapeHtml(profile.endpoint || "")}" placeholder="http://seaweedfs.example.com:8333" required />
      </label>
      <label>Access Key
        <input class="ltr" name="access_key" value="${escapeHtml(profile.access_key || "")}" required autocomplete="off" />
      </label>
      <label>Secret Key
        <input class="ltr" name="secret_key" type="password" ${profile.id ? 'placeholder="Unchanged"' : "required"} autocomplete="new-password" />
      </label>
      <label>S3 Path Lookup
        <select name="path_style" data-path-style-select>
          ${pathStyles
            .map(([value, label]) => `<option value="${value}" ${value === pathStyle ? "selected" : ""}>${escapeHtml(label)}</option>`)
            .join("")}
        </select>
      </label>
      <label class="checkbox">
        <input name="insecure" type="checkbox" ${profile.insecure ? "checked" : ""} />
        Insecure connection
      </label>
      <button class="primary" ${state.busy ? "disabled" : ""}>Save</button>
    </form>
  `;
}

function renderView() {
  if (state.view === "browser") return renderBrowser();
  if (state.view === "buckets") return renderBuckets();
  if (state.view === "policies") return renderPolicies();
  if (state.view === "mc") return renderMc();
  if (state.view === "settings") return renderSettings();
  return "";
}

function renderBucketButton() {
  return `
    <button type="button" class="bucket-switch" data-action="open-bucket-modal" ${state.busy || !state.buckets.length ? "disabled" : ""}>
      <span class="button-kicker">Bucket</span>
      <strong class="ltr">${escapeHtml(state.bucket || "Select bucket")}</strong>
      <span>Change</span>
    </button>
  `;
}

function renderBrowser() {
  const currentPrefix = state.prefix || "/";
  return `
    <section class="stack">
      <div class="browser-header">
        <div class="browser-context">
          ${renderBucketButton()}
          <div class="path-summary">
            <span class="button-kicker">Prefix</span>
            <strong class="ltr">${escapeHtml(currentPrefix)}</strong>
          </div>
        </div>
        <div class="toolbar">
          <button data-action="refresh-objects" ${!state.bucket || state.busy ? "disabled" : ""}>Refresh</button>
          <button data-action="open-folder-modal" ${!state.bucket || state.busy ? "disabled" : ""}>Create Folder</button>
          <label class="button-file">
            <input id="upload-input" type="file" multiple hidden />
            <button type="button" data-action="pick-upload" class="primary" ${!state.bucket || state.busy ? "disabled" : ""}>Upload</button>
          </label>
        </div>
      </div>
      <div class="panel crumbs">
        ${renderCrumbs()}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.bucket
                ? state.objects.map(renderObjectRow).join("") || `<tr><td colspan="5" class="muted">Empty</td></tr>`
                : `<tr><td colspan="5" class="muted">No bucket selected.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCrumbs() {
  const parts = state.prefix.split("/").filter(Boolean);
  const crumbs = [`<button class="object-name" data-prefix="">${escapeHtml(state.bucket || "root")}</button>`];
  let current = "";
  for (const part of parts) {
    current += `${part}/`;
    crumbs.push(`<button class="object-name" data-prefix="${escapeHtml(current)}">${escapeHtml(part)}</button>`);
  }
  return crumbs.join('<span class="muted">/</span>');
}

function renderObjectRow(item) {
  const key = escapeHtml(item.key);
  return `
    <tr>
      <td class="ltr">
        ${
          item.isFolder
            ? `<button class="object-name ltr" data-open-prefix="${key}">${escapeHtml(item.name)}</button>`
            : escapeHtml(item.name)
        }
      </td>
      <td>${item.isFolder ? "Folder" : "File"}</td>
      <td class="ltr">${item.isFolder ? "-" : formatSize(item.size)}</td>
      <td class="ltr">${escapeHtml(item.updated || "-")}</td>
      <td>
        <div class="row-actions">
          ${item.isFolder ? "" : `<button data-download="${key}">Download</button>`}
          <button class="danger" data-delete-object="${key}" data-recursive="${item.isFolder ? "1" : "0"}">Delete</button>
        </div>
      </td>
    </tr>
  `;
}

function renderBuckets() {
  return `
    <section class="split">
      <div class="stack">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Modified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.buckets
                  .map(
                    (bucket) => `
                      <tr>
                        <td class="ltr">${escapeHtml(bucket.name)}</td>
                        <td class="ltr">${escapeHtml(bucket.updated || "-")}</td>
                        <td>
                          <div class="row-actions">
                            <button data-use-bucket="${escapeHtml(bucket.name)}">Open</button>
                            <button class="danger" data-delete-bucket="${escapeHtml(bucket.name)}">Delete</button>
                            <button class="danger" data-force-delete-bucket="${escapeHtml(bucket.name)}">Force Delete</button>
                          </div>
                        </td>
                      </tr>
                    `
                  )
                  .join("") || `<tr><td colspan="3" class="muted">No buckets found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
      <aside class="panel">
        <h2>New Bucket</h2>
        <form id="bucket-create-form">
          <label>Bucket Name
            <input class="ltr" name="bucket" required autocomplete="off" />
          </label>
          <button class="primary" ${state.busy ? "disabled" : ""}>Create</button>
        </form>
      </aside>
    </section>
  `;
}

function renderPolicies() {
  if (!supportsMinioPolicy()) {
    return `
      <section class="stack">
        <div class="panel stack">
          <h2>Provider Access Controls</h2>
          <p class="muted">
            This profile is configured as ${escapeHtml(providerLabel(profileProvider()))}. S3B keeps object browsing,
            uploads, downloads, deletes, and bucket operations on standard S3 commands. The policy buttons here are
            MinIO-specific anonymous policy commands and are disabled for this provider.
          </p>
          <p class="muted">
            Use the MC tab for supported S3 commands, or configure SeaweedFS access keys and bucket policies on the
            SeaweedFS side.
          </p>
        </div>
      </section>
    `;
  }
  return `
    <section class="stack">
      <div class="panel toolbar">
        ${renderBucketButton()}
        <button data-action="load-policy" ${!state.bucket || state.busy ? "disabled" : ""}>Load</button>
      </div>
      <div class="panel policy-actions">
        ${["private", "download", "upload", "public"]
          .map((policy) => `<button data-policy="${policy}" ${!state.bucket || state.busy ? "disabled" : ""}>${policy}</button>`)
          .join("")}
      </div>
      <pre class="output">${escapeHtml(state.policyText || state.output || "")}</pre>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) return "";
  if (state.modal === "bucket") return renderBucketModal();
  if (state.modal === "folder") return renderFolderModal();
  return "";
}

function renderBucketModal() {
  return `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="bucket-modal-title">
        <header class="modal-header">
          <div>
            <h2 id="bucket-modal-title">Select Bucket</h2>
            <p class="muted">${state.buckets.length} available buckets</p>
          </div>
          <button type="button" class="icon-button" data-modal-close aria-label="Close">×</button>
        </header>
        <div class="bucket-card-grid">
          ${
            state.buckets
              .map(
                (bucket) => `
                  <button type="button" class="bucket-card ${bucket.name === state.bucket ? "selected" : ""}" data-select-bucket="${escapeHtml(bucket.name)}">
                    <span class="bucket-card-top">
                      <strong class="ltr">${escapeHtml(bucket.name)}</strong>
                      ${bucket.name === state.bucket ? '<span class="badge">Current</span>' : ""}
                    </span>
                    <span class="muted ltr">${escapeHtml(bucket.updated || "No modified date")}</span>
                    <span class="bucket-card-action">${bucket.name === state.bucket ? "Selected" : "Open bucket"}</span>
                  </button>
                `
              )
              .join("") || `<div class="empty">No buckets found.</div>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderFolderModal() {
  return `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="modal-panel compact" role="dialog" aria-modal="true" aria-labelledby="folder-modal-title">
        <header class="modal-header">
          <div>
            <h2 id="folder-modal-title">Create Folder</h2>
            <p class="muted ltr">${escapeHtml(state.bucket || "")}/${escapeHtml(state.prefix || "")}</p>
          </div>
          <button type="button" class="icon-button" data-modal-close aria-label="Close">×</button>
        </header>
        <form id="folder-create-form">
          <label>Folder Name
            <input class="ltr" name="folder" placeholder="reports" required autocomplete="off" ${!state.bucket || state.busy ? "disabled" : ""} />
          </label>
          <div class="modal-actions">
            <button type="button" data-modal-close>Cancel</button>
            <button class="primary" ${!state.bucket || state.busy ? "disabled" : ""}>Create</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderMc() {
  const bucket = state.bucket || "bucket";
  const examples = isMinioProfile()
    ? ["ls {alias}", `du {alias}/${bucket}`, `anonymous get {alias}/${bucket}`, `ilm ls {alias}/${bucket}`, "admin info {alias}"]
    : ["ls {alias}", `mb {alias}/${bucket}`, `ls {alias}/${bucket}`, `du {alias}/${bucket}`, `rm {alias}/${bucket}/path/to/object`];
  return `
    <section class="stack">
      <form id="mc-form" class="panel">
        <label>Command
          <textarea name="args" spellcheck="false">${escapeHtml(state.mcArgs)}</textarea>
        </label>
        <div class="row-actions">
          <button class="primary" ${state.busy ? "disabled" : ""}>Run</button>
          ${examples.map((cmd) => `<button type="button" data-mc-example="${escapeHtml(cmd)}">${escapeHtml(cmd)}</button>`).join("")}
        </div>
      </form>
      <pre class="output">${escapeHtml(state.output)}</pre>
    </section>
  `;
}

function renderSettings() {
  return `
    <section class="split">
      <div class="panel">
        <h2>Current Profile</h2>
        ${profileForm(state.activeProfile)}
        <div class="row-actions">
          <button class="danger" data-action="delete-profile">Delete Profile</button>
        </div>
      </div>
      <aside class="panel stack">
        <h2>Profiles</h2>
        ${state.profiles
          .map(
            (profile) => `
              <article class="profile-card">
                <h3>${escapeHtml(profile.name)}</h3>
                <div class="muted ltr">${escapeHtml(profile.endpoint)}</div>
                <div class="muted">${escapeHtml(providerLabel(profile.provider))}</div>
                <button data-login="${escapeHtml(profile.id)}" ${profile.id === state.activeProfile.id ? "disabled" : ""}>Open</button>
              </article>
            `
          )
          .join("")}
      </aside>
    </section>
  `;
}

function bindCommon() {
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.nav;
      state.status = "";
      state.error = "";
      persistSession();
      render();
    });
  });
  document.querySelector("[data-action=switch-profile]")?.addEventListener("click", () => {
    state.activeProfile = null;
    state.bucket = "";
    state.prefix = "";
    state.objects = [];
    state.status = "";
    state.error = "";
    state.modal = null;
    persistSession();
    render();
  });
  document.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  document.querySelector("[data-modal-backdrop]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal();
    }
  });
}

function bindView() {
  document.querySelectorAll("[data-action=open-bucket-modal]").forEach((button) => {
    button.addEventListener("click", () => openModal("bucket"));
  });
  document.querySelectorAll("[data-action=open-folder-modal]").forEach((button) => {
    button.addEventListener("click", () => openModal("folder"));
  });
  document.querySelectorAll("[data-select-bucket]").forEach((button) => {
    button.addEventListener("click", () => selectBucket(button.dataset.selectBucket));
  });
  document.querySelector("[data-action=refresh-objects]")?.addEventListener("click", () => loadObjects());
  document.querySelector("[data-action=pick-upload]")?.addEventListener("click", () => {
    document.querySelector("#upload-input")?.click();
  });
  document.querySelector("#upload-input")?.addEventListener("change", (event) => uploadObject(event.target));
  document.querySelector("#folder-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createFolder(event.currentTarget);
  });
  document.querySelectorAll("[data-open-prefix]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.prefix = button.dataset.openPrefix;
      persistSession();
      await loadObjects();
    });
  });
  document.querySelectorAll("[data-prefix]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.prefix = button.dataset.prefix;
      persistSession();
      await loadObjects();
    });
  });
  document.querySelectorAll("[data-download]").forEach((button) => {
    button.addEventListener("click", () => downloadObject(button.dataset.download));
  });
  document.querySelectorAll("[data-delete-object]").forEach((button) => {
    button.addEventListener("click", () => deleteObject(button.dataset.deleteObject, button.dataset.recursive === "1"));
  });
  document.querySelector("#bucket-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createBucket(event.currentTarget);
  });
  document.querySelectorAll("[data-delete-bucket]").forEach((button) => {
    button.addEventListener("click", () => deleteBucket(button.dataset.deleteBucket, false));
  });
  document.querySelectorAll("[data-force-delete-bucket]").forEach((button) => {
    button.addEventListener("click", () => deleteBucket(button.dataset.forceDeleteBucket, true));
  });
  document.querySelectorAll("[data-use-bucket]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = "browser";
      persistSession();
      await selectBucket(button.dataset.useBucket);
    });
  });
  document.querySelector("[data-action=load-policy]")?.addEventListener("click", () => loadPolicy());
  document.querySelectorAll("[data-policy]").forEach((button) => {
    button.addEventListener("click", () => setPolicy(button.dataset.policy));
  });
  document.querySelector("#mc-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runMc(event.currentTarget);
  });
  document.querySelectorAll("[data-mc-example]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mcArgs = button.dataset.mcExample;
      render();
    });
  });
  document.querySelector("#profile-update-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    updateProfile(event.currentTarget);
  });
  document.querySelectorAll("form").forEach(bindProfileControls);
  document.querySelector("[data-action=delete-profile]")?.addEventListener("click", () => deleteProfile());
  document.querySelectorAll("[data-login]").forEach((button) => {
    button.addEventListener("click", () => login(button.dataset.login));
  });
}

function bindProfileControls(form) {
  const providerSelect = form.querySelector("[data-provider-select]");
  const pathStyleSelect = form.querySelector("[data-path-style-select]");
  if (!providerSelect || !pathStyleSelect) return;
  providerSelect.addEventListener("change", () => {
    if (providerSelect.value === "seaweedfs") {
      pathStyleSelect.value = "on";
    } else if (providerSelect.value === "minio" && pathStyleSelect.value === "on") {
      pathStyleSelect.value = "auto";
    }
  });
}

loadProfiles();
