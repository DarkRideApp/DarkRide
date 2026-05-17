import { registerWebsocketEndpoint } from './handlers';
import { AutomationCompiler } from '../services/automation-compiler';
import type { ValidationResult } from '../../shared/types/websocket';

export function registerAutomationWebsocketEndpoints(compiler: AutomationCompiler): void {
  // validate-automation — debounced server-side validation
  registerWebsocketEndpoint('validate-automation', (message, socket) => {
    const { code, automationId } = message;

    if (!code || automationId === undefined) {
      socket.send(JSON.stringify({
        type: 'validation-result',
        automationId: automationId ?? 0,
        errors: [{ line: 0, column: 0, message: 'code and automationId are required', severity: 1 }],
        success: false,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    const result = compiler.compileWithCache(code, `ws-validate-${automationId}`);

    const errors = (result.diagnostics || []).map((d) => {
      const pos = d.file?.getLineAndCharacterOfPosition(d.start || 0);
      return {
        line: pos?.line ?? 0,
        column: pos?.character ?? 0,
        message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
        severity: d.category,
      };
    });

    const response: ValidationResult = {
      type: 'validation-result',
      automationId,
      errors,
      success: errors.filter((e) => e.severity === 1).length === 0,
      timestamp: new Date().toISOString(),
    };

    socket.send(JSON.stringify(response));
  }, { requires: ['core.automations:read'] });

  // session-status — clients subscribe to real-time session updates
  // The broadcastToAll in AutomationRunner already sends session-status messages
  // This endpoint just acknowledges the subscription
  registerWebsocketEndpoint('session-status', (message, socket) => {
    socket.send(JSON.stringify({
      type: 'session-status-subscribed',
      timestamp: new Date().toISOString(),
    }));
  }, { requires: ['core.automations:read'] });
}
