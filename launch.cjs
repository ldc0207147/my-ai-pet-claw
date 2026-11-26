const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

function password(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(Error('請在命令提示字元視窗雙擊啟動，才能安全輸入密碼。'));
    process.stdout.write(prompt);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    function onData(chunk) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(); return reject(Error('已取消啟動')); }
        if (char === '\r' || char === '\n') { finish(); return resolve(value); }
        if (char === '\u007f' || char === '\b') { if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); } }
        else if (char >= ' ' && char !== '\u001b') { value += char; process.stdout.write('*'); }
      }
    }
    process.stdin.on('data', onData);
  });
}

(async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw Error('請安裝 Node.js 22.13 以上版本。');
  const { DatabaseSync } = require('node:sqlite');
  const database = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'claw.sqlite');
  let initialized = false;
  if (fs.existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    try { initialized = !!db.prepare('SELECT username FROM admin LIMIT 1').get(); } catch {} finally { db.close(); }
  }
  if (!initialized) {
    console.log('\n第一次啟動：建立後台管理員。密碼只儲存雜湊，不會寫入 BAT。');
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.env.ADMIN_USER = (await input.question('管理員帳號（直接 Enter 使用 admin）：')).trim() || 'admin';
    input.close();
    let value;
    do { value = await password('管理員密碼（至少 12 字元）：'); if (value.length < 12) console.log('密碼太短，請重新輸入。'); } while (value.length < 12);
    const confirmation = await password('再輸入一次密碼：');
    if (value !== confirmation) throw Error('兩次密碼不同，請重新啟動。');
    process.env.ADMIN_PASSWORD = value;
  } else console.log('\n已載入既有管理員帳號與遊戲資料。');
  console.log('啟動後請保持此視窗開啟。按 Ctrl+C 可停止伺服器。');
  const port = process.env.PORT || '4174';
  console.log(`遊戲：http://127.0.0.1:${port}/\n後台：http://127.0.0.1:${port}/admin\n`);
  require('./server.cjs');
})().catch(error => { console.error('\n啟動失敗：' + error.message); process.exitCode = 1; });
