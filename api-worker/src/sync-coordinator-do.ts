// ~/imgN/api-worker/src/sync-coordinator-do.ts (包含完整 getStatus 实现的版本)
import { DurableObjectState, DurableObjectNamespace, DurableObjectStorage } from '@cloudflare/workers-types';

// 定义 Env 类型，确保包含 DO 需要的绑定 (主要是 Queue)
interface Env {
	// DB?: D1Database; 
	// KV_CACHE?: KVNamespace; 
	SYNC_TASK_QUEUE: Queue; // DO 需要这个 Queue Producer 绑定来发送任务
}

// (可选) 定义 DO 内部状态的类型
interface SyncState {
	syncStatus: 'idle' | 'running' | 'stopping' | 'error';
	lastProcessedPage: number;
	totalPages?: number;
	lastRunStart?: string; // ISO timestamp
	lastError?: string;
}

export class SyncCoordinatorDO implements DurableObject {
	state: DurableObjectState;
	env: Env;
	storage: DurableObjectStorage;

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
			switch (path) {
				case '/start':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					// 调用 startSync 方法，该方法已包含原子操作和错误处理逻辑
					return await this.startSync();
				case '/stop':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					// 调用 stopSync 方法，该方法已包含原子操作
					return await this.stopSync();
				case '/status':
					if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
					// 调用 getStatus 方法
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
							return new Response('Bad Request: Missing pageCompleted/photoCount or error in body', { status: 400 });
						}
					} catch (e) { console.error(`[DO ${doIdShort}] Error parsing report body:`, e); return new Response('Bad Request: Invalid JSON body for /report', { status: 400 }); }

				case '/reset':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					// 调用 resetState 方法，该方法已包含原子操作
					return await this.resetState();

				default:
					return new Response('Not Found in DO', { status: 404 });
			}
		} catch (e: any) {
			console.error(`[DO ${doIdShort}] Unhandled error in fetch handler:`, e);
			return new Response(`Internal Server Error in DO: ${e.message}`, { status: 500 });
		}
	}

	/** 开始同步任务 (包含恢复逻辑的版本) */
	async startSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let startSuccess = false;
		let message = 'Sync already running or failed to start.';
		let status = 409;

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			if (currentStatus === 'running') { console.log(`[DO ${doIdShort}] Sync already running.`); message = 'Sync already running.'; status = 409; startSuccess = false; return; }

			console.log(`[DO ${doIdShort}] Setting status to running and resuming/starting sync...`);
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;
			const nextPageToQueue = lastPage + 1;
			console.log(`[DO ${doIdShort}] Resuming/Starting from page ${nextPageToQueue} (last processed: ${lastPage})`);

			// 更新状态 (不重置 lastProcessedPage)
			const newState: Partial<SyncState> = { syncStatus: 'running', lastRunStart: new Date().toISOString(), lastError: undefined };
			await this.storage.put(newState);
			await this.storage.delete('lastError');

			try { // 尝试发送到队列
				console.log(`[DO ${doIdShort}] Sending task (page ${nextPageToQueue}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: nextPageToQueue });
				console.log(`[DO ${doIdShort}] Message for page ${nextPageToQueue} sent successfully.`);
				startSuccess = true; message = `Sync ${nextPageToQueue === 1 ? 'started' : 'resumed'} successfully from page ${nextPageToQueue}.`; status = 200;
			} catch (queueError: any) { // 处理队列发送错误
				console.error(`[DO ${doIdShort}] Failed to send message for page ${nextPageToQueue} to queue:`, queueError);
				const errorMsg = `Failed to queue task for page ${nextPageToQueue}: ${queueError.message}`;
				await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
				message = errorMsg; status = 500; startSuccess = false;
			}
		}); // end blockConcurrencyWhile

		return new Response(JSON.stringify({ success: startSuccess, message: message }), { status: status, headers: { 'Content-Type': 'application/json' } });
	}

	/** 停止同步任务 (设置标志位) */
	async stopSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.put('syncStatus', 'stopping');
			console.log(`[DO ${doIdShort}] Status set to stopping.`);
		});
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	// =====================================================
	//  这个 getStatus 方法是可能导致问题的版本
	// =====================================================
	/** 获取当前同步状态 */
	async getStatus(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] getStatus called`);
		// 一次性读取所有需要的状态
		// 潜在问题点：如果 storage.get 内部或返回的 Map 处理有问题，可能导致错误
		const data = await this.storage.get<SyncState>([
			'syncStatus',
			'lastProcessedPage',
			'totalPages',
			'lastRunStart',
			'lastError'
		]);

		// 确认 data 是否是预期的 Map 结构 (虽然 TS 类型暗示是，但运行时可能不同)
		if (!(data instanceof Map)) {
			console.error(`[DO ${doIdShort}] storage.get did not return a Map! Got:`, typeof data, data);
			// 如果返回的不是 Map，我们无法安全地调用 .get()，直接返回错误
			throw new Error("Internal error reading state storage.");
			// 或者返回一个固定的错误响应:
			// return new Response(JSON.stringify({success: false, error: "Failed to read internal state"}), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}

		const responseBody = {
			success: true,
			data: {
				// 使用 Map 的 get 方法安全地获取值，并提供默认值
				status: data.get('syncStatus') ?? 'idle',
				lastProcessedPage: data.get('lastProcessedPage') ?? 0,
				totalPages: data.get('totalPages'), // undefined if not set
				lastRunStart: data.get('lastRunStart'), // undefined if not set
				lastError: data.get('lastError'), // undefined if not set
			}
		};
		// 确认 responseBody 可以被序列化
		let responsePayloadString: string;
		try {
			responsePayloadString = JSON.stringify(responseBody);
		} catch (stringifyError) {
			console.error(`[DO ${doIdShort}] Failed to stringify response body:`, stringifyError, responseBody);
			throw new Error("Internal error stringifying state.");
		}

		// 返回 Response 对象
		return new Response(responsePayloadString, { headers: { 'Content-Type': 'application/json' } });
	}
	// =====================================================
	//  结束 getStatus 方法
	// =====================================================


	/** 处理成功的页面完成报告 (包含完成检测逻辑) */
	async handleSuccessfulPageReport(pageCompleted: number, photoCount: number): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let nextPageQueued = false;
		let finalStatus = 'unknown';

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;
			console.log(`[DO ${doIdShort}] Received success report for page ${pageCompleted} (Count: ${photoCount}). Status: ${currentStatus}, LastPg: ${lastPage}`);
			if (pageCompleted >= lastPage) { await this.storage.put('lastProcessedPage', pageCompleted); console.log(`[DO ${doIdShort}] Updated lastProcessedPage to ${pageCompleted}`); }
			else { console.warn(`[DO ${doIdShort}] Potential retry/late message for page ${pageCompleted}.`); }

			const shouldContinue = currentStatus === 'running';
			if (shouldContinue) {
				if (photoCount > 0) { // 继续同步
					const nextPage = pageCompleted + 1;
					try { await this.env.SYNC_TASK_QUEUE.send({ page: nextPage }); console.log(`[DO ${doIdShort}] Sent task page ${nextPage}.`); nextPageQueued = true; finalStatus = 'running'; }
					catch (queueError: any) { console.error(`[DO ${doIdShort}] Fail queue page ${nextPage}:`, queueError); const errorMsg = `Fail queue page ${nextPage}: ${queueError.message}`; await this.storage.put({ syncStatus: 'error', lastError: errorMsg }); finalStatus = 'error'; }
				} else { // 同步完成
					console.log(`[DO ${doIdShort}] Sync complete (page ${pageCompleted} had 0 photos).`);
					await this.storage.put('syncStatus', 'idle'); await this.storage.delete('lastError'); finalStatus = 'idle'; nextPageQueued = false;
				}
			} else { console.log(`[DO ${doIdShort}] Status is '${currentStatus}', not queueing.`); finalStatus = currentStatus; nextPageQueued = false; }
		});
		return new Response(JSON.stringify({ success: true, finalStatus: finalStatus, nextPageQueued: nextPageQueued }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 记录 sync-worker 遇到的错误 */
	async reportError(errorMessage: string): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => { console.error(`[DO ${doIdShort}] Error reported: ${errorMessage}`); await this.storage.put({ syncStatus: 'error', lastError: errorMessage }); });
		return new Response(JSON.stringify({ success: true, message: "Error reported." }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 重置 DO 内部状态的方法 */
	async resetState(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.warn(`[DO ${doIdShort}] Resetting state...`);
		await this.state.blockConcurrencyWhile(async () => { await this.storage.deleteAll(); const initialState: Partial<SyncState> = { syncStatus: 'idle', lastProcessedPage: 0 }; await this.storage.put(initialState); });
		console.log(`[DO ${doIdShort}] State reset complete.`);
		return new Response(JSON.stringify({ success: true, message: 'Durable Object state reset.' }), { headers: { 'Content-Type': 'application/json' } });
	}
}