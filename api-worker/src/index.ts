// ~/imgN/api-worker/src/index.ts (最终版 - 分页默认30, 返回总数)
import { ExecutionContext } from '@cloudflare/workers-types';
// 导入 DO 类
import { SyncCoordinatorDO } from './sync-coordinator-do';
// 导入 Env 类型定义 (假设在 api-worker/src/types.ts 中定义)
import { Env } from './types';

// *** 导出 Durable Object 类 ***
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // 生产环境建议替换为你的 Pages 域名
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许 GET 和 POST
    'Access-Control-Allow-Headers': 'Content-Type', // 允许常用的 Content-Type 头
    'Access-Control-Max-Age': '86400', // 预检请求缓存时间 (秒)
};
// 辅助函数：为响应添加 CORS 头 (创建新响应以修改 Headers)
function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => { newHeaders.set(key, value); });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
}
// 辅助函数：处理 OPTIONS 预检请求
function handleOptions(request: Request): Response {
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        return new Response(null, { headers: corsHeaders });
    } else { return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } }); }
}

// --- Worker 主逻辑 ---
export default {
    /**
     * 处理所有进入 api-worker 的 HTTP 请求
     */
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

        // 1. 处理 CORS 预检请求
        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        const url = new URL(request.url);
        const path = url.pathname;
        let response: Response; // 存储最终响应

        try {
            // 2. 定义需要与 DO 交互的路径
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path);
            let doStub: DurableObjectStub | null = null;

            // 3. 如果需要，获取 DO Stub
            if (requiresDo) {
                try {
                    const doNamespace = env.SYNC_COORDINATOR_DO;
                    const doId = doNamespace.idFromName("sync-coordinator-singleton");
                    doStub = doNamespace.get(doId);
                } catch (e: any) {
                    console.error("[API Worker] Failed to get DO Namespace or Stub:", e);
                    throw new Error("Durable Object binding not configured correctly.");
                }
            }

            // --- 4. 路由处理 ---
            if (requiresDo && doStub) { // --- 处理需要 DO 的路径 ---
                let doPath = '';
                let isPostRequired = false;
                let isGetRequired = false;

                // 映射 API 路径到 DO 内部路径
                if (path === '/start-sync') { doPath = '/start'; isPostRequired = true; }
                else if (path === '/stop-sync') { doPath = '/stop'; isPostRequired = true; }
                else if (path === '/sync-status') { doPath = '/status'; isGetRequired = true; }
                else if (path === '/report-sync-page') { doPath = '/report'; isPostRequired = true; }
                else if (path === '/reset-sync-do') { doPath = '/reset'; isPostRequired = true; }

                // 检查方法是否匹配
                if (!doPath) {
                    response = new Response('Internal Routing Error', { status: 500 });
                } else if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) {
                    response = new Response(`Method Not Allowed (${request.method} for ${path}, expected ${isPostRequired ? 'POST' : 'GET'})`, { status: 405 });
                } else {
                    console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`);
                    const doUrl = new URL(request.url);
                    doUrl.pathname = doPath;
                    // 直接将原始请求对象传递给 DO 的 fetch 方法
                    response = await doStub.fetch(doUrl.toString(), request);
                }

            } else if (path === '/images' && request.method === 'GET') { // --- 处理 /images GET 请求 ---
                console.log(`[${new Date().toISOString()}] Request received for /images`);
                const params = url.searchParams;
                // *** 确认分页参数默认值为 30 ***
                const page = parseInt(params.get('page') || '1', 10);
                const limit = parseInt(params.get('limit') || '30', 10); // <-- 默认 30
                const pageNum = Math.max(1, isNaN(page) ? 1 : page);
                const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 30 : limit)); // <-- 默认 30, 上限 50
                const offset = (pageNum - 1) * limitNum;

                console.log(`Querying D1 (table: img3_metadata): page=${pageNum}, limit=${limitNum}, offset=${offset}`);

                // 查询总记录数
                const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
                const countResult = await countStmt.first<{ total: number }>();
                const totalImages = countResult?.total ?? 0;
                const totalPages = Math.ceil(totalImages / limitNum);
                console.log(`Total images found: ${totalImages}, Total pages: ${totalPages}`);

                // 查询当前页数据
                const query = `SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`;
                const dataStmt = env.DB.prepare(query).bind(limitNum, offset);
                const { results, success, error } = await dataStmt.all();

                if (!success) { throw new Error(`Database query failed: ${error}`); }
                console.log(`D1 query returned ${results?.length ?? 0} results for page ${pageNum}.`);

                // 构建包含分页信息的响应
                const responsePayload = {
                    success: true,
                    data: {
                        images: results ?? [],
                        page: pageNum,
                        limit: limitNum,
                        totalImages: totalImages,
                        totalPages: totalPages
                    },
                    message: "Images fetched successfully."
                };

                response = new Response(JSON.stringify(responsePayload), { headers: { 'Content-Type': 'application/json' }, status: 200 });

            } else if (path === '/' || path === '/health') { // --- 处理健康检查 ---
                const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>API endpoint: /images</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
                response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

            } else { // --- 处理 404 ---
                response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), {
                    status: 404, headers: { 'Content-Type': 'application/json' }
                });
            }

            // 5. 为所有响应添加 CORS 头
            return addCorsHeaders(response);

        } catch (error: any) {
            // --- 通用错误处理 ---
            console.error(`[API Worker] Error processing request ${request.url}:`, error);
            const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
            response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
            return addCorsHeaders(response);
        }
    },
};