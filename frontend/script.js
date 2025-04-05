// ~/imgN/frontend/script.js (Nginx 表格风格, 10 条/页, 指定列)

// --- 配置 (保持不变) ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10; // <-- 确认是 10 ***
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev'; // 你的 R2 URL

// --- DOM 元素获取 ---
const imageTableBody = document.getElementById('image-table-body'); // <-- 获取 tbody
const startButton = document.getElementById('startButton'); /* ... etc ... */
const stopButton = document.getElementById('stopButton');
const statusDisplay = document.getElementById('statusDisplay');
const actionMessage = document.getElementById('actionMessage');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const pageInfo = document.getElementById('pageInfo');
const prevButtonBottom = document.getElementById('prevButtonBottom');
const nextButtonBottom = document.getElementById('nextButtonBottom');
const pageInfoBottom = document.getElementById('pageInfoBottom');

// --- 状态变量 (保持不变) ---
let statusIntervalId = null; let currentPage = 1; let totalPages = 1; let totalImages = 0; let isLoadingImages = false;

// --- R2 Key 处理辅助函数 (保持不变) ---
function sanitizeForR2KeyJs(tagName) { if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 (保持不变) ---
function showActionMessage(message, isError = false) { /* ... */ }
async function handleSyncAction(url, button) { /* ... */ }
async function fetchStatus() { /* ... */ }

/** *** 修改：创建表格行，按新列顺序填充数据 *** */
function createImageInfoRow(imageData) {
    const tr = document.createElement('tr');
    const photoId = imageData.id || '-';

    // --- 准备各列数据 ---

    // 1. 图片 ID (链接)
    let idLink = photoId; // 默认只显示 ID
    if (photoId !== '-' && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        const r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        // 让 ID 链接到 R2 图片地址
        idLink = `<a href="${r2ImageUrl}" target="_blank" title="查看 R2 图片">${photoId}</a>`;
    }

    // 2. 大小 (基本不可用)
    const displaySize = '-'; // 因为 file_size 字段通常为 NULL

    // 3. 分辨率
    const displayResolution = imageData.resolution || '-';

    // 4. 拍摄地点 (解析 JSON)
    let locationDisplay = '-';
    if (imageData.location_details) {
        try {
            const loc = JSON.parse(imageData.location_details);
            // 优先显示 city, country，然后是 name
            locationDisplay = [loc?.city, loc?.country].filter(Boolean).join(', ') || loc?.name || '-';
            if (locationDisplay.length > 50) locationDisplay = locationDisplay.substring(0, 50) + '...'; // 简单截断
        } catch (e) { console.error("解析地点 JSON 失败:", imageData.location_details, e); }
    }

    // 5. 拍摄/更新时间 (格式化)
    // 优先用创建时间 created_at_api 代表拍摄时间，其次用更新时间
    const timeStr = imageData.created_at_api || imageData.updated_at_api;
    let displayTime = '-';
    if (timeStr) {
        try {
            displayTime = new Date(timeStr).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) { console.error("格式化时间失败:", timeStr, e); }
    }

    // 6. Tags (解析 JSON 数组，空格分隔)
    let tagsDisplay = '-';
    if (imageData.tags_data) {
        try {
            const tagsArray = JSON.parse(imageData.tags_data); // 预期是 ["tag1", "tag2"]
            if (Array.isArray(tagsArray) && tagsArray.length > 0) {
                tagsDisplay = tagsArray.join(' '); // 用空格分隔
            }
        } catch (e) { console.error("解析 Tags JSON 失败:", imageData.tags_data, e); }
    }

    // 7. 描述
    let description = imageData.description || imageData.alt_description || '-';
    // 可以选择截断描述长度
    // if (description.length > 100) description = description.substring(0, 100) + '...'; 

    // 构建表格行内容 (按新顺序)
    tr.innerHTML = `
        <td>${idLink}</td>
        <td>${displaySize}</td>
        <td>${displayResolution}</td>
        <td>${locationDisplay}</td>
        <td>${displayTime}</td> 
        <td>${tagsDisplay}</td>
        <td>${description}</td>
    `;
    return tr;
}

/** *** 修改：加载并显示图片信息到表格 (内部逻辑不变，确保调用 createImageInfoRow) *** */
async function loadImages(page = 1) {
    if (!imageTableBody || isLoadingImages) { if (!imageTableBody) console.error("无法找到 #image-table-body 元素!"); return; }
    isLoadingImages = true;
    imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">正在加载信息...</td></tr>`; // 更新 colspan 为 7
    updatePaginationUI();
    currentPage = page;
    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`; // 使用常量 10
        console.log(`从 API 获取图片信息: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData);

        if (jsonData.success && jsonData.data?.images) {
            imageTableBody.innerHTML = '';
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const images = jsonData.data.images;
            if (images.length > 0) {
                console.log(`[loadImages] 准备渲染 ${images.length} 行数据...`);
                images.forEach((image, index) => {
                    console.log(`[loadImages] 处理索引 ${index}, ID: ${image?.id}`);
                    const tableRow = createImageInfoRow(image); // <-- 调用创建表格行函数
                    if (tableRow) { imageTableBody.appendChild(tableRow); }
                    else { console.warn(`[loadImages] 未能为图片 ID 创建表格行: ${image?.id}`); }
                });
            } else {
                const emptyMsg = (currentPage === 1) ? '数据库中还没有图片信息。请尝试启动同步。' : '当前页没有图片信息。';
                imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">${emptyMsg}</td></tr>`; // 更新 colspan
            }
            updatePaginationUI();
        } else { throw new Error(jsonData.message || '加载信息失败。'); }
    } catch (error) {
        console.error('[loadImages] 加载信息过程中出错:', error);
        if (imageTableBody) { imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color: red;">加载信息出错: ${error.message}</td></tr>`; } // 更新 colspan
        totalPages = currentPage;
        updatePaginationUI();
    } finally { isLoadingImages = false; updatePaginationUI(); console.log("[loadImages] 加载流程结束."); }
}

// 更新分页 UI (中文, 总记录数)
function updatePaginationUI() { const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 条记录)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageTableBody || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM elements missing!"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }