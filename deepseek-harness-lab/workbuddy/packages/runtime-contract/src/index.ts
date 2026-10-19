import {z} from 'zod';
const Id=z.string().uuid();
export const ManagerCommand=z.discriminatedUnion('method',[
 z.object({method:z.enum(['create','resume','snapshot','cancel','dispose']),userId:Id,sessionId:Id}).strict(),
 z.object({method:z.literal('prompt'),userId:Id,sessionId:Id,runId:Id,text:z.string().min(1).max(12000)}).strict(),
 z.object({method:z.literal('approval'),userId:Id,sessionId:Id,approvalId:Id,decision:z.enum(['allow','deny'])}).strict(),
 z.object({method:z.literal('import'),userId:Id,sessionId:Id,filename:z.string().min(1).max(120),displayName:z.string().min(1).max(120),data:z.string().max(1400000)}).strict(),
]);
export type Command=z.infer<typeof ManagerCommand>;
