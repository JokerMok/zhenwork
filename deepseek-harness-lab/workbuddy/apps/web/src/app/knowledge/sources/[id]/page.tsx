import {KnowledgeSource} from '@/features/knowledge';
export default async function SourcePage({params}:{params:Promise<{id:string}>}){const {id}=await params;return <KnowledgeSource id={id}/>}
