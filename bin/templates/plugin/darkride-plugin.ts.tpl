import { definePlugin } from '@darkrideapp/plugin-sdk';
import { register{{pascalName}}Endpoints } from './backend/routes';

export default definePlugin({
  name: '{{slug}}',
  // version is read from package.json#version at boot — do not duplicate it here.

  register(ctx) {
    register{{pascalName}}Endpoints(ctx);

    ctx.nav([
      { group: 'Tools', label: '{{label}}', path: '/{{slug}}', icon: 'box' },
    ]);

    ctx.pages([
      { path: '/{{slug}}' },
    ]);
  },

  // Uncomment when you need async runtime setup. Called in dependency order
  // after every plugin's register() has run. Construct services here, register
  // service-dependent routes/jobs/tools via ctx.routes/jobs/tools, and call
  // ctx.exposeService<MyApi>(impl) if other plugins consume your APIs.
  // async start(ctx) {},

  // Uncomment when you need teardown. Called in REVERSE dependency order on
  // shutdown. Stop intervals, close handles, etc. Failures here are logged
  // but do not halt subsequent stops.
  // async stop(ctx) {},
});
