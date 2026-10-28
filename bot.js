require('dotenv').config();
const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 600000 });
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const INTERVAL_MIN = Number(process.env.POST_INTERVAL_MIN || 60);

const db = new Database('bot.db');
db.exec(`
CREATE TABLE IF NOT EXISTS chats(
  id INTEGER PRIMARY KEY, title TEXT, type TEXT, description TEXT,
  topic TEXT, lang TEXT DEFAULT 'uz', is_football INTEGER DEFAULT 0,
  style TEXT, active INTEGER DEFAULT 1, post_count INTEGER DEFAULT 0, invite TEXT
);
CREATE TABLE IF NOT EXISTS seen(
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, text TEXT,
  mine INTEGER DEFAULT 0, ts INTEGER DEFAULT (strftime('%s','now'))
);
`);

// ---------- Gemini ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(prompt, { search = false } = {}) {
  const models = [MODEL, process.env.GEMINI_MODEL_2].filter(Boolean);

  const call = async (model, p, withSearch) => {
    const body = { contents: [{ parts: [{ text: p }] }] };
    if (withSearch) body.tools = [{ google_search: {} }];
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(body),
      }
    );
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
  };

  const retryable = (e) => /"code":\s*(500|503)|UNAVAILABLE/.test(e.message);

  const tryAll = async (p, withSearch) => {
    let lastErr;
    for (const model of models) {
      for (let a = 0; a < 3; a++) {
        try {
          return await call(model, p, withSearch);
        } catch (e) {
          lastErr = e;
          if (!retryable(e)) break;
          console.error(`Gemini ${model} band (${a + 1}/3), ${8 * (a + 1)} soniya kutaman...`);
          await sleep(8000 * (a + 1));
        }
      }
    }
    throw lastErr;
  };

  try {
    return await tryAll(prompt, search);
  } catch (e) {
    if (!search || /429|RESOURCE_EXHAUSTED/.test(e.message)) throw e;
    console.error('Qidiruv ishlamadi, qidiruvsiz urinaman:', e.message.slice(0, 120));
    return await tryAll(
      prompt + "\n\nESLATMA: internet qidiruvi hozir yo'q. Yangi natija, transfer yoki yangilikni o'ylab topma. Faqat aniq bilgan faktlar, rekordlar, tarix, taktika yoki qiziqarli ma'lumot yoz.",
      false
    );
  }
}

function extractJson(t) {
  const m = t.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ---------- Kanalni tahlil qilish ----------
async function analyze(chatId) {
  const info = await bot.telegram.getChat(chatId);
  const texts = db
    .prepare('SELECT text FROM seen WHERE chat_id=? AND mine=0 ORDER BY id DESC LIMIT 30')
    .all(chatId)
    .map((r) => r.text.slice(0, 300));

  const prompt = `Telegram kanalini tahlil qil.
Nom: ${info.title}
Username: ${info.username || '-'}
Tavsif: ${info.description || '-'}
Oxirgi postlar:
${texts.join('\n---\n') || "(yo'q)"}

Faqat JSON qaytar (boshqa matn yo'q):
{"topic":"qisqa mavzu","is_football":true/false,"lang":"uz|ru|en","style":"post uslubi haqida 1-2 gap","audience":"auditoriya"}`;

  let a = null;
  try {
    a = extractJson(await gemini(prompt));
  } catch (e) {
    console.error('analyze error', e.message);
  }
  if (!a) a = { topic: info.title, is_football: /futbol|football|футбол/i.test(`${info.title} ${info.description}`), lang: 'uz', style: 'qiziqarli, qisqa' };

  let invite = null;
  try {
    invite = await bot.telegram.exportChatInviteLink(chatId);
  } catch {}

  db.prepare(
    `UPDATE chats SET title=?, description=?, topic=?, lang=?, is_football=?, style=?, invite=? WHERE id=?`
  ).run(info.title, info.description || '', a.topic, a.lang || 'uz', a.is_football ? 1 : 0, a.style || '', invite, chatId);
  return a;
}

// ---------- Post yaratish ----------
const LANG = { uz: "o'zbek tilida (lotin)", ru: 'rus tilida', en: 'ingliz tilida' };

db.exec(`CREATE TABLE IF NOT EXISTS used(link TEXT PRIMARY KEY, ts INTEGER DEFAULT (strftime('%s','now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS used_photos(query TEXT PRIMARY KEY, ts INTEGER DEFAULT (strftime('%s','now')))`);

const UA = 'kanal-bot/1.0 (Telegram channel assistant)';
const FEEDS = (
  process.env.NEWS_FEEDS ||
  'https://www.sports.ru/rss/topnews.xml,https://feeds.bbci.co.uk/sport/football/rss.xml,https://www.theguardian.com/football/rss'
).split(',').map((s) => s.trim()).filter(Boolean);

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

async function fetchFeed(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  const xml = await r.text();
  return xml.split(/<item[\s>]/i).slice(1).map((b) => ({
    title: tag(b, 'title'),
    desc: tag(b, 'description').slice(0, 300),
    link: tag(b, 'link'),
  })).filter((i) => i.title && i.link);
}

async function fetchNews() {
  const all = [];
  for (const u of FEEDS) {
    try {
      all.push(...(await fetchFeed(u)).slice(0, 15));
    } catch (e) {
      console.error('RSS xato:', e.message);
    }
  }
  const used = new Set(db.prepare('SELECT link FROM used').all().map((r) => r.link));
  return all.filter((i) => !used.has(i.link));
}

let commonsBlockedUntil = 0;

async function commonsPhoto(q) {
  if (!q || typeof q !== 'string') return null;
  if (Date.now() < commonsBlockedUntil) return null;
  let query = q.trim().replace(/["']/g, '').slice(0, 60);
  if (!/football|soccer|fc |club/i.test(query)) query += ' football';

  const getJson = async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const ct = r.headers.get('content-type') || '';
    if (r.status === 429 || !ct.includes('json')) {
      commonsBlockedUntil = Date.now() + 10 * 60 * 1000;
      throw new Error('Commons limit, 10 daqiqa kutiladi');
    }
    return r.json();
  };

  try {
    const j = await getJson(
      'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=8' +
      '&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1280&format=json&gsrsearch=' +
      encodeURIComponent(query + ' filetype:bitmap')
    );
    const pages = Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii || !/jpeg|png/i.test(ii.mime || '') || (ii.width || 0) < 500) continue;
      const url = ii.thumburl || ii.url;
      if (!url) continue;
      if (db.prepare('SELECT 1 FROM used_photos WHERE query=?').get(url)) continue;
      const ir = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!ir.ok) {
        if (ir.status === 429) commonsBlockedUntil = Date.now() + 10 * 60 * 1000;
        continue;
      }
      const buf = Buffer.from(await ir.arrayBuffer());
      if (buf.length < 8000 || buf.length > 9000000) continue;
      db.prepare('INSERT OR IGNORE INTO used_photos(query) VALUES(?)').run(url);
      return buf;
    }
    return null;
  } catch (e) {
    console.error('rasm xato:', e.message.slice(0, 100));
    return null;
  }
}

async function newsPost(c, lang) {
  const items = await fetchNews();
  if (!items.length) return null;
  const pick = items.sort(() => Math.random() - 0.5).slice(0, 20);
  const list = pick.map((it, i) => `${i}. ${it.title} — ${it.desc}`).join('\n');
  const raw = await gemini(`Sen futbol Telegram kanalining adminisan. Quyida yangi sarlavhalar ro'yxati.
Faqat FUTBOLGA oid bitta eng qiziqarli yangilikni tanla (agar futbolga oid yo'q bo'lsa index -1).
O'sha yangilik asosida ${lang} o'z so'zlaring bilan qisqa post yoz (400-800 belgi, 1-3 emoji, 1-2 abzats, oxirida albatta 2-3 ta hashtag (# bilan, masalan #Футбол #Трансфер)).
Faqat ro'yxatdagi ma'lumotga tayan, yangi fakt o'ylab topma. Markdown ishlatma. Uslub: ${c.style}.
Ro'yxat:
${list}

Faqat JSON qaytar: {"index":0,"text":"...","photo_query":"inglizcha aniq qidiruv: asosiy futbolchi + jamoa nomi + football, masalan Bruno Fernandes Manchester United football, masalan Harry Kane Bayern Munich football yoki Chelsea FC football. Umumiy so'zlar (football, soccer, stadium) ishlatma"}`);
  const j = extractJson(raw);
  if (!j || j.index < 0 || !pick[j.index] || !j.text) return null;
  return { text: j.text, photoQuery: j.photo_query, link: pick[j.index].link };
}

db.exec(`CREATE TABLE IF NOT EXISTS used(link TEXT PRIMARY KEY, ts INTEGER DEFAULT (strftime('%s','now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS used_photos(query TEXT PRIMARY KEY, ts INTEGER DEFAULT (strftime('%s','now')))`);

async function sendVideo(c) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dec = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const ids = (process.env.VIDEO_CHANNELS || 'UCG5qGWdu8nIRZqJ_GgDwQ-w,UCTv-XvfzLX3i4IGWAm4sbmA,UCWV3obpZVGgJ3j9FVhEjF2Q,UC14UlmYlSNiQCBe9Eookf_A')
    .split(',').map((x) => x.trim()).filter(Boolean).sort(() => Math.random() - 0.5);

  for (const id of ids) {
    try {
      const r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const entries = xml.split('<entry>').slice(1, 8);
      for (const e of entries) {
        const vid = (e.match(/<yt:videoId>([^<]+)/) || [])[1];
        const title = dec((e.match(/<title>([^<]+)/) || [])[1] || '');
        if (!vid) continue;
        const link = 'https://www.youtube.com/watch?v=' + vid;
        if (db.prepare('SELECT 1 FROM used WHERE link=?').get(link)) continue;

        let text = '🎬 ' + esc(title) + '\n\n' + link;
        if (c.invite) text += `\n\n📣 <a href="${c.invite}">${esc(c.title)}</a>`;
        await bot.telegram.sendMessage(c.id, text, { parse_mode: 'HTML' });

        db.prepare('INSERT OR IGNORE INTO used(link) VALUES(?)').run(link);
        db.prepare('INSERT INTO seen(chat_id,text,mine) VALUES(?,?,1)').run(c.id, 'VIDEO: ' + title);
        db.prepare('UPDATE chats SET post_count=post_count+1 WHERE id=?').run(c.id);
        return true;
      }
    } catch (e) {
      console.error('video xato:', e.message.slice(0, 80));
    }
  }
  return false;
}

async function makeAndSend(c) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const last = db.prepare('SELECT text FROM seen WHERE chat_id=? AND mine=1 ORDER BY id DESC LIMIT 6').all(c.id).map((r) => r.text);
  const avoid = last.length ? `Oldingi postlarni takrorlama: ${last.map((t) => t.slice(0, 60)).join(' | ')}` : '';
  const lang = LANG[c.lang] || LANG.ru;
  const n = c.post_count || 0;
  if (c.is_football && n % 4 === 3 && (!process.env.VIDEO_CHAT_ID || String(c.id) === process.env.VIDEO_CHAT_ID)) {
    try { if (await sendVideo(c)) return; } catch (e) { console.error('video xato:', e.message.slice(0, 80)); }
  }

  if (n > 0 && n % 5 === 0) {
    try {
      const q = await gemini(`Futbol bo'yicha qiziqarli so'rovnoma savoli yoz. Faqat ${lang}. Savol + 3-4 variant. Faqat JSON: {"question":"...","options":["A","B","C"]}`);
      const j = extractJson(q);
      if (j?.question && Array.isArray(j.options) && j.options.length >= 2) {
        await bot.telegram.sendPoll(c.id, j.question.slice(0, 300), j.options.slice(0, 10).map((o) => String(o).slice(0, 100)), { is_anonymous: true });
        db.prepare('UPDATE chats SET post_count=post_count+1 WHERE id=?').run(c.id);
        return;
      }
    } catch (e) {
      console.error('poll xato', e.message.slice(0, 100));
    }
  }

  let text = null, photoQ = null, link = null;

  // 1) RSS yangilik (eng yangi, haqiqiy)
  try {
    const items = await fetchNews();
    if (items && items.length) {
      const pick = items.sort(() => Math.random() - 0.5).slice(0, 15);
      const list = pick.map((it, i) => `${i}. ${it.title} — ${it.desc || ''}`).join('\n');
      const raw = await gemini(`Sen futbol Telegram kanalining adminisan. Quyida eng yangi sarlavhalar.
Faqat FUTBOLGA oid eng qiziqarli bitta yangilikni tanla. Futbolga oid yo'q bo'lsa INDEX: -1 yoz.
Shu yangilik asosida faqat ${lang} o'z so'zlaring bilan post yoz (450-750 belgi, 1-3 emoji, hashtag va Markdown yo'q). Ro'yxatda yo'q fakt qo'shma.
Uslub: ${c.style || 'qiziqarli va qisqa'}. ${avoid}

Ro'yxat:
${list}

Javobni AYNAN shu formatda yoz:
INDEX: <raqam>
TEXT: <post matni>
FOTO: <inglizcha 2-4 so'z, postdagi asosiy erkak futbolchi yoki klub nomi>`);
      const im = raw.match(/INDEX:\s*(-?\d+)/i);
      const tm = raw.match(/TEXT:\s*([\s\S]*?)\s*FOTO:/i);
      const fm = raw.match(/FOTO:\s*(.+)/i);
      const idx = im ? parseInt(im[1], 10) : -1;
      if (idx >= 0 && pick[idx] && tm && tm[1].trim().length > 50) {
        text = tm[1].trim();
        link = pick[idx].link;
        photoQ = fm ? fm[1].replace(/["'.]/g, '').trim().slice(0, 45) : null;
      }
    }
  } catch (e) {
    console.error('yangilik xato:', e.message.slice(0, 150));
  }

  // 2) Zaxira: Gemini + Google qidiruv
  if (!text) {
    const prompt = `Sen futbol kanalining adminisan. Bugungi eng yangi futbol xabarini yoz: so'nggi o'yin natijasi, transfer yoki jarohat. Eski tarix yozma, hech narsani o'ylab topma.
Til: faqat ${lang}. 450-700 belgi, 1-3 emoji, hashtag va Markdown yo'q. ${avoid}
Eng oxirgi qatorda: FOTO: <inglizcha 2-4 so'z, asosiy erkak futbolchi yoki klub nomi>`;
    let raw = await gemini(prompt, { search: true }).catch(() => null);
    if (!raw) raw = await gemini(prompt, { search: false }).catch(() => null);
    if (!raw) return;
    const m = raw.match(/\n?\s*FOTO:\s*(.+)\s*$/i);
    text = m ? raw.slice(0, m.index).trim() : raw.trim();
    photoQ = m ? m[1].replace(/["'.]/g, '').trim().slice(0, 45) : null;
  }
  if (!text) return;

  // ---- RASM: har doim topishga urinamiz ----
  let photo = null;

  // a) maqolaning o'z rasmi
  if (link) {
    try {
      const u = new URL(link);
      if (!/news\.google/i.test(u.hostname)) {
        const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
        const html = (await r.text()).slice(0, 200000);
        const mm =
          html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
        if (mm) {
          const imgUrl = new URL(mm[1].replace(/&amp;/g, '&'), r.url || link).href;
          const ir = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
          const ct = ir.headers.get('content-type') || '';
          if (ir.ok && /image\/(jpeg|png|webp)/i.test(ct)) {
            const buf = Buffer.from(await ir.arrayBuffer());
            if (buf.length > 8000 && buf.length < 9000000) photo = buf;
          }
        }
      }
    } catch (e) {
      console.error('og:image xato:', e.message.slice(0, 80));
    }
  }

  // b) Commons: futbolchi/klub
  if (!photo && photoQ && photoQ.length > 3) {
    photo = await commonsPhoto(photoQ).catch(() => null);
  }

  // c) umumiy futbol rasmlari
  if (!photo) {
    const generic = ['football match', 'football stadium', 'football players', 'soccer ball', 'football fans', 'football goal', 'football training'].sort(() => Math.random() - 0.5);
    for (const g of generic.slice(0, 2)) {
      photo = await commonsPhoto(g).catch(() => null);
      if (photo) break;
    }
  }

  text = esc(text.slice(0, 3500));
  if (c.invite) text += `\n\n📣 <a href="${c.invite}">${esc(c.title)}</a>`;
  const opts = { disable_web_page_preview: true, parse_mode: 'HTML' };

  if (photo) {
    try {
      if (text.length <= 1024) {
        await bot.telegram.sendPhoto(c.id, { source: photo }, { caption: text, parse_mode: 'HTML' });
      } else {
        await bot.telegram.sendPhoto(c.id, { source: photo });
        await bot.telegram.sendMessage(c.id, text, opts);
      }
    } catch (e) {
      console.error('rasm yuborish xato:', e.message.slice(0, 80));
      await bot.telegram.sendMessage(c.id, text, opts);
    }
  } else {
    await bot.telegram.sendMessage(c.id, text, opts);
  }

  if (link) db.prepare('INSERT OR IGNORE INTO used(link) VALUES(?)').run(link);
  db.prepare('INSERT INTO seen(chat_id,text,mine) VALUES(?,?,1)').run(c.id, text);
  db.prepare('UPDATE chats SET post_count=post_count+1 WHERE id=?').run(c.id);
}

async function sendBatch(c, n = 3) {
  for (let i = 0; i < n; i++) {
    const fresh = db.prepare('SELECT * FROM chats WHERE id=?').get(c.id);
    await makeAndSend(fresh);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function tick() {
  const chats = db.prepare('SELECT * FROM chats WHERE active=1').all();
  for (const c of chats) {
    try {
      await makeAndSend(c);
    } catch (e) {
      console.error('post error', c.id, e.message);
      if (/kicked|not a member|chat not found|forbidden/i.test(e.message)) {
        db.prepare('UPDATE chats SET active=0 WHERE id=?').run(c.id);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------- Botga qo'shilish / chiqarilish ----------
bot.on('my_chat_member', async (ctx) => {
  const u = ctx.myChatMember;
  const chat = u.chat;
  if (!['channel', 'group', 'supergroup'].includes(chat.type)) return;
  const st = u.new_chat_member.status;

  if (st === 'administrator' || st === 'member') {
    db.prepare(
      `INSERT INTO chats(id,title,type) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET active=1, title=excluded.title`
    ).run(chat.id, chat.title || '', chat.type);
    const a = await analyze(chat.id);
    console.log('Yangi chat:', chat.title, a);
    if (ADMIN_ID) {
      bot.telegram
        .sendMessage(ADMIN_ID, `✅ Ulandi: ${chat.title}\nMavzu: ${a.topic}\nFutbol: ${a.is_football ? 'ha' : "yo'q"}\nTil: ${a.lang}`)
        .catch(() => {});
    }
    if (st === 'administrator') sendBatch(db.prepare('SELECT * FROM chats WHERE id=?').get(chat.id), 3).catch(console.error);
  } else {
    db.prepare('UPDATE chats SET active=0 WHERE id=?').run(chat.id);
  }
});

bot.on(['channel_post', 'message'], (ctx, next) => {
  const m = ctx.channelPost || ctx.message;
  const text = m?.text || m?.caption;
  if (text && ctx.chat.type !== 'private') {
    db.prepare('INSERT INTO seen(chat_id,text) VALUES(?,?)').run(ctx.chat.id, text);
  }
  return next();
});

// ---------- Buyruqlar (faqat admin, private) ----------
bot.start((ctx) =>
  ctx.reply("Salom! Meni kanalingizga yoki guruhingizga admin qilib qo'shing, qolganini o'zim bajaraman.")
);
const isAdmin = (ctx) => ctx.chat.type === 'private' && (!ADMIN_ID || ctx.from.id === ADMIN_ID);

bot.command('now', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  const c = db.prepare('SELECT * FROM chats WHERE id=?').get(id);
  if (!c) return ctx.reply('Ishlatish: /now <chat_id>');
  const cnt = Math.min(Number(ctx.message.text.split(' ')[2]) || 1, 10);
  await sendBatch(c, cnt).catch((e) => ctx.reply('Xato: ' + e.message.slice(0, 300)));
});

bot.command('interval', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  if (parts[1]) {
    const m = parseInt(parts[1], 10);
    if (m >= 10 && m <= 1440) {
      process.env.POST_INTERVAL_MIN = String(m);
      // .env ni ham yangilash
      const fs = require('fs');
      let env = fs.readFileSync('.env', 'utf8');
      if (/^POST_INTERVAL_MIN=/m.test(env)) {
        env = env.replace(/^POST_INTERVAL_MIN=.*/m, 'POST_INTERVAL_MIN=' + m);
      } else {
        env += '\nPOST_INTERVAL_MIN=' + m + '\n';
      }
      fs.writeFileSync('.env', env);
      await ctx.reply("Interval " + m + " daqiqaga o'zgardi. Qayta ishga tushirish: pm2 restart kanal-bot --update-env");
    } else {
      await ctx.reply('10 dan 1440 gacha daqiqa kiriting');
    }
  } else {
    const cur = process.env.POST_INTERVAL_MIN || '180';
    await ctx.reply('Hozirgi interval: ' + cur + ' daqiqa (~' + Math.round(60 / (cur / 60) * 10) / 10 + ' post/soat har bir kanalga)');
  }
});

bot.command('status', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const chats = db.prepare('SELECT id, title, active, post_count, lang FROM chats').all();
  const lines = chats.map(c =>
    (c.active ? '🟢' : '🔴') + ' ' + (c.title || c.id) + ' | post: ' + c.post_count + ' | ' + (c.lang || '?')
  );
  const interval = process.env.POST_INTERVAL_MIN || '180';
  await ctx.reply(
    'Bot ishlayapti\nInterval: ' + interval + ' min\nKanallar: ' + chats.length + '\n\n' +
    (lines.join('\n') || "yo'q")
  );
});

bot.command('reanalyze', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  const a = await analyze(id).catch((e) => ({ topic: 'xato: ' + e.message }));
  ctx.reply(JSON.stringify(a, null, 2));
});

bot.command('all', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const n = Math.min(Number(ctx.message.text.split(' ')[1]) || 3, 10);
  const rows = db.prepare('SELECT * FROM chats WHERE active=1').all();
  await ctx.reply(rows.length + ' ta chatga ' + n + ' tadan post yuboraman...');
  for (const c of rows) {
    await sendBatch(c, n).catch((e) => ctx.reply('Xato (' + c.title + '): ' + e.message.slice(0, 200)));
  }
  ctx.reply('Tayyor ✅');
});

const cmdArgs = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);
const chatById = (id) => db.prepare('SELECT * FROM chats WHERE id=?').get(Number(id));
const restArgs = (ctx, skip) => ctx.message.text.trim().split(/\s+/).slice(1 + skip).join(' ');

bot.command('help', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
`BUYRUQLAR

Postlar:
/now <id> [n] - n ta post yuborish
/all [n] - hamma kanalga n tadan post
/poll <id> - so'rovnoma yuborish
/video <id> - video yuborish
/say <id> <matn> - o'z matningizni yuborish
/broadcast <matn> - hamma kanalga matn

Kanallar:
/chats - kanallar ro'yxati
/info <id> - kanal haqida
/pause <id> - to'xtatish
/resume <id> - davom ettirish
/pauseall - hammasini to'xtatish
/resumeall - hammasini yoqish
/delete <id> - kanalni o'chirish

Sozlamalar:
/setlang <id> <uz|ru|en>
/setstyle <id> <uslub>
/settopic <id> <mavzu>
/football <id> <on|off>
/interval [min]
/reanalyze <id>

Tizim:
/status - bot holati
/stats - statistika
/last <id> [n] - oxirgi postlar
/clear <id> - post tarixini tozalash
/clearphotos - ishlatilgan rasmlarni tozalash
/ping - bot va Gemini tekshiruvi
/restart - botni qayta ishga tushirish`
  );
});

bot.command('pause', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /pause <chat_id>');
  db.prepare('UPDATE chats SET active=0 WHERE id=?').run(c.id);
  ctx.reply('To\'xtatildi: ' + c.title);
});

bot.command('resume', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /resume <chat_id>');
  db.prepare('UPDATE chats SET active=1 WHERE id=?').run(c.id);
  ctx.reply('Yoqildi: ' + c.title);
});

bot.command('pauseall', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = db.prepare('UPDATE chats SET active=0').run();
  ctx.reply('To\'xtatildi: ' + r.changes + ' ta kanal');
});

bot.command('resumeall', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = db.prepare('UPDATE chats SET active=1').run();
  ctx.reply('Yoqildi: ' + r.changes + ' ta kanal');
});

bot.command('delete', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /delete <chat_id>');
  db.prepare('DELETE FROM seen WHERE chat_id=?').run(c.id);
  db.prepare('DELETE FROM chats WHERE id=?').run(c.id);
  ctx.reply('O\'chirildi: ' + c.title);
});

bot.command('setlang', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id, lang] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c || !['uz', 'ru', 'en'].includes(lang)) return ctx.reply('Ishlatish: /setlang <chat_id> <uz|ru|en>');
  db.prepare('UPDATE chats SET lang=? WHERE id=?').run(lang, c.id);
  ctx.reply(c.title + ' tili: ' + lang);
});

bot.command('setstyle', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  const style = restArgs(ctx, 1);
  if (!c || !style) return ctx.reply('Ishlatish: /setstyle <chat_id> <uslub>');
  db.prepare('UPDATE chats SET style=? WHERE id=?').run(style, c.id);
  ctx.reply('Uslub yangilandi: ' + c.title);
});

bot.command('settopic', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  const topic = restArgs(ctx, 1);
  if (!c || !topic) return ctx.reply('Ishlatish: /settopic <chat_id> <mavzu>');
  db.prepare('UPDATE chats SET topic=? WHERE id=?').run(topic, c.id);
  ctx.reply('Mavzu yangilandi: ' + c.title);
});

bot.command('football', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id, v] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c || !['on', 'off'].includes(v)) return ctx.reply('Ishlatish: /football <chat_id> <on|off>');
  db.prepare('UPDATE chats SET is_football=? WHERE id=?').run(v === 'on' ? 1 : 0, c.id);
  ctx.reply(c.title + ' futbol rejimi: ' + v);
});

bot.command('poll', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /poll <chat_id>');
  try {
    const lang = LANG[c.lang] || LANG.ru;
    const q = await gemini('Mavzu: ' + (c.topic || 'futbol') + '. Qiziqarli so\'rovnoma savoli yoz. Faqat ' + lang + '. Savol + 3-4 variant. Faqat JSON: {"question":"...","options":["A","B","C"]}');
    const j = extractJson(q);
    if (!j || !j.question || !Array.isArray(j.options) || j.options.length < 2) return ctx.reply('So\'rovnoma yaratilmadi, qayta urinib ko\'ring');
    await bot.telegram.sendPoll(c.id, j.question.slice(0, 300), j.options.slice(0, 4).map((o) => String(o).slice(0, 100)), { is_anonymous: true });
    ctx.reply('Yuborildi');
  } catch (e) {
    ctx.reply('Xato: ' + e.message.slice(0, 300));
  }
});

bot.command('video', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /video <chat_id>');
  if (typeof sendVideo !== 'function') return ctx.reply('Video funksiyasi o\'rnatilmagan');
  try {
    const ok = await sendVideo(c);
    ctx.reply(ok ? 'Video yuborildi' : 'Yangi video topilmadi');
  } catch (e) {
    ctx.reply('Xato: ' + e.message.slice(0, 300));
  }
});

bot.command('say', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  const text = restArgs(ctx, 1);
  if (!c || !text) return ctx.reply('Ishlatish: /say <chat_id> <matn>');
  try {
    await bot.telegram.sendMessage(c.id, text);
    ctx.reply('Yuborildi');
  } catch (e) {
    ctx.reply('Xato: ' + e.message.slice(0, 300));
  }
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = restArgs(ctx, 0);
  if (!text) return ctx.reply('Ishlatish: /broadcast <matn>');
  const rows = db.prepare('SELECT * FROM chats WHERE active=1').all();
  let ok = 0;
  for (const c of rows) {
    try {
      await bot.telegram.sendMessage(c.id, text);
      ok++;
    } catch (e) {
      console.error('broadcast xato', c.id, e.message.slice(0, 80));
    }
  }
  ctx.reply('Yuborildi: ' + ok + '/' + rows.length);
});

bot.command('chats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = db.prepare('SELECT id, title, active, post_count, lang, is_football FROM chats').all();
  if (!rows.length) return ctx.reply('Kanallar yo\'q');
  const lines = rows.map((c) => (c.active ? '🟢 ' : '🔴 ') + c.title + '\nid: ' + c.id + ' | ' + c.lang + ' | post: ' + c.post_count + ' | futbol: ' + (c.is_football ? 'ha' : 'yo\'q'));
  ctx.reply(lines.join('\n\n').slice(0, 4000));
});

bot.command('info', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /info <chat_id>');
  ctx.reply(
    ('Nomi: ' + c.title + '\nID: ' + c.id + '\nTil: ' + c.lang + '\nMavzu: ' + c.topic + '\nUslub: ' + c.style +
    '\nFutbol: ' + (c.is_football ? 'ha' : 'yo\'q') + '\nFaol: ' + (c.active ? 'ha' : 'yo\'q') +
    '\nPostlar: ' + c.post_count + '\nHavola: ' + (c.invite || '-')).slice(0, 4000)
  );
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const one = (q) => Object.values(db.prepare(q).get())[0];
  ctx.reply(
    'Kanallar: ' + one('SELECT COUNT(*) FROM chats') +
    '\nFaol: ' + one('SELECT COUNT(*) FROM chats WHERE active=1') +
    '\nJami postlar: ' + (one('SELECT SUM(post_count) FROM chats') || 0) +
    '\nSaqlangan matnlar: ' + one('SELECT COUNT(*) FROM seen') +
    '\nIshlatilgan yangilik/video: ' + one('SELECT COUNT(*) FROM used') +
    '\nIshlatilgan rasm qidiruvlari: ' + one('SELECT COUNT(*) FROM used_photos') +
    '\nInterval: ' + (process.env.POST_INTERVAL_MIN || '180') + ' min' +
    '\nAktiv vaqt: ' + Math.round(process.uptime() / 60) + ' min'
  );
});

bot.command('last', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const a = cmdArgs(ctx);
  const c = chatById(a[0]);
  if (!c) return ctx.reply('Ishlatish: /last <chat_id> [n]');
  const n = Math.min(Number(a[1]) || 3, 10);
  const rows = db.prepare('SELECT text FROM seen WHERE chat_id=? AND mine=1 ORDER BY id DESC LIMIT ?').all(c.id, n);
  if (!rows.length) return ctx.reply('Postlar yo\'q');
  ctx.reply(rows.map((r, i) => (i + 1) + ') ' + r.text.replace(/<[^>]+>/g, '').slice(0, 300)).join('\n\n').slice(0, 4000));
});

bot.command('clear', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id] = cmdArgs(ctx);
  const c = chatById(id);
  if (!c) return ctx.reply('Ishlatish: /clear <chat_id>');
  const r = db.prepare('DELETE FROM seen WHERE chat_id=?').run(c.id);
  ctx.reply('Tozalandi: ' + r.changes + ' ta yozuv');
});

bot.command('clearphotos', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = db.prepare('DELETE FROM used_photos').run();
  ctx.reply('Rasm tarixi tozalandi: ' + r.changes + ' ta');
});

bot.command('ping', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const t = Date.now();
  await ctx.reply('Bot ishlayapti. Gemini tekshirilmoqda...');
  try {
    const r = await gemini('Faqat "ok" deb javob ber');
    ctx.reply('Gemini: ' + (r || '').slice(0, 50) + ' (' + (Date.now() - t) + ' ms)');
  } catch (e) {
    ctx.reply('Gemini xato: ' + e.message.slice(0, 250));
  }
});

bot.command('restart', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('Qayta ishga tushmoqda...');
  setTimeout(() => process.exit(0), 1000);
});

bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message', 'channel_post', 'my_chat_member'] });
setInterval(tick, INTERVAL_MIN * 60 * 1000);
console.log('Bot ishga tushdi');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
