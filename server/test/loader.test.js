// Тест загрузчика: node server/test/loader.test.js
// Загрузчик берёт server/Code.gs «с GitHub», кеширует, держит запасную копию.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas-mock');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const g = load('Loader.gs');
let github = { status: 200, body: code, calls: 0 };
g.ctx.UrlFetchApp = { fetch: (url) => {
  github.calls++;
  if (github.down) throw new Error('network');
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/timirsharipov\/fgk-closeseason26\/main\/server\/Code\.gs\?t=\d+$/);
  return { getResponseCode: () => github.status, getContentText: () => github.body };
} };
const vm = require('vm');
const loaderSrc = fs.readFileSync(path.join(__dirname, '..', 'Loader.gs'), 'utf8');
const reset = () => vm.runInContext(loaderSrc, g.ctx); // новый запуск скрипта: снова только загрузчик
const json = (out) => JSON.parse(out.s);

// первый запуск: setup через загрузчик создаёт листы
g.ctx.setup();
assert.ok(g.sheets['Настройки'] && g.sheets['Точки'], 'setup из GitHub-кода отработал');
assert.equal(g.ctx.LOADER_INFO.source, 'github'); assert.equal(github.calls, 1);

// следующий запуск - из кеша, без GitHub
reset();
assert.equal(json(g.ctx.doGet({ parameter: { action: 'state' } })).ok, true);
assert.equal(g.ctx.LOADER_INFO.source, 'cache'); assert.equal(github.calls, 1);

// служебные команды version / reload
const key = g.sheets['Настройки'].data.find(r => r[0] === 'Ключ администратора')[1];
const admin = (op) => json(g.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'admin', op, key }) } }));
assert.equal(admin('version').loaded.source, 'cache');
assert.equal(admin('reload').done, true);
reset(); g.ctx.doGet({ parameter: { action: 'state' } });
assert.equal(g.ctx.LOADER_INFO.source, 'github', 'после reload код берётся заново'); assert.equal(github.calls, 2);

// GitHub недоступен и кеш пуст - работает сохранённая копия
g.cache.clear(); github.down = true; reset();
assert.equal(json(g.ctx.doGet({ parameter: { action: 'state' } })).ok, true);
assert.equal(g.ctx.LOADER_INFO.source, 'backup');

// на GitHub код с синтаксической ошибкой - на сервер он не попадает
github.down = false; github.body = 'function broken( {'; g.cache.clear(); reset();
assert.equal(json(g.ctx.doGet({ parameter: { action: 'state' } })).ok, true);
assert.equal(g.ctx.LOADER_INFO.source, 'backup');

// меню строится без загрузки кода (при открытии таблицы интернет недоступен)
let menu = []; g.ctx.SpreadsheetApp.getUi = () => ({ createMenu: () => { const m = { addItem: (t, f) => (menu.push(f), m), addToUi: () => {} }; return m; } });
const before = github.calls; reset(); g.ctx.onOpen();
assert.deepEqual(menu, ['setup', 'refreshQr']); assert.equal(github.calls, before);

console.log('LOADER OK');
