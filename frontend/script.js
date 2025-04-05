// ~/imgN/frontend/script.js (版本：10 张/页, Card 布局, R2 URL, 按钮, 状态, 分页)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000; // 状态轮询间隔 (毫秒)
const IMAGES_PER_PAGE = 10; // <-- 每页 10 张 ***

// R2 公开 URL (!!! 需要你填入正确的 !!!)
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev';

// --- DOM 元素获取 ---
const imageGrid = document.getElementById('image-grid'); // <-- 获取网格 div
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusDisplay = document.getElementById('statusDisplay');
const actionMessage = document.getElementById('actionMessage');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const pageInfo = document.getElementById('pageInfo');
const prevButtonBottom = document.getElementById('prevButtonBottom');
const nextButtonBottom = document.getElementById('nextButtonBottom');
const pageInfoBottom = document.getElementById('pageInfoBottom');

// --- 状态变量 ---
let statusIntervalId = null;
let currentPage = 1;
let totalPages = 1;
let totalImages = 0;
let isLoadingImages = false;

// --- R2 Key 处理辅助函数 ---
/** 清理 Tag 标题用于 R2 Key */
function sanitizeForR2KeyJs(tagName) {
    if (!tagName) return '';
    const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50);
    if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; }
    return sanitized;
}
/** 从 tags_data JSON 字符串获取 R2 文件夹名 */
function getFolderNameFromTagsJs(tagsData) {
    const defaultFolder = 'uncategorized';
    let tags = [];
    if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } }
    if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; }
    for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } }
    return defaultFolder;
}

// --- 其他辅助函数 ---

/** 显示操作反馈信息 */
function showActionMessage(message, isError = false) {
    if (!actionMessage) return;
    actionMessage.textContent = message;
    actionMessage.className = isError ? 'action-message error' : 'action-message';
    setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000);
}

/** 处理点击 "Start/Stop" 按钮 (包含修正后的禁用逻辑) */
async function handleSyncAction(url, button) {
    if (!button || button.disabled) return;

    const originalText = button.textContent;
    button.disabled = true; // 只禁用当前点击的按钮
    button.textContent = '处理中...';

    showActionMessage('正在发送请求...', false);
    try {
        const response = await fetch(url, { method: 'POST' });
        let result = { success: response.ok, message: response.statusText };
        try { result = await response.json(); } catch (e) { /* Ignore if not JSON */ }

        if (response.ok && result.success !== false) {
            showActionMessage(result.message || '操作成功！', false);
            setTimeout(fetchStatus, 100); // 稍等后刷新状态
        } else { throw new Error(result.message || `请求失败: ${response.status}`); }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message}`, true);
        fetchStatus(); // 出错时也尝试刷新状态
    } finally {
        button.textContent = originalText; // 恢复文本 (是否可用由 fetchStatus 决定)
        // 不再在这里强制 button.disabled = false;
    }
}

/** 获取并显示同步状态 (包含修正后的按钮禁用逻辑) */
async function fetchStatus() {
    if (!statusDisplay) return;
    let currentStatus = 'unknown';

    try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) throw new Error(`HTTP 错误! 状态: ${response.status}`);
        const result = await response.json();
        if (result.success && result.data) {
            currentStatus = result.data.status || 'unknown';
            const page = result.data.lastProcessedPage || 0;
            const lastError = result.data.lastError;
            let statusText = `状态: ${currentStatus} (上次处理页: ${page})`;
            if (currentStatus === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; }
            statusDisplay.textContent = statusText;
        } else { throw new Error(result.message || '无法获取状态'); }
    } catch (error) {
        console.error('获取状态时出错:', error);
        statusDisplay.textContent = `状态: 获取错误`;
        // *** 获取状态出错时，启用按钮允许重试 ***
        if (startButton) startButton.disabled = false;
        if (stopButton) stopButton.disabled = false;
        return; // 提前返回
    }

    // *** 根据获取到的真实状态控制按钮 ***
    const isRunning = (currentStatus === 'running');
    const isStopping = (currentStatus === 'stopping');
    if (startButton) startButton.disabled = isRunning || isStopping; // 运行时或停止中不能开始
    if (stopButton) stopButton.disabled = !isRunning; // 只有运行时才能停止
}

/** 创建图片卡片 Div (使用 R2 URL) */
function createImageCard(imageData) {
    const card = document.createElement('div');
    card.classList.add('image-card');
    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '<i>无描述</i>';
    let r2ImageUrl = null;
    const photoId = imageData.id;
    let originalLink = '#'; // 链接到 Unsplash 页面

    // 解析 JSON 数据
    try {
        if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; }
        if (imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || '#'; }
    } catch (e) { console.error("解析 JSON 时出错:", e, imageData); }

    // 构造 R2 URL
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        if (originalLink === '#') { originalLink = r2ImageUrl; }
    } else {
        // 增加对 R2_PUBLIC_URL_BASE 未配置的警告
        if (!R2_PUBLIC_URL_BASE || R2_PUBLIC_URL_BASE === 'https://<你的R2公共URL>') {
            console.warn("R2_PUBLIC_URL_BASE 未配置或未修改! 无法生成 R2 URL。");
        } else {
            console.warn("无法构造 R2 URL，缺少 photoId:", photoId);
        }
        return null; // 无法构造 URL 则返回 null
    }

    // 如果 R2 URL 无效
    if (!r2ImageUrl) { return null; }

    // 构建卡片内容
    card.innerHTML = `
		<a href="${originalLink}" target="_blank" rel="noopener noreferrer" title="查看来源或图片"> 
			<img src="${r2ImageUrl}" alt="${imageData.alt_description || imageData.description || 'Image from R2'}" loading="lazy" onerror="this.parentElement.parentElement.style.display='none'; console.error('图片加载失败:', this.src)"> 
            </a>
		<div class="image-info">
			<p class="description">${description}</p>
			<p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">点赞: ${imageData.likes || 0}</p>
		</div>
	`;
    return card; // <-- 返回 div 卡片
}

/** 加载并显示图片到网格 Div (使用常量 IMAGES_PER_PAGE=10) */
async function loadImages(page = 1) {
    if (!imageGrid || isLoadingImages) {
        if (!imageGrid) console.error("无法找到 #image-grid 元素!");
        return;
    }

    isLoadingImages = true;
    imageGrid.innerHTML = '<p>正在加载图片...</p>';
    updatePaginationUI(); // 禁用分页按钮

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`; // <-- 使用常量 10
        console.log(`从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData); // <--- 保留这个日志，用于确认数据

        if (jsonData.success && jsonData.data?.images) {
            imageGrid.innerHTML = '';
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const imagesToRender = jsonData.data.images;

            if (imagesToRender && imagesToRender.length > 0) {
                console.log(`[loadImages] 准备渲染 ${imagesToRender.length} 张图片...`);
                imagesToRender.forEach((image, index) => {
                    console.log(`[loadImages] 处理图片索引 ${index}, ID: ${image?.id}`);
                    const card = createImageCard(image);
                    if (card) {
                        imageGrid.appendChild(card);
                        console.log(`[loadImages] 已添加卡片 ID: ${image?.id}`);
                    } else {
                        console.warn(`[loadImages] 未能为图片 ID 创建卡片: ${image?.id}`);
                    }
                });
            } else { // 处理无图片情况
                const emptyMsg = (currentPage === 1) ? '图库中还没有图片。请尝试启动同步。' : '当前页没有图片。';
                imageGrid.innerHTML = `<p style="text-align:center;">${emptyMsg}</p>`;
            }
            updatePaginationUI();

        } else {
            console.error("[loadImages] API 返回成功但数据结构不正确或无图片:", jsonData);
            throw new Error(jsonData.message || '加载图片失败 (API 数据问题)。');
        }

    } catch (error) {
        console.error('[loadImages] 加载图片过程中出错:', error);
        if (imageGrid) { imageGrid.innerHTML = `<p style="color: red; text-align:center;">加载图片出错: ${error.message}</p>`; }
        totalPages = currentPage;
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
        updatePaginationUI(); // 确保最终更新按钮状态
        console.log("[loadImages] 加载流程结束.");
    }
}

// 更新分页 UI (中文, 总记录数)
function updatePaginationUI() { const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 条记录)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageGrid || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM 元素缺失，初始化失败！"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }