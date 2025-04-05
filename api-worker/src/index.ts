// ~/imgN/api-worker/src/index.ts (添加了总数和总页数返回)
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

        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        const url = new URL(request.url);
        const path = url.pathname;
        let response: Response;

        try {
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path);
            let doStub: DurableObjectStub | null = null;

            if (requiresDo) { /* ... (获取 doStub 逻辑保持不变) ... */
                try { const doNamespace = env.SYNC_COORDINATOR_DO; const doId = doNamespace.idFromName("sync-coordinator-singleton"); doStub = doNamespace.get(doId); } catch (e: any) { console.error("[API Worker] Failed to get DO Namespace or Stub:", e); throw new Error("Durable Object binding not configured correctly."); }
            }

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

            } else if (path === '/images' && request.method === 'GET') { // --- 处理 /images GET 请求 (修改部分) ---
                console.log(`[${new Date().toISOString()}] Request received for /images`);
                const params = url.searchParams;
                const page = parseInt(params.get('page') || '1', 10);
                const limit = parseInt(params.get('limit') || '12', 10);
                const pageNum = Math.max(1, isNaN(page) ? 1 : page);
                const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 12 : limit));
                const offset = (pageNum - 1) * limitNum;

                console.log(`Querying D1 (table: img3_metadata): page=${pageNum}, limit=${limitNum}, offset=${offset}`);

                // *** 新增：查询总记录数 ***
                const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
                const countResult = await countStmt.first<{ total: number }>();
                const totalImages = countResult?.total ?? 0;
                const totalPages = Math.ceil(totalImages / limitNum);
                console.log(`Total images found: ${totalImages}, Total pages: ${totalPages}`);
                // *** 结束新增查询 ***

                // 准备获取当前页数据的查询
                const query = `SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`;
                const dataStmt = env.DB.prepare(query).bind(limitNum, offset);
                const { results, success, error } = await dataStmt.all();

                if (!success) { /* ... (D1 查询失败处理) ... */ throw new Error(`Database query failed: ${error}`); }
                console.log(`D1 query returned ${results?.length ?? 0} results for page ${pageNum}.`);

                // *** 修改：在响应中加入分页信息 ***
                const responsePayload = {
                    success: true,
                    data: {
                        images: results ?? [],
                        page: pageNum,
                        limit: limitNum,
                        totalImages: totalImages, // <-- 返回总记录数
                        totalPages: totalPages    // <-- 返回总页数
                    },
                    message: "Images fetched successfully."
                };
                // *** 结束修改 ***

                response = new Response(JSON.stringify(responsePayload), { headers: { 'Content-Type': 'application/json' }, status: 200 });

            } else if (path === '/' || path === '/health') { /* ... (健康检查保持不变) ... */
                const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>API endpoint: /images</p><p>Time: ${new Date().toISOString()}</p></body></html>`; // 更新了 health 信息
                response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

            } else { /* ... (404 保持不变) ... */
                response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }

            // 为所有响应添加 CORS 头
            return addCorsHeaders(response);

        } catch (error: any) { /* ... (通用错误处理保持不变) ... */
            console.error(`[API Worker] Error processing request ${request.url}:`, error); const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'; response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), { status: 500, headers: { 'Content-Type': 'application/json' }, }); return addCorsHeaders(response);
        }
    },
};