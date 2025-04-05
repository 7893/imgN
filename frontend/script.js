// ~/imgN/frontend/script.js (更新为表格渲染, 中文 UI)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 5; // <-- 修改为 5 ***

// R2 公开 URL (!!! 需要你填入 !!!)
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev';

// --- DOM 元素获取 ---
const imageTableBody = document.getElementById('image-table-body'); // <-- 改为获取 table body
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

// --- R2 Key 处理辅助函数 (保持不变) ---
function sanitizeForR2KeyJs(tagName) { if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 ---

/** 显示操作反馈信息 */
function showActionMessage(message, isError = false) {
    if (!actionMessage) return;
    actionMessage.textContent = message;
    actionMessage.className = isError ? 'action-message error' : 'action-message';
    setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000);
}

/** 处理点击 "Start/Stop" 按钮 */
async function handleSyncAction(url, button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    const otherButton = (button === startButton) ? stopButton : startButton;
    if (otherButton) otherButton.disabled = true;

    showActionMessage('正在发送请求...', false); // 中文提示
    try {
        const response = await fetch(url, { method: 'POST' });
        let result = { success: response.ok, message: response.statusText };
        try { result = await response.json(); } catch (e) { /* Ignore */ }

        if (response.ok && result.success) {
            showActionMessage(result.message || '操作成功！', false); // 中文提示
            setTimeout(fetchStatus, 500); // 稍等后刷新状态
        } else { throw new Error(result.message || `请求失败: ${response.status}`); }
    } catch (error) {
        console.error('执行同步操作时出错:', url, error);
        showActionMessage(`错误: ${error.message}`, true); // 中文提示
        fetchStatus(); // 出错时也刷新状态
    }
}

/** 获取并显示同步状态 */
async function fetchStatus() {
    if (!statusDisplay) return;
    try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) throw new Error(`HTTP 错误! 状态: ${response.status}`);
        const result = await response.json();
        if (result.success && result.data) {
            const status = result.data.status || '未知'; // 中文默认值
            const page = result.data.lastProcessedPage || 0;
            const lastError = result.data.lastError;
            let statusText = `状态: ${status} (上次处理页: ${page})`; // 中文状态
            if (status === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; }
            statusDisplay.textContent = statusText;

            const isRunning = (status === 'running');
            const isStopping = (status === 'stopping');
            if (startButton) startButton.disabled = isRunning || isStopping;
            if (stopButton) stopButton.disabled = !isRunning;

        } else { throw new Error(result.message || '无法获取状态'); }
    } catch (error) {
        console.error('获取状态时出错:', error);
        statusDisplay.textContent = `状态: 获取错误`;
        if (startButton) startButton.disabled = true; // 出错时禁用按钮
        if (stopButton) stopButton.disabled = true;
    }
}

/** *** 修改：创建图片表格行 (TableRow) *** */
function createImageTableRow(imageData) {
    const tr = document.createElement('tr'); // 创建 <tr> 元素

    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '-'; // 默认用 -
    let r2ImageUrl = null;
    let r2ThumbnailUrl = null; // 使用 R2 的小图或缩略图作为预览
    const photoId = imageData.id;
    let originalLink = '#'; // 图片点击链接

    // 解析 JSON 数据
    try {
        if (imageData.author_details) {
            const author = JSON.parse(imageData.author_details);
            authorName = author?.name || authorName;
            authorLink = author?.links?.html || authorLink;
        }
        if (imageData.photo_links) {
            const links = JSON.parse(imageData.photo_links);
            originalLink = links?.html || originalLink; // 优先 Unsplash 页面链接
        }
    } catch (e) { console.error("解析 JSON 时出错:", e, imageData); }

    // 构造 R2 URL (使用 R2 公开 URL 和计算出的 Key)
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        r2ThumbnailUrl = r2ImageUrl; // 简单起见，预览和链接用同一个 R2 URL (因为我们存的就是 small)
        if (!originalLink || originalLink === '#') {
            originalLink = r2ImageUrl; // 如果没有 Unsplash 链接，点击也打开 R2 图片
        }
    } else {
        console.warn("无法构造 R2 URL 或 R2_PUBLIC_URL_BASE 未配置:", photoId);
        return null; // 如果没有 R2 URL，则不创建行
    }

    // 创建并填充单元格 (td)
    tr.innerHTML = `
        <td>
            <a href="${originalLink}" target="_blank" rel="noopener noreferrer">
                <img src="${r2ThumbnailUrl}" alt="预览" class="thumbnail" loading="lazy">
            </a>
        </td>
        <td>${description.substring(0, 100)}${description.length > 100 ? '...' : ''}</td> 
        <td><a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></td>
        <td>${imageData.width || '-'} x ${imageData.height || '-'}</td>
        <td>${imageData.likes || 0}</td>
        <td>${imageData.updated_at_api ? new Date(imageData.updated_at_api).toLocaleString('zh-CN') : '-'}</td> 
        <td>${imageData.slug || imageData.id}</td> 
    `;
    return tr;
}

/** *** 修改：加载并显示图片到表格 *** */
async function loadImages(page = 1) {
    if (!imageTableBody || isLoadingImages) {
        if (!imageTableBody) console.error("无法找到 #image-table-body 元素!");
        return;
    }

    isLoadingImages = true;
    imageTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px;">正在加载图片...</td></tr>`; // 表格的加载提示
    updatePaginationUI(); // 禁用按钮

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`;
        console.log(`从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData);

        if (jsonData.success && jsonData.data?.images) {
            imageTableBody.innerHTML = ''; // 清空加载提示
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const images = jsonData.data.images;

            if (images.length > 0) {
                images.forEach(image => {
                    const tableRow = createImageTableRow(image); // <-- 调用创建表格行函数
                    if (tableRow) { imageTableBody.appendChild(tableRow); } // <-- 添加行到 tbody
                });
            } else {
                const emptyMsg = (currentPage === 1) ? '图库中还没有图片。请尝试启动同步。' : '当前页没有图片。';
                imageTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px;">${emptyMsg}</td></tr>`;
            }
            updatePaginationUI();

        } else { throw new Error(jsonData.message || '加载图片失败。'); }

    } catch (error) {
        console.error('加载图片时出错:', error);
        if (imageTableBody) { imageTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: red;">加载图片出错: ${error.message}</td></tr>`; }
        totalPages = currentPage;
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
        updatePaginationUI(); // 确保按钮状态最终被正确设置
    }
}

/** 更新分页控件的 UI (使用中文) */
function updatePaginationUI() {
    // *** 修改：使用中文并显示总数 ***
    const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 张图片)`;
    if (pageInfo) pageInfo.textContent = pageInfoText;
    if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText;
    // *** 结束修改 ***

    const disablePrev = isLoadingImages || currentPage <= 1;
    const disableNext = isLoadingImages || currentPage >= totalPages;
    if (prevButton) prevButton.disabled = disablePrev;
    if (prevButtonBottom) prevButtonBottom.disabled = disablePrev;
    if (nextButton) nextButton.disabled = disableNext;
    if (nextButtonBottom) nextButtonBottom.disabled = disableNext;
}

// 处理点击上一页 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
// 处理点击下一页 (保持不变)
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() {
    // 增加对 Table Body 的检查
    if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageTableBody || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM elements missing!"); return; }
    startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage);
    loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动 (间隔: ${STATUS_POLL_INTERVAL}ms)`);
}

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }