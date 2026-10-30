// БЕЗОПАСНАЯ ТЕСТОВАЯ КОПИЯ: настройки и точки синхронизированы с Google Таблицей.
// Секреты QR, регистрации и боевые сканы сюда намеренно не попадают.
window.RACE = {
  // старт аллейката = закрытие регистрации, конец - сканы больше не принимаются (МСК)
  start: "2026-10-30T21:00:00+03:00",
  end: "2026-10-30T23:00:00+03:00",
  // скан засчитывается, если телефон не дальше этого радиуса от точки, м
  radius: 150,

  checkpoints: [
    { id: "p1", name: "Куллар", lat: 55.744481, lng: 49.132111, value: 3,
      description: "Артур Гришагин — один из тех, с кого начинался Fixed Gear Kazan в 2013 году. «Лекция профессора Гришагина»: https://www.youtube.com/watch?v=Z5k3jcwvkG4",
      photo: "https://drive.google.com/thumbnail?id=11kVOay2O5DWvtTmq6zM-wWxDXuQpL-Bz&sz=w1200" },
    { id: "p2", name: "Сквер Тукая", lat: 55.785161, lng: 49.120479, value: 2,
      description: "Точка сбора на классический маршрут «Петля». Ещё есть «Очко» и «Додо».",
      photo: "https://drive.google.com/thumbnail?id=1rAoLdZQX4xH2-7_JMngWCVOrvikQDyDh&sz=w1200" },
    { id: "fin", name: "bass_u x werk", lat: 55.764974, lng: 49.125359, value: 2, final: true,
      description: "Финиш в Werk. Туса DSP приютила нас на своём мероприятии — спасибо.",
      photo: "https://drive.google.com/thumbnail?id=1luLsL4qb4ZqBRFzi9gFGqqS0V-l6bLzC&sz=w1200" },
    { id: "p3", name: "Спуск Касаткина", lat: 55.802068, lng: 49.122441, value: 4,
      description: "Место, где зубы Омара попали в городскую ливнёвку. Aura +999.",
      photos: ["https://drive.google.com/thumbnail?id=1vGk29JcQkCAGeELP_L5ioFEWJvUlDge0&sz=w1200", "https://drive.google.com/thumbnail?id=1Lex-ocE-8sZ0l9NQtyyDKSkfbKQEC5Wr&sz=w1200"] },
    { id: "p4", name: "Cherry CC", lat: 55.783933, lng: 49.148613, value: 3,
      description: "Надежда казанского FG и штаб FG ПФО. В 2025 году это был хоум-спот, где всегда был движ.",
      photo: "https://drive.google.com/thumbnail?id=15LwgEXqjDucKOrBnoXaWj3hFcfNtwC0t&sz=w1200" },
    { id: "p5", name: "Гараж AXL custom", lat: 55.779844, lng: 49.150397, value: 3,
      description: "Антон уже ждёт вас на следующем виде транспорта после фикса. Кино-рекомендация: Line of Sight — культовый документальный фильм про FG.",
      photo: "https://drive.google.com/thumbnail?id=1qwS-bUUaCoTWYfGjnMWniiK7xudgGE6M&sz=w1200" },
    { id: "p6", name: "Кольцо на Петербургской", lat: 55.783430, lng: 49.128361, value: 2,
      description: "Почувствуй вайб 2015 года.",
      photo: "https://entermedia.io/wp-content/uploads/2018/05/IMG_0014-1-1024x597.jpg" },
    { id: "p7", name: "Чайная гуру", lat: 55.791919, lng: 49.137814, value: 2,
      description: "Спот для множества гонок и эвентов. Статья Criterium и репортаж с закрытия сезона 2023.",
      photos: ["https://drive.google.com/thumbnail?id=1ofSyIWAngNKAjo0bez1qG2kckvK3-1wI&sz=w1200", "https://drive.google.com/thumbnail?id=1mW1oTgUfi60wei4s1blu4FPDenQNmqaz&sz=w1200"] },
    { id: "p8", name: "Bike Polo BBK", lat: 55.806006, lng: 49.144642, value: 3,
      description: "Когда-то бодрый заряд на казанскую команду BP, который потух и, возможно, вспыхнет вновь…",
      photos: ["https://drive.google.com/thumbnail?id=1LwbP121Kq7TBbzvWPksNM1lGDfHRBV_3&sz=w1200", "https://drive.google.com/thumbnail?id=1ZQBrbJhXmVN2HWSW2NkKvU3GnqssyiAl&sz=w1200"] },
    { id: "p9", name: "Купель РНШ", lat: 55.807235, lng: 49.164905, value: 5,
      description: "Спот для здравых занятий и nature. Наслаждайся, пока Ак Барс Сити не застроит его успешными ЖК.",
      photo: "https://lh3.googleusercontent.com/d/177zA_roslj7GEuhgQFnoUpnsFMkiQ0gJ" },
  ],

  // сканы других участников: [id точки, минут после старта]
  riders: [],

  // демо-участник, который «вошёл» на сайт
  demoUser: { nick: "test_rider", scans: [["p1", 8], ["p4", 24], ["p2", 33]] },
};
