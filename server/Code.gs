/**
 * FGK CloseSeason 26 - сервер аллейката на Google Apps Script.
 *
 * Данные лежат в этой же Google Таблице:
 *   «Настройки»   - время старта, радиус засчёта, адрес сайта
 *   «Регистрации» - ники участников, сумма и галочка «Оплачено»
 *                   (колонка «Допуск»: «нет» - не пускать в гонку)
 *   «Точки»       - точки маршрута, их ценность, секреты и ссылки для QR
 *   «Сканы»       - журнал всех попыток скана со статусом
 *
 * Если таблица - это таблица ответов Google Формы, ответы формы автоматически
 * переносятся в «Регистрации» (лист формы остаётся как есть).
 *
 * Установка - см. server/README.md.
 */

var SHEETS = {
  settings: "Настройки",
  regs: "Регистрации",
  points: "Точки",
  scans: "Сканы",
};

var HEADERS = {
  regs: ["Время", "Ник", "Пол", "Источник оплаты", "Сумма, ₽", "Оплачено", "Допуск"],
  points: ["ID", "Название", "Координаты", "Ценность", "Финиш", "Секрет", "Ссылка для QR", "QR", "Описание", "Фото", "Фото для сайта", "Фото QR", "Фото QR для сайта"],
  scans: ["Время", "Ник", "Точка", "Очки", "Расстояние, м", "Точность, м", "Статус"],
};

var DEFAULT_SETTINGS = [
  ["Старт", "2026-10-30T20:00:00+03:00"],
  ["Конец", "2026-10-31T00:00:00+03:00"], // после этого сканы не принимаются
  ["Радиус, м", "150"],
  ["Адрес сайта", "https://timirsharipov.github.io/fgk-closeseason26/"],
  ["Цена, ₽", "300"],
  ["Цена после повышения, ₽", "600"],
  ["Повышение цены", "2026-10-26T00:00:00+03:00"],
  ["Гонка только после оплаты", "нет"],
  ["Очки за первое место", "10"], // на каждой точке: первый — столько, второй на 1 меньше и т. д.
  ["Минимум очков за точку", "1"],
  ["Ключ администратора", ""], // setup заполнит сам; с ним можно обслуживать таблицу удалённо
];

// колонки листа «Точки» ищем по названию - их можно переставлять
var P = {
  id: "ID", name: "Название", coords: "Координаты", value: "Ценность", final: "Финиш",
  secret: "Секрет", link: "Ссылка для QR", qr: "QR", description: "Описание",
  photo: "Фото", photoSite: "Фото для сайта", // для красоты
  photoQr: "Фото QR", photoQrSite: "Фото QR для сайта", // где висит QR
};
var PHOTO_FOLDER = "FGK CloseSeason 26, фото точек";

var COL_PAID = 6; // колонка «Оплачено» на листе «Регистрации»
var YES = /^(да|yes|1|true|x|✓)$/i;
var OK = "ok";
var CACHE_SECONDS = 10;
var MAX_ACCURACY_M = 500; // хуже этой точности геолокацию не принимаем
var ACCURACY_BONUS_M = 50; // допуск на погрешность GPS сверх радиуса

/* ================= HTTP ================= */

function doGet(e) {
  return handle_(function () {
    var p = (e && e.parameter) || {};
    var action = p.action || "state";
    if (action === "state") return getState_(p.test);
    if (action === "me") return me_(p.nick);
    throw userError_("Неизвестное действие");
  });
}

function doPost(e) {
  return handle_(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.action === "register") return register_(body);
    if (body.action === "login") return login_(body);
    if (body.action === "scan") return scan_(body);
    if (body.action === "admin") return admin_(body);
    throw userError_("Неизвестное действие");
  });
}

function handle_(fn) {
  var out;
  try {
    out = fn();
    out.ok = out.ok !== false;
  } catch (err) {
    out = { ok: false, error: err.userMessage || "Ошибка сервера, попробуй ещё раз" };
    if (!err.userMessage) console.error(err && err.stack ? err.stack : err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(message) {
  var err = new Error(message);
  err.userMessage = message;
  return err;
}

/* ================= действия ================= */

function getState_(testKey) {
  var s = settings_();
  var now = Date.now();
  var test = isAdmin_(s, testKey);
  // в тестовом режиме (с ключом администратора) точки видны и до старта
  var state = {
    now: now, start: s.start, end: isFinite(s.end) ? s.end : null, radius: s.radius,
    open: now >= s.start || test, test: test,
  };
  if (!state.open) return state; // до старта точки не раскрываем

  var cache = CacheService.getScriptCache();
  var cached = cache.get("public");
  var pub = cached ? JSON.parse(cached) : null;
  if (!pub) {
    var points = readPoints_();
    pub = { checkpoints: points.map(publicPoint_), leaderboard: leaderboard_(s, points, readScans_()) };
    cache.put("public", JSON.stringify(pub), CACHE_SECONDS);
  }
  state.checkpoints = pub.checkpoints;
  // топ и кто где был: во время гонки скрыты (азарт), видны организатору и после конца
  state.results = test || now > s.end;
  if (state.results) state.leaderboard = pub.leaderboard;
  return state;
}

function register_(body) {
  var s = settings_();
  if (Date.now() >= s.start) throw userError_("Регистрация закрыта, аллейкат уже идёт");

  var nick = cleanNick_(body.telegram);
  var gender = String(body.gender || "").trim();
  var payment = String(body.payment || "").trim().slice(0, 200);
  if (!nick) throw userError_("Проверь ник в Telegram: латиница, цифры и _");
  if (gender !== "М" && gender !== "Ж") throw userError_("Выбери пол");
  if (!payment) throw userError_("Укажи, с чьей карты перевод");

  return withLock_(function () {
    var existing = findRegistration_(nick);
    if (existing) return status_(existing, { already: true });
    var amount = addRegistration_(s, new Date(), nick, gender, payment);
    return status_({ nick: nick, amount: amount, paid: amount === 0, blocked: false }, { already: false });
  });
}

function addRegistration_(s, time, nick, gender, payment) {
  var amount = price_(s, gender, time.getTime());
  var sh = sheet_("regs");
  sh.appendRow([time, nick, gender, payment, amount, amount === 0, ""]);
  sh.getRange(sh.getLastRow(), COL_PAID).insertCheckboxes();
  return amount;
}

// статус регистрации и оплаты - чтобы участник видел, подтверждён ли перевод
function me_(raw) {
  var nick = cleanNick_(raw);
  var reg = nick && findRegistration_(nick);
  if (!reg) throw userError_("Не нашли такой ник среди зарегистрированных");
  // свои отметки гонщик видит всегда: [id точки, время]
  var finals = {};
  readPoints_().forEach(function (p) { if (p.final) finals[p.id] = true; });
  var mine = readScans_().filter(function (x) { return x.nick === nick; });
  var finishAt = Math.min.apply(null, mine.filter(function (x) { return finals[x.cp]; }).map(function (x) { return x.at; }).concat([Infinity]));
  mine = mine
    .filter(function (x) { return x.at <= finishAt; }) // после финиша не считается
    .map(function (x) { return [x.cp, x.at]; });
  return status_(reg, { scans: mine });
}

function status_(reg, extra) {
  var out = { nick: reg.nick, amount: reg.amount, paid: reg.paid, blocked: reg.blocked };
  for (var k in extra) out[k] = extra[k];
  return out;
}

function price_(s, gender, at) {
  if (gender === "Ж") return 0;
  return at < s.priceChange ? s.priceEarly : s.priceLate;
}

function login_(body) {
  var nick = cleanNick_(body.nick);
  if (!nick) throw userError_("Введи ник в Telegram");
  var reg = findRegistration_(nick);
  if (!reg) throw userError_("Не нашли @" + nick + " среди зарегистрированных");
  if (reg.blocked) throw userError_("@" + nick + " пока не допущен к гонке, напиши организаторам");
  return status_(reg, {});
}

function scan_(body) {
  var s = settings_();
  if (body.test) return testScan_(s, body);
  var nick = cleanNick_(body.nick);
  var cpId = String(body.cp || "").trim();
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var accuracy = Number(body.accuracy) || 0;

  return withLock_(function () {
    var log = function (point, status, distance) {
      sheet_("scans").appendRow([
        new Date(), nick || String(body.nick || ""), cpId,
        status === OK ? point.value : 0,
        distance == null ? "" : Math.round(distance),
        accuracy ? Math.round(accuracy) : "",
        status,
      ]);
    };
    var fail = function (point, status, message, distance) {
      log(point || { value: 0 }, status, distance);
      throw userError_(message);
    };

    if (Date.now() < s.start) fail(null, "рано", "Сканы засчитываются с момента старта");
    if (Date.now() > s.end) fail(null, "после конца", "Аллейкат закончился, сканы больше не принимаются");

    var reg = nick && findRegistration_(nick);
    if (!reg) fail(null, "нет регистрации", "Войди ником из регистрации");
    if (reg.blocked) fail(null, "не допущен", "Ты пока не допущен к гонке, напиши организаторам");
    if (s.requirePaid && !reg.paid) fail(null, "не оплачено", "Оплата ещё не подтверждена, покажи перевод организаторам");

    var points = readPoints_();
    var point = points.filter(function (p) { return p.id === cpId; })[0];
    if (!point) fail(null, "нет точки", "Такой точки нет, отсканируй код ещё раз");
    if (!body.k || String(body.k) !== point.secret) fail(point, "неверный код", "QR-код не подошёл, отсканируй код прямо на точке");

    var okScans = readScans_();
    var already = okScans.filter(function (x) { return x.nick === nick && x.cp === cpId; })[0];
    if (already) return { already: true, cp: cpId, at: already.at };

    // финиш отмечается последним: после него точки не засчитываются
    var finals = {};
    points.forEach(function (p) { if (p.final) finals[p.id] = true; });
    var finished = okScans.some(function (x) { return x.nick === nick && finals[x.cp]; });
    if (finished) fail(point, "после финиша", "Ты уже отметил финиш, после него точки не засчитываются");

    if (!isFinite(lat) || !isFinite(lng)) fail(point, "нет геолокации", "Не получили геолокацию. Разреши доступ и отсканируй ещё раз");
    if (accuracy > MAX_ACCURACY_M) fail(point, "низкая точность", "Геолокация слишком неточная. Включи GPS и попробуй ещё раз");

    var distance = distanceM_({ lat: lat, lng: lng }, point);
    var allowed = s.radius + Math.min(accuracy, ACCURACY_BONUS_M);
    if (distance > allowed) {
      log(point, "далеко", distance);
      return { ok: false, far: true, distance: Math.round(distance), radius: s.radius, cp: cpId };
    }

    var place = okScans.filter(function (x) { return x.cp === cpId; }).length + 1;
    var pts = placePoints_(s, point.value, place);
    log({ value: pts }, OK, distance);
    CacheService.getScriptCache().remove("public");
    // место и очки не отдаём: во время гонки гонщик не знает, кто был раньше
    return { cp: cpId, distance: Math.round(distance), at: Date.now() };
  });
}

/* ================= обслуживание по ключу ================= */

function isAdmin_(s, key) {
  return Boolean(s.adminKey) && String(key || "") === s.adminKey;
}

// Тестовый скан для разработки и расклейки: проверяет, что QR от этой точки
// и как далеко телефон от её координат. В «Сканы» - с пометкой «тест», в очки не идёт.
function testScan_(s, body) {
  if (!isAdmin_(s, body.test)) throw userError_("Тестовый режим: неверный ключ");
  var cpId = String(body.cp || "").trim();
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var accuracy = Number(body.accuracy) || 0;
  var point = readPoints_().filter(function (p) { return p.id === cpId; })[0];
  var log = function (status, distance) {
    sheet_("scans").appendRow([new Date(), "(тест)", cpId, 0,
      distance == null ? "" : Math.round(distance), accuracy ? Math.round(accuracy) : "", "тест: " + status]);
  };
  if (!point) { log("нет точки"); throw userError_("Такой точки нет в таблице"); }
  if (!body.k || String(body.k) !== point.secret) { log("неверный код"); throw userError_("QR-код не от этой точки: секрет не совпал"); }
  if (!isFinite(lat) || !isFinite(lng)) { log("нет геолокации"); throw userError_("Не получили геолокацию"); }
  var hasCoords = isFinite(point.lat) && isFinite(point.lng);
  var distance = hasCoords ? distanceM_({ lat: lat, lng: lng }, point) : null;
  var ok = hasCoords && distance <= s.radius + Math.min(accuracy, ACCURACY_BONUS_M);
  log(ok ? "ok" : hasCoords ? "далеко" : "нет координат", distance);
  return {
    test: true, ok: true, cp: cpId, name: point.name, inRadius: ok, radius: s.radius,
    distance: distance == null ? null : Math.round(distance), accuracy: Math.round(accuracy), hasCoords: hasCoords,
  };
}

// Служебные команды для удалённого обслуживания таблицы.
// Работают только с «Ключом администратора» из листа «Настройки».
function admin_(body) {
  var s = settings_();
  if (!isAdmin_(s, body.key)) throw userError_("Нет доступа");
  if (body.op === "refresh") {
    withLock_(refreshQr);
    CacheService.getScriptCache().remove("public");
    return { done: true, points: adminPoints_(s) };
  }
  if (body.op === "points") return { points: adminPoints_(s) };
  // загрузчик (server/Loader.gs): взять свежий код с GitHub со следующего запроса
  if (body.op === "reload") {
    CacheService.getScriptCache().remove("serverCode");
    return { done: true, loaded: typeof LOADER_INFO !== "undefined" ? LOADER_INFO : null };
  }
  if (body.op === "version") return { loaded: typeof LOADER_INFO !== "undefined" ? LOADER_INFO : null };
  if (body.op === "coords") return setCoords_(body);
  if (body.op === "setting") return setSetting_(body);
  // первичная настройка удалённо: дописать недостающие настройки и колонки (данные не трогает)
  if (body.op === "setup") {
    withLock_(setup);
    return { done: true };
  }
  throw userError_("Неизвестная команда");
}

// Поменять значение на листе «Настройки» (только известные настройки, кроме ключа)
function setSetting_(body) {
  var name = String(body.name || "").trim();
  var known = DEFAULT_SETTINGS.map(function (r) { return r[0]; });
  if (known.indexOf(name) < 0 || name === "Ключ администратора") throw userError_("Нельзя менять эту настройку");
  return withLock_(function () {
    var sh = sheet_("settings");
    var rows = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === name) {
        sh.getRange(i + 1, 2).setNumberFormat("@").setValue(String(body.value));
        CacheService.getScriptCache().remove("public");
        return { name: name, value: String(body.value) };
      }
    }
    throw userError_("Нет такой строки в «Настройках», запустите setup");
  });
}

// Расклейка: записать точке координаты по месту, где стоит организатор
function setCoords_(body) {
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  if (!isFinite(lat) || !isFinite(lng)) throw userError_("Нет координат");
  return withLock_(function () {
    var t = pointsTable_();
    var i = -1;
    t.rows.forEach(function (r, k) { if (String(t.get(r, "id")).trim() === String(body.id || "").trim()) i = k; });
    if (i < 0 || t.col.coords < 0) throw userError_("Такой точки нет в таблице");
    var coords = lat.toFixed(6) + ", " + lng.toFixed(6);
    t.sh.getRange(i + 2, t.col.coords + 1).setNumberFormat("@").setValue(coords);
    CacheService.getScriptCache().remove("public");
    return { id: body.id, coords: coords };
  });
}

function adminPoints_(s) {
  var t = pointsTable_();
  return t.rows.map(function (r, i) {
    var photo = t.get(r, "photo");
    return {
      row: i + 2,
      id: String(t.get(r, "id")).trim(),
      name: String(t.get(r, "name")).trim(),
      coords: String(t.get(r, "coords")).trim(),
      value: t.get(r, "value"),
      final: String(t.get(r, "final")).trim(),
      secret: String(t.get(r, "secret")).trim(),
      link: String(t.get(r, "link")).trim(),
      description: String(t.get(r, "description")).trim(),
      photo: photo && typeof photo === "object" ? "[фото в ячейке]" : String(photo || "").trim(),
      photoSite: String(t.get(r, "photoSite")).trim(),
      photoQr: (function (v) { return v && typeof v === "object" ? "[фото в ячейке]" : String(v || "").trim(); })(t.get(r, "photoQr")),
      photoQrSite: String(t.get(r, "photoQrSite")).trim(),
    };
  });
}

/* ================= данные ================= */

function settings_() {
  var rows = sheet_("settings").getDataRange().getValues();
  var map = {};
  rows.forEach(function (r) { map[String(r[0]).trim()] = r[1]; });
  var start = map["Старт"] instanceof Date ? map["Старт"].getTime() : Date.parse(String(map["Старт"]));
  if (!isFinite(start)) throw userError_("Сервер не настроен: в «Настройках» неверное время старта");
  var change = map["Повышение цены"];
  change = change instanceof Date ? change.getTime() : Date.parse(String(change));
  return {
    start: start,
    end: parseTime_(map["Конец"]),
    radius: Number(map["Радиус, м"]) || 150,
    site: String(map["Адрес сайта"] || "").trim(),
    priceEarly: Number(map["Цена, ₽"]) || 0,
    priceLate: Number(map["Цена после повышения, ₽"]) || Number(map["Цена, ₽"]) || 0,
    priceChange: isFinite(change) ? change : Infinity,
    requirePaid: YES.test(String(map["Гонка только после оплаты"] || "").trim()),
    adminKey: String(map["Ключ администратора"] || "").trim(),
    firstPoints: Number(map["Очки за первое место"]) || 10,
    minPoints: Number(map["Минимум очков за точку"]) || 1,
  };
}

function readPoints_() {
  var t = pointsTable_();
  return t.rows
    .filter(function (r) { return String(t.get(r, "id")).trim(); })
    .map(function (r) {
      var c = parseCoords_(t.get(r, "coords"));
      return {
        id: String(t.get(r, "id")).trim(),
        name: String(t.get(r, "name")).trim(),
        lat: c.lat,
        lng: c.lng,
        value: Number(t.get(r, "value")) || 1,
        final: YES.test(String(t.get(r, "final")).trim()),
        secret: String(t.get(r, "secret")).trim(),
        description: String(t.get(r, "description") || "").trim(),
        photo: photoUrl_(t.get(r, "photoSite")) || photoUrl_(t.get(r, "photo")),
        qrPhoto: photoUrl_(t.get(r, "photoQrSite")) || photoUrl_(t.get(r, "photoQr")),
      };
    });
}

// лист «Точки»: строки + номера колонок по заголовкам
function pointsTable_() {
  var sh = sheet_("points");
  var values = sh.getDataRange().getValues();
  var head = (values[0] || []).map(function (h) { return String(h).trim(); });
  var col = {};
  Object.keys(P).forEach(function (k) { col[k] = head.indexOf(P[k]); });
  return {
    sh: sh,
    col: col,
    rows: values.slice(1),
    get: function (r, k) { return col[k] >= 0 ? r[col[k]] : ""; },
  };
}
function parseTime_(v) {
  var t = v instanceof Date ? v.getTime() : Date.parse(String(v || ""));
  return isFinite(t) ? t : Infinity;
}

// «55.752000, 37.617500» - как копируют из Яндекс и Google Карт (подойдёт и «55,752; 37,6175»)
function parseCoords_(v) {
  var m = String(v || "").match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return { lat: NaN, lng: NaN };
  return { lat: Number(m[1].replace(",", ".")), lng: Number(m[2].replace(",", ".")) };
}

function publicPoint_(p) {
  return {
    id: p.id, name: p.name, lat: p.lat, lng: p.lng, value: p.value, final: p.final,
    description: p.description, photo: p.photo, qrPhoto: p.qrPhoto,
  };
}

// Ссылку «поделиться» из Google Диска превращаем в картинку, которую можно показать на сайте
// (файл должен быть доступен «всем, у кого есть ссылка»). Прочие ссылки - как есть.
function photoUrl_(v) {
  var url = String(v || "").trim();
  if (!/^https?:\/\//.test(url)) return "";
  var m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w1200" : url;
}

function readScans_() {
  return rows_("scans")
    .filter(function (r) { return r[6] === OK; })
    .map(function (r) {
      return { at: new Date(r[0]).getTime(), nick: String(r[1]), cp: String(r[2]) };
    });
}

function findRegistration_(nick) {
  var row = rows_("regs").filter(function (r) { return cleanNick_(r[1]) === nick; })[0];
  if (!row) return null;
  return {
    nick: nick,
    amount: Number(row[4]) || 0,
    paid: row[5] === true || YES.test(String(row[5]).trim()),
    blocked: /^(нет|no|0|false)$/i.test(String(row[6]).trim()),
  };
}

// На каждой точке очки зависят от того, каким по счёту на неё приехал:
// первый — «Очки за первое место», каждый следующий на 1 меньше, но не меньше минимума.
// Ценность точки — множитель. Побеждает больше очков, при равенстве — кто набрал раньше.
function placePoints_(s, value, place) {
  return value * Math.max(s.firstPoints - (place - 1), s.minPoints);
}

function leaderboard_(s, points, scans) {
  var value = {};
  var finals = {};
  points.forEach(function (p) {
    value[p.id] = p.value;
    if (p.final) finals[p.id] = true;
  });
  var finishedAt = {}; // финиш отмечается последним: что после него, не считается
  scans.forEach(function (x) {
    if (finals[x.cp] && !(finishedAt[x.nick] <= x.at)) finishedAt[x.nick] = x.at;
  });
  var placed = {}; // сколько уже взяли каждую точку
  var byNick = {};
  scans
    .slice()
    .sort(function (a, b) { return a.at - b.at; })
    .forEach(function (x) {
      if (!(x.cp in value)) return;
      if (x.at > finishedAt[x.nick]) return;
      var place = (placed[x.cp] = (placed[x.cp] || 0) + 1);
      var pts = placePoints_(s, value[x.cp], place);
      var r = byNick[x.nick] || (byNick[x.nick] = { nick: x.nick, score: 0, reachedAt: 0, scans: [] });
      r.score += pts;
      r.reachedAt = Math.max(r.reachedAt, x.at);
      r.scans.push([x.cp, x.at, place, pts]);
      if (finals[x.cp]) r.finished = true;
    });
  return Object.keys(byNick)
    .map(function (k) { return byNick[k]; })
    .sort(function (a, b) { return b.score - a.score || a.reachedAt - b.reachedAt; });
}

/* ================= утилиты ================= */

function cleanNick_(v) {
  var nick = String(v || "").trim().toLowerCase()
    .replace(/^https?:\/\/t\.me\//, "")
    .replace(/^@/, "");
  return /^[a-z0-9_]{3,32}$/.test(nick) ? nick : "";
}

function distanceM_(a, b) {
  var rad = function (x) { return (x * Math.PI) / 180; };
  var dLat = rad(b.lat - a.lat);
  var dLng = rad(b.lng - a.lng);
  var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLng / 2), 2);
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_("Сервер занят, попробуй ещё раз через пару секунд");
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sheet_(key) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS[key]);
  if (!sh) throw userError_("Сервер не настроен: нет листа «" + SHEETS[key] + "». Запустите функцию setup в Apps Script");
  return sh;
}

function rows_(key) {
  var sh = sheet_(key);
  var n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, sh.getLastColumn()).getValues() : [];
}

/* ================= меню организатора ================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Аллейкат")
    .addItem("Первичная настройка", "setup")
    .addItem("Обновить ссылки, QR и фото точек", "refreshQr")
    .addToUi();
}

/** Создаёт листы с заголовками и примером точек. Существующие данные не трогает. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  var ensure = function (name, header) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (header && sh.getLastRow() === 0) {
      sh.appendRow(header);
      sh.getRange(1, 1, 1, header.length).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    return sh;
  };

  // дописываем недостающие настройки, существующие значения не трогаем
  var st = ensure(SHEETS.settings);
  var have = st.getLastRow() ? st.getRange(1, 1, st.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  DEFAULT_SETTINGS.forEach(function (row) {
    if (have.indexOf(row[0]) >= 0) return;
    st.getRange(st.getLastRow() + 1, 1, 1, 2).setNumberFormat("@").setValues([row]);
    st.getRange(st.getLastRow(), 1).setFontWeight("bold");
  });
  var keyRow = st.getRange(1, 1, st.getLastRow(), 2).getValues()
    .map(function (r) { return String(r[0]).trim(); }).indexOf("Ключ администратора");
  if (keyRow >= 0 && !String(st.getRange(keyRow + 1, 2).getValue()).trim()) {
    st.getRange(keyRow + 1, 2).setNumberFormat("@").setValue(Utilities.getUuid().replace(/-/g, ""));
  }
  st.autoResizeColumns(1, 2);

  ensure(SHEETS.regs, HEADERS.regs);
  ensure(SHEETS.scans, HEADERS.scans);
  var pts = ensure(SHEETS.points, HEADERS.points);
  migratePoints_(pts);
  if (pts.getLastRow() === 1) {
    var t = pointsTable_();
    [
      { id: "c1", name: "Пример: мост", coords: "55.752000, 37.617500", value: 1 },
      { id: "c2", name: "Пример: смотровая", coords: "55.765000, 37.598000", value: 2 },
      { id: "fin", name: "bass_u x werk", coords: "55.755500, 37.632000", value: 5, final: "да" },
    ].forEach(function (ex, i) {
      Object.keys(ex).forEach(function (k) { pts.getRange(i + 2, t.col[k] + 1).setValue(ex[k]); });
    });
  }
  refreshQr();

  // ответы Google Формы → «Регистрации»: сразу и при каждом новом ответе
  importFormResponses();
  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "importFormResponses"; });
  if (formSheet_() && !hasTrigger) ScriptApp.newTrigger("importFormResponses").forSpreadsheet(ss).onFormSubmit().create();
}

/* ================= ответы Google Формы ================= */

// лист, куда Google Форма пишет ответы: «Время | ник | пол | источник оплаты»
function formSheet_() {
  return SpreadsheetApp.getActive().getSheets().filter(function (sh) {
    return /^(Ответы на форму|Form Responses)/i.test(sh.getName());
  })[0] || null;
}

/**
 * Переносит новые ответы формы в «Регистрации» (каждый - один раз).
 * Ник, который не похож на ник в Telegram, переносится как есть -
 * поправьте его вручную в «Регистрациях», иначе человек не сможет войти.
 */
function importFormResponses() {
  var form = formSheet_();
  if (!form) return;
  withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var done = Number(props.getProperty("formRowsImported")) || 1; // строка 1 - заголовки
    var last = form.getLastRow();
    if (last <= done) return;
    var s = settings_();
    form.getRange(done + 1, 1, last - done, 4).getValues().forEach(function (r) {
      var raw = String(r[1]).trim();
      if (!raw) return;
      var nick = cleanNick_(raw) || raw;
      if (cleanNick_(raw) && findRegistration_(nick)) return; // уже есть, например с сайта
      var gender = /^ж/i.test(String(r[2]).trim()) ? "Ж" : "М";
      var time = r[0] instanceof Date ? r[0] : new Date();
      addRegistration_(s, time, nick, gender, String(r[3]).trim());
    });
    props.setProperty("formRowsImported", String(last));
  });
}

/**
 * Приводит лист «Точки» к нынешнему виду, ничего не теряя из нужного:
 * «Широта» + «Долгота» → «Координаты», колонка «Адрес» больше не нужна,
 * недостающие колонки дописываются в конец.
 */
function migratePoints_(sh) {
  var head = function () {
    return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (h) { return String(h).trim(); });
  };
  var h = head();
  var lat = h.indexOf("Широта");
  var lng = h.indexOf("Долгота");
  if (lat >= 0 && lng >= 0) {
    var n = sh.getLastRow() - 1;
    if (n > 0) {
      var a = sh.getRange(2, lat + 1, n, 1).getValues();
      var b = sh.getRange(2, lng + 1, n, 1).getValues();
      var merged = a.map(function (r, i) {
        return [String(r[0]).trim() && String(b[i][0]).trim() ? r[0] + ", " + b[i][0] : ""];
      });
      sh.getRange(2, lat + 1, n, 1).setNumberFormat("@").setValues(merged);
    }
    sh.getRange(1, lat + 1).setValue("Координаты");
    sh.deleteColumn(lng + 1);
    h = head();
  }
  var addr = h.indexOf("Адрес");
  if (addr >= 0) {
    sh.deleteColumn(addr + 1);
    h = head();
  }
  HEADERS.points.forEach(function (name) {
    if (h.indexOf(name) >= 0) return;
    var c = h.filter(String).length + 1;
    sh.getRange(1, c).setValue(name).setFontWeight("bold");
    h[c - 1] = name;
  });
}
/**
 * Дозаполняет секреты, ссылки и QR у всех точек и выкладывает фото,
 * вставленные прямо в ячейку «Фото», чтобы сайт мог их показать.
 * Пишем только служебные колонки - то, что заполнил организатор, не трогаем.
 */
function refreshQr() {
  var site = settings_().site.replace(/\/?$/, "/");
  var t = pointsTable_();
  var n = t.rows.length;
  if (n < 1) return;
  var write = function (k, values) {
    if (t.col[k] >= 0) t.sh.getRange(2, t.col[k] + 1, n, 1).setValues(values.map(function (v) { return [v]; }));
  };

  // пустой ID у заполненной точки: «fin» для финиша, иначе p1, p2, …
  var used = {};
  t.rows.forEach(function (r) { used[String(t.get(r, "id")).trim()] = true; });
  var nextId = function (final) {
    if (final && !used.fin) return (used.fin = true) && "fin";
    for (var k = 1; ; k++) if (!used["p" + k]) return (used["p" + k] = true) && "p" + k;
  };
  write("id", t.rows.map(function (r) {
    var id = String(t.get(r, "id")).trim();
    var filled = String(t.get(r, "name")).trim() || String(t.get(r, "coords")).trim();
    if (!id && filled) id = nextId(YES.test(String(t.get(r, "final")).trim()));
    if (t.col.id >= 0) r[t.col.id] = id;
    return id;
  }));

  var secrets = t.rows.map(function (r) {
    var s = String(t.get(r, "secret")).trim();
    return s || (String(t.get(r, "id")).trim() ? Utilities.getUuid().replace(/-/g, "").slice(0, 12) : "");
  });
  var linkCol = colLetter_(t.col.link + 1);
  var scannable = t.rows.map(function (r) { return Boolean(String(t.get(r, "id")).trim()); });
  write("secret", secrets);
  write("link", t.rows.map(function (r, i) {
    return scannable[i] ? site + "?cp=" + encodeURIComponent(String(t.get(r, "id")).trim()) + "&k=" + secrets[i] : "";
  }));
  write("qr", t.rows.map(function (r, i) {
    return scannable[i]
      ? '=IMAGE("https://quickchart.io/qr?size=300&margin=1&text=" & ENCODEURL(' + linkCol + (i + 2) + "))"
      : "";
  }));
  write("photoSite", t.rows.map(function (r) { return syncPhoto_(t, r, "photo", "photoSite", ""); }));
  write("photoQrSite", t.rows.map(function (r) { return syncPhoto_(t, r, "photoQr", "photoQrSite", " QR"); }));

  t.sh.setRowHeights(2, n, 120);
  if (t.col.qr >= 0) t.sh.setColumnWidth(t.col.qr + 1, 130);
  warnFloatingPhotos_(t);
}

// картинки «поверх ячеек» сервер не видит - подскажем, где их поместить в ячейку
function warnFloatingPhotos_(t) {
  if (typeof t.sh.getImages !== "function") return;
  var rows = t.sh.getImages()
    .map(function (img) { return img.getAnchorCell().getRow(); })
    .filter(function (row) { return row > 1; });
  if (!rows.length) return;
  var ids = rows.map(function (row) { return String(t.get(t.rows[row - 2] || [], "id")).trim() || "строка " + row; });
  try {
    SpreadsheetApp.getUi().alert(
      "Фото поверх ячеек не попадут на сайт (точки: " + ids.join(", ") + ").\n\n" +
      "Нажмите на фото → ⋮ → «Поместить изображение в выбранную ячейку», " +
      "потом снова «Аллейкат → Обновить ссылки, QR и фото точек»."
    );
  } catch (e) { /* запуск не из таблицы - окно показать некуда */ }
}

function colLetter_(n) {
  var s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
// Фото, вставленное в ячейку («Вставка → Изображение → Изображение в ячейке»),
// сохраняем на Диск с доступом по ссылке; в ответ - ссылка для сайта.
function syncPhoto_(t, r, from, to, suffix) {
  var cell = t.get(r, from);
  var old = String(t.get(r, to) || "").trim();
  var id = String(t.get(r, "id")).trim();
  var isImage = cell && typeof cell === "object" && typeof cell.getContentUrl === "function";
  var props = PropertiesService.getScriptProperties();
  var hashKey = "photoHash_" + id + suffix;
  if (!isImage) {
    trashPhoto_(old);
    props.deleteProperty(hashKey);
    return "";
  }
  var blob = UrlFetchApp.fetch(cell.getContentUrl(), {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
  }).getBlob().setName("точка " + id + suffix);
  // фото не менялось — оставляем уже выложенное
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, blob.getBytes()));
  if (old && props.getProperty(hashKey) === hash) return old;
  var file = photoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  trashPhoto_(old); // прошлую версию фото этой точки убираем, чтобы не копились
  props.setProperty(hashKey, hash);
  return "https://drive.google.com/file/d/" + file.getId() + "/view";
}

function trashPhoto_(link) {
  var m = String(link || "").match(/\/d\/([\w-]{20,})/);
  if (!m) return;
  try { DriveApp.getFileById(m[1]).setTrashed(true); } catch (e) { /* уже удалён */ }
}

function photoFolder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}
