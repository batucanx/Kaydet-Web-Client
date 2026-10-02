import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerSignatureRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listSignatures', ({ ctx, params }) => u.listSignatures(ctx, params.accountId));
  r.bind('putSignature', ({ ctx, params, body }) => u.putSignature(ctx, params.accountId, params.signatureId, body));
  r.bind('deleteSignature', ({ ctx, params }) => u.deleteSignature(ctx, params.accountId, params.signatureId));
}
