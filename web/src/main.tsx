import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { installAuthGuard } from './authGuard.ts';
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
