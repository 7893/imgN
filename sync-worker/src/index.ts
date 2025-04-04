// src/index.ts
import { handleFetch, handleScheduled } from './handlers';
import { Env } from './types'; // 从 types.ts 导入 Env

// 导出 Env 类型，如果其他地方需要导入 Worker 的类型定义
export type { Env };

// 导出包含 fetch 和 scheduled 处理程序的默认对象
// 这些处理程序现在从 handlers.ts 导入
export default {
    fetch: handleFetch,
    scheduled: handleScheduled,

    // 如果将来需要处理队列消息，可以在 handlers.ts 中实现 handleQueue
    // 然后在这里添加:
    // queue: handleQueue, 
};