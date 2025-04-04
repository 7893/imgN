// ~/imgN/api-worker/src/index.ts
import { ExecutionContext } from '@cloudflare/workers-types';
// 导入 DO 类
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
// 导入 Env 类型定义 (确保 api-worker/src/types.ts 中定义了正确的 Env)
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
    Object.entries(corsHeaders).forEach(([key, value]) => { 
        newHeaders.set(key, value); 
    });
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders
	}); 
}

// 辅助函数：处理 OPTIONS 预检请求
function handleOptions(request: Request): Response { 
	if (request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null) {
		// 处理 CORS 预检请求
		return new Response(null, { headers: corsHeaders });
	} else { 
        // 处理标准 OPTIONS 请求
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
        let response: Response; // 存储最终响应

		try {
            // 2. 定义需要与 DO 交互的路径
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            
            // 3. 路由处理
            if (doPaths.includes(path)) { // --- 如果是需要 DO 处理的路径 ---
                
                // 获取 DO Stub (单例模式)
                const doNamespace = env.SYNC_COORDINATOR_DO;
                const doId = doNamespace.idFromName("sync-coordinator-singleton"); 
                const doStub = doNamespace.get(doId);
                
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
                    
                    // --- 构造转发给 DO 的请求 ---
                    // 使用 Request 对象来传递 headers 和 body (如果需要)
                    // 这是更健壮的转发方式，特别是对于需要 Body 的 POST 请求
                    const doRequest = new Request(`https://do-internal${doPath}`, request); 

                    // 调用 DO 的 fetch 方法并等待响应
                    response = await doStub.fetch(doRequest);
                    // 注意：从 DO 返回的 Response Headers 是不可变的，添加 CORS 需要克隆
                    // addCorsHeaders 函数内部处理了克隆
                }

            } else if (path === '/' || path === '/health') { // --- 处理健康检查 ---
				 const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET), /reset-sync-do (POST)</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
				 response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' }});
			
			} else { // --- 处理 404 ---
				response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { 
					status: 404, 
					headers: { 'Content-Type': 'application/json' }
				});
			}

            // 4. 为所有从此 Worker 返回的响应添加 CORS 头
            return addCorsHeaders(response); 

		} catch (error: any) {
			// --- 通用错误处理 ---
			console.error(`[API Worker] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
			// 错误响应也添加 CORS
			return addCorsHeaders(response); 
		}
	},
};
