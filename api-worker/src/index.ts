// ~/imgN/api-worker/src/index.ts (添加了 CORS Debug 日志)
import { ExecutionContext, DurableObjectStub } from '@cloudflare/workers-types'; 
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
import { Env } from './types'; // 假设 types.ts 定义了 Env (含 DB, KV_CACHE, SYNC_COORDINATOR_DO, SYNC_TASK_QUEUE)

// 导出 DO 类
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
	'Access-Control-Allow-Origin': '*', 
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', 
};

/**
 * 辅助函数：为响应添加 CORS 头 (包含详细 Debug 日志)
 * @param response 原始 Response 对象
 * @returns 带有 CORS 头部的新 Response 对象
 */
function addCorsHeaders(response: Response): Response { 
    // --- DEBUG LOGGING START ---
    try { 
        // 尝试记录原始头信息，使用 try-catch 防止意外错误
        const originalHeaders: { [key: string]: string } = {};
        response.headers.forEach((value, key) => { originalHeaders[key] = value; });
        console.log("[CORS Debug] addCorsHeaders 被调用。原始响应头:", JSON.stringify(originalHeaders)); 
    } catch(e) { console.error("[CORS Debug] 无法记录原始响应头:", e); }
    // --- DEBUG LOGGING END ---

    const newHeaders = new Headers(response.headers); 
    Object.entries(corsHeaders).forEach(([key, value]) => { 
        // --- DEBUG LOGGING START ---
        console.log(`[CORS Debug] 正在设置 Header: ${key}=${value}`);
        // --- DEBUG LOGGING END ---
        newHeaders.set(key, value); 
    });
    
    // --- DEBUG LOGGING START ---
    try {
        // 尝试记录最终设置的头信息
        const finalHeaders: { [key: string]: string } = {};
        newHeaders.forEach((value, key) => { finalHeaders[key] = value; });
        console.log("[CORS Debug] 完成设置，新的 Headers 对象内容:", JSON.stringify(finalHeaders));
    } catch(e) { console.error("[CORS Debug] 无法记录新响应头:", e); }
    // --- DEBUG LOGGING END ---

    // 返回带有新头信息的新响应
    return new Response(response.body, { 
        status: response.status, 
        statusText: response.statusText, 
        headers: newHeaders 
    }); 
}

/**
 * 辅助函数：处理 OPTIONS 预检请求 (保持不变)
 */
function handleOptions(request: Request): Response { 
    // ... (之前的 handleOptions 代码) ...
	if (request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null) {
		console.log("[CORS Debug] Handling OPTIONS preflight request."); // 添加日志
		return new Response(null, { headers: corsHeaders });
	} else { 
        console.log("[CORS Debug] Handling standard OPTIONS request."); // 添加日志
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
			return handleOptions(request); // handleOptions 内部已包含 CORS 头
		}

		// *** 入口日志 ***
		const url = new URL(request.url);
		const path = url.pathname;
		console.log(`[API Worker Entry] Received request: ${request.method} ${path}`);
        // *** 结束入口日志 ***

        let response: Response; // 最终响应

		try {
            // 2. 判断是否需要 DO
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path); 
            let doStub: DurableObjectStub | null = null;

            // 3. 获取 DO Stub (如果需要)
            if (requiresDo) { /* ... (获取 doStub 逻辑) ... */ try { const ns = env.SYNC_COORDINATOR_DO; const id = ns.idFromName("sync-coordinator-singleton"); doStub = ns.get(id); } catch (e: any) { console.error("DO 获取失败:", e); throw new Error("DO binding 配置错误."); } }
            
            // --- 4. 路由处理 ---
            if (requiresDo && doStub) { // --- A. 处理需要 DO 的路径 ---
                 let doPath = ''; let isPost = false; let isGet = false;
                if (path === '/start-sync') { doPath = '/start'; isPost = true; }
                else if (path === '/stop-sync') { doPath = '/stop'; isPost = true; }
                else if (path === '/sync-status') { doPath = '/status'; isGet = true; }
                else if (path === '/report-sync-page') { doPath = '/report'; isPost = true; }
                else if (path === '/reset-sync-do') { doPath = '/reset'; isPost = true; }
                
                if (!doPath) { response = new Response('Internal Routing Error', { status: 500 }); }
                else if ((isPost && request.method !== 'POST') || (isGet && request.method !== 'GET')) { response = new Response(`Method Not Allowed`, { status: 405 }); } 
                else { 
                    console.log(`[API Worker] 转发 ${request.method} ${path} 到 DO ${doPath}...`); 
                    const doUrl = new URL(request.url); doUrl.pathname = doPath; 
                    response = await doStub.fetch(doUrl.toString(), request); // 调用 DO
                    console.log(`[API Worker] 从 DO 收到响应，状态码: ${response.status}`); // 记录 DO 返回状态
                }

            } else if (path === '/images' && request.method === 'GET') { // --- B. 处理 /images (带 KV 缓存) ---
                console.log(`[API Worker /images] 开始处理...`);
                const params = url.searchParams;
                const pageNum = Math.max(1, parseInt(params.get('page') || '1', 10));
                const limitNum = Math.min(50, Math.max(1, parseInt(params.get('limit') || '10', 10))); // 默认 10
                const cacheKey = `images_p${pageNum}_l${limitNum}`;
                console.log(`[Cache] 检查 Key: ${cacheKey}`);
                try {
                    const cachedData = await env.KV_CACHE.get(cacheKey, "text");
                    if (cachedData !== null) { // 缓存命中
                        console.log(`[Cache] 命中 Key: ${cacheKey}`);
                        response = new Response(cachedData, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'hit' }});
                    } else { // 缓存未命中
                        console.log(`[Cache] 未命中 Key: ${cacheKey}. 查询 D1...`);
                        const offset = (pageNum - 1) * limitNum;
                        const countStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM img3_metadata;`);
                        const dataStmt = env.DB.prepare(`SELECT * FROM img3_metadata ORDER BY created_at_api DESC LIMIT ?1 OFFSET ?2;`).bind(limitNum, offset);
                        const [countResult, dataResult] = await Promise.all([ countStmt.first<{ total: number }>(), dataStmt.all() ]);
                        if (!dataResult.success) { throw new Error(`D1 查询失败: ${dataResult.error}`); }
                        const totalImages = countResult?.total ?? 0; const totalPages = Math.ceil(totalImages / limitNum); const images = dataResult.results ?? [];
                        console.log(`D1 返回 ${images.length} 条记录.`);
                        const responsePayload = { success: true, data: { images, page: pageNum, limit: limitNum, totalImages, totalPages }, message: "从源获取成功。" };
                        const responsePayloadString = JSON.stringify(responsePayload);
                        const cacheTtlSeconds = 60; 
                        console.log(`[Cache] 写入 KV Key: ${cacheKey}, TTL: ${cacheTtlSeconds}s`);
                        ctx.waitUntil( env.KV_CACHE.put(cacheKey, responsePayloadString, { expirationTtl: cacheTtlSeconds }).catch(err => console.error(`[Cache] KV put 失败:`, err)) );
                        response = new Response(responsePayloadString, { headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'miss' }});
                    }
                } catch (kvOrDbError) { console.error(`[API Worker /images] 处理出错:`, kvOrDbError); throw kvOrDbError; }
            
            } else if (path === '/' || path === '/health') { // --- C. 健康检查 ---
				 const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>...</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
				 response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' }});
			
			} else { // --- D. 404 Not Found ---
				response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' }});
			}

            // --- 5. 为所有从此 Worker 返回的响应添加 CORS 头 ---
            console.log(`[API Worker] 准备通过 addCorsHeaders 返回最终响应 (Status: ${response.status})...`);
            return addCorsHeaders(response); // <--- 统一出口

		} catch (error: any) { // --- 通用错误处理 ---
			console.error(`[API Worker] 未捕获的顶层错误 ${request.url}:`, error); 
            const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'; 
            response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), { status: 500, headers: { 'Content-Type': 'application/json' }, }); 
             console.log(`[API Worker] 准备通过 addCorsHeaders 返回 500 错误响应...`);
            return addCorsHeaders(response); // <--- 错误出口也加 CORS
		}
	},
};
