const validKey = value => /^(private|group):[1-9]\d{0,11}$/.test(value);
const clean = value => String(value ?? '').replace(/[\u0000-\u001f]/g,'').slice(0,100);
export function projectWorkbenchContacts({friends=[],groups=[],aliases=[]}={},fallback=[]) {
  const rows=new Map();
  const put=(key,data={})=>{if(!validKey(key))return;rows.set(key,{key,kind:key.split(':')[0],id:key.split(':')[1],name:'',nickname:'',remark:'',aliases:[],...rows.get(key),...data});};
  for(const key of fallback)put(key);
  for(const f of friends.slice(0,10000)) {
    const id=String(f.user_id??f.uin??f.userId??'');
    put('private:'+id,{name:clean(f.remark||f.nickname||f.nick||id),nickname:clean(f.nickname||f.nick),remark:clean(f.remark)});
  }
  for(const g of groups.slice(0,10000)) {
    const id=String(g.group_id??g.groupId??'');put('group:'+id,{name:clean(g.group_name||g.groupName||g.name||id)});
  }
  for(const a of aliases.slice(0,100)) {
    if(!validKey(a.key))continue;put(a.key);
    const row=rows.get(a.key);row.aliases.push(clean(a.name));if(!row.name)row.name=clean(a.label||a.name);
  }
  return [...rows.values()].map(row=>({...row,name:row.name||row.id}));
}
