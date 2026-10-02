import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import type { SocketSecurity } from '@kaydet/domain';
import type { MailboxFieldsState } from './useMailboxFields';
import styles from './AccountSetupForm.module.css';

export interface MailboxFieldsProps {
  fields: MailboxFieldsState;
  disabled: boolean;
  /** Prefix of the element ids (`add-account` → `add-account-email`). */
  idPrefix: string;
  passwordAutoComplete: 'current-password' | 'new-password';
  /** Rendered between the address and the password (e.g. the display name). */
  afterEmail?: ReactNode;
}

/** Address, password and the collapsible IMAP/SMTP server settings. */
export function MailboxFields({ fields, disabled, idPrefix, passwordAutoComplete, afterEmail }: MailboxFieldsProps) {
  const [showPassword, setShowPassword] = useState(false);
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <>
      <div className={styles.field}>
        <label htmlFor={id('email')} className={styles.label}>
          E-posta adresi
        </label>
        <input
          id={id('email')}
          type="email"
          required
          autoComplete="email"
          disabled={disabled}
          className={styles.input}
          placeholder="ornek@sirket.com"
          value={fields.email}
          onChange={(e) => fields.changeEmail(e.target.value)}
        />
      </div>

      {afterEmail}

      <div className={styles.field}>
        <label htmlFor={id('password')} className={styles.label}>
          Şifre
        </label>
        <div className={styles.inputWrapper}>
          <input
            id={id('password')}
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete={passwordAutoComplete}
            disabled={disabled}
            className={`${styles.input} ${styles.passwordInput}`}
            placeholder="••••••••"
            value={fields.password}
            onChange={(e) => fields.setPassword(e.target.value)}
          />
          <button
            type="button"
            className={styles.visibilityToggle}
            onClick={() => setShowPassword((prev) => !prev)}
            disabled={disabled}
            aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      <button
        type="button"
        className={styles.advancedToggle}
        onClick={() => fields.setShowAdvanced((prev) => !prev)}
        disabled={disabled}
        aria-expanded={fields.showAdvanced}
      >
        {fields.showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span>Sunucu ayarları</span>
      </button>

      {fields.showAdvanced && (
        <div className={styles.advancedSection}>
          <ServerBlock
            title="Gelen sunucu — IMAP"
            idPrefix={id('imap')}
            disabled={disabled}
            host={fields.imapHost}
            onHost={fields.changeImapHost}
            port={fields.imapPort}
            onPort={fields.setImapPort}
            security={fields.imapSecurity}
            onSecurity={fields.changeImapSecurity}
          />
          <ServerBlock
            title="Giden sunucu — SMTP"
            idPrefix={id('smtp')}
            disabled={disabled}
            host={fields.smtpHost}
            onHost={fields.changeSmtpHost}
            port={fields.smtpPort}
            onPort={fields.setSmtpPort}
            security={fields.smtpSecurity}
            onSecurity={fields.changeSmtpSecurity}
          />
        </div>
      )}
    </>
  );
}

interface ServerBlockProps {
  title: string;
  idPrefix: string;
  disabled: boolean;
  host: string;
  onHost: (value: string) => void;
  port: string;
  onPort: (value: string) => void;
  security: SocketSecurity;
  onSecurity: (value: SocketSecurity) => void;
}

function ServerBlock({ title, idPrefix, disabled, host, onHost, port, onPort, security, onSecurity }: ServerBlockProps) {
  return (
    <div className={styles.serverBlock}>
      <h3 className={styles.serverBlockTitle}>{title}</h3>
      <div className={styles.serverGrid}>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-host`} className={styles.label}>
            Sunucu
          </label>
          <input
            id={`${idPrefix}-host`}
            type="text"
            required
            disabled={disabled}
            className={styles.input}
            placeholder="mail.ornek.com"
            value={host}
            onChange={(e) => onHost(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-port`} className={styles.label}>
            Port
          </label>
          <input
            id={`${idPrefix}-port`}
            type="number"
            min={1}
            max={65535}
            required
            disabled={disabled}
            className={styles.input}
            value={port}
            onChange={(e) => onPort(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-security`} className={styles.label}>
            Güvenlik
          </label>
          <select
            id={`${idPrefix}-security`}
            disabled={disabled}
            className={styles.select}
            value={security}
            onChange={(e) => onSecurity(e.target.value as SocketSecurity)}
          >
            <option value="ssl">SSL/TLS</option>
            <option value="startTls">STARTTLS</option>
            <option value="none">Güvensiz</option>
          </select>
        </div>
      </div>
    </div>
  );
}
