/**
 * MOCK DATA — static, fictional, and isolated. Shaped as the shared API DTOs (`@kaydet/domain`) and
 * replaced by the real API later. Only `MockMailDataProvider` may import this file (enforced by
 * ESLint). All names/addresses are invented; addresses use reserved `.example` domains.
 */
import type { AccountView, FolderRole, LabelView, MessageSummary, Person } from '../types';

export const MOCK_ACCOUNTS: AccountView[] = [
  {
    id: 'acc1',
    email: 'ayse.demir@sirket.example',
    displayName: 'Ayşe Demir',
    supportsServerLabels: true,
    sync: { status: 'idle', lastSyncAt: '2026-09-30T09:00:00.000Z' },
  },
  {
    id: 'acc2',
    email: 'ayse@ornek.example',
    displayName: '',
    supportsServerLabels: false,
    sync: { status: 'idle', lastSyncAt: '2026-09-30T09:00:00.000Z' },
  },
];

export interface MockFolderSpec {
  key: string;
  name: string;
  role: FolderRole;
  parent?: string;
  favorite?: boolean;
  count: number;
}

export const MOCK_FOLDER_SPECS: MockFolderSpec[] = [
  { key: 'inbox', name: 'Gelen Kutusu', role: 'inbox', count: 96 },
  { key: 'sent', name: 'Gönderilenler', role: 'sent', count: 9 },
  { key: 'archive', name: 'Arşiv', role: 'archive', count: 7 },
  { key: 'drafts', name: 'Taslaklar', role: 'drafts', count: 3 },
  { key: 'trash', name: 'Çöp Kutusu', role: 'trash', count: 5 },
  { key: 'junk', name: 'İstenmeyen', role: 'junk', count: 4 },
  { key: 'projeler', name: 'Projeler', role: 'custom', favorite: true, count: 6 },
  { key: 'projeler-web', name: 'Kaydet Web', role: 'custom', parent: 'projeler', count: 4 },
  { key: 'projeler-ted', name: 'Tedarikçiler', role: 'custom', parent: 'projeler', count: 3 },
  { key: 'faturalar', name: 'Faturalar', role: 'custom', favorite: true, count: 5 },
];

export const MOCK_LABELS: Omit<LabelView, 'id' | 'accountId'>[] = [
  { name: 'Önemli', tone: 0 },
  { name: 'İş', tone: 10 },
  { name: 'Kişisel', tone: 6 },
  { name: 'Fatura', tone: 3 },
];

const PEOPLE: Person[] = [
  { name: 'Mehmet Kaya', email: 'mehmet.kaya@tedarik.example' },
  { name: 'Elif Yıldız', email: 'elif@studyo.example' },
  { name: 'İsmail Şahin', email: 'ismail.sahin@sirket.example' },
  { name: 'Zeynep Çelik', email: 'zeynep.celik@muhasebe.example' },
  { name: 'Öznur Arslan', email: 'ozgur@lojistik.example' },
  { name: 'Ufuk Güneş', email: 'ufuk@danismanlik.example' },
  { name: 'Destek Ekibi', email: 'destek@servis.example' },
  { name: 'Haftalık Bülten', email: 'bulten@haber.example' },
  { name: 'Canan Öztürk', email: 'canan@sirket.example' },
  { name: '', email: 'noreply@bildirim.example' },
  { name: 'Burak Aydın', email: 'burak.aydin@ortak.example' },
  { name: 'Ğ. Ş. Yılmaz', email: 'gsyilmaz@kurum.example' },
];

const SUBJECTS = [
  'Toplantı notları ve aksiyon listesi',
  'Fatura ödemesi hakkında bilgilendirme',
  'Re: Teklif revizyonu',
  'Haftalık rapor – 38. hafta',
  'Sözleşme taslağı incelemeniz için',
  'Yarınki sunum için son kontrol',
  'Kargo gönderiniz yola çıktı',
  'Yeni müşteri talebi: entegrasyon',
  'Bütçe onayı bekleniyor',
  'Şifre sıfırlama bağlantınız',
  'Fwd: Tedarikçi fiyat listesi',
  'Ekip etkinliği için tarih anketi',
  '(konu yok)',
  'Sistem bakımı duyurusu',
  'İzin talebiniz onaylandı',
  'Güvenlik güncellemesi gerekli',
];

const PREVIEWS = [
  'Merhaba, geçen görüşmemizde konuştuğumuz maddeleri sizin için derledim. Lütfen inceleyip geri bildirim verin.',
  'İlgili belgeyi ekte bulabilirsiniz. Ödeme vadesi ay sonuna kadar uzatılmıştır.',
  'Teşekkürler, önerilerinizi dikkate alarak taslağı güncelledik. Yeni sürüm ekte.',
  'Bu hafta tamamlanan işler, bekleyenler ve önümüzdeki hafta planı aşağıdadır.',
  'Kısa bir hatırlatma: yarın saat 10:00’da çevrimiçi toplantımız var.',
  'Talebiniz alındı ve ilgili ekibe iletildi. En kısa sürede dönüş yapılacaktır.',
  'Detayları görmek için bağlantıya tıklayın. Bu ileti otomatik olarak oluşturulmuştur.',
  '',
];

/** Small deterministic PRNG so screenshots are stable between runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

interface GenOptions {
  accountId: string;
  folderId: string;
  role: FolderRole;
  count: number;
  seed: number;
  now: number;
}

export function generateMessages({ accountId, folderId, role, count, seed, now }: GenOptions): MessageSummary[] {
  const rand = mulberry32(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const own: Person = { name: 'Ayşe Demir', email: 'ayse.demir@sirket.example' };
  const labelNames = MOCK_LABELS.map((l) => l.name);

  // Newest first, spread so every date-group header (Bugün … month names) appears in the Inbox.
  const spread = role === 'inbox' ? 75 : 40;
  const out: MessageSummary[] = [];
  for (let i = 0; i < count; i++) {
    const age = (i / Math.max(1, count - 1)) ** 1.6 * spread * DAY + rand() * 3 * 3_600_000;
    const outgoing = role === 'sent' || role === 'drafts';
    const other = pick(PEOPLE);
    const attachments = rand() < 0.22;
    out.push({
      id: `${folderId}-${i}`,
      accountId,
      folderId,
      threadId: `thread-${folderId}-${i}`,
      from: outgoing ? own : other,
      to: outgoing ? [other, ...(rand() < 0.3 ? [pick(PEOPLE)] : [])] : [own],
      subject: pick(SUBJECTS),
      preview: pick(PREVIEWS),
      date: new Date(now - age).toISOString(),
      seen: role === 'inbox' ? rand() > 0.28 : true,
      pinned: role === 'inbox' ? rand() < 0.06 : rand() < 0.03,
      answered: !outgoing && rand() < 0.15,
      forwarded: !outgoing && rand() < 0.07,
      draft: role === 'drafts',
      hasAttachments: attachments,
      labels: rand() < 0.25 ? [pick(labelNames)] : [],
      outbox: { state: 'none' },
    });
  }
  // A couple of in-flight outbox rows so the Sent folder shows those states.
  if (role === 'sent' && out[0] && out[1]) {
    out[0].outbox = { state: 'queued' };
    out[1].outbox = { state: 'failed', error: 'Gönderilemedi' };
  }
  return out;
}
