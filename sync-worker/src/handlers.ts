// ~/imgN/sync-worker/src/handlers.ts (再次确认版 - 重点检查 types.ts 文件是否存在)
import { ExecutionContext, MessageBatch, Response } from '@cloudflare/workers-types';
// Request type is globally available

// 导入类型定义和核心处理逻辑
// 错误 TS2307 在此行报告: 请确保 './types.ts' 文件存在于 'sync-worker/src/' 目录下，并且文件名大小写正确。
import { Env } from './types';
// 使用正确的相对路径导入共享类型
import { QueueMessagePayload } from '../../api-worker/src/api-types'; // 确认此相对路径正确
import { processSyncPage } from './sync-logic';

// --- CORS Helper Functions ---
const corsHeadersMap = {
    'Access-Control-Allow-Origin': '*', // Be more specific in production
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeadersMap).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });
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
    if (
        request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null
    ) {
        const allowHeaders = request.headers.get('Access-Control-Request-Headers');
        const headers = {
            ...corsHeadersMap,
            'Access-Control-Allow-Headers': allowHeaders ?? 'Content-Type',
        };
        return new Response(null, { headers: headers });
    } else {
        return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }
}

// --- Worker 事件处理程序 ---

/**
 * 处理 HTTP Fetch 请求 (状态页面)
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    console.log(`[SyncWorker Fetch] Received: ${request.method} ${requestUrl.pathname}`);

    if (request.method === 'OPTIONS') {
        return handleOptions(request);
    }

    let response: Response;

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/health') {
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>imgn-sync-worker Status</title><style>body{font-family: system-ui, sans-serif; padding: 2em; line-height: 1.6;} h1{color:#333;} p{color:#555;} code{background-color:#f4f4f4; padding:2px 4px; border-radius:3px;}</style></head><body><h1>imgn-sync-worker Status</h1><p>✅ This Worker is actively processing queue tasks.</p><p>It fetches data, updates the database, and stores images.</p><p>Monitor activity via Cloudflare dashboard logs or <code>wrangler tail imgn-sync-worker</code>.</p><hr><p><em>Current server time: ${new Date().toISOString()}</em></p></body></html>`;
        response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    } else {
        response = new Response('Not Found. This worker primarily processes queue tasks.', { status: 404 });
    }

    return addCorsHeaders(response);
}

/**
 * 处理来自 Cloudflare Queue 的消息批次
 */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[QueueHandler] Received batch with ${batch.messages.length} message(s). Queue: ${batch.queue}`);

    const messagePromises = batch.messages.map(async (message) => {
        const messageId = message.id;
        let pageToProcess: number | undefined = undefined;
        let processingResult: { success: boolean; photoCount: number; error?: string } | null = null;

        console.log(`[QueueHandler] Processing message ID: ${messageId}`);

        try {
            // 1. Validate Payload
            const payload = message.body;
            if (!payload || typeof payload.page !== 'number' || !Number.isInteger(payload.page) || payload.page <= 0) {
                console.error(`[QueueHandler] Invalid or missing page number in payload for message ${messageId}. Payload:`, JSON.stringify(payload));
                message.ack();
                console.warn(`[QueueHandler] Invalid message ${messageId} acknowledged.`);
                return;
            }
            pageToProcess = payload.page;

            // 2. Process the Sync Page Logic
            console.log(`[QueueHandler] Calling processSyncPage for page ${pageToProcess} (Message ID: ${messageId})...`);

            if (typeof pageToProcess === 'number') {
                processingResult = await processSyncPage(pageToProcess, env, ctx);
            } else {
                console.error(`[QueueHandler] Internal Logic Error: pageToProcess (${pageToProcess}) is not a number before calling processSyncPage for message ${messageId}.`);
                processingResult = { success: false, photoCount: 0, error: 'Internal logic error: page number became invalid.' };
            }

            console.log(`[QueueHandler] processSyncPage result for page ${pageToProcess}:`, processingResult);

            // 3. Acknowledge based on processing attempt
            message.ack();
            console.log(`[QueueHandler] Message ID ${messageId} (Page ${pageToProcess}) acknowledged. Success: ${processingResult.success}`);
            if (!processingResult.success) {
                console.error(`[QueueHandler] Processing failed for page ${pageToProcess}. Error: ${processingResult.error}`);
            }

        } catch (error: any) {
            console.error(`[QueueHandler] UNEXPECTED error processing message ID ${messageId} (Page ${pageToProcess ?? 'unknown'}):`, error);
            processingResult = {
                success: false,
                photoCount: 0,
                error: `Unexpected queue handler error: ${error.message || String(error)}`
            };
            message.ack();
            console.error(`[QueueHandler] Message ${messageId} acknowledged after unexpected handler error.`);
        } finally {
            // 4. Report Status Back to API Worker (via Service Binding)
            if (pageToProcess !== undefined && processingResult !== null) {
                console.log(`[QueueHandler] Reporting status for page ${pageToProcess} via Service Binding...`);

                const reportPayload = processingResult.success
                    ? { pageCompleted: pageToProcess, photoCount: processingResult.photoCount }
                    : { error: `Failed page ${pageToProcess}: ${processingResult.error ?? 'Unknown processing error'}` };

                if (!env.API_WORKER) {
                    console.error("FATAL: Service binding 'API_WORKER' is not configured! Cannot report sync status back.");
                } else {
                    const reportPath = '/report-sync-page';
                    const reportOptions = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(reportPayload),
                    };

                    console.log(`[QueueHandler] Sending report via Service Binding: ${reportOptions.method} ${reportPath} Payload:`, reportPayload);

                    ctx.waitUntil(
                        env.API_WORKER.fetch(reportPath, reportOptions)
                            .then(async (res: Response) => {
                                if (!res.ok) {
                                    const errorText = await res.text();
                                    console.error(`[Service Binding Error] Failed to report page ${pageToProcess} to API_WORKER. Status: ${res.status}. Response:`, errorText);
                                } else {
                                    console.log(`[Service Binding Success] Successfully reported status for page ${pageToProcess}.`);
                                }
                            })
                            .catch((err: unknown) => {
                                let errorMessage = 'Unknown network error';
                                if (err instanceof Error) {
                                    errorMessage = err.message;
                                } else if (typeof err === 'string') {
                                    errorMessage = err;
                                }
                                console.error(`[Service Binding Network Error] Failed to report page ${pageToProcess} due to network issue:`, errorMessage, err);
                            })
                    );
                }
            } else {
                console.log(`[QueueHandler] No processing result to report for message ID ${messageId} (likely invalid payload).`);
            }
        }
    }); // End of messagePromises.map

    await Promise.allSettled(messagePromises);
    console.log(`[QueueHandler] Finished processing batch.`);
} // End of handleQueue