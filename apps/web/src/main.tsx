import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@kaydet/tokens/tokens.css';
import './styles/fonts.css';
import './styles/global.css';
import { App } from './app/App';
import { Providers } from './app/providers';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
