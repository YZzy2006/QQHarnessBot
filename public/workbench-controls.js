'use strict';
// Local select-only combobox and Beijing-date calendar. Native fields remain the form's source of truth.
window.WorkbenchControls = (() => {
  const records = new Set(), known = new WeakMap();let sequence = 0, opened = null, queued = false;
  const node = (tag, attrs = {}, text = '') => {const n = document.createElement(tag);for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v);if (text) n.textContent=text;return n;};
  const emit = input => {input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
  const today = () => new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const date = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso+'T12:00:00Z') : new Date(today()+'T12:00:00Z');
  const iso = value => value.toISOString().slice(0,10);
  const displayDate = value => value ? value.replace(/^(\d{4})-(\d{2})-(\d{2})$/,'$1年$2月$3日') : '选择日期';
  function close(restore = false) {
    if (!opened) return;
    const {record, popup}=opened;opened=null;popup.remove();record.trigger.setAttribute('aria-expanded','false');record.trigger.removeAttribute('aria-activedescendant');if(record.calendar)document.querySelector('#app').inert=false;
    if (restore && record.trigger.isConnected) record.trigger.focus();
  }
  function position() {
    if (!opened) return;
    const {record,popup}=opened;if (!record.trigger.isConnected) {close();return;}
    const r=record.trigger.getBoundingClientRect(), margin=12;
    popup.style.width=Math.min(record.calendar?316:Math.max(r.width,190),innerWidth-margin*2)+'px';
    const height=popup.getBoundingClientRect().height;
    const top=r.bottom+height+8<=innerHeight-margin?r.bottom+6:Math.max(margin,r.top-height-6);
    const left=Math.max(margin,Math.min(r.left,innerWidth-popup.getBoundingClientRect().width-margin));
    popup.style.left=Math.round(left)+'px';popup.style.top=Math.round(top)+'px';
  }
  function choose(record,value) {record.input.value=value;sync(record);close(true);emit(record.input);}
  function sync(record) {
    const {input,trigger}=record;
    if(trigger.disabled!==input.disabled)trigger.disabled=input.disabled;
    const text=record.calendar?displayDate(input.value):input.selectedOptions?.[0]?.textContent || '请选择';if(trigger.querySelector('.pixel-value').textContent!==text)trigger.querySelector('.pixel-value').textContent=text;
    if (record.calendar) trigger.setAttribute('aria-description',input.value?displayDate(input.value):'未选择日期');
    if (opened?.record===record && input.disabled) close();
  }
  function syncAll() {for (const r of records) {if (!r.input.isConnected) {if(opened?.record===r)close();records.delete(r);}else sync(r);}}
  function openSelect(record) {
    close();const popup=node('div',{class:'pixel-popup pixel-options',id:record.popupId,role:'listbox','aria-label':record.label});
    const options=[...record.input.options].filter(o=>!o.disabled), buttons=[];
    if (!options.length) return;
    let index=Math.max(0,options.findIndex(o=>o.value===record.input.value));
    const paint=()=>{buttons.forEach((b,i)=>b.classList.toggle('is-active',i===index));record.trigger.setAttribute('aria-activedescendant',buttons[index].id);const b=buttons[index];if(b.offsetTop<popup.scrollTop)popup.scrollTop=b.offsetTop;else if(b.offsetTop+b.offsetHeight>popup.scrollTop+popup.clientHeight)popup.scrollTop=b.offsetTop+b.offsetHeight-popup.clientHeight;};
    options.forEach((option,i)=>{const b=node('div',{class:'pixel-option',id:record.popupId+'-'+i,role:'option','aria-selected':String(option.value===record.input.value)},option.textContent);b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('click',()=>choose(record,option.value));b.addEventListener('pointermove',()=>{index=i;paint();});buttons.push(b);popup.append(b);});
    opened={record,popup,move:delta=>{index=(index+delta+options.length)%options.length;paint();},edge:last=>{index=last?options.length-1:0;paint();},commit:()=>choose(record,options[index].value),search:text=>{const next=options.findIndex((o,i)=>i>index&&o.textContent.toLocaleLowerCase().startsWith(text));const any=next<0?options.findIndex(o=>o.textContent.toLocaleLowerCase().startsWith(text)):next;if(any>=0){index=any;paint();}}};
    document.body.append(popup);record.trigger.setAttribute('aria-expanded','true');position();paint();
  }
  function openCalendar(record) {
    close();const popup=node('div',{class:'pixel-popup pixel-calendar',id:record.popupId,role:'dialog','aria-label':record.label+'：选择日期','aria-modal':'true'});
    let focused=date(record.input.value), year=focused.getUTCFullYear(), month=focused.getUTCMonth(), mode='days', yearStart=year-5;
    const allowed=value=>(!record.input.min||value>=record.input.min)&&(!record.input.max||value<=record.input.max);
    function shiftMonth(delta) {const day=focused.getUTCDate();const d=new Date(Date.UTC(year,month+delta,1,12));year=d.getUTCFullYear();month=d.getUTCMonth();focused=new Date(Date.UTC(year,month,Math.min(day,new Date(Date.UTC(year,month+1,0)).getUTCDate()),12));render();}
    function render(focusGrid=false) {
      popup.replaceChildren();
      const heading=node('div',{class:'calendar-heading'});
      const prev=node('button',{type:'button',class:'calendar-step','aria-label':mode==='years'?'前12年':mode==='months'?'上一年':'上个月'},'‹');
      const current=node('button',{type:'button',class:'calendar-period','aria-live':'polite'},mode==='days'?`${year}年${month+1}月`:mode==='months'?`${year}年`:`${yearStart}—${yearStart+11}`);
      const next=node('button',{type:'button',class:'calendar-step','aria-label':mode==='years'?'后12年':mode==='months'?'下一年':'下个月'},'›');
      prev.onclick=()=>{if(mode==='years')yearStart-=12;else if(mode==='months')year--;else return shiftMonth(-1);render();};
      next.onclick=()=>{if(mode==='years')yearStart+=12;else if(mode==='months')year++;else return shiftMonth(1);render();};
      current.onclick=()=>{mode=mode==='days'?'months':'years';yearStart=year-5;render(true);};heading.append(prev,current,next);popup.append(heading);
      if (mode==='days') {
        const table=node('table',{class:'calendar-grid',role:'grid','aria-label':`${year}年${month+1}月`});
        const head=node('thead'),labels=node('tr');['一','二','三','四','五','六','日'].forEach((v,i)=>labels.append(node('th',{scope:'col','aria-label':'星期'+['一','二','三','四','五','六','日'][i]},v)));head.append(labels);table.append(head);
        const body=node('tbody'),first=new Date(Date.UTC(year,month,1,12)),offset=(first.getUTCDay()+6)%7;
        for(let week=0;week<6;week++) {const row=node('tr');for(let weekday=0;weekday<7;weekday++) {
          const d=new Date(Date.UTC(year,month,1-offset+week*7+weekday,12)),value=iso(d),cell=node('td',{role:'gridcell','aria-selected':String(value===record.input.value)});
          const button=node('button',{type:'button',class:'calendar-day'+(d.getUTCMonth()!==month?' other-month':'')+(value===today()?' is-today':'')+(value===record.input.value?' is-selected':''),'data-date':value,'aria-label':displayDate(value),tabindex:value===iso(focused)?'0':'-1'},String(d.getUTCDate()));
          if(!allowed(value))button.disabled=true;
          if(value===today())button.setAttribute('aria-current','date');
          button.onclick=()=>choose(record,value);
          button.onkeydown=e=>{const deltas={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7,Home:-((d.getUTCDay()+6)%7),End:6-((d.getUTCDay()+6)%7)};
            if(Object.hasOwn(deltas,e.key)){e.preventDefault();focused=new Date(d);focused.setUTCDate(d.getUTCDate()+deltas[e.key]);year=focused.getUTCFullYear();month=focused.getUTCMonth();render(true);}
            else if(e.key==='PageUp'||e.key==='PageDown'){e.preventDefault();focused=new Date(d);shiftMonth((e.key==='PageUp'?-1:1)*(e.shiftKey?12:1));focusDay();}};
          cell.append(button);row.append(cell);
        }body.append(row);}table.append(body);popup.append(table);
      } else {
        const grid=node('div',{class:'calendar-period-grid','aria-label':mode==='months'?'选择月份':'选择年份'});
        for(let i=0;i<12;i++){const value=mode==='months'?i:yearStart+i,button=node('button',{type:'button',class:'calendar-period-choice'},mode==='months'?`${i+1}月`:String(value));button.onclick=()=>{if(mode==='months'){month=value;mode='days';focused=new Date(Date.UTC(year,month,1,12));}else{year=value;mode='months';}render(true);};grid.append(button);}popup.append(grid);
      }
      const footer=node('div',{class:'calendar-footer'});
      if(!record.input.required){const clear=node('button',{type:'button',class:'quiet'},'清空');clear.onclick=()=>choose(record,'');footer.append(clear);}
      const now=node('button',{type:'button',class:'quiet'},'今天');now.disabled=!allowed(today());now.onclick=()=>choose(record,today());
      const dismiss=node('button',{type:'button',class:'quiet'},'收起');dismiss.onclick=()=>close(true);footer.append(now,dismiss);popup.append(footer);
      const hint=node('p',{class:'calendar-help'},mode==='days'?'方向键选日期 · 点击年月可切换':'选择后返回日历');popup.append(hint);
      position();if(focusGrid){if(mode==='days')focusDay();else popup.querySelector('.calendar-period-choice')?.focus();}
    }
    function focusDay(){const preferred=popup.querySelector(`.calendar-day[data-date="${iso(focused)}"]:not(:disabled)`)||popup.querySelector('.calendar-day:not(:disabled)');if(preferred){popup.querySelectorAll('.calendar-day').forEach(b=>b.tabIndex=-1);preferred.tabIndex=0;preferred.focus();}}
    opened={record,popup};document.body.append(popup);document.querySelector('#app').inert=true;record.trigger.setAttribute('aria-expanded','true');render(true);
    popup.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close(true);}else if(e.key==='Tab'){const bs=[...popup.querySelectorAll('button:not(:disabled)')].filter(b=>b.tabIndex>=0);if(e.shiftKey&&document.activeElement===bs[0]){e.preventDefault();bs.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===bs.at(-1)){e.preventDefault();bs[0].focus();}}});
  }
  function enhance(root=document) {
    for(const input of root.querySelectorAll('select,input[type=date]')) {
      if(known.has(input)||input.multiple)continue;
      const calendar=input.type==='date',label=input.getAttribute('aria-label')||input.closest('label')?.firstChild?.textContent?.trim()||'选择';
      const trigger=node('button',{type:'button',class:'pixel-trigger'+(calendar?' pixel-date-trigger':''),role:calendar?'button':'combobox','aria-label':label,'aria-haspopup':calendar?'dialog':'listbox','aria-expanded':'false'});
      trigger.append(node('span',{class:'pixel-value'}),node('span',{class:calendar?'pixel-calendar-mark':'pixel-chevron','aria-hidden':'true'}));
      const record={input,trigger,calendar,label,popupId:'pixel-popup-'+(++sequence)};trigger.setAttribute('aria-controls',record.popupId);
      // Hidden native fields still provide constraint values/FormData, but never open system popups.
      input.hidden=true;input.tabIndex=-1;input.setAttribute('aria-hidden','true');input.after(trigger);known.set(input,record);records.add(record);
      input.addEventListener('input',()=>sync(record));input.addEventListener('change',()=>sync(record));
      trigger.addEventListener('click',()=>{if(opened?.record===record)close(true);else calendar?openCalendar(record):openSelect(record);});
      let typed='',typedAt=0;
      trigger.addEventListener('keydown',e=>{
        if(calendar){if(e.key==='ArrowDown'){e.preventDefault();openCalendar(record);}return;}
        if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const wasOpen=opened?.record===record;if(!wasOpen)openSelect(record);if(e.key==='Home'||e.key==='End')opened?.edge(e.key==='End');else if(wasOpen)opened?.move(e.key==='ArrowDown'?1:-1);}
        else if(e.key==='Escape'&&opened?.record===record){e.preventDefault();close(true);}
        else if(['Enter',' '].includes(e.key)&&opened?.record===record){e.preventDefault();opened.commit();}
        else if(e.key==='Tab'&&opened?.record===record){opened.commit();}
        else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();if(opened?.record!==record)openSelect(record);typed=Date.now()-typedAt>700?'':typed;typed+=e.key.toLocaleLowerCase();typedAt=Date.now();opened?.search(typed);}
      });sync(record);
    }
  }
  document.addEventListener('pointerdown',e=>{if(opened&&!opened.popup.contains(e.target)&&!opened.record.trigger.contains(e.target))close();},true);
  window.addEventListener('resize',position);
  window.addEventListener('scroll',e=>{if(opened&&!opened.popup.contains(e.target))position();},true);
  const observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;enhance();syncAll();});});
  function start(){enhance();observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected','min','max']});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  return {enhance,sync:syncAll,close};
})();
