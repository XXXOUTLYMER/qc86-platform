# 项目结构说明

这个项目已经按“API 接口、网页路由、页面、样式和数据”分开整理。新增 API 时只需要在 `api/` 中增加适配器，不需要改动旧 qc86 的实现。

## 主要目录

```text
qc86-platform/
├── api/                    # 所有短信平台 API 实现
│   ├── providerService.js  # 统一调度层，根据项目选择 API
│   ├── qc86.js             # 原 qc86 API
│   └── uoomsg.js           # 新 uoomsg API
├── routes/                 # 管理后台和用户页面路由
│   ├── admin.js
│   ├── user.js
│   ├── rejectedPhones.js
│   ├── qc86.js             # 旧入口兼容转发，不要删除
│   ├── uoomsg.js           # 旧入口兼容转发，不要删除
│   └── providerService.js  # 旧入口兼容转发，不要删除
├── views/                  # EJS 网站页面
│   ├── admin/              # 管理后台页面
│   └── user/               # 用户卡密页面
├── public/                 # 网站静态和修饰资源
│   ├── css/                # 样式
│   ├── js/                 # 可复用前端交互脚本
│   └── assets/             # 图片、图标等资源
├── data/platform.db        # 运行数据，部署时必须持久化
├── database.js             # 数据表和数据库升级
├── config.js               # 基础配置
└── server.js               # 网站启动入口
```

## API 如何互不影响

1. 后台“API 对接”保存每个服务商自己的地址、账号或 Token。
2. 后台“项目管理”把项目绑定到指定 API 服务商。
3. 卡密只绑定项目。
4. 用户使用卡密时，`api/providerService.js` 根据项目选择 qc86 或 uoomsg。
5. 测试卡密使用本地测试流程，不访问外部 API。

原来的 `routes/qc86.js` 等文件现在是兼容入口。已有代码即使仍引用旧路径，也会自动转发到新的 `api/` 目录，因此旧 qc86 功能不会因为目录整理而失效。

## 修改网站

- 管理后台页面：修改 `views/admin/`
- 用户卡密页面：修改 `views/user/index.ejs`
- 管理后台样式：修改 `public/css/admin.css`
- 新的公共交互脚本：放到 `public/js/`
- 图片和图标：放到 `public/assets/`

后台 API 配置、qc86 原有凭证、uoomsg 配置、平台运行参数和 qc86 快捷操作现在统一在 `/admin/api-providers` 页面。旧的 `/admin/settings` 地址只做兼容跳转，不再显示旧的独立页面。

修改完成后重启程序即可生效。EJS、CSS 和 JavaScript 文件均会包含在 Docker 镜像中。

## 添加第三个 API

1. 在 `api/` 新增服务商适配器，例如 `another-provider.js`。
2. 在 `api/providerService.js` 中增加服务商类型分派。
3. 在数据库和后台 API 对接页面增加对应配置字段。
4. 给项目绑定该服务商，再生成项目卡密。

不要直接把不同 API 的 Token 写到项目或卡密中。凭证应保存在 API 服务商配置里，避免项目之间串用。

## Docker 部署与备份

Docker 必须持久化：

```yaml
volumes:
  - ./data:/app/data
```

需要备份时，至少备份整个项目目录和 `data/platform.db`。更新程序时保留 NAS 上的 `data/` 目录，再重新构建并启动容器，原有项目、卡密和设置就不会丢失。
