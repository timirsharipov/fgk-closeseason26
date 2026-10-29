/**
 * FGK CloseSeason 26 - сервер аллейката на Google Apps Script.
 *
 * Данные лежат в этой же Google Таблице:
 *   «Настройки»   - время старта, радиус засчёта, адрес сайта
 *   «Регистрации» - ники участников, сумма и галочка «Оплачено»
 *                   (колонка «Допуск»: «нет» - не пускать в гонку)
 *   «Точки»       - точки маршрута, их ценность, описание и фото
 *   «Сканы»       - журнал всех отметок со статусом. Отметка по фото приходит
 *                   со статусом «проверить фото»: посмотрели фото, поставили «ok»
 *                   (засчитается временем отправки) или «отклонено»
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
  points: ["ID", "Название", "Координаты", "Ценность", "Финиш", "Описание", "Фото", "Фото для сайта"],
  scans: ["Время", "Ник", "Точка", "Очки", "Расстояние, м", "Точность, м", "Статус", "Фото"],
};

var DEFAULT_SETTINGS = [
  ["Старт", "2026-10-30T20:00:00+03:00"],
  ["Конец", "2026-10-31T00:00:00+03:00"], // после этого сканы не принимаются
  ["Радиус, м", "150"],
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
  description: "Описание",
  photo: "Фото", photoSite: "Фото для сайта",
};
// остались от отметки по QR-кодам - setup их удаляет
var OLD_POINT_COLUMNS = ["Секрет", "Ссылка для QR", "QR", "Фото QR", "Фото QR для сайта"];
var OLD_SETTINGS = ["Адрес сайта"];
var PHOTO_FOLDER = "FGK CloseSeason 26, фото точек";
var CHECKIN_FOLDER = "FGK CloseSeason 26, фото с отметок"; // фото гонщиков, когда гео не сработало
var PENDING = "проверить фото";

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
    if (body.action === "photo") return photo_(body);
    if (body.action === "paysource") return paySource_(body);
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

  return withLock_(function () {
    var existing = findRegistration_(nick);
    if (existing) return status_(existing, { already: true });
    var amount = addRegistration_(s, new Date(), nick, gender, payment);
    return status_({ nick: nick, amount: amount, paid: amount === 0, blocked: false }, { already: false });
  });
}

// После регистрации участник пишет, с чьей карты перевёл, - чтобы найти платёж
function paySource_(body) {
  var nick = cleanNick_(body.nick);
  var payment = String(body.payment || "").trim().slice(0, 200);
  if (!nick) throw userError_("Не нашли такой ник среди зарегистрированных");
  if (!payment) throw userError_("Напиши имя и банк, с которых переводишь");
  return withLock_(function () {
    var rows = rows_("regs");
    for (var i = 0; i < rows.length; i++) {
      if (cleanNick_(rows[i][1]) !== nick) continue;
      sheet_("regs").getRange(i + 2, 4).setValue(payment);
      return status_(findRegistration_(nick), {});
    }
    throw userError_("Не нашли такой ник среди зарегистрированных");
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
  // фото, которые организаторы ещё не посмотрели
  var taken = {};
  mine.forEach(function (x) { taken[x[0]] = true; });
  var pending = rows_("scans")
    .filter(function (r) { return r[6] === PENDING && String(r[1]) === nick && !taken[String(r[2])]; })
    .map(function (r) { return String(r[2]); });
  return status_(reg, { scans: mine, pending: pending });
}

function status_(reg, extra) {
  var out = { nick: reg.nick, amount: reg.amount, paid: reg.paid, blocked: reg.blocked, source: reg.source || "" };
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

    var c = checkRider_(s, nick, cpId, fail);
    if (c.already) return { already: true, cp: cpId, at: c.already.at };
    var point = c.point;
    var okScans = c.okScans;

    if (!isFinite(lat) || !isFinite(lng)) fail(point, "нет геолокации", "Не получили геолокацию. Разреши доступ и отметься ещё раз");
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

// Общие проверки отметки: время гонки, регистрация, точка, финиш последним.
// fail(point, статус, сообщение) пишет попытку в журнал и прерывает отметку.
function checkRider_(s, nick, cpId, fail) {
  if (Date.now() < s.start) fail(null, "рано", "Отметки засчитываются с момента старта");
  if (Date.now() > s.end) fail(null, "после конца", "Аллейкат закончился, отметки больше не принимаются");

  var reg = nick && findRegistration_(nick);
  if (!reg) fail(null, "нет регистрации", "Войди ником из регистрации");
  if (reg.blocked) fail(null, "не допущен", "Ты пока не допущен к гонке, напиши организаторам");
  if (s.requirePaid && !reg.paid) fail(null, "не оплачено", "Оплата ещё не подтверждена, покажи перевод организаторам");

  var points = readPoints_();
  var point = points.filter(function (p) { return p.id === cpId; })[0];
  if (!point) fail(null, "нет точки", "Такой точки нет");

  var okScans = readScans_();
  var already = okScans.filter(function (x) { return x.nick === nick && x.cp === cpId; })[0];
  if (already) return { already: already };

  // финиш отмечается последним: после него точки не засчитываются
  var finals = {};
  points.forEach(function (p) { if (p.final) finals[p.id] = true; });
  var finished = okScans.some(function (x) { return x.nick === nick && finals[x.cp]; });
  if (finished) fail(point, "после финиша", "Ты уже отметил финиш, после него точки не засчитываются");
  return { point: point, okScans: okScans };
}

// Отметка по фото - если геолокация не работает (глушат, уводит за город).
// Фото ложится на Диск организатора, в «Сканы» - строка «проверить фото» со ссылкой.
// Организатор смотрит фото и меняет статус на «ok» (засчитается временем отправки) или «отклонено».
function photo_(body) {
  var s = settings_();
  var nick = cleanNick_(body.nick);
  var cpId = String(body.cp || "").trim();
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var accuracy = Number(body.accuracy) || 0;
  var data = String(body.image || "").replace(/^data:image\/[\w+.-]+;base64,/, "");
  if (!data) throw userError_("Фото не дошло, попробуй ещё раз");
  if (data.length > 10 * 1024 * 1024) throw userError_("Фото слишком большое");
  var at = new Date();

  var fail = function (point, status, message) {
    sheet_("scans").appendRow([at, nick || String(body.nick || ""), cpId, 0, "", "", "фото: " + status, ""]);
    throw userError_(message);
  };
  var c = checkRider_(s, nick, cpId, fail);
  if (c.already) return { already: true, cp: cpId, at: c.already.at };

  // сохраняем вне блокировки: загрузка на Диск небыстрая
  var name = Utilities.formatDate(at, "Europe/Moscow", "HH-mm-ss") + " " + nick + " " + cpId + ".jpg";
  var file = checkinFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(data), "image/jpeg", name));
  var hasPos = isFinite(lat) && isFinite(lng) && isFinite(c.point.lat) && isFinite(c.point.lng);
  var distance = hasPos ? Math.round(distanceM_({ lat: lat, lng: lng }, c.point)) : "";

  withLock_(function () {
    var sh = sheet_("scans");
    if (!String(sh.getRange(1, 8).getValue()).trim()) sh.getRange(1, 8).setValue("Фото").setFontWeight("bold");
    sh.appendRow([at, nick, cpId, 0, distance, accuracy ? Math.round(accuracy) : "", PENDING, file.getUrl()]);
  });
  return { pending: true, cp: cpId, at: at.getTime() };
}

function checkinFolder_() {
  var it = DriveApp.getFoldersByName(CHECKIN_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CHECKIN_FOLDER);
}

/* ================= обслуживание по ключу ================= */

function isAdmin_(s, key) {
  return Boolean(s.adminKey) && String(key || "") === s.adminKey;
}

// Тестовая отметка для разработки и проверки точек: как далеко телефон от координат точки. В «Сканы» - с пометкой «тест», в очки не идёт.
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
  if (body.op === "photo") return setPointPhoto_(body);
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
// Фото точки, присланное не через таблицу: кладём на Диск с доступом по ссылке
// и добавляем ссылку в колонку «Фото» новой строкой (сайт показывает их галереей).
function setPointPhoto_(body) {
  var data = String(body.image || "").replace(/^data:image\/[\w+.-]+;base64,/, "");
  if (!data) throw userError_("Нет фото");
  var id = String(body.id || "").trim();
  var t = pointsTable_();
  var i = -1;
  t.rows.forEach(function (r, k) { if (String(t.get(r, "id")).trim() === id) i = k; });
  if (i < 0 || t.col.photo < 0) throw userError_("Такой точки нет в таблице");
  var cell = t.get(t.rows[i], "photo");
  if (cell && typeof cell === "object") throw userError_("В ячейке «Фото» картинка: добавь фото в таблице или очисти ячейку");
  // гифку (анимированный webp/gif) Диск в превью показывает одним кадром - помечаем её #anim
  var anim = body.type === "webp" || body.type === "gif";
  var ext = anim ? body.type : "jpg";
  var mime = anim ? "image/" + body.type : "image/jpeg";
  var file = photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(data), mime, "точка " + id + "." + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var link = "https://drive.google.com/file/d/" + file.getId() + "/view" + (anim ? "#anim" : "");
  return withLock_(function () {
    // в объединённую ячейку запись молча пропадает - лучше сказать об этом
    var range = t.sh.getRange(i + 2, t.col.photo + 1);
    if (typeof range.isPartOfMerge === "function" && range.isPartOfMerge()) {
      throw userError_("Ячейка «Фото» у точки " + id + " объединена с соседней: разъедини её в таблице");
    }
    // новое фото добавляется к уже стоящим - на сайте их можно листать
    var old = String(range.getValue() || "").trim();
    t.sh.getRange(i + 2, t.col.photo + 1).setValue(old ? old + "\n" + link : link);
    CacheService.getScriptCache().remove("public");
    return { id: id, photo: link, site: photoUrl_(link), count: (old ? old.split(/\s+/).length : 0) + 1 };
  });
}

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
      description: String(t.get(r, "description")).trim(),
      photo: photo && typeof photo === "object" ? "[фото в ячейке]" : String(photo || "").trim(),
      photoSite: String(t.get(r, "photoSite")).trim(),
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
        description: String(t.get(r, "description") || "").trim(),
        photos: pointPhotos_(t, r),
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
    description: p.description, photo: p.photos[0] || "", photos: p.photos,
  };
}

// Фото точки: вставленное в ячейку (его копия на Диске - в «Фото для сайта»)
// и/или ссылки в ячейке «Фото», по одной на строку. На сайте листаются.
function pointPhotos_(t, r) {
  var out = [];
  var site = photoUrl_(t.get(r, "photoSite"));
  if (site) out.push(site);
  var cell = t.get(r, "photo");
  if (cell && typeof cell === "object") return out;
  String(cell || "").split(/\s+/).forEach(function (u) {
    var url = photoUrl_(u);
    if (url && out.indexOf(url) < 0) out.push(url);
  });
  return out;
}

// Ссылку «поделиться» из Google Диска превращаем в картинку, которую можно показать на сайте
// (файл должен быть доступен «всем, у кого есть ссылка»). Прочие ссылки - как есть.
function photoUrl_(v) {
  var url = String(v || "").trim();
  if (!/^https?:\/\//.test(url)) return "";
  var m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  if (!m) return url;
  // гифка: lh3 отдаёт её с анимацией и, в отличие от прямых ссылок Диска, не запрещает показ на чужом сайте
  if (/#anim$/.test(url)) return "https://lh3.googleusercontent.com/d/" + m[1];
  return "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w1200";
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
    source: String(row[3] || "").trim(),
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
    .addItem("Обновить ID и фото точек", "refreshQr")
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
  for (var row = st.getLastRow(); row >= 1; row--) {
    if (OLD_SETTINGS.indexOf(String(st.getRange(row, 1).getValue()).trim()) >= 0) st.deleteRow(row);
  }
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
  // колонки QR-кодов больше не нужны: удаляем справа налево, чтобы номера не съезжали
  OLD_POINT_COLUMNS
    .map(function (name) { return h.indexOf(name); })
    .filter(function (i) { return i >= 0; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (i) { sh.deleteColumn(i + 1); });
  h = head();
  HEADERS.points.forEach(function (name) {
    if (h.indexOf(name) >= 0) return;
    var c = h.filter(String).length + 1;
    sh.getRange(1, c).setValue(name).setFontWeight("bold");
    h[c - 1] = name;
  });
}
/**
 * Дозаполняет пустые ID точек и выкладывает фото, вставленные прямо в ячейку «Фото»,
 * чтобы сайт мог их показать. Пишем только служебные колонки - то, что заполнил организатор, не трогаем.
 * (Имя функции осталось от QR-кодов: на него ссылается загрузчик в Apps Script.)
 */
function refreshQr() {
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
  write("photoSite", t.rows.map(function (r) { return syncPhoto_(t, r, "photo", "photoSite", ""); }));

  t.sh.setRowHeights(2, n, 120);
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
      "потом снова «Аллейкат → Обновить ID и фото точек»."
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
