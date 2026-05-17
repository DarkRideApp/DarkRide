'use strict';

// Plugin registers GET /v1/test-plugin/ping returning { pong: true }.
// Used by the e2e lifecycle test to assert routes appear/disappear with
// enable/disable.

module.exports = {
  name: 'test-plugin',
  version: '0.0.1',
  dependencies: [],
  optionalDependencies: [],
  aiScopes: [],
  register(ctx) {
    ctx.api(api => {
      api.get('/v1/test-plugin/ping', (_req, res) => {
        res.json({ pong: true });
      });
    });
  },
};

module.exports.default = module.exports;
