// Тест сервера без Google: node server/test/server.test.js
// Имитирует Google Таблицу в памяти и прогоняет регистрацию, вход, сканы и топ.
const assert=require('assert');const {load}=require('./gas-mock');
const {ctx,sheets,cache}=load();
ctx.setup();
const S=n=>sheets[n];
const get=()=>JSON.parse(ctx.doGet({parameter:{action:'state'}}).s);
const post=b=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(b)}}).s);
const setStart=ms=>{S('Настройки').data[0][1]=new Date(ms).toISOString();cache.clear();};

setStart(Date.now()+3600e3);
let st=get(); assert.equal(st.open,false); assert.equal(st.checkpoints,undefined);
let reg=post({action:'register',telegram:'@Fixie_Masha',gender:'Ж',payment:'бесплатно'});
assert.equal(reg.nick,'fixie_masha'); assert.equal(reg.amount,0); assert.equal(reg.paid,true);
assert.equal(post({action:'register',telegram:'fixie_masha',gender:'Ж',payment:'x'}).already,true);
assert.equal(post({action:'register',telegram:'Иван',gender:'М',payment:'x'}).ok,false);
// цена после повышения
const change=S('Настройки').data.find(r=>r[0]==='Повышение цены');
change[1]=new Date(Date.now()-86400e3).toISOString();
reg=post({action:'register',telegram:'bob_1',gender:'М',payment:'Боб'});
assert.equal(reg.ok,true); assert.equal(reg.amount,600); assert.equal(reg.paid,false);
// цена до повышения
change[1]=new Date(Date.now()+86400e3).toISOString();
assert.equal(post({action:'register',telegram:'early_bird',gender:'М',payment:'x'}).amount,300);
// статус оплаты
let me=JSON.parse(ctx.doGet({parameter:{action:'me',nick:'@bob_1'}}).s); assert.equal(me.paid,false); assert.equal(me.amount,600);
S('Регистрации').data[2][5]=true;
me=JSON.parse(ctx.doGet({parameter:{action:'me',nick:'bob_1'}}).s); assert.equal(me.paid,true);
assert.equal(JSON.parse(ctx.doGet({parameter:{action:'me',nick:'nobody'}}).s).ok,false);
assert.equal(post({action:'register',telegram:'blocked_guy',gender:'М',payment:'-'}).ok,true);
S('Регистрации').data[4][6]='нет';
assert.equal(S('Регистрации').data.length,5);
assert.equal(post({action:'login',nick:'@FIXIE_MASHA'}).nick,'fixie_masha');
assert.equal(post({action:'login',nick:'nobody'}).ok,false);
assert.match(post({action:'login',nick:'blocked_guy'}).error,/не допущен/);
const pts=S('Точки').data.slice(1); // старый вид строки [.., .., .., lat, lng, .., .., secret] - чтобы не переписывать проверки ниже
const old=r=>{const [la,ln]=r[2].split(',').map(Number);return [r[0],r[1],'',la,ln,r[3],r[4],r[5]];};
const [c1,c2,fin]=pts.map(old); 
let r=post({action:'scan',nick:'bob_1',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4],accuracy:10}); assert.equal(r.ok,false); assert.match(r.error,/старта/);
setStart(Date.now()-60e3);
assert.equal(post({action:'register',telegram:'late',gender:'М',payment:'x'}).ok,false);
st=get(); assert.equal(st.open,true); assert.equal(st.checkpoints.length,3); assert.ok(!('secret' in st.checkpoints[0]));
assert.equal(st.leaderboard,undefined,'во время гонки топ скрыт'); assert.equal(st.results,false);
const ADMIN=S('Настройки').data.find(r=>r[0]==='Ключ администратора')[1];
const getLB=()=>{cache.clear(); return JSON.parse(ctx.doGet({parameter:{action:'state',test:ADMIN}}).s).leaderboard;};
assert.deepEqual(getLB(),[]);
r=post({action:'scan',nick:'bob_1',cp:'c1',k:c1[7],lat:c1[3]+0.01,lng:c1[4],accuracy:10}); assert.equal(r.far,true); 
r=post({action:'scan',nick:'bob_1',cp:'c1',k:c1[7],lat:c1[3]+0.001,lng:c1[4],accuracy:10}); assert.equal(r.ok,true); assert.equal(r.place,undefined,'место не отдаём'); 
r=post({action:'scan',nick:'bob_1',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4]}); assert.equal(r.already,true);
r=post({action:'scan',nick:'blocked_guy',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4]}); assert.match(r.error,/не допущен/);
r=post({action:'scan',nick:'ghost',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4]}); assert.match(r.error,/Войди/);
r=post({action:'scan',nick:'bob_1',cp:'c2',k:c2[7],lat:c2[3],lng:c2[4],accuracy:900}); assert.match(r.error,/неточная/);
r=post({action:'scan',nick:'fixie_masha',cp:'c2',k:c2[7],lat:c2[3],lng:c2[4],accuracy:5}); assert.equal(r.ok,true);
r=post({action:'scan',nick:'bob_1',cp:'c2',k:c2[7],lat:c2[3],lng:c2[4],accuracy:5}); assert.equal(r.ok,true);
st=get();
// c2 ценность 2: masha первая (20), bob второй (18); c1: bob первый (10)
assert.deepEqual(getLB().map(x=>[x.nick,x.score]),[['bob_1',28],['fixie_masha',20]]);
// «Гонка только после оплаты»
S('Настройки').data.find(r=>r[0]==='Гонка только после оплаты')[1]='да';
r=post({action:'scan',nick:'early_bird',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4],accuracy:5}); assert.match(r.error,/Оплата/);
S('Настройки').data.find(r=>r[0]==='Гонка только после оплаты')[1]='нет';
// повторный setup не затирает настройки и не дублирует строки
const before=JSON.stringify(S('Настройки').data); ctx.setup(); assert.equal(JSON.stringify(S('Настройки').data),before);
r=post({action:'scan',nick:'fixie_masha',cp:'c1',k:c1[7],lat:c1[3],lng:c1[4],accuracy:5}); 
const L=getLB(); assert.deepEqual(L.map(x=>[x.nick,x.score]),[['fixie_masha',29],['bob_1',28]],'masha вторая на c1: +9');
assert.deepEqual(L[0].scans.map(x=>x.slice(2)),[[1,20],[2,9]],'в топе видно место и очки на каждой точке');
// правило очков: минимум, множитель, равенство по времени
{ const sx={firstPoints:3,minPoints:1}; const P=[{id:'a',value:1},{id:'b',value:2},{id:'f',value:5,final:true}];
  const sc=[['u1','a',1],['u2','a',2],['u3','a',3],['u4','a',4],['u4','b',5],['u3','b',6],['u1','f',7]].map(([nick,cp,at])=>({nick,cp,at}));
  const lb=ctx.leaderboard_(sx,P,sc).map(x=>[x.nick,x.score]);
  // a: 3,2,1,1 ; b(×2): u4 6, u3 4 ; финиш ×5: u1 первый 15
  assert.deepEqual(lb,[['u1',18],['u4',7],['u3',5],['u2',2]]);
  const P2=[{id:'a',value:1},{id:'c',value:1}];
  const tie=ctx.leaderboard_(sx,P2,[{nick:'y',cp:'c',at:2},{nick:'x',cp:'a',at:1}]).map(x=>[x.nick,x.score]);
  assert.deepEqual(tie,[['x',3],['y',3]],'при равенстве выше тот, кто набрал раньше'); }


// описание, фото и координаты точек; перестройка старых листов
const NEW_HEAD=["ID","Название","Координаты","Ценность","Финиш","Описание","Фото","Фото для сайта"];
{ const {load:l4}=require('./gas-mock'); const g4=l4();
  const pts=g4.ctx.SpreadsheetApp.getActive().insertSheet('Точки');
  // самый первый вид листа: широта/долгота отдельно, адрес и колонки QR
  pts.data=[["ID","Название","Адрес","Широта","Долгота","Ценность","Финиш","Секрет","Ссылка для QR","QR"],["c1","Мост","Наб., 1",55.75,37.61,2,"","sec1","",""]];
  g4.ctx.setup();
  assert.deepEqual(pts.data[0],NEW_HEAD);
  assert.deepEqual(pts.data[1].slice(0,5),["c1","Мост","55.75, 37.61",2,""],'ценность на месте, QR удалены');
  g4.ctx.setup(); assert.deepEqual(pts.data[0],NEW_HEAD,'повторный setup ничего не ломает');
  pts.data[1][5]='Под мостом, у третьей опоры';
  pts.data[1][6]='https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing';
  pts.data.push(["c2","Б","55.765000, 37.598000",1,"","","https://example.com/p.jpg",""],["c3","В","55,7; 37,6",1,"да","","не ссылка",""]);
  g4.ctx.refreshQr();
  g4.sheets['Настройки'].data.find(r=>r[0]==='Старт')[1]=new Date(Date.now()-1000).toISOString();
  const cps=JSON.parse(g4.ctx.doGet({parameter:{action:'state'}}).s).checkpoints;
  assert.deepEqual([cps[0].lat,cps[0].lng,cps[0].value],[55.75,37.61,2]); assert.ok(!('address' in cps[0])); assert.ok(!('qrPhoto' in cps[0]));
  assert.deepEqual([cps[1].lat,cps[1].lng],[55.765,37.598]); assert.deepEqual([cps[2].lat,cps[2].lng,cps[2].final],[55.7,37.6,true]);
  assert.equal(cps[0].description,'Под мостом, у третьей опоры');
  assert.equal(cps[0].photo,'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345&sz=w1200');
  assert.equal(cps[1].photo,'https://example.com/p.jpg'); assert.equal(cps[2].photo,''); assert.equal(cps[1].description,'');

  // фото, вставленное прямо в ячейку
  const img={getContentUrl:()=>'https://lh3.googleusercontent.com/tmp-image'};
  pts.data[3][6]=img; pts.data[3][5]='описание'; g4.ctx.refreshQr();
  assert.equal(g4.drive.files.length,1); assert.equal(g4.drive.files[0].name,'точка c3');
  assert.match(pts.data[3][7],/^https:\/\/drive\.google\.com\/file\/d\/file0+1\/view$/);
  assert.equal(pts.data[3][6],img,'ячейку с фото не трогаем'); assert.equal(pts.data[3][5],'описание');
  g4.cache.clear(); let c3=JSON.parse(g4.ctx.doGet({parameter:{action:'state'}}).s).checkpoints[2];
  assert.equal(c3.photo,'https://drive.google.com/thumbnail?id=file00000000000000000001&sz=w1200');
  g4.ctx.refreshQr(); assert.equal(g4.drive.files.length,1,'то же фото не перевыкладывается'); assert.match(pts.data[3][7],/file0+1\/view/);
  g4.drive.content['https://lh3.googleusercontent.com/tmp-image']='новое фото'; g4.ctx.refreshQr();
  assert.equal(g4.drive.files.length,2,'новое фото выкладывается'); assert.deepEqual(g4.drive.trashed,['file00000000000000000001']); assert.equal(g4.drive.folder,1);
  pts.data[3][6]=''; g4.ctx.refreshQr(); assert.equal(pts.data[3][7],''); assert.equal(g4.drive.trashed.length,2);
  g4.cache.clear(); assert.equal(JSON.parse(g4.ctx.doGet({parameter:{action:'state'}}).s).checkpoints[1].photo,'https://example.com/p.jpg');

  // фото поверх ячеек - подсказка, в каких точках
  pts.getImages=()=>[{getAnchorCell:()=>({getRow:()=>3})}];
  g4.ctx.refreshQr(); assert.match(g4.alerts[0],/точки: c2/);
}
// лист в нынешнем виде у организатора: колонки QR, описание и вставленное фото
{ const {load:l5}=require('./gas-mock'); const g5=l5();
  const pts=g5.ctx.SpreadsheetApp.getActive().insertSheet('Точки');
  const img={getContentUrl:()=>'https://lh3.googleusercontent.com/x'};
  pts.data=[["ID","Название","Координаты","Ценность","Финиш","Секрет","Ссылка для QR","QR","Описание","Фото","Фото для сайта","Фото QR","Фото QR для сайта"],
            ["fin","Клуб","55.7, 37.6",5,"да","secF","old","=IMAGE()","Вход со двора",img,"","",""]];
  g5.sheets['Настройки']=new (require('./gas-mock').Sheet)('Настройки'); g5.sheets['Настройки'].data=[["Старт","2026-10-30T20:00:00+03:00"],["Адрес сайта","https://x/"],["Радиус, м","150"]];
  g5.ctx.setup();
  assert.deepEqual(pts.data[0],NEW_HEAD);
  assert.deepEqual(pts.data[1].slice(0,6),["fin","Клуб","55.7, 37.6",5,"да","Вход со двора"]);
  assert.equal(pts.data[1][6],img); assert.match(pts.data[1][7],/drive\.google\.com\/file\/d\//);
  assert.ok(!g5.sheets['Настройки'].data.some(r=>r[0]==='Адрес сайта'),'«Адрес сайта» удалён');
  assert.equal(g5.sheets['Настройки'].data.find(r=>r[0]==='Радиус, м')[1],'150','остальные настройки на месте');
}

// пустые ID проставляются сами: fin для финиша, p1, p2… для остальных
{ const {load:l6}=require('./gas-mock'); const g6=l6();
  const pts=g6.ctx.SpreadsheetApp.getActive().insertSheet('Точки');
  pts.data=[NEW_HEAD,["","Мост","55.7, 37.6",1,"","","",""],["p1","Уже с ID","55.7, 37.6",1,"","","",""],
            ["","Клуб","55.7, 37.6",5,"да","","",""],["","","",'',"","","",""],["","Смотровая","",2,"","","",""]];
  g6.ctx.setup();
  assert.deepEqual(pts.data.slice(1).map(r=>r[0]),["p2","p1","fin","","p3"]);
}

// служебные команды по ключу администратора
{ const {load:l7}=require('./gas-mock'); const g7=l7(); g7.ctx.setup();
  const keyRow=g7.sheets['Настройки'].data.find(r=>r[0]==='Ключ администратора'); assert.match(keyRow[1],/^[0-9a-f]{32}$/);
  const key=keyRow[1]; g7.ctx.setup(); assert.equal(keyRow[1],key,'повторный setup ключ не меняет');
  const call=b=>JSON.parse(g7.ctx.doPost({postData:{contents:JSON.stringify(Object.assign({action:'admin'},b))}}).s);
  assert.equal(call({op:'points'}).error,'Нет доступа'); assert.equal(call({op:'points',key:'wrong'}).error,'Нет доступа');
  const pts=g7.sheets['Точки'].data; pts[1][0]='';
  const res=call({op:'refresh',key}); assert.equal(res.ok,true); assert.equal(res.points[0].id,'p1'); assert.ok(!('secret' in res.points[0]));
  assert.equal(res.points[2].id,'fin');
  assert.equal(call({op:'points',key}).points.length,3);
  g7.sheets['Настройки'].data=g7.sheets['Настройки'].data.filter(r=>r[0]!=='Очки за первое место');
  assert.equal(call({op:'setup',key}).done,true); assert.ok(g7.sheets['Настройки'].data.find(r=>r[0]==='Очки за первое место'),'setup по ключу дописал настройку');
  assert.equal(call({op:'setting',key,name:'Радиус, м',value:'200'}).value,'200');
  assert.match(call({op:'setting',key,name:'Ключ администратора',value:'x'}).error,/Нельзя/);
  assert.match(call({op:'setting',key,name:'Что-то',value:'x'}).error,/Нельзя/);
  keyRow[1]=''; assert.equal(call({op:'points',key:''}).error,'Нет доступа','пустой ключ не открывает');
}

// тестовый режим: точки до старта, тестовые сканы, координаты по месту
{ const {load:l8}=require('./gas-mock'); const g8=l8(); g8.ctx.setup();
  const key=g8.sheets['Настройки'].data.find(r=>r[0]==='Ключ администратора')[1];
  g8.sheets['Настройки'].data.find(r=>r[0]==='Старт')[1]=new Date(Date.now()+86400e3).toISOString();
  const get=t=>JSON.parse(g8.ctx.doGet({parameter:{action:'state',test:t}}).s);
  assert.equal(get(undefined).open,false); assert.equal(get('wrong').checkpoints,undefined,'без ключа точки скрыты');
  const st=get(key); assert.equal(st.open,true); assert.equal(st.test,true); assert.equal(st.checkpoints.length,3);
  const post=b=>JSON.parse(g8.ctx.doPost({postData:{contents:JSON.stringify(b)}}).s);
  const row=g8.sheets['Точки'].data[1]; const [la,ln]=row[2].split(',').map(Number);
  let r=post({action:'scan',test:key,cp:'c1',k:row[5],lat:la+0.0005,lng:ln,accuracy:8});
  assert.equal(r.ok,true); assert.equal(r.inRadius,true); assert.equal(r.distance,56);
  r=post({action:'scan',test:key,cp:'c1',k:row[5],lat:la+0.01,lng:ln}); assert.equal(r.inRadius,false); assert.equal(r.distance,1112);
  assert.match(post({action:'scan',test:'wrong',cp:'c1',k:row[5],lat:la,lng:ln}).error,/неверный ключ/);
  const scans=g8.sheets['Сканы'].data.slice(1); assert.deepEqual(scans.map(x=>x[6]),['тест: ok','тест: далеко']);
  assert.ok(scans.every(x=>x[1]==='(тест)'&&x[3]===0)); assert.deepEqual(get(key).leaderboard,[],'тест в топ не идёт');
  // записать координаты точки по месту
  assert.equal(post({action:'admin',op:'coords',key:'x',id:'c1',lat:1,lng:2}).error,'Нет доступа');
  r=post({action:'admin',op:'coords',key,id:'c1',lat:55.7612345,lng:49.1234567}); assert.equal(r.coords,'55.761235, 49.123457');
  assert.equal(row[2],'55.761235, 49.123457');
  assert.match(post({action:'admin',op:'coords',key,id:'nope',lat:1,lng:2}).error,/нет в таблице/);
  // фото точки из чата
  r=post({action:'admin',op:'photo',key,id:'c1',image:'data:image/jpeg;base64,aGVsbG8='}); assert.match(r.photo,/drive\.google\.com\/file\/d\//); assert.match(r.site,/thumbnail\?id=/);
  g8.cache.clear(); assert.match(get(key).checkpoints.find(c=>c.id==='c1').photo,/thumbnail\?id=/);
  g8.ctx.refreshQr(); g8.cache.clear(); assert.match(get(key).checkpoints.find(c=>c.id==='c1').photo,/thumbnail\?id=/,'refresh фото не стирает');
  assert.match(post({action:'admin',op:'photo',key,id:'nope',image:'aGVsbG8='}).error,/нет в таблице/);
}

// финиш: сканируется последним, после него точки не засчитываются
{ const {load:l9}=require('./gas-mock'); const g9=l9(); g9.ctx.setup();
  const S9=n=>g9.sheets[n]; const st=S9('Настройки').data.find(r=>r[0]==='Старт');
  st[1]=new Date(Date.now()+3600e3).toISOString();
  const post=b=>JSON.parse(g9.ctx.doPost({postData:{contents:JSON.stringify(b)}}).s);
  post({action:'register',telegram:'rider1',gender:'М',payment:'x'});
  st[1]=new Date(Date.now()-1000).toISOString();
  const row=id=>S9('Точки').data.find(r=>r[0]===id); const fin=row('fin'), c1=row('c1');
  const at=r=>r[2].split(',').map(Number);
  let r=post({action:'scan',nick:'rider1',cp:'fin',k:fin[5],lat:at(fin)[0],lng:at(fin)[1]}); assert.equal(r.ok,true);
  r=post({action:'scan',nick:'rider1',cp:'c1',k:c1[5],lat:at(c1)[0],lng:at(c1)[1]}); assert.match(r.error,/после него/);
  const K9=S9('Настройки').data.find(r=>r[0]==='Ключ администратора')[1];
  g9.cache.clear(); const lb=JSON.parse(g9.ctx.doGet({parameter:{action:'state',test:K9}}).s).leaderboard;
  assert.deepEqual(lb.map(x=>[x.nick,x.score,x.finished]),[['rider1',50,true]]);
  // строка после финиша, попавшая в «Сканы» вручную, не считается
  const t=Date.now()+5000; S9('Сканы').data.push([new Date(t),'rider1','c2',20,0,5,'ok']); g9.cache.clear();
  assert.equal(JSON.parse(g9.ctx.doGet({parameter:{action:'state',test:K9}}).s).leaderboard[0].score,50);
  // гонщик видит свои отметки, но не топ; после конца топ открыт всем
  const me=JSON.parse(g9.ctx.doGet({parameter:{action:'me',nick:'rider1'}}).s); assert.deepEqual(me.scans.map(x=>x[0]),['fin']);
  // отметка по фото: без QR и геолокации, ждёт проверки организатором
  post({action:'register',telegram:'jammed',gender:'М',payment:'x'}); // поздняя регистрация не пройдёт - старт уже был
  st[1]=new Date(Date.now()+3600e3).toISOString(); post({action:'register',telegram:'jammed',gender:'М',payment:'x'}); st[1]=new Date(Date.now()-1000).toISOString();
  assert.match(post({action:'photo',nick:'jammed',cp:'c1'}).error,/не дошло/);
  assert.match(post({action:'photo',nick:'ghost',cp:'c1',image:'aGVsbG8='}).error,/Войди/);
  r=post({action:'photo',nick:'jammed',cp:'c1',image:'data:image/jpeg;base64,aGVsbG8=',lat:0,lng:0,accuracy:20}); assert.equal(r.ok,true); assert.equal(r.pending,true);
  const prow=S9('Сканы').data.at(-1); assert.equal(prow[6],'проверить фото'); assert.match(prow[7],/drive\.google\.com/); assert.equal(S9('Сканы').data[0][7],'Фото');
  assert.equal(String(g9.drive.files.at(-1).bytes),'hello');
  let jm=JSON.parse(g9.ctx.doGet({parameter:{action:'me',nick:'jammed'}}).s); assert.deepEqual(jm.pending,['c1']); assert.deepEqual(jm.scans,[]);
  g9.cache.clear(); assert.ok(!JSON.parse(g9.ctx.doGet({parameter:{action:'state',test:K9}}).s).leaderboard.some(x=>x.nick==='jammed'),'до проверки не в топе');
  prow[6]='ok'; g9.cache.clear();
  jm=JSON.parse(g9.ctx.doGet({parameter:{action:'me',nick:'jammed'}}).s); assert.deepEqual(jm.pending,[]); assert.deepEqual(jm.scans.map(x=>x[0]),['c1']);
  assert.ok(JSON.parse(g9.ctx.doGet({parameter:{action:'state',test:K9}}).s).leaderboard.some(x=>x.nick==='jammed'),'после «ok» в топе');
  assert.equal(post({action:'photo',nick:'jammed',cp:'c1',image:'aGVsbG8='}).already,true);
  // обычная отметка теперь без секрета QR
  const c2=row('c2'); r=post({action:'scan',nick:'jammed',cp:'c2',lat:at(c2)[0],lng:at(c2)[1],accuracy:5}); assert.equal(r.ok,true);
  assert.equal(JSON.parse(g9.ctx.doGet({parameter:{action:'state'}}).s).leaderboard,undefined);
  S9('Настройки').data.find(r=>r[0]==='Конец')[1]=new Date(Date.now()-1).toISOString(); g9.cache.clear();
  const after=JSON.parse(g9.ctx.doGet({parameter:{action:'state'}}).s); assert.equal(after.results,true); assert.equal(after.leaderboard[0].nick,'rider1');
}

// конец аллейката: после него сканы не принимаются, тестовые работают
{ const {load:l10}=require('./gas-mock'); const g=l10(); g.ctx.setup();
  const set=(k,v)=>g.sheets['Настройки'].data.find(r=>r[0]===k)[1]=v;
  assert.ok(g.sheets['Настройки'].data.find(r=>r[0]==='Конец'),'setup добавил «Конец»');
  set('Старт',new Date(Date.now()+3600e3).toISOString());
  const post=b=>JSON.parse(g.ctx.doPost({postData:{contents:JSON.stringify(b)}}).s);
  post({action:'register',telegram:'late_rider',gender:'М',payment:'x'});
  set('Старт',new Date(Date.now()-7200e3).toISOString()); set('Конец',new Date(Date.now()-1000).toISOString());
  const st=JSON.parse(g.ctx.doGet({parameter:{action:'state'}}).s); assert.ok(st.end<Date.now()); assert.equal(st.open,true);
  const c1=g.sheets['Точки'].data.find(r=>r[0]==='c1'); const [la,ln]=c1[2].split(',').map(Number);
  assert.match(post({action:'scan',nick:'late_rider',cp:'c1',k:c1[5],lat:la,lng:ln}).error,/закончился/);
  const key=g.sheets['Настройки'].data.find(r=>r[0]==='Ключ администратора')[1];
  assert.equal(post({action:'scan',test:key,cp:'c1',k:c1[5],lat:la,lng:ln}).ok,true,'тест работает и после конца');
  set('Конец',''); assert.equal(JSON.parse(g.ctx.doGet({parameter:{action:'state'}}).s).end,null,'без конца - не ограничено');
}

// без setup - понятная ошибка
{ const {load:l3}=require('./gas-mock'); const g3=l3();
  assert.match(JSON.parse(g3.ctx.doGet({parameter:{action:'state'}}).s).error,/setup/); }

// ===== таблица ответов Google Формы =====
{
  const {load:load2}=require('./gas-mock');
  const g=load2();
  const form=g.ctx.SpreadsheetApp.getActive().insertSheet('Ответы на форму (1)');
  const d=(s)=>new Date(s);
  form.data=[['Отметка времени','Я ник телеграмм','пол ','стоимость участия…'],
    [d('2026-10-03T17:46:53+03:00'),'Lmsmolentsev','М','Перевод, т банк (Леонид С)'],
    [d('2026-10-04T09:38:00+03:00'),'difdebik','М','Тимур Рафаэлевич. Т-Банк'],
    [d('2026-10-05T12:22:25+03:00'),'@JasonFunderberkerr','М','Альфа'],
    [d('2026-10-05T13:00:00+03:00'),'Аня','Ж','бесплатно'],
    [d('2026-10-27T10:00:00+03:00'),'late_guy','М','Сбер']];
  g.ctx.setup();
  const regs=()=>g.sheets['Регистрации'].data.slice(1).map(r=>[r[1],r[2],r[4],r[5]].join('/'));
  assert.deepEqual(regs(),['lmsmolentsev/М/300/false','difdebik/М/300/false','jasonfunderberkerr/М/300/false','Аня/Ж/0/true','late_guy/М/600/false']);
  assert.equal(g.triggers.length,1,'триггер на новые ответы формы');
  g.ctx.setup(); assert.equal(g.triggers.length,1); assert.equal(regs().length,5,'повторный setup не дублирует');
  // новый ответ формы
  form.data.push([new Date(),'new_one','М','x']); g.ctx.importFormResponses();
  assert.equal(regs().length,6); g.ctx.importFormResponses(); assert.equal(regs().length,6);
  // уже зарегистрированный с сайта не дублируется
  g.sheets['Настройки'].data.find(r=>r[0]==='Старт')[1]=new Date(Date.now()+3600e3).toISOString();
  JSON.parse(g.ctx.doPost({postData:{contents:JSON.stringify({action:'register',telegram:'site_guy',gender:'М',payment:'x'})}}).s);
  form.data.push([new Date(),'@Site_Guy','М','x']); g.ctx.importFormResponses(); assert.equal(regs().length,7);
  // вход по нику из формы
  assert.equal(JSON.parse(g.ctx.doPost({postData:{contents:JSON.stringify({action:'login',nick:'@lmsmolentsev'})}}).s).nick,'lmsmolentsev');
  console.log('form import:', regs().join(' | '));
}
console.log('ALL OK');
