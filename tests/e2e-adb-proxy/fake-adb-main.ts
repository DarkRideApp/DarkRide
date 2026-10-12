import { FakeAdbServer } from '../../backend/services/adb-proxy/testing/fake-adb-server';

const port = Number(process.env.FAKE_ADB_PORT || 15299);
const fake = new FakeAdbServer([{ serial: 'FAKE-E2E-1', features: 'cmd' }], {
  shell: (_serial, command) => (command.startsWith('getprop') ? 'e2eprod\nE2EModel\ne2edev\n' : `ran: ${command}\n`),
});

fake.start(port).then(
  () => console.log(`fake adb server listening on ${port}`),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    fake.stop().finally(() => process.exit(0));
  });
}
