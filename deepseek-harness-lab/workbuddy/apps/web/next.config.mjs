import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
export default {devIndicators:false,output:'standalone',outputFileTracingRoot:root,turbopack:{root}};
