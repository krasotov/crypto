import {
  getCertificates,
  createDetachedSignature,
  arrayBufferToBase64,
} from './cryptopro.js';

const params = new URLSearchParams(window.location.search);
const placement = params.get('placement') || '';
const page = params.get('page') || '';

const appEl = document.getElementById('app');

function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function base64ByteLength(b64 = '') {
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function clientLog(step, meta = {}) {
  console.log('[sign-stamp:client]', step, meta);
}

function formatError(err, fallback = 'Неизвестная ошибка') {
  if (!err) return fallback;
  if (typeof err === 'string') return err || fallback;
  if (typeof err.toDisplayString === 'function') return err.toDisplayString();
  if (err.message) return err.message;
  return fallback;
}

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.step = details.step || null;
    this.requestId = details.requestId || null;
    this.code = details.code || null;
    this.details = details.details || null;
    this.requestMeta = details.requestMeta || null;
  }

  toDisplayString() {
    const parts = [this.message];
    if (this.code) parts.push(`код: ${this.code}`);
    if (this.step) parts.push(`шаг: ${this.step}`);
    if (this.requestMeta?.uploadPart) parts.push(`файл: ${this.requestMeta.uploadPart}`);
    if (this.requestId) parts.push(`id: ${this.requestId}`);
    if (this.requestMeta?.bodySizeHuman) parts.push(`размер: ${this.requestMeta.bodySizeHuman}`);
    return parts.join(' · ');
  }
}

async function fetchFileBase64(prepareId) {
  clientLog('fetch_file_start', { prepareId });
  const res = await fetch(`/api/sign/file/${prepareId}`);
  const requestId = res.headers.get('X-App-Request-Id');
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(json?.error?.message || `Не удалось загрузить файл (${res.status})`, {
      ...json?.error,
      requestId: json?.error?.requestId || requestId,
      step: 'fetch_file',
    });
  }
  const buf = await res.arrayBuffer();
  clientLog('fetch_file_ok', { prepareId, bytes: buf.byteLength, bytesHuman: formatSize(buf.byteLength), requestId });
  return arrayBufferToBase64(buf);
}

async function api(path, options = {}) {
  const bodyStr = typeof options.body === 'string' ? options.body : null;
  const bodyBytes = bodyStr ? new TextEncoder().encode(bodyStr).length : 0;
  clientLog('api_request', {
    path,
    method: options.method || 'GET',
    bodyBytes,
    bodyBytesHuman: formatSize(bodyBytes),
  });

  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const requestId = res.headers.get('X-App-Request-Id');
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }

  if (!res.ok) {
    const errPayload = json?.error || {};
    clientLog('api_error', {
      path,
      status: res.status,
      requestId: errPayload.requestId || requestId,
      code: errPayload.code,
      step: errPayload.step,
      message: errPayload.message,
      requestMeta: errPayload.requestMeta,
    });
    throw new ApiError(errPayload.message || `HTTP ${res.status}`, {
      ...errPayload,
      requestId: errPayload.requestId || requestId,
    });
  }
  clientLog('api_ok', { path, requestId: json?.data?.requestId || requestId });
  return json.data;
}

function parseContext() {
  let options = {};
  try {
    options = JSON.parse(params.get('placement_options') || '{}');
  } catch {
    options = {};
  }
  const match = placement.match(/CRM_DYNAMIC_(\d+)_/);
  return {
    placement,
    entityTypeId: match ? Number(match[1]) : null,
    itemId: options.ID ? Number(options.ID) : null,
    options,
  };
}

async function loadContext() {
  const local = parseContext();
  const server = await api(`/api/context${window.location.search}`);
  return { ...server, ...local };
}

async function boot() {
  try {
    const ctx = await loadContext();
    const fromCard = Boolean(ctx.entityTypeId && ctx.itemId);
    const wantsSettings = page === 'settings' || (placement === 'LEFT_MENU' && page !== 'sign');

    if (fromCard) {
      await renderSigning(ctx);
      return;
    }

    if (wantsSettings && ctx.isAdmin) {
      await renderSettings(ctx);
      return;
    }

    await renderHome(ctx);
  } catch (err) {
    appEl.innerHTML = `<div class="error-box">${escapeHtml(formatError(err))}</div>`;
  }
}

async function renderHome(ctx) {
  appEl.innerHTML = `
    <div class="page">
      <header class="page-header">
        <h1>ЭЦП Подписание</h1>
        <p class="subtitle">Подписание документов в смарт-процессах с помощью КриптоПро</p>
      </header>
      <div class="card">
        <h3>Как подписать документ</h3>
        <ol class="steps-list">
          <li>Откройте <strong>карточку элемента</strong> смарт-процесса (например, «Исходящие документы»).</li>
          <li>В верхнем меню карточки нажмите <strong>«Ещё»</strong> → <strong>«Подписание»</strong>.</li>
          <li>Или перейдите на вкладку <strong>«Подписание»</strong> в карточке.</li>
          <li>Выберите сертификат и нажмите <strong>«Подписать»</strong>.</li>
        </ol>
        <p class="hint">Подписание выполняется на вашем компьютере через КриптоПро CSP и Browser plug-in.</p>
      </div>
      ${ctx.isAdmin ? `
        <div class="card">
          <h3>Администрирование</h3>
          <p>Перед первым использованием настройте поля смарт-процессов.</p>
          <button id="go-settings" class="btn primary">Открыть настройки</button>
        </div>` : `
        <div class="card">
          <p>Если пункт «Подписание» не виден в карточке — обратитесь к администратору портала для настройки приложения.</p>
        </div>`}
    </div>`;

  document.getElementById('go-settings')?.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('page', 'settings');
    window.location.href = url.toString();
  });
}

async function renderSettings(ctx) {
  if (!ctx.isAdmin) {
    appEl.innerHTML = '<div class="error-box">Настройки доступны только администратору портала.</div>';
    return;
  }

  appEl.innerHTML = `
    <div class="page">
      <header class="page-header">
        <h1>Настройки ЭЦП Подписания</h1>
        <p class="subtitle">Выберите смарт-процессы и укажите поля для файлов. При сохранении кнопки «Подписание» автоматически добавляются в карточки включённых процессов.</p>
        <button id="go-home" class="btn secondary" style="margin-top:8px">← К инструкции по подписанию</button>
      </header>
      <div id="settings-root"></div>
      <button id="save-all" class="btn primary save-btn">Сохранить настройки</button>
      <p id="save-status" class="subtitle" style="margin-top:12px;min-height:1.2em"></p>
    </div>`;

  document.getElementById('go-home').addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('page');
    window.location.href = url.toString();
  });

  const root = document.getElementById('settings-root');
  const [processes, settings] = await Promise.all([
    api('/api/smart-processes'),
    api('/api/settings'),
  ]);

  const configs = settings.smartProcesses || {};

  root.innerHTML = processes.map((sp) => {
    const id = String(sp.entityTypeId);
    const cfg = configs[id] || defaultConfig(sp);
    return processCardHtml(sp, cfg);
  }).join('');

  await Promise.all(
    [...root.querySelectorAll('.process-card')].map((card) => bindProcessCard(card)),
  );

  document.getElementById('save-all').addEventListener('click', saveAllSettings);
}

function defaultConfig(sp) {
  return {
    enabled: false,
    title: sp.title,
    sourceFileField: '',
    signedPdfField: '',
    detachedSigField: '',
    responseSourceField: '',
    responseSignedPdfField: '',
    responseDetachedSigField: '',
    documentTemplateId: '',
    bizprocTemplateId: '',
  };
}

function processCardHtml(sp, cfg) {
  const id = sp.entityTypeId;
  return `
    <section class="process-card card" data-entity-type-id="${id}">
      <div class="card-header">
        <label class="checkbox-label">
          <input type="checkbox" class="enabled" ${cfg.enabled ? 'checked' : ''}>
          <strong>${escapeHtml(sp.title)}</strong>
          <span class="badge">entityTypeId: ${id}</span>
        </label>
      </div>
      <div class="card-body">
        <h3>Основной документ</h3>
        <div class="field-grid">
          ${fieldSelect('sourceFileField', 'Поле файла для подписи', cfg.sourceFileField, id)}
          ${fieldSelect('signedPdfField', 'Поле для PDF со штампом ЭЦП', cfg.signedPdfField, id)}
          ${fieldSelect('detachedSigField', 'Поле для откреплённой подписи (.sig)', cfg.detachedSigField, id)}
        </div>
        <h3>Ответный документ</h3>
        <div class="field-grid">
          ${fieldSelect('responseSourceField', 'Поле файла ответа для подписи', cfg.responseSourceField, id)}
          ${fieldSelect('responseSignedPdfField', 'Поле для подписанного ответа (PDF)', cfg.responseSignedPdfField, id)}
          ${fieldSelect('responseDetachedSigField', 'Поле для откреплённой подписи ответа', cfg.responseDetachedSigField, id)}
        </div>
        <div class="field-grid">
          <label>ID шаблона генератора документов
            <input type="text" class="documentTemplateId" value="${escapeAttr(cfg.documentTemplateId || '')}" placeholder="Необязательно">
          </label>
          <label>ID шаблона бизнес-процесса
            <input type="text" class="bizprocTemplateId" value="${escapeAttr(cfg.bizprocTemplateId || '')}" placeholder="Для генерации ответа">
          </label>
        </div>
      </div>
    </section>`;
}

function fieldSelect(name, label, value, entityTypeId) {
  return `
    <label>${label}
      <select class="${name}" data-entity-type-id="${entityTypeId}" data-field="${name}" data-initial-value="${escapeAttr(value || '')}" disabled>
        <option value="">Загрузка полей...</option>
      </select>
    </label>`;
}

async function bindProcessCard(card) {
  const entityTypeId = card.dataset.entityTypeId;
  const selects = [...card.querySelectorAll('select[data-field]')];

  selects.forEach((select) => {
    select.disabled = true;
    select.innerHTML = '<option value="">Загрузка полей...</option>';
  });

  try {
    const fields = await api(`/api/smart-processes/${entityTypeId}/fields`);
    const fileFields = fields.filter((f) => f.type === 'file' || String(f.type).toLowerCase().includes('file'));

    selects.forEach((select) => {
      const current = select.dataset.initialValue || select.value;
      select.disabled = false;
      select.innerHTML = '<option value="">— выберите поле —</option>' +
        fileFields.map((f) => `<option value="${escapeAttr(f.code)}" ${f.code === current ? 'selected' : ''}>${escapeHtml(f.title)} (${escapeHtml(f.code)})</option>`).join('');

      if (fileFields.length === 0) {
        select.innerHTML = '<option value="">Нет полей типа «Файл»</option>';
        select.disabled = true;
      }
    });
  } catch (err) {
    selects.forEach((select) => {
      select.innerHTML = `<option value="">Ошибка: ${escapeHtml(err.message)}</option>`;
      select.disabled = true;
    });
  }
}

async function saveAllSettings() {
  const smartProcesses = {};
  document.querySelectorAll('.process-card').forEach((card) => {
    const id = card.dataset.entityTypeId;
    smartProcesses[id] = {
      enabled: card.querySelector('.enabled').checked,
      title: card.querySelector('strong').textContent,
      sourceFileField: card.querySelector('.sourceFileField').value,
      signedPdfField: card.querySelector('.signedPdfField').value,
      detachedSigField: card.querySelector('.detachedSigField').value,
      responseSourceField: card.querySelector('.responseSourceField').value,
      responseSignedPdfField: card.querySelector('.responseSignedPdfField').value,
      responseDetachedSigField: card.querySelector('.responseDetachedSigField').value,
      documentTemplateId: card.querySelector('.documentTemplateId').value.trim(),
      bizprocTemplateId: card.querySelector('.bizprocTemplateId').value.trim(),
    };
  });

  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ smartProcesses }),
  });
  const json = await res.json().catch(() => ({}));

  const btn = document.getElementById('save-all');
  const statusEl = document.getElementById('save-status');
  const sync = json.placementSync;

  if (!res.ok || json.success === false) {
    btn.textContent = 'Ошибка сохранения';
    if (statusEl) statusEl.textContent = json.error?.message || 'Не удалось сохранить настройки';
    return;
  }

  if (sync?.success) {
    const ids = (sync.entityTypeIds || []).join(', ') || 'нет';
    const republishNote = sync.republished ? ' (переопубликовано)' : '';
    const snapshotNote = sync.snapshotUploaded ? ' + snapshot' : '';
    btn.textContent = 'Сохранено ✓';
    if (statusEl) {
      statusEl.textContent = `Placements обновлены для процессов: ${ids}${republishNote}${snapshotNote}`;
    }
  } else if (sync?.error) {
    btn.textContent = 'Сохранено';
    if (statusEl) statusEl.textContent = `Placements не обновлены: ${sync.error}`;
  } else {
    btn.textContent = 'Сохранено ✓';
    if (statusEl) statusEl.textContent = '';
  }

  setTimeout(() => {
    btn.textContent = 'Сохранить настройки';
    if (statusEl) statusEl.textContent = '';
  }, 8000);
}

async function renderSigning(ctx) {
  const { entityTypeId, itemId } = ctx;
  if (!entityTypeId || !itemId) {
    appEl.innerHTML = '<div class="error-box">Откройте приложение из карточки элемента смарт-процесса.</div>';
    return;
  }

  let config;
  try {
    config = await api(`/api/sign/config/${entityTypeId}`);
  } catch {
    appEl.innerHTML = '<div class="error-box">Смарт-процесс не настроен. Обратитесь к администратору.</div>';
    return;
  }

  appEl.innerHTML = `
    <div class="page sign-page">
      <header class="page-header">
        <h1>Подписание</h1>
        <p class="subtitle">${escapeHtml(config.title || '')} · элемент #${itemId}</p>
      </header>
      <div class="tabs">
        <button class="tab active" data-mode="main">Основной документ</button>
        <button class="tab" data-mode="response">Ответный документ</button>
      </div>
      <div id="sign-panel"></div>
    </div>`;

  let currentMode = 'main';
  const panel = document.getElementById('sign-panel');

  async function loadPanel(mode) {
    currentMode = mode;
    panel.innerHTML = '<div class="loader">Подготовка документа...</div>';

    let prepare;
    try {
      prepare = await api(`/api/sign/prepare/${entityTypeId}/${itemId}?mode=${mode}`);
    } catch (err) {
      panel.innerHTML = `<div class="error-box">${escapeHtml(formatError(err))}</div>`;
      if (mode === 'response') {
        appendGenerateResponseButton(panel, entityTypeId, itemId);
      }
      return;
    }

    panel.innerHTML = signPanelHtml(prepare, [], mode, { certsLoading: true });

    let certs = [];
    try {
      certs = await getCertificates();
      updateCertList(certs);
    } catch (err) {
      updateCertList([], formatError(err));
    }

    bindSignPanel(prepare, certs, mode);
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      loadPanel(tab.dataset.mode);
    });
  });

  await loadPanel('main');
}

function appendGenerateResponseButton(container, entityTypeId, itemId) {
  container.insertAdjacentHTML('beforeend', `
    <div class="card" style="margin-top:16px">
      <p>Если ответный документ ещё не сгенерирован, создайте его:</p>
      <button id="generate-response" class="btn primary">Сгенерировать ответный документ</button>
    </div>`);
  document.getElementById('generate-response')?.addEventListener('click', async () => {
    try {
      await api(`/api/response/generate/${entityTypeId}/${itemId}`, { method: 'POST' });
      alert('Генерация запущена. Обновите через несколько секунд.');
    } catch (e) {
      alert(formatError(e));
    }
  });
}

function isPdfFile(file = {}) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.contentType || '').toLowerCase();
  return type.includes('pdf') || name.endsWith('.pdf');
}

function signPanelHtml(prepare, certs, mode, { certsLoading = false, certError = '' } = {}) {
  const certStatus = certError
    ? certError
    : certsLoading
      ? 'Загрузка сертификатов КриптоПро...'
      : certs.length
        ? `Найдено сертификатов: ${certs.length}`
        : 'Сертификаты не найдены. Установите КриптоПро и сертификат.';

  const pdfStampOption = isPdfFile(prepare.file)
    ? `<label class="checkbox-label stamp-option">
        <input type="checkbox" id="add-stamp" checked>
        Добавить визуальный штамп ЭЦП на PDF
      </label>`
    : '';

  return `
    <div class="card" id="sign-card">
      <p><strong>Файл:</strong> ${escapeHtml(prepare.file.name)}${prepare.file.size ? ` (${formatSize(prepare.file.size)})` : ''}</p>
      ${mode === 'response' ? '<button id="generate-response" class="btn secondary" style="margin-bottom:12px">Сгенерировать ответный документ</button>' : ''}
      <label>Поиск сертификата ЭЦП
        <input type="search" id="cert-search" placeholder="ФИО, организация, серийный номер..." autocomplete="off" ${certs.length && !certsLoading ? '' : 'disabled'}>
      </label>
      <label>Выберите сертификат
        <select id="cert-select" size="6" class="cert-list">${renderCertOptions(certs)}</select>
      </label>
      <p id="cert-count" class="hint ${certError ? 'cert-error' : ''}">${escapeHtml(certStatus)}</p>
      ${pdfStampOption}
      <div class="sign-actions">
        <button id="sign-btn" class="btn primary" ${certs.length && !certsLoading ? '' : 'disabled'}>Подписать</button>
      </div>
      <div id="sign-status" class="status"></div>
    </div>`;
}

function updateCertList(certs, certError = '') {
  const select = document.getElementById('cert-select');
  const searchInput = document.getElementById('cert-search');
  const countEl = document.getElementById('cert-count');
  const signBtn = document.getElementById('sign-btn');
  if (!select || !countEl || !signBtn) return;

  select.innerHTML = renderCertOptions(certs);
  if (searchInput) searchInput.disabled = !certs.length;
  countEl.className = certError ? 'hint cert-error' : 'hint';
  countEl.textContent = certError
    || (certs.length ? `Найдено сертификатов: ${certs.length}` : 'Сертификаты не найдены. Установите КриптоПро и сертификат.');
  signBtn.disabled = !certs.length;
}

function renderCertOptions(certs, filter = '') {
  if (!certs.length) {
    return '<option value="">Сертификаты не найдены</option>';
  }
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? certs.filter((c) => {
        const haystack = [
          c.displayName,
          c.subjectName,
          c.issuerName,
          c.serialNumber,
          c.thumbprint,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : certs;

  if (!filtered.length) {
    return '<option value="">Нет сертификатов по запросу</option>';
  }

  return filtered.map((c) =>
    `<option value="${escapeAttr(c.thumbprint)}">${escapeHtml(c.displayName)}</option>`,
  ).join('');
}

function bindCertSearch(certs) {
  const searchInput = document.getElementById('cert-search');
  const select = document.getElementById('cert-select');
  const countEl = document.getElementById('cert-count');
  const signBtn = document.getElementById('sign-btn');
  if (!searchInput || !select) return;

  const applyFilter = () => {
    const filter = searchInput.value;
    select.innerHTML = renderCertOptions(certs, filter);
    const q = filter.trim().toLowerCase();
    const visible = q
      ? certs.filter((c) => [c.displayName, c.subjectName, c.issuerName, c.serialNumber, c.thumbprint].join(' ').toLowerCase().includes(q))
      : certs;
    countEl.textContent = visible.length
      ? `Показано сертификатов: ${visible.length} из ${certs.length}`
      : `Нет сертификатов по запросу «${filter}»`;
    signBtn.disabled = !visible.length;
    if (visible.length === 1) {
      select.value = visible[0].thumbprint;
    }
  };

  searchInput.addEventListener('input', applyFilter);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && select.options.length && select.options[0].value) {
      e.preventDefault();
      select.value = select.options[0].value;
    }
  });
}

function bindSignPanel(prepare, certs, mode) {
  bindCertSearch(certs);
  document.getElementById('generate-response')?.addEventListener('click', async () => {
    const { entityTypeId, itemId } = parseContext();
    try {
      await api(`/api/response/generate/${entityTypeId}/${itemId}`, { method: 'POST' });
      alert('Генерация ответного документа запущена.');
    } catch (e) {
      alert(e.message);
    }
  });

  document.getElementById('sign-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('sign-status');
    const thumbprint = document.getElementById('cert-select').value;
    const cert = certs.find((c) => c.thumbprint === thumbprint);
    if (!cert) return;

    statusEl.textContent = 'Создание откреплённой подписи...';
    statusEl.className = 'status info';

    try {
      const originalBase64 = await fetchFileBase64(prepare.prepareId);
      clientLog('sign_start', {
        prepareId: prepare.prepareId,
        fileBytes: base64ByteLength(originalBase64),
        fileBytesHuman: formatSize(base64ByteLength(originalBase64)),
      });

      const detachedSig = await createDetachedSignature(thumbprint, originalBase64);
      clientLog('sign_cades_ok', {
        sigBytes: base64ByteLength(detachedSig),
        sigBytesHuman: formatSize(base64ByteLength(detachedSig)),
      });

      statusEl.textContent = 'Сохранение в карточку...';

      const addStamp = document.getElementById('add-stamp')?.checked ?? false;
      const payload = {
        prepareId: prepare.prepareId,
        detachedSigBase64: detachedSig,
        addStamp,
        certInfo: {
          ...cert,
          signedAt: new Date().toLocaleString('ru-RU'),
        },
      };
      clientLog('complete_request', {
        prepareId: prepare.prepareId,
        payloadBytes: JSON.stringify(payload).length,
        payloadBytesHuman: formatSize(JSON.stringify(payload).length),
        sigBytesHuman: formatSize(base64ByteLength(detachedSig)),
      });

      await api('/api/sign/complete', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      statusEl.textContent = addStamp
        ? '✓ Документ подписан. PDF со штампом и откреплённая подпись сохранены в карточку.'
        : '✓ Документ подписан. PDF без штампа и откреплённая подпись сохранены в карточку.';
      statusEl.className = 'status success';
    } catch (err) {
      const text = formatError(err);
      clientLog('sign_failed', { message: text, err });
      statusEl.textContent = `Ошибка: ${text}`;
      statusEl.className = 'status error';
    }
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

boot();
