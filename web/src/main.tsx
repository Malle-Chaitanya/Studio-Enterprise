import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { installAuthGuard } from './authGuard.ts';
// CloudFuze design system: canonical --cf-* tokens + cf-* component styles.
// Loaded before styles.css so app tokens (below) can alias to these as the
// single source of truth. Everything here is scoped to .cf-ui/cf-* selectors,
// so it is additive — it does not touch existing unprefixed styles.
import './design/cf-ui/tokens.css';
import './design/cf-ui/base.css';
import './design/cf-ui/components.css';
import './styles.css';

// Before the first render, so a session that expired while the tab was open surfaces as
// "sign in again" rather than as a load failure on whichever screen asked first.
installAuthGuard();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
