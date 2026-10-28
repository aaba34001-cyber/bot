const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf8');
const re = /async function gemini[\s\S]*?\n}\n\nfunction extractJson/;
if (!re.test(s)) { console.log('TOPILMADI: gemini'); process.exit(1); }
s = s.replace(re, () => fs.readFileSync('new_gemini2.txt', 'utf8') + '\nfunction extractJson');
const t = 'new Telegraf(process.env.BOT_TOKEN)';
if (!s.includes(t)) { console.log('TOPILMADI: Telegraf'); process.exit(1); }
s = s.replace(t, () => 'new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 600000 })');
fs.writeFileSync('bot.js', s);
console.log('Patch OK');
