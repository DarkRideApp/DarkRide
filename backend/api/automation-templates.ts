import { registerEndpoint } from './api-service';
import { templates } from './automation-template-data';

export function registerAutomationTemplateEndpoints(): void {
  // GET /v1/automation/templates — list all templates
  registerEndpoint('GET', '/v1/automation/templates', (_req, res) => {
    // Return templates without the full code for the list view
    const summaries = templates.map(({ code: _code, ...rest }) => rest);
    res.json({ success: true, data: summaries });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/template/:id — get a single template with full code
  registerEndpoint('GET', '/v1/automation/template/:id', (req, res) => {
    const template = templates.find(t => t.id === req.params.id);
    if (!template) {
      res.status(404).json({ success: false, error: 'Template not found' });
      return;
    }
    res.json({ success: true, data: template });
  }, { requires: ['core.automations:read'] });
}
