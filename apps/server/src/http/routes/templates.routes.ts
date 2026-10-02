import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerTemplateRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('listTemplates', ({ ctx }) => u.listTemplates(ctx));
  r.bind('putTemplate', ({ ctx, params, body }) => u.putTemplate(ctx, params.templateId, body));
  r.bind('deleteTemplate', ({ ctx, params }) => u.deleteTemplate(ctx, params.templateId));
}
