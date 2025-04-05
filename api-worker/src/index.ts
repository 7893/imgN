// ~/imgN/api-worker/src/index.ts (修正 DO fetch 调用)
import { ExecutionContext, DurableObjectStub, RequestInit } from '@cloudflare/workers-types';
// Request, Response, Headers 使用全局类型
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types';

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

// --- Worker 主逻辑 ---
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        const url = new URL(request.url);
        const path = url.pathname;
        console.log(`[API Worker Entry] Request: ${request.method} ${path}`);
        let response: Response;

        try {
            const doPaths = ['/start-sync', '/stop-sync', '/sync-status', '/report-sync-page', '/reset-sync-do'];
            const requiresDo = doPaths.includes(path);
            let doStub: DurableObjectStub | null = null;
            
            if (requiresDo) {
                const doNamespace = env.SYNC_COORDINATOR_DO;
                const doId = doNamespace.idFromName('sync-coordinator-singleton');
                doStub = doNamespace.get(doId);
            }

            if (requiresDo && doStub) {
                let doPath = '';
                let isPostRequired = false;
                let isGetRequired = false;

                if (path === '/start-sync') {
                    doPath = '/start';
                    isPostRequired = true;
                } else if (path === '/stop-sync') {
                    doPath = '/stop';
                    isPostRequired = true;
                } else if (path === '/sync-status') {
                    doPath = '/status';
                    isGetRequired = true;
                } else if (path === '/report-sync-page') {
                    doPath = '/report';
                    isPostRequired = true;
                } else if (path === '/reset-sync-do') {
                    doPath = '/reset';
                    isPostRequired = true;
                }

                if (!doPath) {
                    response = new Response('Internal Routing Error', { status: 500 });
                } else if ((isPostRequired && request.method !== 'POST') || (isGetRequired && request.method !== 'GET')) {
                    response = new Response('Method Not Allowed', { status: 405 });
                } else {
                    console.log(`[API Worker] Forwarding ${request.method} ${path} to DO ${doPath}...`);
                    const doUrl = new URL(request.url);
                    doUrl.pathname = doPath;

                    const doRequestInit: RequestInit = {
                        method: request.method,
                        headers: request.headers,
                    };

                    if (request.body && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
                        doRequestInit.body = request.clone().body;
                    }

                    response = await doStub.fetch(doUrl.toString(), doRequestInit);
                    console.log(`[API Worker] DO response status: ${response.status}`);
                }
            } else if (path === '/images' && request.method === 'GET') {
                response = new Response(JSON.stringify({ message: "Images endpoint placeholder" }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } else if (path === '/' || path === '/health') {
                response = new Response(JSON.stringify({ status: 'healthy' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } else {
                response = new Response('Not Found', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain' }
                });
            }

            return addCorsHeaders(response);
        } catch (error: unknown) {
            console.error(`[API Worker] Error:`, error);
            response = new Response(
                JSON.stringify({ success: false, error: 'Internal Server Error' }),
                {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            return addCorsHeaders(response);
        }
    },
};