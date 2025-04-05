import { IRequest } from 'itty-router';
import { ExecutionContext, DurableObjectState, Queue } from '@cloudflare/workers-types';

// 队列消息载荷类型
export interface QueueMessagePayload {
    page: number;
    retryCount?: number;
    lastError?: string;
    timestamp?: number;
}

// 扩展请求类型
export interface ExtendedRequest extends IRequest {
    query: { [key: string]: string | undefined };
}

// API 错误类型
export class APIError extends Error {
    constructor(
        message: string,
        public status: number = 500,
        public code?: string
    ) {
        super(message);
        this.name = 'APIError';
    }
}

// 同步状态类型
export interface SyncState {
    syncStatus: 'idle' | 'running' | 'stopping' | 'error';
    lastProcessedPage: number;
    totalPages?: number;
    lastRunStart?: string;
    lastError?: string;
}

// 数据库模型类型
export interface ImageMetadata {
    id: string;
    created_at_api: string;
    updated_at_api: string;
    width: number;
    height: number;
    color: string;
    blur_hash: string;
    downloads?: number;
    likes?: number;
    description?: string | null;
    alt_description?: string | null;
    urls: {
        raw: string;
        full: string;
        regular: string;
        small: string;
        thumb: string;
    };
    user: {
        id: string;
        username: string;
        name: string;
    };
    location?: {
        city?: string;
        country?: string;
        position?: {
            latitude?: number;
            longitude?: number;
        };
    };
    exif?: {
        make?: string;
        model?: string;
        exposure_time?: string;
        aperture?: string;
        focal_length?: string;
        iso?: number;
    };
}

// DO 请求配置类型
export interface DORequestInit extends RequestInit {
    method: string;
    headers: Headers;
    body?: BodyInit | null;
}

// 类型守卫
export function isSyncState(obj: unknown): obj is SyncState {
    return obj !== null 
        && typeof obj === 'object'
        && 'syncStatus' in obj
        && typeof (obj as SyncState).lastProcessedPage === 'number';
}

// 运行时类型检查
export function validateImageMetadata(data: unknown): asserts data is ImageMetadata {
    if (!data || typeof data !== 'object') {
        throw new APIError('Invalid image metadata', 400);
    }
    const img = data as Partial<ImageMetadata>;
    if (!img.id || typeof img.id !== 'string') {
        throw new APIError('Missing or invalid image id', 400);
    }
    if (!img.urls || typeof img.urls !== 'object') {
        throw new APIError('Missing or invalid image URLs', 400);
    }
    // 其他必要的验证...
} 