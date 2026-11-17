/* Medicine Expiry Date Detector - runs fully in the browser (no backend). */
const $ = (id) => document.getElementById(id);
const els = {
  file: $('fileInput'), camBtn: $('cameraBtn'), capBtn: $('captureBtn'),
  video: $('video'), canvas: $('canvas'), preview: $('preview'),
  result: $('result'), raw: $('rawText'), pw: $('progressWrap'),
  bar: $('bar'), pt: $('progressText'), manualIn: $('manualInput'),
  manualBtn: $('manualBtn'), hist: $('history'), clear: $('clearBtn'),
};

const MONTHS = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };
const MAX_WIDTH = 1000;          // downscale for speed -> no lag
let worker = null, workerPromise = null, busy = false, stream = null;

/* ---------- OCR worker (created once, reused) ---------- */
function getWorker() {
  if (!workerPromise) {
    els.pw.hidden = false;
    workerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        els.pt.textContent = m.status + (m.progress ? ` ${Math.round(m.progress * 100)}%` : '');
        els.bar.style.width = Math.round((m.progress || 0) * 100) + '%';
      },
    }).then(async (w) => {
      await w.setParameters({
        tessedit_char_whitelist: '0123456789/-.:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
        tessedit_pageseg_mode: '6',
      });
      worker = w;
      return w;
    });
  }
  return workerPromise;
}
// Warm up in the background once the page is idle
window.addEventListener('load', () => setTimeout(() => getWorker().catch(() => {}), 500));

/* ---------- Image preprocessing ---------- */
function preprocess(source) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, MAX_WIDTH / sw);
  const c = els.canvas;
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);       // contrast stretch
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i] - min) * 255) / range;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ---------- Date extraction ---------- */
function fixOcr(text) {
  // Fix common OCR confusions only when next to digits
  return text.toUpperCase()
    .replace(/(?<=\d)[OQ](?=\d|\b)|(?<=\b)[OQ](?=\d)/g, '0')
    .replace(/(?<=\d)[IL|](?=\d)/g, '1')
    .replace(/(?<=\d)S(?=\d)/g, '5');
}

const PATTERNS = [
  { re: /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})\b/g, kind: 'dmy' },
  { re: /\b(20\d{2})\s*[\/\-.]\s*(0?[1-9]|1[0-2])\b/g, kind: 'ym' },
  { re: /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[\s.\-\/,']*(\d{4}|\d{2})\b/g, kind: 'mon' },
  { re: /\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(\d{4}|\d{2})\b/g, kind: 'my' },
];

const fullYear = (y) => (y < 100 ? 2000 + y : y);
const endOfMonth = (y, m) => new Date(y, m, 0);          // m is 1-12

function extractDates(raw) {
  const text = fixOcr(raw).replace(/\n/g, ' ');
  const taken = [];
  const found = [];
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      let date = null;
      if (kind === 'dmy') {
        const d = +m[1], mo = +m[2], y = fullYear(+m[3]);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) date = new Date(y, mo - 1, d);
      } else if (kind === 'ym') {
        date = endOfMonth(+m[1], +m[2]);
      } else if (kind === 'mon') {
        date = endOfMonth(fullYear(+m[2]), MONTHS[m[1].slice(0, 3)]);
      } else {
        date = endOfMonth(fullYear(+m[2]), +m[1]);
      }
      if (!date || date.getFullYear() < 2000 || date.getFullYear() > 2100) continue;
      taken.push([s, e]);
      const before = text.slice(Math.max(0, s - 22), s);
      let label = 'unknown';
      if (/(EXP|USE\s*BEF|BEST\s*BEF|EXPIRY)[A-Z.\s:]*$/.test(before)) label = 'exp';
      else if (/(MFG|MFD|MANUF|MFR|PROD)[A-Z.\s:]*$/.test(before)) label = 'mfg';
      found.push({ date, label, text: m[0], pos: s });
    }
  }
  return found.sort((a, b) => a.pos - b.pos);
}

function pickExpiry(found) {
  if (!found.length) return null;
  return (
    found.find((f) => f.label === 'exp') ||
    // otherwise the latest date that is not labelled as manufacturing
    found.filter((f) => f.label !== 'mfg').sort((a, b) => b.date - a.date)[0] ||
    null
  );
}

/* ---------- Status + UI ---------- */
function fmt(d) {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function evaluate(expiry) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0) return { cls: 'expired', title: '❌ EXPIRED — do not use', note: `Expired ${-days} day(s) ago.` };
  if (days <= 30) return { cls: 'warn', title: '⚠️ Expiring very soon', note: `Only ${days} day(s) left.` };
  if (days <= 90) return { cls: 'warn', title: '⚠️ Expiring within 3 months', note: `${days} days left.` };
  return { cls: 'safe', title: '✅ Safe to use (not expired)', note: `${days} days left.` };
}

function showResult(found, source) {
  const pick = pickExpiry(found);
  if (!pick) {
    els.result.className = 'result idle';
    els.result.innerHTML = 'No expiry date detected. Try a clearer photo, or enter the date manually below.';
    return;
  }
  const ev = evaluate(pick.date);
  els.result.className = 'result ' + ev.cls;
  els.result.innerHTML = `${ev.title}<small>Expiry date: ${fmt(pick.date)} (read as "${pick.text}")<br>${ev.note}</small>`;
  saveHistory({ expiry: fmt(pick.date), status: ev.title, source, at: new Date().toLocaleString('en-IN') });
}

/* ---------- OCR run ---------- */
async function runOcr(source, label) {
  if (busy) return;
  busy = true;
  els.result.className = 'result idle';
  els.result.textContent = 'Reading image…';
  try {
    const canvas = preprocess(source);
    const w = await getWorker();
    const { data } = await w.recognize(canvas);
    els.raw.textContent = data.text.trim() || '(nothing read)';
    showResult(extractDates(data.text), label);
  } catch (err) {
    console.error(err);
    els.result.className = 'result expired';
    els.result.textContent = 'Could not read the image. Check your internet (needed to load the OCR engine once) and try again.';
  } finally {
    busy = false;
    els.pw.hidden = true;
  }
}

/* ---------- Events ---------- */
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  if (!f) return;
  stopCamera();
  const url = URL.createObjectURL(f);
  els.preview.src = url;
  els.preview.hidden = false;
  els.preview.onload = () => { runOcr(els.preview, 'upload'); URL.revokeObjectURL(url); };
});

els.camBtn.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false,
    });
    els.video.srcObject = stream;
    els.video.hidden = false;
    els.preview.hidden = true;
    els.capBtn.disabled = false;
  } catch {
    alert('Camera not available. Use http://127.0.0.1 (Live Server) and allow camera access, or upload a photo.');
  }
});

els.capBtn.addEventListener('click', () => {
  if (!stream) return;
  runOcr(els.video, 'camera');
});

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.hidden = true;
  els.capBtn.disabled = true;
}

els.manualBtn.addEventListener('click', () => {
  const t = els.manualIn.value.trim();
  if (!t) return;
  els.raw.textContent = t;
  showResult(extractDates(t), 'manual');
});
els.manualIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.manualBtn.click(); });

/* ---------- History (localStorage) ---------- */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('medHistory') || '[]'); } catch { return []; }
}
function saveHistory(item) {
  const h = loadHistory(); h.unshift(item);
  try { localStorage.setItem('medHistory', JSON.stringify(h.slice(0, 20))); } catch {}
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  els.hist.innerHTML = h.length
    ? h.map((x) => `<li><span>${x.expiry} — ${x.status}</span><span>${x.at}</span></li>`).join('')
    : '<li>No scans yet.</li>';
}
els.clear.addEventListener('click', () => { localStorage.removeItem('medHistory'); renderHistory(); });
renderHistory();
