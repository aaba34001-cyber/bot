const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf8');
const re = /async function makeAndSend[\s\S]*?\n}\n\nasync function sendBatch/;
if (!re.test(s)) { console.log('TOPILMADI'); process.exit(1); }
s = s.replace(re, () => fs.readFileSync('new_make.txt', 'utf8') + 'async function sendBatch');
fs.writeFileSync('bot.js', s);
console.log('Patch OK');
