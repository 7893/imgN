// ~/imgN/api-worker/src/index.ts (分页默认 limit 改为 10)
import { ExecutionContext } from '@cloudflare/workers-types';
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types';

export { SyncCoordinatorDO };

// --- CORS 处理 (保持不变) ---
const corsHeaders = { /* ... */ };
function addCorsHeaders(response: Response): Response { /* ... */ const newHeaders = new Headers(response.headers); Object.entries(corsHeaders).forEach(([key, value]) => { newHeaders.set(key, value); }); return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders }); }
function handleOptions(request: Request): Response { /* ... */ if (request.headers.get('Origin') !== null && request.headers.get('Access-Control-Request-Method') !== null && request.headers.get('Access-Control-Request-Headers') !== null) { return new Response(null, { headers: corsHeaders }); } else { return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } }); } }

// --- Worker 主逻辑 ---
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

        if (request.method === 'OPTIONS') { return handleOptions(request); }

        const url = new URL(request.url);
        const path = url.pathname;
        let response: Response;

        try {
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path);
            let doStub: DurableObjectStub | null = null;
            if (requiresDo) { /* ... (获取 doStub 逻辑保持不变) ... */ try { const doNamespace = env.SYNC_COORDINATOR_DO; const doId = doNamespace.idFromName("sync-coordinator-singleton"); doStub = doNamespace.get(doId); } catch (e: any) { console.error("[API Worker] Failed to get DO Namespace or Stub:", e); throw new Error("Durable Object binding not configured correctly."); } }

            // --- 路由处理 ---
            if (requiresDo && doStub) { /* ... (DO 转发逻辑保持不变) ... */
                let doPath = ''; let isPostRequired = false; let isGetRequired = false;
                if (path === '/start-sync') { doPath = '/start'; isPostRequired = true; }
                else if (path === '/stop-sync') { doPath = '/stop'; isPostRequired = true; }
                else if (path === '/sync-status') { doPath = '/status'; isGetRequired = true; }
                else if (path === '/report-sync-page') { doPath = '/report'; isPostRequired = true; }
                else if (path === '/reset-sync-do') { doPath = '/reset'; isPostRequired = true; }
                if (!doPath) { response = new Response('Internal Routing Error', { status: 500 }); }
                else if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) { response = new Response(`Method Not Allowed...`, { status: 405 }); }
                else { console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`); const doUrl = new URL(request.url); doUrl.pathname = doPath; response = await doStub.fetch(doUrl.toString(), request); }

            } else if (path === '/images' && request.method === 'GET') { // --- 处理 /images GET 请求 (修改 limit 默认值) ---
                console.log(`[${new Date().toISOString()}] Request received for /images`);
                const params = url.searchParams;
                // *** 修改：将 limit 的默认值从 5 改为 10 ***
                const page = parseInt(params.get('page') || '1', 10);
                const limit = parseInt(params.get('limit') || '10', 10); // <-- 默认 10
                const pageNum = Math.max(1, isNaN(page) ? 1 : page);
                const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 10 : limit)); // <-- 默认 10, 上限 50
                const offset = (pageNum - 1) * limitNum;

                console.log(`Querying D1 (table: img3_metadata): page=${pageNum}, limit=${limitNum}, offset=${offset}`);

                // --- KV Caching Logic (保持不变) ---
                const cacheKey = `images_p${pageNum}_l${limitNum}`;
                console.log(`[Cache] Checking cache for key: ${cacheKey}`);
                try {
                    const cachedData = await env.KV_CACHE.get(cacheKey, "text");
                    if (cachedData !== null) {
                        console.log(`[Cache] Hit for key: ${cacheKey}`);
                        response = new Response(cachedData, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'hit' }, status: 200 });
                        return addCorsHeaders(response); // 直接返回缓存
                    } else {
                        console.log(`[Cache] Miss for key: ${cacheKey}. Querying D1...`);
                        // --- 查询 D1 (保持不变) ---
                        const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
                        const dataStmt = env.DB.prepare(`SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`).bind(limitNum, offset);
                        const [countResult, dataResult] = await Promise.all([countStmt.first<{ total: number }>(), dataStmt.all()]);
                        if (!dataResult.success) { throw new Error(`Database query failed: ${dataResult.error}`); }
                        const totalImages = countResult?.total ?? 0;
                        const totalPages = Math.ceil(totalImages / limitNum);
                        const images = dataResult.results ?? [];
                        console.log(`D1 query returned ${images.length} results for page ${pageNum}. Total: ${totalImages}`);
                        // --- 构造响应体 (保持不变) ---
                        const responsePayload = { success: true, data: { images, page: pageNum, limit: limitNum, totalImages, totalPages }, message: "Images fetched successfully (from source)." };
                        const responsePayloadString = JSON.stringify(responsePayload);
                        // --- 存入 KV (保持不变) ---
                        const cacheTtlSeconds = 60;
                        console.log(`[Cache] Storing data in KV for key: ${cacheKey} with TTL: ${cacheTtlSeconds}s`);
                        ctx.waitUntil(env.KV_CACHE.put(cacheKey, responsePayloadString, { expirationTtl: cacheTtlSeconds }).catch(err => console.error(`[Cache] KV put failed for key ${cacheKey}:`, err)));
                        // --- 返回响应 ---
                        response = new Response(responsePayloadString, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'miss' }, status: 200 });
                    } // End Cache Miss
                } catch (kvOrDbError) { /* ... (错误处理) ... */ throw kvOrDbError; }

            } else if (path === '/' || path === '/health') { /* ... (健康检查) ... */
                const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>API endpoint: /images</p><p>Time: ${new Date().toISOString()}</p></body></html>`; // 简化 health 信息
                response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

            } else { /* ... (404) ... */
                response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }
            return addCorsHeaders(response);
        } catch (error: any) { /* ... (通用错误处理) ... */
            console.error(`[API Worker] Error processing request ${request.url}:`, error); const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'; response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), { status: 500, headers: { 'Content-Type': 'application/json' }, }); return addCorsHeaders(response);
        }
    },
};