// Explicit, structured adapters to existing owner commands. Never accepts a command string.
const specs = [];
const text = (name, label, value = '', max = 500) => ({name, label, type: 'text', value, max});
const choice = (name, label, options, value = options[0][0]) => ({name, label, type: 'select', options, value});
const number = (name, label, value, min = 1, max = 100) => ({name, label, type: 'number', value: String(value), min, max});
const target = (name = 'target', kind = 'any', allowed = false) => ({name, label: kind === 'group' ? '群聊' : kind === 'private' ? '好友' : '目标会话', type: 'target', kind, allowed});
const ref = (name = 'id', label = '记录 ID 或序号') => ({...text(name, label, '', 120), type: 'ref'});
const onoff = () => choice('mode', '开关', [['on','开启'],['off','关闭']]);
const add = (id, group, label, tokens, fields = [], options = {}) => specs.push({id, group, label, tokens, fields, risk: 'read', family: 'operator', ...options});
const write = {risk: 'write'}, danger = {risk: 'danger'}, send = {risk: 'send'};

add('feed.query',1,'查询好友动态',[],[{...target('friend','private'),optional:true},text('range','时间范围','最近7天',80),number('count','最多条数',10,1,50)],{format:'feed'});
for (const [id,label,head,risk] of [['like','点赞动态','点赞','send'],['comments','查看动态评论','查看评论','read'],['delete-comment','删除机器人评论','删除评论','danger']]) add('feed.'+id,1,label,[head,'@index'],[number('index','查询结果序号',1)],{risk});
add('feed.comment',1,'评论动态',['评论','@index','@content'],[number('index','查询结果序号',1),text('content','评论正文')],send);
add('feed.comment-draft',1,'生成待确认评论',['评论','@index'],[number('index','查询结果序号',1)],{risk:'model'});

for (const [id,label,sub] of [['status','互动状态','status'],['pending','待确认评论','pending'],['feed','最近抓取动态','feed']]) add('social.'+id,2,label,['social',sub],[],{format:'qzone'});
for (const [id,label,sub] of [['enabled','自动互动',null],['like','自动点赞','like'],['comment','自动评论','comment'],['approval','评论前确认','approval']]) add('social.'+id,2,label,['social',...(sub?[sub]:[]),'@mode'],[onoff()],{format:'qzone',risk:'write'});
for (const [id,label,sub,risk] of [['preview','预览互动','now dry','read'],['now','立即互动','now','send'],['confirm','确认发送评论','confirm','send'],['cancel','取消待确认评论','cancel','write']]) add('social.'+id,2,label,['social',...sub.split(' ')],[],{format:'qzone',risk});
add('social.modify',2,'修改待确认评论',['social','modify','@content'],[text('content','新评论正文')],{format:'qzone',risk:'write'});
add('social.delete',2,'删除机器人互动评论',['social','delete','@tid','@comment'],[ref('tid','动态 tid'),{...ref('comment','评论 ID（可选）'),optional:true}],{format:'qzone',risk:'danger'});
add('social.undo',2,'撤销互动记录',['social','undo','@tid'],[ref('tid','动态 tid')],{format:'qzone',risk:'danger'});
for (const [id,label,head] of [['pending-list','查看待处理评论','查看待处理评论'],['approve-id','确认指定评论','待评论确认'],['cancel-id','取消指定评论','待评论取消']]) add('social.'+id,2,label,[head,...(id==='pending-list'?[]:['@id'])],id==='pending-list'?[]:[ref()],{risk:id==='pending-list'?'read':'send',format:id==='pending-list'?undefined:'tagged-ref'});

for (const [id,label,tokens,risk] of [['status','空间状态',['status'],'read'],['list','待审草稿',['list'],'read'],['reconcile','核对发布结果',['reconcile'],'read'],['auto-now','立即检查自主说说',['auto','now'],'send']]) add('qzone.'+id,3,label,tokens,[],{format:'qzone',risk});
add('qzone.draft',3,'创建说说草稿',['draft','@content'],[{...text('content','草稿正文（留空由模型生成）'),optional:true}],{format:'qzone',risk:'model',optionalFields:['content']});
for (const [id,label,risk] of [['approve','发布草稿','send'],['reject','丢弃草稿','danger']]) add('qzone.'+id,3,label,[id,'@id'],[ref('id','草稿 ID')],{format:'qzone',risk});
add('qzone.enabled',3,'空间总开关',['@mode'],[onoff()],{format:'qzone',risk:'write'});
add('qzone.auto',3,'自主发说说开关',['auto','@mode'],[onoff()],{format:'qzone',risk:'write'});
add('qzone.right',3,'修改说说可见范围',['right','@tid','@right'],[{...ref('tid','动态 tid（留空为最近一条）'),optional:true},choice('right','可见范围',[['64','仅自己'],['4','好友'],['1','公开']])],{format:'qzone',risk:'danger'});
add('qzone.delete',3,'删除说说',['undo','@tid'],[{...ref('tid','动态 tid（留空为最近一条）'),optional:true}],{format:'qzone',risk:'danger'});
add('profile.like',4,'好友资料卡点赞',['资料卡点赞','@friend','@count'],[target('friend','private'),number('count','次数',10,1,10)],send);

add('friend.requests',5,'查看好友申请',['好友申请']);
for (const [id,label,head] of [['approve','通过好友申请','通过申请'],['reject','拒绝好友申请','拒绝申请']]) add('friend.'+id,5,label,[head,'@id'],[ref('id','申请 ID 或序号')],danger);
add('friend.source',5,'查询好友来源',['好友来源','@friend'],[target('friend','private')]);
add('friend.source-set',5,'记录好友来源',['好友来源','设置','@friend','@direction','@content'],[target('friend','private'),choice('direction','添加方向',[['对方加我','对方加我'],['我加对方','我加对方']]),text('content','来源说明')],write);

add('friends.list',6,'查看全部好友',['查看你全部好友']);
add('friends.active',6,'最近活跃好友',[],[number('count','好友数量',5,1,20)],{format:'active'});
add('friends.history',6,'在 QQ 查看好友对话',[],[target('friend','private'),number('count','最近消息数',20,1,100)],{format:'friend-history',risk:'send',delivery:'qq'});
add('groups.history',6,'在 QQ 查看群聊记录',['群聊记录','@group','@count'],[target('group','group'),number('count','最近消息数',20,1,100)],{risk:'send',delivery:'qq'});

for (const [id,label,head] of [['status','机器人状态','状态'],['sessions','会话列表','会话列表'],['groups','群列表','群列表'],['errors','最近错误','最近错误'],['balance','账户余额','余额'],['reminders','提醒列表','提醒列表'],['usage','今日用量','今日用量'],['cost','成本','成本'],['server','服务器状态','服务器'],['disk','磁盘状态','磁盘状态'],['disk-preview','清理预览','清理预览']]) add('console.'+id,7,label,[head]);
for (const [id,label,head] of [['members','群成员','群成员'],['info','群信息','群信息'],['announcements','群公告','群公告'],['honors','群荣誉','群荣誉'],['at-all','全体剩余次数','@全体剩余']]) add('console.'+id,7,label,[head,'@group'],[target('group','group')]);
add('console.cancel-reminder',7,'取消提醒',['取消提醒','@id'],[ref('id','提醒 ID')],danger);
add('console.read',7,'标记已读',['标记已读','@target'],[target()],write);
add('console.forward',7,'查看合并转发',['看转发','@id'],[ref('id','forward_id')]);
for (const [id,label,head] of [['disk-clean','清理磁盘','清理磁盘'],['log-clean','清理日志','清理日志']]) add('console.'+id,7,label,[head],[],danger);

add('admin.requests',8,'查看入群申请',['入群申请']);
for (const [id,label,head] of [['approve','通过入群申请','通过入群'],['reject','拒绝入群申请','拒绝入群']]) add('admin.'+id,8,label,[head,'@id'],[ref('id','申请 ID 或序号')],danger);
const member = () => text('member','群成员昵称、名片或 QQ','',80);
for (const [id,label,head,confirmed] of [['kick','踢出群成员','踢人',true],['unban','解除禁言','解禁',false]]) add('admin.'+id,8,label,[head,'@group','@member',...(confirmed?['确认']:[])],[target('group','group'),member()],danger);
add('admin.ban',8,'禁言成员',['禁言','@group','@member','@minutes','确认'],[target('group','group'),member(),number('minutes','分钟',10,1,43200)],danger);
add('admin.whole-ban',8,'全员禁言开关',['全员禁言','@group','@mode','确认'],[target('group','group'),onoff()],danger);
for (const [id,label,head] of [['card','修改群名片','改名片'],['title','修改群头衔','群头衔']]) add('admin.'+id,8,label,[head,'@group','@member','@content','确认'],[target('group','group'),member(),text('content','新内容','',60)],danger);
add('admin.group-name',8,'修改群名',['改群名','@group','@content','确认'],[target('group','group'),text('content','新群名','',60)],danger);
add('admin.manager',8,'设置或取消管理员',['设管理','@group','@member','@mode','确认'],[target('group','group'),member(),onoff()],danger);
add('admin.leave',8,'退出群聊',['退群','@group','确认'],[target('group','group')],danger);
for (const [id,label,head] of [['recall','撤回消息','撤回'],['essence','设置精华消息','设精华'],['unessence','取消精华消息','取消精华']]) add('admin.'+id,8,label,[head,'@message','确认'],[ref('message','消息 ID')],danger);
add('admin.sign',8,'群签到',['群签到','@group'],[target('group','group')],send);
add('admin.friend-info',8,'查询 QQ 资料',['查QQ','@friend'],[target('friend','private')]);
add('admin.remark',8,'修改好友备注',['改备注','@friend','@content'],[target('friend','private'),text('content','新备注','',60)],write);
add('admin.friend-delete',8,'删除好友',['删好友','@friend','确认'],[target('friend','private')],danger);
for (const [id,label,head] of [['emoji','添加表情回应','消息表情回应'],['unemoji','取消表情回应','取消表情回应']]) add('admin.'+id,8,label,[head,'@message','@emoji'],[ref('message','消息 ID'),text('emoji','表情数字 ID','76',8)],send);

add('session.status',9,'查看状态',['状态']);
add('session.role',9,'切换人物卡',[],[text('role','人物卡名称','',120)],{format:'api',endpoint:'role',risk:'write'});
add('session.role-clear',9,'清除人物卡',[],[],{format:'api',endpoint:'role-clear',risk:'danger'});
add('session.context',9,'清空上下文（保留记忆）',['清上下文','@target','确认'],[target('target','any',true)],danger);
add('session.reset',9,'重置目标会话与记忆',[],[target('target','any',true)],{format:'api',endpoint:'session-reset',risk:'danger'});
add('session.silent',9,'静默或恢复说话',[],[choice('mode','说话模式',[['silent','静默'],['active','恢复说话']])],{format:'api',endpoint:'role-mode',risk:'write'});

for (const [kind,label,head] of [['private','私聊','私聊白名单'],['group','群聊','群聊白名单']]) {
  add('allow.'+kind+'.list',10,'查看'+label+'白名单',[head]);
  for (const [id,title,verb] of [['add','加入','添加'],['remove','移除','删除']]) add('allow.'+kind+'.'+id,10,title+label+'白名单',[head,verb,'@target','确认'],[target('target',kind)],danger);
  add('allow.'+kind+'.set',10,'整体替换'+label+'白名单',[head,'设置','@ids','确认'],[{...text('ids','号码列表（逗号分隔）','',1000),type:'ids'}],danger);
}

for (const [id,label,head] of [['backup','备份状态','备份状态'],['likes','我的名片赞','我的名片赞'],['memory','长期记忆列表','记忆列表'],['stickers','收藏表情列表','收藏列表']]) add('extra.'+id,11,label,[head]);
add('extra.members',11,'搜索群成员',['群成员查','@group','@query'],[target('group','group'),text('query','QQ、昵称、名片或头衔','',80)]);
add('extra.poke',11,'拍一拍好友',['拍一拍','@friend'],[target('friend','private')],send);
add('extra.poke-group',11,'群内拍一拍',['拍一拍','@group','@member'],[target('group','group'),member()],send);
add('extra.context',11,'清上下文',['清上下文','@target','确认'],[target('target','any',true)],danger);
add('extra.recall',11,'撤回最近一条',['撤回最近','确认'],[],danger);
add('extra.forget-preview',11,'预览匹配的记忆',['忘记记忆','@query'],[text('query','匹配关键词','',120)]);
add('extra.forget',11,'删除匹配的记忆',['忘记记忆','@query','确认'],[text('query','匹配关键词','',120)],danger);
add('extra.nickname',11,'修改机器人昵称',['改昵称','@content','确认'],[text('content','新昵称','',60)],danger);

for (const [id,label,head,risk] of [['wake','主动唤醒','主动唤醒','model'],['status','主动问候状态','主动状态','read'],['reset','重置今日发送计数','限额重置','danger']]) add('active.'+id,12,label,[head,'@target'],[target('target','any',true)],{risk});
add('active.talk',12,'主动对话',['主动对话','@target','@content'],[target('target','any',true),text('content','让她说什么或做什么')],{risk:'model'});
add('active.toggle',12,'自动主动问候开关',['主动开关','@target','@mode'],[target('target','any',true),onoff()],write);
add('active.limits',12,'查看 QQ 发送限额',['限额调整']);
add('active.limit-set',12,'调整 QQ 发送限额',['限额调整','@kind','@period','@count'],[choice('kind','会话类型',[['私聊','私聊'],['群聊','群聊']]),choice('period','时间窗口',[['每分钟','每分钟'],['每小时','每小时'],['每天','每天']]),number('count','上限（0为不限）',20,0,100000)],danger);
add('task.list',12,'查看全部定时任务',['定时任务','查看所有']);
add('task.add',12,'创建定时任务',['定时任务','@when','@target','@content','@condition'],[text('when','执行时间','明天8点',80),target('target','any',true),text('content','任务内容'),{...text('condition','周期条件（可选：连续7天、共10次、永久）','',80),optional:true}],{risk:'model'});
add('task.cancel',12,'取消指定任务',['定时任务','取消','@id','确认'],[ref('id','任务完整 ID')],danger);
add('task.cancel-all',12,'取消全部定时任务',['定时任务','取消','全部','确认'],[],danger);
add('active.balance',12,'查询模型余额',['查询模型余额','@provider'],[choice('provider','供应商',[['deepseek','DeepSeek'],['千问','千问'],['豆包','豆包'],['小米','小米']])]);

add('tools.note',13,'记录待办',['记一下','@content'],[text('content','待办内容')],write);
add('tools.notes',13,'查看待办',['待办','全部']);
for (const [id,label,head,token] of [['done','完成待办','完成待办',false],['restore','恢复待办','恢复待办',false],['delete','删除待办','删除待办',true]]) add('tools.note-'+id,13,label,[head,'@id',...(token?['确认']:[])],[ref('id','待办 ID')],token?danger:write);
add('tools.reminder',13,'创建私人提醒',['提醒我','@when','@content'],[text('when','提醒时间','30分钟后',80),text('content','提醒内容')],write);
for (const [id,label,head,field] of [['reschedule','任务改期','任务改期',text('value','新的时间','明天9点',80)],['content','修改任务内容','任务内容',text('value','新的任务内容')],['defer','任务顺延','任务顺延',text('value','顺延多久','30分钟',80)]]) add('tools.task-'+id,13,label,[head,'@id','@value'],[ref('id','任务 ID'),field],write);
for (const [id,label,head] of [['pause','暂停任务','暂停任务'],['resume','恢复任务','恢复任务']]) add('tools.task-'+id,13,label,[head,'@id'],[ref('id','任务 ID')],write);
add('tools.quiet',13,'临时免打扰',['免打扰','@target','@duration'],[target('target','any',true),text('duration','持续多久','2小时',80)],write);
add('tools.unquiet',13,'取消临时免打扰',['取消免打扰','@target'],[target('target','any',true)],write);
add('tools.diagnose',13,'会话诊断',['诊断','@target'],[target()]);
add('tools.aliases',13,'查看目标别名',['别名列表']);
add('tools.alias',13,'设置目标别名',['别名设置','@name','@target','确认'],[text('name','别名','',20),target()],write);
add('tools.alias-delete',13,'删除目标别名',['别名删除','@name','确认'],[text('name','别名','',20)],danger);
add('tools.search',13,'搜索会话消息',['搜消息','@target','@query','@range'],[target('target','any',true),text('query','关键词','',120),text('range','历史范围','最近100条',40)]);
add('tools.summary',13,'按需生成群摘要',['群摘要','@group','@range'],[target('group','group',true),text('range','历史范围','最近100条',40)],{risk:'model'});
for (const [id,label,confirmed] of [['preview','预览记忆更正',false],['apply','确认更正记忆',true]]) add('tools.memory-'+id,13,label,['更正记忆','@target','@old','@content',...(confirmed?['确认']:[])],[target('target','any',true),text('old','旧内容'),text('content','新内容')],confirmed?danger:{risk:'read'});
for (const [id,label,head] of [['avoid','减少某话题','少聊话题'],['restore','恢复某话题','恢复话题']]) add('tools.topic-'+id,13,label,[head,'@target','@topic'],[target('target','any',true),text('topic','话题','',100)],write);
add('tools.topics',13,'查看话题偏好',['话题偏好','@target'],[target('target','any',true)]);
add('tools.recall',13,'撤回指定消息',['撤回此条','@target','@message','确认'],[target('target','any',true),ref('message','消息 ID')],danger);
for (const [id,label,head] of [['react','添加消息回应','回应'],['unreact','取消消息回应','取消回应']]) add('tools.'+id,13,label,[head,'@target','@message','@emoji'],[target('target','any',true),ref('message','消息 ID'),text('emoji','表情或数字 ID','👍',8)],send);

export const WORKBENCH_OPERATIONS = specs;
const error = (message, statusCode = 400) => {throw Object.assign(Error(message), {statusCode});};
export function publicOperations() {return specs.map(({tokens,format,endpoint,optionalFields,...spec}) => structuredClone(spec));}
export function buildWorkbenchOperation(id, args, confirmed, allowed = []) {
  const spec = specs.find(s => s.id === id);if (!spec) error('未知网页操作',404);
  if (!args || typeof args !== 'object' || Array.isArray(args)) error('参数格式无效');
  if (Object.keys(args).some(key => !spec.fields.some(field => field.name === key))) error('包含未开放的参数');
  if (spec.risk !== 'read' && confirmed !== true) error('请先确认本次操作',409);
  const values = Object.create(null);
  for (const f of spec.fields) {
    const raw = args[f.name] ?? f.value ?? '';
    if (typeof raw !== 'string' && typeof raw !== 'number') error(f.label+'格式无效');
    const value = String(raw).trim();
    if (!value && (f.optional || spec.optionalFields?.includes(f.name))) {values[f.name]='';continue;}
    if (!value || value.length > (f.max || 1000) || /[\[\]【】\u0000-\u001f]/.test(value)) error(f.label+'不能为空、过长或含括号/换行');
    if (f.type === 'select' && !f.options.some(([v])=>v===value)) error(f.label+'选项无效');
    if (f.type === 'number' && (!/^\d+$/.test(value) || Number(value)<f.min || Number(value)>f.max)) error(f.label+'超出范围');
    if (f.type === 'target') {
      const match=/^(private|group):([1-9]\d{4,11})$/.exec(value);
      if (!match || (f.kind !== 'any' && f.kind !== match[1])) error('请选择正确类型的好友或群聊');
      if (f.allowed && !allowed.includes(value)) error('目标不在当前允许的会话中',403);
      values[f.name]=f.kind === 'any' ? value : match[2];
    } else if (f.type === 'ids') {
      if (!/^[1-9]\d{4,11}(?:[ ,，]+[1-9]\d{4,11})*$/.test(value)) error('号码列表格式无效');
      values[f.name]=value.split(/[ ,，]+/).join(',');
    } else if (f.type === 'ref') {
      if (!/^[\w.-]{1,120}$/.test(value)) error(f.label+'格式无效');values[f.name]=value;
    } else values[f.name]=value;
  }
  if (['task.cancel','console.cancel-reminder'].includes(id) && !/^r_[a-f0-9]{8,}$/i.test(values.id)) error('请填写目标任务完整 ID，不能以全部代替');
  if (id.startsWith('tools.note-') && !/^n_[a-f0-9]{8,}$/i.test(values.id)) error('待办 ID 无效');
  let command='';
  const tokens=spec.tokens.map(token=>/^@[a-zA-Z]\w*$/.test(token)?values[token.slice(1)]:token).filter(token=>token!==''&&token!==undefined);
  if (spec.format === 'qzone') command='/qzone '+tokens.join(' ');
  else if (spec.format === 'tagged-ref') command='['+tokens.join(' ')+']';
  else if (spec.format === 'feed') command='[查看'+(values.friend?values.friend+'的':'好友')+'动态]['+values.range+'][最多'+values.count+'条]';
  else if (spec.format === 'active') command='[查看你最近最活跃的 '+values.count+' 个好友]';
  else if (spec.format === 'friend-history') command='[查看 '+values.friend+' 最近 '+values.count+' 条对话]';
  else if (spec.format !== 'api') command=tokens.map(token=>'['+token+']').join('');
  return {id:spec.id,label:spec.label,risk:spec.risk,command,endpoint:spec.endpoint,values};
}
