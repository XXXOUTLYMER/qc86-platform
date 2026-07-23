const isProduction = process.env.NODE_ENV === 'production';
const defaultDevelopmentSecret = 'qc86-platform-secret-key-change-in-production';
const sessionSecret = process.env.SESSION_SECRET || defaultDevelopmentSecret;
const packageInfo = require('./package.json');
const insecureProductionSecrets = new Set([
  defaultDevelopmentSecret,
  'replace-with-a-long-random-secret-at-least-32-characters'
]);
const defaultDevelopmentAdminPassword = 'admin123';

if (isProduction && insecureProductionSecrets.has(sessionSecret)) {
  throw new Error('生产环境必须设置 SESSION_SECRET。请在 Docker 项目变量中填写一段随机长密码。');
}

function getInitialAdminCredentials() {
  const username = String(process.env.INITIAL_ADMIN_USERNAME || 'admin').trim();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || (isProduction ? '' : defaultDevelopmentAdminPassword));

  if (!username || username.length > 64) {
    throw new Error('INITIAL_ADMIN_USERNAME 必须是 1 到 64 个字符。');
  }

  if (isProduction) {
    if (password.length < 12 || password === defaultDevelopmentAdminPassword) {
      throw new Error('首次正式部署必须设置至少 12 位且非默认值的 INITIAL_ADMIN_PASSWORD。');
    }
  }

  return { username, password };
}

function readVersion(value, fallback) {
  const normalized = String(value || '').trim().replace(/[^0-9A-Za-z.+_-]/g, '').slice(0, 48);
  if (!normalized) return fallback;
  return normalized.startsWith('v') ? normalized : `v${normalized}`;
}

// Mac 直接运行时默认是 Beta。NAS 的 Compose 文件会明确传入 production，
// 这样不会因为 NODE_ENV 或部署方式的变化而误显示为正式版。
const appStage = process.env.APP_STAGE === 'production' ? 'production' : 'beta';
const appVersion = readVersion(process.env.APP_VERSION, `v${packageInfo.version || '1.0.0'}`);
const appVersionLabel = appStage === 'production'
  ? `正式版 ${appVersion}`
  : `Beta ${appVersion}`;

module.exports = {
  // qc86 API configuration
  qc86: {
    baseUrl: 'https://api.qc86.shop/api',
    username: process.env.QC86_USERNAME || '',
    password: process.env.QC86_PASSWORD || '',
  },
  // Server configuration
  server: {
    port: process.env.PORT || 3000,
    sessionSecret,
    secureCookie: process.env.COOKIE_SECURE === 'true',
  },
  initialAdmin: {
    getCredentials: getInitialAdminCredentials,
  },
  // Public, non-sensitive build identity shown in the UI and /health.
  app: {
    stage: appStage,
    version: appVersion,
    label: appVersionLabel,
  }
};
