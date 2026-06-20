"use strict";
/* cloud.js — Phase 1 cloud backup + multi-device sync for the Field Verification Log.
   Local capture stays the source of truth and works fully offline. This layer:
   - signs the user in (email + password),
   - pushes local changes (an outbox of "dirty" rows + photos) to Supabase when online,
   - pulls changes made on other devices,
   - resolves versions by the SERVER clock (updated_at set by a DB trigger),
   - never blocks or alters offline capture. */
(function () {
  const CFG = window.CLOUD_CONFIG;
  if (!CFG || !CFG.url || !CFG.key) { console.warn("cloud: no config"); return; }

  let sb = null, session = null, syncing = false, pendingResync = false, bumpT = null;
  const ASSET_COLS = "id,owner_id,asset_type,title,data,world_value,photo_count,is_deleted,version,device_id,created_at,updated_at";

  // ---- tiny DOM helpers ----
  const $ = (id) => document.getElementById(id);
  const online = () => navigator.onLine !== false;
  const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // ---- status pill + banner ----
  let status = { state: "idle", pending: 0, msg: "" };
  function setStatus(state, msg) { status.state = state; if (msg != null) status.msg = msg; paint(); }
  function paint() {
    const pill = $("cloudpill"); if (!pill) return;
    pill.classList.remove("hidden");
    let t = "☁︎";
    if (!CFG.url) { pill.classList.add("hidden"); return; }
    if (!session) t = "☁︎ Sign in";
    else if (!online()) t = "☁︎ Offline";
    else if (status.state === "syncing") t = "☁︎ Syncing…";
    else if (status.state === "error") t = "☁︎ Backup error";
    else if (status.state === "paused") t = "☁︎ Cloud full/paused";
    else if (status.pending > 0) t = "☁︎ " + status.pending + " to back up";
    else t = "☁︎ Backed up ✓";
    pill.textContent = t;
    pill.style.background = (status.state === "error" || status.state === "paused") ? "var(--red)" : "rgba(255,255,255,.18)";
    // loud banner only for real problems
    const ban = $("cloudbanner"); if (!ban) return;
    if (session && (status.state === "error" || status.state === "paused")) {
      ban.className = "cloudbanner warn";
      ban.textContent = status.state === "paused"
        ? "Cloud backup is full or paused. Your work is still saving on this phone. Free space or upgrade to resume backup."
        : ("Cloud backup hit a problem" + (status.msg ? " (" + status.msg + ")" : "") + ". Your work is safe on this phone; it will retry.");
    } else { ban.className = "cloudbanner hidden"; ban.textContent = ""; }
  }
  async function countPending() {
    try {
      const A = await FieldApp.idbGetAll("assets"), P = await FieldApp.idbGetAll("photos");
      status.pending = A.filter(needsPush).length + P.filter(needsPush).length;
    } catch (e) {}
    paint();
  }

  // ---- outbox predicate ----
  const needsPush = (x) => x && (x.syncState === "dirty" || (x.syncState === "deleted" && !x.remoteDeleted));

  // ---- mapping local <-> rows ----
  function assetToRow(a) {
    const d = a.data || {};
    return { id: a.id, owner_id: session.user.id, asset_type: a.type || "other",
      title: (d.assetId || d.assetName || "") + "", data: d, world_value: a.world_value || {},
      photo_count: a.photoCount || 0, is_deleted: a.syncState === "deleted", version: a.version || 1, device_id: a.deviceId || null };
  }
  function rowToAsset(row) {
    return { id: row.id, type: row.asset_type || "other", schemaVersion: 1, deviceId: row.device_id || null,
      createdAt: row.created_at, updatedAt: row.updated_at, syncState: row.is_deleted ? "deleted" : "synced",
      remoteDeleted: !!row.is_deleted, photoCount: row.photo_count || 0, data: row.data || {},
      world_value: row.world_value || {}, version: row.version || 1 };
  }
  const pathFor = (p) => session.user.id + "/" + p.assetId + "/" + p.id + ".jpg";
  async function sha256(blob) {
    try { const buf = await blob.arrayBuffer(); const h = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join(""); } catch (e) { return null; }
  }
  function photoToRow(p, storagePath, hash) {
    return { id: p.id, owner_id: session.user.id, asset_id: p.assetId, section_id: p.sectionId || null,
      storage_path: storagePath || p.storagePath || null, mime: p.mime || "image/jpeg",
      byte_size: p.blob ? p.blob.size : null, width: p.w || null, height: p.h || null,
      caption: p.caption || "", sha256: hash || p.sha256 || null, is_deleted: p.syncState === "deleted",
      version: p.version || 1, device_id: p.deviceId || null };
  }

  // ---- error classification ----
  function isQuota(err) { const m = ((err && (err.message || err.error || err.msg)) || "").toLowerCase(); return m.includes("exceeded") || m.includes("quota") || m.includes("payload too large") || m.includes("paused"); }

  // ============ PUSH ============
  async function pushAssets() {
    const A = (await FieldApp.idbGetAll("assets")).filter(needsPush);
    if (!A.length) return 0;
    const rows = A.map(assetToRow);
    const { data, error } = await sb.from("assets").upsert(rows, { onConflict: "id" }).select("id,updated_at,is_deleted");
    if (error) throw error;
    const byId = {}; (data || []).forEach(r => byId[r.id] = r);
    for (const a of A) {
      const r = byId[a.id]; if (!r) continue;
      if (a.syncState === "deleted") { a.remoteDeleted = true; }
      else { a.syncState = "synced"; a.updatedAt = r.updated_at; }
      await FieldApp.idbPut("assets", a);
      if (r.updated_at > watermark) watermark = r.updated_at;
    }
    return A.length;
  }
  async function pushPhotos() {
    const P = (await FieldApp.idbGetAll("photos")).filter(needsPush);
    if (!P.length) return 0;
    let n = 0;
    for (const p of P) {
      if (p.syncState === "deleted") {
        try { await sb.storage.from(CFG.bucket).remove([pathFor(p)]); } catch (e) {}
        const { error } = await sb.from("photos").upsert([photoToRow(p)], { onConflict: "id" });
        if (error) throw error;
        p.remoteDeleted = true; await FieldApp.idbPut("photos", p); n++;
        continue;
      }
      if (!p.blob) { p.syncState = "synced"; await FieldApp.idbPut("photos", p); continue; }
      const path = pathFor(p);
      const up = await sb.storage.from(CFG.bucket).upload(path, p.blob, { contentType: p.mime || "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      const hash = await sha256(p.blob);
      const { data, error } = await sb.from("photos").upsert([photoToRow(p, path, hash)], { onConflict: "id" }).select("id,updated_at");
      if (error) throw error;
      p.syncState = "synced"; p.storagePath = path; p.sha256 = hash;
      if (data && data[0]) { p.updatedAt = data[0].updated_at; if (data[0].updated_at > watermark) watermark = data[0].updated_at; }
      await FieldApp.idbPut("photos", p); n++;
    }
    return n;
  }

  // ============ PULL ============
  let watermark = "1970-01-01T00:00:00Z";
  async function pull() {
    const uid = session.user.id;
    const since = lsGet("cloud:lastPull:" + uid, "1970-01-01T00:00:00Z");
    let changed = false;
    const { data: aRows, error: aErr } = await sb.from("assets").select(ASSET_COLS).gt("updated_at", since).order("updated_at", { ascending: true });
    if (aErr) throw aErr;
    const localAssets = {}; (await FieldApp.idbGetAll("assets")).forEach(a => localAssets[a.id] = a);
    for (const row of (aRows || [])) {
      if (row.updated_at > watermark) watermark = row.updated_at;
      const local = localAssets[row.id];
      if (local && local.syncState === "dirty" && !(row.updated_at > local.updatedAt)) continue; // keep local newer edits
      if (local && local.syncState === "synced" && !(row.updated_at > local.updatedAt)) continue; // already current
      await FieldApp.idbPut("assets", rowToAsset(row)); changed = true;
    }
    const { data: pRows, error: pErr } = await sb.from("photos").select("*").gt("updated_at", since).order("updated_at", { ascending: true });
    if (pErr) throw pErr;
    for (const row of (pRows || [])) {
      if (row.updated_at > watermark) watermark = row.updated_at;
      const existing = await FieldApp.idbGet("photos", row.id);
      if (row.is_deleted) {
        if (existing && existing.syncState !== "deleted") { existing.syncState = "deleted"; existing.remoteDeleted = true; existing.blob = null; existing.thumb = null; existing.updatedAt = row.updated_at; await FieldApp.idbPut("photos", existing); changed = true; }
        continue;
      }
      if (existing && existing.blob && existing.syncState === "synced" && !(row.updated_at > (existing.updatedAt || ""))) continue;
      // download the image bytes for a photo we don't have locally
      let blob = existing && existing.blob ? existing.blob : null, thumb = existing && existing.thumb ? existing.thumb : null;
      if (!blob && row.storage_path) {
        try { const dl = await sb.storage.from(CFG.bucket).download(row.storage_path); if (dl.data) { blob = dl.data; const small = await FieldApp.downscale(blob, 220, 0.6); thumb = small.blob; } } catch (e) {}
      }
      const rec = { id: row.id, assetId: row.asset_id, sectionId: row.section_id, blob, thumb, mime: row.mime || "image/jpeg",
        w: row.width, h: row.height, caption: row.caption || "", sha256: row.sha256 || null, storagePath: row.storage_path,
        createdAt: row.created_at, createdMs: existing ? existing.createdMs : Date.parse(row.created_at) || Date.now(),
        deviceId: row.device_id, syncState: "synced", remoteDeleted: false, updatedAt: row.updated_at };
      await FieldApp.idbPut("photos", rec); changed = true;
    }
    lsSet("cloud:lastPull:" + uid, watermark);
    return changed;
  }

  // ============ ORCHESTRATION ============
  async function syncNow(reason) {
    if (!sb || !session) return;
    if (!online()) { paint(); return; }
    if (syncing) { pendingResync = true; return; }
    syncing = true; setStatus("syncing");
    try {
      watermark = lsGet("cloud:lastPull:" + session.user.id, "1970-01-01T00:00:00Z");
      await pushAssets();
      await pushPhotos();
      const changed = await pull();
      setStatus("ok");
      await countPending();
      if (changed) { try { await FieldApp.reload(); FieldApp.refresh(); } catch (e) {} }
      lsSet("cloud:lastSync", new Date().toISOString());
    } catch (err) {
      console.warn("sync error", err);
      setStatus(isQuota(err) ? "paused" : "error", (err && (err.message || err.error)) || "");
    } finally {
      syncing = false;
      renderDialogIfOpen();
      if (pendingResync) { pendingResync = false; setTimeout(() => syncNow("resync"), 800); }
    }
  }
  const bump = () => { clearTimeout(bumpT); bumpT = setTimeout(() => { countPending(); syncNow("change"); }, 1500); };

  // first time this account logs in on this phone, claim the existing on-phone data so it uploads
  async function claimLocalIfFirstLogin() {
    const uid = session.user.id;
    if (lsGet("cloud:claimedBy", "") === uid) return;
    try {
      const A = await FieldApp.idbGetAll("assets");
      for (const a of A) { if (a.syncState !== "deleted") { a.syncState = "dirty"; a.remoteDeleted = false; await FieldApp.idbPut("assets", a); } }
      const P = await FieldApp.idbGetAll("photos");
      for (const p of P) { if (p.syncState !== "deleted" && p.blob) { p.syncState = "dirty"; p.remoteDeleted = false; await FieldApp.idbPut("photos", p); } }
    } catch (e) {}
    lsSet("cloud:claimedBy", uid);
  }

  // ============ AUTH + UI ============
  function fmtAgo(iso) { if (!iso) return "never"; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return new Date(iso).toLocaleString(); }
  function renderDialogIfOpen() { const dlg = $("cloudDlg"); if (dlg && dlg.open) renderDialog(); }
  function renderDialog() {
    const body = $("cloudBody"); if (!body) return;
    if (!session) {
      $("cloudTitle").textContent = "Cloud backup";
      body.innerHTML =
        '<p style="margin:0 0 10px;font-size:14px;color:var(--muted)">Sign in to back up your data and reach it from any device. Capture and PDF keep working offline whether or not you sign in.</p>' +
        '<div class="fld"><label>Email</label><input id="cEmail" type="email" autocomplete="username" inputmode="email" placeholder="you@example.com"/></div>' +
        '<div class="fld"><label>Password</label><input id="cPass" type="password" autocomplete="current-password" placeholder="at least 6 characters"/></div>' +
        '<div class="row"><button class="btn-teal" id="cSignin" style="flex:1">Sign in</button><button class="btn-line" id="cSignup" style="flex:1">Create account</button></div>' +
        '<div id="cMsg" class="note hidden" style="margin-top:10px"></div>';
      $("cSignin").addEventListener("click", () => doAuth("in"));
      $("cSignup").addEventListener("click", () => doAuth("up"));
    } else {
      $("cloudTitle").textContent = "Cloud backup";
      const email = session.user.email || "(no email)";
      body.innerHTML =
        '<p style="margin:0 0 8px">Signed in as <b>' + escapeHtml(email) + '</b>.</p>' +
        '<div class="note" id="cSyncInfo" style="margin:8px 0">' + syncInfoText() + '</div>' +
        '<div class="row"><button class="btn-teal" id="cSyncNow" style="flex:1">⤓ Back up now</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn-line btn-sm" id="cSignout">Sign out of this device</button></div>' +
        '<p style="font-size:12px;color:var(--muted);margin:10px 0 0">Signing out only stops cloud sync. Your captures and photos stay on this phone.</p>';
      $("cSyncNow").addEventListener("click", () => { syncNow("manual"); });
      $("cSignout").addEventListener("click", doSignOut);
    }
  }
  function syncInfoText() {
    const last = lsGet("cloud:lastSync", "");
    let s = "Last backup: <b>" + fmtAgo(last) + "</b>. ";
    if (!online()) s += "You are offline; it will sync when you have signal.";
    else if (status.state === "paused") s += "Cloud is full or paused.";
    else if (status.state === "error") s += "Last attempt hit an error; it will retry.";
    else if (status.pending > 0) s += status.pending + " change(s) waiting to upload.";
    else s += "Everything is backed up.";
    return s;
  }
  const escapeHtml = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function msg(text, err) { const m = $("cMsg"); if (!m) return; m.classList.remove("hidden"); m.textContent = text; m.style.color = err ? "var(--red)" : "var(--muted)"; }

  async function doAuth(mode) {
    const email = ($("cEmail").value || "").trim(), pass = $("cPass").value || "";
    if (!email || !pass) return msg("Enter an email and a password.", true);
    if (pass.length < 6) return msg("Password must be at least 6 characters.", true);
    if (!online()) return msg("You need internet the first time you sign in.", true);
    msg(mode === "up" ? "Creating account…" : "Signing in…");
    try {
      if (mode === "up") {
        const { data, error } = await sb.auth.signUp({ email, password: pass });
        if (error) {
          if (/already|registered|exists/i.test(error.message || "")) {
            msg("That account already exists, signing you in…");
            const r = await sb.auth.signInWithPassword({ email, password: pass });
            if (r.error) return msg("This email already has an account, but that password is wrong. Use Sign in, or reset it in Supabase.", true);
            return; // onAuthStateChange takes over
          }
          return msg(error.message || "Could not create the account.", true);
        }
        if (!data.session) return msg("Account created. If email confirmation is on, confirm via the email, then Sign in.", false);
        return; // signed in; onAuthStateChange takes over
      }
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) return msg(error.message || "Sign in failed.", true);
      // onAuthStateChange will pick up the session and start sync
    } catch (e) { msg((e && e.message) || "Network error.", true); }
  }
  async function doSignOut() { try { await sb.auth.signOut(); } catch (e) {} }

  function openDialog() { const dlg = $("cloudDlg"); if (!dlg) return; renderDialog(); if (!dlg.open) dlg.showModal(); }

  // ============ INIT ============
  async function init() {
    await FieldApp.ready;
    try {
      sb = window.supabase.createClient(CFG.url, CFG.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "cloud-auth" }
      });
    } catch (e) { console.warn("cloud: client init failed", e); return; }

    // pill click opens the dialog
    const pill = $("cloudpill");
    if (pill) { pill.classList.remove("hidden"); pill.addEventListener("click", openDialog); }
    paint();

    sb.auth.onAuthStateChange(async (_event, sess) => {
      session = sess || null;
      paint(); renderDialogIfOpen();
      if (session) { await claimLocalIfFirstLogin(); await countPending(); syncNow("auth"); }
      else { status.pending = 0; paint(); }
    });
    try { const { data } = await sb.auth.getSession(); session = data.session || null; } catch (e) {}
    paint(); await countPending();
    if (session) { await claimLocalIfFirstLogin(); syncNow("boot"); }

    window.addEventListener("online", () => { paint(); syncNow("online"); });
    window.addEventListener("offline", paint);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow("visible"); });
    setInterval(() => { if (session && online() && !syncing) syncNow("interval"); }, 20000);
  }

  window.Cloud = { bump, syncNow: () => syncNow("api"), openDialog, countPending };
  init();
})();
