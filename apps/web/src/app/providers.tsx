import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext';
import { ApiMailDataProvider } from '../data/api/ApiMailDataProvider';
import { ThemeProvider } from '../theme/ThemeProvider';
import { NoticeProvider } from '../ui/Notice';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <NoticeProvider>
          <AuthProvider>
            <ApiMailDataProvider>{children}</ApiMailDataProvider>
          </AuthProvider>
        </NoticeProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
