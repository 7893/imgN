// ~/imgN/api-worker/src/sync-coordinator-do.ts (v3 - 修正返回值, 移除 memoryState)

import { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { APIError, DORequestInit, QueueMessagePayload } from './api-types';
// Request 和 Response 使用全局类型

// 定义 Env 类型，仅包含此 DO 运行时真正需要的绑定
interface Env {
	SYNC_TASK_QUEUE: Queue<QueueMessagePayload>; // DO 需要这个 Queue Producer 绑定来发送任务
}

// DO 内部状态的类型定义
interface SyncState {
	syncStatus: 'idle' | 'running' | 'stopping' | 'error';
	lastProcessedPage: number;
	totalPages?: number; // 可选，如果能从 API 获取总数
	lastRunStart?: string; // ISO timestamp
	lastError?: string; // 记录最后一次错误信息
}

function isSyncState(obj: unknown): obj is SyncState {
	return obj !== null 
		&& typeof obj === 'object'
		&& 'syncStatus' in obj
		&& typeof (obj as SyncState).lastProcessedPage === 'number';
}

export class SyncCoordinatorDO implements DurableObject {
	private storage: DurableObjectStorage;

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env
	) {
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
					if (request.method !== 'POST') {
						throw new APIError('Method Not Allowed', 405);
					}
					return await this.startSync();
				case '/stop':
					if (request.method !== 'POST') {
						throw new APIError('Method Not Allowed', 405);
					}
					return await this.stopSync();
				case '/status':
					if (request.method !== 'GET') {
						throw new APIError('Method Not Allowed', 405);
					}
					return await this.getStatus();
				case '/report':
					if (request.method !== 'POST') {
						throw new APIError('Method Not Allowed', 405);
					}
					const data = await request.json() as { pageCompleted?: number; photoCount?: number; error?: string; };
					if (data?.error) {
						return await this.reportError(data.error);
					}
					if (typeof data?.pageCompleted === 'number' && typeof data?.photoCount === 'number') {
						return await this.handleSuccessfulPageReport(data.pageCompleted, data.photoCount);
					}
					throw new APIError('Bad Request: Missing pageCompleted/photoCount or error in body', 400);
				case '/reset':
					if (request.method !== 'POST') {
						throw new APIError('Method Not Allowed', 405);
					}
					return await this.resetState();
				default:
					throw new APIError('Not Found in DO', 404);
			}
		} catch (error: unknown) {
			console.error(`[DO ${doIdShort}] Error:`, error);
			if (error instanceof APIError) {
				return new Response(JSON.stringify({ success: false, error: error.message }), {
					status: error.status,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ success: false, error: 'Internal Server Error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
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
			if (currentStatus === 'running') {
				console.log(`[DO ${doIdShort}] Sync already running.`);
				return;
			}

			console.log(`[DO ${doIdShort}] Setting status to running and resuming/starting sync...`);
			const lastPage = await this.storage.get<number>('lastProcessedPage') ?? 0;
			const nextPageToQueue = lastPage + 1;

			const newState: Partial<SyncState> = {
				syncStatus: 'running',
				lastRunStart: new Date().toISOString()
			};
			await this.storage.put(newState);
			await this.storage.delete('lastError');

			try {
				const queueMessage: QueueMessagePayload = {
					page: nextPageToQueue,
					timestamp: Date.now()
				};
				await this.env.SYNC_TASK_QUEUE.send(queueMessage);
				console.log(`[DO ${doIdShort}] Message for page ${nextPageToQueue} sent successfully.`);
				startSuccess = true;
				message = `Sync ${nextPageToQueue === 1 ? 'started' : 'resumed'} successfully from page ${nextPageToQueue}.`;
				status = 200;
			} catch (queueError: unknown) {
				const errorMsg = queueError instanceof Error ? queueError.message : 'Unknown queue error';
				console.error(`[DO ${doIdShort}] Failed to send message:`, queueError);
				await this.storage.put({
					syncStatus: 'error',
					lastError: `Failed to queue task for page ${nextPageToQueue}: ${errorMsg}`
				} as Partial<SyncState>);
				message = errorMsg;
				status = 500;
				startSuccess = false;
			}
		});

		return new Response(JSON.stringify({ success: startSuccess, message }), {
			status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	/** 停止同步任务 */
	async stopSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.put({ syncStatus: 'stopping' } as Partial<SyncState>);
			console.log(`[DO ${doIdShort}] Status set to stopping.`);
		});
		// 确保返回 Response
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 获取当前同步状态 (带健壮性检查) */
	async getStatus(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] getStatus called`);
		
		try {
			const state = await this.storage.get<SyncState>(['syncStatus', 'lastProcessedPage', 'totalPages', 'lastRunStart', 'lastError']);
			let syncState: Partial<SyncState> = {};
			
			if (state instanceof Map) {
				const syncStatus = state.get('syncStatus') as SyncState['syncStatus'] | undefined;
				const lastProcessedPage = state.get('lastProcessedPage') as number | undefined;
				const totalPages = state.get('totalPages') as number | undefined;
				const lastRunStart = state.get('lastRunStart') as string | undefined;
				const lastError = state.get('lastError') as string | undefined;

				syncState = {
					syncStatus,
					lastProcessedPage,
					totalPages,
					lastRunStart,
					lastError
				};
			} else if (state && typeof state === 'object') {
				syncState = state;
			}

			const responseData = {
				status: (syncState.syncStatus ?? 'idle') as SyncState['syncStatus'],
				lastProcessedPage: syncState.lastProcessedPage ?? 0,
				totalPages: syncState.totalPages,
				lastRunStart: syncState.lastRunStart,
				lastError: syncState.lastError
			};

			return new Response(JSON.stringify({
				success: true,
				data: responseData
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error: unknown) {
			console.error(`[DO ${doIdShort}] Error reading storage:`, error);
			throw new APIError('Failed to read sync state', 500);
		}
	}

	/** 处理成功的页面完成报告 (包含完成检测) */
	async handleSuccessfulPageReport(pageCompleted: number, photoCount: number): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let nextPageQueued = false;
		let finalStatus: SyncState['syncStatus'] = 'idle';

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
						const errorMsg = queueError instanceof Error ? queueError.message : 'Unknown error';
						console.error(`[DO ${doIdShort}] ${errorMsg}`, queueError);
						await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
						finalStatus = 'error';
						throw new APIError(`Failed to queue next page: ${errorMsg}`, 500);
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
		const responseBody = {
			success: true,
			finalStatus,
			nextPageQueued
		};
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