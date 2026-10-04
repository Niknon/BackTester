import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { useSession } from './store/session';
import { restoreUsStocks } from './data/assets';

// акции США, добавленные пользователем по тикеру (история с Yahoo)
restoreUsStocks();

// отладочный доступ из консоли браузера (только dev-режим)
if (import.meta.env.DEV) (window as any).__bt = useSession;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
