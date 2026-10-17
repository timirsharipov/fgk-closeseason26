/**
 * FGK CloseSeason 26 - загрузчик сервера.
 *
 * Этот короткий код вставляется в Apps Script один раз. Сам сервер (server/Code.gs)
 * он берёт из GitHub, поэтому обновлять код и заново разворачивать веб-приложение
 * больше не нужно: достаточно запушить изменения в main.
 *
 * Свежий код подхватывается в течение CODE_CACHE_SECONDS (или сразу - служебной
 * командой reload). Последняя рабочая копия хранится в свойствах скрипта и
 * используется, если GitHub недоступен.
 */

var SOURCE_URL = "https://raw.githubusercontent.com/timirsharipov/fgk-closeseason26/main/server/Code.gs";
var CODE_CACHE_SECONDS = 120;
var GLOBAL = this;
var LOADER_INFO = null;

// Точки входа: веб-приложение, меню и триггеры вызывают их по имени.
// После загрузки кода сервера настоящие функции с теми же именами заменяют эти.
function doGet(e) { return run_("doGet", arguments, doGet); }
function doPost(e) { return run_("doPost", arguments, doPost); }
function setup() { return run_("setup", arguments, setup); }
function refreshQr() { return run_("refreshQr", arguments, refreshQr); }
function importFormResponses() { return run_("importFormResponses", arguments, importFormResponses); }

// Меню строим здесь же: при открытии таблицы скачивать код из интернета нельзя.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Аллейкат")
    .addItem("Первичная настройка", "setup")
    .addItem("Обновить ссылки, QR и фото точек", "refreshQr")
    .addToUi();
}

function run_(name, args, stub) {
  if (!LOADER_INFO) {
    var src = loadSource_();
    (0, eval)(src.code);
    LOADER_INFO = { source: src.from, bytes: src.code.length, at: new Date().toISOString() };
  }
  var fn = GLOBAL[name];
  if (typeof fn !== "function" || fn === stub) throw new Error("Код сервера не загрузился (нет функции " + name + ")");
  return fn.apply(GLOBAL, args);
}

function loadSource_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("serverCode");
  if (cached) return { code: cached, from: "cache" };
  try {
    var res = UrlFetchApp.fetch(SOURCE_URL + "?t=" + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var code = res.getContentText();
      new Function(code); // синтаксическая ошибка не должна попасть на сервер
      cache.put("serverCode", code, CODE_CACHE_SECONDS);
      saveBackup_(code);
      return { code: code, from: "github" };
    }
  } catch (e) {
    console.error("Не удалось взять код с GitHub: " + e);
  }
  var backup = readBackup_();
  if (!backup) throw new Error("Нет кода сервера: GitHub недоступен, а сохранённой копии ещё нет");
  return { code: backup, from: "backup" };
}

// свойства скрипта хранят до 9 КБ на значение - режем на части
function saveBackup_(code) {
  var props = PropertiesService.getScriptProperties();
  var size = 8000;
  var parts = {};
  for (var i = 0; i * size < code.length; i++) parts["serverCode_" + i] = code.slice(i * size, (i + 1) * size);
  parts.serverCode_n = String(i);
  props.setProperties(parts);
}

function readBackup_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty("serverCode_n")) || 0;
  var code = "";
  for (var i = 0; i < n; i++) code += props.getProperty("serverCode_" + i) || "";
  return code;
}

// Никогда не вызывается: по этим строкам Google понимает, какие разрешения
// нужны серверу: таблица, запись на Диск (фото точек), блокировки, триггеры.
function permissions_() {
  SpreadsheetApp.getActive();
  DriveApp.createFolder("").createFile(Utilities.newBlob("")).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  DriveApp.getFileById("").setTrashed(true);
  LockService.getScriptLock();
  ScriptApp.newTrigger("").forSpreadsheet("").onFormSubmit().create();
  ScriptApp.getOAuthToken();
}
