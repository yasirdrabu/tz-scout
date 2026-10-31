import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot, createApp } from './router';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <AppRoot app={createApp()} />
  </StrictMode>,
);
