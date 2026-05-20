import type { PluginContext } from '@darkrideapp/plugin-sdk';

export function register{{pascalName}}Endpoints(ctx: PluginContext): void {
  ctx.api(api => {
    api.get('/v1/{{slug}}/status', (_req, res) => {
      res.json({ success: true, data: { status: 'ok', plugin: '{{slug}}' } });
    });
  });
}
