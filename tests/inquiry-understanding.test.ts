import { beforeEach, expect, it, vi } from 'vitest';
import { answerChat } from '../lib/server/chat';
import { salesModel } from '../lib/server/sales-model';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { putSettings } from '../lib/server/db';
import { understandInquiry } from '../lib/server/inquiry-understanding';
vi.mock('../lib/server/sales-model', () => ({salesModel: vi.fn()}));
const model=vi.mocked(salesModel);
const parsed = (extra={}) => ({ model:'',manufacturer:'',designation:'',designationKind:'unknown',newSubject:false,quantity:0,quantityEvidence:'',quantityUnit:'',quotePreference:'unchanged',identityUnavailable:false,next:'none',known:[],...extra });
beforeEach(async()=>{model.mockReset();vi.stubEnv('OPENAI_API_KEY','synthetic');await putSettings({...DEFAULT_SETTINGS,responseProvider:'local',flags:{...DEFAULT_SETTINGS.flags,webSearch:false,aiResearch:false}})});
it('interprets a spaced trademark series with local replies, without inventing a manufacturer or stock',async()=>{
 model.mockResolvedValueOnce(parsed({next:'identity'}));
 const first=await answerChat('耐熱ガラスを探している','interpretation');
 model.mockResolvedValueOnce(parsed({designation:'BOROFLOAT® 33',designationKind:'series',known:['identity']}));
 const next=await answerChat('BOROFLOAT® 33','interpretation',first.conversationId);
 expect(next.message.inquiryState?.designation).toBe('BOROFLOAT® 33');
 expect(next.message.inquiryState?.manufacturer).toBeUndefined();
 expect(next.message.content).toContain('BOROFLOAT® 33');
 expect(next.message.content).toContain('登録商品を照合');
 expect(next.message.content).not.toContain('資料がなければ');
 expect(next.message.content).toContain('現在庫は未確認');
 expect(model.mock.calls.at(-1)?.[0].model).toBe('gpt-4.1-mini');
});
it('retains a name and corrects quantities without interpreting the series number as stock',async()=>{
 model.mockResolvedValueOnce(parsed({designation:'透明ガラスα',designationKind:'product_name'}));
 const first=await answerChat('商品名は透明ガラスα','correction');
 model.mockResolvedValueOnce(parsed({quantity:5,quantityEvidence:'5枚',quantityUnit:'枚',quotePreference:'declined'}));
 const next=await answerChat('3枚ではなく5枚、見積は不要です','correction',first.conversationId);
 expect(next.message.inquiryState).toMatchObject({designation:'透明ガラスα',quantity:5,quoteDeclined:true});
 expect(next.message.handoff).not.toBe('quote');
});
it('asks clarification when the interpreter fails instead of advancing a checklist',async()=>{
 model.mockRejectedValue(Error('quota'));
 const first=await answerChat('耐熱ガラスを探している','failure');
 const next=await answerChat('BOROFLOAT® 33','failure',first.conversationId);
 expect(next.message.content).toContain('判断できませんでした');
 expect(next.message.content).not.toContain('資料がなければ');
});
it('rejects identities and quantity evidence absent from the latest message',async()=>{
 model.mockResolvedValue(parsed({designation:'invented',manufacturer:'invented',model:'invented',quantity:50,quantityEvidence:'50個'}));
 const result=await understandInquiry({message:'まだ分かりません',history:[],settings:DEFAULT_SETTINGS,context:{scope:'chat'}});
 expect(result).toMatchObject({designation:'',model:'',manufacturer:'',quantity:0});
});

it('does not treat a general category as a specific product',async()=>{
 model.mockResolvedValueOnce(parsed({designation:'耐熱ガラス',designationKind:'category',next:'identity'}));
 const r=await answerChat('耐熱ガラスを探している','category');
 expect(r.message.inquiryState?.designation).toBeUndefined();
 expect(r.message.content).toContain('メーカー名・型番');
});
it('uses a manufacturer answer to ask for the remaining identity',async()=>{
 model.mockResolvedValueOnce(parsed({next:'identity'}));
 const first=await answerChat('ガラスを探しています','maker');
 model.mockResolvedValueOnce(parsed({manufacturer:'Example Maker',next:'identity'}));
 const next=await answerChat('Example Maker','maker',first.conversationId);
 expect(next.message.content).toContain('メーカーは「Example Maker」');
 expect(next.message.content).not.toContain('資料がなければ');
});
