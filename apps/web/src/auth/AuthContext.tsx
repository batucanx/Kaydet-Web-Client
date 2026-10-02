import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MailboxSessionCreateRequest, SessionDTO } from '@kaydet/domain';
import type { ApiClient } from '../data/api/client';
import { defaultApiClient } from '../data/api/client';
import * as sessionApi from '../data/api/session';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionDTO['user'];
  login: (credentials: MailboxSessionCreateRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  client = defaultApiClient,
  children,
}: {
  client?: ApiClient;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<SessionDTO['user']>(null);

  useEffect(() => {
    let cancelled = false;
    sessionApi
      .getSession(client)
      .then((session) => {
        if (cancelled) return;
        if (session.authenticated && session.user) {
          setUser(session.user);
          setStatus('authenticated');
        } else {
          setUser(null);
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus('unauthenticated');
      });

    const unsubscribe = client.onUnauthorized(() => {
      setUser(null);
      setStatus('unauthenticated');
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  const login = useCallback(
    async (credentials: MailboxSessionCreateRequest) => {
      const session = await sessionApi.createMailboxSession(client, credentials);
      setUser(session.user);
      setStatus('authenticated');
    },
    [client],
  );

  const logout = useCallback(async () => {
    try {
      await sessionApi.deleteSession(client);
    } finally {
      client.setCsrfToken(null);
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout }),
    [status, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      status: 'authenticated',
      user: null,
      login: async () => {},
      logout: async () => {},
    };
  }
  return ctx;
}
