const MOODS = {
  impressionism: { label: 'Спокойствие и уют', reference: 'Тёплый домашний свет', keys: ['уют','нежн','тепл','свет','дом','обня','спокой','тихо','ностальг','мама','чай','мягк','вспомин','лето','природ'] },
  suprematism: { label: 'Злость и обида', reference: 'Резкий ритм перемены', keys: ['злост','зли','обид','несправ','злоб','ярост','конфликт','крич','напряж','разбил','сердц','думаю о мести','давлен'] },
  minimalism: { label: 'Грусть и расстройство', reference: 'Незаметные детали дождя', keys: ['устал','устала','одинок','груст','дожд','пусто','молч','поздно','выгор','тишин','тяжело','прощ','снег','серый','один','потер','растро','слёз'] },
  zine: { label: 'Радость и восторг', reference: 'Солнечный импульс', keys: ['друз','смех','смешно','вечерин','танц','поезд','путешеств','море','весело','ура','вместе','концерт','приключен','свобод','побед','эйфор','радост','счаст','восторг'] }
};
const FALLBACK_PALETTE = ['#d5a77d', '#758b72', '#d7cdb5'];
function matchMood(text) {
  const normalized = text.toLocaleLowerCase('ru');
  const scores = Object.entries(MOODS).map(([mode, info]) => ({ mode, words: info.keys.filter((word) => normalized.includes(word)) }));
  scores.sort((a, b) => b.words.length - a.words.length);
  return scores[0].words.length ? scores[0] : { mode: 'minimalism', words: [] };
}

function detectTime(text, date = new Date()) {
  const normalized = text.toLocaleLowerCase('ru');
  if (/ноч|полноч|под утро|в три|в 3|в 4/.test(normalized)) return 'night';
  if (/утр|рассвет|проснул|завтрак/.test(normalized)) return 'morning';
  if (/вечер|закат|после работы/.test(normalized)) return 'evening';
  if (/днём|днем|обед|полдень/.test(normalized)) return 'day';
  const hour = date.getHours();
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'day';
  if (hour < 22) return 'evening';
  return 'night';
}

function detectWeather(text) {
  const normalized = text.toLocaleLowerCase('ru');
  if (/дожд|ливен|морос/.test(normalized)) return 'rain';
  if (/снег|метел|снежин/.test(normalized)) return 'snow';
  if (/ветер|ветрен|шторм/.test(normalized)) return 'wind';
  if (/солнц|солнеч|жара|жарко/.test(normalized)) return 'sun';
  return 'still';
}

function createTitle(text) {
  const words = text.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || [];
  const title = words.slice(0, 5);
  if (title.length < 3) title.push(...['этот', 'день'].slice(0, 3 - title.length));
  const phrase = title.join(' ');
  return phrase.charAt(0).toLocaleUpperCase('ru') + phrase.slice(1);
}

function colorToHex(r, g, b) {
  return `#${[r,g,b].map((channel) => Math.round(channel).toString(16).padStart(2,'0')).join('')}`;
}

function paletteFromImage(source, canvas) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const buckets = new Map();
        for (let index = 0; index < data.length; index += 16) {
          if (data[index + 3] < 180) continue;
          const key = `${Math.min(7,data[index]>>5)},${Math.min(7,data[index+1]>>5)},${Math.min(7,data[index+2]>>5)}`;
          const bucket = buckets.get(key) || { count:0, r:0, g:0, b:0 };
          bucket.count++; bucket.r += data[index]; bucket.g += data[index+1]; bucket.b += data[index+2]; buckets.set(key,bucket);
        }
        const colors = [...buckets.values()].sort((a,b) => b.count-a.count).slice(0,3).map((bucket) => colorToHex(bucket.r/bucket.count,bucket.g/bucket.count,bucket.b/bucket.count));
        resolve(colors.length ? [...colors,...FALLBACK_PALETTE].slice(0,3) : FALLBACK_PALETTE);
      } catch { resolve(FALLBACK_PALETTE); }
    };
    image.onerror = () => resolve(FALLBACK_PALETTE);
    image.src = source;
  });
}

export async function analyzeDiary({ text, photos = [], music = {}, modeChoice = 'auto', canvas }) {
  const match = matchMood(text);
  const mode = modeChoice === 'auto' ? match.mode : modeChoice;
  const time = detectTime(text);
  const weather = detectWeather(text);
  const palette = photos.length ? await paletteFromImage(photos[0], canvas) : FALLBACK_PALETTE;
  const bpm = { slow:64, medium:96, fast:128 }[music.tempo || 'medium'] || 96;
  return { mode, mood: MOODS[mode].label, reference: MOODS[mode].reference, keywords: match.words.slice(0,5), time, weather, palette, bpm, title: createTitle(text) };
}

export function getModeInfo(mode) { return MOODS[mode] || MOODS.minimalism; }
export function sortMemoryEntries(entries) {
  return [...entries].sort((a, b) => Number(b.importance) - Number(a.importance));
}
export function getEmotionPalette(mode) {
  const palettes = {
    zine: { name: 'joy', a: '#ffb62e', b: '#f04492', c: '#ffec82' },
    minimalism: { name: 'sadness', a: '#3a7ca5', b: '#175676', c: '#8ccbe4' },
    suprematism: { name: 'alarm', a: '#ef3d59', b: '#7d2ae8', c: '#ff7868' },
    impressionism: { name: 'calm', a: '#168f72', b: '#58bca2', c: '#d8efb7' }
  };
  return palettes[mode] || palettes.impressionism;
}
export function paletteVariables(palette = FALLBACK_PALETTE) { return { '--user-accent-1':palette[0], '--user-accent-2':palette[1], '--user-accent-3':palette[2] }; }
export function createMoodArtwork(mode) {
  const scenes = {
    zine: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#ffb21c"/><stop offset=".5" stop-color="#ff3b91"/><stop offset="1" stop-color="#3158dd"/></linearGradient></defs><rect width="720" height="480" fill="url(#g)"/><circle cx="560" cy="95" r="64" fill="#fff2ad" opacity=".95"/><g fill="none" stroke="#fff" stroke-width="12" opacity=".88"><circle cx="560" cy="95" r="105"/><circle cx="560" cy="95" r="145"/></g><path d="M0 390Q170 300 330 390T720 340V480H0Z" fill="#123f8d" opacity=".72"/><g fill="#fff"><circle cx="150" cy="130" r="8"/><circle cx="210" cy="82" r="5"/><circle cx="315" cy="130" r="7"/><circle cx="410" cy="70" r="6"/></g></svg>`,
    minimalism: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#9ec4df"/><stop offset="1" stop-color="#283b65"/></linearGradient></defs><rect width="720" height="480" fill="url(#g)"/><path d="M0 330Q180 290 360 335T720 322V480H0Z" fill="#18243f" opacity=".72"/><g stroke="#d9edf7" stroke-width="5" opacity=".7"><path d="M90 30l-38 150"/><path d="M210 10l-38 175"/><path d="M390 20l-44 190"/><path d="M540 0l-48 180"/><path d="M650 28l-35 160"/></g><ellipse cx="360" cy="300" rx="145" ry="28" fill="#b8d4df" opacity=".25"/></svg>`,
    suprematism: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#25114d"/><stop offset=".55" stop-color="#b42632"/><stop offset="1" stop-color="#ff7a18"/></linearGradient></defs><rect width="720" height="480" fill="url(#g)"/><path d="M40 410L350 80l120 44L165 438z" fill="#ffcf3a"/><circle cx="520" cy="250" r="105" fill="#f23a20" opacity=".9"/><path d="M0 230h720M280 0v480" stroke="#160d2d" stroke-width="18" opacity=".72"/><g fill="#fff4bb"><circle cx="520" cy="250" r="8"/><circle cx="550" cy="210" r="5"/><circle cx="470" cy="190" r="6"/></g></svg>`,
    impressionism: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480"><defs><radialGradient id="g"><stop stop-color="#fff1ae"/><stop offset=".45" stop-color="#77a6a0"/><stop offset="1" stop-color="#2d4d73"/></radialGradient></defs><rect width="720" height="480" fill="url(#g)"/><g fill="#f7df8b" opacity=".58"><circle cx="175" cy="150" r="100"/><circle cx="540" cy="310" r="150"/></g><path d="M0 350Q180 300 360 352T720 326V480H0Z" fill="#305a64" opacity=".7"/><path d="M95 420Q160 340 225 420M500 410Q565 330 630 410" fill="none" stroke="#d9edcf" stroke-width="10" opacity=".75"/></svg>`
  };
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(scenes[mode] || scenes.impressionism)}`;
}
export function photoOrientation(source) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth >= image.naturalHeight ? 'landscape' : 'portrait');
    image.onerror = () => resolve('portrait');
    image.src = source;
  });
}

export function parseMusicUrl(value = '') {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com') {
      const videoId = host === 'youtu.be'
        ? url.pathname.split('/').filter(Boolean)[0]
        : url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts)\/([^/?]+)/)?.[1];
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
      return { provider: 'youtube', id: videoId };
    }
    if (host === 'open.spotify.com') {
      const [, type, id] = url.pathname.split('/');
      if (type !== 'track' || !id || !/^[a-zA-Z0-9]+$/.test(id)) return null;
      return { provider: 'spotify', id };
    }
  } catch { return null; }
  return null;
}

export function createWeatherMarkup(weather) {
  const count = weather === 'rain' ? 13 : weather === 'snow' ? 9 : weather === 'wind' ? 6 : weather === 'sun' ? 5 : 0;
  return Array.from({length:count}, (_, index) => `<i class="weather-particle particle-${weather}" style="--particle:${index};--left:${8+(index*37)%88}%;--delay:${(index*.37)%3}s"></i>`).join('');
}

export function startSceneCanvas(canvas, { mode, weather }) {
  const context = canvas.getContext('2d');
  if (!context) return () => {};

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drops = Array.from({ length: 58 }, () => ({ x: Math.random(), y: Math.random(), length: 9 + Math.random() * 18, speed: .18 + Math.random() * .5, drift: -.035 - Math.random() * .04 }));
  const shapes = Array.from({ length: 8 }, (_, index) => ({ x: .12 + Math.random() * .76, y: .12 + Math.random() * .76, size: 12 + Math.random() * 45, phase: index * .8, color: index % 2 ? '#f0d7a2' : '#d75d40' }));
  const ripples = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastTime = 0;
  let pointer = { x: -1, y: -1 };

  function resize() {
    let bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      bounds = canvas.parentElement?.getBoundingClientRect() || bounds;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Number.isFinite(bounds.width) ? bounds.width : 1;
    height = Number.isFinite(bounds.height) ? bounds.height : 1;
    if (width < 2) width = 1;
    if (height < 2) height = 1;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (reducedMotion && width > 1 && height > 1) draw(lastTime);
  }

  function addRipple(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (weather === 'rain') ripples.push({ ...pointer, radius: 2, alpha: .58 });
    if (reducedMotion) draw(lastTime);
  }

  function draw(time) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
      if (!reducedMotion) frame = requestAnimationFrame(draw);
      return;
    }
    const elapsed = Math.min((time - (lastTime || time)) / 1000, .05);
    lastTime = time;
    context.clearRect(0, 0, width, height);

    if (weather === 'rain') {
      context.lineWidth = 1;
      for (const drop of drops) {
        const x = drop.x * width;
        const y = drop.y * height;
        const nearPointer = pointer.x >= 0 && Math.hypot(x - pointer.x, y - pointer.y) < 70;
        context.strokeStyle = nearPointer ? 'rgba(255,244,218,.88)' : 'rgba(223,237,235,.48)';
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + drop.drift * drop.length, y + drop.length);
        context.stroke();
        if (!reducedMotion) {
          drop.x += drop.drift * elapsed;
          drop.y += drop.speed * elapsed;
          if (drop.y > 1.05) { drop.y = -.05; drop.x = Math.random(); }
        }
      }
      for (const ripple of ripples) {
        context.beginPath();
        context.ellipse(ripple.x, ripple.y, ripple.radius * 1.6, ripple.radius * .62, 0, 0, Math.PI * 2);
        context.strokeStyle = `rgba(246,239,215,${ripple.alpha})`;
        context.lineWidth = 1;
        context.stroke();
        ripple.radius += 38 * elapsed;
        ripple.alpha -= .42 * elapsed;
      }
      for (let index = ripples.length - 1; index >= 0; index -= 1) if (ripples[index].alpha <= 0) ripples.splice(index, 1);
    } else if (weather === 'ember') {
      shapes.forEach((shape, index) => {
        const y = ((shape.y + time / 3300 + index * .03) % 1.15) * height;
        const x = shape.x * width + Math.sin(time / 600 + index) * 12;
        const glow = context.createRadialGradient(x, y, 0, x, y, shape.size);
        glow.addColorStop(0, 'rgba(255,201,76,.72)');
        glow.addColorStop(.45, 'rgba(255,72,24,.28)');
        glow.addColorStop(1, 'rgba(255,72,24,0)');
        context.fillStyle = glow;
        context.fillRect(x - shape.size, y - shape.size, shape.size * 2, shape.size * 2);
      });
    } else if (mode === 'suprematism') {
      shapes.forEach((shape, index) => {
        const flicker = .12 + (Math.sin(time / 330 + shape.phase) + 1) * .17;
        context.globalAlpha = flicker;
        context.fillStyle = shape.color;
        const x = shape.x * width;
        const y = shape.y * height;
        if (index % 3 === 0) {
          context.beginPath();
          context.arc(x, y, shape.size * (.75 + flicker), 0, Math.PI * 2);
          context.fill();
        } else {
          context.save();
          context.translate(x, y);
          context.rotate(shape.phase + time / 9000);
          context.fillRect(-shape.size / 2, -2, shape.size, 4);
          context.restore();
        }
      });
      context.globalAlpha = 1;
    } else if (weather === 'sun') {
      for (let index = 0; index < 14; index += 1) {
        const x = ((index * 67 + time / 45) % (width + 160)) - 80;
        const y = (index * 41 + Math.sin(time / 900 + index) * 18) % height;
        const ray = context.createLinearGradient(x - 90, y - 90, x + 90, y + 90);
        ray.addColorStop(0, 'rgba(255,255,220,0)');
        ray.addColorStop(.5, 'rgba(255,229,126,.28)');
        ray.addColorStop(1, 'rgba(255,255,220,0)');
        context.fillStyle = ray;
        context.save();
        context.translate(x, y);
        context.rotate(index * .27);
        context.fillRect(-150, -5, 300, 10);
        context.restore();
      }
    } else if (mode === 'impressionism') {
      shapes.forEach((shape, index) => {
        const x = shape.x * width + Math.sin(time / 2200 + shape.phase) * 12;
        const y = shape.y * height + Math.cos(time / 2700 + shape.phase) * 10;
        const radius = shape.size * (1.2 + Math.sin(time / 1800 + index) * .18);
        const glow = context.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, 'rgba(255,238,188,.18)');
        glow.addColorStop(1, 'rgba(255,238,188,0)');
        context.fillStyle = glow;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      });
    }

    if (!reducedMotion) frame = requestAnimationFrame(draw);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  canvas.addEventListener('pointermove', addRipple);
  canvas.addEventListener('pointerdown', addRipple);
  resize();
  draw(0);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener('pointermove', addRipple);
    canvas.removeEventListener('pointerdown', addRipple);
  };
}
