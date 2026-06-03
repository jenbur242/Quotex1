/* ── QUOTEX1 Dashboard Frontend ─────────────────────────── */

const socket = io();
const MAX_LOGS = 300;

// ── State ────────────────────────────────────────────────
let state = {
  botRunning: false,
  connections: { telegram: false, quotex: false },
  metrics: { daily_trades: 0, wins: 0, losses: 0, daily_pnl: 0, active_signals: 0, alert: null },
};

// Holds full loaded config so hardcoded fields are preserved on save
let _loadedConfig = {};

// ── DOM helpers ──────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

// ── Theme ─────────────────────────────────────────────────
const htmlEl = document.documentElement;

function applyTheme(theme) {
  htmlEl.dataset.theme = theme;
  const icon = $('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem('qx1-theme', theme);
}

$('btn-theme')?.addEventListener('click', () => {
  applyTheme(htmlEl.dataset.theme === 'dark' ? 'light' : 'dark');
});

// Sync icon with whatever theme the anti-flash script already applied
applyTheme(htmlEl.dataset.theme || 'dark');

// ── Tabs ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + target));
  });
});

// ── Bot control ──────────────────────────────────────────
const btnToggle = $('btn-toggle');

btnToggle.addEventListener('click', async () => {
  if (btnToggle.classList.contains('loading')) return;
  setBtnLoading(true);

  const action = state.botRunning ? 'stop' : 'start';
  try {
    const res = await api('POST', `/api/bot/${action}`);
    if (!res.success) {
      showToast(res.message || 'Failed', 'error');
      setBtnLoading(false);
    }
    // UI updates via SocketIO state_update / bot_status
  } catch {
    showToast('Connection error', 'error');
    setBtnLoading(false);
  }
});

function setBtnLoading(on) {
  btnToggle.classList.toggle('loading', on);
  btnToggle.innerHTML = on
    ? '<div class="spinner"></div><div class="btn-text">WAIT...</div>'
    : renderBtnContent(state.botRunning);
  btnToggle.disabled = on;
}

function renderBtnContent(running) {
  return running
    ? '<div class="btn-icon">■</div><div class="btn-text">STOP</div>'
    : '<div class="btn-icon">▶</div><div class="btn-text">START</div>';
}

function updateBotButton(running) {
  state.botRunning = running;
  btnToggle.classList.remove('loading');
  btnToggle.classList.toggle('running', running);
  btnToggle.disabled = false;
  btnToggle.innerHTML = renderBtnContent(running);
  refreshAlert();
}

// ── Metrics ───────────────────────────────────────────────
function updateMetrics(s) {
  $('metric-trades').textContent  = s.daily_trades ?? 0;
  $('metric-signals').textContent = s.active_signals ?? 0;

  const wins   = s.wins ?? 0;
  const losses = s.losses ?? 0;
  const total  = wins + losses;
  const rate   = total > 0 ? Math.round((wins / total) * 100) : 0;
  $('metric-winrate').textContent = rate + '%';

  // In percent risk mode, daily P&L is expressed as % of the day's opening balance.
  const isPct = s.risk_mode === 'percent';
  const pnlVal = Number(s.daily_pnl ?? 0);
  const pnlEl = $('metric-pnl');
  const sign = pnlVal < 0 ? '-' : '+';
  const abs  = Math.abs(pnlVal).toFixed(2);
  pnlEl.textContent = isPct ? `${sign}${abs}%` : `${sign}$${abs}`;
  pnlEl.className = 'metric-value ' + (pnlVal >= 0 ? 'text-green' : 'text-red');

  const sub = $('metric-pnl-sub');
  if (sub) sub.textContent = isPct ? 'Daily P&L (% of balance)' : 'Realized daily P&L';
}

// ── Header status ─────────────────────────────────────────
function updateHeaderStatus(running) {
  const pill = $('header-status');
  pill.className = 'header-status ' + (running ? 'running' : 'stopped');
  pill.innerHTML = `<div class="status-dot ${running ? 'pulse' : ''}"></div>${running ? 'RUNNING' : 'STOPPED'}`;
}

// ── Alert banner ──────────────────────────────────────────
let _serverAlert = null;   // last real error from bot_state.json

function setAlert(msg) {
  const banner = $('alert-banner');
  if (msg) {
    $('alert-text').textContent = msg;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

/**
 * Decide what (if anything) to show in the alert banner.
 * Priority:
 *   1. Real server error alert (login failures, health monitor errors)
 *   2. Dynamic connection warning when bot is running but connections missing
 *   3. Nothing
 */
function refreshAlert() {
  // Real error from the bot always takes priority
  if (_serverAlert) {
    setAlert(_serverAlert);
    return;
  }
  // Dynamic connection warnings (only relevant when bot is running)
  if (state.botRunning) {
    const tg = state.connections.telegram;
    const qx = state.connections.quotex;
    if (!tg && !qx) {
      setAlert('Telegram and Quotex are not connected — configure both in Settings to enable trading.');
      return;
    }
    if (!qx) {
      setAlert('Quotex not connected — go to Settings → Quotex Account and click Connect.');
      return;
    }
    if (!tg) {
      setAlert('Telegram not connected — go to Settings → Connections and connect Telegram.');
      return;
    }
  }
  setAlert(null);
}

document.querySelector('.alert-close')?.addEventListener('click', () => {
  _serverAlert = null;
  setAlert(null);
});

// ── Activity log ──────────────────────────────────────────
const logPanel = $('log-panel');

function addLog(time, msg, level = 'INFO') {
  const entry = el('div', 'log-entry');
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${level}">${escHtml(msg)}</span>`;
  logPanel.appendChild(entry);

  // Trim old entries
  while (logPanel.children.length > MAX_LOGS) {
    logPanel.removeChild(logPanel.firstChild);
  }
  // Auto-scroll if near bottom
  if (logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 60) {
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SocketIO events ───────────────────────────────────────
socket.on('connect', () => addLog(now(), 'Dashboard connected', 'INFO'));
socket.on('disconnect', () => addLog(now(), 'Dashboard disconnected', 'WARNING'));

socket.on('state_update', s => {
  const running = s.bot_running ?? false;
  if (running !== state.botRunning) updateBotButton(running);
  updateHeaderStatus(running);
  updateMetrics(s);
  // Store real server errors; connection warnings are handled dynamically by refreshAlert()
  _serverAlert = s.alert || null;
  if (s.connections) updateConnectionBadges(s.connections);
  // refreshAlert() is called inside updateConnectionBadges → always runs last
});

socket.on('bot_status', d => {
  updateBotButton(d.running);
  updateHeaderStatus(d.running);
});

socket.on('log', d => addLog(d.time || now(), d.message, d.level || 'INFO'));


// ── Connection badges ─────────────────────────────────────
function updateConnectionBadges(conn) {
  state.connections = conn;
  setConnBadge('tg-badge',     conn.telegram, 'Connected', 'Disconnected');
  setConnBadge('qx-badge',     conn.quotex,   'Connected', 'Offline');
  setConnBadge('tg-badge-hdr', conn.telegram, 'Connected', 'Disconnected');
  setConnBadge('qx-badge-hdr', conn.quotex,   'Connected', 'Offline');
  refreshAlert();
}

function setConnBadge(id, ok, yesLabel, noLabel) {
  const el = $(id);
  if (!el) return;
  el.className = 'conn-badge ' + (ok ? 'connected' : 'disconnected');
  el.innerHTML = `<div class="status-dot${ok ? ' pulse' : ''}"></div>${ok ? yesLabel : noLabel}`;
}

// ── Telegram auth modal ───────────────────────────────────
let tgPhone = '';

$('btn-tg-connect')?.addEventListener('click', () => {
  if (state.connections.telegram) {
    disconnectTelegram();
  } else {
    openModal('modal-telegram');
    showTgStep('step-phone');
  }
});

$('btn-tg-send-code')?.addEventListener('click', async () => {
  const phone = $('tg-phone').value.trim();
  if (!phone) { showFieldError('tg-phone', 'Enter your phone number'); return; }
  tgPhone = phone;
  setBtnBusy('btn-tg-send-code', true, 'Sending...');

  const res = await api('POST', '/api/telegram/connect', { phone });
  setBtnBusy('btn-tg-send-code', false, 'Send Code');

  if (res.success) {
    showTgStep('step-code');
  } else {
    showToast(res.message || 'Failed to send code', 'error');
  }
});

$('btn-tg-verify')?.addEventListener('click', async () => {
  const code = $('tg-code').value.trim();
  if (!code) { showFieldError('tg-code', 'Enter the code'); return; }
  setBtnBusy('btn-tg-verify', true, 'Verifying...');

  const res = await api('POST', '/api/telegram/verify', { phone: tgPhone, code });
  setBtnBusy('btn-tg-verify', false, 'Verify');

  if (res.success) {
    showTgStep('step-success');
    state.connections.telegram = true;
    updateConnectionBadges(state.connections);
    setTimeout(() => closeModal('modal-telegram'), 2000);
  } else if (res.needs_password) {
    showTgStep('step-password');
  } else {
    showToast(res.message || 'Invalid code', 'error');
  }
});

$('btn-tg-password')?.addEventListener('click', async () => {
  const pw = $('tg-password').value;
  if (!pw) { showFieldError('tg-password', 'Enter your password'); return; }
  setBtnBusy('btn-tg-password', true, 'Verifying...');

  const res = await api('POST', '/api/telegram/password', { password: pw });
  setBtnBusy('btn-tg-password', false, 'Submit');

  if (res.success) {
    showTgStep('step-success');
    state.connections.telegram = true;
    updateConnectionBadges(state.connections);
    setTimeout(() => closeModal('modal-telegram'), 2000);
  } else {
    showToast(res.message || 'Wrong password', 'error');
  }
});

function showTgStep(id) {
  document.querySelectorAll('#modal-telegram .modal-step').forEach(s => {
    s.classList.toggle('active', s.id === id);
  });
}

async function disconnectTelegram() {
  await api('POST', '/api/telegram/disconnect');
  state.connections.telegram = false;
  updateConnectionBadges(state.connections);
  showToast('Telegram disconnected', 'info');
}

// ── Quotex connect modal ──────────────────────────────────

function showQxStep(id) {
  document.querySelectorAll('#modal-quotex .modal-step').forEach(s => {
    s.classList.toggle('active', s.id === id);
  });
}

$('btn-qx-connect')?.addEventListener('click', () => {
  if (state.connections.quotex) {
    disconnectQuotex();
  } else {
    openModal('modal-quotex');
    showQxStep('qx-step-form');
    // Pre-fill from the Settings form fields (always reflects the latest saved values)
    setValue('qx-email',    $('s-qx-email')?.value    || '');
    setValue('qx-password', $('s-qx-password')?.value || '');
  }
});

$('btn-qx-save')?.addEventListener('click', async () => {
  const email    = $('qx-email').value.trim();
  const password = $('qx-password').value;
  if (!email)    { showFieldError('qx-email',    'Enter your Quotex email');    return; }
  if (!password) { showFieldError('qx-password', 'Enter your Quotex password'); return; }

  showQxStep('qx-step-testing');

  // /api/quotex/connect may block for up to 10 minutes (OTP wait) — don't await here;
  // the result comes back via SocketIO events (quotex_otp_required / connection_update).
  api('POST', '/api/quotex/connect', { email, password }).then(res => {
    if ($('qx-step-testing').classList.contains('active') ||
        $('qx-step-pin').classList.contains('active')) {
      if (res.success) {
        _onQxConnected(email, password);
      } else {
        $('quotex-error-msg').textContent = res.message || 'Login failed — check your credentials.';
        showQxStep('qx-step-failed');
      }
    }
  });
});

// SocketIO: Quotex requests a PIN from the user's email
socket.on('quotex_otp_required', d => {
  showQxStep('qx-step-pin');
  setValue('qx-pin', '');
  $('qx-pin')?.focus();
});

$('btn-qx-pin')?.addEventListener('click', async () => {
  const pin = ($('qx-pin')?.value || '').replace(/\s/g, '');
  if (!pin) { showFieldError('qx-pin', 'Enter the PIN from your email'); return; }
  setBtnBusy('btn-qx-pin', true, 'Submitting…');

  const res = await api('POST', '/api/quotex/pin', { pin });
  setBtnBusy('btn-qx-pin', false, 'Submit PIN');

  if (res.success) {
    // PIN submitted — go back to "testing" spinner while connect continues
    showQxStep('qx-step-testing');
  } else {
    showToast(res.message || 'Failed to submit PIN', 'error');
  }
});

// SocketIO: Quotex connected successfully (fired after OTP accepted)
socket.on('connection_update', d => {
  if (d.telegram !== undefined) state.connections.telegram = d.telegram;
  if (d.quotex   !== undefined) {
    state.connections.quotex = d.quotex;
    if (d.quotex && document.getElementById('modal-quotex')?.classList.contains('open')) {
      const email    = $('qx-email')?.value    || '';
      const password = $('qx-password')?.value || '';
      _onQxConnected(email, password);
    }
  }
  updateConnectionBadges(state.connections);
});

function _onQxConnected(email, password) {
  showQxStep('qx-step-success');
  state.connections.quotex = true;
  updateConnectionBadges(state.connections);
  setValue('s-qx-email',    email);
  setValue('s-qx-password', password);
  _loadedConfig.quotex = { ...(_loadedConfig.quotex || {}), email, password };
  setTimeout(() => closeModal('modal-quotex'), 2000);
}

async function disconnectQuotex() {
  await api('POST', '/api/quotex/disconnect');
  state.connections.quotex = false;
  updateConnectionBadges(state.connections);
  showToast('Quotex credentials cleared', 'info');
}

// ── Settings ──────────────────────────────────────────────
async function loadSettings() {
  const cfg = await api('GET', '/api/settings');
  if (!cfg) return;
  _loadedConfig = cfg;  // preserve hardcoded fields for save

  const t = cfg.telegram || {};
  const q = cfg.quotex   || {};
  const tr = cfg.trading  || {};
  const lo = cfg.logging  || {};

  // Telegram (session name and sticker IDs are hardcoded — not shown in UI)
  setValue('s-api-id',   t.api_id   || '');
  setValue('s-api-hash', t.api_hash || '');

  // Quotex
  setValue('s-qx-email',    q.email    || '');
  setValue('s-qx-password', q.password || '');
  setValue('s-wait-trades', q.wait_between_trades ?? 30);

  // Trading
  setValue('s-account-type', tr.account_type || 'demo');
  setValue('s-risk-mode',    tr.risk_mode    || 'fixed');
  applyRiskModeUnits(tr.risk_mode || 'fixed');
  setValue('s-risk-amount',  tr.risk_amount  ?? 1);
  setValue('s-max-trades',   tr.max_daily_trades   ?? 10);
  setValue('s-max-loss',     tr.max_daily_loss     ?? 50);
  setValue('s-max-concurrent', tr.max_concurrent_trades ?? 1);

  // Martingale
  setChecked('s-martingale-enabled', tr.martingale_enabled || false);
  setValue('s-martingale-mult',  tr.martingale_multiplier ?? 2.0);
  setValue('s-martingale-steps', tr.martingale_max_steps  ?? 5);
  toggleMartingaleFields(tr.martingale_enabled || false);

  // Logging
  setValue('s-log-level', lo.log_level || 'INFO');
  setValue('s-log-file',  lo.log_file  || 'quotex_bot.log');

  // Channels
  renderChannels(t.channels || []);
}

function renderChannels(channels) {
  const list = $('channel-list');
  list.innerHTML = '';
  (channels.length ? channels : [{ enabled: true, identifier: '' }]).forEach((ch, i) => {
    const item = el('div', 'channel-item');
    item.innerHTML = `
      <label class="toggle" title="Enable/Disable">
        <input type="checkbox" ${ch.enabled ? 'checked' : ''} data-ch="${i}" class="ch-enabled">
        <span class="toggle-track"></span>
      </label>
      <input type="text" value="${ch.identifier || ''}" placeholder="Channel name, @username or numeric ID"
             data-ch="${i}" class="ch-id" style="flex:1;">
      <button class="btn btn-danger btn-sm" onclick="removeChannel(${i})">✕</button>`;
    list.appendChild(item);
  });
}

function addChannel() {
  const items = document.querySelectorAll('.channel-item');
  const channels = getChannelsFromDOM();
  channels.push({ enabled: true, identifier: '' });
  renderChannels(channels);
}

function removeChannel(idx) {
  const channels = getChannelsFromDOM();
  channels.splice(idx, 1);
  renderChannels(channels.length ? channels : [{ enabled: true, identifier: '' }]);
}

function getChannelsFromDOM() {
  const items = document.querySelectorAll('.channel-item');
  return Array.from(items).map(item => ({
    enabled:    item.querySelector('.ch-enabled').checked,
    identifier: item.querySelector('.ch-id').value.trim(),
  }));
}

$('s-martingale-enabled')?.addEventListener('change', function () {
  toggleMartingaleFields(this.checked);
});

function toggleMartingaleFields(on) {
  $('martingale-fields').style.display = on ? '' : 'none';
}

// When risk mode is "% of balance", risk amount, daily loss (and P&L) are all
// percentages — relabel the settings inputs so the units match.
$('s-risk-mode')?.addEventListener('change', function () {
  applyRiskModeUnits(this.value);
});

function applyRiskModeUnits(mode) {
  const isPct = mode === 'percent';
  const ra = $('lbl-risk-amount');
  const ml = $('lbl-max-loss');
  if (ra) ra.textContent = isPct ? 'Risk Amount (% of balance)' : 'Risk Amount ($)';
  if (ml) ml.textContent = isPct ? 'Max Daily Loss (%)'         : 'Max Daily Loss ($)';
}

async function saveSettings() {
  const btn = $('btn-save');
  btn.classList.add('btn-saving');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  const cfg = buildConfigFromForm();
  const res = await api('POST', '/api/settings', cfg);

  btn.classList.remove('btn-saving');
  btn.textContent = 'Save Settings';
  btn.disabled = false;

  if (res.success) showToast('Settings saved', 'success');
  else             showToast('Save failed: ' + (res.message || ''), 'error');
}

function buildConfigFromForm() {
  return {
    telegram: {
      // Visible fields
      api_id:   parseInt($('s-api-id').value)  || 0,
      api_hash: $('s-api-hash').value.trim(),
      channels: getChannelsFromDOM(),
      // Hardcoded — preserved from loaded config, not editable in UI
      session_name:    (_loadedConfig.telegram?.session_name    ?? 'quotex_bot_session'),
      sticker_up_id:   (_loadedConfig.telegram?.sticker_up_id   ?? 0),
      sticker_down_id: (_loadedConfig.telegram?.sticker_down_id ?? 0),
    },
    quotex: {
      email:               $('s-qx-email').value.trim(),
      password:            $('s-qx-password').value,
      wait_between_trades: parseInt($('s-wait-trades').value) || 30,
      // login_wait_minutes preserved from loaded config (not exposed in UI)
      login_wait_minutes:  (_loadedConfig.quotex?.login_wait_minutes ?? 1),
    },
    trading: {
      account_type:          $('s-account-type').value,
      risk_mode:             $('s-risk-mode').value,
      risk_amount:           parseFloat($('s-risk-amount').value) || 1,
      max_daily_trades:      parseInt($('s-max-trades').value)   || 10,
      max_daily_loss:        parseFloat($('s-max-loss').value)   || 50,
      max_concurrent_trades: parseInt($('s-max-concurrent').value) || 1,
      martingale_enabled:    $('s-martingale-enabled').checked,
      martingale_multiplier: parseFloat($('s-martingale-mult').value)  || 2.0,
      martingale_max_steps:  parseInt($('s-martingale-steps').value)   || 5,
    },
    logging: {
      log_level: $('s-log-level').value,
      log_file:  $('s-log-file').value.trim() || 'quotex_bot.log',
    },
  };
}

// ── Modal helpers ─────────────────────────────────────────
function openModal(id) {
  $(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  $(id).classList.remove('open');
  document.body.style.overflow = '';
}
// Close on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.closest('.modal-overlay').id));
});

// ── Toast notifications ───────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = el('div', `toast-popup ${type}`, escHtml(msg));
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── API helper ────────────────────────────────────────────
async function api(method, url, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return res.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ── Misc helpers ──────────────────────────────────────────
function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}
function setValue(id, val) {
  const e = $(id);
  if (e) e.value = val;
}
function setChecked(id, val) {
  const e = $(id);
  if (e) e.checked = !!val;
}
function setBtnBusy(id, busy, label) {
  const e = $(id);
  if (!e) return;
  e.disabled = busy;
  e.textContent = label;
}
function showFieldError(id, msg) {
  const e = $(id);
  if (e) { e.focus(); e.style.borderColor = 'var(--red)'; setTimeout(() => e.style.borderColor = '', 2000); }
  showToast(msg, 'error');
}

// ── Init ──────────────────────────────────────────────────
(async () => {
  await loadSettings();

  // Initial status fetch
  const status = await api('GET', '/api/status');
  if (status) {
    _serverAlert = status.alert || null;
    updateBotButton(status.bot_running || false);
    updateHeaderStatus(status.bot_running || false);
    updateMetrics(status);
    if (status.connections) updateConnectionBadges(status.connections);
    // refreshAlert() is called inside updateConnectionBadges
  }
})();
