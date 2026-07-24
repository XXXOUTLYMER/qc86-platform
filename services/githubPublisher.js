const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const GIT_TIMEOUT_MS = 60000;
let isPublishing = false;

function getGitOptions() {
  return {
    cwd: projectRoot,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  };
}

function redactOutput(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(ghp|github_pat)_[A-Za-z0-9_]+/g, '$1_[REDACTED]')
    .replace(/(token|password|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(0, 1200)
    .trim();
}

function cleanGitError(error) {
  const details = redactOutput(error && (error.stderr || error.stdout || error.message));
  if (/SSL_ERROR_SYSCALL|Could not resolve host|Failed to connect|Connection reset|Recv failure|Network is unreachable/i.test(details)) {
    return '无法连接到 GitHub。请检查当前 Mac 的网络、DNS 或代理连接后再发布；系统已自动尝试兼容连接方式。';
  }
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied/i.test(details)) {
    return 'GitHub 登录未完成或当前账号没有仓库权限。请先在 Mac 的终端完成一次 GitHub 登录后再试。';
  }
  if (/non-fast-forward|fetch first|rejected/i.test(details)) {
    return '远程仓库已有较新的提交。请先在本地同步并处理差异后再发布，系统不会强制覆盖远程版本。';
  }
  if (/already exists/i.test(details)) {
    return '这个版本标签已经存在，请使用新的版本号。';
  }
  return details || 'Git 操作失败，请稍后再试。';
}

function isHttpsConnectionError(error) {
  const details = String(error && (error.stderr || error.stdout || error.message) || '');
  return /SSL_ERROR_SYSCALL|Failed to connect|Connection reset|Recv failure|Connection timed out/i.test(details);
}

async function executeGit(args) {
  const { stdout, stderr } = await execFileAsync('git', args, getGitOptions());
  return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
}

async function runGit(args) {
  try {
    return await executeGit(args);
  } catch (error) {
    // GitHub occasionally terminates HTTP/2 TLS connections on some macOS
    // networks. Retry only the failed command with HTTP/1.1 before surfacing
    // a network error; local Git commands stay on their normal fast path.
    if (isHttpsConnectionError(error)) {
      try {
        return await executeGit(['-c', 'http.version=HTTP/1.1', ...args]);
      } catch (retryError) {
        const safeError = new Error(cleanGitError(retryError));
        safeError.code = retryError && retryError.code;
        throw safeError;
      }
    }
    const safeError = new Error(cleanGitError(error));
    safeError.code = error && error.code;
    throw safeError;
  }
}

function normalizeReleaseVersion(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return `v${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`;
}

async function getGitStatus() {
  const [branchResult, statusResult, lastCommitResult, originResult] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['status', '--short']),
    runGit(['log', '-1', '--format=%h%x1f%s%x1f%ci']),
    runGit(['remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }))
  ]);
  const [hash = '', subject = '', committedAt = ''] = lastCommitResult.stdout.split('\x1f');
  const changedFiles = statusResult.stdout
    ? statusResult.stdout.split('\n').filter(Boolean).map(line => line.slice(3)).slice(0, 100)
    : [];

  return {
    branch: branchResult.stdout || '未命名分支',
    hasOrigin: Boolean(originResult.stdout),
    isClean: changedFiles.length === 0,
    changedFiles,
    changedFileCount: statusResult.stdout ? statusResult.stdout.split('\n').filter(Boolean).length : 0,
    lastCommit: { hash, subject, committedAt }
  };
}

async function ensureOrigin() {
  const { stdout } = await runGit(['remote', 'get-url', 'origin']);
  if (!stdout) throw new Error('未找到 GitHub 远程仓库 origin，暂时不能发布。');
}

async function stageAndCommit(message) {
  await runGit(['add', '-A']);
  const { stdout: stagedFiles } = await runGit(['diff', '--cached', '--name-only']);
  const files = stagedFiles ? stagedFiles.split('\n').filter(Boolean) : [];
  if (files.length) await runGit(['commit', '-m', message]);
  const { stdout: hash } = await runGit(['rev-parse', '--short', 'HEAD']);
  return { createdCommit: files.length > 0, files, hash };
}

async function withPublishLock(callback) {
  if (isPublishing) throw new Error('正在发布中，请等待当前操作完成后再试。');
  isPublishing = true;
  try {
    return await callback();
  } finally {
    isPublishing = false;
  }
}

async function publishBeta() {
  return withPublishLock(async () => {
    await ensureOrigin();
    const prepared = await stageAndCommit(`Beta publish ${new Date().toISOString()}`);
    await runGit(['push', 'origin', 'HEAD:refs/heads/beta']);
    return { ...prepared, target: 'beta' };
  });
}

async function publishRelease(versionInput) {
  const version = normalizeReleaseVersion(versionInput);
  if (!version) {
    throw new Error('版本号格式应为 v1.0.1 或 1.0.1。');
  }

  return withPublishLock(async () => {
    await ensureOrigin();
    const { stdout: remoteTag } = await runGit(['ls-remote', '--tags', 'origin', `refs/tags/${version}`]);
    if (remoteTag) throw new Error('这个版本标签已经存在，请使用新的版本号。');

    const prepared = await stageAndCommit(`Release ${version}`);
    await runGit(['push', 'origin', 'HEAD:refs/heads/main']);

    const { stdout: existingTag } = await runGit(['tag', '--list', version]);
    if (existingTag) {
      const [{ stdout: taggedCommit }, { stdout: headCommit }] = await Promise.all([
        runGit(['rev-list', '-n', '1', version]),
        runGit(['rev-parse', 'HEAD'])
      ]);
      if (taggedCommit !== headCommit) throw new Error('本地已存在同名版本标签，但它指向其他提交。请使用新的版本号。');
    } else {
      await runGit(['tag', '-a', version, '-m', `Release ${version}`]);
    }
    await runGit(['push', 'origin', version]);
    return { ...prepared, target: 'main', version };
  });
}

module.exports = {
  getGitStatus,
  publishBeta,
  publishRelease,
  normalizeReleaseVersion
};
