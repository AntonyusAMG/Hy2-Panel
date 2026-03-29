(function () {
  const JWT_KEY = 'hy2_jwt';
  const THEME_KEY = 'hy2_theme';
  const ACCENTS_KEY = 'hy2_accents';
  const AUTO_REFRESH_KEY = 'hy2_auto_refresh';
  const AUTO_INTERVAL_KEY = 'hy2_refresh_interval_sec';
  const MODES = ['dark', 'light'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /** Префикс пути за reverse proxy (например /panel + /status), пустая строка если панель на корне. */
  function apiBasePrefix() {
    const path = window.location.pathname || '';
    const i = path.indexOf('/ui');
    if (i < 0) return '';
    return path.slice(0, i);
  }

  function apiUrl(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    return apiBasePrefix() + p;
  }

  function _cookieFlags() {
    const sec = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    /* Как у Set-Cookie в agent.py — иначе Max-Age=0 может не снять зеркальную не-HttpOnly куку */
    return '; path=/; SameSite=Lax' + sec;
  }

  /* Тема и автообновление: дублируем в cookie — Safari/ITP часто режет localStorage, а <html data-theme="light"> перезаписывал выбор при F5 */
  const _UI_PREF_MAX_AGE = 365 * 24 * 60 * 60;

  function _uiPrefGet(key) {
    let ls = null;
    try {
      ls = localStorage.getItem(key);
    } catch (e) {}
    if (ls != null && String(ls).trim() !== '') {
      return String(ls).trim();
    }
    const needle = key + '=';
    const parts = document.cookie.split(';');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].trim();
      if (p.indexOf(needle) !== 0) continue;
      let v = p.slice(needle.length);
      try {
        v = decodeURIComponent(v);
      } catch (e) {}
      v = String(v).trim();
      if (v !== '') return v;
    }
    return null;
  }

  function _uiPrefSet(key, value) {
    const s = String(value);
    try {
      localStorage.setItem(key, s);
    } catch (e) {}
    try {
      document.cookie =
        key + '=' + encodeURIComponent(s) + '; Max-Age=' + _UI_PREF_MAX_AGE + _cookieFlags();
    } catch (e) {}
  }

  function _uiPrefRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
    try {
      document.cookie = key + '=; Max-Age=0' + _cookieFlags();
    } catch (e) {}
  }

  const UI_KEYS = {
    blurMult: 'hy2_ui_blur_mult',
    chromeBlur: 'hy2_ui_chrome_blur',
    satMult: 'hy2_ui_sat_mult',
    fontScale: 'hy2_ui_font_scale',
    reduceMotion: 'hy2_ui_reduce_motion',
  };

  const UI_DEFAULTS = {
    blurMult: 100,
    chromeBlur: 100,
    satMult: 100,
    fontScale: 100,
    reduceMotion: '0',
  };

  function clampUiNum(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x)) return lo;
    return Math.min(hi, Math.max(lo, x));
  }

  function uiPrefInt(key, def, lo, hi) {
    const v = _uiPrefGet(key);
    if (v == null || v === '') return def;
    return clampUiNum(parseInt(v, 10), lo, hi);
  }

  function syncUiBlurSat() {
    const root = document.documentElement;
    const st = getComputedStyle(root);
    const blurNum = parseFloat(st.getPropertyValue('--glass-blur')) || 32;
    const bm = clampUiNum(parseFloat(_uiPrefGet(UI_KEYS.blurMult) || '100') / 100, 0.5, 1.5);
    const baseEff = blurNum * bm;
    root.style.setProperty('--hy2-ui-blur-effective', baseEff + 'px');
    const chromePct = uiPrefInt(UI_KEYS.chromeBlur, UI_DEFAULTS.chromeBlur, 0, 100) / 100;
    root.style.setProperty('--hy2-chrome-blur-effective', baseEff * chromePct + 'px');
    const satStr = st.getPropertyValue('--glass-saturation').trim() || '160%';
    const satNum = parseFloat(satStr) || 160;
    const sm = clampUiNum(parseFloat(_uiPrefGet(UI_KEYS.satMult) || '100') / 100, 0.75, 1.25);
    root.style.setProperty('--hy2-ui-sat-effective', satNum * sm + '%');
  }

  function applyUiPrefs() {
    const root = document.documentElement;
    root.style.setProperty('--hy2-ui-card-mix', '100%');
    root.style.setProperty('--hy2-ui-chrome-mix', '88%');
    root.style.setProperty('--hy2-ui-srv-page-mix', '100%');
    root.style.setProperty('--hy2-ui-mesh-mult', '1');
    root.style.setProperty('--hy2-ui-main-glow-mult', '1');
    root.style.setProperty('--hy2-ui-bg-overlay', '0');
    const fs = uiPrefInt(UI_KEYS.fontScale, UI_DEFAULTS.fontScale, 90, 110) / 100;
    root.style.setProperty('--hy2-ui-font-scale', String(fs));
    syncUiBlurSat();
    const rm = (_uiPrefGet(UI_KEYS.reduceMotion) || UI_DEFAULTS.reduceMotion) === '1';
    root.classList.toggle('hy2-reduce-motion', rm);
  }

  function refreshSettingsForm() {
    function setRange(id, val, valId, suffix) {
      const el = document.getElementById(id);
      const vEl = document.getElementById(valId);
      if (el) el.value = String(val);
      if (vEl) vEl.textContent = suffix ? val + suffix : String(val);
    }
    const bm = uiPrefInt(UI_KEYS.blurMult, UI_DEFAULTS.blurMult, 50, 150);
    setRange('ui-blur-mult', bm, 'ui-blur-mult-val', '%');
    const chromeBlurVal = uiPrefInt(UI_KEYS.chromeBlur, UI_DEFAULTS.chromeBlur, 0, 100);
    setRange('ui-chrome-blur', chromeBlurVal, 'ui-chrome-blur-val', '%');
    const sm = uiPrefInt(UI_KEYS.satMult, UI_DEFAULTS.satMult, 75, 125);
    setRange('ui-sat-mult', sm, 'ui-sat-mult-val', '%');
    const fs = uiPrefInt(UI_KEYS.fontScale, UI_DEFAULTS.fontScale, 90, 110);
    setRange('ui-font-scale', fs, 'ui-font-scale-val', '%');
    const reduceMotionEl = document.getElementById('ui-reduce-motion');
    if (reduceMotionEl) reduceMotionEl.checked = (_uiPrefGet(UI_KEYS.reduceMotion) || '0') === '1';
  }

  function initSettingsSection() {
    function wireRange(id, key, valId, suffix) {
      const el = document.getElementById(id);
      if (!el) return;
      const vEl = document.getElementById(valId);
      el.addEventListener('input', function () {
        _uiPrefSet(key, el.value);
        if (vEl) vEl.textContent = suffix ? el.value + suffix : el.value;
        applyUiPrefs();
      });
    }
    wireRange('ui-blur-mult', UI_KEYS.blurMult, 'ui-blur-mult-val', '%');
    wireRange('ui-chrome-blur', UI_KEYS.chromeBlur, 'ui-chrome-blur-val', '%');
    wireRange('ui-sat-mult', UI_KEYS.satMult, 'ui-sat-mult-val', '%');
    wireRange('ui-font-scale', UI_KEYS.fontScale, 'ui-font-scale-val', '%');
    const rmc = document.getElementById('ui-reduce-motion');
    if (rmc) {
      rmc.addEventListener('change', function () {
        _uiPrefSet(UI_KEYS.reduceMotion, rmc.checked ? '1' : '0');
        applyUiPrefs();
      });
    }
    const resetBtn = document.getElementById('ui-reset-defaults');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!confirm('Сбросить все настройки вида к значениям по умолчанию?')) return;
        Object.keys(UI_KEYS).forEach(function (k) {
          _uiPrefRemove(UI_KEYS[k]);
        });
        _uiPrefRemove(ACCENTS_KEY);
        loadAccents();
        applyUiPrefs();
        refreshSettingsForm();
        if (_getJwt()) void renderChart().catch(function () {});
        toast('Настройки вида сброшены');
      });
    }
    refreshSettingsForm();
  }

  function _setJwt(token) {
    try { localStorage.setItem(JWT_KEY, token); } catch(e) {}
    // HttpOnly cookie выставляет сервер при POST /auth/login (не читается из JS — надёжнее при F5)
  }

  function _getJwt() {
    try {
      const ls = localStorage.getItem(JWT_KEY);
      if (ls) return ls;
    } catch(e) {}
    // Старые сессии: не-HttpOnly cookie из прошлых версий
    const match = document.cookie.match('(?:^|;\\s*)' + JWT_KEY + '=([^;]*)');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  function _removeJwtLocal() {
    try {
      localStorage.removeItem(JWT_KEY);
    } catch (e) {}
    document.cookie = JWT_KEY + '=; Max-Age=0' + _cookieFlags();
  }

  function _removeJwt() {
    _removeJwtLocal();
    fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'include' }).catch(function () {});
  }

  function toast(msg, isErr) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 4200);
  }

  async function api(path, opts = {}) {
    const jwtRaw = _getJwt();
    const jwt = jwtRaw && String(jwtRaw).trim();
    const headers = Object.assign({}, opts.headers || {});
    if (jwt) headers.Authorization = 'Bearer ' + jwt;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const cred = opts.credentials !== undefined ? opts.credentials : 'include';
    const r = await fetch(apiUrl(path), Object.assign({}, opts, { headers, credentials: cred }));
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) {
      const authPath = path.startsWith('/auth/');
      /* 401 без Bearer на старте — гость; не трогаем JWT (иначе «поздний» 401 сбросит сессию после входа). */
      if (r.status === 401 && !authPath) {
        if (jwt) {
          _removeJwt();
          showApp(false);
        }
        throw new Error(jwt ? 'Сессия истекла — войдите снова' : 'Требуется вход');
      }
      const d = typeof data === 'object' && data.detail !== undefined ? data.detail : data;
      throw new Error(typeof d === 'string' ? d : JSON.stringify(d));
    }
    return data;
  }

  function formatBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const u = ['B','KB','MB','GB','TB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(i >= 3 ? 2 : 1)) + ' ' + u[i];
  }

  function formatBitrate(bps) {
    if (bps == null || !Number.isFinite(Number(bps))) return '—';
    const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let v = Number(bps);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    const d = i === 0 ? 0 : v < 10 ? 2 : 1;
    return v.toFixed(d) + ' ' + u[i];
  }

  function formatThreadCountRu(n) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x) || x < 0) return '—';
    const m10 = x % 10;
    const m100 = x % 100;
    let w = 'потоков';
    if (m10 === 1 && m100 !== 11) w = 'поток';
    else if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 > 20)) w = 'потока';
    return x + ' ' + w;
  }

  function formatUptime(sec) {
    const s = Number(sec) || 0;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'д ' + h + 'ч';
    if (h > 0) return h + 'ч ' + m + 'м';
    return m + 'м';
  }

  /** Сумма tx+rx по пользователям из stats; без двойного учёта при вложенном JSON. */
  function sumTrafficStats(obj) {
    const t = normalizeTrafficPayload(obj);
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { up: 0, down: 0, total: 0 };
    let up = 0, down = 0;
    function addPair(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      up += Number(v.tx != null ? v.tx : v.upload) || 0;
      down += Number(v.rx != null ? v.rx : v.download) || 0;
    }
    if (t.users && typeof t.users === 'object' && !Array.isArray(t.users)) {
      Object.values(t.users).forEach(addPair);
      return { up, down, total: up + down };
    }
    const skip = new Set(['online', 'data', 'users', 'meta', 'server', 'system', 'version']);
    for (const [k, v] of Object.entries(t)) {
      if (skip.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) addPair(v);
    }
    if (up > 0 || down > 0) return { up, down, total: up + down };
    if (Array.isArray(t.online)) t.online.forEach(addPair);
    return { up, down, total: up + down };
  }

  function summarizeOnline(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { userCount: 0, connCount: 0, byUser: {} };
    let connCount = 0;
    const byUser = {};
    Object.entries(raw).forEach(([k, v]) => {
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      const c = Number.isFinite(n) && n > 0 ? n : 0;
      if (c > 0) {
        byUser[k] = c;
        connCount += c;
      }
    });
    return { userCount: Object.keys(byUser).length, connCount, byUser };
  }

  async function fetchOnlineMap() {
    try {
      const d = await api('/online');
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) {
      return {};
    }
  }

  /** Ответ GET /traffic иногда обёрнут или приходит в виде вложенного объекта. */
  function normalizeTrafficPayload(t) {
    if (t == null || typeof t !== 'object' || Array.isArray(t)) return t;
    if (t.users && typeof t.users === 'object' && !Array.isArray(t.users)) return t;
    if (typeof t.data === 'object' && t.data !== null && !Array.isArray(t.data)) return t.data;
    return t;
  }

  function onlineCountForUser(byUser, id) {
    const s = String(id);
    if (!byUser || typeof byUser !== 'object') return 0;
    const n = byUser[s] != null ? byUser[s] : byUser[id];
    const v = typeof n === 'number' ? n : parseInt(String(n), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function touchLastRefresh() {
    const el = $('#hdr-last-refresh');
    if (!el) return;
    el.textContent = 'Обновлено ' + new Date().toLocaleTimeString();
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    clearTimeout(touchLastRefresh._t);
    touchLastRefresh._t = setTimeout(() => el.classList.remove('flash'), 450);
  }

  /** tx/rx по каждому telegram_id из stats; один раз с users или с корня, без рекурсивного дубля. */
  function perUserFromTraffic(traffic, userIds) {
    const map = {};
    userIds.forEach((id) => {
      map[String(id)] = { up: 0, down: 0 };
    });
    const t = normalizeTrafficPayload(traffic);
    if (!t || typeof t !== 'object') return map;
    function readUser(ks, v) {
      if (!map[ks] || !v || typeof v !== 'object' || Array.isArray(v)) return;
      map[ks].up += Number(v.tx != null ? v.tx : v.upload) || 0;
      map[ks].down += Number(v.rx != null ? v.rx : v.download) || 0;
    }
    if (t.users && typeof t.users === 'object' && !Array.isArray(t.users)) {
      userIds.forEach((id) => {
        const ks = String(id);
        readUser(ks, t.users[ks] ?? t.users[id]);
      });
      return map;
    }
    userIds.forEach((id) => {
      const ks = String(id);
      readUser(ks, t[ks] ?? t[id]);
    });
    return map;
  }

  function rowsFromTrafficForTable(traffic) {
    const rows = [];
    if (!traffic || typeof traffic !== 'object') {
      rows.push({ id: '—', pair: '—', note: 'Нет ответа от stats API' });
      return rows;
    }
    if (traffic.online && Array.isArray(traffic.online)) {
      traffic.online.forEach((o) => rows.push({
        id: String(o.id || o.user || o.telegram_id || '—'),
        pair: [formatBytes(o.tx || o.upload), formatBytes(o.rx || o.download)].join(' / '),
        note: 'online',
      }));
      if (rows.length) return rows;
    }
    const users = traffic.users || traffic;
    if (users && typeof users === 'object' && !Array.isArray(users)) {
      Object.entries(users).forEach(([id, v]) => {
        if (v && typeof v === 'object') {
          const up = v.upload ?? v.tx ?? 0;
          const down = v.download ?? v.rx ?? 0;
          rows.push({
            id: id,
            pair: formatBytes(up) + ' / ' + formatBytes(down),
            note: 'накопленно',
          });
        }
      });
    }
    if (!rows.length) {
      rows.push({ id: '—', pair: '—', note: 'Формат stats не распознан' });
    }
    return rows;
  }

  function localDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  const OVERVIEW_CHART_DAYS = 30;
  const TRAFFIC_WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  let trafficLineChart = null;
  let trafficChartResizeObs = null;

  /** На узком графике большой hitRadius даёт перекрытие соседних дней — тултип и «статистика» не совпадают с касанием. */
  function trafficChartHitRadiusPx() {
    const wrap = document.querySelector('.hy2-chart-canvas-wrap');
    const w = wrap && wrap.clientWidth > 40 ? wrap.clientWidth : Math.max(280, window.innerWidth - 48);
    const per = w / OVERVIEW_CHART_DAYS;
    return Math.max(5, Math.min(15, Math.floor(per * 0.4)));
  }

  function attachTrafficChartResizeObserver(canvas) {
    const el = canvas && canvas.parentElement;
    if (!el || trafficChartResizeObs) return;
    trafficChartResizeObs = new ResizeObserver(() => {
      if (!trafficLineChart) return;
      trafficLineChart.resize();
      const r = trafficChartHitRadiusPx();
      const ds0 = trafficLineChart.data.datasets[0];
      if (ds0) {
        ds0.pointHitRadius = r;
        ds0.pointHoverRadius = Math.min(9, r + 2);
      }
      trafficLineChart.update('none');
    });
    trafficChartResizeObs.observe(el);
  }

  function colorWithAlpha(c, a) {
    const s = (c || '').trim();
    const rgbM = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgbM) return 'rgba(' + rgbM[1] + ',' + rgbM[2] + ',' + rgbM[3] + ',' + a + ')';
    if (s.startsWith('#') && s.length === 7) {
      const r = parseInt(s.slice(1, 3), 16);
      const g = parseInt(s.slice(3, 5), 16);
      const b = parseInt(s.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return s || 'rgba(167,139,250,' + a + ')';
  }

  function accentColorForChart(slot) {
    const root = document.documentElement;
    if (root.classList.contains('hy2-accent-' + slot + '-off')) {
      return root.getAttribute('data-theme') === 'light' ? 'rgba(150,140,180,0.45)' : 'rgba(200,200,220,0.35)';
    }
    const m = { 1: '--hy2-acc-1', 2: '--hy2-acc-2', 3: '--hy2-acc-3', 4: '--hy2-acc-4' };
    const v = getComputedStyle(root).getPropertyValue(m[slot] || '--accent').trim();
    return v || '#a78bfa';
  }

  function updateTrafficLineChart(days, vals, dayObjs) {
    const canvas = document.getElementById('traffic-chart-canvas');
    if (!canvas || typeof Chart === 'undefined') return;
    const labels = dayObjs.map((di) => {
      if (!di || isNaN(di.getTime())) return '';
      const dd = String(di.getUTCDate()).padStart(2, '0');
      const mm = String(di.getUTCMonth() + 1).padStart(2, '0');
      return dd + '.' + mm;
    });
    const c1 = accentColorForChart(1);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const grid = isLight ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.06)';
    const tick = isLight ? '#6b6394' : 'rgba(200,180,255,0.55)';
    const hitR = trafficChartHitRadiusPx();
    const ds = {
      labels,
      datasets: [
        {
          label: 'Байт/сутки',
          data: vals,
          borderColor: c1,
          backgroundColor: colorWithAlpha(c1, 0.14),
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: Math.min(9, hitR + 2),
          pointHitRadius: hitR,
        },
      ],
    };
    if (trafficLineChart) {
      trafficLineChart.$hy2 = { days, dayObjs };
      trafficLineChart.data.labels = labels;
      trafficLineChart.data.datasets[0].data = vals;
      trafficLineChart.data.datasets[0].borderColor = c1;
      trafficLineChart.data.datasets[0].backgroundColor = colorWithAlpha(c1, 0.14);
      trafficLineChart.data.datasets[0].pointHitRadius = hitR;
      trafficLineChart.data.datasets[0].pointHoverRadius = Math.min(9, hitR + 2);
      trafficLineChart.options.scales.x.grid.color = grid;
      trafficLineChart.options.scales.y.grid.color = grid;
      trafficLineChart.options.scales.x.ticks.color = tick;
      trafficLineChart.options.scales.y.ticks.color = tick;
      trafficLineChart.update();
      return;
    }
    trafficLineChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: ds,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title(items) {
                const it = items[0];
                const meta = it.chart.$hy2 || { days: [], dayObjs: [] };
                const i = it.dataIndex;
                const di = meta.dayObjs[i];
                const dk = meta.days[i];
                if (di != null && dk && !isNaN(di.getTime())) {
                  return TRAFFIC_WD[di.getUTCDay()] + ', ' + dk;
                }
                return it.label || '';
              },
              label(ctx) {
                const raw = ctx.chart.data.datasets[ctx.datasetIndex].data[ctx.dataIndex];
                const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (ctx.parsed && ctx.parsed.y != null ? ctx.parsed.y : 0);
                return 'За сутки: ' + formatBytes(v);
              },
            },
          },
        },
        scales: {
          x: { grid: { color: grid }, ticks: { color: tick, maxRotation: 45, font: { size: 9 } } },
          y: {
            beginAtZero: true,
            grid: { color: grid },
            ticks: {
              color: tick,
              font: { size: 9 },
              callback(v) {
                return formatBytes(Number(v));
              },
            },
          },
        },
      },
    });
    trafficLineChart.$hy2 = { days, dayObjs };
    attachTrafficChartResizeObserver(canvas);
  }

  async function renderChart() {
    const days = [];
    const dayObjs = [];
    const vals = [];
    try {
      const res = await api('/traffic/daily?days=' + OVERVIEW_CHART_DAYS);
      const arr = res && Array.isArray(res.days) ? res.days : [];
      arr.forEach(function (row) {
        if (!row || row.date == null) return;
        const dk = String(row.date);
        days.push(dk);
        const p = dk.split('-').map(function (x) {
          return parseInt(x, 10);
        });
        const di =
          p.length === 3 && p.every(function (n) {
            return Number.isFinite(n);
          })
            ? new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0))
            : new Date(NaN);
        dayObjs.push(di);
        vals.push(Math.max(0, Number(row.bytes) || 0));
      });
    } catch (e) {}
    if (!vals.length) {
      for (let i = OVERVIEW_CHART_DAYS - 1; i >= 0; i--) {
        const dt = new Date();
        dt.setHours(12, 0, 0, 0);
        dt.setDate(dt.getDate() - i);
        const dk = localDateKey(dt);
        days.push(dk);
        const p = dk.split('-').map(function (x) {
          return parseInt(x, 10);
        });
        dayObjs.push(
          p.length === 3 && p.every(function (n) {
            return Number.isFinite(n);
          })
            ? new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0))
            : new Date(NaN),
        );
        vals.push(0);
      }
    }
    updateTrafficLineChart(days, vals, dayObjs);
  }

  let currentSection = 'overview';
  let sectionRefreshTimer = null;

  function clearSectionRefresh() {
    if (sectionRefreshTimer) {
      clearInterval(sectionRefreshTimer);
      sectionRefreshTimer = null;
    }
  }

  function scheduleSectionRefresh() {
    clearSectionRefresh();
    const on = $('#auto-refresh-on');
    if (!on || !on.checked) return;
    if (currentSection !== 'overview' && currentSection !== 'users' && currentSection !== 'server') return;
    const sec = Math.max(3, parseInt($('#auto-refresh-interval').value, 10) || 5);
    const ms = sec * 1000;
    sectionRefreshTimer = setInterval(() => {
      if (currentSection === 'overview') loadOverview(true);
      else if (currentSection === 'users') loadUsers(true);
      else if (currentSection === 'server') loadServer(true);
    }, ms);
  }

  function loadCurrentSection() {
    if (currentSection === 'overview') return loadOverview();
    if (currentSection === 'users') return loadUsers();
    if (currentSection === 'config') return loadConfig();
    if (currentSection === 'server') return loadServer();
    if (currentSection === 'settings') return;
  }

  function showSection(id) {
    currentSection = id;
    $$('.dock-item').forEach((b) => {
      const on = b.dataset.section === id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    ['overview', 'users', 'config', 'server', 'settings'].forEach((s) => {
      $('#sec-' + s).classList.toggle('hidden', s !== id);
    });
    clearSectionRefresh();
    if (id === 'overview') loadOverview();
    if (id === 'users') loadUsers();
    if (id === 'config') loadConfig();
    if (id === 'server') loadServer();
    if (id === 'settings') refreshSettingsForm();
    scheduleSectionRefresh();
  }

  function cleanHysteriaVersion(s) {
    if (!s) return '—';
    const lines = String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return '—';
    const bannerish = (ln) => {
      if (ln.length < 10) return false;
      let b = 0;
      for (let i = 0; i < ln.length; i++) {
        const c = ln.charCodeAt(i);
        if ((c >= 0x2580 && c <= 0x259f) || ln[i] === '█' || ln[i] === '░' || ln[i] === '▒' || ln[i] === '▓') b++;
      }
      return b >= Math.max(8, ln.length / 4);
    };
    const verRe = /v?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?/i;
    for (const ln of lines) {
      const vm = ln.match(/^\s*Version:\s*(.+)$/i);
      if (vm) {
        const t = vm[1].trim();
        const m2 = t.match(verRe);
        return (m2 ? m2[0] : t).slice(0, 80);
      }
    }
    const nonBanner = lines.filter((ln) => !bannerish(ln));
    const pool = nonBanner.length ? nonBanner : lines;
    for (const ln of pool) {
      const m2 = ln.match(verRe);
      if (m2 && ln.length < 100) return m2[0].slice(0, 80);
    }
    for (const ln of pool) {
      const m2 = ln.match(verRe);
      if (m2) return m2[0].slice(0, 80);
    }
    const first = pool.find((ln) => !bannerish(ln)) || pool[0];
    return first.slice(0, 80);
  }

  const METRIC_TINTS = ['metric-tint-neutral', 'metric-tint-low', 'metric-tint-mid', 'metric-tint-high', 'metric-tint-crit'];
  /** Пороги для CPU / ОЗУ / свап (%): раньше краснеет — критично с 80 %. */
  const TINT_CRIT_MIN = 80;
  const TINT_HIGH_MIN = 55;
  const TINT_MID_MIN = 30;
  /** Сколько подключений HY2 считать «100 %» шкалы для карточки онлайн (те же пороги через tintClassFromLoadPct). */
  const ONLINE_CONN_FOR_FULL_SCALE = 30;
  function resetOverviewMetricTints() {
    document.querySelectorAll('.overview-summary .metric:not(.hidden)').forEach((card) => {
      METRIC_TINTS.forEach((c) => card.classList.remove(c));
      card.classList.add('metric-tint-neutral');
    });
  }
  function tintClassFromLoadPct(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return 'metric-tint-neutral';
    const p = Math.max(0, Math.min(100, Number(pct)));
    if (p >= TINT_CRIT_MIN) return 'metric-tint-crit';
    if (p >= TINT_HIGH_MIN) return 'metric-tint-high';
    if (p >= TINT_MID_MIN) return 'metric-tint-mid';
    return 'metric-tint-low';
  }
  function applyMetricTint(elementId, tintClass) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const card = el.closest('.metric');
    if (!card) return;
    METRIC_TINTS.forEach((c) => card.classList.remove(c));
    card.classList.add(tintClass);
  }

  const HY2_ICO_LINK =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
  const HY2_ICO_RESET =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  const HY2_ICO_DEL =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M10 11v6M14 11v6"/></svg>';
  const HY2_ICO_RESTART =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
  const HY2_ICO_STOP =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
  const HY2_ICO_START =
    '<svg class="hy2-tbl-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="8 5 19 12 8 19 8 5"/></svg>';

  async function loadOverview(silent) {
    try {
      const st = await api('/status');
      const users = await api('/users');
      let traffic = {};
      try {
        traffic = normalizeTrafficPayload(await api('/traffic'));
      } catch (e) {
        traffic = {};
      }
      const onlineRaw = await fetchOnlineMap();
      const onl = summarizeOnline(onlineRaw);
      const ids = users.users || [];
      $('#hdr-node').textContent = st.node_name || 'нода';
      $('#hdr-ver').textContent = cleanHysteriaVersion(st.hysteria_version);
      const hyOk = st.hysteria_active === 'active';
      const el = $('#hdr-online');
      el.textContent = hyOk ? 'HY2 active' : 'HY2 ' + (st.hysteria_active || '?');
      el.className = 'status-pill mono ' + (hyOk ? 'ok' : 'bad');

      const pu = $('#m-panel-url');
      if (pu) {
        const pb = String(st.panel_public_url || '').trim().replace(/\/$/, '');
        const origin = window.location && window.location.origin ? String(window.location.origin).replace(/\/$/, '') : '';
        const base = pb || origin;
        if (base) {
          const ui = base + '/ui';
          const a = document.createElement('a');
          a.href = ui;
          a.style.color = 'var(--accent2)';
          a.style.textDecoration = 'underline';
          a.textContent = ui;
          pu.replaceChildren(a);
        } else {
          pu.textContent = '—';
        }
      }
      const ph = $('#m-hy2-domain');
      if (ph) {
        const d = String(st.hysteria_client_domain || '').trim();
        ph.textContent = d || '— (задайте public_base_url или hysteria_public_domain в config.json агента)';
        ph.style.color = d ? 'inherit' : 'var(--amber)';
      }

      $('#m-users').textContent = String(ids.length);
      const mo = $('#m-online');
      const ms = $('#m-online-sub');
      if (onl.userCount > 0 || onl.connCount > 0) {
        mo.textContent = String(onl.userCount);
        if (ms) ms.textContent = onl.connCount + ' подключ. (экземпляров клиента)';
      } else {
        mo.textContent = '0';
        if (ms) ms.textContent = 'нет активных сессий';
      }
      const sum = sumTrafficStats(traffic);
      $('#m-traffic').textContent = formatBytes(sum.total);
      const cpu = st.cpu_percent != null && Number.isFinite(Number(st.cpu_percent)) ? Math.round(Number(st.cpu_percent)) : null;
      const ncpu = st.cpu_count != null && Number.isFinite(Number(st.cpu_count)) ? Math.floor(Number(st.cpu_count)) : 0;
      const vm = st.memory || {};
      const memPct = vm.percent != null && Number.isFinite(Number(vm.percent)) ? Math.round(Number(vm.percent)) : null;
      const sw = st.swap || {};
      const swTot = Number(sw.total) || 0;
      const swUsed = Number(sw.used) || 0;
      const swPct = sw.percent != null && Number.isFinite(Number(sw.percent)) ? Math.round(Number(sw.percent)) : null;

      const mCpu = $('#m-cpu');
      const mCpuSub = $('#m-cpu-sub');
      if (mCpu) {
        mCpu.textContent = cpu != null ? cpu + '%' : '—';
        if (mCpuSub) mCpuSub.textContent = ncpu > 0 ? ncpu + ' лог. ядер' : 'загрузка';
      }
      const mMem = $('#m-mem');
      const mMemSub = $('#m-mem-sub');
      if (mMem) {
        mMem.textContent = memPct != null ? memPct + '%' : '—';
        if (mMemSub) {
          if (vm.used != null && vm.total != null) {
            mMemSub.textContent = formatBytes(vm.used) + ' / ' + formatBytes(vm.total);
          } else {
            mMemSub.textContent = 'занято';
          }
        }
      }
      const mSw = $('#m-swap');
      const mSwSub = $('#m-swap-sub');
      if (mSw) {
        if (swTot <= 0) {
          mSw.textContent = '—';
          if (mSwSub) mSwSub.textContent = 'не настроен';
        } else {
          mSw.textContent = swPct != null ? swPct + '%' : '—';
          if (mSwSub) mSwSub.textContent = formatBytes(swUsed) + ' / ' + formatBytes(swTot);
        }
      }
      resetOverviewMetricTints();
      applyMetricTint('m-cpu', tintClassFromLoadPct(cpu));
      applyMetricTint('m-mem', tintClassFromLoadPct(memPct));
      if (swTot <= 0) applyMetricTint('m-swap', 'metric-tint-neutral');
      else applyMetricTint('m-swap', tintClassFromLoadPct(swPct));
      let onlineTint;
      if (!hyOk) onlineTint = 'metric-tint-crit';
      else {
        const onlinePct = Math.min(100, ((onl.connCount || 0) / ONLINE_CONN_FOR_FULL_SCALE) * 100);
        onlineTint = tintClassFromLoadPct(onlinePct);
      }
      applyMetricTint('m-online', onlineTint);
      $('#m-uptime').textContent = formatUptime(st.uptime_seconds);
      await renderChart();

      const tb = $('#tbl-conn');
      tb.innerHTML = '';
      rowsFromTrafficForTable(traffic).forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono">' + row.id + '</td><td class="mono">' + row.pair + '</td><td>' + row.note + '</td>';
        tb.appendChild(tr);
      });
      touchLastRefresh();
    } catch (e) {
      if (!silent) toast(String(e.message || e), true);
    }
  }

  async function loadUsers(silent) {
    try {
      const users = await api('/users');
      let traffic = {};
      try {
        traffic = normalizeTrafficPayload(await api('/traffic'));
      } catch (e) {
        traffic = {};
      }
      const onlineRaw = await fetchOnlineMap();
      const onl = summarizeOnline(onlineRaw);
      const sumEl = $('#users-online-summary');
      if (sumEl) {
        sumEl.textContent = 'Онлайн: ' + onl.userCount + ' польз. · ' + onl.connCount + ' подкл.';
      }
      const ids = users.users || [];
      const pmap = perUserFromTraffic(traffic, ids);
      const q = ($('#user-search').value || '').trim().toLowerCase();
      const tb = $('#tbl-users');
      tb.innerHTML = '';
      ids.filter((id) => !q || String(id).toLowerCase().includes(q)).forEach((id) => {
        const p = pmap[String(id)] || pmap[id] || { up: 0, down: 0 };
        const total = (p.up + p.down) || 0;
        const pct = total > 0 ? Math.min(100, 12 + Math.log10(total + 1) * 8) : 0;
        const oc = onlineCountForUser(onl.byUser, id);
        let statusHtml;
        if (oc > 0) {
          statusHtml =
            '<span class="status-pill ok">онлайн' +
            (oc > 1 ? ' (' + oc + ')' : '') +
            '</span>';
        } else {
          statusHtml = '<span class="status-pill bad" style="opacity:0.85">офлайн</span>';
        }
        const tr = document.createElement('tr');
        tr.dataset.telegramId = id;
        tr.innerHTML =
          '<td class="mono">' + id + '</td>' +
          '<td style="min-width:140px"><div class="mono" style="font-size:0.8rem">' + formatBytes(p.up) + ' ↑ / ' + formatBytes(p.down) + ' ↓</div><div class="progress"><i style="width:' + pct + '%"></i></div></td>' +
          '<td class="muted">—</td><td class="muted">—</td>' +
          '<td>' + statusHtml + '</td>' +
          '<td class="hy2-tbl-actions"><div class="hy2-tbl-act-row">' +
          '<button type="button" class="btn btn-info hy2-tbl-act" data-act="link" data-id="' +
          id +
          '" title="Ссылка" aria-label="Ссылка">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_LINK +
          '</span><span class="hy2-tbl-act-txt">Ссылка</span></button> ' +
          '<button type="button" class="btn btn-warning hy2-tbl-act" data-act="reset" data-id="' +
          id +
          '" title="Сброс пароля" aria-label="Сброс пароля">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_RESET +
          '</span><span class="hy2-tbl-act-txt">Сброс</span></button> ' +
          '<button type="button" class="btn btn-danger hy2-tbl-act" data-act="del" data-id="' +
          id +
          '" title="Удалить" aria-label="Удалить">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_DEL +
          '</span><span class="hy2-tbl-act-txt">Удалить</span></button>' +
          '</div></td>';
        tb.appendChild(tr);
      });
      tb.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (btn.dataset.act === 'del') {
            if (!confirm('Удалить пользователя ' + id + '?')) return;
            try {
              await api('/users/' + encodeURIComponent(id), { method: 'DELETE' });
              toast('Удалено');
              loadUsers();
            } catch (e) { toast(String(e.message || e), true); }
          }
          if (btn.dataset.act === 'reset') {
            try {
              await api('/traffic/' + encodeURIComponent(id) + '/reset', { method: 'POST' });
              toast('Сброс запрошен');
              loadUsers();
            } catch (e) {
              toast(String(e.message || e), true);
            }
          }
          if (btn.dataset.act === 'link') {
            try {
              const r = await api('/users/' + encodeURIComponent(id) + '/client-uri');
              $('#uri-out').value = r.uri || '';
              const sub = r.happ_subscription_url || '';
              const subBlock = $('#uri-sub-block');
              const noSub = $('#uri-no-sub');
              const btnSub = $('#uri-copy-sub');
              const subHint = $('#uri-sub-hint');
              if (subBlock) subBlock.classList.toggle('hidden', !sub);
              if (noSub) noSub.classList.toggle('hidden', !!sub);
              if ($('#uri-sub-out')) $('#uri-sub-out').value = sub;
              if (btnSub) btnSub.classList.toggle('hidden', !sub);
              if (subHint && r.happ_subscription_hint) subHint.textContent = r.happ_subscription_hint;
              $('#modal-uri').classList.remove('hidden');
            } catch (e) {
              toast(String(e.message || e), true);
            }
          }
        });
      });
      touchLastRefresh();
    } catch (e) {
      if (!silent) toast(String(e.message || e), true);
    }
  }

  async function loadConfig() {
    try {
      const c = await api('/config');
      const code = $('#cfg-yaml');
      code.textContent = c.content || '';
      code.className = 'language-yaml';
      if (window.hljs) hljs.highlightElement(code);
    } catch (e) {
      toast(String(e.message || e), true);
    }
  }

  function setSrvGauge(ringSel, valSel, subSel, pct, valText, subText) {
    const ring = $(ringSel);
    if (ring) ring.style.setProperty('--pct', String(Math.min(100, Math.max(0, Number(pct) || 0))));
    const v = $(valSel);
    if (v) v.textContent = valText;
    const s = $(subSel);
    if (s) s.textContent = subText;
  }

  const SRV_GAUGE_TINTS = ['srv-gauge-tint-neutral', 'srv-gauge-tint-low', 'srv-gauge-tint-mid', 'srv-gauge-tint-high', 'srv-gauge-tint-crit'];
  function applySrvGaugeTint(ringSel, pct) {
    const ring = $(ringSel);
    if (!ring) return;
    const host = ring.closest('.srv-gauge');
    if (!host) return;
    SRV_GAUGE_TINTS.forEach((c) => host.classList.remove(c));
    if (pct == null || !Number.isFinite(Number(pct))) {
      host.classList.add('srv-gauge-tint-neutral');
      return;
    }
    const m = tintClassFromLoadPct(Number(pct));
    host.classList.add(m.replace(/^metric-tint-/, 'srv-gauge-tint-'));
  }

  function setPillState(el, ok, okText, badText) {
    if (!el) return;
    el.textContent = ok ? okText : badText;
    el.classList.remove('pill-ok', 'pill-bad');
    el.classList.add(ok ? 'pill-ok' : 'pill-bad');
  }

  async function loadServer(silent) {
    try {
      const st = await api('/status');
      const cpuP = Math.min(100, st.cpu_percent != null ? Number(st.cpu_percent) : 0);
      setSrvGauge(
        '#srv-ring-cpu',
        '#srv-val-cpu',
        '#srv-sub-cpu',
        cpuP,
        (st.cpu_percent != null ? Number(st.cpu_percent).toFixed(2) : '—') + '%',
        formatThreadCountRu(st.cpu_count)
      );
      applySrvGaugeTint('#srv-ring-cpu', st.cpu_percent != null ? cpuP : null);

      const mem = st.memory || {};
      const mp = Math.min(100, mem.percent != null ? mem.percent : 0);
      setSrvGauge(
        '#srv-ring-mem',
        '#srv-val-mem',
        '#srv-sub-mem',
        mp,
        (mem.percent != null ? Number(mem.percent).toFixed(2) : '—') + '%',
        formatBytes(mem.used) + ' / ' + formatBytes(mem.total)
      );
      applySrvGaugeTint('#srv-ring-mem', mem.percent != null ? mp : null);

      const sw = st.swap || {};
      const swT = sw.total != null ? Number(sw.total) : 0;
      if (swT <= 0) {
        setSrvGauge('#srv-ring-swap', '#srv-val-swap', '#srv-sub-swap', 0, '—', 'Swap не используется');
        applySrvGaugeTint('#srv-ring-swap', null);
      } else {
        const sp = Math.min(100, sw.percent != null ? Number(sw.percent) : 0);
        setSrvGauge(
          '#srv-ring-swap',
          '#srv-val-swap',
          '#srv-sub-swap',
          sp,
          (sw.percent != null ? Number(sw.percent).toFixed(2) : '—') + '%',
          formatBytes(sw.used) + ' / ' + formatBytes(sw.total)
        );
        applySrvGaugeTint('#srv-ring-swap', sw.percent != null ? sp : null);
      }

      const dk = st.disk || {};
      const dp = Math.min(100, dk.percent != null ? dk.percent : 0);
      setSrvGauge(
        '#srv-ring-disk',
        '#srv-val-disk',
        '#srv-sub-disk',
        dp,
        (dk.percent != null ? Number(dk.percent).toFixed(2) : '—') + '%',
        formatBytes(dk.used) + ' / ' + formatBytes(dk.total)
      );
      applySrvGaugeTint('#srv-ring-disk', dk.percent != null ? dp : null);

      const hyOk = st.hysteria_active === 'active';
      setPillState($('#srv-pill-hy-st'), hyOk, 'Запущен', String(st.hysteria_active || 'неизв.'));
      const hv = $('#srv-pill-hy-ver');
      if (hv) hv.textContent = cleanHysteriaVersion(st.hysteria_version);

      const agOk = st.hy2_agent_active === 'active';
      setPillState($('#srv-pill-agent-st'), agOk, 'Запущен', String(st.hy2_agent_active || 'неизв.'));

      setPillState($('#srv-pill-tls'), !!st.tls_active, 'Active', 'Disabled');
      const tlsHint = $('#srv-pill-domain-hint');
      if (tlsHint) tlsHint.textContent = st.tls_mode || 'Auto (ACME)';

      setPillState($('#srv-pill-masq'), !!st.masquerade_enabled, 'Enabled', 'Disabled');
      const masqMode = $('#srv-pill-masq-mode');
      if (masqMode) masqMode.textContent = st.masquerade_type || 'None';

      setPillState($('#srv-pill-stats'), !!st.stats_secret_configured, 'Internal Only', 'Unconfigured');

      const upOs = $('#srv-pill-uptime-os');
      if (upOs) upOs.textContent = 'ОС: ' + formatUptime(st.uptime_seconds);

      const la = st.load_average;
      const loadEl = $('#srv-pill-load');
      if (loadEl) {
        if (Array.isArray(la) && la.length >= 3) {
          loadEl.textContent = la[0] + ' | ' + la[1] + ' | ' + la[2];
          loadEl.classList.remove('pill-muted');
          loadEl.classList.add('pill-ok');
        } else {
          loadEl.textContent = '—';
          loadEl.classList.remove('pill-ok');
          loadEl.classList.add('pill-muted');
        }
      }

      const nUp = $('#srv-net-up');
      if (nUp) nUp.textContent = formatBitrate(st.net_speed_up_bps);
      const nDn = $('#srv-net-down');
      if (nDn) nDn.textContent = formatBitrate(st.net_speed_down_bps);
      const tUp = $('#srv-net-tot-up');
      if (tUp) tUp.textContent = formatBytes(st.bytes_sent_total);
      const tDn = $('#srv-net-tot-down');
      if (tDn) tDn.textContent = formatBytes(st.bytes_recv_total);
      const domEl = $('#srv-domain-val');
      if (domEl) {
        const d = (st.hysteria_client_domain || '').trim();
        domEl.textContent = d || 'не определён (см. конфиг / TLS)';
      }

      const tb = $('#tbl-svc');
      tb.innerHTML = '';

      function row(name, active, svcKey) {
        const ok = active === 'active';
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + name + '</td>' +
          '<td><span class="status-pill ' + (ok ? 'ok' : 'bad') + '">' + active + '</span></td>' +
          '<td class="hy2-tbl-actions"><div class="hy2-tbl-act-row">' +
          '<button type="button" class="btn btn-restart hy2-tbl-act" data-svc="' +
          svcKey +
          '" data-a="restart" title="Перезапуск" aria-label="Перезапуск">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_RESTART +
          '</span><span class="hy2-tbl-act-txt">Restart</span></button> ' +
          '<button type="button" class="btn btn-warning hy2-tbl-act" data-svc="' +
          svcKey +
          '" data-a="stop" title="Остановить" aria-label="Остановить">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_STOP +
          '</span><span class="hy2-tbl-act-txt">Stop</span></button> ' +
          '<button type="button" class="btn btn-success hy2-tbl-act" data-svc="' +
          svcKey +
          '" data-a="start" title="Запустить" aria-label="Запустить">' +
          '<span class="hy2-tbl-act-ico" aria-hidden="true">' +
          HY2_ICO_START +
          '</span><span class="hy2-tbl-act-txt">Start</span></button>' +
          '</div></td>';
        tb.appendChild(tr);
        tr.querySelectorAll('button[data-svc]').forEach((b) => {
          b.addEventListener('click', async () => {
            const svc = b.dataset.svc;
            const a = b.dataset.a;
            const path = svc === 'hy2-agent'
              ? '/service/node-agent/' + a
              : '/service/' + a;
            try {
              await api(path, { method: 'POST' });
              toast('OK: ' + name + ' ' + a);
              loadServer();
            } catch (e) { toast(String(e.message || e), true); }
          });
        });
      }

      row(st.hysteria_service || 'hysteria-server', st.hysteria_active, 'hysteria');
      row('hy2-agent', st.hy2_agent_active, 'hy2-agent');
      touchLastRefresh();
    } catch (e) {
      if (!silent) toast(String(e.message || e), true);
    }
  }

  function applyHljsTheme() {
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    const dark = t !== 'light';
    const link = document.getElementById('hljs-theme');
    if (link) {
      link.href = dark
        ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css'
        : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css';
    }
  }

  function syncModeLabels() {
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    const name = t === 'light' ? 'Светлая' : 'Тёмная';
    const ll = $('#login-theme-mode-label');
    const al = $('#app-theme-mode-label');
    if (ll) ll.textContent = name;
    if (al) al.textContent = name;
  }

  function closeAllThemeMenus() {}

  function closeRefreshPopover() {
    const pop = $('#refresh-popover');
    const menu = $('#btn-refresh-menu');
    if (!pop) return;
    try {
      if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
    } catch (e) {}
    if (!pop.classList.contains('hidden')) {
      pop.classList.add('hidden');
      if (menu) menu.setAttribute('aria-expanded', 'false');
    }
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'dark';
    document.documentElement.setAttribute('data-theme', mode);
    _uiPrefSet(THEME_KEY, mode);
    applyHljsTheme();
    syncModeLabels();
    syncUiBlurSat();
    if ($('#cfg-yaml') && $('#cfg-yaml').textContent && window.hljs) {
      hljs.highlightElement($('#cfg-yaml'));
    }
    if (_getJwt()) void renderChart().catch(function () {});
  }

  function toggleUIMode() {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    setMode(cur === 'light' ? 'dark' : 'light');
  }

  function loadAccents() {
    let raw = _uiPrefGet(ACCENTS_KEY);
    const arr = [true, true, true, true];
    try {
      if (raw) {
        const p = JSON.parse(raw);
        if (Array.isArray(p) && p.length >= 4) {
          for (let i = 0; i < 4; i++) arr[i] = !!p[i];
        }
      }
    } catch (e) {}
    for (let i = 1; i <= 4; i++) {
      document.documentElement.classList.toggle('hy2-accent-' + i + '-off', !arr[i - 1]);
      const btn = document.querySelector('[data-accent-toggle="' + i + '"]');
      if (btn) {
        btn.classList.toggle('off', !arr[i - 1]);
        btn.classList.toggle('on', arr[i - 1]);
        btn.setAttribute('aria-pressed', arr[i - 1] ? 'true' : 'false');
      }
    }
  }

  function persistAccentsFromDom() {
    const arr = [];
    for (let i = 1; i <= 4; i++) {
      arr.push(!document.documentElement.classList.contains('hy2-accent-' + i + '-off'));
    }
    _uiPrefSet(ACCENTS_KEY, JSON.stringify(arr));
  }

  function toggleAccentSlot(n) {
    const offClass = 'hy2-accent-' + n + '-off';
    document.documentElement.classList.toggle(offClass);
    const nowOff = document.documentElement.classList.contains(offClass);
    const btn = document.querySelector('[data-accent-toggle="' + n + '"]');
    if (btn) {
      btn.classList.toggle('off', nowOff);
      btn.classList.toggle('on', !nowOff);
      btn.setAttribute('aria-pressed', !nowOff ? 'true' : 'false');
    }
    persistAccentsFromDom();
    if (_getJwt()) void renderChart().catch(function () {});
  }

  function showApp(show) {
    const login = $('#view-login');
    const app = $('#view-app');
    if (!login || !app) return;
    if (show) {
      login.classList.add('hidden');
      app.classList.remove('hidden');
      app.classList.remove('app-reveal');
      void app.offsetWidth;
      app.classList.add('app-reveal');
      syncModeLabels();
      window.setTimeout(function () {
        app.classList.remove('app-reveal');
        syncModeLabels();
      }, 520);
    } else {
      app.classList.add('hidden');
      login.classList.remove('hidden');
    }
  }

  function logout() {
    _removeJwt();
    showApp(false);
  }

  /* Сразу после объявления showApp: до любых addEventListener, чтобы F5 всегда бил в /auth/me (см. логи Apache). */
  (async function initSession() {
    const jwtRaw = _getJwt();
    let jwt = jwtRaw && String(jwtRaw).trim();

    function meUrl() {
      try {
        return new URL(apiUrl('/auth/me'), window.location.origin).href;
      } catch (e) {
        return apiUrl('/auth/me');
      }
    }

    async function fetchMe(sendBearer) {
      const headers = { Accept: 'application/json' };
      if (sendBearer && jwt) headers.Authorization = 'Bearer ' + jwt;
      return fetch(meUrl(), { credentials: 'include', headers });
    }

    try {
      let r = await fetchMe(true);
      if (r.status === 401 && jwt) {
        const rCookie = await fetchMe(false);
        if (rCookie.ok) {
          _removeJwtLocal();
          jwt = '';
          r = rCookie;
        } else {
          r = rCookie;
        }
      }
      if (r.status === 401) {
        _removeJwt();
        showApp(false);
        return;
      }
      if (!r.ok) {
        const transient = r.status >= 500 || r.status === 429 || r.status === 408;
        if (transient) {
          showApp(!!jwt);
          if (jwt) showSection('overview');
          toast('Сервер временно недоступен (' + r.status + '). Повторите через минуту.', true);
          return;
        }
        if (r.status === 404 || r.status === 403) {
          showApp(!!jwt);
          if (jwt) showSection('overview');
          toast(
            'Проверка сессии: ' + r.status + '. Проверьте URL панели, прокси и заголовки Authorization/Cookie.',
            true,
          );
          return;
        }
        showApp(false);
        toast('Ошибка проверки сессии (' + r.status + '). Обновите страницу.', true);
        return;
      }
      showApp(true);
      showSection('overview');
    } catch (e) {
      showApp(!!jwt);
      if (jwt) showSection('overview');
      toast('Нет связи с панелью. Проверьте сеть и обновите страницу.', true);
    }
  })();

  (function initRefreshPopover() {
    const menu = $('#btn-refresh-menu');
    const pop = $('#refresh-popover');
    if (!menu || !pop) return;

    pop.removeAttribute('popover');
    menu.removeAttribute('popovertarget');
    menu.removeAttribute('popovertargetaction');

    /* #view-app: overflow:hidden + transform (анимация .app-reveal) — обрезают position:fixed у потомков */
    try {
      if (pop.parentNode && pop.parentNode !== document.body) {
        document.body.appendChild(pop);
      }
    } catch (e) {}

    function positionRefreshPopover() {
      const r = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const margin = 10;
      pop.style.setProperty('--refresh-popover-top', r.bottom + 8 + 'px');
      const measured = pop.offsetWidth;
      const pw = measured > 80 ? measured : 248;
      let left = (vw - pw) / 2;
      left = Math.max(margin, Math.min(left, vw - pw - margin));
      pop.style.setProperty('--refresh-popover-left', left + 'px');
      const cx = r.left + r.width / 2;
      const popRight = left + pw;
      const fromRight = popRight - cx - 5;
      const arrowR = Math.max(14, Math.min(pw - 20, fromRight));
      pop.style.setProperty('--refresh-popover-arrow-right', arrowR + 'px');
    }

    function onMenuClick(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      closeAllThemeMenus();
      if (pop.classList.contains('hidden')) {
        pop.classList.remove('hidden');
        menu.setAttribute('aria-expanded', 'true');
        positionRefreshPopover();
        requestAnimationFrame(() => {
          positionRefreshPopover();
          requestAnimationFrame(() => positionRefreshPopover());
        });
      } else {
        pop.classList.add('hidden');
        menu.setAttribute('aria-expanded', 'false');
      }
    }

    menu.addEventListener('click', onMenuClick, true);
    pop.addEventListener('click', (e) => e.stopPropagation());
    window.addEventListener('resize', () => {
      if (!pop.classList.contains('hidden')) positionRefreshPopover();
    });
    window.addEventListener(
      'scroll',
      () => {
        if (!pop.classList.contains('hidden')) positionRefreshPopover();
      },
      true,
    );
  })();

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try {
      const r = await fetch(apiUrl('/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: $('#inp-login').value.trim(),
          password: $('#inp-pass').value,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || 'Ошибка входа');
      _setJwt(j.access_token);
      showApp(true);
      showSection('overview');
    } catch (err) {
      $('#login-err').textContent = err.message || String(err);
    }
  });

  $('#btn-logout').addEventListener('click', logout);

  const loginThemeBtn = $('#btn-login-theme-toggle');
  if (loginThemeBtn) loginThemeBtn.addEventListener('click', () => toggleUIMode());
  const appThemeBtn = $('#btn-app-theme-toggle');
  if (appThemeBtn) appThemeBtn.addEventListener('click', () => toggleUIMode());

  const accentWrap = document.querySelector('.accent-btns');
  if (accentWrap) {
    accentWrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-accent-toggle]');
      if (!b) return;
      const n = parseInt(b.getAttribute('data-accent-toggle'), 10);
      if (n >= 1 && n <= 4) toggleAccentSlot(n);
    });
  }

  $$('.dock-item').forEach((b) => {
    b.addEventListener('click', () => showSection(b.dataset.section));
  });

  document.addEventListener('click', (e) => {
    const rWrap = $('#refresh-split-wrap');
    const rPop = $('#refresh-popover');
    const inRefresh =
      (rWrap && rWrap.contains(e.target)) || (rPop && rPop.contains(e.target));
    if (!inRefresh) closeRefreshPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeRefreshPopover();
  });

  $('#user-search').addEventListener('input', () => {
    if (currentSection === 'users') loadUsers();
  });

  $('#btn-add-user').addEventListener('click', () => {
    $('#mu-tg').value = '';
    $('#mu-pw').value = '';
    $('#modal-user').classList.remove('hidden');
  });
  $('#mu-cancel').addEventListener('click', () => $('#modal-user').classList.add('hidden'));
  $('#mu-save').addEventListener('click', async () => {
    const telegram_id = $('#mu-tg').value.trim();
    const password = $('#mu-pw').value;
    if (!/^\d{1,32}$/.test(telegram_id)) {
      toast('telegram_id — только цифры', true);
      return;
    }
    if (!password) {
      toast('Укажите пароль', true);
      return;
    }
    try {
      await api('/users', { method: 'POST', body: { telegram_id, password } });
      toast('Пользователь добавлен');
      $('#modal-user').classList.add('hidden');
      loadUsers();
    } catch (e) {
      toast(String(e.message || e), true);
    }
  });

  const uriCloseBtn = $('#uri-close');
  if (uriCloseBtn) {
    uriCloseBtn.addEventListener('click', () => {
      const m = $('#modal-uri');
      if (m) m.classList.add('hidden');
    });
  }
  const uriCopyBtn = $('#uri-copy');
  if (uriCopyBtn) {
    uriCopyBtn.addEventListener('click', async () => {
      const t = $('#uri-out') && $('#uri-out').value;
      if (!t) return;
      try {
        await navigator.clipboard.writeText(t);
        toast('Строка hysteria2 скопирована');
      } catch (e) {
        toast('Не удалось скопировать', true);
      }
    });
  }
  const btnCopySub = $('#uri-copy-sub');
  if (btnCopySub) {
    btnCopySub.addEventListener('click', async () => {
      const t = $('#uri-sub-out').value;
      if (!t) return;
      try {
        await navigator.clipboard.writeText(t);
        toast('HTTPS-ссылка подписки скопирована');
      } catch (e) {
        toast('Не удалось скопировать', true);
      }
    });
  }

  (function initTheme() {
    const saved = _uiPrefGet(THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      setMode(saved);
      return;
    }
    const legacyDark = ['ios26-liquid', 'tg-dark', 'crm-soft', 'accent-violet'];
    if (saved && legacyDark.indexOf(saved) >= 0) {
      setMode('dark');
      _uiPrefSet(THEME_KEY, 'dark');
      return;
    }
    const fromDoc = document.documentElement.getAttribute('data-theme');
    if (fromDoc === 'light' || fromDoc === 'dark') {
      setMode(fromDoc);
      return;
    }
    setMode('dark');
  })();

  loadAccents();
  applyUiPrefs();
  initSettingsSection();
  syncModeLabels();

  (function initAutoRefreshControls() {
    const cb = $('#auto-refresh-on');
    const sel = $('#auto-refresh-interval');
    const btn = $('#btn-refresh-now');
    if (sel) {
      const sec = _uiPrefGet(AUTO_INTERVAL_KEY);
      if (sec && ['5', '10', '30', '60'].indexOf(sec) >= 0) sel.value = sec;
      else sel.value = '5';
    }
    if (cb) {
      const persistAutoRefresh = () => {
        const el = document.getElementById('auto-refresh-on');
        if (!el) return;
        _uiPrefSet(AUTO_REFRESH_KEY, el.checked ? '1' : '0');
        scheduleSectionRefresh();
      };
      const stored = _uiPrefGet(AUTO_REFRESH_KEY);
      cb.checked = stored !== '0';
      cb.addEventListener('change', persistAutoRefresh);
      cb.addEventListener('input', persistAutoRefresh);
      const swLab = cb.closest('.refresh-switch-label');
      if (swLab) {
        swLab.addEventListener('click', () => {
          window.setTimeout(persistAutoRefresh, 0);
        });
      }
    }
    if (sel) {
      sel.addEventListener('change', () => {
        _uiPrefSet(AUTO_INTERVAL_KEY, sel.value);
        scheduleSectionRefresh();
      });
    }
    if (btn) btn.addEventListener('click', () => loadCurrentSection());

    window.addEventListener('storage', (e) => {
      if (!e.key) return;
      if (e.key === AUTO_REFRESH_KEY && cb) {
        cb.checked = e.newValue !== '0';
        scheduleSectionRefresh();
      }
      if (e.key === AUTO_INTERVAL_KEY && sel && e.newValue && ['5', '10', '30', '60'].indexOf(e.newValue) >= 0) {
        sel.value = e.newValue;
        scheduleSectionRefresh();
      }
    });
  })();
})();
