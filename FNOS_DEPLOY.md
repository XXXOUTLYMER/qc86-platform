# fnOS Docker 部署

## 版本规则

这套项目现在分为两条清晰的运行线，代码和数据不会混在一起：

- **Mac 本地：Beta 版**。直接运行项目时会显示 `Beta v1.0.0`，用于修改和测试。
- **GitHub：版本库与镜像仓库**。`beta` 分支会发布 `:beta` 测试镜像；正式发布用 Git 标签，例如 `v1.0.1`。
- **fnOS/NAS：正式版**。NAS 必须固定使用一个正式标签，例如 `:v1.0.1`，页面会显示 `正式版 v1.0.1`。

不要让 NAS 长期使用 `:latest`。固定版本才能明确知道正在运行哪一版，也能随时退回旧版。

## 1. 上传项目

在 fnOS 的文件管理器中创建一个固定目录，例如：

`/vol1/1000/docker/qc86-platform`

将本项目全部上传到该目录。不要上传本机的 `node_modules` 目录。

给另一台 NAS 或其他人部署时，请只交付干净源码：不要带上 `data/`、`fnos.env`、
`.env`、日志、数据库文件或 `node_modules/`。上传后，将 `fnos.env.example` 复制为
`fnos.env`，由该 NAS 的管理员自行填写。

## 2. 设置项目变量

在 fnOS 文件管理器中打开项目目录里的 `fnos.env`，并至少修改：

- `SESSION_SECRET`：填写至少 32 个字符的随机密码，不能使用示例值。
- `COOKIE_SECURE`：首次内网测试保持 `false`；启用 HTTPS 后必须改为 `true` 并重启容器。

默认访问端口是 `3000`。若 NAS 已被占用，可在 `docker-compose.yml` 中将
`"3000:3000"` 左侧的第一个 `3000` 改为其他端口，例如 `"3010:3000"`。

## 3. 在 Docker 管理器创建 Compose 项目

在 fnOS Docker 的 Compose/项目功能中，选择刚才的项目目录，并使用其中的
`docker-compose.yml` 创建项目。构建完成后，访问：

`http://NAS 局域网 IP:3000/`

管理员入口：

`http://NAS 局域网 IP:3000/admin/login`

## 4. 确认数据持久化

首次打开网站后，项目目录中的 `data/platform.db` 会保存卡密、项目和后台配置。
更新镜像或重建容器前，先复制整个 `data` 目录作为备份。

## 5. 对外访问前的安全要求

不要将 `3000` 或 `3010` 端口直接映射到公网。应先配置反向代理和 HTTPS，只在路由器
上开放 80/443。启用 HTTPS 后将 `fnos.env` 中的 `COOKIE_SECURE` 改为 `true`，然后重启项目。

建议只通过 NAS 内网、固定 IP 或 VPN 访问 `/admin`。

## 6. fnOS 无法拉取 node:20-alpine 时

这是 NAS 的镜像仓库或 Docker Hub 授权问题，不是网站代码错误。请先在 fnOS Docker
的镜像/仓库设置中修复 Docker Hub 拉取权限，确认可以拉取 `node:20-alpine` 后再构建。
也可以先在 Mac 构建镜像并导出为 tar 文件，再在 fnOS Docker 的镜像页面导入。

## 7. 用 GitHub 自动构建并更新 NAS

仓库内的 `.github/workflows/publish-image.yml` 会自动构建镜像并发布到 GitHub Container Registry（GHCR）：

- 推送到 `beta` 分支：生成 `:beta` 测试镜像。
- 推送到 `main` 分支：生成 `:main` 候选镜像。
- 推送标签 `v1.0.1`：生成 `:v1.0.1` 正式镜像，同时更新 `:latest`。

1. 在 GitHub 新建一个**私有仓库**，例如 `qc86-platform`。
2. 将干净源码推送到 `beta` 分支进行测试。`data/`、`fnos.env`、`.env` 和数据库不会被提交。
3. 确认稳定后，将代码合并到 `main`，再创建并推送一个正式标签，例如 `v1.0.1`。
4. 等 GitHub Actions 成功后，在每台 NAS 的 `fnos.env` 中填写：
   ```dotenv
   QC86_IMAGE=ghcr.io/<GitHub 用户名>/<仓库名>:v1.0.1
   APP_STAGE=production
   APP_VERSION=v1.0.1
   ```
5. 用 `docker-compose.ghcr.yml` 创建 Compose 项目，而不是普通的 `docker-compose.yml`。

每次更新正式站：Mac 完成测试后，推送正式标签；Actions 完成构建后，在 fnOS Docker 项目中执行
“拉取镜像/重新创建（或更新）”。由于 `./data:/app/data` 是独立卷，更新代码不会清空该 NAS 自己的
卡密、项目、使用记录或后台设置。

需要**回退版本**时，把 `QC86_IMAGE` 和 `APP_VERSION` 一起改回上一版，例如 `v1.0.0`，然后在 fnOS
重新拉取并创建项目即可。回退代码不会删除 `data/platform.db`；但若新版本已做过数据库结构升级，仍建议先备份 `data/`。

GHCR 默认的私有镜像需要 NAS 登录 GitHub Registry 才能拉取。若接受让镜像公开，可将 GitHub
Package 设为 Public；若保持私有，则为 NAS 创建只读的 GitHub Token，并在 Docker 的 Registry
登录界面填写 `ghcr.io`、GitHub 用户名与该 Token。
