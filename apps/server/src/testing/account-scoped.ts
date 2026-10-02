import { IDS } from './fixtures.ts';

/** Every account-scoped HTTP operation of the API, addressed at `accountId`: [name, method, path, body?, query?]. */
export const ACCOUNT_SCOPED = (accountId: string) =>
  [
    ['updateAccount', 'PATCH', `/accounts/${accountId}`, { displayName: 'x' }],
    ['deleteAccount', 'DELETE', `/accounts/${accountId}`],
    ['syncAccount', 'POST', `/accounts/${accountId}/sync`],
    ['listFolders', 'GET', `/accounts/${accountId}/folders`],
    ['createFolder', 'POST', `/accounts/${accountId}/folders`, { name: 'Yeni', parentId: null }],
    ['updateFolder', 'PATCH', `/accounts/${accountId}/folders/${IDS.a1Custom}`, { isFavorite: true }],
    ['deleteFolder', 'DELETE', `/accounts/${accountId}/folders/${IDS.a1Custom}`],
    ['listMessages', 'GET', `/accounts/${accountId}/messages`, undefined, { scope: 'pinned' }],
    ['applyMessageActions', 'POST', '/messages/actions', { accountId, messageIds: [IDS.m1], actions: [{ type: 'markRead' }] }],
    ['putDraft', 'PUT', '/drafts/scope-check', { accountId, to: [], cc: [], bcc: [], subject: '', bodyText: '', bodyHtml: null, attachmentIds: [], source: null }],
    ['search', 'GET', '/search', undefined, { q: 'x', accounts: 'account', accountId }],
    ['listLabels', 'GET', `/accounts/${accountId}/labels`],
    ['createLabel', 'POST', `/accounts/${accountId}/labels`, { name: 'Etiket', tone: 1 }],
    ['deleteLabel', 'DELETE', `/accounts/${accountId}/labels/l1`],
    ['listSignatures', 'GET', `/accounts/${accountId}/signatures`],
    ['putSignature', 'PUT', `/accounts/${accountId}/signatures/s1`, { name: 'İmza', body: 'x', isDefault: false }],
    ['deleteSignature', 'DELETE', `/accounts/${accountId}/signatures/s1`],
  ] as const;
