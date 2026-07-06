import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FONT_CANDIDATES = {
  regular: [
    path.join(__dirname, '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
    path.join(__dirname, '../fonts/DejaVuSans.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
  bold: [
    path.join(__dirname, '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
    path.join(__dirname, '../fonts/DejaVuSans-Bold.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ],
};

function readFont(candidates) {
  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      return fs.readFileSync(fontPath);
    }
  }
  throw new Error('Не найден шрифт с поддержкой кириллицы (DejaVuSans.ttf)');
}

/**
 * Добавляет визуальный штамп ЭЦП на последнюю страницу PDF.
 */
export async function addSignatureStamp(pdfBuffer, certInfo) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  pdfDoc.registerFontkit(fontkit);

  const font = await pdfDoc.embedFont(readFont(FONT_CANDIDATES.regular), { subset: true });
  const fontBold = font;

  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();

  const stampHeight = 80;
  const margin = 24;
  const boxWidth = Math.min(width - margin * 2, 420);
  const boxX = margin;
  const boxY = margin;

  page.drawRectangle({
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: stampHeight,
    borderColor: rgb(0.1, 0.35, 0.65),
    borderWidth: 1.5,
    color: rgb(0.95, 0.97, 1),
  });

  const lines = [
    { text: 'Документ подписан электронной подписью', font: fontBold, size: 9 },
    { text: `Владелец: ${certInfo.subjectName || '—'}`, font, size: 8 },
    { text: `Издатель: ${certInfo.issuerName || '—'}`, font, size: 8 },
    { text: `Серийный №: ${certInfo.serialNumber || '—'}`, font, size: 8 },
    { text: `Действителен: ${certInfo.validFrom || '—'} — ${certInfo.validTo || '—'}`, font, size: 8 },
    { text: `Подписано: ${certInfo.signedAt || new Date().toLocaleString('ru-RU')}`, font, size: 8 },
  ];

  let y = boxY + stampHeight - 14;
  for (const line of lines) {
    page.drawText(line.text.slice(0, 120), {
      x: boxX + 8,
      y,
      size: line.size,
      font: line.font,
      color: rgb(0.1, 0.15, 0.25),
    });
    y -= line.size + 4;
  }

  const stamped = await pdfDoc.save({ useObjectStreams: true });
  return Buffer.from(stamped);
}
