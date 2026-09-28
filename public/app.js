'use strict';
async function api(path, options={}) {
  let response;
  try{response=await fetch('/api/v1'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});}
  catch(error){const timeout=error.name==='TimeoutError'||error.name==='AbortError';const friendly=new Error(timeout?'Ответ сервера задерживается. Повторите действие.':'Нет связи с сервером. Проверьте подключение и повторите действие.');friendly.name=timeout?'TimeoutError':'NetworkError';throw friendly;}
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error?.message||'Сервис недоступен.');error.code=data.error?.code;throw error;}
  return data;
}
async function initializeBooking(){
const catalog=await api('/catalog');
await window.contentReady;
const offer=document.querySelector('#offers');
if(offer){
 offer.querySelector('.offer-number').replaceChildren(document.createTextNode('−'+catalog.policy.discount_percent+'%'));
 offer.querySelector('.offer p').textContent=`Скидка ${catalog.policy.discount_percent}% на проживание от ${catalog.policy.discount_nights} ночей. Дополнительные услуги считаются отдельно.`;
 document.querySelector('#offer-button').textContent=`Рассчитать ${catalog.policy.discount_nights} ночей ↗`;
 offer.querySelector('.offer small').textContent=catalog.policy.demo?'Предварительный расчёт. Условия акции подтвердите при согласовании заявки.':'Скидка учитывается в расчёте проживания.';
 if(!catalog.policy.discount_percent)offer.hidden=true;
}
if(!catalog.policy.demo){
 document.querySelector('.rate-disclaimer').textContent='Тариф из каталога турбазы';
 document.querySelectorAll('.demo-note').forEach(el=>{if(el.closest('#stay'))el.textContent='Фото показывает территорию; домик, комнату и удобства подтвердим при согласовании заявки.';if(el.closest('#experiences'))el.textContent='Программу, расписание и условия участия необходимо согласовать с турбазой.';});
 document.querySelector('footer > p').textContent='Приём заявок подключён. Подтверждение и оплата — после согласования.';
}
// Replace demo tariffs here after the owner confirms pricing and billing units.
const PRICING=Object.freeze({bedMinor:catalog.products.find(p=>p.id==='bed').price_minor,discountNights:catalog.policy.discount_nights,discountPercent:catalog.policy.discount_percent});
const icons={climb:'<path d="m5 28 10-23 12 23M10 18l5-5 4 5M29 5v25M26 11h6M26 20h6"/>',mountain:'<path d="m2 29 12-20 6 9 5-14 9 25H2Zm7-12 5 3 3-5M22 13l4 3 2-5"/>',walk:'<circle cx="21" cy="5" r="3"/><path d="m15 31 4-11-5-4 5-7 6 8h6M11 11l-4 6 6 4M25 32l-5-11M30 17v15"/>',bath:'<path d="M4 20h28l-3 11H7L4 20ZM8 24h20M10 15c-6-5 5-5 0-11M18 15c-6-5 5-5 0-11M26 15c-6-5 5-5 0-11"/>',food:'<path d="M5 19h26M7 19a11 11 0 0 1 22 0M18 8V5M15 5h6M3 25h30M6 30h24"/>'};
const safe=value=>String(value).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const SERVICES=catalog.products.filter(p=>p.id!=='bed').map(p=>({id:p.id,title:p.title,short:p.title,category:p.category,priceMinor:p.price_minor,unit:p.unit,quantity:p.unit,description:p.description,image:p.image_url}));
const $=s=>document.querySelector(s);
let serverQuote=null, serverQuoteTrip=null, pendingSubmission=null;
const trip=()=>({arrival:$('#arrival').value,departure:$('#departure').value,beds:$('#include-stay').checked?guests():0,extras:{...quantities}});
async function refreshQuote(){
  const currentTrip=JSON.stringify(trip());
  const freshQuote=await api('/quotes',{method:'POST',body:currentTrip});
  serverQuote=freshQuote;serverQuoteTrip=currentTrip;
  const container=$('#summary-lines');container.replaceChildren();
  const lines=quoteCalculation(serverQuote).lines;
  for(const line of lines){const row=document.createElement('div');row.className='summary-line';for(const text of [line.label,money(line.sum)]){const span=document.createElement('span');span.textContent=text;row.append(span);}container.append(row);}
  $('#total-price').textContent=money(serverQuote.totalMinor);
  return serverQuote;
}
const money=minor=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:minor%100?2:0,maximumFractionDigits:2}).format(minor/100)+' ₽';
const quoteCalculation=quote=>{const lines=quote.items.map(p=>({label:`${p.title}: ${p.quantity} × ${money(p.unitPriceMinor)}`,sum:p.totalMinor}));if(quote.discountMinor)lines.push({label:'Скидка на проживание',sum:-quote.discountMinor});return{lines,total:quote.totalMinor}};
const currentCalculation=()=>serverQuote&&serverQuoteTrip===JSON.stringify(trip())?quoteCalculation(serverQuote):calculation();
const quantities=Object.fromEntries(SERVICES.map(s=>[s.id,0]));
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays=(date,n)=>{const d=new Date(date+'T12:00:00');d.setDate(d.getDate()+n);return iso(d)};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Irkutsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('#arrival').min=today;$('#arrival').value=addDays(today,1);$('#departure').value=addDays(today,3);$('#departure').min=addDays($('#arrival').value,1);
function nights(){return Math.round((Date.parse($('#departure').value)-Date.parse($('#arrival').value))/86400000)}
function guests(){return Number($('#guests').value)}
function validDates(){const a=$('#arrival').value,b=$('#departure').value;const n=nights();let error='';if(!a||!b||!Number.isFinite(n))error='Выберите даты заезда и выезда.';else if(a<today)error='Дата заезда не может быть в прошлом.';else if(n<1)error='Выезд должен быть позже заезда.';else if(n>365)error='Выберите поездку продолжительностью до 365 ночей.';$('#date-error').textContent=error;return !error}
$('#arrival').addEventListener('change',()=>{$('#departure').min=addDays($('#arrival').value||today,1);if($('#arrival').value&&$('#departure').value<=$('#arrival').value)$('#departure').value=addDays($('#arrival').value,1);$('#date-error').textContent=''});
$('#departure').addEventListener('change',()=>{$('#date-error').textContent=''});
$('#activity-grid').innerHTML=SERVICES.map(s=>`<article class="activity-card" data-category="${s.category}">${s.image?`<img class="activity-image" src="${safe(s.image)}" alt="" loading="lazy">`:""}<div class="activity-icon"><svg viewBox="0 0 36 36" aria-hidden="true">${icons[s.id]||icons.walk}</svg></div><h3>${safe(s.title)}</h3><p>${safe(s.description)}</p><div class="activity-footer"><div><strong>${money(s.priceMinor)}</strong><small>${safe(s.unit)}</small></div><button class="add-button" data-add="${s.id}" aria-label="Добавить: ${safe(s.short)}">+</button></div></article>`).join('');
$('#extras').innerHTML=SERVICES.map(s=>`<div class="extra-row"><div><strong>${safe(s.short)}</strong><small>${money(s.priceMinor)} / ${safe(s.unit)}</small><small>Всего ${safe(s.quantity)} за поездку</small></div><div class="stepper"><button data-step="-1" data-service="${s.id}" aria-label="Уменьшить: ${safe(s.short)}">−</button><output id="qty-${s.id}" aria-label="${safe(s.short)}: количество">0</output><button data-step="1" data-service="${s.id}" aria-label="Увеличить: ${safe(s.short)}">+</button></div></div>`).join('');
function calculation(){const n=nights(),g=guests();const stay=$('#include-stay').checked?PRICING.bedMinor*n*g:0;const discount=n>=PRICING.discountNights?Math.round(stay*PRICING.discountPercent/100):0;const lines=[];if(stay)lines.push({label:`Проживание: ${g} × ${n} ноч. × ${money(PRICING.bedMinor)}`,sum:stay});if(discount)lines.push({label:`Скидка ${PRICING.discountPercent}% от ${PRICING.discountNights} ночей`,sum:-discount});for(const s of SERVICES)if(quantities[s.id])lines.push({label:`${s.short}: ${quantities[s.id]} × ${money(s.priceMinor)}`,sum:quantities[s.id]*s.priceMinor});return{lines,total:lines.reduce((sum,line)=>sum+line.sum,0)}}
function renderSummary(){const dateFormat=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'});$('#booking-period').textContent=`${dateFormat.format(new Date($('#arrival').value+'T12:00:00'))} — ${dateFormat.format(new Date($('#departure').value+'T12:00:00'))} · ${nights()} ноч. · ${$('#include-stay').checked?'мест: '+guests():'без проживания'}`;const result=currentCalculation();$('#summary-lines').innerHTML=result.lines.length?result.lines.map(l=>`<div class="summary-line ${l.sum<0?'discount':''}"><span>${safe(l.label)}</span><span>${money(l.sum)}</span></div>`).join(''):'<p class="demo-note">Выберите проживание или добавьте услуги.</p>';$('#total-price').textContent=money(result.total);$('#save-trip').disabled=result.total===0;$('#continue-request').disabled=result.total===0;$('#save-status').textContent='';for(const s of SERVICES){$(`#qty-${s.id}`).value=quantities[s.id];$(`[data-service="${s.id}"][data-step="-1"]`).disabled=quantities[s.id]===0;$(`[data-service="${s.id}"][data-step="1"]`).disabled=quantities[s.id]>=100}}
function openBooking(service){if(!validDates()){pickDates();return false}if(service){quantities[service]=Math.min(100,quantities[service]+1);$('#extras-details').open=true}renderSummary();setBookingStep('options',false);if(!$('#booking-dialog').open){$('#booking-dialog').showModal();$('#booking-title').focus({preventScroll:true})}return true}
$('#quick-book').addEventListener('submit',e=>{e.preventDefault();$('#include-stay').checked=true;openBooking()});
document.querySelectorAll('[data-book]').forEach(b=>b.addEventListener('click',()=>openBooking()));
document.querySelectorAll('[data-add]').forEach(b=>b.addEventListener('click',()=>openBooking(b.dataset.add)));
document.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>{quantities[b.dataset.service]=Math.max(0,Math.min(100,quantities[b.dataset.service]+Number(b.dataset.step)));renderSummary()}));
$('#include-stay').addEventListener('change',renderSummary);
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}}));
$('#change-dates').addEventListener('click',()=>{$('#booking-dialog').close();$('#quick-book').scrollIntoView({behavior:'smooth',block:'center'});$('#arrival').focus({preventScroll:true})});
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-pressed',String(t===b))});document.querySelectorAll('[data-category]').forEach(card=>{card.hidden=b.dataset.filter!=='all'&&card.dataset.category!==b.dataset.filter})}));
$('.menu-toggle').addEventListener('click',()=>{const open=$('.header nav').classList.toggle('open');$('.menu-toggle').setAttribute('aria-expanded',String(open));$('.menu-toggle').setAttribute('aria-label',open?'Закрыть меню':'Открыть меню')});
document.querySelectorAll('.header nav a').forEach(a=>a.addEventListener('click',()=>{$('.header nav').classList.remove('open');$('.menu-toggle').setAttribute('aria-expanded','false');$('.menu-toggle').setAttribute('aria-label','Открыть меню')}));
$('#offer-button').addEventListener('click',()=>{if(!$('#arrival').value||$('#arrival').value<today)$('#arrival').value=addDays(today,1);$('#departure').value=addDays($('#arrival').value,PRICING.discountNights);$('#include-stay').checked=true;updateQuickEstimate();openBooking()});
$('#save-trip').addEventListener('click',()=>{const result=currentCalculation();if(!result.total)return;const content=['АНГАСОЛКА — ПЛАН ПОЕЗДКИ','Предварительный расчёт. Не является подтверждением бронирования.','',`Заезд: ${$('#arrival').value}`,`Выезд: ${$('#departure').value}`,`Койко-мест: ${$('#include-stay').checked?guests():0}`,'',...result.lines.map(l=>`${l.label}: ${money(l.sum)}`),'',`ИТОГО: ${money(result.total)}`,'','Цены, акция, доступность, условия размещения и расписание услуг требуют подтверждения турбазой.','Этот файл не является заявкой. Оплата не производилась.'].join('\n');const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`Ангасолка-план-${$('#arrival').value}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('#save-status').textContent='План подготовлен к скачиванию.'});
$('#sources-button').addEventListener('click',()=>{$('#sources-dialog').showModal();$('#sources-title').focus({preventScroll:true})});
$('#photo-credit').innerHTML='Мосты через Ангасолку: <a href="https://commons.wikimedia.org/wiki/File:Mosty_na_st.Angasolka.jpg" target="_blank" rel="noopener noreferrer">Kolchak1923, Wikimedia Commons</a>, 14 августа 2011 года. Панорама и фотографии территории — с сайта angasolka.net. Изображения кадрируются в интерфейсе; полный кадр открывается по нажатию на фотографию в галерее.';
// The public CTA always starts with dates. Draft contacts exist only in page memory.
function pickDates(){
  if($('#booking-dialog').open)$('#booking-dialog').close();
  $('.header nav').classList.remove('open');
  $('.menu-toggle').setAttribute('aria-expanded','false');
  $('.menu-toggle').setAttribute('aria-label','Открыть меню');
  $('#quick-book').scrollIntoView({behavior:'smooth',block:'center'});
  $('#arrival').focus({preventScroll:true});
}
document.querySelectorAll('[data-pick-dates]').forEach(b=>b.addEventListener('click',pickDates));
document.querySelectorAll('[data-stay-price]').forEach(el=>el.textContent=money(PRICING.bedMinor));
function updateQuickEstimate(){
  const n=nights(), g=guests();
  const valid=Number.isFinite(n)&&n>=1&&n<=365&&$('#arrival').value>=today;
  const subtotal=PRICING.bedMinor*n*g;
  const discount=valid&&n>=PRICING.discountNights?Math.round(subtotal*PRICING.discountPercent/100):0;
  const plural=(value,forms)=>forms[value%100>=11&&value%100<=14?2:value%10===1?0:value%10>=2&&value%10<=4?1:2];
  $('#quick-period').textContent=valid?`${g} ${plural(g,['место','места','мест'])} · ${n} ${plural(n,['ночь','ночи','ночей'])}`:'Выберите корректные даты';
  $('#quick-total').textContent=valid?money(subtotal-discount):'—';
  $('#quick-discount').textContent=discount?`Включена скидка ${catalog.policy.discount_percent}%: −${money(discount)}`:'';
}
['arrival','departure','guests'].forEach(id=>{
  $('#'+id).addEventListener('input',updateQuickEstimate);
  $('#'+id).addEventListener('change',updateQuickEstimate);
});
updateQuickEstimate();
// Avoid covering the date form with the mobile shortcut while it is visible.
new IntersectionObserver(([entry])=>$('.mobile-booking').classList.toggle('is-hidden',entry.isIntersecting),{threshold:0.15}).observe($('#quick-book'));

function setBookingStep(step,focus=true){
  $('#booking-options').hidden=step!=='options';
  $('#contact-step').hidden=step!=='contact';
  $('#request-result').hidden=step!=='result';
  $('#continue-request').hidden=step!=='options';
  $('#booking-step').textContent=step==='options'?'ШАГ 1 ИЗ 2 · СОСТАВ ПОЕЗДКИ':step==='contact'?'ШАГ 2 ИЗ 2 · ВАШИ КОНТАКТЫ':'ЗАЯВКА СОХРАНЕНА';
  $('#booking-title').textContent=step==='options'?'Проверьте поездку':step==='contact'?'Отправьте заявку':'Всё готово к согласованию';
  $('#booking-dialog').scrollTop=0;
  if(focus)$(step==='contact'?'#contact-name':step==='result'?'#draft-title':'#change-dates').focus({preventScroll:true});
}
$('#continue-request').addEventListener('click',async()=>{
  const button=$('#continue-request');button.disabled=true;$('#save-status').textContent='Проверяем стоимость…';
  try{await refreshQuote();setBookingStep('contact');$('#save-status').textContent='';}
  catch(error){$('#save-status').textContent=error.message;}
  finally{button.disabled=false;}
});
$('#back-to-options').addEventListener('click',()=>setBookingStep('options'));
$('#edit-request').addEventListener('click',()=>setBookingStep('contact'));
const phone=$('#contact-phone');
function validatePhone(){
  const value=phone.value.trim(), digits=value.replace(/\D/g,'');
  const valid=/^\+?[\d\s()\-]+$/.test(value)&&digits.length>=10&&digits.length<=15;
  phone.setCustomValidity(valid?'':'Укажите телефон с кодом страны: от 10 до 15 цифр.');
}
phone.addEventListener('input',validatePhone);
$('#contact-name').addEventListener('input',()=>$('#contact-name').setCustomValidity($('#contact-name').value.trim()?'':'Укажите ваше имя.'));
let requestDraft='';
$('#request-form').addEventListener('submit',async e=>{
  e.preventDefault();validatePhone();
  $('#contact-name').setCustomValidity($('#contact-name').value.trim()?'':'Укажите ваше имя.');
  if(!$('#request-form').reportValidity()||!validDates()||!serverQuote)return;
  const button=$('#request-form button[type=submit]');button.disabled=true;$('#submit-status').textContent='Сохраняем заявку…';
  const base={...trip(),customer:{name:$('#contact-name').value.trim(),phone:phone.value.trim()},comment:$('#contact-comment').value.trim(),consent:$('#contact-consent').checked,expectedTotalMinor:serverQuote.totalMinor,pricingVersion:serverQuote.pricingVersion};
  const fingerprint=JSON.stringify(base);
  if(!pendingSubmission||pendingSubmission.fingerprint!==fingerprint){
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    pendingSubmission={fingerprint,key:crypto.randomUUID(),body:{...base,trackingToken:token}};
  }
  try {
    const result=await api('/orders',{method:'POST',headers:{'Idempotency-Key':pendingSubmission.key},body:JSON.stringify(pendingSubmission.body)});
    requestDraft=['АНГАСОЛКА — ЗАЯВКА СОХРАНЕНА',`Номер: ${result.order.id}`,'Статус: ожидает согласования. Места не зарезервированы.',`Заезд: ${base.arrival}`,`Выезд: ${base.departure}`,`Предварительная стоимость: ${money(result.order.quote.totalMinor)}`,'',`Код проверки статуса: ${pendingSubmission.body.trackingToken}`,'Проверить статус: '+location.origin+'/status.html','Сохраните код и не передавайте посторонним.'].join('\n');
    $('#request-preview').textContent=requestDraft;$('#submit-status').textContent='';$('#edit-request').hidden=true;
    setBookingStep('result');
  }catch(error){
    $('#submit-status').textContent=error.name==='TimeoutError'?'Ответ задерживается. Повторите отправку: повтор не создаст дубликат.':error.message.replace('Нет связи с сервером.','Нет связи с сервером. Если заявка уже сохранилась, повторная отправка не создаст дубликат.');
    if(error.code==='PRICE_CHANGED'){try{await refreshQuote();pendingSubmission=null;$('#submit-status').textContent='Стоимость обновлена. Проверьте сумму и отправьте заявку ещё раз.';}catch{}}
  }finally{button.disabled=false;}
});
$('#download-request').addEventListener('click',()=>{
  if(!requestDraft)return;
  const url=URL.createObjectURL(new Blob(['\ufeff'+requestDraft],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`Ангасолка-заявка-${$('#arrival').value}.txt`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  $('#request-status').textContent='Подтверждение и секретный код подготовлены к скачиванию.';
});
// Optional browser WebMCP: the same calculator, without sending a booking.
if(document.modelContext?.registerTool){try{Promise.resolve(document.modelContext.registerTool({name:'read_trip_estimate',title:'Прочитать расчёт поездки',description:'Return the current preliminary estimate; does not create a booking or check availability.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('Expected an empty object');if(!validDates())throw new Error('Invalid dates');return{...currentCalculation(),currency:'RUB',unit:'minor',preliminary:true,bookingCreated:false}}})).catch(()=>{})}catch{}}


}
initializeBooking().catch(()=>{
  document.querySelector('#date-error').textContent='Не удалось загрузить тарифы. Проверьте запуск сервера и обновите страницу.';
  document.querySelectorAll('[data-pick-dates], [data-book], #quick-book button, #offer-button').forEach(b=>b.disabled=true);
});
