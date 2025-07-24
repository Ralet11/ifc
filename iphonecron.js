require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const cron      = require('node-cron');
const puppeteer = require('puppeteer');

const {
  FB_EMAIL, FB_PASSWORD,
  TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_IDS,
  TELEGRAM_TOKEN,
  KEYWORD, INTERVAL_CRON
} = process.env;

// ─── Persistencia ─────────────────────────────────────────────────────
const DATA_FILE     = path.resolve(__dirname, 'seen.json');
const USER_DATA_DIR = path.resolve(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);
if (!fs.existsSync(DATA_FILE))     fs.writeFileSync(DATA_FILE, '[]');

const loadSeen = () => new Set(JSON.parse(fs.readFileSync(DATA_FILE)));
const saveSeen = set => fs.writeFileSync(DATA_FILE, JSON.stringify([...set], null, 2));

// ─── Construcción del array de chat IDs ─────────────────────────────
const CHAT_IDS = (
  TELEGRAM_CHAT_IDS
    ? TELEGRAM_CHAT_IDS.split(',').map(s => s.trim())
    : [TELEGRAM_CHAT_ID]
).filter(Boolean);

if (!TELEGRAM_TOKEN || CHAT_IDS.length === 0) {
  console.error('❌ Debes definir TELEGRAM_TOKEN y al menos un TELEGRAM_CHAT_ID(S) en .env');
  process.exit(1);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Función para enviar a todos los chats ───────────────────────────
async function sendTelegram(text) {
  for (const chatId of CHAT_IDS) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      });
      console.log(`📨 Enviado a chat ${chatId}`);
    } catch (e) {
      console.error(`❌ Error enviando a ${chatId}:`, e.message);
    }
  }
}

// ─── Configuración de Marketplace ─────────────────────────────────────
const MP_URL =
  `https://www.facebook.com/marketplace/buenosaires/search/` +
  `?query=${encodeURIComponent(KEYWORD)}` +
  `&distance=40&daysSinceListed=1&sort=DATE_DESC`;

// ─── Variables de estado para el navegador ────────────────────────────
let browser = null;
let launchCount = 0;
const MAX_LAUNCHES = 12; // tras 12 ejecuciones reiniciamos Chromium

// ─── Inicializa o reinicia el browser según sea necesario ──────────────
async function initBrowser() {
  if (browser && browser.isConnected() && launchCount < MAX_LAUNCHES) {
    return;
  }
  if (browser && browser.isConnected()) {
    await browser.close();
  }
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox','--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });
  launchCount = 0;
  console.log('🔄 Chromium (re)iniciado');
}

// ─── Proceso principal ────────────────────────────────────────────────
let running = false;
async function run() {
  if (running) {
    console.log('⏳ Ya en ejecución, omito esta corrida');
    return;
  }
  running = true;

  try {
    // 1) Aseguramos el browser
    await initBrowser();
    launchCount++;

    // 2) Creamos y configuramos una nueva pestaña
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/114.0.0.0 Safari/537.36'
    );

    // 3) Navegamos e hicimos login si es necesario
    console.log('🌐 Navegando a Marketplace con filtros...');
    await page.goto(MP_URL, { waitUntil: 'networkidle2' });
    if (page.url().includes('/login')) {
      console.log('🔐 Logueando de nuevo…');
      await page.type('#email', FB_EMAIL, { delay: 40 });
      await page.type('#pass',  FB_PASSWORD, { delay: 40 });
      await Promise.all([
        page.click('[name=login]'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);
      await page.goto(MP_URL, { waitUntil: 'networkidle2' });
    }

    // 4) Scroll infinito para cargar todos los items
    console.log('🧭 Scroll infinito para cargar todos los listados...');
    const found = new Map();
    let lastH = -1, same = 0;
    while (same < 3) {
      const cards = await page.$$eval('a[href*="/marketplace/item/"]', els =>
        els.map(a => {
          const href  = a.href.split('?')[0];
          const id    = href.split('/').filter(Boolean).pop();
          const title = a.getAttribute('aria-label')?.trim() || a.textContent.trim();
          return { id, href, title };
        })
      );
      cards.forEach(item => found.set(item.id, item));

      const h = await page.evaluate('document.body.scrollHeight');
      if (h === lastH) same++;
      else { same = 0; lastH = h; }
      await page.evaluate('window.scrollBy(0, window.innerHeight)');
      await delay(1500);
    }
    console.log(`✅ Scroll terminado, ${found.size} ítems capturados`);

    // 5) Filtrar y enviar nuevos
    const seen = loadSeen();
    let sent = 0;
    for (const item of found.values()) {
      if (!seen.has(item.id)) {
        await sendTelegram(`*Más recientes*\n${item.title}\n${item.href}`);
        seen.add(item.id);
        sent++;
      }
    }
    saveSeen(seen);
    console.log(`🎉 Enviados ${sent} nuevos listados, total vistos ${seen.size}`);

    // 6) Cerrar la pestaña
    await page.close();
  } catch (err) {
    console.error('❌ Error en run():', err.message);
  } finally {
    running = false;
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────
console.log(`🚀 Scheduler iniciado – cron "${INTERVAL_CRON}"`);
run();
cron.schedule(INTERVAL_CRON, () => run());
