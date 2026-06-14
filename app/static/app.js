const state = {
  profiles: [],
  activeProfile: null,
  view: "browser",
  buckets: [],
  bucket: "",
  prefix: "",
  objects: [],
  policyText: "",
  mcArgs: "ls {alias}",
  output: "",
  status: "",
  error: "",
  busy: false,
};

const app = document.querySelector("#app");

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
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
  return Boolean(state.activeProfile?.capabilities?.minio_anonymous_policy);
}

async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    state.profiles = data.profiles || [];
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function login(profileId) {
  setBusy(true);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId }),
    });
    state.activeProfile = data.profile;
    localStorage.setItem("s3b.lastProfile", profileId);
    state.view = "browser";
    state.prefix = "";
    state.output = "";
    await loadBuckets(false);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function createProfile(form) {
  setBusy(true);
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.insecure = form.querySelector("[name=insecure]").checked;
  try {
    const data = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.profiles.push(data.profile);
    await login(data.profile.id);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function updateProfile(form) {
  if (!state.activeProfile) return;
  setBusy(true);
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.insecure = form.querySelector("[name=insecure]").checked;
  try {
    const data = await api(`/api/profiles/${state.activeProfile.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.activeProfile = data.profile;
    state.profiles = state.profiles.map((item) => (item.id === data.profile.id ? data.profile : item));
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
    await api(`/api/profiles/${state.activeProfile.id}`, { method: "DELETE" });
    localStorage.removeItem("s3b.lastProfile");
    state.activeProfile = null;
    state.buckets = [];
    state.objects = [];
    await loadProfiles();
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
    const data = await api(`/api/buckets?profile_id=${qs(state.activeProfile.id)}`);
    state.buckets = normalizeBuckets(data.items || []);
    if (!state.bucket && state.buckets.length) {
      state.bucket = state.buckets[0].name;
    }
    if (state.bucket) {
      await loadObjects(false);
    }
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
      body: JSON.stringify({ profile_id: state.activeProfile.id, bucket }),
    });
    form.reset();
    state.bucket = bucket;
    await loadBuckets(false);
    setStatus("Bucket created.");
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
    await api(`/api/buckets/${qs(bucket)}?profile_id=${qs(state.activeProfile.id)}&force=${force ? "1" : "0"}`, {
      method: "DELETE",
    });
    if (state.bucket === bucket) {
      state.bucket = "";
      state.prefix = "";
      state.objects = [];
    }
    await loadBuckets(false);
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
    const data = await api(
      `/api/objects?profile_id=${qs(state.activeProfile.id)}&bucket=${qs(state.bucket)}&prefix=${qs(state.prefix)}`
    );
    state.objects = normalizeObjects(data.items || []);
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
  setBusy(true);
  const body = new FormData();
  body.append("profile_id", state.activeProfile.id);
  body.append("bucket", state.bucket);
  body.append("prefix", state.prefix);
  body.append("file", input.files[0]);
  try {
    await api("/api/upload", { method: "POST", body });
    input.value = "";
    await loadObjects(false);
    setStatus("Uploaded.");
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
    await api(
      `/api/object?profile_id=${qs(state.activeProfile.id)}&bucket=${qs(state.bucket)}&key=${qs(key)}&recursive=${recursive ? "1" : "0"}`,
      { method: "DELETE" }
    );
    await loadObjects(false);
    setStatus("Deleted.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function downloadObject(key) {
  const url = `/api/download?profile_id=${qs(state.activeProfile.id)}&bucket=${qs(state.bucket)}&key=${qs(key)}`;
  window.location.href = url;
}

async function loadPolicy() {
  if (!state.activeProfile || !state.bucket) return;
  if (!supportsMinioPolicy()) {
    setStatus("Anonymous bucket policies are MinIO-specific for this app.", true);
    return;
  }
  setBusy(true);
  try {
    const data = await api(`/api/policy?profile_id=${qs(state.activeProfile.id)}&bucket=${qs(state.bucket)}`);
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
      body: JSON.stringify({ profile_id: state.activeProfile.id, bucket: state.bucket, policy }),
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
      body: JSON.stringify({ profile_id: state.activeProfile.id, args }),
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
  return String(value).replace(state.activeProfile?.access_key || "", "******");
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
            <span class="badge">${state.profiles.length} profiles</span>
          </div>
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

function renderBucketSelect() {
  return `
    <select id="bucket-select" ${state.busy ? "disabled" : ""}>
      <option value="">Select bucket</option>
      ${state.buckets
        .map((bucket) => `<option value="${escapeHtml(bucket.name)}" ${bucket.name === state.bucket ? "selected" : ""}>${escapeHtml(bucket.name)}</option>`)
        .join("")}
    </select>
  `;
}

function renderBrowser() {
  return `
    <section class="stack">
      <div class="panel toolbar">
        ${renderBucketSelect()}
        <button data-action="refresh-objects" ${state.busy ? "disabled" : ""}>Refresh</button>
        <label class="button-file">
          <input id="upload-input" type="file" hidden />
          <button type="button" data-action="pick-upload" class="primary" ${!state.bucket || state.busy ? "disabled" : ""}>Upload</button>
        </label>
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
        ${renderBucketSelect()}
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
    render();
  });
}

function bindView() {
  document.querySelector("#bucket-select")?.addEventListener("change", async (event) => {
    state.bucket = event.target.value;
    state.prefix = "";
    await loadObjects();
  });
  document.querySelector("[data-action=refresh-objects]")?.addEventListener("click", () => loadObjects());
  document.querySelector("[data-action=pick-upload]")?.addEventListener("click", () => {
    document.querySelector("#upload-input")?.click();
  });
  document.querySelector("#upload-input")?.addEventListener("change", (event) => uploadObject(event.target));
  document.querySelectorAll("[data-open-prefix]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.prefix = button.dataset.openPrefix;
      await loadObjects();
    });
  });
  document.querySelectorAll("[data-prefix]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.prefix = button.dataset.prefix;
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
      state.bucket = button.dataset.useBucket;
      state.prefix = "";
      state.view = "browser";
      await loadObjects();
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
