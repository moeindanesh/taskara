import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppearanceProvider } from '@/components/layout/appearance-provider';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { setupNotificationServiceWorker } from '@/lib/notification-service-worker';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <AppearanceProvider>
        <BrowserRouter>
          <App />
          <Toaster />
        </BrowserRouter>
      </AppearanceProvider>
    </ThemeProvider>
  </React.StrictMode>
);

void setupNotificationServiceWorker();
