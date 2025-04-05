// ~/imgN/api-worker/src/sync-coordinator-do.ts (更新 startSync 实现恢复功能)
import { DurableObjectState, DurableObjectNamespace, DurableObjectStorage } from '@cloudflare/workers-types';

// Env 接口 (需要 Queue 绑定)
interface Env {
	SYNC_TASK_QUEUE: Queue;
}

// DO 状态类型 (保持不变)
interface SyncState { /* ... */ }

export class SyncCoordinatorDO implements DurableObject {
	state: DurableObjectState;
	env: Env;
	storage: DurableObjectStorage;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.storage = this.state.storage;
	}

	// fetch 方法 (路由逻辑保持不变)
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] Request: ${request.method} ${path}`);
		try {
			switch (path) {
				case '/start': /* ... */ return await this.startSync();
				case '/stop':  /* ... */ return await this.stopSync();
				case '/status':/* ... */ return await this.getStatus();
				case '/report': /* ... (处理报告逻辑不变) ... */
					const data = await request.json<{ pageCompleted?: number, photoCount?: number, error?: string }>();
					if (data?.error) { return await this.reportError(data.error); }
					else if (typeof data?.pageCompleted === 'number' && typeof data?.photoCount === 'number') { return await this.handleSuccessfulPageReport(data.pageCompleted, data.photoCount); }
					else { return new Response('Bad Request', { status: 400 }); }
				case '/reset': /* ... */ return await this.resetState();
				default: return new Response('Not Found in DO', { status: 404 });
			}
		} catch (e: any) { /* ... */ return new Response(`Internal Server Error in DO`, { status: 500 }); }
	}

	// =====================================================
	//  修改 startSync 方法以支持恢复
	// =====================================================
	async startSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let startSuccess = false;
		let message = 'Sync already running or failed to start.';
		let status = 409; // Conflict

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			if (currentStatus === 'running') {
				console.log(`[DO ${doIdShort}] Sync already running.`);
				message = 'Sync already running.';
				status = 409;
				startSuccess = false;
				return;
			}

			console.log(`[DO ${doIdShort}] Setting status to running and resuming/starting sync...`);

			// --- *** 修改点 开始 *** ---
			// 1. 读取上次成功处理的页码
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;
			// 2. 计算下一页 (恢复点)
			const nextPageToQueue = lastPage + 1;
			console.log(`[DO ${doIdShort}] Resuming/Starting from page ${nextPageToQueue} (last processed: ${lastPage})`);
			// --- *** 修改点 结束 *** ---

			// 更新状态：设置 running, 更新开始时间, 清除错误, **不重置 lastProcessedPage**
			const newState: Partial<SyncState> = {
				syncStatus: 'running',
				lastRunStart: new Date().toISOString(),
				// lastProcessedPage: 0, // <-- 不再重置这一行!
				lastError: undefined
			};
			await this.storage.put(newState);
			await this.storage.delete('lastError'); // 确保清除旧错误

			try {
				console.log(`[DO ${doIdShort}] Sending task (page ${nextPageToQueue}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: nextPageToQueue }); // 发送下一页任务
				console.log(`[DO ${doIdShort}] Message for page ${nextPageToQueue} sent successfully.`);
				startSuccess = true;
				message = `Sync ${nextPageToQueue === 1 ? 'started' : 'resumed'} successfully from page ${nextPageToQueue}.`; // 更新提示信息
				status = 200; // OK
			} catch (queueError: any) {
				console.error(`[DO ${doIdShort}] Failed to send message for page ${nextPageToQueue} to queue:`, queueError);
				const errorMsg = `Failed to queue task for page ${nextPageToQueue}: ${queueError.message}`;
				await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
				message = errorMsg;
				status = 500;
				startSuccess = false;
			}
		}); // end blockConcurrencyWhile

		return new Response(JSON.stringify({ success: startSuccess, message: message }), { status: status, headers: { 'Content-Type': 'application/json' } });
	}

	// stopSync 方法 (保持不变)
	async stopSync(): Promise<Response> { /* ... */ }

	// getStatus 方法 (保持不变)
	async getStatus(): Promise<Response> { /* ... */ }

	// handleSuccessfulPageReport 方法 (处理回调，逻辑保持不变)
	async handleSuccessfulPageReport(pageCompleted: number, photoCount: number): Promise<Response> { /* ... */ }

	// reportError 方法 (保持不变)
	async reportError(errorMessage: string): Promise<Response> { /* ... */ }

	// resetState 方法 (保持不变，它仍然会将 lastProcessedPage 重置为 0)
	async resetState(): Promise<Response> { /* ... */ }
}