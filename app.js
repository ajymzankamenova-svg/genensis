import { analyzeDiary, createWeatherMarkup, getModeInfo, paletteVariables, startSceneCanvas, photoOrientation, parseMusicUrl, createMoodArtwork, getEmotionPalette, sortMemoryEntries } from './engine.js';
import { AudioController } from './audio.js';
import { DEMO_ENTRIES, MODE_LABELS } from './presets.js';

const DB_NAME = 'srez-genesis';
const STORE_NAME = 'days';
const MAX_PHOTOS = 4;
const MAX_FILE_SIZE = 12 * 1024 * 1024;
const MODE_STORIES = {
  zine: { human: 'Радость', line: 'Радость и восторг', description: 'Для смеха, встреч с близкими, ярких побед и спонтанных поездок.', reference: 'Солнечный импульс', texture: 'Луч солнца · движение · конфетти' },
  minimalism: { human: 'Грусть', line: 'Грусть и расстройство', description: 'Для слёз, одиночества, потерь и тихих дождливых вечеров.', reference: 'Незаметные детали дождя', texture: 'Капли · туман · мягкая тишина' },
  suprematism: { human: 'Злость', line: 'Злость и обида', description: 'Для конфликтов, давления, несправедливости и внутреннего огня.', reference: 'Резкий ритм перемены', texture: 'Огонь · геометрия · высокий контраст' },
  impressionism: { human: 'Спокойствие', line: 'Спокойствие и уют', description: 'Для тепла дома, нежности, отдыха и тихой ностальгии.', reference: 'Тёплый домашний свет', texture: 'Тепло · акварель · мягкий воздух' }
};
const audio = new AudioController();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let database;
let entries = [];
let selectedMode = 'impressionism';
let selectedPhotos = [];
let selectedAudio = null;
let currentBookPage = 0;
let stopAmbient = () => {};
let stopScene = () => {};
let speechRecognition = null;
let voiceBase = '';
let voiceFinal = '';
let microphonePermission = 'unknown';
let toastTimer;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB недоступна'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

function normalizeEntry(entry, index = 0) {
  const analysis = entry.analysis || entry;
  const date = new Date(entry.createdAt || Date.now());
  const demoImportance = { impressionism: 5, suprematism: 4, minimalism: 3, zine: 2 }[analysis.mode || entry.mode] || 3;
  const demoMigration = {
    'demo-impressionism': { title: 'Тёплый вечер у окна', mainTag: 'Спокойствие и уют' },
    'demo-suprematism': { title: 'Красный импульс перемены', mainTag: 'Злость и обида' },
    'demo-minimalism': { title: 'Пауза под дождём', mainTag: 'Грусть и расстройство' },
    'demo-zine': { title: 'Ночь на встрече друзей', mainTag: 'Радость и восторг' }
  };
  const migration = demoMigration[entry.id];
  return { ...entry, ...(migration || {}), eventDate: entry.eventDate || date.toISOString().slice(0, 10), importance: Math.min(5, Math.max(1, Number(entry.importance) || (entry.id?.startsWith('demo-') ? demoImportance : 3))), mainTag: migration?.mainTag || entry.mainTag || entry.mood || getModeInfo(analysis.mode || entry.mode).label, createdAt: entry.createdAt || date.toISOString() };
}

async function loadEntries() {
  try {
    database = await openDatabase();
    const store = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const saved = await idbRequest(store.getAll());
    if (!saved.length) {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      DEMO_ENTRIES.forEach((entry, index) => transaction.objectStore(STORE_NAME).put(normalizeEntry(entry, index)));
      await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
      return DEMO_ENTRIES.map(normalizeEntry);
    }
    return saved
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
      .map(normalizeEntry);
  } catch (error) {
    console.warn('Локальное хранилище недоступно; используется резервное хранилище.', error);
    try {
      const saved = JSON.parse(localStorage.getItem('srez-days') || 'null');
      if (saved?.length) return saved.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string').map(normalizeEntry);
      const demos = DEMO_ENTRIES.map(normalizeEntry);
      localStorage.setItem('srez-days', JSON.stringify(demos));
      return demos;
    } catch { return DEMO_ENTRIES.map(normalizeEntry); }
  }
}

async function persistEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string') {
    throw new Error('Некорректная запись воспоминания');
  }
  if (database) { await idbRequest(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(entry)); return; }
  const saved = entries.filter((item) => item.id !== entry.id);
  try { localStorage.setItem('srez-days', JSON.stringify([entry, ...saved])); }
  catch { showToast('Браузер заблокировал локальное хранение. Разреши данные сайта и попробуй снова.'); throw new Error('Не удалось сохранить день'); }
}

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function safeUrl(value = '') { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function formatDate(value, options = {}) {
  const date = value instanceof Date ? value : /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', ...options }).format(date).toLocaleUpperCase('ru').replace(/\sГ\.$/u, '');
}

function setAmbientMood(mode) {
  document.body.dataset.mood = mode;
  const emotion = getEmotionPalette(mode);
  document.body.style.setProperty('--emotion-a', emotion.a);
  document.body.style.setProperty('--emotion-b', emotion.b);
  document.body.style.setProperty('--emotion-c', emotion.c);
  stopAmbient();
  try {
    stopAmbient = startSceneCanvas($('#ambient-canvas'), { mode, weather: { minimalism: 'rain', impressionism: 'sun', suprematism: 'ember', zine: 'sun' }[mode] });
  } catch (error) {
    console.warn('Фоновый Canvas недоступен; сохранён цветовой режим.', error);
  }
}

function renderMoodOptions() {
  $('#mood-options').innerHTML = Object.entries(MODE_STORIES).map(([mode, story], index) => {
    const art = createMoodArtwork(mode);
    return `<button class="mood-card mood-${mode}" type="button" data-mode="${mode}" onclick="window.openMoodModal('${mode}')" aria-label="Выбрать ${story.human}: ${story.line}"><span class="mood-card-art"><img src="${art}" alt="${story.line}" aria-hidden="true"><span class="mood-number">0${index + 1}</span><span class="mood-art-label">${story.human.toUpperCase()}</span></span><span class="mood-card-copy"><span class="mood-human">${story.human}</span><strong>${story.line}</strong><span class="mood-description">${story.description}</span><span class="mood-reference">${story.reference}<span>↗</span></span></span></button>`;
  }).join('');
  $$('.mood-card').forEach((card) => {
    card.type = 'button';
    card.setAttribute('role', 'button');
  });
}

function openMoodModal(mode) {
  if (!MODE_STORIES[mode]) mode = 'impressionism';
  selectedMode = mode;
  setAmbientMood(mode);
  $('#builder-mode-note').textContent = `${MODE_STORIES[mode].line} · ${MODE_STORIES[mode].reference}`;
  $('#builder-view').classList.remove('is-hidden');
  $('#reflection-view').classList.add('is-hidden');
  refreshMicrophoneStatus();
  $('#builder-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectMood(mode) {
  openMoodModal(mode);
}

function sortedEntries() { return sortMemoryEntries(entries); }

function renderArchive(direction = 'next') {
  const sorted = sortedEntries();
  const pageCount = Math.max(1, Math.ceil(sorted.length / 2));
  currentBookPage = Math.min(currentBookPage, pageCount - 1);
  const spread = sorted.slice(currentBookPage * 2, currentBookPage * 2 + 2);
  const book = $('#book-spread');
  book.classList.remove('turn-forward', 'turn-back');
  void book.offsetWidth;
  book.classList.add(direction === 'back' ? 'turn-back' : 'turn-forward');
  book.innerHTML = spread.map((entry, index) => renderBookPage(entry, currentBookPage * 2 + index)).join('');
  $$('.memory-page', book).forEach((page) => page.addEventListener('click', () => openEntry(page.dataset.entryId)));
  $('#archive-count').textContent = String(entries.length).padStart(2, '0');
  const lastTwo = entries.length % 100;
  const lastDigit = entries.length % 10;
  const pageWord = lastTwo >= 11 && lastTwo <= 14 ? 'СТРАНИЦ' : lastDigit === 1 ? 'СТРАНИЦА' : lastDigit >= 2 && lastDigit <= 4 ? 'СТРАНИЦЫ' : 'СТРАНИЦ';
  $('#archive-subtitle').textContent = `${entries.length} ${pageWord}`;
  renderMemoryHQ();
  $('#book-page').textContent = `${String(currentBookPage + 1).padStart(2, '0')} / ${String(pageCount).padStart(2, '0')}`;
  $('#book-prev').disabled = currentBookPage === 0;
  $('#book-next').disabled = currentBookPage >= pageCount - 1;
}

function renderMemoryHQ() {
  const groups = {
    zine: { label: 'Радость', className: 'joy', entries: [] },
    minimalism: { label: 'Грусть', className: 'sadness', entries: [] },
    suprematism: { label: 'Тревожность', className: 'alarm', entries: [] },
    impressionism: { label: 'Спокойствие', className: 'calm', entries: [] }
  };
  entries
    .filter((entry) => !String(entry.id || '').startsWith('demo-'))
    .forEach((entry) => {
      const mode = entry.analysis?.mode || entry.mode;
      if (groups[mode]) groups[mode].entries.push(entry);
    });
  const ranked = Object.entries(groups).sort(([, a], [, b]) => b.entries.length - a.entries.length);
  const realEntries = entries.filter((entry) => !String(entry.id || '').startsWith('demo-'));
  $('#hq-dominant').textContent = realEntries.length ? `${ranked[0][1].entries.length ? ranked[0][1].label : 'Память'} ведёт` : 'Пока тихо в штаб-квартире';
  $('#hq-counts').textContent = realEntries.length ? ranked.map(([, group]) => `${group.label} · ${group.entries.length}`).join('  /  ') : 'Создайте первое воспоминание, чтобы зажечь сферы памяти';
  const orbs = $('#hq-orbs');
  if (!realEntries.length) {
    orbs.innerHTML = '<div class="hq-empty"><span>✦</span><strong>Штаб-квартира ждёт первый момент</strong><p>Создайте первое воспоминание, чтобы зажечь сферы памяти.</p></div>';
    return;
  }
  orbs.innerHTML = ranked.flatMap(([mode, group]) => group.entries.slice(0, 5).map((entry, index) => {
    const title = entry.title || entry.analysis?.title || 'Момент';
    const size = 82 + (entry.importance || 3) * 12;
    return `<button class="memory-orb orb-${group.className}" type="button" data-entry-id="${escapeHtml(entry.id)}" style="--orb-size:${size}px;--orb-delay:${index * -.9}s" aria-label="Открыть память: ${escapeHtml(title)}"><span class="orb-glow"></span><strong>${escapeHtml(title.length > 28 ? `${title.slice(0, 28)}…` : title)}</strong><small>${group.label} · ${entry.importance}/5</small></button>`;
  })).join('');
  $$('.memory-orb', orbs).forEach((orb) => orb.addEventListener('click', () => openEntry(orb.dataset.entryId)));
}

function renderBookPage(entry, index) {
  const mode = entry.analysis?.mode || entry.mode;
  const analysis = entry.analysis || entry;
  const photo = entry.photoUrls?.[0] || '';
  const title = entry.title || analysis.title || 'Воспоминание';
  const orientation = entry.photoOrientations?.[0] || 'portrait';
  return `<button class="memory-page page-${index % 2 ? 'right' : 'left'}" type="button" data-entry-id="${escapeHtml(entry.id)}" data-mode="${mode}" style="--page-index:${index};--user-accent-1:${analysis.palette?.[0] || entry.palette?.[0] || '#d6d2c4'}"><span class="page-number">${String(index + 1).padStart(2, '0')}</span><span class="page-photo ${orientation === 'landscape' ? 'film-frame' : 'polaroid-frame'}"><img src="${photo}" alt="Кадр из дня ${escapeHtml(title)}">${orientation === 'landscape' ? '<i class="film-holes" aria-hidden="true"></i>' : ''}</span><span class="page-stamp">${formatDate(entry.eventDate || entry.createdAt, { day: 'numeric', month: 'short' })}</span><strong class="page-title">${escapeHtml(title)}</strong><span class="page-tag">${escapeHtml(entry.mainTag || analysis.mood || getModeInfo(mode).label)}</span><span class="page-stars" aria-label="Важность ${entry.importance} из 5">${'✳'.repeat(entry.importance)}<i>${'✳'.repeat(5 - entry.importance)}</i></span><span class="page-open">РАЗВЕРНУТЬ ↗</span></button>`;
}

function renderPhotoLayouts(entry) {
  const photos = entry.photoUrls || [];
  if (!photos.length || (photos.length === 1 && photos[0] === DEMO_ENTRIES.find((item) => item.mode === (entry.analysis?.mode || entry.mode))?.photoUrls[0])) {
    const mode = entry.analysis?.mode || entry.mode;
    const artwork = createMoodArtwork(mode);
    return `<figure class="detail-polaroid emotional-placeholder"><img src="${artwork}" alt="Тематическая иллюстрация настроения"><figcaption>СЦЕНА НАСТРОЕНИЯ</figcaption></figure><aside class="collage-note"><span>THIS IS THE MOMENT</span><strong>${escapeHtml(entry.mainTag || entry.mood || 'День')}</strong></aside>`;
  }
  return photos.map((url, index) => {
    const orientation = entry.photoOrientations?.[index] || 'portrait';
    return `<figure class="${orientation === 'landscape' ? 'detail-film-frame' : 'detail-polaroid'}"><img src="${url}" alt="Фотография ${index + 1} из воспоминания"><figcaption>${String(index + 1).padStart(2, '0')} / 0${entry.photoUrls.length}</figcaption></figure>`;
  }).join('');
}

function renderDetail(entry) {
  const mode = entry.analysis?.mode || entry.mode;
  const analysis = entry.analysis || entry;
  const info = getModeInfo(mode);
  const title = entry.title || analysis.title || 'Воспоминание';
  const photo = entry.photoUrls?.[0] || '';
  const externalUrl = safeUrl(entry.music?.url);
  const musicLink = parseMusicUrl(externalUrl || '');
  const eventDate = entry.eventDate || entry.createdAt;
  const keywords = analysis.keywords?.length ? analysis.keywords.map(escapeHtml).join(' · ') : 'явных маркеров не найдено';
  const trackName = entry.music?.title || (entry.audioBlob ? 'Твоя запись' : 'Генеративный эмбиент');
  $('#detail-content').innerHTML = `<article class="diary-sheet" data-mode="${mode}"><section class="diary-art" data-mode="${mode}"><img src="${photo}" alt="Арт-сцена: ${escapeHtml(title)}"><div class="diary-art-wash"></div><canvas class="scene-canvas" aria-label="Живая текстура сцены"></canvas><span class="diary-art-stamp">${formatDate(eventDate, { day: 'numeric', month: 'short', year: 'numeric' })}</span><strong class="diary-art-title">${escapeHtml(title)}</strong><span class="diary-art-credit">СРЕЗ / ${MODE_LABELS[mode]}</span></section><section class="diary-copy"><div class="diary-topline"><span>${formatDate(eventDate, { day: 'numeric', month: 'long', year: 'numeric' })}</span><span class="importance-badge">${'✳'.repeat(entry.importance || 3)}</span></div><h2 id="detail-title">${escapeHtml(title)}</h2><p class="diary-mood">${escapeHtml(entry.mainTag || analysis.mood || info.label)} <span>·</span> ${escapeHtml(info.reference)}</p><p class="diary-story">${escapeHtml(entry.text)}</p><div class="detail-photo-layout">${renderPhotoLayouts(entry)}</div><section class="music-card" id="music-card"><div class="record-art"><span class="record-disc"><i></i></span><span class="record-center">${escapeHtml((entry.music?.title || 'СРЕЗ').slice(0, 12))}</span></div><div class="music-info"><span class="music-label">САУНДТРЕК ДНЯ</span><strong id="track-title">${escapeHtml(trackName)}</strong><small>${escapeHtml(entry.music?.artist || '')}${entry.music?.artist ? ' · ' : ''}${analysis.bpm || entry.bpm || 96} BPM</small><input id="track-progress" class="track-progress" type="range" min="0" max="100" value="0" aria-label="Позиция в треке"><span class="track-time" id="track-time">00:00 / 00:00</span></div><div class="music-buttons"><button class="play-button" id="play-audio" type="button" aria-label="Воспроизвести">▶</button><button class="mute-button" id="mute-audio" type="button" aria-label="Выключить звук" aria-pressed="false">◖</button>${externalUrl ? `<a class="external-link" href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть трек в сервисе">↗</a>` : ''}</div></section><details class="logic-details"><summary>КАК СИСТЕМА СОБРАЛА ЭТУ СТРАНИЦУ</summary><div class="logic-body"><p><strong>Слова:</strong> ${keywords}.</p><p><strong>Цвет:</strong> ${(analysis.palette || entry.palette || []).map((color) => `<i class="logic-swatch" style="background:${color}"></i>`).join('')} взяты из снимка.</p><p><strong>Ритм:</strong> ${analysis.bpm || entry.bpm || 96} BPM управляет движением сцены.</p><p><strong>Референс:</strong> ${escapeHtml(info.reference)} · ${escapeHtml(MODE_STORIES[mode].texture)}.</p></div></details><div class="diary-actions"><button class="speech-button" id="speak-entry" type="button">↗ Озвучить день</button><button class="export-button" id="export-entry" type="button">↓ Экспорт PNG</button><button class="delete-button" id="delete-entry" type="button">Удалить страницу</button></div></section></article>`;

  if (musicLink) {
    const serviceCard = document.createElement('section');
    serviceCard.className = 'music-service-card-detail';
    const cover = musicLink.provider === 'youtube' ? `https://img.youtube.com/vi/${musicLink.id}/hqdefault.jpg` : 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#1db954"/><circle cx="120" cy="120" r="72" fill="none" stroke="#fff" stroke-width="12"/><path d="M70 105c45 22 100 22 132 0M76 130c38 18 78 18 118 4M84 154c30 12 62 12 93 2" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/></svg>`);
    serviceCard.innerHTML = `<img class="music-service-cover" src="${cover}" alt="Обложка трека"><div class="music-service-copy"><strong>${escapeHtml(trackName)}</strong><span>${musicLink.provider === 'youtube' ? 'YouTube' : 'Spotify'} · СЛУШАТЬ НА ПЛАТФОРМЕ</span></div><a class="music-service-link" href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener noreferrer">Слушать на ${musicLink.provider === 'youtube' ? 'YouTube' : 'Spotify'} ↗</a>`;
    $('#music-card').after(serviceCard);
    $('#play-audio').textContent = '▶';
    $('#play-audio').setAttribute('aria-label', 'Воспроизвести атмосферное сопровождение');
    $('.music-label', $('#music-card')).textContent = 'АТМОСФЕРНЫЙ ВиниЛ';
    $('.music-info small', $('#music-card')).textContent = 'Локальный Web Audio плеер';
  }

  const art = $('.diary-art', $('#detail-content'));
  const emotion = getEmotionPalette(mode);
  art.style.setProperty('--emotion-a', emotion.a);
  art.style.setProperty('--emotion-b', emotion.b);
  art.style.setProperty('--emotion-c', emotion.c);
  art.dataset.emotion = emotion.name;
  const artNote = $('.diary-art-credit', art);
  const futureNote = entry.futureLetter?.trim() || '';
  artNote.textContent = futureNote ? `${futureNote.slice(0, 100).trim()}${futureNote.length > 100 ? '…' : ''}` : entry.mainTag || analysis.mood || info.label;
  artNote.classList.toggle('has-future-letter', Boolean(futureNote));
  const recordCover = document.createElement('img');
  recordCover.className = 'record-cover';
  recordCover.src = musicLink?.provider === 'youtube' ? `https://img.youtube.com/vi/${musicLink.id}/hqdefault.jpg` : photo;
  recordCover.alt = `Обложка саундтрека ${trackName}`;
  recordCover.onerror = () => { recordCover.src = photo; };
  $('.record-art', $('#detail-content')).prepend(recordCover);
  if (musicLink?.provider === 'spotify') {
    const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${musicLink.id}`)}`;
    fetch(oEmbedUrl).then((response) => response.ok ? response.json() : null).then((metadata) => {
      if (metadata?.thumbnail_url && recordCover.isConnected) recordCover.src = metadata.thumbnail_url;
      if (metadata?.title) {
        $('#track-title').textContent = metadata.title;
      }
    }).catch(() => {});
  }
  Object.entries(paletteVariables(analysis.palette || entry.palette)).forEach(([name, value]) => art.style.setProperty(name, value));
  art.style.setProperty('--beat-duration', `${Math.max(.35, 60 / (analysis.bpm || entry.bpm || 96))}s`);
  const createdDate = document.createElement('span');
  createdDate.className = 'created-date';
  createdDate.textContent = `СОЗДАНО ${formatDate(entry.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('.diary-topline', $('#detail-content')).insertBefore(createdDate, $('.importance-badge', $('#detail-content')));
  stopScene();
  stopScene = startSceneCanvas($('.scene-canvas', art), { mode, weather: analysis.weather || entry.weather || 'still' });
  const capsule = renderCapsule(entry);
  if (capsule) $('.diary-copy', $('#detail-content')).insertBefore(capsule, $('.logic-details', $('#detail-content')));
  $('#play-audio').addEventListener('click', () => toggleAudio(entry, art));
  $('#mute-audio').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const muted = button.getAttribute('aria-pressed') !== 'true';
    audio.setMuted(muted);
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  });
  $('#track-progress').addEventListener('input', (event) => audio.seekProgress(Number(event.currentTarget.value) / 100));
  $('#speak-entry').addEventListener('click', () => { if (!audio.speak(entry.text, mode)) showToast('Браузер не поддерживает русскую озвучку.'); });
  $('#export-entry').addEventListener('click', () => exportEntry(entry));
  $('#delete-entry').addEventListener('click', () => deleteEntry(entry));
}

function renderCapsule(entry) {
  if (!entry.futureLetter?.trim()) return null;
  const capsule = document.createElement('section');
  capsule.className = 'time-capsule';
  capsule.innerHTML = '<div class="capsule-heading"><span class="capsule-seal">✉</span> ПИСЬМО СЕБЕ В БУДУЩЕЕ</div><p class="capsule-copy">Слова, оставленные автором в тот день.</p><button class="open-capsule" type="button">Развернуть письмо ↗</button>';
  const preview = document.createElement('p');
  preview.className = 'future-letter-preview';
  preview.textContent = entry.futureLetter.length > 110 ? `${entry.futureLetter.slice(0, 110).trim()}…` : entry.futureLetter;
  capsule.append(preview);
  const letter = document.createElement('p');
  letter.className = 'future-letter-content';
  letter.hidden = true;
  letter.textContent = entry.futureLetter;
  capsule.append(letter);
  $('.open-capsule', capsule).addEventListener('click', (event) => { letter.hidden = false; preview.hidden = true; event.currentTarget.hidden = true; $('.capsule-copy', capsule).textContent = 'Прочитай это бережно.'; });
  return capsule;
}

async function toggleAudio(entry, art) {
  const button = $('#play-audio');
  if (audio.isPlaying) { audio.stop(); button.textContent = '▶'; $('#music-card').classList.remove('is-playing'); return; }
  try { await audio.play(entry, art, updateTrackProgress); button.textContent = 'Ⅱ'; $('#music-card').classList.add('is-playing'); }
  catch (error) { showToast(`Не удалось запустить локальный звук: ${error.message}`); }
}

function updateTrackProgress(current, duration) {
  const slider = $('#track-progress');
  if (!slider) return;
  slider.value = duration ? String(Math.round(current / duration * 100)) : '0';
  $('#track-time').textContent = `${clock(current)} / ${clock(duration)}`;
}

function clock(seconds) { const value = Number.isFinite(seconds) ? Math.floor(seconds) : 0; return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }

function openEntry(id) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  audio.stop(); stopScene(); renderDetail(entry); $('#detail-dialog').showModal();
  requestAnimationFrame(() => {
    const art = $('.diary-art', $('#detail-content'));
    stopScene = startSceneCanvas($('.scene-canvas', art), { mode: entry.analysis?.mode || entry.mode, weather: entry.analysis?.weather || entry.weather || 'still' });
  });
  toggleAudio(entry, $('.diary-art', $('#detail-content')));
}

async function deleteEntry(entry) {
  if (!window.confirm(`Удалить «${entry.title}» из архива?`)) return;
  audio.stop(); stopScene(); entries = entries.filter((item) => item.id !== entry.id);
  if (database) await idbRequest(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(entry.id));
  else localStorage.setItem('srez-days', JSON.stringify(entries));
  $('#detail-dialog').close(); renderArchive('back'); showToast('Страница удалена из воспоминаний.');
}

function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible'); clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

function scrollToMoods() { $('#mood-picker').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function imageDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

function renderPhotoPreviews() {
  $('#photo-previews').innerHTML = selectedPhotos.map((photo, index) => `<button class="photo-preview ${photo.orientation === 'landscape' ? 'film-thumb' : 'polaroid-thumb'}" type="button" aria-label="Удалить кадр ${index + 1}" data-remove-photo="${index}"><img src="${photo.dataUrl}" alt="Кадр ${index + 1}"><span>×</span></button>`).join('');
  $$('[data-remove-photo]').forEach((button) => button.addEventListener('click', () => { selectedPhotos.splice(Number(button.dataset.removePhoto), 1); renderPhotoPreviews(); }));
}

async function onPhotoSelection(event) {
  for (const file of [...event.target.files]) {
    if (!file.type.startsWith('image/')) { showToast('Выбери файл изображения.'); continue; }
    if (file.size > MAX_FILE_SIZE) { showToast(`${file.name}: размер больше 12 МБ.`); continue; }
    if (selectedPhotos.length >= MAX_PHOTOS) { showToast('Можно добавить не больше четырёх кадров.'); break; }
    const dataUrl = await imageDataUrl(file);
    selectedPhotos.push({ dataUrl, name: file.name, orientation: await photoOrientation(dataUrl) });
  }
  event.target.value = ''; renderPhotoPreviews();
}

function startVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = $('#voice-status');
  if (!Recognition) {
    status.textContent = 'Распознавание речи недоступно в этом браузере. Открой страницу в Chrome или Edge.';
    showToast('Голосовой ввод поддерживается в Chrome и Edge.');
    return;
  }
  if (microphonePermission === 'denied') {
    status.textContent = 'Микрофон ранее заблокирован браузером. Сайт запросит разрешение при записи; если окно не появилось, нажми значок микрофона у адреса.';
  }
  const button = $('#voice-input');
  if (speechRecognition) { speechRecognition.stop(); return; }
  speechRecognition = new Recognition();
  speechRecognition.lang = 'ru-RU'; speechRecognition.continuous = true; speechRecognition.interimResults = true;
  voiceBase = $('#diary-text').value.trim(); voiceFinal = '';
  speechRecognition.onstart = () => {
    button.classList.add('is-recording');
    button.setAttribute('aria-pressed', 'true');
    button.querySelector('span:last-child').textContent = 'Остановить запись';
    status.textContent = 'Слушаю… речь появится в поле сразу после распознавания.';
  };
  speechRecognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) voiceFinal += `${voiceFinal ? ' ' : ''}${transcript}`;
      else interim += `${interim ? ' ' : ''}${transcript}`;
    }
    $('#diary-text').value = [voiceBase, voiceFinal, interim].filter(Boolean).join(' ');
    $('#character-count').textContent = `${$('#diary-text').value.length} / 1600`;
  };
  speechRecognition.onerror = (event) => {
    const messages = {
      'not-allowed': 'Разреши доступ к микрофону в настройках сайта и попробуй снова.',
      'service-not-allowed': 'Браузер заблокировал службу распознавания речи.',
      'audio-capture': 'Не найден микрофон. Проверь устройство ввода.',
      'no-speech': 'Речь не услышана. Нажми микрофон и попробуй ещё раз.',
      network: 'Служба распознавания недоступна без сети.'
    };
    status.textContent = messages[event.error] || 'Не удалось распознать речь. Попробуй ещё раз.';
    showToast(status.textContent);
  };
  speechRecognition.onend = () => {
    speechRecognition = null;
    button.classList.remove('is-recording');
    button.setAttribute('aria-pressed', 'false');
    button.querySelector('span:last-child').textContent = 'Записать голосом';
    if (voiceFinal && !status.textContent.includes('Разреши') && !status.textContent.includes('Не найден')) status.textContent = 'Готово: транскрипция добавлена в запись.';
  };
  try { speechRecognition.start(); }
  catch (error) {
    speechRecognition = null;
    status.textContent = error.name === 'NotAllowedError' ? 'Разреши сайту использовать микрофон.' : 'Не удалось включить микрофон. Проверь разрешения браузера.';
    showToast(status.textContent);
  }
}

function refreshMicrophoneStatus() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = $('#voice-status');
  if (!Recognition) {
    microphonePermission = 'unsupported';
    status.textContent = 'Распознавание речи доступно в Chrome и Edge. В другом браузере можно продолжить вводить текст.';
    return;
  }
  if (!navigator.permissions?.query) return;
  navigator.permissions.query({ name: 'microphone' }).then((permission) => {
    microphonePermission = permission.state;
    if (permission.state === 'denied') status.textContent = 'Микрофон заблокирован. Разреши его в настройках сайта рядом с адресом браузера.';
    else if (permission.state === 'prompt') status.textContent = 'При первой записи браузер попросит доступ к микрофону.';
    else if (permission.state === 'granted' && !speechRecognition) status.textContent = 'Микрофон готов к записи.';
  }).catch(() => {});
}

function showReflection(event) {
  event.preventDefault();
  if (!$('#diary-text').value.trim()) return;
  $('#reflection-view').classList.remove('is-hidden');
  $('#reflection-view').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderMusicLinkPreview() {
  const preview = $('#music-link-preview');
  const musicLink = parseMusicUrl($('#track-url').value.trim());
  preview.replaceChildren();
  preview.hidden = !musicLink;
  if (!musicLink) return;
  const title = $('#track-name').value.trim() || (musicLink.provider === 'youtube' ? 'Видео на YouTube' : 'Трек в Spotify');
  const cover = musicLink.provider === 'youtube' ? `https://img.youtube.com/vi/${musicLink.id}/hqdefault.jpg` : 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#1db954"/><circle cx="120" cy="120" r="72" fill="none" stroke="#fff" stroke-width="12"/><path d="M70 105c45 22 100 22 132 0M76 130c38 18 78 18 118 4M84 154c30 12 62 12 93 2" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/></svg>`);
  preview.innerHTML = `<div class="music-service-card"><img class="music-service-cover" src="${cover}" alt="Обложка трека"><div class="music-service-copy"><strong>${escapeHtml(title)}</strong><span>${musicLink.provider === 'youtube' ? 'YouTube' : 'Spotify'} · ОТКРОЕТСЯ В НОВОЙ ВКЛАДКЕ</span></div><a class="music-service-link" href="${escapeHtml($('#track-url').value.trim())}" target="_blank" rel="noopener noreferrer">Слушать ↗</a></div>`;
}

function updateEventDateLabel() {
  const [year, month, day] = $('#event-date').value.split('-').map(Number);
  if (!year || !month || !day) { $('#event-date-label').textContent = 'ВЫБРАТЬ ДАТУ'; return; }
  $('#event-date-label').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(year, month - 1, day)).replace(/\sг\.$/u, '');
}

async function finishEntry() {
  const text = $('#diary-text').value.trim();
  if (text.length < 8) { showToast('Добавь немного больше текста, чтобы собрать страницу.'); return; }
  const modeChoice = selectedMode;
  const trackParts = $('#track-name').value.split(' — ');
  const musicUrl = safeUrl($('#track-url').value.trim());
  const musicLink = parseMusicUrl(musicUrl || '');
  const music = { title: trackParts[0].trim(), artist: trackParts.slice(1).join(' — ').trim(), url: musicUrl, provider: musicLink?.provider || '', tempo: $('#track-tempo').value, key: $('#track-mode').value };
  const photoUrls = selectedPhotos.map((photo) => photo.dataUrl);
  const analysis = await analyzeDiary({ text, photos: photoUrls, music, modeChoice, canvas: $('#color-canvas') });
  const selectedImportance = Number($('input[name="importance"]:checked').value);
  const fallbackArtwork = DEMO_ENTRIES.find((entry) => entry.mode === analysis.mode).photoUrls[0];
  const entry = normalizeEntry({
    id: `day-${crypto.randomUUID?.() || Date.now()}`, createdAt: new Date().toISOString(), eventDate: $('#event-date').value,
    title: $('#entry-title').value.trim() || analysis.title, text, futureLetter: $('#future-letter').value.trim(), mode: analysis.mode, mood: analysis.mood, reference: analysis.reference,
    analysis, keywords: analysis.keywords, palette: analysis.palette, bpm: analysis.bpm, time: analysis.time, weather: analysis.weather,
    importance: selectedImportance, mainTag: $('#main-tag').value, photoUrls: photoUrls.length ? photoUrls : [fallbackArtwork],
    photoOrientations: selectedPhotos.length ? selectedPhotos.map((photo) => photo.orientation) : ['portrait'], music, audioBlob: selectedAudio
  });
  try {
    await persistEntry(entry);
    entries.push(entry); currentBookPage = 0; renderArchive(); $('#detail-dialog').showModal(); renderDetail(entry);
    await toggleAudio(entry, $('.diary-art', $('#detail-content')));
    $('#entry-form').reset(); selectedPhotos = []; selectedAudio = null; renderPhotoPreviews();
    $('#audio-file-name').textContent = 'Добавить аудиофайл'; $('#character-count').textContent = '0 / 1600'; $('#letter-count').textContent = '0 / 600'; $('#voice-status').textContent = '';
    $('#reflection-view').classList.add('is-hidden'); $('#builder-view').classList.add('is-hidden');
    showToast('Страница собрана и сохранена. Музыка запускается вместе с воспоминанием.');
  } catch { /* Storage helper already informed the user. */ }
}

function canvasCover(dataUrl) {
  return new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = dataUrl; });
}

async function exportEntry(entry) {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1500;
  const context = canvas.getContext('2d'); const analysis = entry.analysis || entry;
  const palette = analysis.palette || entry.palette || ['#d6d2c4', '#71816c', '#d05a3b'];
  context.fillStyle = palette[0]; context.fillRect(0, 0, canvas.width, canvas.height);
  const image = await canvasCover(entry.photoUrls?.[0] || '');
  if (image) { const scale = Math.max(canvas.width / image.width, canvas.height / image.height); const width = image.width * scale; const height = image.height * scale; context.globalAlpha = .8; context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height); context.globalAlpha = 1; }
  const gradient = context.createLinearGradient(0, 680, 0, 1500); gradient.addColorStop(0, 'rgba(20,25,20,0)'); gradient.addColorStop(1, 'rgba(20,25,20,.78)'); context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#f6f2e8'; context.font = '500 22px monospace'; context.fillText(`СРЕЗ  /  ${formatDate(entry.eventDate || entry.createdAt, { day: 'numeric', month: 'long', year: 'numeric' })}`, 82, 1190);
  context.font = '600 58px Georgia'; let line = ''; let y = 1300;
  for (const word of (entry.title || analysis.title).split(' ')) { const next = line ? `${line} ${word}` : word; if (context.measureText(next).width > 1020) { context.fillText(line, 82, y); line = word; y += 72; } else line = next; }
  if (line) context.fillText(line, 82, y);
  context.font = '500 18px monospace'; context.fillStyle = '#d7d1c0'; context.fillText(`${'✳'.repeat(entry.importance)}  ·  ${entry.mainTag || ''}  ·  ${MODE_LABELS[analysis.mode || entry.mode]}`, 84, 1460);
  const link = document.createElement('a'); link.download = `srez-${(entry.title || analysis.title).toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}.png`; link.href = canvas.toDataURL('image/png'); link.click();
}

function moveBook(direction) { currentBookPage += direction; renderArchive(direction < 0 ? 'back' : 'next'); }

function bindControls() {
  const moodGrid = $('#mood-options');
  moodGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.mood-card');
    if (!card) return;
    event.preventDefault();
    selectMood(card.dataset.mode);
  });
  moodGrid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.mood-card');
    if (!card) return;
    event.preventDefault();
    selectMood(card.dataset.mode);
  });
  $('#archive-nav').addEventListener('click', () => $('#memories').scrollIntoView({ behavior: 'smooth' }));
  $('#create-nav').addEventListener('click', scrollToMoods);
  $('#back-to-moods').addEventListener('click', scrollToMoods);
  $('#back-to-builder').addEventListener('click', () => { $('#reflection-view').classList.add('is-hidden'); $('#builder-view').scrollIntoView({ behavior: 'smooth' }); });
  $('#book-prev').addEventListener('click', () => moveBook(-1)); $('#book-next').addEventListener('click', () => moveBook(1));
  $('#entry-form').addEventListener('submit', showReflection); $('#finish-entry').addEventListener('click', finishEntry);
  $('#photo-input').addEventListener('change', onPhotoSelection);
  $('#audio-input').addEventListener('change', (event) => { selectedAudio = event.target.files[0] || null; if (selectedAudio) $('#audio-file-name').textContent = selectedAudio.name; });
  $('#voice-input').addEventListener('click', startVoiceInput);
  window.addEventListener('focus', refreshMicrophoneStatus);
  $('#diary-text').addEventListener('input', (event) => { $('#character-count').textContent = `${event.target.value.length} / 1600`; });
  $('#future-letter').addEventListener('input', (event) => { $('#letter-count').textContent = `${event.target.value.length} / 600`; });
  $('#event-date').addEventListener('change', updateEventDateLabel);
  const linkPreview = document.createElement('div');
  linkPreview.className = 'music-link-preview';
  linkPreview.id = 'music-link-preview';
  linkPreview.hidden = true;
  $('.music-controls').after(linkPreview);
  $('#track-url').addEventListener('input', renderMusicLinkPreview);
  $('#close-dialog').addEventListener('click', () => { audio.stop(); stopScene(); $('#detail-dialog').close(); });
  $('#detail-dialog').addEventListener('click', (event) => { if (event.target === $('#detail-dialog')) { audio.stop(); stopScene(); $('#detail-dialog').close(); } });
  $('#detail-dialog').addEventListener('close', () => { audio.stop(); stopScene(); });
}

async function init() {
  window.openMoodModal = openMoodModal;
  window.openMood = openMoodModal;
  document.addEventListener('click', (event) => {
    const moodCard = event.target.closest('.mood-card');
    if (moodCard) {
      event.preventDefault();
      openMoodModal(moodCard.dataset.mode);
      return;
    }
    const page = event.target.closest('.memory-page');
    if (page) openEntry(page.dataset.entryId);
  });
  bindControls(); renderMoodOptions();
  const today = new Date(); $('#event-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  updateEventDateLabel();
  entries = DEMO_ENTRIES.map(normalizeEntry);
  renderArchive();
  setAmbientMood('impressionism');

  try {
    const loaded = await Promise.race([
      loadEntries(),
      new Promise((resolve) => window.setTimeout(() => resolve(DEMO_ENTRIES.map(normalizeEntry)), 1800))
    ]);
    entries = Array.isArray(loaded)
      ? loaded.map(normalizeEntry).filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
      : DEMO_ENTRIES.map(normalizeEntry);
  } catch (error) {
    console.warn('Хранилище очищено до безопасных демо-данных.', error);
    entries = DEMO_ENTRIES.map(normalizeEntry);
  }
  renderArchive();
  setAmbientMood('impressionism');
}

window.addEventListener('error', (event) => {
  console.warn('Срез: восстановлен после ошибки интерфейса.', event?.message || 'Unknown error');
});

function bootstrap() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

bootstrap();