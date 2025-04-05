// ~/imgN/api-worker/src/index.ts (使用 itty-router 重构)
import { ExecutionContext } from '@cloudflare/workers-types';
import { Router, IRequest, StatusError } from 'itty-router'; // 导入 itty-router
import { SyncCoordinatorDO } from './sync-coordinator-do'; 
import { Env } from './types'; 
// 导入路由处理函数
import { 
    handleStartSync, 
    handleStopSync, 
    handleStatus, 
    handleReport, 
    handleReset, 
    handleHealth, 
    handleGetImages 
} from './routes';

// 导出 DO 类
export { SyncCoordinatorDO };

// --- CORS 处理 ---
// (addCorsHeaders 和 handleOptions 函数保持不变，需要放在这里或导入)
const corsHeaders = { /* ... */ };
function addCorsHeaders(response: Response): Response { /* ... */ const newHeaders = new Headers(response.headers); Object.entries(corsHeaders).forEach(([key, value]) => { newHeaders.set(key, value); }); return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders }); }
function handleOptions(request: Request): Response { /* ... */ if (request.headers.get('Origin') !== null && request.headers.get('Access-Control-Request-Method') !== null && request.headers.get('Access-Control-Request-Headers') !== null) { return new Response(null, { headers: corsHeaders }); } else { return new Response(null, { headers: { Allow: 'GET, POST, OPTIONS' } }); } }


// --- 创建和配置 Router ---
const router = Router();

// CORS Preflight handler for all routes
router.options('*', handleOptions);

// API Routes
router.post('/start-sync', handleStartSync);
router.post('/stop-sync', handleStopSync);
router.get('/sync-status', handleStatus);
router.post('/report-sync-page', handleReport);
router.post('/reset-sync-do', handleReset);
router.get('/images', handleGetImages);
router.get('/health', handleHealth);
router.get('/', handleHealth); 

// 404 Handler
router.all('*', () => new Response(JSON.stringify({ success: false, error: 'Not Found' }), { 
    status: 404, 
    headers: { 'Content-Type': 'application/json' }
}));

// --- Worker 入口 ---
export default {
	/**
	 * 使用 itty-router 处理所有请求
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        let response: Response;
        try {
            // 将请求、环境和上下文传递给 router 处理
		    response = await router.handle(request, env, ctx);
        } catch (error: any) {
             // --- 通用错误处理 ---
			console.error(`[API Worker] 未捕获的错误:`, error); 
            const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
            const errorStatus = error instanceof StatusError ? error.status : 500; // 使用 itty-router 的 StatusError
			response = new Response(JSON.stringify({ success: false, error: 'Internal Server Error', message: errorMessage }), {
				status: errorStatus,
				headers: { 'Content-Type': 'application/json' },
			});
        }
        // 确保为所有响应（包括路由产生的和错误产生的）添加 CORS 头
        return addCorsHeaders(response); 
	},
};
