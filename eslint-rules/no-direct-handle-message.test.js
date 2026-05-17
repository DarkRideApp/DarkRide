'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-direct-handle-message');

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-direct-handle-message', rule, {
  valid: [
    // factory paths — all valid
    { code: `const agent = aiFactory.forUser(1); agent.handleMessage({});` },
    { code: `const agent = aiFactory.forCoreService('apk'); agent.handleMessage({});` },
    { code: `const agent = ctx.ai.agent(); agent.handleMessage({});` },
    { code: `const agent = ctx.ai.forUser(1); agent.handleMessage({});` },
    // Inline usage: aiFactory.forUser(1).handleMessage({})
    { code: `aiFactory.forUser(1).handleMessage({});` },
    // Arbitrary variable names — provenance matters, not the name
    { code: `const a = ctx.ai.agent(); a.handleMessage({});` },
    // handleMessage on an unrecognised object — we don't flag what we can't trace
    { code: `someObject.handleMessage({});` },
    // Variable whose init is something benign (e.g. a function call we don't recognise)
    { code: `const agent = makeAgent(); agent.handleMessage({});` },
    // Inline call on member expression chain — not from forbidden source
    { code: `this.ai.agent().handleMessage({});` },
  ],
  invalid: [
    {
      code: `const agent = new AiAgent(db); agent.handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
    {
      code: `const agent = new ClaudeCliAgent(db); agent.handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
    {
      code: `const agent = getAiAgent(); agent.handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
    // Inline: getAiAgent().handleMessage({})
    {
      code: `getAiAgent().handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
    // Inline: new AiAgent(...).handleMessage({})
    {
      code: `new AiAgent(db).handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
    // Inline: new ClaudeCliAgent(...).handleMessage({})
    {
      code: `new ClaudeCliAgent(db).handleMessage({});`,
      errors: [{ messageId: 'noDirectAgent' }],
    },
  ],
});

console.log('no-direct-handle-message rule: all test cases pass');
