// api-worker/src/sync-coordinator-do.ts
import { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';
import { Env } from './types'; // 导入 api-worker 的 Env

// 定义 DO 内部状态的类型 (可选但推荐)
interface SyncState {
	syncStatus: 'idle' | 'running' | 'stopping' | 'error';
	lastProcessedPage: number;
	totalPages?: number; // 如果能从 API 获取总数
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
        // 可以在这里初始化，确保启动时状态存在
        // this.state.blockConcurrencyWhile(async () => {
        //     const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus');
        //     if (!currentStatus) {
        //         await this.storage.put('syncStatus', 'idle');
        //         await this.storage.put('lastProcessedPage', 0);
        //     }
        // });
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		console.log(`[DO ${this.state.id.toString().substring(0,6)}] Request: ${request.method} ${path}`);

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
                    const data = await request.json<{ pageCompleted?: number, error?: string }>();
                    if (typeof data?.pageCompleted === 'number') {
                         return await this.reportPageCompleted(data.pageCompleted);
                    } else if (data?.error) {
                         return await this.reportError(data.error);
                    } else {
                         return new Response('Bad Request: Missing pageCompleted or error in body', { status: 400 });
                    }
                default:
                    return new Response('Not Found', { status: 404 });
            }
        } catch (e: any) {
            console.error(`[DO ${this.state.id.toString().substring(0,6)}] Error in fetch:`, e);
            return new Response(`Internal Server Error: ${e.message}`, { status: 500 });
        }
	}

	/** 开始同步 */
	async startSync(): Promise<Response> {
		let startSuccess = false;
		let message = 'Sync already running or failed to start.';
		let status = 409; // Conflict by default

		await this.state.blockConcurrencyWhile(async () => {
			const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
			if (currentStatus === 'running') {
				console.log("[DO] Sync already running.");
				return; // Exit blockConcurrencyWhile
			}

			console.log("[DO] Setting status to running and starting sync...");
			await this.storage.put('syncStatus', 'running');
			await this.storage.put('lastRunStart', new Date().toISOString());
            await this.storage.delete('lastError'); // Clear previous error
            
			// 决定从哪一页开始 (可以从上次记录的页码+1 开始，或总是从 1 开始)
			// 这里我们先实现简单逻辑：总是从第 1 页开始一个新的同步周期
			const startPage = 1;
			await this.storage.put('lastProcessedPage', 0); // 重置已处理页码

			try {
				console.log(`[DO] Sending initial task (page ${startPage}) to queue...`);
				await this.env.SYNC_TASK_QUEUE.send({ page: startPage });
				console.log(`[DO] Message for page ${startPage} sent successfully.`);
				startSuccess = true;
				message = 'Sync started successfully.';
				status = 200; // OK
			} catch (queueError: any) {
				console.error("[DO] Failed to send initial message to queue:", queueError);
				await this.storage.put('syncStatus', 'error');
                await this.storage.put('lastError', `Failed to queue initial task: ${queueError.message}`);
				message = `Failed to queue initial task: ${queueError.message}`;
				status = 500; // Internal Server Error
			}
		});
		
		return new Response(JSON.stringify({ success: startSuccess, message: message }), { status: status, headers: { 'Content-Type': 'application/json' } });
	}

	/** 停止同步 */
	async stopSync(): Promise<Response> {
		await this.state.blockConcurrencyWhile(async () => {
			await this.storage.put('syncStatus', 'stopping');
			console.log("[DO] Status set to stopping.");
		});
		return new Response(JSON.stringify({ success: true, message: 'Stop request received. Sync will stop queuing new tasks.' }), { headers: { 'Content-Type': 'application/json' } });
	}

	/** 获取状态 */
	async getStatus(): Promise<Response> {
		// Read multiple values simultaneously for efficiency
		const data = await this.storage.get<SyncState>([
            'syncStatus', 
            'lastProcessedPage', 
            'totalPages', 
            'lastRunStart',
            'lastError'
        ]);
		const status = data.get('syncStatus') ?? 'idle';
        const lastPage = data.get('lastProcessedPage') ?? 0;
        const totalPages = data.get('totalPages'); // Might be undefined
        const lastRunStart = data.get('lastRunStart');
        const lastError = data.get('lastError');

		const responseBody = {
			success: true,
			data: { status, lastProcessedPage: lastPage, totalPages, lastRunStart, lastError },
		};
		return new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } });
	}

    /** sync-worker 完成一页后调用此方法 */
    async reportPageCompleted(pageCompleted: number): Promise<Response> {
        let nextPageQueued = false;
        await this.state.blockConcurrencyWhile(async () => {
            const currentStatus = await this.storage.get<SyncState['syncStatus']>('syncStatus') ?? 'idle';
            const lastPage = await this.storage.get<SyncState['lastProcessedPage']>('lastProcessedPage') ?? 0;

            console.log(`[DO] Received report for page ${pageCompleted}. Current status: ${currentStatus}, Last processed: ${lastPage}`);

            // 更新最后处理页码 (只在它是递增时更新)
            if (pageCompleted > lastPage) {
                 await this.storage.put('lastProcessedPage', pageCompleted);
            } else {
                console.warn(`[DO] Received report for page ${pageCompleted}, but last processed page is already ${lastPage}. Ignoring.`);
                // 可能因为重试导致重复报告，通常可以忽略
            }

            // 如果状态是 'running'，则继续发送下一页的任务
            // TODO: 需要增加判断是否已达到最后一页的逻辑 (如果知道 totalPages)
            if (currentStatus === 'running') {
                const nextPage = pageCompleted + 1;
                 try {
                    console.log(`[DO] Sending next task (page ${nextPage}) to queue...`);
                    await this.env.SYNC_TASK_QUEUE.send({ page: nextPage });
                    console.log(`[DO] Message for page ${nextPage} sent successfully.`);
                    nextPageQueued = true;
                 } catch (queueError: any) {
                     console.error(`[DO] Failed to send message for page ${nextPage} to queue:`, queueError);
                     await this.storage.put('syncStatus', 'error');
                     await this.storage.put('lastError', `Failed to queue task for page ${nextPage}: ${queueError.message}`);
                 }
            } else {
                 console.log(`[DO] Status is '${currentStatus}', not queueing next page.`);
                 // 如果状态是 stopping 或 idle 或 error，则不再继续发送任务
            }
        });
         return new Response(JSON.stringify({ success: true, nextPageQueued: nextPageQueued }), { headers: { 'Content-Type': 'application/json' } });
    }

    /** 记录 sync-worker 遇到的错误 */
     async reportError(errorMessage: string): Promise<Response> {
         await this.state.blockConcurrencyWhile(async () => {
             console.error(`[DO] Received error report from sync-worker: ${errorMessage}`);
             await this.storage.put('syncStatus', 'error');
             await this.storage.put('lastError', errorMessage);
         });
          return new Response(JSON.stringify({ success: true, message: "Error reported." }), { headers: { 'Content-Type': 'application/json' } });
     }
}
