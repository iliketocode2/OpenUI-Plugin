import Mocha from 'mocha';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 60_000, color: true });
  for (const f of readdirSync(__dirname)) {
    if (f.endsWith('.test.js')) mocha.addFile(join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
