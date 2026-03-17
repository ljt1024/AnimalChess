# 斗兽棋联机版

这是一个基于 `React + Vite + Socket.IO` 的在线斗兽棋项目，支持：

- 双人联机房间
- 人机对战房间
- 悔棋、战报、音效

## 启动

前端：

```bash
npm install
npm run dev
```

服务端：

```bash
cd server
npm install
npm run dev
```

默认服务端端口为 `5011`。

服务端环境变量文件：

- 示例文件：`server/.env.example`
- 本地实际配置：`server/.env`

## 前端环境区分

前端现在通过 `VITE_SOCKET_URL` 读取 Socket 服务地址：

- 开发环境：[`/Users/ljt/Documents/trae_projects/game/.env.development`](/Users/ljt/Documents/trae_projects/game/.env.development)
- 生产环境：[`/Users/ljt/Documents/trae_projects/game/.env.production`](/Users/ljt/Documents/trae_projects/game/.env.production)
- 本地覆盖示例：[`/Users/ljt/Documents/trae_projects/game/.env.local.example`](/Users/ljt/Documents/trae_projects/game/.env.local.example)

建议用法：

- `npm run dev` 默认读取 `.env.development`
- `npm run build` 默认读取 `.env.production`
- 需要临时覆盖时，复制 `.env.local.example` 为 `.env.local`，改成你自己的地址

未配置时：

- 开发环境默认回退到 `http://127.0.0.1:5011`
- 生产环境默认回退到当前页面同源地址

## DeepSeek 人机模式

大厅中新增了“人机对战”按钮。创建后会自动加入一个 AI 对手。

- 未配置大模型时：自动使用本地启发式 AI
- 已配置大模型时：优先使用 DeepSeek 接口决策
- 大模型请求失败时：自动回退到本地启发式 AI，不影响继续对局

服务端可配置环境变量：

```bash
PORT=5011
CORS_ORIGIN=*
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_MODEL=deepseek-chat
```

说明：

- 大模型调用放在服务端，避免前端暴露密钥
- `DEEPSEEK_API_URL` 和 `DEEPSEEK_MODEL` 都可按你的实际网关或兼容层修改
