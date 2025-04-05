// ~/imgN/frontend/script.js (更新为 10 张/页, Card 布局)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10; // <--- 修改为 10 ***

// R2 公开 URL (需要你填入正确的)
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev';

// --- DOM 元素获取 ---
const imageGrid = document.getElementById('image-grid'); // <--- 改回获取 div
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
function sanitizeForR2KeyJs(tagName) { /* ... */ }
function getFolderNameFromTagsJs(tagsData) { /* ... */ }

// --- 其他辅助函数 ---
function showActionMessage(message, isError = false) { /* ... (保持不变) ... */ }
async function handleSyncAction(url, button) { /* ... (保持不变) ... */ }
async function fetchStatus() { /* ... (保持不变) ... */ }

/** *** 修改：改回创建图片卡片 (Card Div) *** */
function createImageCard(imageData) {
    const card = document.createElement('div'); // <-- 创建 div
    card.classList.add('image-card');
    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '<i>无描述</i>';
    let r2ImageUrl = null;
    const photoId = imageData.id;
    let originalLink = '#';

    // 解析 JSON 数据
    try {
        if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; }
        if (imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || originalLink; }
    } catch (e) { console.error("解析 JSON 时出错:", e, imageData); }

    // 构造 R2 URL
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        if (originalLink === '#') { originalLink = r2ImageUrl; } // 如果没有 Unsplash 链接，点击打开 R2 图
    } else { console.warn("无法构造 R2 URL:", photoId); return null; }

    // --- 构建卡片内容 (使用 R2 URL) ---
    card.innerHTML = `
		<a href="${originalLink}" target="_blank" rel="noopener noreferrer" title="查看原图或来源"> 
			<img src="${r2ImageUrl}" alt="${imageData.alt_description || imageData.description || 'Image from R2'}" loading="lazy">
		</a>
		<div class="image-info">
			<p class="description">${description}</p>
			<p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">点赞: ${imageData.likes || 0}</p>
		</div>
	`;
    return card; // <-- 返回 div 卡片
}

console.log(`[Card for ${photoId}] Tags Data: ${imageData.tags_data}, Folder: ${folderName}, Key: ${r2Key}, Final R2 URL: ${r2ImageUrl}`);

/** *** 修改：加载并显示图片到网格 Div *** */
async function loadImages(page = 1) {
    if (!imageGrid || isLoadingImages) { // <-- 检查 imageGrid
        if (!imageGrid) console.error("无法找到 #image-grid 元素!");
        return;
    }

    isLoadingImages = true;
    imageGrid.innerHTML = '<p>正在加载图片...</p>'; // <-- 设置加载提示
    updatePaginationUI();

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`; // <-- 使用新的 PerPage
        console.log(`从 API 获取图片: ${url}`);
        const response = await fetch(url);
        if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); }
        const jsonData = await response.json();
        console.log("接收到图片数据:", jsonData);

        console.log("API Response Data:", jsonData); // 打印完整的 API 响应数据
        const imagesToRender = jsonData.data?.images;
        if (!imagesToRender) {
            console.error("Images array is missing in API response data!");
        }

        if (jsonData.success && jsonData.data?.images) {
            imageGrid.innerHTML = ''; // <-- 清空加载提示
            totalImages = jsonData.data.totalImages || 0;
            totalPages = jsonData.data.totalPages || 1;
            const images = jsonData.data.images;

            if (images.length > 0) {
                images.forEach(image => {
                    const card = createImageCard(image); // <-- 调用创建卡片函数
                    if (card) { imageGrid.appendChild(card); } // <-- 添加卡片到 Grid Div
                });
            } else { // 处理无图片情况
                const emptyMsg = (currentPage === 1) ? '图库中还没有图片。请尝试启动同步。' : '当前页没有图片。';
                imageGrid.innerHTML = `<p style="text-align:center;">${emptyMsg}</p>`;
            }
            updatePaginationUI();

        } else { throw new Error(jsonData.message || '加载图片失败。'); }

    } catch (error) { // ... (错误处理保持不变) ...
        console.error('加载图片时出错:', error); if (imageGrid) { imageGrid.innerHTML = `<p style="color: red; text-align:center;">加载图片出错: ${error.message}</p>`; } totalPages = currentPage; updatePaginationUI();
    } finally { isLoadingImages = false; updatePaginationUI(); }
}

// 更新分页 UI (保持不变)
function updatePaginationUI() { const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 张图片)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageGrid || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM elements missing!"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }