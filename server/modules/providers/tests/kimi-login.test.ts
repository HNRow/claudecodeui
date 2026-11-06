import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractKimiDeviceCode, kimiLoginService } from '@/modules/providers/list/kimi/kimi-login.service.js';

const FAKE_LOGIN_SCRIPT = `#!/usr/bin/env node
process.stderr.write('Open https://example.test/device\\n');
process.stderr.write('Then enter code: ABCD-1234\\n');
setInterval(() => {}, 1000);
`;

test('device-code output yields the verification URL and user code', () => {
  const parsed = extractKimiDeviceCode('Open this URL in your browser: https://kimi.com/device\nenter code: WXYZ-9876');
  assert.equal(parsed.verificationUrl, 'https://kimi.com/device');
  assert.equal(parsed.userCode, 'WXYZ-9876');

  assert.deepEqual(extractKimiDeviceCode('no device flow here'), {
    verificationUrl: null,
    userCode: null,
  });
});

test('only one login process runs at a time and cancel stops it', { concurrency: false }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-login-'));
  const cliPath = path.join(tempDirectory, 'fake-kimi-login.cjs');
  const previousCliPath = process.env.KIMI_CLI_PATH;
  await writeFile(cliPath, FAKE_LOGIN_SCRIPT, 'utf8');
  await chmod(cliPath, 0o755);
  process.env.KIMI_CLI_PATH = cliPath;

  try {
    kimiLoginService.cancel();
    const started = kimiLoginService.start();
    assert.equal(started.state, 'running');

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 8_000;
      const poll = () => {
        if (kimiLoginService.getStatus().verificationUrl) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('Timed out waiting for the device code.'));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
    const running = kimiLoginService.getStatus();
    assert.equal(running.verificationUrl, 'https://example.test/device');
    assert.equal(running.userCode, 'ABCD-1234');

    assert.throws(() => kimiLoginService.start(), /already in progress/);

    const cancelled = kimiLoginService.cancel();
    assert.equal(cancelled.state, 'cancelled');
  } finally {
    kimiLoginService.close();
    if (previousCliPath === undefined) delete process.env.KIMI_CLI_PATH;
    else process.env.KIMI_CLI_PATH = previousCliPath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});