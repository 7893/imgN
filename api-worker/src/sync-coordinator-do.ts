// ~/imgN/api-worker/src/sync-coordinator-do.ts
import { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';

// 假设 api-worker 的 Env 定义在一个共享的 types.ts 或直接在这里定义
// 需要包含 Queue Producer 的绑定
interface Env {
	// DB?: D1Database; // 如果 DO 需要直接访问 D1
	// KV_CACHE?: KVNamespace; // 如果 DO 需要访问 KV
	// SYNC_COORDINATOR_DO: DurableObjectNamespace; // DO 通常不需要访问自己的 Namespace
	SYNC_TASK_QUEUE: Queue; // Queue Producer 绑定，用于发送任务
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
	storage: DurableObjectStorage; // storage API 的快捷方式

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.storage = this.state.storage; 
	}

	// Durable Object 的主入口点
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const doIdShort = this.state.id.toString().substring(0, 6); // 用于日志，方便区分实例（虽然我们用单例）

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
						const data = await request.json<{ pageCompleted?: number, error?: string }>();
						if (typeof data?.pageCompleted === 'number') {
							 return await this.reportPageCompleted(data.pageCompleted);
						} else if (data?.error) {
							 return await this.reportError(data.error);
						} else {
							 return new Response('Bad Request: Missing pageCompleted or error in body', { status: 400 });
						}
					} catch (e) {
						return new Response('Bad Request: Invalid JSON body for /report', { status: 400 });
					}
				
				// --- 新增的 Reset 端点 ---
				case '/reset':
					if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
					return await this.resetState();
				// --- Reset 端点结束 ---

				default:
					return new Response('Not Found', { status: 404 });
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
		let status = 409; // Conflict by default

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			if (currentStatus === 'running') {
				console.log(`[DO ${doIdShort}] Sync already running.`);
				return; 
			}

			console.log(`[DO ${doIdShort}] Setting status to running and starting sync...`);
			const newState: Partial<SyncState> = {
                syncStatus: 'running',
                lastRunStart: new Date().toISOString(),
                lastProcessedPage: 0, // 重置为 0，表示准备处理第 1 页
                lastError: undefined // 清除错误状态
            };
            // 使用 multiPut 一次写入多个状态
            await this.storage.put(newState);
            // 也可以单独删除错误: await this.storage.delete('lastError');
            
			const startPage = 1; // 总是从第一页开始新的同步周期

			try {
				console.log(`[DO ${doIdShort}] Sending initial task (page ${startPage}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: startPage }); // 发送包含页码的消息
				console.log(`[DO ${doIdShort}] Message for page ${startPage} sent successfully.`);
				startSuccess = true;
				message = 'Sync started successfully.';
				status = 200; // OK
			} catch (queueError: any) {
				console.error(`[DO ${doIdShort}] Failed to send initial message to queue:`, queueError);
                const errorMsg = `Failed to queue initial task: ${queueError.message}`;
                await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
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
			console.log(`[DO ${doIdShort}] Status set to stopping.`);
		});
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 获取当前同步状态 */
	async getStatus(): Promise<Response> {
		const doIdShort = this.state.id.toString().substring(0, 6);
		console.log(`[DO ${doIdShort}] getStatus called`);
		// 一次性读取所有需要的状态
		const data = await this.storage.get<SyncState>([ 'syncStatus', 'lastProcessedPage', 'totalPages', 'lastRunStart', 'lastError' ]);
		const responseBody = {
			success: true,
			data: {
				status: data.get('syncStatus') ?? 'idle',
				lastProcessedPage: data.get('lastProcessedPage') ?? 0,
				totalPages: data.get('totalPages'), // 可能为 undefined
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
            const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
            const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;

            console.log(`[DO ${doIdShort}] Received report for page ${pageCompleted}. Current status: ${currentStatus}, Last processed: ${lastPage}`);

            // 更新最后处理页码 (简单处理，如果需要更精确可以比较)
            if (pageCompleted > lastPage) {
                 await this.storage.put('lastProcessedPage', pageCompleted);
                 console.log(`[DO ${doIdShort}] Updated lastProcessedPage to ${pageCompleted}`);
            } else {
                console.warn(`[DO ${doIdShort}] Received report for page ${pageCompleted}, but last processed page is already ${lastPage}. Ignoring page update, but may still queue next.`);
            }

            // 如果状态是 'running'，则继续发送下一页的任务
            // TODO: 需要增加判断是否已达到最后一页的逻辑 (如果知道 totalPages 或 API 返回空)
            if (currentStatus === 'running') {
                const nextPage = pageCompleted + 1;
                 try {
                    console.log(`[DO ${doIdShort}] Sending next task (page ${nextPage}) to queue...`);
                    await this.env.SYNC_TASK_QUEUE.send({ page: nextPage });
                    console.log(`[DO ${doIdShort}] Message for page ${nextPage} sent successfully.`);
                    nextPageQueued = true;
                 } catch (queueError: any) {
                     console.error(`[DO ${doIdShort}] Failed to send message for page ${nextPage} to queue:`, queueError);
                     const errorMsg = `Failed to queue task for page ${nextPage}: ${queueError.message}`;
                     await this.storage.put({ syncStatus: 'error', lastError: errorMsg });
                 }
            } else {
                 console.log(`[DO ${doIdShort}] Status is '${currentStatus}', not queueing next page.`);
            }
        });
         return new Response(JSON.stringify({ success: true, nextPageQueued: nextPageQueued }), { headers: { 'Content-Type': 'application/json' } });
    }

    /** 记录 sync-worker 遇到的错误 */
     async reportError(errorMessage: string): Promise<Response> {
		 const doIdShort = this.state.id.toString().substring(0, 6);
         await this.state.blockConcurrencyWhile(async () => {
             console.error(`[DO ${doIdShort}] Received error report from sync-worker: ${errorMessage}`);
             // 可以选择只记录错误，不一定改变 syncStatus，让下一次 /start 重新触发
             // 或者设置为 error 状态阻止自动进行
             await this.storage.put({ syncStatus: 'error', lastError: errorMessage }); 
         });
          return new Response(JSON.stringify({ success: true, message: "Error reported." }), { headers: { 'Content-Type': 'application/json' } });
     }

     /** 新增：重置 DO 内部状态的方法 */
     async resetState(): Promise<Response> {
        const doIdShort = this.state.id.toString().substring(0, 6);
        console.warn(`[DO ${doIdShort}] Received request to reset state! Deleting all stored data...`);
        
        // 使用 blockConcurrencyWhile 确保原子性
        await this.state.blockConcurrencyWhile(async () => {
            await this.storage.deleteAll(); // 删除所有内部存储
            // 重置为初始状态
            await this.storage.put({
                syncStatus: 'idle',
                lastProcessedPage: 0
            });
             // 可以选择性删除其他可能存在的 key
             // await this.storage.delete(['totalPages', 'lastRunStart', 'lastError']); 
        });

        console.log(`[DO ${doIdShort}] State reset complete.`);
        return new Response(JSON.stringify({ success: true, message: 'Durable Object state has been reset.'}), { headers: {'Content-Type':'application/json'} });
    }
}