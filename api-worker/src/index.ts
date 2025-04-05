// ~/imgN/api-worker/src/index.ts (最终确认版 - 含 KV 缓存和正确 CORS)
import { ExecutionContext, DurableObjectStub } from '@cloudflare/workers-types'; // 确保导入 DurableObjectStub
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types'; // 确保 types.ts 包含 KV_CACHE

// 导出 DO 类
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // 允许所有来源 (简单起见)
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许的方法
    'Access-Control-Allow-Headers': 'Content-Type', // 允许的请求头
    'Access-Control-Max-Age': '86400', // 预检请求结果缓存时间 (秒)
};

// 辅助函数：为响应添加 CORS 头 (通过创建新 Response 对象)
function addCorsHeaders(response: Response): Response {
    // 创建一个新的 Headers 对象，复制原始响应头
    const newHeaders = new Headers(response.headers);
    // 在新 Headers 对象上添加/覆盖 CORS 头部
    Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });
    // 返回一个新的 Response 对象，使用原始响应体、状态，但应用新的 Headers
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders // 使用包含 CORS 头的新 Headers 对象
    });
}

// 辅助函数：处理 OPTIONS 预检请求
function handleOptions(request: Request): Response {
    // 确保是合法的预检请求
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        // 直接返回带有 CORS 允许头部的空响应
        return new Response(null, { headers: corsHeaders });
    } else {
        // 对于非预检的 OPTIONS 请求，返回允许的方法
        return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } });
    }
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
        let response: Response; // 声明用于存储最终响应的变量

        try {
            // 2. 判断是否需要与 DO 交互
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
                    console.error("[API Worker] 获取 DO 绑定或 Stub 失败:", e);
                    throw new Error("Durable Object binding 配置错误。");
                }
            }

            // --- 4. 路由处理 ---
            if (requiresDo && doStub) { // --- A. 处理需要 DO 的路径 ---
                let doPath = '';
                let isPostRequired = false; let isGetRequired = false;
                // 映射 API 路径到 DO 内部路径
                if (path === '/start-sync') { doPath = '/start'; isPostRequired = true; }
                else if (path === '/stop-sync') { doPath = '/stop'; isPostRequired = true; }
                else if (path === '/sync-status') { doPath = '/status'; isGetRequired = true; }
                else if (path === '/report-sync-page') { doPath = '/report'; isPostRequired = true; }
                else if (path === '/reset-sync-do') { doPath = '/reset'; isPostRequired = true; }

                // 检查方法是否匹配
                if (!doPath) { response = new Response('Internal Routing Error', { status: 500 }); }
                else if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) {
                    response = new Response(`Method Not Allowed (${request.method} for ${path})`, { status: 405 });
                }
                else { // 方法匹配，转发给 DO
                    console.log(`[API Worker] 转发 ${request.method} ${path} 到 DO 路径 ${doPath}...`);
                    const doUrl = new URL(request.url);
                    doUrl.pathname = doPath;
                    // 将原始请求（包含 headers, body 等）转发给 DO
                    response = await doStub.fetch(doUrl.toString(), request);
                }

            } else if (path === '/images' && request.method === 'GET') { // --- B. 处理 /images (带 KV 缓存) ---
                console.log(`[${new Date().toISOString()}] 请求 /images`);
                const params = url.searchParams;
                const page = parseInt(params.get('page') || '1', 10);
                const limit = parseInt(params.get('limit') || '10', 10); // 确认默认 10
                const pageNum = Math.max(1, isNaN(page) ? 1 : page);
                const limitNum = Math.min(50, Math.max(1, isNaN(limit) ? 10 : limit));

                const cacheKey = `images_p${pageNum}_l${limitNum}`;
                console.log(`[Cache] 检查 Key: ${cacheKey}`);

                try {
                    const cachedData = await env.KV_CACHE.get(cacheKey, "text"); // 尝试从 KV 读取
                    if (cachedData !== null) { // 缓存命中
                        console.log(`[Cache] 命中 Key: ${cacheKey}`);
                        response = new Response(cachedData, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'hit' }, status: 200 });
                    } else { // 缓存未命中
                        console.log(`[Cache] 未命中 Key: ${cacheKey}. 查询 D1...`);
                        const offset = (pageNum - 1) * limitNum;
                        // 并发查询总数和数据
                        const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
                        const dataStmt = env.DB.prepare(`SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`).bind(limitNum, offset);
                        const [countResult, dataResult] = await Promise.all([countStmt.first<{ total: number }>(), dataStmt.all()]);
                        if (!dataResult.success) { throw new Error(`D1 查询失败: ${dataResult.error}`); }
                        const totalImages = countResult?.total ?? 0;
                        const totalPages = Math.ceil(totalImages / limitNum);
                        const images = dataResult.results ?? [];
                        console.log(`D1 返回 ${images.length} 条记录 (Page ${pageNum}, Total ${totalImages})`);
                        // 构造响应体
                        const responsePayload = { success: true, data: { images, page: pageNum, limit: limitNum, totalImages, totalPages }, message: "从源获取成功。" };
                        const responsePayloadString = JSON.stringify(responsePayload);
                        // 异步写入缓存
                        const cacheTtlSeconds = 60;
                        console.log(`[Cache] 写入 KV Key: ${cacheKey}, TTL: ${cacheTtlSeconds}s`);
                        ctx.waitUntil(env.KV_CACHE.put(cacheKey, responsePayloadString, { expirationTtl: cacheTtlSeconds }).catch(err => console.error(`[Cache] KV put 失败:`, err)));
                        // 返回从 D1 获取的数据
                        response = new Response(responsePayloadString, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'miss' }, status: 200 });
                    }
                } catch (kvOrDbError) { console.error(`[API Worker /images] 处理 KV 或 D1 时出错:`, kvOrDbError); throw kvOrDbError; } // 重新抛出让外层 catch 处理

            } else if (path === '/' || path === '/health') { // --- C. 健康检查 ---
                const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>API endpoint: /images</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
                response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

            } else { // --- D. 404 Not Found ---
                response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }

            // --- 5. 为所有响应添加 CORS 头 ---
            return addCorsHeaders(response);

        } catch (error: any) { // --- 通用错误处理 ---
            console.error(`[API Worker] 请求处理出错 ${request.url}:`, error);
            const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
            response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), { status: 500, headers: { 'Content-Type': 'application/json' }, });
            return addCorsHeaders(response);
        }
    },
};