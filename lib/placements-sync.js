const VIBE_API = process.env.VIBE_API_URL || 'https://vibecode.bitrix24.tech';
const DEFAULT_APP_ID = '761fdd2e-a613-4276-bdc7-87e07df05445';

export function buildPlacementsPayload(entityTypeIds = []) {
  const ids = [...new Set(entityTypeIds.map(Number).filter(Boolean))].sort((a, b) => a - b);
  const placements = ['LEFT_MENU'];
  const placementTitles = { LEFT_MENU: 'ЭЦП Подписание' };

  for (const id of ids) {
    placements.push(`CRM_DYNAMIC_${id}_DETAIL_TOOLBAR`, `CRM_DYNAMIC_${id}_DETAIL_TAB`);
    placementTitles[`CRM_DYNAMIC_${id}_DETAIL_TOOLBAR`] = 'Подписание';
    placementTitles[`CRM_DYNAMIC_${id}_DETAIL_TAB`] = 'Подписание';
  }

  return { placements, placementTitles, entityTypeIds: ids };
}

async function vibeRequest(apiKey, method, path, body = null) {
  const res = await fetch(`${VIBE_API}${path}`, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

export async function publishPlacements(apiKey, entityTypeIds, appId = process.env.APP_ID || DEFAULT_APP_ID) {
  if (!apiKey) {
    throw new Error('VIBE_API_KEY не настроен');
  }
  if (!appId) {
    throw new Error('APP_ID не настроен');
  }

  const payload = buildPlacementsPayload(entityTypeIds);
  const publishBody = {
    placements: payload.placements,
    placementTitles: payload.placementTitles,
  };

  let republished = false;
  let { res, json } = await vibeRequest(apiKey, 'POST', `/v1/apps/${appId}/publish`, publishBody);

  if (!json.success && json.error?.code === 'ALREADY_PUBLISHED') {
    const { json: unpublishJson } = await vibeRequest(apiKey, 'POST', `/v1/apps/${appId}/unpublish`);
    if (!unpublishJson.success) {
      throw new Error(unpublishJson.error?.message || 'Не удалось снять приложение с публикации');
    }

    ({ res, json } = await vibeRequest(apiKey, 'POST', `/v1/apps/${appId}/publish`, publishBody));
    republished = true;
  }

  if (!res.ok || json.success === false) {
    const msg = json.error?.message || json.message || `Publish failed: ${res.status}`;
    throw new Error(msg);
  }

  return {
    success: true,
    republished,
    entityTypeIds: payload.entityTypeIds,
    placementCount: payload.placements.length,
    warnings: json.warnings || [],
    response: json.data || json,
  };
}
