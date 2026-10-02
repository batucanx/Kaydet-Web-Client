/** Deterministic seed data for server tests: two Kaydet users, three accounts, a few folders and messages. */
import type { AccountDTO, FolderDTO, MessageDTO } from '@kaydet/domain';
import type { MemoryPersistence } from '../infrastructure/memory/index.ts';

export const USER_A = 'user-a';
export const USER_B = 'user-b';

export const account = (id: string, email: string): AccountDTO => ({
  id,
  email,
  displayName: '',
  supportsServerLabels: true,
  sync: { status: 'idle', lastSyncAt: null },
});

export const folder = (over: Partial<FolderDTO> & Pick<FolderDTO, 'id' | 'accountId' | 'name' | 'role'>): FolderDTO => ({
  parentId: null,
  depth: 0,
  hasChildren: false,
  isFavorite: false,
  unreadCount: 0,
  totalCount: 0,
  ...over,
});

export const message = (over: Partial<MessageDTO> & Pick<MessageDTO, 'id' | 'accountId' | 'folderId'>): MessageDTO => ({
  threadId: `thread-${over.id}`,
  from: { email: 'sender@example.com', name: 'Sender' },
  to: [{ email: 'me@example.com', name: '' }],
  subject: 'Subject',
  preview: 'Preview text',
  date: '2026-09-01T10:00:00.000Z',
  seen: false,
  pinned: false,
  answered: false,
  forwarded: false,
  draft: false,
  hasAttachments: false,
  labels: [],
  outbox: { state: 'none' },
  cc: [],
  bcc: [],
  body: { text: 'Body text', html: null },
  attachments: [],
  ...over,
});

export const IDS = {
  a1: 'acc-a1',
  a2: 'acc-a2',
  b1: 'acc-b1',
  a1Inbox: 'fld-a1-inbox',
  a1Trash: 'fld-a1-trash',
  a1Drafts: 'fld-a1-drafts',
  a1Custom: 'fld-a1-custom',
  a1Parent: 'fld-a1-parent',
  a1Child: 'fld-a1-child',
  a2Inbox: 'fld-a2-inbox',
  b1Inbox: 'fld-b1-inbox',
  m1: 'msg-a1-1',
  m2: 'msg-a1-2',
  mTrash: 'msg-a1-trash',
  mDraft: 'msg-a1-draft',
  mA2: 'msg-a2-1',
  mB1: 'msg-b1-1',
} as const;

export function seed(memory: MemoryPersistence): void {
  const { store } = memory;
  store.accounts.push(
    { userId: USER_A, account: account(IDS.a1, 'a1@example.com') },
    { userId: USER_A, account: account(IDS.a2, 'a2@example.com') },
    { userId: USER_B, account: account(IDS.b1, 'b1@example.com') },
  );
  store.folders.push(
    folder({ id: IDS.a1Inbox, accountId: IDS.a1, name: 'Gelen Kutusu', role: 'inbox', unreadCount: 2, totalCount: 2 }),
    folder({ id: IDS.a1Trash, accountId: IDS.a1, name: 'Çöp Kutusu', role: 'trash' }),
    folder({ id: IDS.a1Drafts, accountId: IDS.a1, name: 'Taslaklar', role: 'drafts' }),
    folder({ id: IDS.a1Custom, accountId: IDS.a1, name: 'Projeler', role: 'custom' }),
    folder({ id: IDS.a1Parent, accountId: IDS.a1, name: 'Arşivim', role: 'custom', hasChildren: true }),
    folder({ id: IDS.a1Child, accountId: IDS.a1, name: 'Alt', role: 'custom', parentId: IDS.a1Parent, depth: 1 }),
    folder({ id: IDS.a2Inbox, accountId: IDS.a2, name: 'Gelen Kutusu', role: 'inbox' }),
    folder({ id: IDS.b1Inbox, accountId: IDS.b1, name: 'Gelen Kutusu', role: 'inbox' }),
  );
  store.messages.push(
    message({
      id: IDS.m1,
      accountId: IDS.a1,
      folderId: IDS.a1Inbox,
      subject: 'Toplantı notları',
      date: '2026-09-02T10:00:00.000Z',
      hasAttachments: true,
      body: {
        text: 'Toplantı notları ekte yer almaktadır.\n\nİyi çalışmalar,\nAhmet Yılmaz',
        html: {
          content: '<div style="font-family: -apple-system, sans-serif;"><h2>Haftalık Değerlendirme Toplantısı</h2><p>Merhaba ekip,</p><p>Bugünkü toplantıda alınan kararlar ve <strong>proje takvimi</strong> ekteki belgede özetlenmiştir.</p><ul><li>Sprint hedefleri gözden geçirildi</li><li>Tasarım token güncellemeleri onaylandı</li><li>E-posta okuyucu güvenliği ve performans kriterleri belirlendi</li></ul><p>Ayrıntılı bilgi için <a href="https://example.com/notlar" target="_blank" rel="noopener noreferrer">bağlantıyı</a> ziyaret edebilirsiniz.</p><p>İyi çalışmalar dilerim,<br><strong>Ahmet Yılmaz</strong></p></div>',
          sanitized: true,
        },
      },
      attachments: [{ id: 'att-1', messageId: IDS.m1, fileName: 'not.pdf', mimeType: 'application/pdf', sizeBytes: 1024 * 512, isInline: false }],
    }),
    message({
      id: IDS.m2,
      accountId: IDS.a1,
      folderId: IDS.a1Inbox,
      subject: 'Fatura',
      date: '2026-09-01T10:00:00.000Z',
      seen: true,
      body: {
        text: 'Sayın Müşterimiz,\n\nAğustos 2026 dönemine ait faturanız düzenlenmiştir.\nToplam Tutar: 1.250,00 TL\n\nTeşekkür ederiz.',
        html: {
          content: '<div style="font-family: sans-serif;"><p>Sayın Müşterimiz,</p><p>Ağustos 2026 dönemine ait faturanız hazırlanmıştır.</p><table border="1" cellpadding="8" style="border-collapse: collapse;"><tr><th>Dönem</th><th>Tutar</th></tr><tr><td>Ağustos 2026</td><td>1.250,00 TL</td></tr></table><p>Bizi tercih ettiğiniz için teşekkür ederiz.</p></div>',
          sanitized: true,
        },
      },
    }),
    message({ id: IDS.mTrash, accountId: IDS.a1, folderId: IDS.a1Trash, subject: 'Eski' }),
    message({ id: IDS.mDraft, accountId: IDS.a1, folderId: IDS.a1Drafts, subject: 'Taslak', draft: true, draftId: 'draft-existing' }),
    message({ id: IDS.mA2, accountId: IDS.a2, folderId: IDS.a2Inbox, subject: 'İkinci hesap' }),
    message({ id: IDS.mB1, accountId: IDS.b1, folderId: IDS.b1Inbox, subject: 'Başka kullanıcı' }),
  );
}
