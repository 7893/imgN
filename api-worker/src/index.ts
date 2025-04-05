// ~/imgN/api-worker/src/index.ts
import { Router } from 'itty-router';
import { ExecutionContext } from '@cloudflare/workers-types';
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types';
import {
    handleStartSync,
    handleStopSync,
    handleStatus,
    handleReport,
    handleReset,
    handleGetImages,
    handleHealth
} from './routes';

export { SyncCoordinatorDO };

// --- CORS 处理 ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

function handleOptions(request: Request): Response {
    return new Response(null, {
        headers: {
            ...corsHeaders,
            'Allow': 'GET, POST, PUT, DELETE, OPTIONS',
        }
    });
}

// --- 创建路由器 ---
const router = Router();

// --- 配置路由 ---
router
    .options('*', handleOptions)
    .get('/images', handleGetImages)
    .get('/sync-status', handleStatus)
    .post('/start-sync', handleStartSync)
    .post('/stop-sync', handleStopSync)
    .post('/report-sync-page', handleReport)
    .post('/reset-sync-do', handleReset)
    .get('/', handleHealth)
    .get('/health', handleHealth);

// --- Worker 主逻辑 ---
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            // 处理请求
            const response = await router.handle(request, env, ctx);
            // 添加 CORS 头
            return addCorsHeaders(response);
        } catch (error: unknown) {
            console.error(`[API Worker] Error:`, error);
            const response = new Response(
                JSON.stringify({ 
                    success: false, 
                    error: error instanceof Error ? error.message : 'Internal Server Error' 
                }),
                {
                    status: error instanceof Error ? (error as any).status || 500 : 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            return addCorsHeaders(response);
        }
    },
};