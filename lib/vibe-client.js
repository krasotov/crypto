import { createLogger, estimateJsonSize, formatBytes, base64ByteLength } from './logger.js';

const VIBE_API = 'https://vibecode.bitrix24.tech';
const log = createLogger('vibe-client');
const INLINE_MAX_BYTES = Number(process.env.INLINE_UPLOAD_MAX_BYTES || 512 * 1024);
const DISK_STORAGE_ID = Number(process.env.DISK_STORAGE_ID || 3);
const DISK_FOLDER_ID = Number(process.env.DISK_FOLDER_ID || DISK_STORAGE_ID);
const BITRIX_PORTAL = process.env.BITRIX_PORTAL || 'admsp.bitrix24.ru';

export function createVibeClient(apiKey, bearer = null) {
  const authToken = bearer ? bearer.replace(/^Bearer\s+/i, '') : null;

  async function request(method, path, body = null, meta = {}) {
    const bodySize = body ? estimateJsonSize(body) : 0;
    log.info('request', {
      method,
      path,
      bodySize,
      bodySizeHuman: formatBytes(bodySize),
      ...meta,
    });

    const opts = { method, headers: { ...headers } };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const started = Date.now();
    const res = await fetch(`${VIBE_API}${path}`, opts);
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    if (!res.ok) {
      log.error('response_error', {
        method,
        path,
        status: res.status,
        code: json?.error?.code,
        message: json?.error?.message || json?.message,
        bodySize,
        bodySizeHuman: formatBytes(bodySize),
        responsePreview: text.slice(0, 300),
        durationMs: Date.now() - started,
        ...meta,
      });
      const err = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error?.code;
      err.details = json;
      err.step = meta.step || meta.uploadPart || null;
      err.requestMeta = { method, path, bodySize, ...meta };
      throw err;
    }

    log.info('response_ok', {
      method,
      path,
      status: res.status,
      bodySize,
      bodySizeHuman: formatBytes(bodySize),
      durationMs: Date.now() - started,
      ...meta,
    });
    return json;
  }

  async function uploadFileToDisk(filename, buffer, meta = {}) {
    const storageId = Number(meta.storageId || DISK_STORAGE_ID);
    const contentBase64 = buffer.toString('base64');
    const payload = { storageId, filename, content: contentBase64 };
    const payloadBytes = estimateJsonSize(payload);

    log.info('disk_upload_plan', {
      filename,
      fileBytes: buffer.length,
      fileBytesHuman: formatBytes(buffer.length),
      payloadBytes,
      payloadBytesHuman: formatBytes(payloadBytes),
      via: payloadBytes < 900_000 ? 'vibe_files_upload' : 'bitrix_multipart',
      ...meta,
    });

    if (payloadBytes < 900_000) {
      try {
        const { data } = await request('POST', '/v1/files/upload', payload, {
          step: 'disk_upload',
          filename,
          fileBytes: buffer.length,
          fileBytesHuman: formatBytes(buffer.length),
          ...meta,
        });
        const diskFileId = data?.id ?? data?.ID;
        if (!diskFileId) throw new Error('Диск не вернул id файла');
        return diskFileId;
      } catch (err) {
        if (err.code !== 'FST_ERR_CTP_BODY_TOO_LARGE' && err.status !== 413) throw err;
        log.warn('disk_upload_vibe_too_large', { filename, ...meta });
      }
    }

    return uploadFileToDiskDirect(filename, buffer, meta);
  }

  async function uploadFileToDiskDirect(filename, buffer, meta = {}) {
    if (!authToken) {
      throw new Error('Файл слишком большой для JSON-загрузки, нужен OAuth-токен пользователя');
    }
    const folderId = Number(meta.folderId || DISK_FOLDER_ID);
    const form = new FormData();
    form.append('id', String(folderId));
    form.append('data[NAME]', filename);
    form.append('fileContent[0]', filename);
    form.append('fileContent[1]', new Blob([buffer]), filename);

    const url = `https://${BITRIX_PORTAL}/rest/disk.folder.uploadfile.json?auth=${encodeURIComponent(authToken)}`;
    log.info('disk_upload_direct', {
      filename,
      folderId,
      fileBytesHuman: formatBytes(buffer.length),
      portal: BITRIX_PORTAL,
      ...meta,
    });

    const started = Date.now();
    const res = await fetch(url, { method: 'POST', body: form });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    if (!res.ok || json.error) {
      log.error('disk_upload_direct_failed', {
        status: res.status,
        error: json.error || json,
        durationMs: Date.now() - started,
        ...meta,
      });
      const err = new Error(json?.error?.error_description || json?.error?.message || `Bitrix upload HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error?.code || 'BITRIX_UPLOAD_FAILED';
      err.step = meta.uploadPart || 'disk_upload_direct';
      err.requestMeta = { filename, fileBytes: buffer.length, ...meta };
      throw err;
    }

    const diskFileId = json.result?.ID ?? json.result?.id ?? json.result?.OBJECT_ID;
    if (!diskFileId) {
      throw new Error('Bitrix upload не вернул ID файла');
    }
    log.info('disk_upload_direct_ok', {
      diskFileId,
      durationMs: Date.now() - started,
      ...meta,
    });
    return diskFileId;
  }

  async function uploadCrmFileDirect(entityTypeId, itemId, fieldCode, filename, buffer, meta = {}) {
    if (!authToken) {
      throw new Error('Файл слишком большой для JSON, нужен OAuth-токен пользователя');
    }
    const bitrixField = fieldCodeToBitrixName(fieldCode);
    const form = new FormData();
    form.append('entityTypeId', String(entityTypeId));
    form.append('id', String(itemId));
    form.append(`fields[${fieldCode}][0]`, filename);
    form.append(`fields[${fieldCode}][1]`, new Blob([buffer]), filename);

    const url = `https://${BITRIX_PORTAL}/rest/crm.item.update.json?auth=${encodeURIComponent(authToken)}`;
    log.info('crm_upload_direct', {
      entityTypeId,
      itemId,
      fieldCode,
      bitrixField,
      fileBytesHuman: formatBytes(buffer.length),
      portal: BITRIX_PORTAL,
      ...meta,
    });

    const started = Date.now();
    const res = await fetch(url, { method: 'POST', body: form });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    if (!res.ok || json.error) {
      const err = new Error(json?.error?.error_description || json?.error?.message || `Bitrix CRM update HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error?.code || 'BITRIX_CRM_UPDATE_FAILED';
      err.step = meta.uploadPart || 'crm_upload_direct';
      err.requestMeta = { fieldCode, fileBytes: buffer.length, ...meta };
      throw err;
    }

    log.info('crm_upload_direct_ok', {
      durationMs: Date.now() - started,
      ...meta,
    });
    return json.result;
  }

  async function verifyItemFieldFile(entityTypeId, itemId, fieldCode, meta = {}) {
    const item = await getItem(entityTypeId, itemId);
    const files = extractFilesFromField(item, fieldCode);
    if (!files.length) {
      const err = new Error(`Файл не появился в поле ${fieldCode} после сохранения`);
      err.step = 'verify_field_file';
      err.code = 'FIELD_FILE_MISSING';
      err.requestMeta = { entityTypeId, itemId, fieldCode, ...meta };
      throw err;
    }
    if (meta.append && meta.previousCount != null && files.length <= meta.previousCount) {
      const err = new Error(`Новый файл не добавился в поле ${fieldCode} (осталось ${files.length})`);
      err.step = 'verify_field_file';
      err.code = 'FIELD_FILE_NOT_APPENDED';
      err.requestMeta = { entityTypeId, itemId, fieldCode, previousCount: meta.previousCount, currentCount: files.length, ...meta };
      throw err;
    }
    log.info('field_file_verified', {
      entityTypeId,
      itemId,
      fieldCode,
      fileCount: files.length,
      fileIds: files.map((f) => f.id),
      ...meta,
    });
    return files.length === 1 ? files[0] : files;
  }

  async function getItem(entityTypeId, itemId) {
    const { data } = await request('GET', `/v1/items/${entityTypeId}/${itemId}`, null, {
      step: 'get_item',
      entityTypeId,
      itemId,
    });
    return data;
  }

  const headers = { 'X-Api-Key': apiKey };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  return {
    get: (path, meta) => request('GET', path, null, meta),
    post: (path, body, meta) => request('POST', path, body, meta),
    patch: (path, body, meta) => request('PATCH', path, body, meta),
    delete: (path, meta) => request('DELETE', path, null, meta),

    async downloadFile(fileId) {
      const res = await fetch(`${VIBE_API}/v1/files/${fileId}/download`, { headers });
      if (!res.ok) {
        throw new Error(`Download failed: ${res.status}`);
      }
      return readBinaryResponse(res, `file_${fileId}`);
    },

    async downloadCrmItemFile({ entityTypeId, itemId, fieldCode, fileRef }) {
      const fallbackName = fileRef.name || `document_${fileRef.id}.pdf`;
      const preferredName = fileRef.name || null;
      const vibeDownloadUrl = fileRef.urlMachine
        || `${VIBE_API}/v1/items/${entityTypeId}/${itemId}/files/${fieldCode}/${fileRef.id}/download`;

      const sources = [
        { url: vibeDownloadUrl, headers, step: 'crm_get_file_vibe' },
      ];

      if (authToken && fileRef.url) {
        sources.push({
          url: fileRef.url,
          headers: { Authorization: `Bearer ${authToken}` },
          step: 'crm_get_file_portal',
        });
      }

      for (const source of sources) {
        try {
          const res = await fetch(source.url, { headers: source.headers, redirect: 'follow' });
          if (res.ok) {
            return await readBinaryResponse(res, fallbackName, preferredName);
          }
          log.warn('crm_file_download_failed', {
            step: source.step,
            status: res.status,
            entityTypeId,
            itemId,
            fieldCode,
            fileId: fileRef.id,
          });
        } catch (err) {
          log.warn('crm_file_download_error', {
            step: source.step,
            message: err.message,
            entityTypeId,
            itemId,
            fieldCode,
            fileId: fileRef.id,
          });
        }
      }

      throw new Error('Не удалось скачать файл из поля CRM');
    },

    async getItem(entityTypeId, itemId) {
      return getItem(entityTypeId, itemId);
    },

    async updateItemField(entityTypeId, itemId, fieldCode, fileName, contentBase64, meta = {}) {
      const buffer = Buffer.from(contentBase64, 'base64');
      return uploadItemFile(entityTypeId, itemId, fieldCode, fileName, buffer, meta);
    },

    async uploadItemFile(entityTypeId, itemId, fieldCode, fileName, buffer, meta = {}) {
      const contentBase64 = buffer.toString('base64');
      let fieldValue;
      let previousCount = 0;

      if (meta.append) {
        const item = await getItem(entityTypeId, itemId);
        const existing = extractFilesFromField(item, fieldCode);
        previousCount = existing.length;
        const kept = existing
          .filter((file) => file.name !== fileName)
          .map((file) => ({ id: file.id }));
        fieldValue = [
          ...kept,
          [fileName, contentBase64],
        ];
        log.info('append_files', {
          fieldCode,
          previousCount,
          keptCount: kept.length,
          fileName,
          ...meta,
        });
      } else {
        fieldValue = { fileData: [fileName, contentBase64] };
      }

      const payload = { [fieldCode]: fieldValue };
      const payloadBytes = estimateJsonSize(payload);

      if (payloadBytes < 900_000) {
        const { data } = await request('PATCH', `/v1/items/${entityTypeId}/${itemId}`, payload, {
          step: meta.append ? 'append_item_field' : 'update_item_field',
          entityTypeId,
          itemId,
          fieldCode,
          fileName,
          fileBytes: buffer.length,
          fileBytesHuman: formatBytes(buffer.length),
          payloadBytes,
          payloadBytesHuman: formatBytes(payloadBytes),
          append: Boolean(meta.append),
          previousCount,
          ...meta,
        });
        await verifyItemFieldFile(entityTypeId, itemId, fieldCode, { ...meta, previousCount });
        return data;
      }

      if (meta.append) {
        throw new Error('Добавление файла: payload слишком большой, уменьшите число подписей или размер файлов');
      }

      await uploadCrmFileDirect(entityTypeId, itemId, fieldCode, fileName, buffer, meta);
      return verifyItemFieldFile(entityTypeId, itemId, fieldCode, meta);
    },

    async listSmartProcesses() {
      const { data } = await request('GET', '/v1/smart-processes?limit=500');
      return data;
    },

    async getItemFields(entityTypeId) {
      const { data } = await request('GET', `/v1/items/${entityTypeId}/fields`);
      return data?.fields || data;
    },

    async startWorkflow(templateId, documentId, parameters = {}) {
      return request('POST', '/v1/workflows/start', {
        templateId,
        documentId,
        parameters,
      });
    },

    async createDocument(templateId, entityTypeId, entityId) {
      return request('POST', '/v1/documents', {
        templateId,
        entityTypeId,
        entityId,
      });
    },

    async batch(calls) {
      return request('POST', '/v1/batch', { calls });
    },
  };
}

export function extractFilesFromField(item, fieldCode) {
  const value = item[fieldCode];
  if (!value) return [];

  const pick = (file) => {
    const url = file.url || file.downloadUrl || file.showUrl || '';
    const urlMachine = file.urlMachine || file.url_machine || null;
    const fnMatch = (url + (urlMachine || '')).match(/fieldName=([^&]+)/i);
    let name = file.name || file.NAME || null;
    if (!name) {
      for (const src of [url, urlMachine].filter(Boolean)) {
        const nameMatch = src.match(/[?&](?:filename|name)=([^&]+)/i);
        if (nameMatch) {
          try {
            name = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
            break;
          } catch {
            name = nameMatch[1];
            break;
          }
        }
      }
    }
    return {
      id: file.id || file.ID,
      name,
      url,
      urlMachine,
      bitrixFieldName: fnMatch ? decodeURIComponent(fnMatch[1]) : null,
    };
  };

  if (Array.isArray(value)) {
    return value.map(pick).filter((f) => f.id);
  }
  if (typeof value === 'object' && (value.id || value.ID)) {
    return [pick(value)];
  }
  return [];
}

export function extractFileFromField(item, fieldCode) {
  const files = extractFilesFromField(item, fieldCode);
  return files[0] || null;
}

function fieldCodeToBitrixName(fieldCode) {
  const match = fieldCode.match(/^ufCrm(\d+)_(.+)$/i);
  if (match) return `UF_CRM_${match[1]}_${match[2]}`;
  return fieldCode.toUpperCase();
}

function filenameFromResponse(res, fallback) {
  const disposition = res.headers.get('content-disposition') || '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // fall through
    }
  }
  const quotedMatch = disposition.match(/filename="([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1];
  const plainMatch = disposition.match(/filename=([^;\n]+)/i);
  if (plainMatch) return plainMatch[1].trim().replace(/^"|"$/g, '');
  return fallback;
}

async function readBinaryResponse(res, fallbackName, preferredName = null) {
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error?.message || json?.error_description || 'Не удалось скачать файл');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Пустой файл');
  const responseFilename = filenameFromResponse(res, fallbackName);
  return {
    buffer,
    filename: preferredName || responseFilename,
    contentType,
  };
}
