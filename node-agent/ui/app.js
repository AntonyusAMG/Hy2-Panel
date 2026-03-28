(function () {
  const JWT_KEY = 'hy2_jwt';
  const THEME_KEY = 'hy2_theme';
  const TRAFFIC_HIST_KEY = 'hy2_traffic_daily_v2';
  const AUTO_REFRESH_KEY = 'hy2_auto_refresh';
  const AUTO_INTERVAL_KEY = 'hy2_refresh_interval_sec';
  const THEMES = ['ios26-liquid', 'tg-dark', 'crm-soft', 'light', 'accent-violet'];
  const THEME_LABELS = { 'ios26-liquid': 'iOS 26 Liquid', 'tg-dark': 'TG Dark', 'crm-soft': 'CRM soft', 'light': 'Светлая', 'accent-violet': 'Violet' };

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
    return '; path=/; SameSite=Strict' + sec;
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

  function _removeJwt() {
    try { localStorage.removeItem(JWT_KEY); } catch(e) {}
    document.cookie = JWT_KEY + '=; Max-Age=0' + _cookieFlags();
    fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'include' }).catch(function () {});
  }

  function toast(msg, isErr) {
    const el = $('#toast');
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
      if (r.status === 401 && !authPath) {
        _removeJwt();
        showApp(false);
        throw new Error('Сессия истекла — войдите снова');
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

  function loadTrafficDayRows() {
    try {
      const x = JSON.parse(localStorage.getItem(TRAFFIC_HIST_KEY) || '{}');
      if (x && Array.isArray(x.days)) return x.days;
    } catch (e) {}
    return [];
  }

  function saveTrafficDayRows(rows) {
    localStorage.setItem(TRAFFIC_HIST_KEY, JSON.stringify({ days: rows.slice(-45) }));
  }

  function localDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function todayStr() {
    return localDateKey(new Date());
  }

  function prevCalendarDayKey(dayKey) {
    const p = dayKey.split('-').map((n) => parseInt(n, 10));
    if (p.length !== 3 || p.some((x) => !Number.isFinite(x))) return '';
    const dt = new Date(p[0], p[1] - 1, p[2]);
    dt.setDate(dt.getDate() - 1);
    return localDateKey(dt);
  }

  /** Сохранить максимальный накопительный total за день + первый замер дня (если нет «вчера» в истории). */
  function pushDailyTrafficSample(cumulativeTotal) {
    const c = Math.max(0, Number(cumulativeTotal) || 0);
    const t = todayStr();
    const rows = loadTrafficDayRows();
    let row = rows.find((r) => r.d === t);
    if (!row) {
      row = { d: t, cum: c, first: c };
      rows.push(row);
    } else {
      row.cum = Math.max(row.cum || 0, c);
      if (typeof row.first !== 'number' || !Number.isFinite(row.first)) row.first = c;
      else row.first = Math.min(row.first, c);
    }
    rows.sort((a, b) => a.d.localeCompare(b.d));
    saveTrafficDayRows(rows);
  }

  function rowMapByDay(rows) {
    const m = {};
    rows.forEach((r) => {
      if (r && r.d) m[r.d] = r;
    });
    return m;
  }

  /** Байты за календарный день: cum(день) − cum(вчера); если вчера нет — cum − first замер этого дня. */
  function dailyTrafficDeltaBytes(dayKey, rows) {
    const map = rowMapByDay(rows);
    const row = map[dayKey];
    if (!row || typeof row.cum !== 'number') return 0;
    const prevK = prevCalendarDayKey(dayKey);
    const prev = prevK && map[prevK];
    if (prev && typeof prev.cum === 'number') {
      return Math.max(0, row.cum - prev.cum);
    }
    const first = typeof row.first === 'number' ? row.first : row.cum;
    return Math.max(0, row.cum - first);
  }

  const OVERVIEW_CHART_DAYS = 30;

  function renderChart() {
    const rows = loadTrafficDayRows();
    const days = [];
    const dayObjs = [];
    for (let i = OVERVIEW_CHART_DAYS - 1; i >= 0; i--) {
      const dt = new Date();
      dt.setHours(12, 0, 0, 0);
      dt.setDate(dt.getDate() - i);
      days.push(localDateKey(dt));
      dayObjs.push(dt);
    }
    const vals = days.map((d) => dailyTrafficDeltaBytes(d, rows));
    const max = Math.max(...vals, 1);
    const BAR_PX = 136;
    const root = $('#chart-bars');
    if (!root) return;
    root.innerHTML = '';
    const wd = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    days.forEach((d, i) => {
      const col = document.createElement('div');
      col.className = 'bar-col';
      const stack = document.createElement('div');
      stack.className = 'bar-stack';
      const bar = document.createElement('div');
      bar.className = 'bar' + (vals[i] > 0 ? '' : ' bar--empty');
      const pct = vals[i] / max;
      bar.style.height = Math.max(4, Math.round(pct * BAR_PX)) + 'px';
      if (vals[i] > 0) {
        const inner = document.createElement('span');
        inner.className = 'bar-val-inside';
        inner.textContent = formatBytes(vals[i]);
        bar.appendChild(inner);
      }
      const lab = document.createElement('span');
      lab.className = 'bar-label bar-label--stacked';
      const di = dayObjs[i];
      const dd = String(di.getDate()).padStart(2, '0');
      const mm = String(di.getMonth() + 1).padStart(2, '0');
      lab.innerHTML =
        '<span class="bar-label-wd">' +
        wd[di.getDay()] +
        '</span><span class="bar-label-dt">' +
        dd +
        '.' +
        mm +
        '</span>';
      col.title =
        wd[di.getDay()] +
        ', ' +
        d +
        ' · ' +
        (vals[i] > 0
          ? formatBytes(vals[i]) + ' (прирост за сутки)'
          : 'нет данных за день (нужны обновления обзора и соседний день в истории)');
      stack.appendChild(bar);
      col.appendChild(stack);
      col.appendChild(lab);
      root.appendChild(col);
    });
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
  }

  function showSection(id) {
    currentSection = id;
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === id));
    ['overview', 'users', 'config', 'server'].forEach((s) => {
      $('#sec-' + s).classList.toggle('hidden', s !== id);
    });
    clearSectionRefresh();
    if (id === 'overview') loadOverview();
    if (id === 'users') loadUsers();
    if (id === 'config') loadConfig();
    if (id === 'server') loadServer();
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
      pushDailyTrafficSample(sum.total);
      renderChart();

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
          '<td style="white-space:nowrap">' +
          '<button type="button" class="btn btn-ghost" data-act="link" data-id="' + id + '">Ссылка</button> ' +
          '<button type="button" class="btn btn-ghost" data-act="reset" data-id="' + id + '">Сброс</button> ' +
          '<button type="button" class="btn btn-danger" data-act="del" data-id="' + id + '">Удалить</button>' +
          '</td>';
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
          '<td>' +
          '<button type="button" class="btn btn-ghost" data-svc="' + svcKey + '" data-a="restart">Restart</button> ' +
          '<button type="button" class="btn btn-ghost" data-svc="' + svcKey + '" data-a="stop">Stop</button> ' +
          '<button type="button" class="btn btn-ghost" data-svc="' + svcKey + '" data-a="start">Start</button>' +
          '</td>';
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
    const t = document.documentElement.getAttribute('data-theme') || 'tg-dark';
    const dark = t !== 'light';
    const link = document.getElementById('hljs-theme');
    if (link) {
      link.href = dark
        ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css'
        : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css';
    }
  }

  function syncLoginThemeChips() {
    const cur = document.documentElement.getAttribute('data-theme') || 'tg-dark';
    const name = THEME_LABELS[cur] || cur;
    const lbl = $('#login-theme-current-label');
    if (lbl) lbl.textContent = name;
    const appLbl = $('#app-theme-current-label');
    if (appLbl) appLbl.textContent = name;
    const btnTheme = $('#btn-theme');
    if (btnTheme) btnTheme.setAttribute('title', 'Тема: ' + name);
    $$('#login-theme-chips [data-theme-set], #app-theme-dd [data-theme-set]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-theme-set') === cur);
    });
  }

  function closeLoginThemeMenu() {
    const m = $('#login-theme-menu');
    const tr = $('#btn-login-theme');
    const wrap = document.querySelector('#login-theme-chips.login-theme-dd');
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
    if (tr) tr.setAttribute('aria-expanded', 'false');
    if (wrap) wrap.classList.remove('open');
  }

  function closeAppThemeMenu() {
    const m = $('#app-theme-menu');
    const tr = $('#btn-theme');
    const wrap = $('#app-theme-dd');
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
    if (tr) tr.setAttribute('aria-expanded', 'false');
    if (wrap) wrap.classList.remove('open');
  }

  function closeAllThemeMenus() {
    closeLoginThemeMenu();
    closeAppThemeMenu();
  }

  function toggleLoginThemeMenu() {
    closeAppThemeMenu();
    const m = $('#login-theme-menu');
    const tr = $('#btn-login-theme');
    const wrap = document.querySelector('#login-theme-chips.login-theme-dd');
    if (!m || !tr || !wrap) return;
    const nowHidden = m.classList.toggle('hidden');
    tr.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
    wrap.classList.toggle('open', !nowHidden);
  }

  function toggleAppThemeMenu() {
    closeLoginThemeMenu();
    const m = $('#app-theme-menu');
    const tr = $('#btn-theme');
    const wrap = $('#app-theme-dd');
    if (!m || !tr || !wrap) return;
    const nowHidden = m.classList.toggle('hidden');
    tr.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
    wrap.classList.toggle('open', !nowHidden);
  }

  function setTheme(t) {
    if (THEMES.indexOf(t) < 0) t = 'tg-dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
    applyHljsTheme();
    syncLoginThemeChips();
    if ($('#cfg-yaml') && $('#cfg-yaml').textContent && window.hljs) {
      hljs.highlightElement($('#cfg-yaml'));
    }
  }

  function setSidebarOpen(open) {
    const sb = $('#sidebar');
    const ov = $('#sidebar-overlay');
    if (sb) sb.classList.toggle('open', !!open);
    if (ov) ov.classList.toggle('hidden', !open);
  }

  function showApp(show) {
    const login = $('#view-login');
    const app = $('#view-app');
    if (show) {
      login.classList.add('hidden');
      app.classList.remove('hidden');
      app.classList.remove('app-reveal');
      void app.offsetWidth;
      app.classList.add('app-reveal');
      window.setTimeout(function () {
        app.classList.remove('app-reveal');
      }, 520);
    } else {
      app.classList.add('hidden');
      login.classList.remove('hidden');
      setSidebarOpen(false);
    }
  }

  function logout() {
    _removeJwt();
    showApp(false);
  }

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

  $('#btn-theme').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppThemeMenu();
  });

  $('#btn-login-theme').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLoginThemeMenu();
  });

  $('#login-theme-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b || b.id === 'btn-login-theme') return;
    setTheme(b.getAttribute('data-theme-set'));
    closeLoginThemeMenu();
  });

  $('#app-theme-dd').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b) return;
    setTheme(b.getAttribute('data-theme-set'));
    closeAppThemeMenu();
  });

  document.addEventListener('click', () => {
    closeAllThemeMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllThemeMenus();
  });

  $('#btn-menu').addEventListener('click', () => {
    const sb = $('#sidebar');
    const next = sb && !sb.classList.contains('open');
    setSidebarOpen(next);
  });

  $('#sidebar-overlay').addEventListener('click', () => {
    setSidebarOpen(false);
  });

  $$('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => {
      showSection(b.dataset.section);
      setSidebarOpen(false);
    });
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

  $('#uri-close').addEventListener('click', () => $('#modal-uri').classList.add('hidden'));
  $('#uri-copy').addEventListener('click', async () => {
    const t = $('#uri-out').value;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast('Строка hysteria2 скопирована');
    } catch (e) {
      toast('Не удалось скопировать', true);
    }
  });
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
    let saved = localStorage.getItem(THEME_KEY);
    if (THEMES.indexOf(saved) < 0) {
      if (saved === 'dark') saved = 'tg-dark';
      else if (saved === 'light') saved = 'light';
      else saved = 'light';
    }
    setTheme(saved);
  })();

  (function initAutoRefreshControls() {
    const cb = $('#auto-refresh-on');
    const sel = $('#auto-refresh-interval');
    const btn = $('#btn-refresh-now');
    if (sel) {
      const sec = localStorage.getItem(AUTO_INTERVAL_KEY);
      if (sec && ['5', '10', '30', '60'].indexOf(sec) >= 0) sel.value = sec;
      else sel.value = '5';
    }
    if (cb) {
      const stored = localStorage.getItem(AUTO_REFRESH_KEY);
      cb.checked = stored !== '0';
      cb.addEventListener('change', () => {
        localStorage.setItem(AUTO_REFRESH_KEY, cb.checked ? '1' : '0');
        scheduleSectionRefresh();
      });
    }
    if (sel) {
      sel.addEventListener('change', () => {
        localStorage.setItem(AUTO_INTERVAL_KEY, sel.value);
        scheduleSectionRefresh();
      });
    }
    if (btn) btn.addEventListener('click', () => loadCurrentSection());
  })();

  (function initRefreshPopover() {
    const menu = $('#btn-refresh-menu');
    const pop = $('#refresh-popover');
    const wrap = $('#refresh-split-wrap');
    if (!menu || !pop || !wrap) return;
    menu.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowHidden = pop.classList.toggle('hidden');
      menu.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    /* После обработчика кнопки: иначе в части браузеров document закрывает попап в том же тике */
    document.addEventListener('click', (e) => {
      if (wrap.contains(e.target)) return;
      window.setTimeout(() => {
        if (!pop.classList.contains('hidden')) {
          pop.classList.add('hidden');
          menu.setAttribute('aria-expanded', 'false');
        }
      }, 0);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || pop.classList.contains('hidden')) return;
      pop.classList.add('hidden');
      menu.setAttribute('aria-expanded', 'false');
    });
  })();

  (async function initSession() {
    const jwtRaw = _getJwt();
    const jwt = jwtRaw && String(jwtRaw).trim();
    const headers = { Accept: 'application/json' };
    if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
    try {
      const r = await fetch(apiUrl('/auth/me'), { credentials: 'include', headers: headers });
      if (r.status === 401) {
        _removeJwt();
        showApp(false);
        return;
      }
      if (!r.ok) {
        /* НЕ вызывать _removeJwt: 502/503/429 и т.д. — сессия жива, иначе «вылет» при каждом глюке прокси */
        showApp(false);
        toast('Сервер временно недоступен (' + r.status + '). Обновите страницу через минуту.', true);
        return;
      }
      showApp(true);
      showSection('overview');
    } catch (e) {
      showApp(false);
      toast('Нет связи с панелью. Проверьте сеть и обновите страницу.', true);
    }
  })();
})();
