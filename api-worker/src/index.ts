// ~/imgN/api-worker/src/index.ts
import { ExecutionContext } from '@cloudflare/workers-types';
// 导入我们之前创建的 DO 类
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
// 导入 Env 类型定义 (假设在 types.ts 或在此文件上方定义)
import { Env } from './types'; 

// *** 关键：导出 Durable Object 类 ***
// 让 Cloudflare 平台能够找到并实例化这个 DO 类。
// 变量名 SyncCoordinatorDO 必须与 wrangler.jsonc 中 migrations.new_classes 数组里的字符串一致。
export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
	'Access-Control-Allow-Origin': '*', // 生产环境建议替换为你的 Pages 域名
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 包含 POST
	'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 预检请求缓存 (秒)
};
function addCorsHeaders(response: Response): Response { 
    Object.entries(corsHeaders).forEach(([key, value]) => { 
        // 确保不重复设置，或者先移除再设置
        response.headers.delete(key); 
        response.headers.set(key, value); 
    });
	return response; 
}
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
		
		// 处理 CORS 预检请求
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		const url = new URL(request.url);
		const path = url.pathname;
        let response: Response; // 用于存储最终响应

		try {
			// 获取 Durable Object 的 Namespace 绑定
            // 只有需要与 DO 交互的路径才需要获取 stub
            let doStub: DurableObjectStub | null = null;
            if (['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'].includes(path)) {
			    const doNamespace = env.SYNC_COORDINATOR_DO;
			    // 使用固定的名字获取单例 DO 的 ID
			    const doId = doNamespace.idFromName("sync-coordinator-singleton"); 
			    // 获取 DO 实例的 Stub
			    doStub = doNamespace.get(doId);
            }

			// --- 路由：根据路径将请求转发给 DO 或直接处理 ---
			if (doStub) { // 如果路径需要与 DO 交互
                let doPath = '';
                let internalMethod = request.method; // 默认使用原始请求方法

                // 映射 API 路径到 DO 内部处理路径
                if (path === '/start-sync') doPath = '/start';
                else if (path === '/stop-sync') doPath = '/stop';
                else if (path === '/sync-status') doPath = '/status'; // GET
                else if (path === '/report-sync-page') doPath = '/report'; // POST
                else if (path === '/reset-sync-do') doPath = '/reset'; // POST

                 // 检查方法是否匹配 (基本检查)
                 const requiresPost = ['/start', '/stop', '/report', '/reset'].includes(doPath);
                 const requiresGet = ['/status'].includes(doPath);

                 if ((requiresPost && request.method !== 'POST') || (requiresGet && request.method !== 'GET')) {
                     response = new Response(`Method Not Allowed (${request.method} for ${path})`, { status: 405 });
                 } else {
                     console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`);
                     
                     // 创建转发给 DO 的请求
                     // 注意：对于需要传递 Body 的 POST 请求 (如 /report)，需要克隆 Body
                     let doRequestInit: RequestInit = { method: internalMethod };
                     if (request.body && (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH')) {
                         doRequestInit.headers = request.headers; // 传递原始 Headers
                         doRequestInit.body = await request.clone().blob(); // 克隆请求体
                     }
                     let doRequest = new Request(`https://do-internal${doPath}`, doRequestInit); 

                     // 调用 DO 的 fetch 方法并等待响应
                     response = await doStub.fetch(doRequest);
                     // 需要克隆响应才能修改 Headers (添加 CORS)
                     response = new Response(response.body, response); 
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

            // 为所有来自此 Worker 的响应添加 CORS 头
            addCorsHeaders(response);
            return response;

		} catch (error: any) {
			// --- 通用错误处理 ---
			console.error(`[API Worker] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
			addCorsHeaders(response); // 错误响应也添加 CORS
            return response;
		}
	},
};