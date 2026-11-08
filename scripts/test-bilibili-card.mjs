import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as cards from '../src/bilibili-card.js';

const card={url:'https://www.bilibili.com/video/BV1gAxv6JEp4/?p=2&share_source=copy_web',title:'大肥鱼抚养权争夺战',image:'http://i0.hdslb.com/bfs/archive/fixture.jpg?tracking=1',content:'不放进指定图文布局'};
const delivered=(segments,overrides={})=>({message_id:99,time:1000,message_type:'private',sender:{user_id:42},target_id:123,message:segments.map(s=>s.type==='image'?{type:'image',data:{file:'gateway-image.jpg'}}:s),...overrides});
const context={kind:'private',targetId:123,selfId:42,messageId:99,notBefore:999000};

test('视频分享按标题、封面、底部链接排列，不生成小程序',()=>{
 const segments=cards.bilibiliShareSegments(card);
 assert.deepEqual(segments,[{type:'text',data:{text:'【大肥鱼抚养权争夺战】\n'}},{type:'image',data:{file:'https://i0.hdslb.com/bfs/archive/fixture.jpg'}},{type:'text',data:{text:'\nhttps://www.bilibili.com/video/BV1gAxv6JEp4?p=2'}}]);
 assert.equal(segments.some(s=>['json','xml','share'].includes(s.type)),false);
});

test('仅本地回读副本不构成会话历史送达，错误目标/旧消息不能冒充成功',()=>{
 const segments=cards.bilibiliShareSegments(card),message=delivered(segments);
 assert.equal(cards.verifyBilibiliShareDelivery({messages:[message]},segments,context),true);
 for(const history of [{messages:[]},{messages:[delivered(segments,{target_id:234})]},{messages:[delivered(segments,{sender:{user_id:7}})]},{messages:[delivered(segments,{message_id:98})]},{messages:[delivered(segments,{time:900})]}]){
  assert.throws(()=>cards.verifyBilibiliShareDelivery(history,segments,context),/会话历史|确认/);
 }
 assert.throws(()=>cards.verifyBilibiliShareDelivery({messages:[delivered(segments.slice(0,1))]},segments,context),/会话历史|确认/);
 const group=delivered(segments,{message_type:'group',group_id:456});
 assert.equal(cards.verifyBilibiliShareDelivery({messages:[group]},segments,{...context,kind:'group',targetId:456}),true);
 assert.throws(()=>cards.verifyBilibiliShareDelivery({messages:[group]},segments,{...context,kind:'group',targetId:789}),/会话历史|确认/);
});

test('图文保留分P和完整Unicode，拒绝其他站点及无效封面',()=>{
 assert.throws(()=>cards.bilibiliShareSegments({...card,url:'https://example.com/'}),/链接/);
 for(const image of ['http://127.0.0.1/a.jpg','https://i0.hdslb.com.evil/a.jpg','https://user@i0.hdslb.com/a.jpg','https://i0.hdslb.com:3000/a.jpg','']){
  assert.equal(cards.bilibiliCover(image),'');
  assert.throws(()=>cards.bilibiliShareSegments({...card,image}),/封面/);
 }
 const segments=cards.bilibiliShareSegments({...card,title:'😀'.repeat(200)});
 assert.equal(segments[0].data.text.isWellFormed(),true);
 assert.equal(cards.bilibiliCover('//i0.hdslb.com/bfs/a.jpg'),'https://i0.hdslb.com/bfs/a.jpg');
});
