import path from 'path';

/**
 * Resolve the project venv's Python executable for the current platform.
 * House rule: never use system python3 — always the venv.
 */
export function getPythonPath(): string {
  if (process.platform === 'win32') {
    return path.resolve('.venv/Scripts/python.exe');
  }
  return path.resolve('.venv/bin/python');
}
