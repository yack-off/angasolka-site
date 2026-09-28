'use strict';
document.querySelector('#status-form').addEventListener('submit',async event=>{
  event.preventDefault();const output=document.querySelector('#status-message');const button=event.target.querySelector('button');const input=document.querySelector('#tracking-code');const code=input.value.trim();if(!/^[a-f0-9]{64}$/.test(code)){output.textContent='Введите код из 64 символов: цифры и латинские буквы a–f.';return;}input.value=code;button.disabled=true;output.textContent='Проверяем…';
  try{
    const response=await fetch('/api/v1/orders/status',{headers:{Authorization:'Bearer '+code},signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Не удалось проверить заявку.');
    const statuses={pending:'Ожидает согласования',contacted:'Связались с гостем',cancelled:'Отменена'};
    output.textContent=`Заявка ${data.id}. ${statuses[data.status]||data.status}. Предварительная стоимость: ${new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(data.total_minor/100)}.`;
  }catch(error){output.textContent=error.name==='TimeoutError'||error.name==='AbortError'?'Ответ сервера задерживается. Повторите проверку.':error instanceof TypeError?'Нет связи с сервером. Проверьте подключение и повторите проверку.':error.message;}finally{button.disabled=false;}
});
