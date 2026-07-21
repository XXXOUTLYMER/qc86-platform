FROM node:22-alpine

WORKDIR /app

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# 先复制依赖配置，利用 Docker 缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制项目文件
COPY . .

# 创建数据目录（SQLite 文件存放位置）
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
