'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(Number(n)/100);
const date=v=>v?new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Irkutsk',dateStyle:'medium'}).format(new Date(v)):'—';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Irkutsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const roles={owner:'Владелец',manager:'Менеджер',viewer:'Просмотр'};
const statuses={pending:'Ожидает связи',contacted:'Связались',cancelled:'Отменена'};
const names={overview:'Обзор',crm:'CRM · Работа с гостями',orders:'Заявки',content:'Блоки и контент',catalog:'Услуги и тарифы',media:'Медиатека',database:'База данных',audit:'История действий',staff:'Сотрудники',password:'Мой пароль'};
let user=null,setup=false,view='overview',viewOptions={},viewData={},sequence=0,saveEditor=null,dirty=false,pickerTarget=null,pickerPage=1,noticeTimer;
const canWrite=()=>user?.role!=='viewer';const owner=()=>user?.role==='owner';
async function api(path,options={}){
  const response=await fetch('/api/v1/admin'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok){if(response.status===401&&path!=='/login'){user=null;showAccess();}throw new Error(data.error?.message||'Не удалось выполнить запрос.');}
  return data;
}
const send=(path,method,body)=>api(path,{method,body:JSON.stringify(body)});
function notify(message){clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(()=>$('#notice').hidden=true,6000);}
function showAccess(){
  $('#shell').hidden=true;$('#access').hidden=false;for(const d of document.querySelectorAll('dialog'))d.close();dirty=false;
  $('#access-title').textContent=setup?'Создайте доступ владельца':'Вход в управление';
  $('#access-description').textContent=setup?'Первый запуск на этом компьютере. Придумайте логин и пароль от 12 символов.':'Войдите с учётной записью сотрудника.';
  $('#repeat-label').hidden=!setup;$('#repeat-label input').required=setup;
  $('#login-form button').disabled=false;$('#login-form button').textContent=setup?'Создать кабинет →':'Войти →';
  $('#login-form [name=password]').autocomplete=setup?'new-password':'current-password';
}
function showShell(){
  $('#access').hidden=true;$('#shell').hidden=false;$('#identity').textContent=user.username+' · '+roles[user.role];
  document.querySelectorAll('[data-owner]').forEach(el=>el.hidden=!owner());
}
const heading=(title,description,action='')=>`<div class="page-heading"><div><span class="overline">АНГАСОЛКА / УПРАВЛЕНИЕ</span><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</div>`;
const empty=(title,text='')=>`<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const badge=(status,label)=>`<span class="tag ${esc(status)}">${esc(label||statuses[status]||status)}</span>`;
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}">${empty('Пока нет записей','Данные появятся после первых действий.')}</td></tr>`}</tbody></table></div>`;
const pager=(total,page,size=25,action='page')=>`<div class="pagination"><span>${total} записей · Страница ${page} из ${Math.max(1,Math.ceil(total/size))}</span><button class="secondary" data-action="${action}" data-page="${page-1}" ${page<=1?'disabled':''} aria-label="Предыдущая страница">←</button><button class="secondary" data-action="${action}" data-page="${page+1}" ${page*size>=total?'disabled':''} aria-label="Следующая страница">→</button></div>`;
const input=(label,name,value='',type='text',attrs='')=>`<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
const textarea=(label,name,value='',max=4000)=>`<label>${esc(label)}<textarea name="${esc(name)}" maxlength="${max}">${esc(value)}</textarea></label>`;
const check=(label,name,value)=>`<label class="check"><input type="checkbox" name="${name}" ${value?'checked':''}>${esc(label)}</label>`;
const select=(label,name,value,options)=>`<label>${esc(label)}<select name="${name}">${Object.entries(options).map(([k,v])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
const imageField=(name,value,label='Изображение',alt)=>`<div class="image-field"><label>${esc(label)}<input name="${name}" value="${esc(value)}" readonly></label><div><img src="${esc(value||'/assets/angasolka-panorama.jpg')}" alt="Превью"><button type="button" class="secondary" data-action="pick" data-target="${name}">Выбрать в медиатеке</button><button type="button" class="quiet" data-action="clear-image" data-target="${name}">Убрать</button></div>${alt!==undefined?input('Описание для незрячих посетителей',name+'-alt',alt,'text','maxlength="300"'):''}</div>`;
function openEditor(title,html,onSave,readOnly=false){
  $('#editor-title').textContent=title;$('#editor-body').innerHTML=html;$('#editor-form .form-error').textContent='';
  $('#editor-form button[type=submit]').hidden=readOnly;
  $('#editor-body').querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=readOnly);
  saveEditor=onSave;dirty=false;$('#editor').showModal();
}
async function load(next=view,options=viewOptions){
  view=next;viewOptions=options;const seq=++sequence;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#breadcrumb').textContent='Управление / '+names[view];$('#view').setAttribute('aria-busy','true');
  $('#view').innerHTML=heading(names[view],'Загружаем данные…');
  try{
    let data,html;const page=options.page||1;
    if(view==='overview'){
      const q=new URLSearchParams();if(options.from)q.set('from',options.from);if(options.to)q.set('to',options.to);
      data=await api('/metrics?'+q);html=renderOverview(data);
    }else if(view==='crm'){
      data=await api('/crm/orders?'+new URLSearchParams(options));html=renderCrm(data,options);
    }else if(view==='orders'){
      data=await api('/orders?page='+page+(options.status?'&status='+options.status:''));
      html=heading('Заявки','Поездки гостей и работа с обращениями.')+`<div class="toolbar">${select('Статус','status-filter',options.status||'',{'':'Все заявки',...statuses})}<button class="secondary" data-action="refresh">Обновить ↻</button></div><div class="panel">`+table(['Гость / номер','Поездка','Сумма заявки','Статус',''],data.items.map(o=>`<tr><td>${esc(o.name)}<br><small>${esc(o.id.slice(0,8))}</small></td><td>${date(o.arrival)} — ${date(o.departure)}<br><small>${o.beds} койко-мест</small></td><td>${money(o.total_minor)}</td><td>${badge(o.status)}</td><td><button data-action="order" data-id="${o.id}">Открыть →</button></td></tr>`))+pager(data.total,page)+'</div><p class="readonly-note">Сумма — сохранённый расчёт. Заявка сама по себе не резервирует места и не подтверждает оплату.</p>';
    }else if(view==='content'){
      data=await api('/content');html=heading('Блоки и контент','Управляйте текстами, фотографиями и порядком разделов.',canWrite()?'<button class="primary" data-action="new-block">+ Добавить блок</button>':'')+'<div class="info">Сохранённые изменения появятся на сайте этого сервера после обновления страницы. Числа в акции берутся из тарифной политики.</div><div class="cards">'+data.blocks.map((b,i)=>{const photo=b.fields.find(f=>f.type==='image'&&f.value);return `<article class="content-card"><div class="content-cover">${photo?`<img src="${esc(photo.value)}" alt="">`:String(i+1).padStart(2,'0')}</div><div class="card-body">${badge(b.enabled?'enabled':'cancelled',b.enabled?'На сайте':'Скрыт')}<h3>${esc(b.title)}</h3><p>${b.fields.length} полей · Порядок ${b.sort_order} · Версия ${b.version}</p><div class="card-footer"><small>${b.custom?'Добавленный блок':'Раздел сайта'}</small><button class="secondary" data-action="block" data-id="${b.id}">${canWrite()?'Редактировать':'Посмотреть'} →</button></div></div></article>`;}).join('')+'</div>';
    }else if(view==='catalog'){
      data=await api('/catalog');html=heading('Услуги и тарифы','Каталог сайта и расчёта поездки.',owner()?'<button class="primary" data-action="new-product">+ Добавить услугу</button>':'')+`<div class="info">${data.policy.demo?'Сейчас используются демонстрационные тарифы.':'Тарифы отмечены владельцем как рабочие.'} Версия ${data.policy.version}. Правки не меняют стоимость уже сохранённых заявок.</div><div class="panel">`+table(['Услуга','Единица','Цена','Доступность',''],data.products.map(p=>`<tr><td>${esc(p.title)}<br><small>${esc(p.id)}</small></td><td>${esc(p.unit)}</td><td>${money(p.price_minor)}</td><td>${badge(p.active?'enabled':'cancelled',p.active?'В каталоге':'Скрыта')}</td><td><button data-action="product" data-id="${p.id}">${owner()?'Редактировать':'Посмотреть'} →</button></td></tr>`))+`</div><div class="panel"><div class="panel-head"><h3>Скидка на проживание</h3>${owner()?'<button class="secondary" data-action="policy">Настроить →</button>':''}</div><p>${data.policy.discount_percent}% от ${data.policy.discount_nights} ночей</p><small>Дополнительные услуги оплачиваются без этой скидки.</small></div>`;
    }else if(view==='media'){
      data=await api('/media?page='+page);html=heading('Медиатека','Фотографии для разделов сайта и карточек услуг.',canWrite()?'<button class="primary" data-action="upload">+ Загрузить фото</button>':'')+'<div class="info">JPEG, PNG или WebP до 5 МБ. При загрузке удаляем метаданные и оптимизируем размер. Выберите фото в редакторе блока или услуги, чтобы использовать его на сайте.</div><h3>Загруженные фотографии</h3>'+mediaCards(data.items,false)+pager(data.total,page,24)+'<h3 class="section-label">Исходные фотографии и знаки</h3>'+mediaCards(data.assets,false);
    }else if(view==='audit'){
      data=await api('/audit?page='+page);html=heading('История действий','Кто и когда изменял данные.')+'<div class="panel">'+table(['Дата','Сотрудник','Действие','Объект','Подробности'],data.items.map(a=>`<tr><td>${date(a.created_at)}<br><small>${new Date(a.created_at).toLocaleTimeString('ru-RU',{timeZone:'Asia/Irkutsk'})}</small></td><td>${esc(a.username)}</td><td>${esc(actionName(a.action))}</td><td>${esc(a.entity_id)}</td><td class="wrap">${esc(JSON.stringify(a.details))}</td></tr>`))+pager(data.total,page)+'</div>';
    }else if(view==='database'){
      data=await api('/database?table='+(options.table||'catalog')+'&page='+page);html=heading('База данных','Просмотр записей и исправления через формы.')+'<div class="info">Тарифы, блоки, контакты и заявки редактируются с проверкой версии и аудитом. Системные секреты закрыты. Неотправленных событий: '+data.outboxPending+'. Доставка уведомлений пока не подключена.</div><div class="toolbar">'+select('Таблица','table-filter',data.table,Object.fromEntries(data.tables.map(t=>[t,t])))+'</div><div class="panel">'+table([...(data.items[0]?Object.keys(data.items[0]):['Записи']),''],data.items.map(row=>`<tr>${Object.values(row).map(v=>`<td>${esc(typeof v==='object'?JSON.stringify(v):v)}</td>`).join('')}<td>${data.table!=='outbox'?`<button data-action="db-edit" data-id="${row.id}">Редактировать →</button>`:'Только просмотр'}</td></tr>`))+pager(data.total,page)+'</div>';
    }else if(view==='staff'){
      data=await api('/staff');html=heading('Сотрудники','Индивидуальный доступ и роли.','<button class="primary" data-action="new-staff">+ Добавить сотрудника</button>')+'<div class="info">Владелец управляет тарифами, базой и сотрудниками. Менеджер — контентом, фотографиями, заявками и контактами. Просмотр — без права изменений.</div><div class="panel">'+table(['Логин','Роль','Доступ',''],data.items.map(u=>`<tr><td>${esc(u.username)} ${u.id===user.id?'<small>· это вы</small>':''}</td><td>${roles[u.role]}</td><td>${badge(u.active?'enabled':'cancelled',u.active?'Включён':'Отключён')}</td><td>${u.id!==user.id?`<button data-action="staff" data-id="${u.id}">Настроить →</button>`:''}</td></tr>`))+'</div>';
    }else if(view==='password'){
      data={};html=heading('Мой пароль','После смены пароля нужно войти снова.')+'<div class="panel"><form id="password-form" class="form-grid">'+input('Текущий пароль','currentPassword','','password','required minlength="12" maxlength="128" autocomplete="current-password"')+input('Новый пароль','password','','password','required minlength="12" maxlength="128" autocomplete="new-password"')+input('Повторите новый пароль','repeat','','password','required minlength="12" maxlength="128" autocomplete="new-password"')+'<div class="full"><button class="primary" type="submit">Изменить пароль</button><p class="form-error" role="alert"></p></div></form></div>';
    }
    if(seq!==sequence)return;viewData=data;$('#view').innerHTML=html;
  }catch(e){if(seq===sequence)$('#view').innerHTML=heading(names[view],'Не удалось загрузить раздел')+`<div class="panel"><p class="form-error">${esc(e.message)}</p><button class="secondary" data-action="refresh">Повторить</button></div>`;}
  finally{if(seq===sequence)$('#view').removeAttribute('aria-busy');}
}
function renderOverview(d){
  const views=d.traffic.filter(t=>t.event==='page_view').reduce((s,t)=>s+Number(t.count),0),quotes=d.traffic.filter(t=>t.event==='quote').reduce((s,t)=>s+Number(t.count),0);
  const start=Date.parse(d.from),count=(Date.parse(d.to)-start)/86400000+1;
  const days=Array.from({length:count},(_,i)=>{const day=new Date(start+i*86400000).toISOString().slice(0,10);return {day,n:d.daily.find(x=>x.day===day)?.orders||0};});
  const max=Math.max(1,...days.map(x=>x.n)),step=600/days.length;
  const chart=`<svg viewBox="0 0 600 180" role="img" aria-label="Количество заявок по дням">${days.map((x,i)=>`<rect x="${i*step+1}" y="${178-x.n/max*155}" width="${Math.max(1,step-2)}" height="${Math.max(2,x.n/max*155)}" rx="2" fill="#8daa6b"><title>${x.day}: ${x.n} заявок</title></rect>`).join('')}</svg>`;
  return heading('Всё под рукой.','Что происходит на сайте и с заявками гостей.',`<span class="tag"><span class="live-dot"></span> Данные сервера</span>`)+`<form id="metrics-filter" class="toolbar">${input('Период с','from',d.from,'date','required')}${input('По','to',d.to,'date','required')}<button class="secondary" type="submit">Показать</button><button class="quiet" type="button" data-action="export-metrics">Скачать CSV ↓</button></form><div class="metrics"><div class="metric"><span class="metric-label">Получено заявок</span><strong>${d.summary.orders}</strong><small>За выбранный период</small></div><div class="metric"><span class="metric-label">Сумма заявок</span><strong>${money(d.summary.amount)}</strong><small>Все статусы · не выручка</small></div><div class="metric"><span class="metric-label">Средняя сумма</span><strong>${money(d.summary.average)}</strong><small>На одну заявку</small></div><div class="metric"><span class="metric-label">Просмотры страниц</span><strong>${views}</strong><small>${quotes} успешных расчётов</small></div></div><div class="grid-two"><section class="panel"><div class="panel-head"><h3>Заявки по дням</h3><small>Asia/Irkutsk</small></div><div class="chart">${chart}</div><div class="chart-labels"><span>${date(d.from)}</span><span>${date(d.to)}</span></div>${!d.summary.orders?'<p class="readonly-note">Заявок за этот период пока нет.</p>':''}</section><section class="panel"><div class="panel-head"><h3>Работа с гостями</h3><button class="quiet" data-view="orders">Все заявки ↗</button></div>${['pending','contacted','cancelled'].map(s=>`<div class="status-line">${badge(s)}<strong>${d.summary[s]}</strong></div>`).join('')}</section></div><section class="panel"><div class="panel-head"><h3>Услуги в заявках</h3><small>Без отменённых заявок · до скидки на проживание</small></div>${table(['Услуга','Количество единиц','Сумма'],d.services.map(s=>`<tr><td>${esc(s.title)}</td><td>${s.quantity}</td><td>${money(s.amount)}</td></tr>`))}</section><div class="info">Просмотры — обращения к главной странице и странице статуса, включая повторные визиты и роботов. Счётчик работает с установки админки; уникальные посетители не определяются. Оплата и фактическая выручка пока не учитываются.</div>`;
}
function mediaCards(items,pick){return items.length?'<div class="cards">'+items.map(m=>`<article class="media-card">${pick?`<button class="picker-select" data-action="select-image" data-url="${esc(m.url)}" data-alt="${esc(m.alt)}">`:''}<img src="${esc(m.url)}" alt="${esc(m.alt||m.title)}" loading="lazy"><div class="card-body"><p>${esc(m.title)}</p><small>${m.width?m.width+' × '+m.height+' · '+Math.round(m.size/1024)+' КБ':'Исходный файл сайта'}</small>${!pick?`<input aria-label="Адрес ${esc(m.title)}" value="${esc(m.url)}" readonly>`:''}</div>${pick?'</button>':''}</article>`).join('')+'</div>':empty('Фотографий пока нет','Загрузите первую фотографию.');}
async function openPicker(page=1){pickerPage=page;$('#picker-body').innerHTML=empty('Загружаем медиатеку…');if(!$('#picker').open)$('#picker').showModal();const d=await api('/media?page='+page);$('#picker-body').innerHTML=mediaCards(d.items,true)+pager(d.total,page,24,'picker-page')+'<h3 class="section-label">Исходные файлы</h3>'+mediaCards(d.assets,true);}
function editBlock(b){
  openEditor(b.title,`<div class="form-grid">${input('Название блока в админке','title',b.title,'text','required maxlength="120"')}${input('Порядок раздела','sort_order',b.sort_order,'number','required min="0" max="10000"')}${check('Показывать на сайте','enabled',b.enabled)}</div><div class="info">Тексты сохраняются без HTML. ${b.id==='offers'?'Скидка и число ночей задаются в «Услуги и тарифы».':''}</div>`+b.fields.map(f=>f.type==='image'?imageField('field-'+f.key,f.value,f.label,f.alt||''):textarea(f.label,'field-'+f.key,f.value)).join(''),async form=>{
    const fields=b.fields.map(f=>({...f,value:form.get('field-'+f.key),...(f.type==='image'?{alt:form.get('field-'+f.key+'-alt')}: {})}));
    await send('/content/'+b.id,'PUT',{title:form.get('title'),enabled:form.has('enabled'),sort_order:Number(form.get('sort_order')),fields,version:b.version});
  },!canWrite());
}
function editProduct(p){
  openEditor(p?'Услуга: '+p.title:'Новая услуга',`<div class="form-grid">${input('Код услуги (латиница)','id',p?.id||'','text',`required pattern="[a-z][a-z0-9_-]{0,39}" maxlength="40" ${p?'readonly':''}`)}${input('Название','title',p?.title||'','text','required maxlength="120"')}${input('Цена, ₽','price',p?p.price_minor/100:'','number','required min="0.01" max="100000" step="0.01"')}${input('Единица расчёта','unit',p?.unit||'человек / занятие','text','required maxlength="80"')}${select('Раздел','category',p?.category||'adventure',{adventure:'Активный отдых',comfort:'Тепло и уют'})}${input('Порядок в каталоге','sort_order',p?.sort_order||0,'number','required min="0" max="10000"')}</div>${check('Услуга доступна для выбора','active',p?.active??true)}${textarea('Описание','description',p?.description||'',2000)}${imageField('image_url',p?.image_url||'')}<div class="info">Цена будет использоваться в новых расчётах. Сохранённые заявки сохранят прежнюю сумму.</div>`,async f=>{
    await send('/catalog','PUT',{id:f.get('id'),title:f.get('title'),unit:f.get('unit'),price_minor:Math.round(Number(f.get('price'))*100),active:f.has('active'),description:f.get('description'),category:f.get('category'),image_url:f.get('image_url'),sort_order:Number(f.get('sort_order')),version:viewData.policy.version});
  },!owner());
}
async function editOrder(id){
  const {order:o,events}=await api('/orders/'+id);
  openEditor('Заявка '+o.id.slice(0,8),`<div class="detail-meta"><div><small>Гость</small>${esc(o.name)} · ${esc(o.phone)}</div><div><small>Поездка</small>${date(o.arrival)} — ${date(o.departure)} · ${o.beds} мест</div><div><small>Сумма заявки</small>${money(o.total_minor)}</div><div><small>Создана</small>${date(o.created_at)} · ${esc(o.source)}</div></div><p class="readonly-note">Номер: ${o.id}</p>${select('Статус','status',o.status,statuses)}${textarea('Комментарий к заявке','comment',o.comment,1000)}<div class="info">Отмена окончательная. Статуса «Подтверждена» пока нет: учёт реального инвентаря не подключён.</div><h3>Сохранённый расчёт</h3>${table(['Позиция','Количество','Сумма'],o.quote.items.map(i=>`<tr><td>${esc(i.title)}</td><td>${i.quantity}</td><td>${money(i.totalMinor)}</td></tr>`))}<p class="readonly-note">Скидка на проживание: ${money(o.quote.discountMinor)}</p><h3 class="section-label">История заявки</h3>${table(['Дата','Событие','Статус'],events.map(e=>`<tr><td>${date(e.created_at)}</td><td>${esc(actionName(e.event_type))}</td><td>${esc(statuses[e.payload.status]||'—')}</td></tr>`))}`,async f=>{await send('/orders/'+id,'PATCH',{version:o.version,status:f.get('status'),comment:f.get('comment')});},!canWrite());
}
function editCustomer(c){openEditor('Контакт клиента',input('Имя','name',c.name,'text','required maxlength="80"')+input('Телефон','phone',c.phone,'tel','required minlength="10" maxlength="30"')+'<div class="info">Это исправление записи. Телефон не подтверждает личность и не объединяет клиентов автоматически.</div>',async f=>{await send('/customers/'+c.id,'PATCH',{name:f.get('name'),phone:f.get('phone'),version:c.version});});}
function editStaff(u){
  openEditor(u?'Доступ: '+u.username:'Новый сотрудник',(u?'':input('Логин','username','','text','required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" autocomplete="off"'))+select('Роль','role',u?.role||'manager',roles)+(u?check('Доступ включён','active',u.active):'')+input(u?'Новый пароль (оставьте пустым, чтобы сохранить)':'Пароль','password','','password',(u?'':'required ')+'minlength="12" maxlength="128" autocomplete="new-password"')+'<div class="info">Изменение доступа завершит все сессии этого сотрудника.</div>',async f=>{const password=f.get('password');await send('/staff'+(u?'/'+u.id:''),u?'PATCH':'POST',u?{version:u.version,role:f.get('role'),active:f.has('active'),...(password?{password}: {})}:{username:f.get('username'),password,role:f.get('role')});});
}
function actionName(a){return {'crm.assigned':'Назначен ответственный','crm.note_added':'Добавлена заметка','crm.task_added':'Добавлена задача','crm.task_updated':'Изменён статус задачи','session.login':'Вход','staff.bootstrap':'Создан владелец','catalog.save':'Изменение услуги','policy.save':'Изменение скидки','content.create':'Добавлен блок','content.save':'Изменение контента','media.upload':'Загрузка фото','order.created':'Создание заявки','order.updated':'Изменение заявки','order.update':'Изменение заявки','customer.update':'Исправление контакта','staff.create':'Создан сотрудник','staff.update':'Изменение доступа','staff.password':'Смена пароля'}[a]||a;}
async function action(button){
  const a=button.dataset.action,id=button.dataset.id;
  if(a==='refresh')return load();
  if(a==='page')return load(view,{...viewOptions,page:Number(button.dataset.page)});
  if(a==='block')return editBlock(viewData.blocks.find(b=>b.id===id));
  if(a==='new-block')return openEditor('Новый блок',input('Название','title','','text','required maxlength="120"')+'<p class="readonly-note">Новый блок появится скрытым. Заполните текст и включите показ на сайте.</p>',async f=>{await send('/content','POST',{title:f.get('title')});});
  if(a==='product'||a==='new-product')return editProduct(viewData.products.find(p=>p.id===id));
  if(a==='policy')return openEditor('Тарифная политика',check('Тарифы демонстрационные','demo',viewData.policy.demo)+input('Скидка на проживание, %','discount_percent',viewData.policy.discount_percent,'number','required min="0" max="99"')+input('Минимум ночей','discount_nights',viewData.policy.discount_nights,'number','required min="1" max="365"')+'<p class="readonly-note">Снимайте отметку демонстрационных тарифов только после согласования цен владельцем.</p>',async f=>{await send('/policy','PUT',{version:viewData.policy.version,demo:f.has('demo'),discount_percent:Number(f.get('discount_percent')),discount_nights:Number(f.get('discount_nights'))});});
  if(a==='order')return editOrder(id);
  if(a==='staff'||a==='new-staff')return editStaff(viewData.items.find(u=>u.id===id));
  if(a==='db-edit'){
    const row=viewData.items.find(r=>r.id===id),t=viewData.table;
    if(t==='customers')return editCustomer(row);
    if(t==='orders')return editOrder(id);
    await load(t==='catalog'?'catalog':'content',{});return t==='catalog'?editProduct(viewData.products.find(p=>p.id===id)):editBlock(viewData.blocks.find(b=>b.id===id));
  }
  if(a==='pick'){pickerTarget=button.dataset.target;return openPicker();}
  if(a==='picker-page')return openPicker(Number(button.dataset.page));
  if(a==='select-image'||a==='clear-image'){
    const target=$(`#editor-form [name="${a==='clear-image'?button.dataset.target:pickerTarget}"]`);target.value=a==='clear-image'?'':button.dataset.url;
    const wrapper=target.closest('.image-field');wrapper.querySelector('img').src=target.value||'/assets/angasolka-panorama.jpg';
    const alt=wrapper.querySelector(`[name="${pickerTarget}-alt"]`);if(alt&&a==='select-image')alt.value=button.dataset.alt||'';
    dirty=true;if(a==='select-image')$('#picker').close();return;
  }
  if(a==='upload')return openEditor('Загрузить фотографию','<label class="file-label">Файл JPEG, PNG или WebP<input type="file" name="file" accept="image/jpeg,image/png,image/webp" required></label>'+input('Название в медиатеке','title','','text','required maxlength="120"')+input('Описание изображения','alt','','text','maxlength="300"'),async f=>{
    const file=f.get('file');if(!file.size||file.size>5*1024*1024)throw new Error('Выберите изображение до 5 МБ.');
    const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('Не удалось прочитать файл.'));r.readAsDataURL(file);});
    await send('/media','POST',{title:f.get('title'),alt:f.get('alt'),data});
  });
  if(a==='export-metrics'){
    const d=viewData;const rows=[['Дата','Заявки','Сумма в копейках'],...d.daily.map(x=>[x.day,x.orders,x.amount])];
    const blob=new Blob(['\ufeff'+rows.map(r=>r.join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='angasolka-metrics-'+d.from+'-'+d.to+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.close){if(button.dataset.close==='editor'&&dirty&&!confirm('Закрыть редактор без сохранения изменений?'))return;$('#'+button.dataset.close).close();if(button.dataset.close==='editor')dirty=false;return;}
  if(button.dataset.view){await load(button.dataset.view,{});return;}
  if(!button.dataset.action)return;
  button.disabled=true;try{await action(button);}catch(error){notify(error.message);}finally{button.disabled=false;}
});
document.addEventListener('change',e=>{if(e.target.name==='status-filter')load('orders',{status:e.target.value});if(e.target.name==='table-filter')load('database',{table:e.target.value});});
$('#editor-form').addEventListener('input',()=>dirty=true);
$('#editor').addEventListener('cancel',e=>{if(dirty&&!confirm('Закрыть редактор без сохранения изменений?'))e.preventDefault();else dirty=false;});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
$('#editor-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget,button=f.querySelector('[type=submit]');button.disabled=true;f.querySelector('.form-error').textContent='';
  try{await saveEditor(new FormData(f));dirty=false;$('#editor').close();notify('Изменения сохранены');await load();}catch(error){f.querySelector('.form-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#login-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,f=new FormData(form),button=form.querySelector('button');button.disabled=true;form.querySelector('.form-error').textContent='';
  try{if(setup&&f.get('password')!==f.get('repeat'))throw new Error('Пароли не совпадают.');const d=await send(setup?'/setup':'/login','POST',{username:f.get('username'),password:f.get('password')});user=d.user;setup=false;form.reset();showShell();await load('overview',{});}catch(error){form.querySelector('.form-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#logout').addEventListener('click',async()=>{try{await send('/logout','POST',{});user=null;showAccess();}catch(e){notify(e.message);}});
document.addEventListener('submit',async e=>{
  if(e.target.id==='metrics-filter'){e.preventDefault();const f=new FormData(e.target);return load('overview',{from:f.get('from'),to:f.get('to')});}
  if(e.target.id==='password-form'){
    e.preventDefault();const form=e.target,f=new FormData(form),button=form.querySelector('button');button.disabled=true;
    try{if(f.get('password')!==f.get('repeat'))throw new Error('Пароли не совпадают.');await send('/password','POST',{currentPassword:f.get('currentPassword'),password:f.get('password')});form.reset();user=null;showAccess();notify('Пароль изменён. Войдите снова.');}catch(error){form.querySelector('.form-error').textContent=error.message;}finally{button.disabled=false;}
  }
});
(async()=>{try{const session=await api('/session');user=session.user;setup=session.setup;if(user){showShell();await load();}else showAccess();}catch(error){$('#access-description').textContent='Сервер недоступен. Проверьте запуск сайта и обновите страницу.';}})();

