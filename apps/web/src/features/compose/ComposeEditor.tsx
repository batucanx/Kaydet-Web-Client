import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Paperclip,
  Underline,
} from 'lucide-react';
import type { SignatureDTO } from '@kaydet/domain';
import { htmlToBodyText, renderSignatureHtml, updateBodySignature } from './signatureUtils';
import styles from './ComposeEditor.module.css';

export interface ComposeEditorProps {
  subject: string;
  onSubjectChange: (subject: string) => void;
  bodyText: string;
  bodyHtml: string | null;
  onBodyChange: (content: { bodyText: string; bodyHtml: string | null }) => void;
  signatures: SignatureDTO[];
  selectedSignatureId: string | null;
  onSelectSignature: (signature: SignatureDTO | null) => void;
  onAttachClick: () => void;
  disabled?: boolean;
}

export function ComposeEditor({
  subject,
  onSubjectChange,
  bodyText,
  bodyHtml,
  onBodyChange,
  signatures,
  selectedSignatureId,
  onSelectSignature,
  onAttachClick,
  disabled = false,
}: ComposeEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState<string>('16px');
  const isInitializedRef = useRef(false);
  const lastHtmlRef = useRef<string>('');

  // Keep editor HTML synchronized with external state changes (e.g. draft load, initial signature)
  useEffect(() => {
    if (!editorRef.current) return;

    if (!isInitializedRef.current) {
      if (bodyHtml) {
        editorRef.current.innerHTML = bodyHtml;
        lastHtmlRef.current = bodyHtml;
      } else if (bodyText) {
        const initial = bodyText
          .split('\n')
          .map((line) => (line ? `<p>${line}</p>` : '<p><br></p>'))
          .join('');
        editorRef.current.innerHTML = initial;
        lastHtmlRef.current = initial;
      } else {
        editorRef.current.innerHTML = '<p><br></p>';
        lastHtmlRef.current = '<p><br></p>';
      }
      isInitializedRef.current = true;
      return;
    }

    // External change (not triggered by user's own typing inside this component)
    if (bodyHtml !== null && bodyHtml !== lastHtmlRef.current) {
      editorRef.current.innerHTML = bodyHtml;
      lastHtmlRef.current = bodyHtml;
    }
  }, [bodyHtml, bodyText]);

  const handleInput = (e: FormEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const html = target.innerHTML;
    lastHtmlRef.current = html;
    const text = htmlToBodyText(html);
    onBodyChange({ bodyText: text, bodyHtml: html });
  };

  const executeFormat = (command: string, value: string | undefined = undefined) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      lastHtmlRef.current = html;
      onBodyChange({ bodyText: htmlToBodyText(html), bodyHtml: html });
    }
  };

  const handleFontSizeChange = (size: string) => {
    setFontSize(size);
    editorRef.current?.focus();
    // Using CSS styling for size selection
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const span = document.createElement('span');
      span.style.fontSize = size;
      const range = selection.getRangeAt(0);
      span.appendChild(range.extractContents());
      range.insertNode(span);
      if (editorRef.current) {
        const html = editorRef.current.innerHTML;
        lastHtmlRef.current = html;
        onBodyChange({ bodyText: htmlToBodyText(html), bodyHtml: html });
      }
    } else if (editorRef.current) {
      editorRef.current.style.fontSize = size;
    }
  };

  const handleSignatureSelect = (sigId: string) => {
    if (!editorRef.current) return;

    if (!sigId || sigId === 'none') {
      const updated = updateBodySignature(editorRef.current.innerHTML, null);
      editorRef.current.innerHTML = updated;
      lastHtmlRef.current = updated;
      onSelectSignature(null);
      onBodyChange({ bodyText: htmlToBodyText(updated), bodyHtml: updated });
      return;
    }

    const found = signatures.find((s) => s.id === sigId);
    if (found) {
      const sigHtml = renderSignatureHtml(found);
      const updated = updateBodySignature(editorRef.current.innerHTML, sigHtml);
      editorRef.current.innerHTML = updated;
      lastHtmlRef.current = updated;
      onSelectSignature(found);
      onBodyChange({ bodyText: htmlToBodyText(updated), bodyHtml: updated });
    }
  };

  return (
    <div className={styles.container}>
      {/* Subject Line */}
      <div className={styles.subjectRow}>
        <input
          type="text"
          className={styles.subjectInput}
          value={subject}
          placeholder="Konu"
          disabled={disabled}
          onChange={(e) => onSubjectChange(e.target.value)}
          aria-label="Konu"
        />
      </div>

      {/* Formatting & Controls Toolbar */}
      <div className={styles.toolbar} role="toolbar" aria-label="Biçimlendirme araç çubuğu">
        {/* Font size */}
        <select
          className={styles.fontSizeSelect}
          value={fontSize}
          disabled={disabled}
          onChange={(e) => handleFontSizeChange(e.target.value)}
          aria-label="Yazı boyutu"
          title="Yazı boyutu"
        >
          <option value="13px">Küçük (13px)</option>
          <option value="16px">Normal (16px)</option>
          <option value="20px">Büyük (20px)</option>
          <option value="24px">Çok büyük (24px)</option>
        </select>

        <div className={styles.separator} aria-hidden="true" />

        {/* Text styling buttons */}
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => executeFormat('bold')}
          disabled={disabled}
          aria-label="Kalın"
          title="Kalın (Ctrl+B)"
        >
          <Bold size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => executeFormat('italic')}
          disabled={disabled}
          aria-label="İtalik"
          title="İtalik (Ctrl+I)"
        >
          <Italic size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => executeFormat('underline')}
          disabled={disabled}
          aria-label="Altı çizili"
          title="Altı çizili (Ctrl+U)"
        >
          <Underline size={16} aria-hidden="true" />
        </button>

        <div className={styles.separator} aria-hidden="true" />

        {/* Lists */}
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => executeFormat('insertUnorderedList')}
          disabled={disabled}
          aria-label="Madde işaretli liste"
          title="Madde işaretli liste"
        >
          <List size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => executeFormat('insertOrderedList')}
          disabled={disabled}
          aria-label="Numaralı liste"
          title="Numaralı liste"
        >
          <ListOrdered size={16} aria-hidden="true" />
        </button>

        <div className={styles.separator} aria-hidden="true" />

        {/* Attach File */}
        <button
          type="button"
          className={styles.toolBtn}
          onClick={onAttachClick}
          disabled={disabled}
          aria-label="Dosya ekle"
          title="Dosya ekle"
        >
          <Paperclip size={16} aria-hidden="true" />
        </button>

        {/* Signature Selector */}
        {signatures.length > 0 && (
          <>
            <div className={styles.separator} aria-hidden="true" />
            <div className={styles.signatureWrap}>
              <select
                className={styles.signatureSelect}
                value={selectedSignatureId ?? 'none'}
                disabled={disabled}
                onChange={(e) => handleSignatureSelect(e.target.value)}
                aria-label="İmza seç"
                title="İmza seç"
              >
                <option value="none">İmza yok</option>
                {signatures.map((sig) => (
                  <option key={sig.id} value={sig.id}>
                    {sig.name} {sig.isDefault ? '(Varsayılan)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {/* Rich / Contenteditable Body Editor */}
      <div
        ref={editorRef}
        className={styles.bodyEditor}
        contentEditable={!disabled}
        data-placeholder="İletinizi yazın…"
        onInput={handleInput}
        role="textbox"
        aria-multiline="true"
        aria-label="İleti gövdesi"
        style={{ fontSize }}
      />
    </div>
  );
}
