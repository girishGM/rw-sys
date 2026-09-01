/**
 * T-002 — application entry point. Vite + React + TS + Tailwind + React Query + React
 * Router skeleton (ARCHITECTURE.md §2/§6). T-005 adds theming, T-006 replaces the router
 * with the real app shell.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './app/providers';
import { router } from './app/router';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>
  </React.StrictMode>,
);
