import type { ReactNode } from 'react';
import '@/styles/globals.css';
export default function Layout({children}:{children:ReactNode}){return <html lang="zh-CN" data-theme="vercel"><body>{children}</body></html>}
