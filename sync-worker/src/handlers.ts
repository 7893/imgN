// ~/imgN/sync-worker/src/handlers.ts (修正 addCorsHeaders 返回类型)
import { ExecutionContext, MessageBatch, Request, Response } from '@cloudflare/workers-types'; // 明确导入 Response
import { Env, QueueMessagePayload } from './types';
import { processSyncPage } from './sync-logic';

// --- CORS Helper Functions (修正 addCorsHeaders) ---
const corsHeadersMap = { /* ... */ };
// *** 修改：确保返回 Response 类型 ***
function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeadersMap).forEach(([key, value]) => { newHeaders.set(key, value); });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
}
function handleOptions(request: Request): Response { /* ... */ if (...) { return new Response(null, { headers: corsHeadersMap }); } else { return new Response(null, { headers: { Allow: 'GET, HEAD, OPTIONS' } }); } }

// --- Worker 事件处理程序 ---
/** 处理 HTTP Fetch 请求 (调用修正后的 addCorsHeaders) */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`[${new Date().toISOString()}] Received fetch request: ${request.url}`);
    if (request.method === 'OPTIONS') { return handleOptions(request); }
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === '/' || url.pathname === '/health') {
        const html = `...`; // 健康检查页面 HTML
        response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    } else { response = new Response('Not Found', { status: 404 }); }
    // *** 修改：确保返回 addCorsHeaders 的结果 ***
    return addCorsHeaders(response);
}

/** 处理 Queue 消息 (保持不变，它不直接返回 Response 给外部) */
export async function handleQueue(batch: MessageBatch<QueueMessagePayload>, env: Env, ctx: ExecutionContext): Promise<void> { /* ... (之前的逻辑不变) ... */ }