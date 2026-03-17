"use strict";

let _supabase          = null;
let _backendUrl        = "";
let _agentUrl          = "http://127.0.0.1:7071";
let _pollInterval      = null;
let _heartbeatInterval = null;
let _agentInterval     = null;
let _currentSession    = null;
let _agentDetected     = false;

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
function initDashboard(supabaseUrl, supabaseAnonKey, backendApiUrl, agentUrl) {
  _supabase   = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  _backendUrl = backendApiUrl;
  _agentUrl   = agentUrl || "http://127.0.0.1:7071";

  _supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session) { window.location.href = "/"; return; }
    document.getElementById("user-email").textContent = session.user.email;
    fetchSessionStatus();
  });

  // Wire buttons
  document.getElementById("migrate-vscode-btn")?.addEventListener("click", migrateVSCodeProject);
  document.getElementById("save-local-btn")?.addEventListener("click", saveProjectToLocal);

  // Agent detection — fast at first, slow once connected
  checkAgent();
  _agentInterval = setInterval(checkAgent, 5000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { fetchSessionStatus(); checkAgent(); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent detection
// ─────────────────────────────────────────────────────────────────────────────
async function checkAgent() {
  try {
    const resp = await fetch(`${_agentUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok) { setAgentDetected(true, data.platform || "Unknown"); return; }
    }
    setAgentDetected(false);
  } catch (_) {
    setAgentDetected(false);
  }
}

function setAgentDetected(detected, platformName) {
  _agentDetected = detected;

  const dot            = document.getElementById("agent-dot");
  const statusText     = document.getElementById("agent-status-text");
  const downloadSec    = document.getElementById("agent-download-section");
  const detectedSec    = document.getElementById("agent-detected-section");
  const platformDetail = document.getElementById("agent-platform-detail");
  const allocBtn       = document.getElementById("btn-allocate");
  const hint           = document.getElementById("agent-required-hint");
  const refreshBtn     = document.getElementById("refresh-tasks-btn");

  if (detected) {
    dot.className          = "agent-dot dot-online";
    statusText.textContent = "Local Agent: Connected";
    document.getElementById("agent-platform").textContent = platformName;
    downloadSec.classList.add("hidden");
    detectedSec.classList.remove("hidden");
    if (platformDetail) platformDetail.textContent = platformName;

    // Enable allocate only if no active session
    if (!_currentSession || ["STOPPED","DEPROVISIONING","DELETED"].includes(_currentSession.status)) {
      allocBtn.disabled = false;
      allocBtn.title    = "";
      if (hint) hint.classList.add("hidden");
    }

    // Enable refresh tasks button
    if (refreshBtn) refreshBtn.disabled = false;

    // Slow down agent polling once confirmed running
    clearInterval(_agentInterval);
    _agentInterval = setInterval(checkAgent, 10000);

  } else {
    dot.className          = "agent-dot dot-offline";
    statusText.textContent = "Local Agent: Not detected";
    document.getElementById("agent-platform").textContent = "";
    downloadSec.classList.remove("hidden");
    detectedSec.classList.add("hidden");
    allocBtn.disabled = true;
    allocBtn.title    = "Start the local agent first";
    if (hint) hint.classList.remove("hidden");

    // Disable task controls
    if (refreshBtn) refreshBtn.disabled = true;
    _resetTasksUI("Start the local agent to view tasks.");
    _setMigrationButtons(false, false, false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────
async function getAuthToken() {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return session.access_token;
}

// FIX: always refresh the Supabase session before returning the token
// so the agent never forwards a stale/expired token to the backend
async function getAuthContext() {
  try {
    const { data: { session }, error } = await _supabase.auth.refreshSession();
    if (!error && session) {
      return { access_token: session.access_token, user_id: session.user.id };
    }
  } catch (_) {
    // fall through to getSession fallback
  }
  // Fallback: use existing session if refresh fails
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return { access_token: session.access_token, user_id: session.user.id };
}

async function handleSignOut() {
  stopPolling(); stopHeartbeat();
  clearInterval(_agentInterval);
  await _supabase.auth.signOut();
  window.location.href = "/";
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend API
// ─────────────────────────────────────────────────────────────────────────────
async function apiCall(path, method = "GET", body = null) {
  const token = await getAuthToken();
  const opts  = { method, headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${_backendUrl}${path}`, opts);
  if (resp.status === 204) return null;
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent API  — passes auth context in every POST body
// ─────────────────────────────────────────────────────────────────────────────
async function agentCall(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (method !== "GET") {
    const ctx  = await getAuthContext();
    opts.body  = JSON.stringify({ ...(body || {}), ...ctx });
  }
  const resp = await fetch(`${_agentUrl}${path}`, opts);
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || `Agent HTTP ${resp.status}`);
  return data;
}

function getRunningVmIp() {
  return (_currentSession?.status === "RUNNING") ? (_currentSession.private_ip || null) : null;
}

// FIX: removed duplicate definition that was always returning 5000
function getRunningApiPort() {
  return (_currentSession?.status === "RUNNING") ? (_currentSession.api_port || 7000) : 7000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session actions
// ─────────────────────────────────────────────────────────────────────────────
async function allocateSession() {
  if (!_agentDetected) { log("Local agent not detected. Install and start the agent first.", "error"); return; }
  log("Requesting session allocation...", "info");
  setButtonState("allocating");
  try {
    const session   = await apiCall("/api/v1/sessions/allocate", "POST");
    _currentSession = session;
    log(`Session ${session.session_id.slice(0,8)}... provisioning started`, "success");
    renderSession(session);
    startPolling();
  } catch (err) {
    log(`Allocation failed: ${err.message}`, "error");
    setButtonState("idle");
  }
}

async function fetchSessionStatus() {
  try {
    const session   = await apiCall("/api/v1/sessions/status");
    _currentSession = session;
    renderSession(session);
    if (session.status === "RUNNING") {
      stopPolling(); startHeartbeat();
    } else if (["PROVISIONING","PENDING"].includes(session.status)) {
      startPolling();
    } else {
      stopPolling(); stopHeartbeat(); setButtonState("idle");
    }
  } catch (err) {
    if (err.message.includes("404") || err.message.toLowerCase().includes("no active session")) {
      renderNoSession();
    } else {
      log(`Status check failed: ${err.message}`, "warning");
      renderNoSession();
    }
  }
}

async function stopSession() {
  if (!confirm("Stop your cloud desktop? Workspace files on EFS are preserved.")) return;
  log("Stopping session...", "info");
  setButtonState("stopping");
  try {
    await apiCall("/api/v1/sessions", "DELETE");
    log("Session stopped.", "success");
    _currentSession = null;
    stopPolling(); stopHeartbeat(); renderNoSession();
  } catch (err) {
    log(`Stop failed: ${err.message}`, "error");
    setButtonState("running");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat / Polling
// ─────────────────────────────────────────────────────────────────────────────
function startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(async () => {
    try { await apiCall("/api/v1/sessions/heartbeat", "POST"); }
    catch (_) { fetchSessionStatus(); }
  }, 30_000);
}
function stopHeartbeat() { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
function startPolling()  { if (_pollInterval) return; _pollInterval = setInterval(fetchSessionStatus, 5_000); }
function stopPolling()   { clearInterval(_pollInterval); _pollInterval = null; }

// ─────────────────────────────────────────────────────────────────────────────
// UI rendering
// ─────────────────────────────────────────────────────────────────────────────
function renderNoSession() {
  setBadge("inactive", "No Session");
  document.getElementById("info-session-id").textContent = "—";
  document.getElementById("info-ip").textContent         = "—";
  document.getElementById("info-port").textContent       = "—";
  document.getElementById("btn-allocate").classList.remove("hidden");
  document.getElementById("btn-stop").classList.add("hidden");
  document.getElementById("btn-connect").classList.add("hidden");
  document.getElementById("btn-allocate").disabled = !_agentDetected;
  const hint = document.getElementById("agent-required-hint");
  if (hint) hint.classList.toggle("hidden", _agentDetected);
  setButtonState("idle");
  _setMigrationButtons(false, false, false);
}

function renderSession(session) {
  document.getElementById("info-session-id").textContent =
    session.session_id ? session.session_id.slice(0,8) + "..." : "—";
  document.getElementById("info-ip").textContent   = session.private_ip || "Pending...";
  document.getElementById("info-port").textContent = session.novnc_port || 6080;

  const isRunning      = session.status === "RUNNING";
  const isProvisioning = ["PROVISIONING","PENDING"].includes(session.status);
  const isStopped      = ["STOPPED","DEPROVISIONING","DELETED"].includes(session.status);

  if (isRunning) {
    setBadge("running", "Running");
    setButtonState("running");
    if (session.novnc_url) {
      const btn = document.getElementById("btn-connect");
      btn.href  = session.novnc_url;
      btn.classList.remove("hidden");
    }
  } else if (isProvisioning) {
    setBadge("provisioning", session.status);
    setButtonState("allocating");
    document.getElementById("btn-connect").classList.add("hidden");
  } else if (isStopped) {
    setBadge("inactive", "Stopped");
    setButtonState("idle");
    document.getElementById("btn-connect").classList.add("hidden");
  } else {
    setBadge("unknown", session.status);
  }

  // Save-to-local only makes sense when session is running
  const saveBtn = document.getElementById("save-local-btn");
  if (saveBtn) saveBtn.disabled = !isRunning;
}

function setBadge(type, label) {
  document.getElementById("status-badge").className = `status-badge badge-${type}`;
  document.getElementById("status-text").textContent = label;
}

function setButtonState(state) {
  const allocBtn = document.getElementById("btn-allocate");
  const stopBtn  = document.getElementById("btn-stop");
  if (state === "idle") {
    allocBtn.disabled   = !_agentDetected;
    allocBtn.innerHTML  = "<span>⚡ Allocate Desktop</span>";
    allocBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
  } else if (state === "allocating") {
    allocBtn.disabled  = true;
    allocBtn.innerHTML = '<span class="spinner-inline"></span><span>Provisioning...</span>';
    allocBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
  } else if (state === "running") {
    allocBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    stopBtn.disabled    = false;
    stopBtn.textContent = "Stop Session";
  } else if (state === "stopping") {
    stopBtn.disabled    = true;
    stopBtn.textContent = "Stopping...";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks — MANUAL refresh only (no auto-refresh)
// ─────────────────────────────────────────────────────────────────────────────
function setTasksBadge(type, label) {
  const badge = document.getElementById("tasks-badge");
  if (!badge) return;
  badge.className = `status-badge badge-${type}`;
  document.getElementById("tasks-status-text").textContent = label;
}

function _resetTasksUI(msg) {
  const loading = document.getElementById("task-loading");
  const select  = document.getElementById("tasks");
  if (loading) { loading.style.display = "block"; loading.textContent = msg || ""; }
  if (select)  { select.style.display = "none"; select.innerHTML = ""; }
  setTasksBadge("inactive", "Waiting for agent...");
}

function _setMigrationButtons(hasTasks, hasVSCode, sessionRunning) {
  const vscodeBtn  = document.getElementById("migrate-vscode-btn");
  const saveBtn    = document.getElementById("save-local-btn");

  if (vscodeBtn) {
    if (hasVSCode) {
      vscodeBtn.classList.remove("hidden");
      vscodeBtn.disabled = !sessionRunning;
      vscodeBtn.title    = sessionRunning ? "" : "Session must be RUNNING to migrate";
    } else {
      vscodeBtn.classList.add("hidden");
    }
  }

  if (saveBtn) saveBtn.disabled = !sessionRunning;
}

async function refreshLocalTasks() {
  const loading    = document.getElementById("task-loading");
  const select     = document.getElementById("tasks");
  const refreshBtn = document.getElementById("refresh-tasks-btn");

  if (!loading || !select) return;

  if (!_agentDetected) {
    _resetTasksUI("Start the local agent to view tasks.");
    _setMigrationButtons(false, false, false);
    return;
  }

  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "Refreshing..."; }

  try {
    setTasksBadge("provisioning", "Fetching...");
    loading.style.display = "block";
    loading.textContent   = "Fetching running tasks...";
    select.style.display  = "none";

    const data  = await agentCall("/running_tasks", "GET");
    const tasks = data?.tasks || [];

    select.innerHTML = "";
    tasks.forEach(t => {
      const opt       = document.createElement("option");
      opt.value       = t.name;
      opt.textContent = `${t.name}  (pid ${t.pid})`;
      select.appendChild(opt);
    });

    if (tasks.length > 0) {
      loading.style.display = "none";
      select.style.display  = "block";
    } else {
      loading.style.display = "block";
      loading.textContent   = "No tracked tasks running (notepad++.exe, chrome.exe, Code.exe).";
      select.style.display  = "none";
    }

    const vmIp      = getRunningVmIp();
    const hasVSCode = tasks.some(t => (t.name || "").toLowerCase() === "code.exe");

    _setMigrationButtons(tasks.length > 0, hasVSCode, !!vmIp);
    setTasksBadge(tasks.length > 0 ? "running" : "inactive", `${tasks.length} task(s) found`);
    log(`Tasks refreshed — ${tasks.length} running`, "info");

  } catch (err) {
    setTasksBadge("unknown", "Error");
    loading.style.display = "block";
    loading.textContent   = `Failed to fetch tasks: ${err.message}`;
    select.style.display  = "none";
    log(`Task fetch failed: ${err.message}`, "warning");
  } finally {
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "↺ Refresh Tasks"; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrate VSCode project  →  S3 (via presigned PUT)  →  EFS on VM
// ─────────────────────────────────────────────────────────────────────────────
async function migrateVSCodeProject() {
  const vmIp = getRunningVmIp();
  if (!vmIp) { log("Session must be RUNNING to migrate VSCode project.", "warning"); return; }

  const spinner  = document.getElementById("vscode-spinner");
  const statusEl = document.getElementById("vscode-status");

  spinner.style.display = "inline-block";
  statusEl.textContent  = "Zipping project + uploading to S3...";
  log("VSCode migration started — zipping and uploading to S3...", "info");

  try {
    const resp = await agentCall("/migrate_vscode", "POST", { vm_ip: vmIp, api_port: getRunningApiPort() });

    statusEl.textContent = resp.message || "VSCode project migrated to cloud desktop.";
    if (resp.opened_path) statusEl.textContent += ` (${resp.opened_path})`;
    log(`VSCode migrated successfully. VM will extract to EFS.`, "success");

    await refreshLocalTasks();

  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    log(`VSCode migration failed: ${err.message}`, "error");
  } finally {
    spinner.style.display = "none";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save project from VM EFS → S3 → local machine
// ─────────────────────────────────────────────────────────────────────────────
async function saveProjectToLocal() {
  const vmIp = getRunningVmIp();
  if (!vmIp) { log("Session must be RUNNING to save project to local.", "warning"); return; }

  const projectName = prompt("Enter the project name to download from your cloud desktop:");
  if (!projectName?.trim()) return;

  const spinner  = document.getElementById("save-local-spinner");
  const statusEl = document.getElementById("save-local-status");

  spinner.style.display = "inline-block";
  statusEl.textContent  = "Exporting from EFS → S3 → local...";

  try {
    const resp = await agentCall("/save_project_to_local", "POST", {
      vm_ip:        vmIp,
      api_port:     getRunningApiPort(),
      project_name: projectName.trim(),
    });
    statusEl.textContent = resp.message || "Saved.";
    log(`Saved "${projectName}" to local machine.`, "success");
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    log(`Save failed: ${err.message}`, "error");
  } finally {
    spinner.style.display = "none";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Log
// ─────────────────────────────────────────────────────────────────────────────
function log(msg, type = "info") {
  const list  = document.getElementById("log-list");
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  const time  = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
  list.prepend(entry);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function toggleFullscreen() {
  const iframe = document.getElementById("novnc-iframe");
  if (iframe?.requestFullscreen) iframe.requestFullscreen();
}