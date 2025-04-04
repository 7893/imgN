// src/index.ts (sync-worker)
import { handleFetch, handleQueue } from './handlers';
import { Env } from './types';

export type { Env };

// 确保导出了 fetch 和 queue
export default {
	fetch: handleFetch,
	queue: handleQueue,
};