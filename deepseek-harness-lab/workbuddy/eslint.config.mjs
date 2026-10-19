import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ignores:['**/node_modules/**','**/.next/**','dist/**','.research/**','spikes/**','apps/web/src/components/**','apps/web/src/lib/**','apps/web/src/hooks/**','apps/web/next-env.d.ts']},
 js.configs.recommended,...ts.configs.recommended,
 {files:['apps/**/*.ts','apps/**/*.tsx','packages/**/*.ts'],languageOptions:{globals:{process:'readonly',console:'readonly',Buffer:'readonly',URL:'readonly',fetch:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',WebSocket:'readonly',document:'readonly',window:'readonly',File:'readonly',FormData:'readonly',Event:'readonly',Headers:'readonly',Request:'readonly',Response:'readonly',crypto:'readonly',React:'readonly'}},rules:{'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'no-undef':'off','no-empty':'error'}});
