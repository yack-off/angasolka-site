'use strict';
window.contentReady=(async()=>{
  try {
    const response=await fetch('/api/v1/content');if(!response.ok)throw new Error('content');
    const {blocks}=await response.json();
    const main=document.querySelector('main');
    const ordered=[];
    const anchors=Array.from(main.querySelectorAll(':scope > [data-cms-block]')).map(section=>{const anchor=document.createComment('CMS section');section.before(anchor);return anchor;});
    for(const block of blocks){
      let section=document.querySelector(`[data-cms-block="${block.id}"]`);
      if(!section&&block.custom){
        section=document.createElement('section');section.className='section wrap cms-custom';section.dataset.cmsBlock=block.id;
        for(const field of block.fields){const el=document.createElement(field.type==='image'?'img':field.key==='heading'?'h2':'p');el.dataset.cmsField=field.key;section.append(el);}
      }
      if(!section)continue;
      section.hidden=!block.enabled;ordered.push(section);
      for(const field of block.fields){
        const el=section.querySelector(`[data-cms-field="${field.key}"]`);if(!el)continue;
        if(field.type==='text'){
          const oldCopy={
            'Тариф для макета. Фото показывает территорию; домик, комнату и удобства подтвердим при согласовании заявки.':'Фото показывает территорию; домик, комнату и удобства подтвердим при согласовании заявки.',
            'Все цены на этой странице приведены для демонстрации расчёта. Программу, расписание и условия участия необходимо согласовать с турбазой.':'Стоимость предварительная. Программу, расписание и условия участия необходимо согласовать с турбазой.',
            'Пример акции для макета, не действующее предложение.':'Условия акции и окончательную стоимость подтвердите при согласовании заявки.'
          };
          field.value=oldCopy[field.value]||field.value;
          // Keep the original typography while its seeded text is unchanged.
          if(el.textContent.replace(/\s+/g,' ').trim()!==field.value)el.textContent=field.value;
        }else{
          el.hidden=!field.value;if(field.value)el.src=field.value;el.alt=field.alt||'';
          if(el.parentElement.tagName==='A')el.parentElement.href=field.value||'#';
        }
      }
      if(section.id){const link=document.querySelector(`.header nav a[href="#${section.id}"]`);if(link)link.hidden=!block.enabled;}
    }
    // Reorder CMS sections while preserving non-CMS explanatory elements.
    ordered.forEach((section,index)=>{if(anchors[index])anchors[index].after(section);else main.append(section);});
    anchors.forEach(anchor=>anchor.remove());
  }catch{ /* The original local copy remains readable if content cannot be fetched. */ }
})();
