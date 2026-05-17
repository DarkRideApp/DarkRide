import { spawn } from 'child_process';
import { resolve } from 'path';

export async function pluginDev(): Promise<void> {
  console.log('Starting DarkRide dev server...\n');

  const child = spawn('npm', ['run', 'dev'], {
    cwd: resolve('.'),
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`Failed to start dev server: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}
