// ~/imgN/api-worker/src/sync-coordinator-do.ts
import { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';

// 定义 Env 类型，确保包含 DO 需要的绑定 (主要是 Queue)
// 最好与 api-worker/src/types.ts 中的 Env 保持一致或部分一致
interface Env {
	// DB?: D1Database; // DO 通常不直接操作 DB，交给 sync-worker
	// KV_CACHE?: KVNamespace;
	// SYNC_COORDINATOR_DO: DurableObjectNamespace; // 不需要访问自己
	SYNC_TASK_QUEUE: Queue; // <--- DO 需要这个来发送任务
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
	memoryState?: Partial<SyncState>; // 可选：内存缓存状态减少 storage 读取

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.storage = this.state.storage; 
        this.memoryState = {}; // 初始化内存状态

        // 可选：首次启动时从存储加载状态到内存
        // this.state.blockConcurrencyWhile(() => this.loadStateFromStorage());
	}

    // (可选) 将状态加载到内存中以减少读取次数
    // async loadStateFromStorage() {
    //     const storedState = await this.storage.get<SyncState>([
    //          'syncStatus', 'lastProcessedPage', 'totalPages', 'lastRunStart', 'lastError'
    //     ]);
    //     this.memoryState = {
    //         syncStatus: storedState.get('syncStatus') ?? 'idle',
    //         lastProcessedPage: storedState.get('lastProcessedPage') ?? 0,
    //         totalPages: storedState.get('totalPages'),
    //         lastRunStart: storedState.get('lastRunStart'),
    //         lastError: storedState.get('lastError'),
    //     };
    // }

	// Durable Object 的主入口点
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const doIdShort = this.state.id.toString().substring(0, 6); 

		console.log(`[DO ${doIdShort}] Request: ${request.method} ${path}`);

		try {
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
				case '/report': // 用于 sync-worker 回调
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					try {
                        // 从请求体中解析 pageCompleted 或 error
						const data = await request.json<{ pageCompleted?: number, error?: string }>();
						if (typeof data?.pageCompleted === 'number') {
							 return await this.reportPageCompleted(data.pageCompleted);
						} else if (data?.error) {
							 return await this.reportError(data.error);
						} else {
							 return new Response('Bad Request: Missing pageCompleted or error in body', { status: 400 });
						}
					} catch (e) {
						console.error(`[DO ${doIdShort}] Error parsing report body:`, e);
						return new Response('Bad Request: Invalid JSON body for /report', { status: 400 });
					}
				
				case '/reset': // 新增的 Reset 端点
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					return await this.resetState();

				default:
					return new Response('Not Found in DO', { status: 404 });
			}
		} catch (e: any) {
			console.error(`[DO ${doIdShort}] Error in fetch handler:`, e);
			return new Response(`Internal Server Error in DO: ${e.message}`, { status: 500 });
		}
	}

	/** 开始同步任务 */
	async startSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		let startSuccess = false;
		let message = 'Sync already running or failed to start.';
		let status = 409; // Conflict

		await this.state.blockConcurrencyWhile(async () => {
            // 从存储（或内存缓存）读取当前状态
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			// const currentStatus = this.memoryState?.syncStatus ?? await this.storage.get('syncStatus') ?? 'idle';
			
            if (currentStatus === 'running') {
				console.log(`[DO ${doIdShort}] Sync already running.`);
				return; 
			}

			console.log(`[DO ${doIdShort}] Setting status to running and starting sync...`);
			// 更新状态并存储
            const newState: SyncState = {
                syncStatus: 'running',
                lastRunStart: new Date().toISOString(),
                lastProcessedPage: 0, // 重置页码
                lastError: undefined, // 清除错误
                totalPages: this.memoryState?.totalPages // 保留可能已知的总页数
            };
            await this.storage.put(newState);
            // this.memoryState = {...this.memoryState, ...newState}; // 更新内存状态

			const startPage = 1; 

			try {
				console.log(`[DO ${doIdShort}] Sending initial task (page ${startPage}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: startPage }); // 发送 JSON 对象
				console.log(`[DO ${doIdShort}] Message for page ${startPage} sent successfully.`);
				startSuccess = true;
				message = 'Sync started successfully.';
				status = 200; // OK
			} catch (queueError: any) {
				console.error(`[DO ${doIdShort}] Failed to send initial message to queue:`, queueError);
                const errorMsg = `Failed to queue initial task: ${queueError.message}`;
                await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
                // this.memoryState.syncStatus = 'error'; this.memoryState.lastError = errorMsg;
				message = errorMsg;
				status = 500; // Internal Server Error
			}
		});
		
		return new Response(JSON.stringify({ success: startSuccess, message: message }), { status: status, headers: { 'Content-Type': 'application/json' } });
	}

	/** 停止同步任务 (设置标志位) */
	async stopSync(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.put('syncStatus', 'stopping');
            // if (this.memoryState) this.memoryState.syncStatus = 'stopping';
			console.log(`[DO ${doIdShort}] Status set to stopping.`);
		});
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 获取当前同步状态 */
	async getStatus(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] getStatus called`);
		// 直接从存储读取最新状态
		const data = await this.storage.get<SyncState>([ 'syncStatus', 'lastProcessedPage', 'totalPages', 'lastRunStart', 'lastError' ]);
		const responseBody = {
			success: true,
			data: {
				status: data.get('syncStatus') ?? 'idle',
				lastProcessedPage: data.get('lastProcessedPage') ?? 0,
				totalPages: data.get('totalPages'), 
				lastRunStart: data.get('lastRunStart'),
                lastError: data.get('lastError'),
			}
		};
		return new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } });
	}

    /** sync-worker 完成一页后调用此方法 */
    async reportPageCompleted(pageCompleted: number): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
        let nextPageQueued = false;
        await this.state.blockConcurrencyWhile(async () => {
            // 获取最新状态和页码
            const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
            const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;

            console.log(`[DO ${doIdShort}] Received report for page ${pageCompleted}. Current status: ${currentStatus}, Last processed: ${lastPage}`);

            // 更新最后处理页码 (仅当报告的页码大于等于记录时才更新，允许重试报告)
            if (pageCompleted >= lastPage) {
                 await this.storage.put('lastProcessedPage', pageCompleted);
                 // if (this.memoryState) this.memoryState.lastProcessedPage = pageCompleted;
                 console.log(`[DO ${doIdShort}] Updated lastProcessedPage to ${pageCompleted}`);
            } else {
                console.warn(`[DO ${doIdShort}] Received report for page ${pageCompleted}, but last processed page is ${lastPage}. Potential retry/late message.`);
            }

            // 如果状态是 'running'，则继续发送下一页的任务
            // TODO: 添加判断是否达到最后一页的逻辑
            const shouldContinue = currentStatus === 'running'; // && !isLastPage; 
            
            if (shouldContinue) {
                const nextPage = pageCompleted + 1;
                 try {
                    console.log(`[DO ${doIdShort}] Sending next task (page ${nextPage}) to queue...`);
                    await this.env.SYNC_TASK_QUEUE.send({ page: nextPage }); // 发送 JSON 对象
                    console.log(`[DO ${doIdShort}] Message for page ${nextPage} sent successfully.`);
                    nextPageQueued = true;
                 } catch (queueError: any) {
                     console.error(`[DO ${doIdShort}] Failed to send message for page ${nextPage} to queue:`, queueError);
                     const errorMsg = `Failed to queue task for page ${nextPage}: ${queueError.message}`;
                     await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
                     // if (this.memoryState) { this.memoryState.syncStatus = 'error'; this.memoryState.lastError = errorMsg; }
                 }
            } else {
                 console.log(`[DO ${doIdShort}] Status is '${currentStatus}', not queueing next page.`);
                 // 如果同步被停止或出错，或已完成，则不再发送新任务
                 if (currentStatus !== 'stopping' && currentStatus !== 'error') {
                      // 如果不是因为停止或错误而不继续，可以认为同步完成了（需要更精确的完成判断）
                      // await this.storage.put('syncStatus', 'idle');
                      // console.log(`[DO ${doIdShort}] Sync seems complete or stopped. Setting status to idle.`);
                 }
            }
        });
         return new Response(JSON.stringify({ success: true, nextPageQueued: nextPageQueued }), { headers: { 'Content-Type': 'application/json' } });
    }

    /** 记录 sync-worker 遇到的错误 */
     async reportError(errorMessage: string): Promise<Response> {
		 const doIdShort = this.state.id.toString().substring(0, 6);
         await this.state.blockConcurrencyWhile(async () => {
             console.error(`[DO ${doIdShort}] Received error report from sync-worker: ${errorMessage}`);
             await this.storage.put({ syncStatus: 'error', lastError: errorMessage }); 
             // if (this.memoryState) { this.memoryState.syncStatus = 'error'; this.memoryState.lastError = errorMessage; }
         });
          return new Response(JSON.stringify({ success: true, message: "Error reported and sync status set to 'error'." }), { headers: { 'Content-Type': 'application/json' } });
     }

     /** 重置 DO 内部状态的方法 */
     async resetState(): Promise<Response> {
        const doIdShort = this.state.id.toString().substring(0, 6);
        console.warn(`[DO ${doIdShort}] Received request to reset state! Deleting all stored data...`);
        
        await this.state.blockConcurrencyWhile(async () => {
            await this.storage.deleteAll(); // 删除所有内部存储
            // 重置为初始状态
            const initialState: Partial<SyncState> = {
                 syncStatus: 'idle',
                 lastProcessedPage: 0
            };
            await this.storage.put(initialState); 
            // if (this.memoryState) { // 重置内存状态
            //     this.memoryState.syncStatus = 'idle';
            //     this.memoryState.lastProcessedPage = 0;
            //     this.memoryState.totalPages = undefined;
            //     this.memoryState.lastRunStart = undefined;
            //     this.memoryState.lastError = undefined;
            // }
             // 可选：显式删除其他 key
             // await this.storage.delete(['totalPages', 'lastRunStart', 'lastError']); 
        });

        console.log(`[DO ${doIdShort}] State reset complete.`);
        return new Response(JSON.stringify({ success: true, message: 'Durable Object state has been reset.'}), { headers: {'Content-Type':'application/json'} });
    }
}
