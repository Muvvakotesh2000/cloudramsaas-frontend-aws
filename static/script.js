"use strict";

var _supabase          = null;
var _backendUrl        = "";
var _pollInterval      = null;
var _heartbeatInterval = null;
var _currentSession    = null;
var _prevStatus        = null;
var _selectedFiles     = [];
var _projectsLoaded    = false;
var _sessionStopFired  = false;
var _provisionTimer    = null;
var _provisionStart    = null;
var _projectPollTimer  = null;
var _projectPollCount  = 0;
var PROVISION_DURATION  = 90;

function initDashboard(supabaseUrl, supabaseAnonKey, backendApiUrl) {
  _supabase   = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  _backendUrl = backendApiUrl;

  _supabase.auth.getSession().then(function(res) {
    var session = res.data.session;
    if (!session) { window.location.href = "/"; return; }
    document.getElementById("user-email").textContent = session.user.email;
    fetchSessionStatus();
  });

  var filePicker   = document.getElementById("file-picker");
  var folderPicker = document.getElementById("folder-picker");
  var nameInput    = document.getElementById("project-name");
  var dropZone     = document.getElementById("drop-zone");

  if (filePicker) {
    filePicker.addEventListener("click", function() { filePicker.value = ""; });
    filePicker.addEventListener("change", function() {
      _selectedFiles = Array.from(filePicker.files);
      if (folderPicker) folderPicker.value = "";
      if (_selectedFiles.length && nameInput) {
        nameInput.value = _selectedFiles[0].name.replace(/\.[^.]+$/, "");
      }
      _renderFileSelection();
    });
  }

  if (folderPicker) {
    folderPicker.addEventListener("click", function() { folderPicker.value = ""; });
    folderPicker.addEventListener("change", function() {
      _showReadingState();
      requestAnimationFrame(function() {
        _selectedFiles = Array.from(folderPicker.files);
        if (filePicker) filePicker.value = "";
        if (_selectedFiles.length && _selectedFiles[0].webkitRelativePath && nameInput) {
          nameInput.value = _selectedFiles[0].webkitRelativePath.split("/")[0];
        }
        _renderFileSelection();
      });
    });
  }

  if (nameInput) {
    nameInput.addEventListener("input", function() {
      _updateTransferButtons(_currentSession && _currentSession.status === "RUNNING");
    });
  }

  if (dropZone) {
    ["dragenter", "dragover"].forEach(function(evt) {
      dropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function(evt) {
      dropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        dropZone.classList.remove("dragover");
      });
    });
    dropZone.addEventListener("drop", function(e) {
      var files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      _selectedFiles = files;
      if (filePicker) filePicker.value = "";
      if (folderPicker) folderPicker.value = "";
      if (nameInput && !nameInput.value.trim() && files.length === 1) {
        nameInput.value = files[0].name.replace(/\.[^.]+$/, "");
      }
      _renderFileSelection();
    });
  }

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }

  document.addEventListener("visibilitychange", function() {
    if (!document.hidden) fetchSessionStatus();
  });

  // Auto-stop session when user closes tab or navigates away
  window.addEventListener("beforeunload", function() {
    _stopSessionBeacon();
  });
}

function _showReadingState() {
  var defEl = document.getElementById("drop-default");
  var selEl = document.getElementById("drop-selected");
  var txt   = document.getElementById("selected-files-text");
  if (defEl) defEl.style.display = "none";
  if (selEl) selEl.style.display = "flex";
  if (txt) txt.textContent = "Reading folder…";
}

function _renderFileSelection() {
  var defEl = document.getElementById("drop-default");
  var selEl = document.getElementById("drop-selected");
  var txt   = document.getElementById("selected-files-text");

  if (_selectedFiles.length) {
    var totalMB = (_selectedFiles.reduce(function(s, f) { return s + f.size; }, 0) / (1024 * 1024)).toFixed(1);
    if (defEl) defEl.style.display = "none";
    if (selEl) selEl.style.display = "flex";
    if (txt) txt.textContent = _selectedFiles.length + " file" + (_selectedFiles.length > 1 ? "s" : "") + " · " + totalMB + " MB";
  } else {
    if (defEl) defEl.style.display = "";
    if (selEl) selEl.style.display = "none";
  }
  _updateTransferButtons(_currentSession && _currentSession.status === "RUNNING");
}

function clearSelectedFiles() {
  _selectedFiles = [];
  var fp = document.getElementById("file-picker");
  var fl = document.getElementById("folder-picker");
  if (fp) fp.value = "";
  if (fl) fl.value = "";
  _renderFileSelection();
}

function _resetUploadForm() {
  _selectedFiles = [];
  var fp = document.getElementById("file-picker");
  var fl = document.getElementById("folder-picker");
  var ni = document.getElementById("project-name");
  if (fp) fp.value = "";
  if (fl) fl.value = "";
  if (ni) ni.value = "";
  _renderFileSelection();
}

/* ── Auth ── */

async function getAuthToken() {
  var r = await _supabase.auth.getSession();
  if (!r.data.session) throw new Error("Not authenticated");
  return r.data.session.access_token;
}

async function getAuthContext() {
  try {
    var r = await _supabase.auth.refreshSession();
    if (!r.error && r.data.session) {
      return { access_token: r.data.session.access_token, user_id: r.data.session.user.id };
    }
  } catch (_) {}
  var r2 = await _supabase.auth.getSession();
  if (!r2.data.session) throw new Error("Not authenticated");
  return { access_token: r2.data.session.access_token, user_id: r2.data.session.user.id };
}

function _stopSessionBeacon() {
  if (_sessionStopFired) return;
  if (!_currentSession || _currentSession.status !== "RUNNING") return;

  _sessionStopFired = true;
  var token = null;
  try {
    var keys = Object.keys(localStorage);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("sb-") === 0 && keys[i].indexOf("-auth-token") !== -1) {
        var raw = JSON.parse(localStorage.getItem(keys[i]));
        token = raw && raw.access_token;
        break;
      }
    }
  } catch (_) {}

  if (!token) return;

  var url = _backendUrl + "/api/v1/sessions/beacon-stop";
  var blob = new Blob([token], { type: "text/plain" });
  navigator.sendBeacon(url, blob);
}

async function handleSignOut() {
  stopPolling(); stopHeartbeat();

  // Stop session before signing out
  if (_currentSession && (_currentSession.status === "RUNNING" || _currentSession.status === "PROVISIONING" || _currentSession.status === "PENDING")) {
    try {
      await apiCall("/api/v1/sessions", "DELETE");
      log("Session stopped.", "success");
    } catch (_) {}
  }

  _sessionStopFired = true;
  await _supabase.auth.signOut();
  window.location.href = "/";
}

/* ── API ── */

async function apiCall(path, method, body) {
  var token = await getAuthToken();
  var opts  = { method: method || "GET", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  var resp = await fetch(_backendUrl + path, opts);
  if (resp.status === 204) return null;
  var data = await resp.json();
  if (!resp.ok) {
    var msg;
    if (Array.isArray(data.detail)) {
      msg = data.detail.map(function(e) { return e.msg || JSON.stringify(e); }).join("; ");
    } else {
      msg = data.detail || ("HTTP " + resp.status);
    }
    throw new Error(msg);
  }
  return data;
}

/* ── Session ── */

async function allocateSession() {
  log("Requesting session allocation…", "info");
  setSessionState("allocating");
  try {
    var session = await apiCall("/api/v1/sessions/allocate", "POST");
    _currentSession = session;
    _sessionStopFired = false;
    log("Session " + session.session_id.slice(0, 8) + "… provisioning", "success");
    renderSession(session);
    startPolling();
  } catch (err) {
    log("Allocation failed: " + err.message, "error");
    setSessionState("idle");
  }
}

async function fetchSessionStatus() {
  try {
    var session = await apiCall("/api/v1/sessions/status");
    _currentSession = session;
    _sessionStopFired = false;
    renderSession(session);
    if (session.status === "RUNNING") {
      if (_prevStatus && _prevStatus !== "RUNNING") {
        _notifyReady();
      }
      stopPolling(); startHeartbeat();
    } else if (session.status === "PROVISIONING" || session.status === "PENDING") {
      startPolling();
    } else {
      stopPolling(); stopHeartbeat(); setSessionState("idle");
    }
    _prevStatus = session.status;
  } catch (err) {
    _prevStatus = null;
    renderNoSession();
  }
}

function _notifyReady() {
  log("Codespace is ready.", "success");
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("CloudRAMSaaS", { body: "Your codespace is ready.", icon: "/static/favicon.ico" });
  } else if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  try { document.title = "✓ CloudRAMSaaS — Ready"; setTimeout(function() { document.title = "CloudRAMSaaS"; }, 5000); } catch(_) {}

  _startProjectPolling();
}

function _startProjectPolling() {
  _stopProjectPolling();
  _projectPollCount = 0;
  _projectPollTimer = setInterval(function() {
    _projectPollCount++;
    _projectsLoaded = false;
    refreshCloudProjects();
    if (_projectPollCount >= 6) _stopProjectPolling();
  }, 10000);
}

function _stopProjectPolling() {
  if (_projectPollTimer) { clearInterval(_projectPollTimer); _projectPollTimer = null; }
}

async function stopSession() {
  if (!confirm("Stop your cloud desktop? Your files will be preserved.")) return;
  log("Stopping session…", "info");
  setSessionState("stopping");
  try {
    await apiCall("/api/v1/sessions", "DELETE");
    log("Session stopped.", "success");
    _currentSession = null;
    _sessionStopFired = true;
    stopPolling(); stopHeartbeat(); renderNoSession();
  } catch (err) {
    log("Stop failed: " + err.message, "error");
    setSessionState("running");
  }
}

/* ── Heartbeat / Polling ── */

function startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(async function() {
    try { await apiCall("/api/v1/sessions/heartbeat", "POST"); }
    catch (_) { fetchSessionStatus(); }
  }, 30000);
}
function stopHeartbeat() { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
function startPolling()  { if (_pollInterval) return; _pollInterval = setInterval(fetchSessionStatus, 5000); }
function stopPolling()   { clearInterval(_pollInterval); _pollInterval = null; }

/* ── Provisioning Timer ── */

function _startProvisionTimer() {
  _provisionStart = Date.now();
  var progressEl = document.getElementById("provision-progress");
  if (progressEl) progressEl.style.display = "";
  _updateProvisionTimer();
  if (_provisionTimer) clearInterval(_provisionTimer);
  _provisionTimer = setInterval(_updateProvisionTimer, 1000);
}

function _updateProvisionTimer() {
  var elapsed = (Date.now() - _provisionStart) / 1000;
  var remaining = Math.max(0, Math.ceil(PROVISION_DURATION - elapsed));
  var pct = Math.min((elapsed / PROVISION_DURATION) * 100, 98);

  var fillEl = document.getElementById("provision-fill");
  var timerEl = document.getElementById("provision-timer");
  if (fillEl) fillEl.style.width = pct + "%";
  if (timerEl) {
    if (remaining > 0) {
      timerEl.textContent = "~" + remaining + "s remaining";
    } else {
      timerEl.textContent = "Almost ready…";
    }
  }
}

function _stopProvisionTimer(completed) {
  if (_provisionTimer) { clearInterval(_provisionTimer); _provisionTimer = null; }
  var progressEl = document.getElementById("provision-progress");
  var fillEl = document.getElementById("provision-fill");
  var timerEl = document.getElementById("provision-timer");
  if (completed) {
    if (fillEl) fillEl.style.width = "100%";
    if (timerEl) timerEl.textContent = "Ready";
    setTimeout(function() {
      if (progressEl) progressEl.style.display = "none";
    }, 1500);
  } else {
    if (progressEl) progressEl.style.display = "none";
  }
}

/* ── Rendering ── */

function _showWorkspacePanels(show) {
  var panels = document.getElementById("workspace-panels");
  if (panels) panels.style.display = show ? "" : "none";

  var hint = document.getElementById("session-hint");
  if (hint) hint.style.display = show ? "none" : "";
}

function renderNoSession() {
  var card = document.getElementById("session-card");
  card.className = "card card-session";

  document.getElementById("info-session-id").textContent = "No active session";
  document.getElementById("info-ip").textContent = "";
  document.getElementById("ip-sep").style.display = "none";
  document.getElementById("status-text").textContent = "Inactive";

  _el("btn-connect").style.display = "none";
  _el("btn-stop").style.display = "none";
  _el("btn-allocate").style.display = "";
  setSessionState("idle");
  _stopProvisionTimer(false);
  _stopProjectPolling();
  _showWorkspacePanels(false);
  _updateTransferButtons(false);
}

function renderSession(session) {
  var card = document.getElementById("session-card");

  document.getElementById("info-session-id").textContent =
    session.session_id ? session.session_id.slice(0, 8) + "…" : "—";

  var ip = session.private_ip;
  document.getElementById("info-ip").textContent = ip || "";
  document.getElementById("ip-sep").style.display = ip ? "" : "none";

  var isRunning = session.status === "RUNNING";
  var isPending = session.status === "PROVISIONING" || session.status === "PENDING";

  if (isRunning) {
    card.className = "card card-session is-running";
    document.getElementById("status-text").textContent = "Running";
    setSessionState("running");
    _stopProvisionTimer(true);
    if (session.novnc_url) {
      _el("btn-connect").href = session.novnc_url;
      _el("btn-connect").style.display = "";
    }
    _showWorkspacePanels(true);
  } else if (isPending) {
    card.className = "card card-session is-pending";
    document.getElementById("status-text").textContent = session.status;
    setSessionState("allocating");
    if (!_provisionTimer) _startProvisionTimer();
    _el("btn-connect").style.display = "none";
    _showWorkspacePanels(false);
  } else {
    card.className = "card card-session";
    document.getElementById("status-text").textContent = session.status || "Stopped";
    setSessionState("idle");
    _stopProvisionTimer(false);
    _el("btn-connect").style.display = "none";
    _showWorkspacePanels(false);
  }

  _updateTransferButtons(isRunning);
}

function setSessionState(state) {
  var alloc = _el("btn-allocate");
  var stop  = _el("btn-stop");

  if (state === "idle") {
    alloc.disabled = false;
    alloc.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg> New codespace';
    alloc.style.display = "";
    stop.style.display = "none";
  } else if (state === "allocating") {
    alloc.disabled = true;
    alloc.innerHTML = '<span class="spinner-inline"></span> Provisioning…';
    alloc.style.display = "";
    stop.style.display = "none";
  } else if (state === "running") {
    alloc.style.display = "none";
    stop.style.display = "";
    stop.disabled = false;
    stop.textContent = "Stop codespace";
  } else if (state === "stopping") {
    stop.disabled = true;
    stop.textContent = "Stopping…";
  }
}

function _updateTransferButtons(sessionRunning) {
  var uploadBtn  = _el("btn-upload");
  var refreshBtn = _el("btn-refresh-projects");
  var nameInput  = _el("project-name");
  var hasFiles   = _selectedFiles.length > 0;
  var hasName    = nameInput && nameInput.value.trim();
  if (uploadBtn)  uploadBtn.disabled  = !sessionRunning || !hasFiles || !hasName;
  if (refreshBtn) refreshBtn.disabled = !sessionRunning;

  var saveBtn    = _el("btn-save-ide-config");
  var saveAllBtn = _el("btn-save-all-ide-configs");
  if (saveBtn)    saveBtn.disabled    = !sessionRunning;
  if (saveAllBtn) saveAllBtn.disabled = !sessionRunning;

  if (sessionRunning && !_projectsLoaded) refreshCloudProjects();
  if (!sessionRunning) {
    _projectsLoaded = false;
  }
}

function _el(id) { return document.getElementById(id); }

/* ── Upload ── */

async function uploadProjectToCloud() {
  if (!_currentSession || _currentSession.status !== "RUNNING") { log("Session must be running.", "warning"); return; }
  if (!_selectedFiles.length) { log("Select files first.", "warning"); return; }

  var nameInput   = _el("project-name");
  var projectName = nameInput && nameInput.value.trim();
  if (!projectName) { log("Enter a project name.", "warning"); return; }

  var ideSelect    = _el("ide-select");
  var selectedIde  = ideSelect ? ideSelect.value : "vscode";
  var ideName      = ideSelect ? ideSelect.options[ideSelect.selectedIndex].text : "VS Code";
  var uploadBtn    = _el("btn-upload");
  var statusEl     = _el("upload-status");
  var progressDiv  = _el("upload-progress");
  var progressFill = _el("upload-progress-fill");

  uploadBtn.disabled = true;
  progressDiv.style.display = "";
  progressFill.style.width = "0%";
  statusEl.textContent = "Preparing…";
  log("Packaging " + _selectedFiles.length + " file(s) for " + ideName + "…", "info");

  try {
    var zip = new JSZip();
    for (var i = 0; i < _selectedFiles.length; i++) {
      var file = _selectedFiles[i];
      var relPath = file.webkitRelativePath;
      var zipPath;
      if (relPath && relPath.indexOf("/") !== -1) {
        zipPath = relPath.split("/").slice(1).join("/");
      }
      if (!zipPath) zipPath = file.name;
      zip.file(zipPath, file);
    }

    statusEl.textContent = "Zipping…";
    var zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE" },
      function(meta) {
        progressFill.style.width = (meta.percent * 0.2) + "%";
        statusEl.textContent = "Zipping… " + Math.round(meta.percent) + "%";
      }
    );

    var sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(1);
    statusEl.textContent = "Uploading " + sizeMB + " MB…";
    progressFill.style.width = "20%";

    var token = await getAuthToken();
    var formData = new FormData();
    formData.append("file", zipBlob, projectName + ".zip");
    formData.append("project_name", projectName);
    formData.append("ide", selectedIde);

    var vmData = await new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
          progressFill.style.width = (20 + (e.loaded / e.total) * 50) + "%";
          statusEl.textContent = "Uploading… " + Math.round((e.loaded / e.total) * 100) + "%";
        }
      };
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else {
            var msg = Array.isArray(data.detail)
              ? data.detail.map(function(e) { return e.msg || JSON.stringify(e); }).join("; ")
              : (data.detail || "HTTP " + xhr.status);
            reject(new Error(msg));
          }
        } catch (_) { reject(new Error("Upload failed: HTTP " + xhr.status)); }
      };
      xhr.onerror = function() { reject(new Error("Network error")); };
      xhr.open("POST", _backendUrl + "/api/v1/vm/upload_project");
      xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.send(formData);
    });

    progressFill.style.width = "75%";
    statusEl.textContent = "Setting up on cloud desktop…";

    if (vmData.job_id) {
      for (var j = 0; j < 60; j++) {
        await new Promise(function(r) { setTimeout(r, j === 0 ? 500 : 2000); });
        try {
          var job = await apiCall("/api/v1/vm/setup_status/" + vmData.job_id);
          if (job.status === "done") {
            progressFill.style.width = "100%";
            statusEl.textContent = "Project ready in " + ideName + ".";
            log("\"" + projectName + "\" uploaded and opened in " + ideName + ".", "success");
            _resetUploadForm();
            refreshCloudProjects();
            return;
          }
          if (job.status === "error") throw new Error(job.message || "Setup failed");
          statusEl.textContent = job.message || "Setting up…";
          progressFill.style.width = (75 + Math.min(j, 20)) + "%";
        } catch (pollErr) {
          if (pollErr.message.indexOf("failed") !== -1) throw pollErr;
        }
      }
      throw new Error("Setup timed out");
    }

    progressFill.style.width = "100%";
    statusEl.textContent = "Uploaded.";
    log("\"" + projectName + "\" uploaded.", "success");
    _resetUploadForm();
    refreshCloudProjects();

  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    log("Upload failed: " + err.message, "error");
  } finally {
    _updateTransferButtons(_currentSession && _currentSession.status === "RUNNING");
  }
}

/* ── Projects ── */

async function refreshCloudProjects() {
  var list       = _el("projects-list");
  var refreshBtn = _el("btn-refresh-projects");
  if (!list) return;

  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="spin-icon"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Loading…'; }
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    var data = await apiCall("/api/v1/vm/projects");
    var projects = data.projects || [];
    _projectsLoaded = true;

    if (!projects.length) {
      list.innerHTML = '<div class="empty-state">No projects on your cloud desktop yet.</div>';
      return;
    }

    list.innerHTML = "";
    for (var i = 0; i < projects.length; i++) {
      var name = projects[i];
      var row = document.createElement("div");
      row.className = "project-row";
      row.innerHTML =
        '<span class="project-name">' + escapeHtml(name) + '</span>' +
        '<button class="btn btn-sm btn-outline" onclick="downloadProject(\'' + escapeHtml(name) + '\', this)">Download</button>';
      list.appendChild(row);
    }
  } catch (err) {
    _projectsLoaded = true;
    list.innerHTML = '<div class="empty-state">Could not load projects.</div>';
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Refresh';
    }
  }
}

async function downloadProject(projectName, btn) {
  var statusEl = _el("download-status");
  var origHTML = btn.innerHTML;

  btn.disabled = true;
  btn.textContent = "Exporting…";
  if (statusEl) statusEl.textContent = "Syncing \"" + projectName + "\" from cloud desktop…";
  log("Downloading \"" + projectName + "\"…", "info");

  try {
    var ctx = await getAuthContext();
    var exportData = await apiCall("/api/v1/vm/export_project", "POST", { project_name: projectName });

    btn.textContent = "Downloading…";
    if (statusEl) statusEl.textContent = "Generating download link…";
    var signResp = await apiCall("/api/v1/s3/sign_get", "POST", {
      user_id: ctx.user_id,
      bucket: exportData.bucket,
      key: exportData.key,
    });

    var a = document.createElement("a");
    a.href = signResp.url;
    a.download = projectName + ".zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (statusEl) statusEl.textContent = "\"" + projectName + "\" download started.";
    log("\"" + projectName + "\" download started.", "success");

  } catch (err) {
    if (statusEl) statusEl.textContent = "Failed: " + err.message;
    log("Download failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

/* ── IDE Settings ── */

async function saveIDEConfig() {
  if (!_currentSession || _currentSession.status !== "RUNNING") { log("Session must be running.", "warning"); return; }

  var ideSelect = _el("save-ide-select");
  var ide       = ideSelect ? ideSelect.value : "vscode";
  var ideName   = ideSelect ? ideSelect.options[ideSelect.selectedIndex].text : "VS Code";
  var btn       = _el("btn-save-ide-config");
  var statusEl  = _el("ide-config-status");
  var origHTML  = btn.innerHTML;

  btn.disabled = true;
  btn.textContent = "Saving…";
  if (statusEl) statusEl.textContent = "Saving " + ideName + " settings…";
  log("Saving " + ideName + " settings…", "info");

  try {
    var result = await apiCall("/api/v1/vm/save_ide_config", "POST", { ide: ide });
    if (result.saved) {
      if (statusEl) statusEl.textContent = ideName + " settings saved (" + result.files + " files).";
      log(ideName + " settings saved successfully.", "success");
    } else {
      if (statusEl) statusEl.textContent = "Nothing to save: " + (result.reason || "no config found.");
      log(ideName + ": " + (result.reason || "no config found."), "warning");
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "Failed: " + err.message;
    log("Save failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

async function saveAllIDEConfigs() {
  if (!_currentSession || _currentSession.status !== "RUNNING") { log("Session must be running.", "warning"); return; }

  var btn      = _el("btn-save-all-ide-configs");
  var statusEl = _el("ide-config-status");
  var origHTML = btn.innerHTML;

  btn.disabled = true;
  btn.textContent = "Saving all…";
  if (statusEl) statusEl.textContent = "Saving all IDE settings…";
  log("Saving all IDE settings…", "info");

  try {
    var result = await apiCall("/api/v1/vm/save_all_ide_configs", "POST");
    var saved = [];
    var results = result.results || {};
    for (var ide in results) {
      if (results[ide].saved) saved.push(ide);
    }
    if (saved.length) {
      if (statusEl) statusEl.textContent = "Saved settings for: " + saved.join(", ") + ".";
      log("Saved settings for: " + saved.join(", ") + ".", "success");
    } else {
      if (statusEl) statusEl.textContent = "No IDE settings found to save.";
      log("No IDE settings found to save.", "warning");
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "Failed: " + err.message;
    log("Save all failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

/* ── Log ── */

function log(msg, type) {
  var list = _el("log-list");
  if (!list) return;
  var entry = document.createElement("div");
  entry.className = "log-entry log-" + (type || "info");
  var time = new Date().toLocaleTimeString();
  entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-msg">' + escapeHtml(msg) + '</span>';
  list.prepend(entry);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
