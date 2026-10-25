// Сайт аллейката. Данные берутся с сервера (Google Apps Script, см. server/),
// а если в config.js не задан apiUrl или в адресе есть ?demo=… - из демо-данных data.js.
(function () {
  const CFG = window.CONFIG || {};
  const MIN = 60 * 1000;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const DEMO = !CFG.apiUrl || params.has("demo");

  // Тестовый режим (разработка и расклейка QR): включается ссылкой ?test=<ключ администратора>,
  // телефон его запоминает; ?test=off - выключить. Тестовые сканы не идут в зачёт.
  const testKey = (function () {
    const fromUrl = params.get("test");
    try {
      if (fromUrl === "off") localStorage.removeItem("fgk_test");
      else if (fromUrl) localStorage.setItem("fgk_test", fromUrl);
      if (fromUrl) {
        params.delete("test");
        history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
      }
      return DEMO ? "" : localStorage.getItem("fgk_test") || "";
    } catch (e) {
      return fromUrl && fromUrl !== "off" && !DEMO ? fromUrl : "";
    }
  })();

  /* ================= состояние ================= */

  let state = null; // { now, start, radius, open, checkpoints, leaderboard }
  let clockOffset = 0; // серверное время − локальное
  let user = null; // { nick }
  let pendingScan = null; // скан, сделанный до входа
  let myScans = []; // свои отметки: [[id точки, время]] — топ во время гонки скрыт
  let payment = null; // { amount, paid } - статус оплаты участника

  const now = () => Date.now() + clockOffset;
  const raceOn = () => state && (now() >= state.start || state.test);

  const store = {
    get() {
      try { return JSON.parse(localStorage.getItem("fgk_user")); } catch (e) { return null; }
    },
    set(v) {
      try { localStorage.setItem("fgk_user", JSON.stringify(v)); } catch (e) { /* приватный режим */ }
    },
  };

  /* ================= сервер ================= */

  // Google иногда отвечает на первый запрос страницей-заглушкой вместо JSON -
  // тогда тихо повторяем (повтор безопасен: сервер не засчитывает скан и регистрацию дважды)
  async function fetchJson(url, options, tries = 3) {
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(url, options);
        return JSON.parse(await res.text());
      } catch (err) {
        if (i >= tries) throw err;
        await new Promise((r) => setTimeout(r, 800 * i));
      }
    }
  }

  const remote = {
    state: () =>
      fetchJson(CFG.apiUrl + "?action=state" + (testKey ? "&test=" + encodeURIComponent(testKey) : ""), { cache: "no-store" }),
    me: (nick) => fetchJson(CFG.apiUrl + "?action=me&nick=" + encodeURIComponent(nick), { cache: "no-store" }),
    // text/plain - чтобы браузер не делал preflight-запрос, который Apps Script не поддерживает
    call: (action, data) =>
      fetchJson(CFG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ action }, data)),
      }),
    register: (v) => remote.call("register", v),
    login: (nick) => remote.call("login", { nick }),
    scan: (v) => remote.call("scan", v),
    admin: (op, v) => remote.call("admin", Object.assign({ op, key: testKey }, v)),
  };

  /* ================= демо ================= */

  // строится только в демо-режиме: на рабочем сайте data.js может и не загрузиться
  const demo = !DEMO ? null : (function () {
    const R = window.RACE;
    const START = Date.parse(R.start);
    const at = (m) => START + m * MIN;
    const byId = Object.fromEntries(R.checkpoints.map((c) => [c.id, c]));
    let mode = params.get("demo") || "reg";
    let mine = []; // сканы демо-участника
    const regs = { [R.demoUser.nick]: { amount: 300, paid: true } };
    const price = (g) => (g === "Ж" ? 0 : Date.now() < Date.parse("2026-10-26T00:00:00+03:00") ? 300 : 600);

    // как на сервере: первый на точке получает 10, следующий на 1 меньше (не меньше 1), × ценность
    const placePts = (value, place) => value * Math.max(10 - (place - 1), 1);
    function board() {
      const all = R.riders.map((r) => ({ nick: r.nick, scans: r.scans.map(([id, m]) => [id, at(m)]) }));
      if (mine.length) all.push({ nick: R.demoUser.nick, scans: mine });
      const flat = [];
      all.forEach((r) => r.scans.forEach(([id, t]) => flat.push({ nick: r.nick, id, t })));
      const placed = {};
      const rows = {};
      flat.sort((a, b) => a.t - b.t).forEach((x) => {
        const place = (placed[x.id] = (placed[x.id] || 0) + 1);
        const pts = placePts(byId[x.id].value, place);
        const r = rows[x.nick] || (rows[x.nick] = { nick: x.nick, score: 0, reachedAt: 0, scans: [] });
        r.score += pts;
        r.reachedAt = Math.max(r.reachedAt, x.t);
        r.scans.push([x.id, x.t, place, pts]);
      });
      return Object.values(rows).sort((a, b) => b.score - a.score || a.reachedAt - b.reachedAt);
    }

    return {
      setMode(m) {
        mode = m;
        mine = m === "reg" || m === "pay" ? [] : R.demoUser.scans.map(([id, m2]) => [id, at(m2)]);
      },
      fakePosition(cpId, far) {
        const c = byId[cpId];
        return far ? { lat: c.lat + 0.015, lng: c.lng + 0.02, accuracy: 12 } : { lat: c.lat + 0.0002, lng: c.lng + 0.0002, accuracy: 12 };
      },
      async state() {
        const END = Date.parse(R.end);
        const t = mode === "reg" || mode === "pay" ? Date.now() : mode === "results" ? END + 10 * MIN : at(75);
        const s = { now: t, start: START, end: END, radius: R.radius, open: t >= START, results: t > END };
        if (s.open) s.checkpoints = R.checkpoints;
        if (s.results) s.leaderboard = board(); // во время гонки топ скрыт
        return s;
      },
      async register(v) {
        const nick = cleanNick(v.telegram);
        const already = Boolean(regs[nick]);
        if (!already) regs[nick] = { amount: price(v.gender), paid: price(v.gender) === 0 };
        return { ok: true, nick, already, ...regs[nick] };
      },
      async me(nick) {
        const n = cleanNick(nick);
        return { ok: true, nick: n, ...(regs[n] || { amount: price("М"), paid: false }), scans: n === R.demoUser.nick ? mine : [] };
      },
      async login(nick) {
        const n = cleanNick(nick);
        const saved = store.get();
        return n === R.demoUser.nick || (saved && saved.nick === n)
          ? { ok: true, nick: n, ...(regs[n] || { amount: 300, paid: false }) }
          : { ok: false, error: "Не нашли @" + (n || nick) + " среди зарегистрированных" };
      },
      async scan(v) {
        const c = byId[v.cp];
        if (!c) return { ok: false, error: "Такой точки нет" };
        const had = mine.find((x) => x[0] === v.cp);
        if (had) return { ok: true, already: true, cp: v.cp, at: had[1] };
        if (mine.some((x) => byId[x[0]].final)) return { ok: false, error: "Ты уже отметил финиш, после него точки не засчитываются" };
        const d = distanceM(v, c);
        if (d > R.radius) return { ok: false, far: true, distance: Math.round(d), radius: R.radius, cp: v.cp };
        const t = at(75);
        const place = board().reduce((n, r) => n + r.scans.filter((x) => x[0] === v.cp).length, 0) + 1;
        mine.push([v.cp, t]);
        return { ok: true, cp: v.cp, value: placePts(c.value, place), place, distance: Math.round(d), at: t };
      },
    };
  })();

  const api = DEMO ? demo : remote;

  /* ================= утилиты ================= */

  function cleanNick(v) {
    const nick = String(v || "").trim().toLowerCase().replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "");
    return /^[a-z0-9_]{3,32}$/.test(nick) ? nick : "";
  }

  const fmtTime = (ms) =>
    new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: CFG.timezone || "Europe/Moscow" });

  function distanceM(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // в списке - уменьшенное фото с Google Диска (полное открывается по нажатию)
  const preview = (url, w) => url.replace(/(drive\.google\.com\/thumbnail\?.*\bsz=)w\d+/, "$1w" + (w || 640));

  // время старта берём из таблицы («Настройки → Старт»), а не из текста страницы
  const startFmt = (opts) =>
    new Date(state ? state.start : Date.parse("2026-10-30T20:00:00+03:00"))
      .toLocaleString("ru-RU", Object.assign({ timeZone: CFG.timezone || "Europe/Moscow" }, opts));
  const START_PARTS = {
    time: () => startFmt({ hour: "2-digit", minute: "2-digit" }),
    date: () => startFmt({ day: "numeric", month: "long" }),
    dm: () => startFmt({ day: "2-digit", month: "2-digit" }),
    weekday: () => startFmt({ weekday: "long" }),
  };
  const startPhrase = () => START_PARTS.date() + " в " + START_PARTS.time();
  function fillStartTexts() {
    document.querySelectorAll("[data-start]").forEach((el) => {
      const part = START_PARTS[el.dataset.start];
      if (part) el.textContent = part();
    });
  }

  const fmtDistance = (m) => (m < 1000 ? Math.round(m) + " м" : (m / 1000).toFixed(1).replace(".", ",") + " км");

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const cpName = (id) => ((state && state.checkpoints) || []).find((c) => c.id === id)?.name || "Точка";

  // топ и «кто где был» приходят только организатору и после конца аллейката
  const resultsOpen = () => Boolean(state && state.leaderboard);

  function myRow() {
    const board = (state && state.leaderboard) || [];
    const i = board.findIndex((r) => r.nick === user.nick);
    return i >= 0 ? { ...board[i], place: i + 1 } : { nick: user.nick, score: null, scans: myScans, place: null };
  }

  /* ================= загрузка ================= */

  async function refresh() {
    try {
      const s = await api.state();
      if (s.ok === false) throw new Error(s.error);
      state = s;
      clockOffset = s.now - Date.now();
    } catch (err) {
      if (!state) $("countdown").textContent = "нет связи с сервером";
      return;
    }
    render();
  }

  /* ================= отрисовка ================= */

  function render() {
    if (!state) return;
    fillStartTexts();
    const on = raceOn();
    if (on && !state.open) return refresh(); // старт наступил - забираем точки
    $("reg-view").hidden = on;
    $("race-view").hidden = !on;
    if (on) renderRace();
    else tickCountdown();
    if (DEMO) {
      const cur = params.get("demo") || (on ? (user ? "racer" : "guest") : "reg");
      document.querySelectorAll(".demo button").forEach((b) => b.classList.toggle("is-active", b.dataset.demo === cur));
    }
  }

  function tickCountdown() {
    const left = state.start - now();
    if (left <= 0) return render();
    const d = Math.floor(left / (24 * 60 * MIN));
    const h = Math.floor((left / (60 * MIN)) % 24);
    const m = Math.floor((left / MIN) % 60);
    $("countdown").textContent = d + " д " + String(h).padStart(2, "0") + " ч " + String(m).padStart(2, "0") + " мин";
  }

  // «2 ч 05 мин» / «3 д 04 ч 12 мин»
  function fmtLeft(ms) {
    const d = Math.floor(ms / (24 * 60 * MIN));
    const h = Math.floor((ms / (60 * MIN)) % 24);
    const m = Math.floor((ms / MIN) % 60);
    return (d ? d + " д " : "") + (d || h ? String(h).padStart(d ? 2 : 1, "0") + " ч " : "") + String(m).padStart(2, "0") + " мин";
  }

  const raceEnded = () => state && state.end && now() >= state.end;

  function renderRace() {
    const ended = raceEnded();
    $("live").classList.toggle("is-ended", Boolean(ended));
    // вместо часов — сколько осталось до конца аллейката
    $("race-clock").textContent = ended ? fmtTime(state.end) : state.end ? fmtLeft(state.end - now()) : fmtTime(now());
    $("live-label").textContent = ended ? "Аллейкат завершён" : "Аллейкат идёт";
    $("live-sub").textContent = ended
      ? "Итоги ниже, во вкладке «Топ»"
      : state.end ? "До конца. В " + fmtTime(state.end) + " сканы перестанут засчитываться" : "Регистрация закрыта";
    $("race-join").hidden = Boolean(user);
    $("me").hidden = !user;
    if (user) renderMe();
    // вкладка «Топ» только когда топ открыт
    document.querySelector(".tabs").hidden = !resultsOpen();
    if (!resultsOpen() && !$("tab-top").hidden) document.querySelector('[data-tab="points"]').click();
    renderCheckpoints();
    if (resultsOpen()) renderBoard();
  }

  // обычные точки (без финиша)
  const scanPoints = () => state.checkpoints.filter((c) => !c.final);

  function renderMe() {
    const me = myRow();
    $("me").innerHTML =
      '<span class="me__nick">@' + esc(me.nick) + "</span>" +
      (resultsOpen() ? '<span class="me__stat"><b>' + (me.score || 0) + "</b> очк.</span>" : "") +
      '<span class="me__stat"><b>' + me.scans.length + "/" + state.checkpoints.length + "</b> точек</span>" +
      (resultsOpen() ? '<span class="me__stat me__place"><b>' + (me.place ? "#" + me.place : "-") + "</b> в топе</span>" : "") +
      (payment && !payment.paid ? '<span class="me__warn">оплата пока не подтверждена</span>' : "");
  }


  // кто и когда уже отметил точку — по порядку прибытия
  function arrivals(cpId) {
    const list = [];
    ((state && state.leaderboard) || []).forEach((r) =>
      r.scans.forEach((x) => { if (x[0] === cpId) list.push({ nick: r.nick, at: x[1], place: x[2] }); })
    );
    return list.sort((a, b) => a.at - b.at).map((x, i) => Object.assign(x, { place: x.place || i + 1 }));
  }

  function renderCheckpoints() {
    const taken = {}; // id точки → [время, место, очки]
    if (user) myRow().scans.forEach((x) => (taken[x[0]] = x.slice(1)));
    // финиш в конце списка
    const list = scanPoints().concat(state.checkpoints.filter((c) => c.final));
    $("cps").innerHTML = list
      .map((c) => {
        const t = taken[c.id];
        const n = arrivals(c.id).length;
        return (
          '<li class="cp' + (c.final ? " cp--final" : "") + (t ? " cp--done" : "") + '" data-cp="' + esc(c.id) +
            '" tabindex="0" role="button" aria-label="' + esc(c.name) + ': подробнее">' +
          '<span class="cp__value" title="ценность точки">×' + c.value + "</span>" +
          '<div class="cp__body">' +
          (c.final ? '<span class="cp__flag">финиш</span>' : "") +
          "<h3>" + esc(c.name) + "</h3>" +
          '<p class="cp__meta">' +
            (resultsOpen()
              ? (n ? "приехали: " + n : "пока никого") + (t ? ' · <b class="cp__mine">ты ' + (t[1] ? t[1] + "-й" : "✓") + "</b>" : "")
              : t ? '<b class="cp__mine">✓ взята в ' + fmtTime(t[0]) + "</b>" : user ? "не взята" : "") + "</p>" +
          "</div>" +
          (c.photo
            ? '<img class="cp__thumb" src="' + esc(preview(c.photo, 160)) + '" alt="" loading="lazy" onerror="this.remove()">'
            : '<span class="cp__chev" aria-hidden="true">›</span>') +
          "</li>"
        );
      })
      .join("");
    if (openCp) renderCpSheet(openCp);
  }

  /* ---------- страница точки ---------- */

  let openCp = null;

  function renderCpSheet(id) {
    const c = state.checkpoints.find((x) => x.id === id);
    if (!c) return closeCpSheet();
    const map = "https://yandex.ru/maps/?pt=" + c.lng + "," + c.lat + "&z=17&l=map";
    const who = arrivals(id);
    $("cp-sheet-body").innerHTML =
      (c.photo
        ? '<a class="cpd__photo" href="' + esc(c.photo) + '" target="_blank" rel="noopener" title="Открыть фото целиком">' +
          '<img src="' + esc(preview(c.photo)) + '" alt="' + esc(c.name) + '" onerror="this.parentNode.remove()"></a>'
        : "") +
      '<div class="cpd__head">' +
        '<span class="cp__value">×' + c.value + "</span>" +
        "<div>" + (c.final ? '<span class="cp__flag">финиш</span>' : "") + "<h2>" + esc(c.name) + "</h2></div>" +
      "</div>" +
      (c.final ? '<p class="cpd__desc">Отмечается последним: после финиша точки не засчитываются.</p>' : "") +
      (c.description ? '<p class="cpd__desc">' + esc(c.description) + "</p>" : "") +
      '<a class="cpd__map" href="' + map + '" target="_blank" rel="noopener">Открыть на карте ↗</a>' +
      (c.qrPhoto
        ? '<h3 class="cpd__sub">Где висит QR</h3>' +
          '<a class="cpd__photo" href="' + esc(c.qrPhoto) + '" target="_blank" rel="noopener" title="Открыть фото целиком">' +
          '<img src="' + esc(preview(c.qrPhoto)) + '" alt="Где висит QR: ' + esc(c.name) + '" loading="lazy" onerror="this.parentNode.remove()"></a>'
        : "") +
      (!resultsOpen() ? "" :
      '<h3 class="cpd__sub">Уже приехали' + (who.length ? " · " + who.length : "") + "</h3>" +
      (who.length
        ? '<ol class="arrivals">' + who.map((x) =>
            '<li class="' + (user && x.nick === user.nick ? "is-me" : "") + '">' +
            '<span class="arrivals__place">' + x.place + "</span>" +
            '<span class="arrivals__nick">@' + esc(x.nick) + "</span>" +
            '<span class="arrivals__time">' + fmtTime(x.at) + "</span></li>").join("") + "</ol>"
        : '<p class="cpd__empty">Пока никого.</p>'));
  }

  function openCpSheet(id) {
    openCp = id;
    renderCpSheet(id);
    $("cp-sheet").hidden = false;
    $("cp-sheet").querySelector(".sheet__card").focus();
  }

  function closeCpSheet() {
    openCp = null;
    $("cp-sheet").hidden = true;
  }

  $("cps").addEventListener("click", (e) => {
    const li = e.target.closest("[data-cp]");
    if (li) openCpSheet(li.dataset.cp);
  });
  $("cps").addEventListener("keydown", (e) => {
    const li = e.target.closest("[data-cp]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCpSheet(li.dataset.cp); }
  });
  $("cp-sheet-close").addEventListener("click", closeCpSheet);
  $("cp-sheet").addEventListener("click", (e) => { if (e.target === $("cp-sheet")) closeCpSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openCp) closeCpSheet(); });


  function renderBoard() {
    const board = state.leaderboard;
    if (!board.length) {
      $("board").innerHTML = '<li class="board__empty">Пока никто не отсканировал ни одной точки</li>';
      return;
    }
    $("board").innerHTML = board
      .map((r, i) => {
        const has = new Set(r.scans.map((s) => s[0]));
        const dots = scanPoints().concat(state.checkpoints.filter((c) => c.final))
          .map((c) => '<i class="' + (has.has(c.id) ? "on" : "") + (c.final ? " fin" : "") + '"></i>').join("");
        return (
          '<li class="row' + (user && r.nick === user.nick ? " row--me" : "") + (i < 3 ? " row--top" : "") + '">' +
          '<span class="row__place">' + (i + 1) + "</span>" +
          '<div class="row__who"><b>@' + esc(r.nick) + '</b><span class="row__dots">' + dots + "</span></div>" +
          '<div class="row__score"><b>' + r.score + "</b><small>к " + fmtTime(r.reachedAt) + "</small></div>" +
          "</li>"
        );
      })
      .join("");
  }

  /* ================= вход ================= */

  function signIn(nick) {
    user = { nick };
    store.set({ nick });
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = $("login-nick").value;
    if (!cleanNick(raw)) return ($("login-error").textContent = "Ник в Telegram: латиница, цифры и _");
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const res = await api.login(raw);
      if (!res.ok) return ($("login-error").textContent = res.error);
      $("login-error").textContent = "";
      signIn(res.nick);
      payment = { amount: res.amount, paid: res.paid };
      await loadMyStatus();
      render();
      if (pendingScan) scan(...pendingScan);
    } catch (err) {
      $("login-error").textContent = "Нет связи с сервером, попробуй ещё раз";
    } finally {
      btn.disabled = false;
    }
  });

  /* ================= вкладки ================= */

  document.querySelectorAll(".tabs__btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs__btn").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-selected", b === btn);
      });
      $("tab-points").hidden = btn.dataset.tab !== "points";
      $("tab-top").hidden = btn.dataset.tab !== "top";
    })
  );

  /* ================= скан QR ================= */
  // QR-код на точке - ссылка вида  https://сайт/?cp=<id>&k=<секрет>.
  // Камера телефона открывает сайт, берём геолокацию, сервер проверяет секрет и расстояние.

  function showSheet(kind, title, text, step, icon, action) {
    const sheet = $("scan-sheet");
    sheet.hidden = false;
    sheet.dataset.state = kind;
    $("scan-step").textContent = step;
    $("scan-icon").textContent = icon;
    $("scan-title").textContent = title;
    $("scan-text").innerHTML = text;
    $("scan-close").textContent = action || "К точкам";
    $("scan-extra").hidden = true;
    sheet.querySelector(".sheet__card").focus();
  }

  /* ---------- тестовый скан: расклейка и разработка ---------- */

  let testPos = null; // где стоял организатор при последнем тестовом скане

  async function testScan(cp, k) {
    const name = cpName(cp);
    showSheet("wait", name, "Определяем, где ты стоишь…", "Тест · геолокация", "📍");
    try {
      testPos = await getPosition();
    } catch (err) {
      return showSheet("far", name, err.message, "Тест · нет геолокации", "✗");
    }
    let res;
    try {
      res = await api.scan({ test: testKey, cp, k, lat: testPos.lat, lng: testPos.lng, accuracy: testPos.accuracy });
    } catch (err) {
      return showSheet("far", name, "Нет связи с сервером.", "Тест · ошибка сети", "✗");
    }
    if (!res.ok) return showSheet("far", name, esc(res.error), "Тест · QR не подошёл", "✗");
    const gps = "Точность GPS ±" + res.accuracy + " м.";
    let text;
    if (!res.hasCoords) text = "QR от этой точки ✓<br>У точки в таблице нет координат.";
    else if (res.inRadius) text = "QR от этой точки ✓<br>До координат из таблицы <b>" + fmtDistance(res.distance) + "</b>, скан засчитается.";
    else text = "QR от этой точки ✓, но до её координат в таблице <b>" + fmtDistance(res.distance) +
      "</b>, гонщику скан <b>не засчитается</b> (радиус " + res.radius + " м).";
    showSheet(res.inRadius ? "ok" : "far", res.name || name, text + "<br><small>" + gps + "</small>",
      "Тест · " + cp, res.inRadius ? "✓" : "!", "Готово");
    const extra = $("scan-extra");
    extra.hidden = false;
    extra.dataset.cp = cp;
    extra.textContent = res.inRadius ? "Уточнить координаты точки по моему месту" : "Записать сюда координаты точки";
  }

  $("scan-extra").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const cp = btn.dataset.cp;
    btn.disabled = true;
    try {
      const res = await api.admin("coords", { id: cp, lat: testPos.lat, lng: testPos.lng });
      if (!res.ok) throw new Error(res.error);
      showSheet("ok", cpName(cp), "Координаты точки в таблице: <b>" + esc(res.coords) + "</b>", "Тест · координаты записаны", "✓", "Готово");
      refresh();
    } catch (err) {
      showSheet("far", cpName(cp), esc(err.message || "Не получилось записать координаты"), "Тест · ошибка", "✗", "Готово");
    } finally {
      btn.disabled = false;
    }
  });

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Браузер не даёт геолокацию. Открой ссылку в Chrome или Safari."));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => reject(new Error("Без геолокации точку не засчитать. Разреши доступ в настройках браузера и отсканируй код ещё раз.")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  async function scan(cp, k, fakePosition) {
    if (testKey) return testScan(cp, k);
    if (raceEnded()) return showSheet("far", cpName(cp), "Аллейкат закончился, сканы больше не принимаются.", "Финиш гонки", "⏱");
    if (!raceOn()) return showSheet("far", "Ещё рано", "Сканы засчитываются с момента старта.", "До старта", "⏳");
    const name = cpName(cp);
    if (!user) {
      pendingScan = [cp, k, fakePosition];
      return showSheet("far", name, "Войди ником из регистрации, и точка засчитается сразу после входа.", "Нужен вход", "@", "Войти");
    }
    pendingScan = null;

    showSheet("wait", name, "Разреши доступ к геолокации, чтобы засчитать точку.", "Проверяем геолокацию…", "📍");
    let pos;
    try {
      pos = fakePosition || (await getPosition());
    } catch (err) {
      return showSheet("far", name, err.message, "Нет геолокации", "✗");
    }

    showSheet("wait", name, "Отправляем скан…", "Проверяем геолокацию…", "📍");
    let res;
    try {
      res = await api.scan({ nick: user.nick, cp, k, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy });
    } catch (err) {
      return showSheet("far", name, "Нет связи с сервером. Проверь интернет и отсканируй код ещё раз.", "Ошибка сети", "✗");
    }

    if (res.far) {
      return showSheet("far", name,
        "Ты в <b>" + fmtDistance(res.distance) + "</b> от точки. Скан засчитывается в радиусе " + res.radius + " м. Подъедь ближе и отсканируй ещё раз.",
        "Слишком далеко", "✗");
    }
    if (!res.ok) return showSheet("far", name, esc(res.error), "Не засчитано", "✗");
    if (res.already) return showSheet("ok", name, "Эта точка у тебя уже есть.", "Взята в " + fmtTime(res.at), "✓");

    await refresh();
    await loadMyStatus();
    const isFinal = (state.checkpoints.find((c) => c.id === cp) || {}).final;
    showSheet("ok", name,
      isFinal ? "Финиш! Паркуй велик, внутри награждение и туса." : "",
      "Точка засчитана · " + fmtTime(res.at), "✓");
  }

  $("scan-close").addEventListener("click", () => {
    $("scan-sheet").hidden = true;
    if (pendingScan && !user) {
      $("race-join").scrollIntoView({ behavior: "smooth", block: "center" });
      $("login-nick").focus({ preventScroll: true });
    }
    if (params.has("cp")) {
      params.delete("cp");
      params.delete("k");
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
    }
  });

  /* ================= регистрация ================= */

  const form = $("reg-form");
  const done = $("done");
  const submit = form.querySelector(".submit");
  const genderHint = $("gender-hint");
  const REQUIRED = "Это обязательный вопрос";

  function setError(name, message) {
    const field = form.querySelector('[data-field="' + name + '"]');
    field.classList.toggle("is-invalid", Boolean(message));
    field.querySelector(".field__error").textContent = message || "";
  }

  // ник для сообщения к переводу - прямо рядом с номером, где люди и платят
  function showFormNick() {
    const nick = cleanNick(form.telegram.value);
    const btn = $("form-nick");
    btn.hidden = !nick;
    btn.textContent = "@" + nick;
    btn.dataset.copy = "@" + nick;
  }

  form.addEventListener("input", (e) => {
    if (e.target.name) setError(e.target.name, "");
    if (e.target.name === "telegram") showFormNick();
    $("form-status").textContent = "";
  });

  form.addEventListener("change", (e) => {
    if (e.target.name === "gender") genderHint.hidden = e.target.value !== "Ж";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const checked = form.querySelector('input[name="gender"]:checked');
    const v = { telegram: form.telegram.value, gender: checked ? checked.value : "", payment: form.payment.value.trim() };
    const errors = {
      telegram: !v.telegram.trim() ? REQUIRED : !cleanNick(v.telegram) ? "Ник в Telegram: латиница, цифры и _ (от 3 символов)" : "",
      gender: v.gender ? "" : REQUIRED,
      payment: v.payment ? "" : REQUIRED,
    };
    Object.keys(errors).forEach((k) => setError(k, errors[k]));
    const firstInvalid = Object.keys(errors).find((k) => errors[k]);
    if (firstInvalid) return form.querySelector('[name="' + firstInvalid + '"]').focus();

    submit.classList.add("is-loading");
    submit.disabled = true;
    try {
      const res = await api.register(v);
      if (!res.ok) {
        $("form-status").textContent = res.error;
        return;
      }
      signIn(res.nick);
      showDone(res, res.already
        ? "@" + res.nick + " уже был в списке, всё в силе."
        : startPhrase() + " здесь появятся точки маршрута. Не забудь шлем.");
      done.focus();
    } catch (err) {
      $("form-status").textContent = "Нет связи с сервером, попробуй ещё раз";
    } finally {
      submit.classList.remove("is-loading");
      submit.disabled = false;
    }
  });

  $("again").addEventListener("click", () => {
    form.reset();
    genderHint.hidden = true;
    showFormNick();
    done.hidden = true;
    form.hidden = false;
    form.telegram.focus();
  });

  /* ================= оплата ================= */

  function showDone(status, text) {
    form.hidden = true;
    done.hidden = false;
    $("done-text").textContent = text;
    renderPayment(status);
  }

  function renderPayment(status) {
    payment = { amount: status.amount, paid: status.paid };
    const box = $("paybox");
    const free = status.amount === 0;
    box.dataset.state = free ? "free" : status.paid ? "paid" : "wait";
    $("pay-badge").textContent = free ? "бесплатно" : status.paid ? "оплачено ✓" : "ждём перевод";
    $("pay-sum").textContent = free ? "0 ₽" : status.amount + " ₽";
    $("pay-sum-copy").textContent = status.amount + " ₽";
    $("pay-sum-copy").dataset.copy = String(status.amount);
    $("pay-nick").textContent = "@" + status.nick;
    $("pay-nick").dataset.copy = "@" + status.nick;
    $("pay-note").textContent = free
      ? "Для девушек участие бесплатное, платить ничего не нужно."
      : status.paid
        ? "Оплата подтверждена. Увидимся " + startPhrase() + "!"
        : "Как только увидим перевод, отметим оплату, и статус здесь сменится.";
  }

  async function loadMyStatus() {
    if (!user) return;
    try {
      const res = await api.me(user.nick);
      if (!res.ok) return;
      payment = { amount: res.amount, paid: res.paid };
      if (res.scans) myScans = res.scans;
      if (!raceOn()) showDone(res, "@" + res.nick + ", ты в списке. " + startPhrase() + " здесь появятся точки маршрута.");
      else render();
    } catch (err) { /* статус оплаты не критичен - покажем в следующий раз */ }
  }

  $("pay-refresh").addEventListener("click", async (e) => {
    e.target.disabled = true;
    await loadMyStatus();
    e.target.disabled = false;
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy");
    if (!btn) return;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "скопировано ✓";
    } catch (err) {
      btn.textContent = btn.dataset.copy;
    }
    setTimeout(() => (btn.textContent = label), 1500);
  });

  /* ================= переключатель состояний (только демо) ================= */

  async function applyDemo(mode) {
    demo.setMode(mode);
    params.set("demo", mode);
    $("scan-sheet").hidden = true;
    user = null;
    pendingScan = null;
    payment = null;
    form.hidden = false;
    done.hidden = true;
    if (!["reg", "pay", "guest", "scan-guest"].includes(mode)) signIn(window.RACE.demoUser.nick);
    if (mode === "racer") payment = { amount: 300, paid: false };
    await refresh();
    if (user && mode !== "pay") await loadMyStatus();
    if (mode === "pay") {
      const res = await demo.register({ telegram: "night_rider", gender: "М" });
      signIn(res.nick);
      showDone(res, startPhrase() + " здесь появятся точки маршрута. Не забудь шлем.");
    }
    if (mode === "scan-ok") scan("c6", "demo", demo.fakePosition("c6"));
    if (mode === "scan-far") scan("c5", "demo", demo.fakePosition("c5", true));
    if (mode === "scan-guest") scan("c6", "demo", demo.fakePosition("c6"));
  }

  const demoNav = document.querySelector(".demo");
  demoNav.hidden = !DEMO;
  demoNav.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      history.replaceState(null, "", "?demo=" + b.dataset.demo);
      applyDemo(b.dataset.demo);
    })
  );

  $("test-exit").addEventListener("click", () => {
    try { localStorage.removeItem("fgk_test"); } catch (e) { /* приватный режим */ }
    location.reload();
  });

  /* ================= старт ================= */

  (async function init() {
    if (DEMO && params.has("demo")) return applyDemo(params.get("demo"));
    const saved = store.get();
    if (saved && cleanNick(saved.nick)) user = { nick: saved.nick };
    if (DEMO) demo.setMode("reg");
    if (testKey) $("testbar").hidden = false;
    await refresh();
    loadMyStatus();
    if (params.has("cp")) scan(params.get("cp"), params.get("k"));
  })();

  // во время гонки обновляем топ, до старта - только отсчёт
  setInterval(() => (raceOn() ? refresh().then(loadMyStatus) : state && tickCountdown()), 20 * 1000);
})();
