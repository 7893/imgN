// ~/imgN/api-worker/src/index.ts (修正 DO fetch 调用)
import { ExecutionContext, DurableObjectStub, RequestInit } from '@cloudflare/workers-types';
// Request, Response, Headers 使用全局类型
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types';

export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = { /* ... */ };
function addCorsHeaders(response: Response): Response { /* ... */ } // 确认此函数返回 Response
function handleOptions(request: Request): Response { /* ... */ } // 确认此函数返回 Response

// --- Worker 主逻辑 ---
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

        if (request.method === 'OPTIONS') { return handleOptions(request); }

        const url = new URL(request.url);
        const path = url.pathname;
        console.log(`[API Worker Entry] Request: ${request.method} ${path}`);
        let response: Response;

        try {
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path);
            let doStub: DurableObjectStub | null = null;
            if (requiresDo) { /* ... 获取 doStub ... */ }

            // --- 路由处理 ---
            if (requiresDo && doStub) { // --- 处理需要 DO 的路径 ---
                let doPath = ''; let isPostRequired = false; let isGetRequired = false;
                /* ... 路径映射 ... */
                if (path === '/start-sync') { doPath = '/start'; isPostRequired = true; } else if (path === '/stop-sync') { doPath = '/stop'; isPostRequired = true; } else if (path === '/sync-status') { doPath = '/status'; isGetRequired = true; } else if (path === '/report-sync-page') { doPath = '/report'; isPostRequired = true; } else if (path === '/reset-sync-do') { doPath = '/reset'; isPostRequired = true; }

                if (!doPath) { response = new Response('Internal Routing Error', { status: 500 }); }
                else if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) { response = new Response(`Method Not Allowed`, { status: 405 }); }
                else {
                    console.log(`[API Worker] Forwarding ${request.method} ${path} to DO ${doPath}...`);
                    const doUrl = new URL(request.url); doUrl.pathname = doPath;

                    // *** 修正：明确构造 RequestInit ***
                    const doRequestInit: RequestInit = {
                        method: request.method,
                        headers: request.headers, // 直接传递 headers 通常可以，类型系统可能过于严格
                    };
                    // 只有 POST/PUT/PATCH 且有 Body 时才克隆并传递 Body
                    if (request.body && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
                        // 使用 clone().body 来获取可传递的 ReadableStream
                        doRequestInit.body = request.clone().body;
                    }
                    // *** 结束修正 ***

                    // 使用 URL 字符串和 RequestInit 调用 DO 的 fetch
                    response = await doStub.fetch(doUrl.toString(), doRequestInit);
                    console.log(`[API Worker] DO response status: ${response.status}`);
                }

            } else if (path === '/images' && request.method === 'GET') { /* ... (KV 缓存和 D1 查询逻辑) ... */ response = new Response("...", { headers: {} }); // Placeholder
            } else if (path === '/' || path === '/health') { /* ... (健康检查) ... */ response = new Response("...", { headers: {} }); // Placeholder
            } else { /* ... (404) ... */ response = new Response("...", { status: 404, headers: {} }); // Placeholder
            }
            // 确保 addCorsHeaders 返回 Response
            return addCorsHeaders(response);

        } catch (error: any) { /* ... (通用错误处理, 确保返回 addCorsHeaders(response)) ... */
            console.error(`[API Worker] Error:`, error);
            response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error' }), { status: 500, headers: { 'Content-Type': 'application/json' }, });
            return addCorsHeaders(response);
        }
    },
};