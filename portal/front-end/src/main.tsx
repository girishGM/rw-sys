/**
 * T-020 — application entry point (04-FRONTEND.md §2). Replaces the T-001 `<App/>` scaffold
 * with the real provider tree, root error boundary and router.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { AppProviders } from './app/providers';
import { router } from './app/router';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </AppProviders>
    </ErrorBoundary>
  </React.StrictMode>,
);
