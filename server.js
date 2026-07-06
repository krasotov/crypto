import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createVibeClient, extractFileFromField } from './lib/vibe-client.js';
import { addSignatureStamp } from './lib/pdf-stamp.js';
import {
  loadSettings,
  saveSettings,
  getProcessConfig,
  getEnabledEntityTypeIds,
} from './lib/settings-store.js';
import { publishPlacements, buildPlacementsPayload } from './lib/placements-sync.js';
import { putPrepare, getPrepare, deletePrepare } from './lib/prepare-cache.js';
import { buildSignedPdfName, buildDetachedSigName } from './lib/file-names.js';
import { createLogger, getRecentLogs, formatBytes, base64ByteLength, estimateJsonSize } from './lib/logger.js';

const log = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const VIBE_API_KEY = process.env.VIBE_API_KEY || process.env.VIBE_APP_KEY;
const JSON_LIMIT = process.env.JSON_LIMIT || '2mb';

const app = express();

app.use((req, res, next) => {
  const requestId = req.headers['x-vibe-request-id']?.toString() || `local_${Date.now().toString(36)}`;
  req.requestId = requestId;
  res.setHeader('X-App-Request-Id', requestId);

  if (req.path.startsWith('/api/')) {
    log.info('http_in', {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      contentLength: req.headers['content-length'] || null,
      contentLengthHuman: formatBytes(Number(req.headers['content-length'] || 0)),
      userId: req.headers['x-vibe-user-id'] || null,
    });
  }
  next();
});

app.use(express.json({
  limit: JSON_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBodyLength = buf.length;
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

function getBearer(req) {
  const header = req.headers['x-vibe-authorization'] || req.headers.authorization;
  if (!header) return null;
  return header.toString().replace(/^Bearer\s+/i, '');
}

function getVibeKey(req) {
  return VIBE_API_KEY;
}

function createClient(req) {
  const apiKey = getVibeKey(req);
  if (!apiKey) throw new Error('VIBE_API_KEY не настроен на сервере');
  return createVibeClient(apiKey, getBearer(req));
}

function isAdmin(req) {
  return req.headers['x-vibe-user-role'] === 'ADMIN';
}

function apiError(res, err, req, fallbackStatus = 500) {
  log.error('api_error', {
    requestId: req.requestId,
    path: req.path,
    message: err.message,
    code: err.code,
    status: err.status,
    details: err.details,
    requestMeta: err.requestMeta,
  });
  res.status(err.status || fallbackStatus).json({
    success: false,
    error: {
      message: err.message,
      code: err.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
      step: err.step || err.requestMeta?.step || null,
      details: err.details || null,
      requestMeta: err.requestMeta || null,
    },
  });
}

function parsePlacementContext(req) {
  const placement = req.query.placement || '';
  const optionsRaw = req.query.placement_options || '{}';
  let options = {};
  try {
    options = JSON.parse(optionsRaw);
  } catch {
    options = {};
  }

  const dynamicMatch = placement.match(/CRM_DYNAMIC_(\d+)_/);
  const entityTypeId = dynamicMatch ? Number(dynamicMatch[1]) : null;
  const itemId = options.ID ? Number(options.ID) : null;

  return { placement, entityTypeId, itemId, options };
}

app.get('/api/context', (req, res) => {
  const ctx = parsePlacementContext(req);
  res.json({
    success: true,
    data: {
      ...ctx,
      userId: req.headers['x-vibe-user-id'] || null,
      userRole: req.headers['x-vibe-user-role'] || null,
      isAdmin: isAdmin(req),
    },
  });
});

app.get('/api/settings', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: { message: 'Только администратор' } });
  }
  res.json({ success: true, data: loadSettings() });
});

app.put('/api/settings', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: { message: 'Только администратор' } });
  }
  const { smartProcesses } = req.body || {};
  if (!smartProcesses || typeof smartProcesses !== 'object') {
    return res.status(400).json({ success: false, error: { message: 'Неверный формат настроек' } });
  }
  saveSettings({ smartProcesses });

  let placementSync = null;
  try {
    placementSync = await publishPlacements(getVibeKey(req), getEnabledEntityTypeIds());
    log.info('placement_sync_ok', {
      requestId: req.requestId,
      entityTypeIds: placementSync.entityTypeIds,
      placementCount: placementSync.placementCount,
    });
  } catch (err) {
    log.warn('placement_sync_failed', { requestId: req.requestId, message: err.message });
    placementSync = { success: false, error: err.message };
  }

  res.json({ success: true, data: loadSettings(), placementSync });
});

app.get('/api/smart-processes', async (req, res) => {
  try {
    const client = createClient(req);
    const processes = await client.listSmartProcesses();
    res.json({ success: true, data: processes });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: { message: err.message } });
  }
});

app.get('/api/smart-processes/:entityTypeId/fields', async (req, res) => {
  try {
    const client = createClient(req);
    const fields = await client.getItemFields(req.params.entityTypeId);
    const normalized = normalizeFields(fields);
    res.json({ success: true, data: normalized });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: { message: err.message } });
  }
});

function normalizeFields(raw) {
  const fields = raw?.fields && typeof raw.fields === 'object' ? raw.fields : raw;

  if (Array.isArray(fields)) {
    return fields.map((f) => ({
      code: f.name || f.code || f.fieldName,
      title: f.title || f.label || f.formLabel || f.listLabel || f.name,
      type: f.type,
      isMultiple: f.isMultiple,
    })).filter((f) => f.code);
  }

  return Object.entries(fields || {}).map(([code, meta]) => ({
    code,
    title: meta.title || meta.label || meta.formLabel || meta.listLabel || code,
    type: meta.type,
    isMultiple: meta.isMultiple,
  }));
}

app.get('/api/sign/config/:entityTypeId', (req, res) => {
  const config = getProcessConfig(req.params.entityTypeId);
  if (!config?.enabled) {
    return res.status(404).json({ success: false, error: { message: 'Смарт-процесс не настроен' } });
  }
  res.json({ success: true, data: config });
});

app.get('/api/sign/prepare/:entityTypeId/:itemId', async (req, res) => {
  const signLog = createLogger('sign-prepare');
  try {
    const { entityTypeId, itemId } = req.params;
    const { mode = 'main' } = req.query;
    signLog.info('start', { requestId: req.requestId, entityTypeId, itemId, mode });

    const config = getProcessConfig(entityTypeId);
    if (!config?.enabled) {
      return res.status(404).json({ success: false, error: { message: 'Смарт-процесс не настроен', requestId: req.requestId } });
    }

    const fieldCode = mode === 'response' ? config.responseSourceField : config.sourceFileField;
    if (!fieldCode) {
      return res.status(400).json({ success: false, error: { message: 'Поле источника не настроено', requestId: req.requestId } });
    }

    const client = createClient(req);
    const item = await client.getItem(entityTypeId, itemId);
    const fileRef = extractFileFromField(item, fieldCode);
    if (!fileRef?.id) {
      return res.status(404).json({ success: false, error: { message: 'Файл для подписи не найден в карточке', requestId: req.requestId } });
    }

    const { buffer, filename, contentType } = await client.downloadCrmItemFile({
      entityTypeId,
      itemId,
      fieldCode,
      fileRef,
    });
    const originalFilename = fileRef.name || filename || 'document.pdf';

    signLog.info('downloaded', {
      requestId: req.requestId,
      fieldCode,
      fileId: fileRef.id,
      fileName: originalFilename,
      fileRefName: fileRef.name || null,
      responseFileName: filename || null,
      fileBytes: buffer.length,
      fileBytesHuman: formatBytes(buffer.length),
    });

    const prepareId = putPrepare({
      buffer,
      filename: originalFilename,
      contentType,
      entityTypeId: Number(entityTypeId),
      itemId: Number(itemId),
      mode,
      userId: req.headers['x-vibe-user-id']?.toString() || null,
    });

    signLog.info('cached', { requestId: req.requestId, prepareId, fileBytesHuman: formatBytes(buffer.length) });

    res.json({
      success: true,
      data: {
        prepareId,
        mode,
        itemId: Number(itemId),
        entityTypeId: Number(entityTypeId),
        itemTitle: item.title || item.TITLE || `#${itemId}`,
        file: {
          id: fileRef.id,
          name: originalFilename,
          contentType,
          size: buffer.length,
        },
      },
    });
  } catch (err) {
    apiError(res, err, req);
  }
});

app.get('/api/sign/file/:prepareId', (req, res) => {
  const entry = getPrepare(req.params.prepareId);
  if (!entry) {
    log.warn('file_cache_miss', { requestId: req.requestId, prepareId: req.params.prepareId });
    return res.status(404).json({ success: false, error: { message: 'Сессия подготовки истекла. Обновите страницу.', requestId: req.requestId } });
  }
  const userId = req.headers['x-vibe-user-id']?.toString();
  if (entry.userId && userId && entry.userId !== userId) {
    return res.status(403).json({ success: false, error: { message: 'Нет доступа к файлу', requestId: req.requestId } });
  }
  log.info('file_download', {
    requestId: req.requestId,
    prepareId: req.params.prepareId,
    fileBytes: entry.buffer.length,
    fileBytesHuman: formatBytes(entry.buffer.length),
  });
  res.setHeader('Content-Type', entry.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.filename)}"`);
  res.send(entry.buffer);
});

app.post('/api/sign/stamp-pdf', async (req, res) => {
  try {
    const { prepareId, certInfo, pdfBase64 } = req.body;
    let pdfBuffer;
    if (prepareId) {
      const entry = getPrepare(prepareId);
      if (!entry) {
        return res.status(404).json({ success: false, error: { message: 'Сессия подготовки истекла' } });
      }
      pdfBuffer = entry.buffer;
    } else if (pdfBase64) {
      pdfBuffer = Buffer.from(pdfBase64, 'base64');
    } else {
      return res.status(400).json({ success: false, error: { message: 'prepareId или pdfBase64 обязателен' } });
    }
    if (!certInfo) {
      return res.status(400).json({ success: false, error: { message: 'certInfo обязателен' } });
    }
    const stamped = await addSignatureStamp(pdfBuffer, certInfo);
    res.json({ success: true, data: { pdfBase64: stamped.toString('base64') } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

app.post('/api/sign/complete', async (req, res) => {
  const signLog = createLogger('sign-complete');
  try {
    const {
      prepareId,
      entityTypeId: bodyEntityTypeId,
      itemId: bodyItemId,
      mode = 'main',
      detachedSigBase64,
      certInfo,
      stampedPdfBase64,
      detachedSigName,
      stampedPdfName,
    } = req.body || {};

    signLog.info('start', {
      requestId: req.requestId,
      prepareId,
      incomingBodyBytes: req.rawBodyLength || estimateJsonSize(req.body),
      incomingBodyHuman: formatBytes(req.rawBodyLength || estimateJsonSize(req.body)),
      sigBytes: base64ByteLength(detachedSigBase64),
      sigBytesHuman: formatBytes(base64ByteLength(detachedSigBase64)),
    });

    if (!detachedSigBase64) {
      return res.status(400).json({ success: false, error: { message: 'detachedSigBase64 обязателен', requestId: req.requestId } });
    }

    const entry = prepareId ? getPrepare(prepareId) : null;
    const entityTypeId = entry?.entityTypeId ?? bodyEntityTypeId;
    const itemId = entry?.itemId ?? bodyItemId;
    const signMode = entry?.mode ?? mode;

    if (!entityTypeId || !itemId) {
      return res.status(400).json({ success: false, error: { message: 'Не указан элемент CRM', requestId: req.requestId } });
    }

    const userId = req.headers['x-vibe-user-id']?.toString();
    if (entry?.userId && userId && entry.userId !== userId) {
      return res.status(403).json({ success: false, error: { message: 'Нет доступа', requestId: req.requestId } });
    }

    const config = getProcessConfig(entityTypeId);
    if (!config?.enabled) {
      return res.status(404).json({ success: false, error: { message: 'Смарт-процесс не настроен', requestId: req.requestId } });
    }

    const signedField = signMode === 'response' ? config.responseSignedPdfField : config.signedPdfField;
    const sigField = signMode === 'response' ? config.responseDetachedSigField : config.detachedSigField;

    if (!signedField || !sigField) {
      return res.status(400).json({ success: false, error: { message: 'Поля для сохранения не настроены', requestId: req.requestId } });
    }

    const originalFilename = entry?.filename || 'document.pdf';
    let signedPdfBuffer = stampedPdfBase64 ? Buffer.from(stampedPdfBase64, 'base64') : null;

    const isPdf = (entry?.contentType || '').includes('pdf') ||
      (entry?.filename || '').toLowerCase().endsWith('.pdf');

    if (!signedPdfBuffer && entry && isPdf && certInfo) {
      signLog.info('stamp_pdf', {
        requestId: req.requestId,
        sourceBytes: entry.buffer.length,
        sourceBytesHuman: formatBytes(entry.buffer.length),
      });
      signedPdfBuffer = await addSignatureStamp(entry.buffer, {
        ...certInfo,
        signedAt: certInfo.signedAt || new Date().toLocaleString('ru-RU'),
      });
      signLog.info('stamped', {
        requestId: req.requestId,
        stampedBytes: signedPdfBuffer.length,
        stampedBytesHuman: formatBytes(signedPdfBuffer.length),
      });
    } else if (!signedPdfBuffer && entry && !isPdf) {
      signedPdfBuffer = entry.buffer;
    }

    if (!signedPdfBuffer) {
      return res.status(400).json({ success: false, error: { message: 'Не удалось подготовить подписанный файл', requestId: req.requestId } });
    }

    const client = createClient(req);
    const pdfName = stampedPdfName || buildSignedPdfName(originalFilename);
    const sigName = buildDetachedSigName(originalFilename, certInfo);
    const sigBuffer = Buffer.from(detachedSigBase64, 'base64');

    signLog.info('upload_pdf_start', {
      requestId: req.requestId,
      field: signedField,
      fileName: pdfName,
      fileBytesHuman: formatBytes(signedPdfBuffer.length),
      strategy: 'crm_fileData',
    });
    await client.uploadItemFile(entityTypeId, itemId, signedField, pdfName, signedPdfBuffer, {
      requestId: req.requestId,
      uploadPart: 'signed_pdf',
    });

    signLog.info('upload_sig_start', {
      requestId: req.requestId,
      field: sigField,
      fileName: sigName,
      fileBytesHuman: formatBytes(sigBuffer.length),
    });
    await client.uploadItemFile(entityTypeId, itemId, sigField, sigName, sigBuffer, {
      requestId: req.requestId,
      uploadPart: 'detached_sig',
      append: true,
    });

    if (prepareId) deletePrepare(prepareId);

    signLog.info('done', { requestId: req.requestId, entityTypeId, itemId });
    res.json({ success: true, data: { message: 'Файлы подписи сохранены в карточку', requestId: req.requestId } });
  } catch (err) {
    apiError(res, err, req);
  }
});

app.post('/api/response/generate/:entityTypeId/:itemId', async (req, res) => {
  try {
    const { entityTypeId, itemId } = req.params;
    const config = getProcessConfig(entityTypeId);
    if (!config?.enabled) {
      return res.status(404).json({ success: false, error: { message: 'Смарт-процесс не настроен' } });
    }

    const client = createClient(req);

    if (config.bizprocTemplateId) {
      const result = await client.startWorkflow(
        Number(config.bizprocTemplateId),
        [`crm`, `DYNAMIC_${entityTypeId}`, itemId],
        config.bizprocParameters || {},
      );
      return res.json({ success: true, data: { type: 'bizproc', result } });
    }

    if (config.documentTemplateId) {
      const result = await client.createDocument(
        Number(config.documentTemplateId),
        Number(entityTypeId),
        Number(itemId),
      );
      return res.json({ success: true, data: { type: 'document', result } });
    }

    return res.status(400).json({
      success: false,
      error: { message: 'Не настроен шаблон бизнес-процесса или генератора документов для ответа' },
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: { message: err.message, details: err.details } });
  }
});

app.get('/api/placements/enabled', (_req, res) => {
  const entityTypeIds = getEnabledEntityTypeIds();
  res.json({
    success: true,
    data: {
      entityTypeIds,
      ...buildPlacementsPayload(entityTypeIds),
    },
  });
});

app.post('/api/placements/sync', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: { message: 'Только администратор' } });
  }
  try {
    const placementSync = await publishPlacements(getVibeKey(req), getEnabledEntityTypeIds());
    log.info('placement_sync_manual', {
      requestId: req.requestId,
      entityTypeIds: placementSync.entityTypeIds,
      placementCount: placementSync.placementCount,
    });
    res.json({ success: true, data: placementSync });
  } catch (err) {
    apiError(res, err, req);
  }
});

app.get('/api/debug/logs', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: { message: 'Только администратор' } });
  }
  res.json({ success: true, data: getRecentLogs(Number(req.query.limit) || 100) });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sign-stamp' });
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    log.error('body_too_large', {
      requestId: req.requestId,
      path: req.path,
      method: req.method,
      limit: JSON_LIMIT,
      contentLength: req.headers['content-length'] || null,
      contentLengthHuman: formatBytes(Number(req.headers['content-length'] || 0)),
    });
    return res.status(413).json({
      success: false,
      error: {
        code: 'BODY_TOO_LARGE',
        message: `Тело запроса слишком большое (лимит ${JSON_LIMIT}). Файл не должен отправляться в JSON — используйте prepareId.`,
        requestId: req.requestId,
        limit: JSON_LIMIT,
        contentLength: req.headers['content-length'] || null,
      },
    });
  }
  next(err);
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`sign-stamp listening on :${PORT}`);
});
