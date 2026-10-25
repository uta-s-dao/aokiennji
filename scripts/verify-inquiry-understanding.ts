import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { answerChat } from '../lib/server/chat';
import { getSettings, putSettings, list, resetDbForTests } from '../lib/server/db';
import type { SupplierKnowledge } from '../lib/contracts';
async function main() {
 if (!process.env.DATABASE_URL || !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) throw Error('Local verification only');
 if (!process.env.OPENAI_API_KEY) throw Error('OpenAI key required');
 const settings=await getSettings();await putSettings({...settings,responseProvider:'local',flags:{...settings.flags,webSearch:false,aiResearch:false}});
 const rows=await list<SupplierKnowledge>('supplier_knowledge');assert(rows.length>0,'Import workbook first');
 let id:string|undefined;const turns=[];
 for(const message of ['耐熱ガラスを探している','BOROFLOAT® 33','型番ではなく製品名です。3枚ではなく5枚欲しいです。見積は不要です','在庫はありますか？']) {
  const r=await answerChat(message,'live-understanding-verification',id);id=r.conversationId;
  turns.push({message,reply:r.message.content,state:r.message.inquiryState});
  for(const row of rows) {assert(!r.message.content.includes(row.supplierName),'Private supplier leaked');if(row.website)assert(!r.message.content.includes(row.website),'Private URL leaked')}
 }
 assert(turns[0].reply.includes('取扱分野資料'),'Registered field source not used');
 assert(turns[0].reply.includes('メーカー名・型番'),'General category must ask identification');
 assert(turns[1].state?.designation==='BOROFLOAT® 33' || turns[1].state?.model==='BOROFLOAT® 33','Identity lost');
 assert(!turns[1].reply.includes('資料がなければ'),'Checklist advanced');
 assert.equal(turns[2].state?.quantity,5);
 assert(turns[3].reply.includes('未確認'),'Ungrounded stock claim');
 writeFileSync('/tmp/aoki-live-inquiry-understanding.json',JSON.stringify({passed:true,turns},null,2));
 console.log(JSON.stringify({passed:true,turns:turns.length,privateSupplierRows:rows.length,responseProvider:'local'}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(resetDbForTests);
