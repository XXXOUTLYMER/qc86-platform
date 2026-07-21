const isProduction = process.env.NODE_ENV === 'production';
const defaultDevelopmentSecret = 'qc86-platform-secret-key-change-in-production';
const sessionSecret = process.env.SESSION_SECRET || defaultDevelopmentSecret;
const insecureProductionSecrets = new Set([
  defaultDevelopmentSecret,
  'replace-with-a-long-random-secret-at-least-32-characters'
]);

if (isProduction && insecureProductionSecrets.has(sessionSecret)) {
  throw new Error('生产环境必须设置 SESSION_SECRET。请在 Docker 项目变量中填写一段随机长密码。');
}

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
  }
};
