// src/index.ts (api-worker)
import { ExecutionContext } from '@cloudflare/workers-types';
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
import { Env } from './types'; // 假设 Env 在 types.ts

// 导出 DO 类
export { SyncCoordinatorDO };

// --- CORS 处理 (保持不变) ---
const corsHeaders = { /* ... */ };
function addCorsHeaders(response: Response): Response { /* ... */ Object.entries(corsHeaders).forEach(([k,v]) => response.headers.set(k,v)); return response; }
function handleOptions(request: Request): Response { /* ... */ if (request.headers.get('Origin') !== null && request.headers.get('Access-Control-Request-Method') !== null && request.headers.get('Access-Control-Request-Headers') !== null) { return new Response(null, { headers: corsHeaders }); } else { return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } }); } }

// --- Worker 主逻辑 ---
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
            // --- 与 DO 交互的端点 ---
			if (path === '/start-sync' || path === '/stop-sync' || path === '/sync-status' || path === '/report-sync-page') {
                
                const doNamespace = env.SYNC_COORDINATOR_DO;
                const doId = doNamespace.idFromName("sync-coordinator-singleton"); 
                const doStub = doNamespace.get(doId);
                let doPath = '';
                let doMethod = request.method; // 默认继承原请求方法

                // 映射 API 路径到 DO 内部路径
                if (path === '/start-sync') doPath = '/start';
                else if (path === '/stop-sync') doPath = '/stop';
                else if (path === '/sync-status') doPath = '/status';
                else if (path === '/report-sync-page') doPath = '/report'; // 用于 sync-worker 回调

                if (!doPath) return addCorsHeaders(new Response('Not Found', { status: 404 })); // Should not happen

                // 检查方法是否匹配
                if ((doPath === '/start' || doPath === '/stop' || doPath === '/report') && request.method !== 'POST') {
                   return addCorsHeaders(new Response('Method Not Allowed (POST required)', { status: 405 })); 
                }
                 if (doPath === '/status' && request.method !== 'GET') {
                   return addCorsHeaders(new Response('Method Not Allowed (GET required)', { status: 405 })); 
                }

                console.log(`[API Worker] Forwarding ${request.method} ${path} to DO path ${doPath}...`);
                
                // 创建转发给 DO 的请求
                // 对于 POST，我们需要克隆请求体 (如果 sync-worker 回调时发送了 body)
                let doRequestInit: RequestInit = { method: doMethod, headers: request.headers };
                if (request.method === 'POST' && request.body) {
                    doRequestInit.body = await request.clone().blob(); // 克隆 body
                }
                let doRequest = new Request(`https://do-internal${doPath}`, doRequestInit); 

                // 调用 DO 并返回其响应
                let response = await doStub.fetch(doRequest);
                // 需要从 DO 的响应克隆并添加 CORS 头，因为 Response Headers 是不可变的
                response = new Response(response.body, response);
                addCorsHeaders(response);
                return response;

            } else if (path === '/' || path === '/health') {
                // 健康检查端点
                const html = `<!DOCTYPE html><body><h1>imgn-api-worker is running!</h1><p>Sync control endpoints: /start-sync (POST), /stop-sync (POST), /sync-status (GET)</p><p>Time: ${new Date().toISOString()}</p></body></html>`;
                const response = new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' }});
                return addCorsHeaders(response); 
            
            } else {
                // 404
                const response = new Response(JSON.stringify({ success: false, error: 'Not Found' }), { 
                    status: 404, 
                    headers: { 'Content-Type': 'application/json' }
                });
                return addCorsHeaders(response);
            }

		} catch (error) {
			// --- 通用错误处理 ---
			console.error(`[API Worker] Error processing request ${request.url}:`, error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			const response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
			return addCorsHeaders(response);
		}
	},
};
