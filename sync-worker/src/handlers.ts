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
 * 处理来自 Cloudflare Queue 的消息批次 (调用 sync-logic)
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[QueueHandler] Received batch with ${batch.messages.length} messages.`);

    // 使用 map 来创建处理每个消息的 Promise 数组
    const messagePromises = batch.messages.map(async (message) => {
        const messageId = message.id;
        let pageToProcess: number | undefined;
        let processingResult: { success: boolean; photoCount: number; error?: string } | null = null;

        console.log(`[QueueHandler] Processing message ID: ${messageId}`);

        try {
            const payload = message.body;
            // 验证消息载荷
            if (!payload || typeof payload.page !== 'number' || payload.page <= 0) {
                console.error(`[QueueHandler] Invalid payload for ${messageId}:`, payload);
                message.ack(); // 确认无效消息，不再重试
                return; // 处理此消息结束
            }
            pageToProcess = payload.page;

            // --- 调用核心处理逻辑 ---
            console.log(`[QueueHandler] Calling processSyncPage for page ${pageToProcess}...`);
            processingResult = await processSyncPage(pageToProcess, env, ctx); // 传入 ctx
            console.log(`[QueueHandler] processSyncPage for page ${pageToProcess} returned:`, processingResult);
            // --- 核心逻辑调用结束 ---

            // 根据处理结果确认或重试消息
            if (processingResult.success) {
                message.ack();
                console.log(`[QueueHandler] Message ID ${messageId} (Page ${pageToProcess}) acknowledged.`);
            } else {
                // 决定是否重试 (这里简单处理：失败也 Ack)
                console.error(`[QueueHandler] processSyncPage failed for page ${pageToProcess}. Acking message. Error: ${processingResult.error}`);
                message.ack();
            }

        } catch (error: any) {
            // 捕获 processSyncPage 或本函数内其他意外错误
            console.error(`[QueueHandler] Unexpected error processing message ID ${messageId} (Page ${pageToProcess}):`, error);
            processingResult = { success: false, photoCount: 0, error: error.message || "Unknown error in queue handler" };
            console.error(`[QueueHandler] Acknowledging failed message ${messageId} due to exception.`);
            message.ack(); // 确认消息，防止卡住
        } finally {
            // --- 回调 API Worker 报告本页处理结果 (使用 Service Binding) ---
            // 确保 pageToProcess 有值并且 processingResult 存在才回调
            if (pageToProcess !== undefined && processingResult !== null) {
                console.log(`[QueueHandler] Reporting status for page ${pageToProcess} via Service Binding...`);

                // 构造回调载荷
                const reportPayload = processingResult.success
                    ? { pageCompleted: pageToProcess, photoCount: processingResult.photoCount }
                    : { error: `Failed page ${pageToProcess}: ${processingResult.error ?? 'Unknown error'}` };

                // 获取 Service Binding
                const apiWorkerBinding = env.API_WORKER;
                if (!apiWorkerBinding) {
                    console.error("FATAL: Service binding 'API_WORKER' is not configured or available! Cannot report back.");
                } else {
                    // 构造 RequestInit 对象
                    const reportPath = '/report-sync-page'; // 目标路径
                    const reportOptions: RequestInit = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(reportPayload),
                    };

                    // 打印将要调用的信息 (用于调试)
                    console.log(`DEBUG: Attempting callback via binding to path ${reportPath} with payload:`, JSON.stringify(reportPayload));

                    // 使用绑定的 fetch 方法调用，并用 waitUntil 包裹
                    ctx.waitUntil(
                        apiWorkerBinding.fetch(reportPath, reportOptions) // 使用 path 和 options
                            .then(async (res) => {
                                if (!res.ok) {
                                    console.error(`[Callback Error via Binding] Failed reporting page ${pageToProcess}: ${res.status}`, await res.text());
                                } else {
                                    console.log(`[Callback Success via Binding] Reported page ${pageToProcess}.`);
                                }
                            })
                            .catch(err => {
                                console.error(`[Callback Network Error via Binding] Error reporting page ${pageToProcess}:`, err);
                            })
                    );
                } // end if apiWorkerBinding
            } // end if pageToProcess !== undefined
        } // end finally block
    }); // end map over messages

    // 等待批次中所有消息的 Promise 完成 (主要为了确保 ack/retry 调用已发出)
    await Promise.allSettled(messagePromises);
    console.log(`[QueueHandler] Finished processing queue batch of ${batch.messages.length} messages.`);

} // end handleQueue