import { useAuth } from '../auth/AuthContext';
import { LoginPage } from '../auth/LoginPage';
import { Skeleton } from '../ui/Skeleton';
import { AppRoutes } from './routes';

export function App() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--color-bg)',
          gap: 'var(--space-md)',
        }}
        role="status"
        aria-label="Yükleniyor"
      >
        <span
          style={{
            font: 'var(--font-title-large)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'var(--color-accent)',
          }}
        >
          Kaydet
        </span>
        <Skeleton width={120} height={4} />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginPage />;
  }

  return <AppRoutes />;
}
