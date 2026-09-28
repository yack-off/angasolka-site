"""One-time import of the existing public copy into the initial CMS seed."""
from html.parser import HTMLParser
from pathlib import Path
import json, re

p=Path('public/index.html')
source=p.read_text(encoding='utf-8-sig')
if 'data-cms-block=' in source:
    # The import is intentionally one-shot; running it again would duplicate CMS markers.
    raise SystemExit(0)
class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes=[]; self.stack=[]; self.lines=[0]
        for m in re.finditer('\n',source): self.lines.append(m.end())
    def position(self):
        line,col=self.getpos(); return self.lines[line-1]+col
    def handle_starttag(self,tag,attrs):
        n={'tag':tag,'attrs':dict(attrs),'start':self.position(),'open_end':self.position()+len(self.get_starttag_text()),'parent':self.stack[-1] if self.stack else None,'children':[],'text':[]}
        if self.stack: self.stack[-1]['children'].append(n)
        self.nodes.append(n)
        if tag not in ['meta','link','img','br','input','hr']: self.stack.append(n)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i]['tag']==tag:
                self.stack[i]['end']=self.position(); self.stack=self.stack[:i]; break
    def handle_data(self,data):
        for n in self.stack:n['text'].append(data)
parser=Parser(); parser.feed(source)
blocks=[]; edits=[]
labels={'hero':'Первый экран','stay':'Проживание и вопросы','experiences':'Услуги — заголовок раздела','offers':'Акция — оформление','place':'Место и дорога','camp':'Детский лагерь','closing':'Заключительный блок'}
for n in parser.nodes:
    if n['tag']!='section' or not n['parent'] or n['parent']['tag']!='main':continue
    bid=n['attrs'].get('id') or ('hero' if 'hero' in n['attrs'].get('class','') else 'closing')
    block={'id':bid,'title':labels[bid],'sort_order':len(blocks)*10,'fields':[]};blocks.append(block)
    edits.append((n['open_end']-1,' data-cms-block="'+bid+'"'))
    chosen=[]
    for node in parser.nodes:
        ancestors=[]; a=node['parent']
        while a is not None:ancestors.append(a);a=a['parent']
        if not any(a is n for a in ancestors):continue
        if any(a['tag'] in ['form','button'] for a in ancestors):continue
        if any(any(a is c for c in chosen) for a in ancestors):continue
        attrs=node['attrs'];tag=node['tag']
        if 'data-stay-price' in attrs or attrs.get('id') in ['activity-grid']:continue
        text=' '.join(''.join(node['text']).split())
        is_text=tag in ['h1','h2','h3','p','small','span','summary','li','strong'] or (tag=='div' and 'eyebrow' in attrs.get('class',''))
        if is_text and text and all(c['tag'] in ['br','em'] for c in node['children']):
            key='text'+str(len(block['fields'])+1)
            block['fields'].append({'key':key,'type':'text','label':text[:65],'value':text})
            edits.append((node['open_end']-1,' data-cms-field="'+key+'"'));chosen.append(node)
        elif tag=='img':
            key='image'+str(len(block['fields'])+1)
            block['fields'].append({'key':key,'type':'image','label':attrs.get('alt','Фотография')[:65],'value':'/'+attrs['src'],'alt':attrs.get('alt','')})
            edits.append((node['open_end']-1,' data-cms-field="'+key+'"'))
    if bid=='hero':
        block['fields'].append({'key':'background','type':'image','label':'Панорама первого экрана','value':'/assets/angasolka-panorama.jpg','alt':''})
        edits.append((n['open_end'],'<img class="cms-hero-image" data-cms-field="background" src="/assets/angasolka-panorama.jpg" alt="">'))
for offset,value in sorted(edits,key=lambda x:x[0],reverse=True):source=source[:offset]+value+source[offset:]
source=source.replace('<script src="app.js?v=backend-1"','<link rel="stylesheet" href="content.css"><script src="content.js" defer></script><script src="app.js?v=admin-1"')
p.write_text(source,encoding='utf-8')
Path('content-seed.json').write_text(json.dumps(blocks,ensure_ascii=False,indent=2),encoding='utf-8')

