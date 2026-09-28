'use strict';
let crmOrder=null,crmPages={notes:1,tasks:1},crmSeq=0;
function renderCrm(d,o){
  const counts=Object.fromEntries(d.counts.map(c=>[c.status,c.count]));
  return heading('Каждому гостю — внимание.','Заявки, ответственные и следующие шаги команды.','<button class="secondary" data-action="refresh">Обновить ↻</button>')+
    `<form id="crm-filters" class="toolbar">${select('Ответственный','assignee',o.assignee||'all',{all:'Вся команда',mine:'Мои заявки',unassigned:'Без ответственного'})}${select('Требуют внимания','attention',o.attention||'all',{all:'Все',overdue:'Просроченные задачи',today:'Задачи на сегодня',no_tasks:'Без открытых задач'})}${select('Этап','status',o.status||'',{'':'Все этапы',...statuses})}<button class="primary">Показать</button></form>`+
    `<div class="crm-board">${Object.entries(statuses).map(([s,label])=>`<section class="crm-column"><header><h2>${esc(label)}</h2><span class="tag ${s}">${counts[s]||0}</span></header>${d.items.filter(x=>x.status===s).map(x=>`<button class="crm-card" data-crm="open" data-id="${x.id}"><span class="crm-card-id">${esc(x.id.slice(0,8))} · ${x.beds} мест</span><strong>${esc(x.name)}</strong><span>${date(x.arrival)} — ${date(x.departure)}</span><b>${money(x.total_minor)}</b><span class="crm-owner">${esc(x.assignee_name||'Ответственный не назначен')}</span><span class="crm-next ${x.next_due&&x.next_due<d.today?'overdue':''}">${x.next_due?(x.next_due<d.today?'Просрочено · ':x.next_due===d.today?'Сегодня · ':'Ближайшая задача · ')+date(x.next_due):'Нет открытых задач'}${x.open_tasks?` · ${x.open_tasks}`:''}</span></button>`).join('')||'<p class="crm-empty">На этой странице заявок нет</p>'}</section>`).join('')}</div>`+
    pager(d.total,Number(o.page||1))+`<p class="readonly-note">На странице до 25 заявок; счётчики включают все заявки по фильтрам. Срок задач — до конца дня по Иркутску. Сумма заявки не является оплатой, места пока не резервируются.</p>`;
}
const crmPager=(n,p,type)=>`<div class="pagination"><span>${n} записей · ${p} / ${Math.max(1,Math.ceil(n/25))}</span><button type="button" class="secondary" data-crm="${type}-page" data-page="${p-1}" ${p<=1?'disabled':''}>←</button><button type="button" class="secondary" data-crm="${type}-page" data-page="${p+1}" ${p*25>=n?'disabled':''}>→</button></div>`;
function crmAssignmentChanged(){const field=$('#crm-assignment select');return field&&field.value!==[...field.options].find(o=>o.defaultSelected)?.value;}
function crmDrafts(){return [...document.querySelectorAll('#crm-detail form')].filter(f=>f.id!=='crm-assignment'||crmAssignmentChanged()).map(f=>({id:f.id,key:f.dataset.key,values:[...new FormData(f)]}));}
async function openCrm(id,refresh=false){
  const seq=++crmSeq,drafts=refresh?crmDrafts():[];
  if(!refresh)crmPages={notes:1,tasks:1};
  const [detail,activity,team]=await Promise.all([api('/orders/'+id),api('/crm/orders/'+id+'?notesPage='+crmPages.notes+'&tasksPage='+crmPages.tasks),api('/crm/team')]);
  if(seq!==crmSeq||!user)return;
  crmOrder=detail.order;const o=crmOrder,d=activity;
  const people=Object.fromEntries(team.items.filter(s=>s.active&&s.role!=='viewer').map(s=>[s.id,s.username]));
  if(o.assignee_id&&!people[o.assignee_id])people[o.assignee_id]=(team.items.find(s=>s.id===o.assignee_id)?.username||'Сотрудник')+' (недоступен — переназначьте)';
  $('#crm-title').textContent=o.name+' · '+o.id.slice(0,8);
  $('#crm-detail').innerHTML=`<div class="crm-summary"><div>${badge(o.status)}<p>${esc(o.phone)}</p><small>${date(o.arrival)} — ${date(o.departure)} · ${o.beds} мест</small></div><div><strong>${money(o.total_minor)}</strong><small>Сумма заявки</small></div></div><p class="crm-text">${esc(o.comment||'Комментарий гостя не указан.')}</p><div class="toolbar"><button type="button" class="secondary" data-crm="order">Статус и расчёт →</button></div>`+
    (canWrite()?`<form id="crm-assignment" class="toolbar">${select('Ответственный за заявку','assigneeId',o.assignee_id||'',{'':'Не назначен',...people})}<button class="secondary">Назначить</button><p class="form-error" role="alert"></p></form>`:`<p>Ответственный: ${esc(people[o.assignee_id]||'Не назначен')}</p>`)+
    `<div class="crm-detail-grid"><section><h3>Задачи команды</h3>${d.tasks.map(t=>`<article class="crm-task ${t.status==='done'?'completed':''}"><strong>${esc(t.title)}</strong><small class="${t.status==='open'&&t.due_date<d.today?'overdue':''}">${esc(t.username)} · ${date(t.due_date)}${t.status==='done'?' · Выполнена':t.due_date<d.today?' · Просрочена':''}</small>${canWrite()?`<button class="quiet" type="button" data-crm="task-status" data-id="${t.id}" data-version="${t.version}" data-status="${t.status==='open'?'done':'open'}">${t.status==='open'?'✓ Выполнить':'Возобновить'}</button>`:''}</article>`).join('')||'<p class="muted">Добавьте следующий шаг: звонок, уточнение поездки или подготовку предложения.</p>'}${crmPager(d.totals.tasks,crmPages.tasks,'tasks')}`+
    (canWrite()?`<form id="crm-task-form" data-key="${crypto.randomUUID()}" class="crm-entry">${input('Что нужно сделать','title','','text','required maxlength="200"')}${input('Срок по Иркутску','dueDate',d.today,'date','required')}${select('Исполнитель задачи','assigneeId',o.assignee_id&&people[o.assignee_id]?o.assignee_id:user.id,Object.fromEntries(team.items.filter(s=>s.active&&s.role!=='viewer').map(s=>[s.id,s.username])))}<button class="primary">Добавить задачу</button><p class="form-error" role="alert"></p></form>`:'')+
    `</section><section><h3>Заметки и история общения</h3>${d.notes.map(n=>`<article class="crm-note"><p class="crm-text">${esc(n.body)}</p><small>${esc(n.username)} · ${date(n.created_at)}</small></article>`).join('')||'<p class="muted">Здесь можно зафиксировать результат разговора и пожелания гостя.</p>'}${crmPager(d.totals.notes,crmPages.notes,'notes')}`+
    (canWrite()?`<form id="crm-note-form" data-key="${crypto.randomUUID()}" class="crm-entry">${textarea('Внутренняя заметка','body','',2000)}<button class="primary">Добавить заметку</button><p class="form-error" role="alert"></p></form>`:'')+`</section></div>`;
  for(const draft of drafts){const form=document.getElementById(draft.id);if(!form)continue;if(draft.key)form.dataset.key=draft.key;for(const [name,value] of draft.values){const field=form.elements.namedItem(name);if(field)field.value=value;}}
  if(!$('#crm-dialog').open)$('#crm-dialog').showModal();
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-crm]');if(!b)return;b.disabled=true;
  try{
    if(b.dataset.crm==='open')await openCrm(b.dataset.id);
    if(b.dataset.crm==='order'){if(crmHasDraft()&&!confirm('Закрыть карточку без сохранения введённого текста?'))return;$('#crm-dialog').close();await editOrder(crmOrder.id);}
    if(b.dataset.crm==='refresh')await openCrm(crmOrder.id,true);
    if(b.dataset.crm==='task-status'){await send('/crm/tasks/'+b.dataset.id,'PATCH',{version:Number(b.dataset.version),status:b.dataset.status});await openCrm(crmOrder.id,true);await load();}
    if(b.dataset.crm.endsWith('-page')){crmPages[b.dataset.crm.split('-')[0]]=Number(b.dataset.page);await openCrm(crmOrder.id,true);}
  }catch(error){notify(error.message);}finally{b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  const form=e.target;if(form.id==='crm-filters'){e.preventDefault();const options=Object.fromEntries(new FormData(form));if(!options.status)delete options.status;await load('crm',options);return;}
  if(!['crm-assignment','crm-task-form','crm-note-form'].includes(form.id))return;
  e.preventDefault();const button=form.querySelector('button'),f=new FormData(form);button.disabled=true;form.querySelector('.form-error').textContent='';
  try{
    if(form.id==='crm-assignment')await send('/crm/orders/'+crmOrder.id+'/assignee','PATCH',{version:crmOrder.version,assigneeId:f.get('assigneeId')||null});
    if(form.id==='crm-task-form')await send('/crm/orders/'+crmOrder.id+'/tasks','POST',{id:form.dataset.key,title:f.get('title'),dueDate:f.get('dueDate'),assigneeId:f.get('assigneeId')});
    if(form.id==='crm-note-form')await send('/crm/orders/'+crmOrder.id+'/notes','POST',{id:form.dataset.key,body:f.get('body')});
    form.reset();form.dataset.key=crypto.randomUUID();if(form.id==='crm-assignment')form.remove();
    await openCrm(crmOrder.id,true);await load();notify('Сохранено');
  }catch(error){const message=form.querySelector('.form-error');if(form.isConnected&&message)message.textContent=error.message;else notify(error.message);}finally{button.disabled=false;}
});
function crmHasDraft(){return !!($('#crm-detail [name=body]')?.value.trim()||$('#crm-detail [name=title]')?.value.trim()||crmAssignmentChanged());}
$('#crm-dialog').addEventListener('cancel',e=>{if(crmHasDraft()&&!confirm('Закрыть карточку без сохранения введённого текста?'))e.preventDefault();});
$('#crm-close').addEventListener('click',()=>{if(!crmHasDraft()||confirm('Закрыть карточку без сохранения введённого текста?')){$('#crm-dialog').close();crmSeq++;}});
window.addEventListener('beforeunload',e=>{if($('#crm-dialog').open&&crmHasDraft()){e.preventDefault();e.returnValue='';}});
