// ~/imgN/sync-worker/src/handlers.ts (最终版本)
import { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
// Request 和 Response 不需要从这里导入

// 导入类型定义和核心处理逻辑
import { Env, QueueMessagePayload } from './types';
import { processSyncPage } from './sync-logic';
// 可能不再需要直接导入 database, storage, unsplash, utils (如果它们只被 sync-logic 使用)
// import { getFolderNameFromTags } from './utils'; // 如果 CORS 辅助函数移到 utils.ts 则需要

// --- CORS Helper Functions ---
const corsHeadersMap = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

/**
 * 辅助函数：为响应添加 CORS 头 (修正后版本)
 * @param response 原始 Response 对象
 * @returns 带有 CORS 头部的新 Response 对象
 */
function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeadersMap).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });
    // 返回带有新头的新 Response 对象
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

/**
 * 辅助函数：处理 OPTIONS 预检请求
 */
function handleOptions(request: Request): Response {
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        // 处理 CORS 预检请求
        return new Response(null, { headers: corsHeadersMap });
    } else {
        // 处理标准 OPTIONS 请求
        return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }
}


// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面 - 调用修正后的 addCorsHeaders)
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
    if (request.method === 'OPTIONS') {
        // 对于 OPTIONS 请求，直接返回 handleOptions 的结果 (已包含 CORS 头)
        return handleOptions(request);
    }

    const url = new URL(request.url);
    let response: Response; // 先声明响应变量

    if (url.pathname === '/' || url.pathname === '/health') {
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:2em; line-height:1.6;}h1{color:#333;}p{color:#555;}code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head><body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is running!</p><p>It processes tasks from a Cloudflare Queue.</p><p>You can monitor its activity using <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
        response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    } else {
        response = new Response('Not Found', { status: 404 });
    }
    // *** 确保返回 addCorsHeaders 的结果 ***
    return addCorsHeaders(response);
}


/**
 * 处理来自 Cloudflare Queue 的消息批次
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[QueueHandler] Received batch with ${batch.messages.length} messages.`);

    const messagePromises = batch.messages.map(async (message) => {
        const messageId = message.id;
        let pageToProcess: number | undefined;
        let processingResult: { success: boolean; photoCount: number; error?: string } | null = null;

        console.log(`[QueueHandler] Processing message ID: ${messageId}`);

        try {
            const payload = message.body;
            if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
                console.error(`[QueueHandler] Invalid payload for ${messageId}:`, payload);
                message.ack();
                return;
            }
            pageToProcess = payload.page;

            console.log(`[QueueHandler] Calling processSyncPage for page ${pageToProcess}...`);
            processingResult = await processSyncPage(pageToProcess, env, ctx);
            console.log(`[QueueHandler] processSyncPage for page ${pageToProcess} returned:`, processingResult);

            if (processingResult.success) {
                message.ack();
                console.log(`[QueueHandler] Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);
            } else {
                console.error(`[QueueHandler] processSyncPage failed for page ${pageToProcess}. Acking message. Error: ${processingResult.error}`);
                message.ack();
            }

        } catch (error: any) {
            console.error(`[QueueHandler] Unexpected error processing message ID ${messageId} (Page ${pageToProcess}):`, error);
            processingResult = { success: false, photoCount: 0, error: error.message || "Unknown error in queue handler" };
            console.error(`[QueueHandler] Acknowledging failed message ${messageId} due to exception.`);
            message.ack();
        } finally {
            // 使用 Service Binding 回调 API Worker 报告处理结果
            if (pageToProcess !== undefined && processingResult !== null) {
                console.log(`[QueueHandler] Reporting status for page ${pageToProcess} via Service Binding...`);

                const reportPayload = processingResult.success
                    ? { pageCompleted: pageToProcess, photoCount: processingResult.photoCount }
                    : { error: `Failed page ${pageToProcess}: ${processingResult.error ?? 'Unknown error'}` };

                // 使用 Service Binding
                if (!env.API_WORKER) {
                    console.error("FATAL: Service binding 'API_WORKER' is not configured! Cannot report back.");
                } else {
                    const reportPath = '/report-sync-page';
                    const reportOptions = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(reportPayload),
                    };

                    console.log(`[QueueHandler] Sending report via Service Binding:`, {
                        path: reportPath,
                        payload: reportPayload
                    });

                    ctx.waitUntil(
                        env.API_WORKER.fetch(reportPath, reportOptions)
                            .then(async (res) => {
                                if (!res.ok) {
                                    const errorText = await res.text();
                                    console.error(`[Service Binding Error] Failed to report page ${pageToProcess}: ${res.status}`, errorText);
                                } else {
                                    console.log(`[Service Binding Success] Reported page ${pageToProcess}`);
                                }
                            })
                            .catch(err => {
                                console.error(`[Service Binding Network Error] Failed to report page ${pageToProcess}:`, err);
                            })
                    );
                }
            }
        }
    });

    await Promise.allSettled(messagePromises);
    console.log(`[QueueHandler] Finished processing queue batch of ${batch.messages.length} messages.`);
}