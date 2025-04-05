// ~/imgN/sync-worker/src/handlers.ts (调用 sync-logic)
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import { Env, QueueMessagePayload } from './types';
import { processSyncPage } from './sync-logic'; // <-- 导入核心逻辑
// 可能不再需要直接导入 database, storage, unsplash, utils (如果它们只被 sync-logic 使用)

// --- CORS Helper Functions ---
const corsHeadersMap = { /* ... */ };
function addCorsHeaders(response: Response): void { /* ... */ }
function handleOptions(request: Request): Response { /* ... */ }

// --- Worker 事件处理程序 ---

// handleFetch (保持不变)
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { /* ... (状态页面逻辑) ... */ }


/**
 * 处理来自 Cloudflare Queue 的消息批次 (调用 processSyncPage)
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`[QueueHandler] Received batch with ${batch.messages.length} messages.`);

	// 批处理消息（虽然我们目前每次只发一个）
    // 使用 Promise.allSettled 处理批次中的所有消息
	const promises = batch.messages.map(async (message) => {
        const messageId = message.id;
		let pageToProcess: number | undefined;
        let processingResult: { success: boolean; photoCount: number; error?: string } | null = null;

		console.log(`[QueueHandler] Processing message ID: ${messageId}`);
		
		try {
			const payload = message.body; 
			if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
				console.error(`[QueueHandler] Invalid payload for ${messageId}:`, payload);
				message.ack(); 
                return; // 无需进一步处理此消息
			}
			pageToProcess = payload.page; 
			console.log(`[QueueHandler] Calling processSyncPage for page ${pageToProcess}...`);

            // --- 调用核心处理逻辑 ---
			processingResult = await processSyncPage(pageToProcess, env, ctx);
            console.log(`[QueueHandler] processSyncPage for page ${pageToProcess} returned:`, processingResult);
            // --- 核心逻辑调用结束 ---

            // 根据处理结果确认或重试消息
            if (processingResult.success) {
                message.ack();
                console.log(`[QueueHandler] Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);
            } else {
                // 决定是否重试 (可以基于 processingResult.error 内容)
                console.error(`[QueueHandler] processSyncPage failed for page ${pageToProcess}. Acking message to prevent retry loop. Error: ${processingResult.error}`);
                message.ack(); // 简单处理：失败也 Ack 掉，避免无限重试
                // 或者实现重试: 
                // if (message.attempts < 3) { message.retry({delaySeconds: 30}); } else { message.ack(); }
            }

		} catch (error: any) {
            // 捕获 processSyncPage 或消息处理中的意外错误
			console.error(`[QueueHandler] Unexpected error processing message ID ${messageId} (Page ${pageToProcess}):`, error);
            errorMessageForReport = error.message || "Unknown error in queue handler";
            processingResult = { success: false, photoCount: 0, error: errorMessageForReport }; // 标记为失败
            console.error(`[QueueHandler] Acknowledging failed message ${messageId} due to exception.`);
			message.ack(); // 确认消息，防止卡住
		} finally {
            // --- 回调 API Worker (使用 Service Binding) ---
            // 确保 pageToProcess 有值才回调
            if (pageToProcess !== undefined) {
                console.log(`[QueueHandler] Reporting status for page ${pageToProcess} via Service Binding...`);
                // 如果 processingResult 为 null (例如无效载荷)，发送一个通用错误
                const reportPayload = processingResult 
                    ? (processingResult.success 
                        ? { pageCompleted: pageToProcess, photoCount: processingResult.photoCount } 
                        : { error: `Failed page ${pageToProcess}: ${processingResult.error ?? 'Unknown error'}` }
                      )
                    : { error: `Failed to process message for page ${pageToProcess ?? 'unknown'}` };
                    
                const apiWorkerBinding = env.API_WORKER; 
                if (!apiWorkerBinding) { console.error("FATAL: Service binding 'API_WORKER' missing!"); } 
                else {
                    const reportRequest = new Request(`http://api/report-sync-page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportPayload), });
                    console.log(`DEBUG: Attempting callback via binding with payload:`, JSON.stringify(reportPayload)); 
                    ctx.waitUntil( // 发送回调
                        apiWorkerBinding.fetch(reportRequest)
                            .then(async (res) => { /* ... 处理回调响应日志 ... */ if (!res.ok) console.error(`[Callback Error via Binding] Failed: ${res.status}`, await res.text()); else console.log(`[Callback Success via Binding] Reported page ${pageToProcess}.`);})
                            .catch(err => { console.error(`[Callback Network Error via Binding]:`, err); })
                    );
                } 
            } // end if pageToProcess !== undefined
        } // end finally block
	}); // end map over messages

    // 等待批次中所有消息的处理尝试完成（ack/retry 调用发出）
    await Promise.allSettled(promises);
    console.log(`[QueueHandler] Finished processing batch.`);

} // end handleQueue
