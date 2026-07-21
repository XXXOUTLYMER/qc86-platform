# fnOS Docker 部署

## 1. 上传项目

在 fnOS 的文件管理器中创建一个固定目录，例如：

`/vol1/1000/docker/qc86-platform`

将本项目全部上传到该目录。不要上传本机的 `node_modules` 目录。

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
