'use strict';

/**
 * ESLint rule: no-direct-handle-message
 *
 * Flags any call to .handleMessage(...) on an agent obtained directly from:
 *   - new AiAgent(...)
 *   - new ClaudeCliAgent(...)
 *   - getAiAgent()
 *
 * Valid paths (not flagged):
 *   - aiFactory.forUser(n).handleMessage(...)
 *   - aiFactory.forCoreService(k).handleMessage(...)
 *   - ctx.ai.agent().handleMessage(...)
 *   - ctx.ai.forUser(n).handleMessage(...)
 *   - any other unknown provenance (we only flag known-forbidden sources)
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling handleMessage on an agent obtained outside the AiAgentFactory / ctx.ai path.',
      recommended: false,
    },
    messages: {
      noDirectAgent:
        'handleMessage must be called on an agent obtained from aiFactory.forUser/forCoreService or ctx.ai.agent/forUser — never on a raw AiAgent/ClaudeCliAgent or getAiAgent() return value.',
    },
    schema: [],
  },

  create(context) {
    const FORBIDDEN_CONSTRUCTORS = new Set(['AiAgent', 'ClaudeCliAgent']);
    const FORBIDDEN_FACTORY_CALLS = new Set(['getAiAgent']);

    /**
     * Returns true and reports if the given expression is a forbidden agent source.
     * @param {import('eslint').Rule.RuleContext} ctx
     * @param {import('estree').Node} reportNode  — the CallExpression node to attach the report to
     * @param {import('estree').Expression} expr   — the expression to examine
     */
    function checkAndReport(reportNode, expr) {
      // new AiAgent(...) or new ClaudeCliAgent(...)
      if (
        expr.type === 'NewExpression' &&
        expr.callee.type === 'Identifier' &&
        FORBIDDEN_CONSTRUCTORS.has(expr.callee.name)
      ) {
        context.report({ node: reportNode, messageId: 'noDirectAgent' });
        return true;
      }

      // getAiAgent()
      if (
        expr.type === 'CallExpression' &&
        expr.callee.type === 'Identifier' &&
        FORBIDDEN_FACTORY_CALLS.has(expr.callee.name)
      ) {
        context.report({ node: reportNode, messageId: 'noDirectAgent' });
        return true;
      }

      return false;
    }

    return {
      CallExpression(node) {
        // Only care about <something>.handleMessage(...)
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'handleMessage'
        ) {
          return;
        }

        const obj = node.callee.object;

        // Inline form: new AiAgent(...).handleMessage() or getAiAgent().handleMessage()
        if (checkAndReport(node, obj)) return;

        // Variable form: trace the identifier back to its declarator in scope.
        if (obj.type === 'Identifier') {
          const scope = context.getScope();
          const variable = findVariable(scope, obj.name);
          if (!variable || variable.defs.length === 0) return;

          const def = variable.defs[0];
          // Only look at `const x = <init>` / `let x = <init>` / `var x = <init>`
          if (def.node.type !== 'VariableDeclarator' || !def.node.init) return;

          checkAndReport(node, def.node.init);
        }
      },
    };
  },
};

/**
 * Walk up the scope chain to find a variable by name.
 * @param {import('eslint').Scope.Scope} scope
 * @param {string} name
 * @returns {import('eslint').Scope.Variable | undefined}
 */
function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const variable = current.set && current.set.get(name);
    if (variable) return variable;
    current = current.upper;
  }
  return undefined;
}
