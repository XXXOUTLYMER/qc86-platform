const isProduction = process.env.NODE_ENV === 'production';
const defaultDevelopmentSecret = 'qc86-platform-secret-key-change-in-production';
const sessionSecret = process.env.SESSION_SECRET || defaultDevelopmentSecret;
const packageInfo = require('./package.json');
const insecureProductionSecrets = new Set([
  defaultDevelopmentSecret,
  'replace-with-a-long-random-secret-at-least-32-characters'
]);

if (isProduction && insecureProductionSecrets.has(sessionSecret)) {
  throw new Error('生产环境必须设置 SESSION_SECRET。请在 Docker 项目变量中填写一段随机长密码。');
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
  // Public, non-sensitive build identity shown in the UI and /health.
  app: {
    stage: appStage,
    version: appVersion,
    label: appVersionLabel,
  }
};
