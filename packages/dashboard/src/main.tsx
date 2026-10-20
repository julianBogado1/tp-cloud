import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Before styles.css on purpose: import order is CSS order, so our rules (the
// marker colours, the dark-theme attribution control) come last and win the
// cascade over Leaflet's without !important.
import 'leaflet/dist/leaflet.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
