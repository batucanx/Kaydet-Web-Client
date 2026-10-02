import { useState } from 'react';
import type { MailEndpoint, SocketSecurity } from '@kaydet/domain';
import { isValidEmail } from '@kaydet/domain';

export interface MailboxCredentials {
  email: string;
  password: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
}

export type MailboxValidation = { ok: true; value: MailboxCredentials } | { ok: false; message: string };

/**
 * State and validation shared by the sign-in screen and the add-account form: address, password and the
 * IMAP/SMTP server settings (defaults match the mobile app: 993/SSL and 465/SSL).
 */
export function useMailboxFields() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapSecurity, setImapSecurity] = useState<SocketSecurity>('ssl');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSecurity, setSmtpSecurity] = useState<SocketSecurity>('ssl');
  const [hostsTouched, setHostsTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Autofill server hosts from the address domain until the user customises them
  const changeEmail = (value: string) => {
    setEmail(value);
    if (hostsTouched) return;
    const at = value.indexOf('@');
    if (at > 0 && at < value.length - 1) {
      const domain = value.substring(at + 1).trim();
      if (domain.includes('.')) {
        setImapHost(`mail.${domain}`);
        setSmtpHost(`mail.${domain}`);
      }
    }
  };

  const changeImapHost = (value: string) => {
    setHostsTouched(true);
    setImapHost(value);
  };

  const changeSmtpHost = (value: string) => {
    setHostsTouched(true);
    setSmtpHost(value);
  };

  const changeImapSecurity = (security: SocketSecurity) => {
    setImapSecurity(security);
    setImapPort(security === 'ssl' ? '993' : '143');
  };

  const changeSmtpSecurity = (security: SocketSecurity) => {
    setSmtpSecurity(security);
    setSmtpPort(security === 'ssl' ? '465' : security === 'startTls' ? '587' : '25');
  };

  /** Validates the whole set; opens the server settings when the problem is in them. */
  const validate = (): MailboxValidation => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return { ok: false, message: 'E-posta adresi gerekli.' };
    if (!isValidEmail(trimmedEmail)) return { ok: false, message: 'Geçerli bir e-posta adresi girin.' };
    if (!password) return { ok: false, message: 'Şifre gerekli.' };

    const imapPortNumber = parseInt(imapPort.trim(), 10);
    if (!imapHost.trim() || isNaN(imapPortNumber) || imapPortNumber <= 0 || imapPortNumber > 65535) {
      setShowAdvanced(true);
      return { ok: false, message: 'Geçerli bir IMAP sunucusu ve bağlantı noktası girin.' };
    }
    const smtpPortNumber = parseInt(smtpPort.trim(), 10);
    if (!smtpHost.trim() || isNaN(smtpPortNumber) || smtpPortNumber <= 0 || smtpPortNumber > 65535) {
      setShowAdvanced(true);
      return { ok: false, message: 'Geçerli bir SMTP sunucusu ve bağlantı noktası girin.' };
    }

    return {
      ok: true,
      value: {
        email: trimmedEmail,
        password,
        imap: { host: imapHost.trim(), port: imapPortNumber, security: imapSecurity },
        smtp: { host: smtpHost.trim(), port: smtpPortNumber, security: smtpSecurity },
      },
    };
  };

  return {
    email, changeEmail,
    password, setPassword,
    imapHost, changeImapHost, imapPort, setImapPort, imapSecurity, changeImapSecurity,
    smtpHost, changeSmtpHost, smtpPort, setSmtpPort, smtpSecurity, changeSmtpSecurity,
    showAdvanced, setShowAdvanced,
    validate,
  };
}

export type MailboxFieldsState = ReturnType<typeof useMailboxFields>;
