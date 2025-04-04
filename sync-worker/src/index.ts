// src/index.ts (sync-worker)
import { handleFetch, handleQueue } from './handlers'; // 导入 queue handler
import { Env } from './types';

export type { Env }; 

// 导出包含 fetch 和 queue 处理程序的默认对象
// 不再导出 scheduled
export default {
	fetch: handleFetch,
	queue: handleQueue, 
};
