// ~/imgN/api-worker/src/sync-coordinator-do.ts (v3 - 修正返回值, 移除 memoryState)

import { DurableObjectState, DurableObjectStorage, Queue } from '@cloudflare/workers-types';
// Request 和 Response 使用全局类型

// 定义 Env 类型，仅包含此 DO 运行时真正需要的绑定
interface Env {
	SYNC_TASK_QUEUE: Queue<any>; // DO 需要这个 Queue Producer 绑定来发送任务
}

// DO 内部状态的类型定义
interface SyncState {
	syncStatus: 'idle' | 'running' | 'stopping' | 'error';
	lastProcessedPage: number;
	totalPages?: number; // 可选，如果能从 API 获取总数
	lastRunStart?: string; // ISO timestamp
	lastError?: string; // 记录最后一次错误信息
}

export class SyncCoordinatorDO implements DurableObject {
	state: DurableObjectState;
	env: Env;
	storage: DurableObjectStorage;
	// private memoryState: Partial<SyncState> = {}; // <-- 已移除 memoryState

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.storage = this.state.storage;
	}

	/**
	 * Durable Object 的主入口点，处理所有发往此 DO 实例的 fetch 请求。
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] Request: ${request.method} ${path}`);

		try {
			// 路由到内部方法，确保每个 case 都明确返回 Promise<Response>
			switch (path) {
				case '/start':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					return await this.startSync();
				case '/stop':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					return await this.stopSync();
				case '/status':
					if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
					return await this.getStatus();
				case '/report':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					try {
						const data = await request.json<{ pageCompleted?: number, photoCount?: number, error?: string }>();
						if (data?.error) {
							return await this.reportError(data.error);
						} else if (typeof data?.pageCompleted === 'number' && typeof data?.photoCount === 'number') {
							return await this.handleSuccessfulPageReport(data.pageCompleted, data.photoCount);
						} else {
							// 确保返回 Response
							return new Response('Bad Request: Missing pageCompleted/photoCount or error in body', { status: 400 });
						}
					} catch (e) {
						console.error(`[DO ${doIdShort}] Error parsing report body:`, e);
						// 确保返回 Response
						return new Response('Bad Request: Invalid JSON body for /report', { status: 400 });
					}

				case '/reset':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					return await this.resetState();

				default:
					// 确保返回 Response
					return new Response('Not Found in DO', { status: 404 });
			}
		} catch (e: any) {
			console.error(`[DO ${doIdShort}] Unhandled error in fetch handler:`, e);
			// 确保返回 Response
			return new Response(`Internal Server Error in DO: ${e.message}`, { status: 500 });
		}
	}

	/** 开始同步任务 (包含恢复逻辑的版本) */
	async startSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let startSuccess = false;
		let message = 'Sync already running or failed to start.';
		let status = 409; // Conflict

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			if (currentStatus === 'running') {
				console.log(`[DO ${doIdShort}] Sync already running.`);
				// message 和 status 保持默认值
				return;
			}

			console.log(`[DO ${doIdShort}] Setting status to running and resuming/starting sync...`);
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;
			const nextPageToQueue = lastPage + 1;
			console.log(`[DO ${doIdShort}] Resuming/Starting from page ${nextPageToQueue} (last processed: ${lastPage})`);

			// 更新状态 (不重置 lastProcessedPage)
			const newState: Partial<SyncState> = { syncStatus: 'running', lastRunStart: new Date().toISOString() };
			await this.storage.put(newState);
			await this.storage.delete('lastError'); // 清除旧错误

			try { // 尝试发送到队列
				console.log(`[DO ${doIdShort}] Sending task (page ${nextPageToQueue}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: nextPageToQueue });
				console.log(`[DO ${doIdShort}] Message for page ${nextPageToQueue} sent successfully.`);
				startSuccess = true; message = `Sync ${nextPageToQueue === 1 ? 'started' : 'resumed'} successfully from page ${nextPageToQueue}.`; status = 200;
			} catch (queueError: any) { // 处理队列发送错误
				console.error(`[DO ${doIdShort}] Failed to send message:`, queueError);
				const errorMsg = `Failed to queue task for page ${nextPageToQueue}: ${queueError.message}`;
				await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
				message = errorMsg; status = 500; startSuccess = false;
			}
		}); // end blockConcurrencyWhile

		// blockConcurrencyWhile 执行完毕后，根据 flag 返回 Response
		return new Response(JSON.stringify({ success: startSuccess, message: message }), { status: status, headers: { 'Content-Type': 'application/json' } });
	}

	/** 停止同步任务 */
	async stopSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.put('syncStatus', 'stopping');
			console.log(`[DO ${doIdShort}] Status set to stopping.`);
		});
		// 确保返回 Response
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 获取当前同步状态 (带健壮性检查) */
	async getStatus(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] getStatus called`);
		const keys: (keyof SyncState)[] = ['syncStatus', 'lastProcessedPage', 'totalPages', 'lastRunStart', 'lastError'];
		let stateData: Partial<SyncState> = {};
		let responseStatus = 200; // 默认成功

		try {
			const data = await this.storage.get<SyncState>(keys);
			// 健壮性检查
			if (data instanceof Map) { keys.forEach(key => { stateData[key] = data.get(key); }); }
			else if (typeof data === 'object' && data !== null) { keys.forEach(key => { stateData[key] = (data as any)[key]; }); }
			else {
				console.error(`[DO ${doIdShort}] storage.get invalid format:`, typeof data);
				stateData.syncStatus = 'error'; stateData.lastError = 'Failed read state (format)';
				responseStatus = 500; // 内部读取错误
			}
		} catch (storageError: any) {
			console.error(`[DO ${doIdShort}] Error reading storage:`, storageError);
			stateData.syncStatus = 'error'; stateData.lastError = `Failed read state: ${storageError.message}`;
			responseStatus = 500; // 内部读取错误
		}

		const responseBody = {
			success: responseStatus === 200, // 根据状态码判断操作是否真正成功
			data: { status: stateData.syncStatus ?? 'idle', lastProcessedPage: stateData.lastProcessedPage ?? 0, totalPages: stateData.totalPages, lastRunStart: stateData.lastRunStart, lastError: stateData.lastError }
		};

		// 序列化并返回 Response 对象
		try {
			const payload = JSON.stringify(responseBody);
			return new Response(payload, { status: responseStatus, headers: { 'Content-Type': 'application/json' } });
		} catch (stringifyError) {
			console.error(`[DO ${doIdShort}] Failed stringify:`, stringifyError);
			// 返回一个标准的错误 Response
			return new Response(JSON.stringify({ success: false, error: "Internal error stringifying state." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	}

	/** 处理成功的页面完成报告 (包含完成检测) */
	async handleSuccessfulPageReport(pageCompleted: number, photoCount: number): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let nextPageQueued = false;
		let finalStatus = 'unknown';
		let errorMessage: string | null = null; // 用于记录可能的错误信息

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;
			console.log(`[DO ${doIdShort}] Report page ${pageCompleted} (Count:${photoCount}). Status:${currentStatus}, LastPg:${lastPage}`);

			if (pageCompleted >= lastPage) { await this.storage.put('lastProcessedPage', pageCompleted); }
			else { console.warn(`[DO ${doIdShort}] Late report page ${pageCompleted}.`); }

			const shouldContinue = currentStatus === 'running';
			if (shouldContinue) {
				if (photoCount > 0) { // 继续同步
					const nextPage = pageCompleted + 1;
					try {
						await this.env.SYNC_TASK_QUEUE.send({ page: nextPage });
						console.log(`[DO ${doIdShort}] Sent task page ${nextPage}.`);
						nextPageQueued = true; finalStatus = 'running';
					} catch (queueError: any) {
						errorMessage = `Failed queue page ${nextPage}: ${queueError.message}`;
						console.error(`[DO ${doIdShort}] ${errorMessage}`, queueError);
						await this.storage.put({ syncStatus: 'error', lastError: errorMessage });
						finalStatus = 'error';
					}
				} else { // 同步完成 (photoCount is 0)
					console.log(`[DO ${doIdShort}] Sync complete (page ${pageCompleted} had 0 photos).`);
					await this.storage.put('syncStatus', 'idle');
					await this.storage.delete('lastError');
					finalStatus = 'idle'; nextPageQueued = false;
				}
			} else { // 状态不是 running
				console.log(`[DO ${doIdShort}] Status is '${currentStatus}', not queueing.`);
				finalStatus = currentStatus; nextPageQueued = false;
			}
		});

		// 返回给 sync-worker 的确认信息
		const responseBody = errorMessage
			? { success: false, message: errorMessage, finalStatus: finalStatus }
			: { success: true, finalStatus: finalStatus, nextPageQueued: nextPageQueued };
		return new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 记录 sync-worker 遇到的错误 */
	async reportError(errorMessage: string): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => {
			console.error(`[DO ${doIdShort}] Error reported: ${errorMessage}`);
			await this.storage.put({ syncStatus: 'error', lastError: errorMessage });
		});
		return new Response(JSON.stringify({ success: true, message: "Error reported and status set to 'error'." }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 重置 DO 内部状态的方法 */
	async resetState(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.warn(`[DO ${doIdShort}] Resetting state...`);
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.deleteAll();
			const initialState: Partial<SyncState> = { syncStatus: 'idle', lastProcessedPage: 0 };
			await this.storage.put(initialState);
		});
		console.log(`[DO ${doIdShort}] State reset complete.`);
		return new Response(JSON.stringify({ success: true, message: 'Durable Object state reset.' }), { headers: { 'Content-Type': 'application/json' } });
	}
}