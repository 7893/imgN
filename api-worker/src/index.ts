// ~/imgN/api-worker/src/index.ts
import { ExecutionContext } from '@cloudflare/workers-types';
// 导入 DO 类
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
// 导入 Env 类型定义 (假设在 api-worker/src/types.ts 中定义了 Env)
import { Env } from './types'; 

// *** 导出 Durable Object 类 ***
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
	'Access-Control-Allow-Origin': '*', 
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', 
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
		
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		const url = new URL(request.url);
		const path = url.pathname;
        let response: Response; 

		try {
            // 定义需要与 DO 交互的路径
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path); // 判断是否需要 DO 交互

            let doStub: DurableObjectStub | null = null;
            if (requiresDo) {
                try {
                    const doNamespace = env.SYNC_COORDINATOR_DO;
                    // 使用固定的名字获取单例 DO 的 ID 
                    const doId = doNamespace.idFromName("sync-coordinator-singleton"); 
                    // 获取 DO 实例的 Stub
                    doStub = doNamespace.get(doId);
                } catch (e: any) {
                     console.error("[API Worker] Failed to get DO Namespace or Stub:", e);
                     throw new Error("Durable Object binding not configured correctly.");
                }
            }
            
            // --- 路由处理 ---
            if (requiresDo && doStub) { // 确保 doStub 已获取
                let doPath = ''; // DO 内部路径
                let isPostRequired = false;
                let isGetRequired = false;

                // 映射 API 路径到 DO 内部路径，并确定所需方法
                if (path === '/start-sync') { doPath = '/start'; isPostRequired = true; }
                else if (path === '/stop-sync') { doPath = '/stop'; isPostRequired = true; }
                else if (path === '/sync-status') { doPath = '/status'; isGetRequired = true; }
                else if (path === '/report-sync-page') { doPath = '/report'; isPostRequired = true; }
                else if (path === '/reset-sync-do') { doPath = '/reset'; isPostRequired = true; }

                // 检查请求方法是否符合预期
                if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) {
                    response = new Response(`Method Not Allowed (${request.method} for ${path}, expected ${isPostRequired ? 'POST' : 'GET'})`, { status: 405 });
                } else {
                    console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`);
                    
                    // 直接将原始请求（或稍作修改的请求）传递给 DO 的 fetch
                    // DO 的 fetch 方法会处理 headers 和 body
                    // 创建一个新的 URL 指向 DO 内部路径
                    const doUrl = new URL(request.url);
                    doUrl.pathname = doPath; 
                    
                    // 调用 DO 的 fetch 方法并等待响应
                    response = await doStub.fetch(doUrl.toString(), request);
                }

            } else if (path === '/' || path === '/health') {
				 // 健康检查端点
				 const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
				 response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' }});
			
			} else {
				// 其他未匹配路径返回 404
				response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { 
					status: 404, 
					headers: { 'Content-Type': 'application/json' }
				});
			}

            // 为所有从此 Worker 返回的响应添加 CORS 头
            return addCorsHeaders(response); 

		} catch (error: any) {
			// --- 通用错误处理 ---
			console.error(`[API Worker] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
			return addCorsHeaders(response); 
		}
	},
};
