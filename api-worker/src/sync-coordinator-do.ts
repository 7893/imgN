// ~/imgN/api-worker/src/sync-coordinator-do.ts (增加了完成检测逻辑)
import { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';

interface Env { SYNC_TASK_QUEUE: Queue; }
interface SyncState { /* ... (保持不变) ... */ }

export class SyncCoordinatorDO implements DurableObject {
	state: DurableObjectState;
	env: Env;
	storage: DurableObjectStorage;

	constructor(state: DurableObjectState, env: Env) { /* ... (保持不变) ... */ }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] Request: ${request.method} ${path}`);

		try {
			switch (path) {
				case '/start': /* ... (保持不变) ... */ return await this.startSync();
				case '/stop':  /* ... (保持不变) ... */ return await this.stopSync();
				case '/status':/* ... (保持不变) ... */ return await this.getStatus();

				case '/report': // 修改：处理新的 payload 格式
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					try {
						// *** 修改：解析包含 photoCount 的 Body ***
						const data = await request.json<{ pageCompleted?: number, photoCount?: number, error?: string }>();
						// *** 结束修改 ***

						if (data?.error) { // 优先处理错误报告
							return await this.reportError(data.error);
						} else if (typeof data?.pageCompleted === 'number' && typeof data?.photoCount === 'number') {
							// 调用新的处理函数，传递 photoCount
							return await this.handleSuccessfulPageReport(data.pageCompleted, data.photoCount);
						} else {
							return new Response('Bad Request: Missing pageCompleted/photoCount or error in body', { status: 400 });
						}
					} catch (e) { console.error(`[DO ${doIdShort}] Error parsing report body:`, e); return new Response('Bad Request: Invalid JSON body', { status: 400 }); }

				case '/reset': /* ... (保持不变) ... */ return await this.resetState();

				default: return new Response('Not Found in DO', { status: 404 });
			}
		} catch (e: any) { /* ... (错误处理) ... */ return new Response(`Internal Server Error in DO`, { status: 500 }); }
	}

	/** 开始同步任务 (保持不变) */
	async startSync(): Promise<Response> { /* ... */ }

	/** 停止同步任务 (保持不变) */
	async stopSync(): Promise<Response> { /* ... */ }

	/** 获取当前同步状态 (保持不变) */
	async getStatus(): Promise<Response> { /* ... */ }

	/** 内部方法：处理成功的页面完成报告 (修改) */
	async handleSuccessfulPageReport(pageCompleted: number, photoCount: number): Promise<Response> { // <-- 接收 photoCount
		const doIdShort = this.state.id.toString().substring(0, 6);
		let nextPageQueued = false;
		let finalStatus = 'unknown';

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;

			console.log(`[DO ${doIdShort}] Received success report for page ${pageCompleted} (Photo Count: ${photoCount}). Status: ${currentStatus}, LastPg: ${lastPage}`);

			// 更新最后处理页码
			if (pageCompleted >= lastPage) {
				await this.storage.put('lastProcessedPage', pageCompleted);
				console.log(`[DO ${doIdShort}] Updated lastProcessedPage to ${pageCompleted}`);
			} else { /* ... (警告日志) ... */ }

			// 检查是否需要继续以及是否已完成
			if (currentStatus === 'running') {
				// *** 新增：检查 photoCount 是否为 0 ***
				if (photoCount > 0) {
					// 仍然有数据，继续派发下一页
					const nextPage = pageCompleted + 1;
					// TODO: 将来可以根据 Unsplash 头信息或固定上限判断是否真的有下一页
					try {
						console.log(`[DO ${doIdShort}] Sending next task (page ${nextPage}) to queue...`);
						await this.env.SYNC_TASK_QUEUE.send({ page: nextPage });
						console.log(`[DO ${doIdShort}] Message for page ${nextPage} sent successfully.`);
						nextPageQueued = true;
						finalStatus = 'running'; // 保持运行状态
					} catch (queueError: any) { /* ... (处理队列错误, 设置状态为 error) ... */ finalStatus = 'error'; }
				} else {
					// *** photoCount 为 0，表示同步完成 ***
					console.log(`[DO ${doIdShort}] Received photo count 0 for page ${pageCompleted}. Sync process complete.`);
					await this.storage.put('syncStatus', 'idle'); // <-- 设置状态为空闲
					await this.storage.delete('lastError'); // 清除可能残留的错误信息
					finalStatus = 'idle'; // 最终状态为空闲
					nextPageQueued = false; // 没有派发下一页
				}
				// *** 结束新增检查 ***
			} else { // 状态不是 running (可能是 stopping, error, idle)
				console.log(`[DO ${doIdShort}] Status is '${currentStatus}', not queueing next page.`);
				finalStatus = currentStatus;
				nextPageQueued = false;
			}
		}); // end blockConcurrencyWhile

		// 返回给 sync-worker 的确认信息
		return new Response(JSON.stringify({ success: true, finalStatus: finalStatus, nextPageQueued: nextPageQueued }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 记录 sync-worker 遇到的错误 (保持不变) */
	async reportError(errorMessage: string): Promise<Response> { /* ... */ }

	/** 重置 DO 内部状态的方法 (保持不变) */
	async resetState(): Promise<Response> { /* ... */ }
}