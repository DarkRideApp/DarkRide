import { registerEndpoint } from '../../../backend/api/api-service';

export function register{{pascalName}}Endpoints(): void {
  registerEndpoint('GET', '/v1/{{slug}}/status', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', plugin: '{{slug}}' } });
  });
}
