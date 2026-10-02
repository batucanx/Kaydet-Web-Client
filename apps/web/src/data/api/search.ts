import { encodeSearchQuery } from '@kaydet/domain';
import type {
  SearchAccountScope,
  SearchFilters,
  SearchPageDTO,
} from '@kaydet/domain';
import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export interface SearchApiParams {
  q: string;
  accounts: SearchAccountScope;
  filters?: SearchFilters;
  cursor?: string | null;
  limit?: number;
}

export function searchMessages(
  client: ApiClient = defaultApiClient,
  params: SearchApiParams,
  signal?: AbortSignal,
): Promise<SearchPageDTO> {
  const query = encodeSearchQuery(params);
  return client.get<SearchPageDTO>('/search', { query, signal });
}
