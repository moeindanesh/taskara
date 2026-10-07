import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { I18nProvider } from 'react-aria';
import { AppearanceProvider } from '@/components/layout/appearance-provider';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <I18nProvider locale="fa-IR">
        <AppearanceProvider>
          <BrowserRouter>
            <App />
            <Toaster />
          </BrowserRouter>
        </AppearanceProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
);
