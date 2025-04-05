// ~/imgN/api-worker/src/index.ts
import { Router } from 'itty-router';
import { ExecutionContext } from '@cloudflare/workers-types';
import { SyncCoordinatorDO } from './sync-coordinator-do';
import { Env } from './types'; // Assuming this Env includes SYNC_COORDINATOR_DO, DB, KV_CACHE
import {
    handleStartSync,
    handleStopSync,
    handleStatus,
    handleReport,
    handleReset,
    handleGetImages,
    handleHealth
} from './routes'; // Make sure routes.ts exports are correct

export { SyncCoordinatorDO }; // Export the DO class for wrangler.toml

// --- CORS 处理 ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Adjust for production
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Add other headers if needed
};

// TS2355 reported around here (line 15/16), but the function looks correct. Check local code.
function addCorsHeaders(response: Response): Response {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => { // Line 15 starts here
        newHeaders.set(key, value);                        // Line 16
    });
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

function handleOptions(request: Request): Response {
    // Handle CORS preflight requests.
    if (
        request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null
    ) {
        return new Response(null, {
            headers: {
                ...corsHeaders,
                // Allow all headers specified in the request Access-Control-Request-Headers
                'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? '',
            }
        });
    } else {
        // Handle standard OPTIONS request.
        return new Response(null, {
            headers: {
                Allow: 'GET, POST, PUT, DELETE, OPTIONS',
            },
        });
    }
}

// --- 创建路由器 ---
const router = Router();

// --- 配置路由 (Using improved handlers from corrected routes.ts) ---
router
    .options('*', handleOptions) // Handle OPTIONS for all routes
    .get('/images', handleGetImages)
    .get('/sync-status', handleStatus)
    .post('/start-sync', handleStartSync)
    .post('/stop-sync', handleStopSync)
    .post('/report-sync-page', handleReport) // Endpoint for sync-worker callback
    .post('/reset-sync-do', handleReset)
    .get('/', handleHealth) // Root health check
    .get('/health', handleHealth) // Explicit health check endpoint
    // Catch-all for 404s
    .all('*', () => new Response('Not Found', { status: 404 }));

// --- Worker 主逻辑 ---
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        let response: Response;
        try {
            // Handle request using the router
            response = await router.handle(request, env, ctx);
        } catch (error: unknown) {
            console.error(`[API Worker] Error handling request ${request.method} ${request.url}:`, error);

            // Determine status code and message
            let statusCode = 500;
            let errorMessage = 'Internal Server Error';

            if (error instanceof Error) {
                errorMessage = error.message;
                // Check if it's a StatusError from itty-router or our custom errors
                if ('status' in error && typeof error.status === 'number') {
                    statusCode = error.status;
                }
            } else {
                errorMessage = String(error);
            }

            // Create a JSON error response
            response = new Response(
                JSON.stringify({
                    success: false,
                    error: errorMessage
                }),
                {
                    status: statusCode,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }
        // Apply CORS headers to all responses (success or error)
        return addCorsHeaders(response);
    },
};