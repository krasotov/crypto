const CADESCOM_CADES_BES = 1;
const CAPICOM_CURRENT_USER_STORE = 2;
const CAPICOM_MY_STORE = 'My';
const CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED = 2;
const CADESCOM_BASE64_TO_BINARY = 1;

function normalizePluginError(err, fallback = 'CryptoPro plug-in недоступен') {
  if (typeof err === 'string') return err || fallback;
  if (err?.message) return err.message;
  return fallback;
}

function waitForCadesPlugin(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof cadesplugin === 'undefined') {
      reject(new Error('CryptoPro Browser plug-in не найден. Установите КриптоПро CSP и расширение для браузера.'));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('Таймаут ожидания CryptoPro plug-in. Проверьте, что расширение КриптоПро включено для этого сайта.')),
      timeoutMs,
    );
    cadesplugin.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(new Error(normalizePluginError(
          err,
          'CryptoPro plug-in недоступен. Установите КриптоПро CSP, расширение браузера и разрешите доступ на admsp.bitrix24.ru.',
        )));
      },
    );
  });
}

async function getCertificates() {
  try {
    await waitForCadesPlugin();
    const store = await cadesplugin.CreateObjectAsync('CAdESCOM.Store');
    await store.Open(CAPICOM_CURRENT_USER_STORE, CAPICOM_MY_STORE, CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED);
    const certs = await store.Certificates;
    const count = await certs.Count;
    const result = [];

    for (let i = 1; i <= count; i += 1) {
      const cert = await certs.Item(i);
      const validToDate = await cert.ValidToDate;
      const validTo = new Date(validToDate);
      if (validTo < new Date()) continue;

      const subjectName = await cert.SubjectName;
      const issuerName = await cert.IssuerName;
      const thumbprint = await cert.Thumbprint;
      const serialNumber = await cert.SerialNumber;
      const validFromDate = await cert.ValidFromDate;

      result.push({
        thumbprint,
        subjectName: extractCn(subjectName),
        issuerName: extractCn(issuerName),
        serialNumber,
        validFrom: formatDate(validFromDate),
        validTo: formatDate(validToDate),
        displayName: `${extractCn(subjectName)} (${formatDate(validToDate)})`,
      });
    }

    await store.Close();
    return result;
  } catch (err) {
    throw new Error(normalizePluginError(err, 'Не удалось получить список сертификатов КриптоПро'));
  }
}

function extractCn(dn) {
  const match = dn.match(/CN=([^,]+)/i);
  return match ? match[1].trim() : dn;
}

function formatDate(value) {
  const d = new Date(value);
  return d.toLocaleDateString('ru-RU');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function createDetachedSignature(thumbprint, dataBase64) {
  await waitForCadesPlugin();
  const store = await cadesplugin.CreateObjectAsync('CAdESCOM.Store');
  await store.Open(CAPICOM_CURRENT_USER_STORE, CAPICOM_MY_STORE, CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED);
  const certs = await store.Certificates;
  const found = await certs.Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, thumbprint);
  if ((await found.Count) === 0) {
    throw new Error('Сертификат не найден');
  }
  const cert = await found.Item(1);
  const signer = await cadesplugin.CreateObjectAsync('CAdESCOM.CPSigner');
  await signer.propset_Certificate(cert);

  const signedData = await cadesplugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
  await signedData.propset_ContentEncoding(CADESCOM_BASE64_TO_BINARY);
  await signedData.propset_Content(dataBase64);

  const signature = await signedData.SignCades(signer, CADESCOM_CADES_BES, true);
  await store.Close();
  return signature;
}

export {
  waitForCadesPlugin,
  getCertificates,
  createDetachedSignature,
  arrayBufferToBase64,
};
