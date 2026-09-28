import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './operations.css';
import './print.css';
import './drawer.css';
import './whatsapp.css';
import './staff.css';
import './experience.css';
import './polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
