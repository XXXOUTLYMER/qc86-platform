const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.js');
const baseEnv = {
  ...process.env,
  SESSION_SECRET: 'test-session-secret-with-more-than-thirty-two-characters',
};

function run(env) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)}).initialAdmin.getCredentials()`], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  });
}

assert.equal(run({ NODE_ENV: 'production', INITIAL_ADMIN_PASSWORD: '' }).status, 1);
assert.equal(run({ NODE_ENV: 'production', INITIAL_ADMIN_PASSWORD: 'admin123' }).status, 1);
assert.equal(run({ NODE_ENV: 'production', INITIAL_ADMIN_PASSWORD: 'strong-admin-password-2026' }).status, 0);
assert.equal(run({ NODE_ENV: 'development', INITIAL_ADMIN_PASSWORD: '' }).status, 0);

console.log('initial admin configuration checks passed');
