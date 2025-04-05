// ~/imgN/frontend/script.js (更新为表格渲染, 10 张/页, 中文 UI)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`;
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000;
const IMAGES_PER_PAGE = 10; // <-- 修改为 10 ***
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev'; // 你的 R2 URL

// --- DOM 元素获取 ---
const imageTableBody = document.getElementById('image-table-body'); // <-- 获取 tbody
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
let statusIntervalId = null; let currentPage = 1; let totalPages = 1; let totalImages = 0; let isLoadingImages = false;

// --- R2 Key 处理辅助函数 ---
function sanitizeForR2KeyJs(tagName) { if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch (e) { console.error("解析 tags_data 失败:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 ---
function showActionMessage(message, isError = false) { if (!actionMessage) return; actionMessage.textContent = message; actionMessage.className = isError ? 'action-message error' : 'action-message'; setTimeout(() => { if (actionMessage.textContent === message) { actionMessage.textContent = ''; actionMessage.className = 'action-message'; } }, 4000); }
async function handleSyncAction(url, button) { if (!button || button.disabled) return; button.disabled = true; const otherButton = (button === startButton) ? stopButton : startButton; if (otherButton) otherButton.disabled = true; showActionMessage('正在发送请求...', false); try { const response = await fetch(url, { method: 'POST' }); let result = { success: response.ok, message: response.statusText }; try { result = await response.json(); } catch (e) { /* Ignore */ } if (response.ok && result.success) { showActionMessage(result.message || '操作成功！', false); setTimeout(fetchStatus, 500); } else { throw new Error(result.message || `请求失败: ${response.status}`); } } catch (error) { console.error('执行同步操作时出错:', url, error); showActionMessage(`错误: ${error.message}`, true); fetchStatus(); } }
async function fetchStatus() { if (!statusDisplay) return; try { const response = await fetch(STATUS_URL); if (!response.ok) throw new Error(`HTTP 错误! 状态: ${response.status}`); const result = await response.json(); if (result.success && result.data) { const status = result.data.status || '未知'; const page = result.data.lastProcessedPage || 0; const lastError = result.data.lastError; let statusText = `状态: ${status} (上次处理页: ${page})`; if (status === 'error' && lastError) { statusText += ` - 错误: ${lastError.substring(0, 100)}${lastError.length > 100 ? '...' : ''}`; } statusDisplay.textContent = statusText; const isRunning = (status === 'running'); const isStopping = (status === 'stopping'); if (startButton) startButton.disabled = isRunning || isStopping; if (stopButton) stopButton.disabled = !isRunning; } else { throw new Error(result.message || '无法获取状态'); } } catch (error) { console.error('获取状态时出错:', error); statusDisplay.textContent = `状态: 获取错误`; if (startButton) startButton.disabled = true; if (stopButton) stopButton.disabled = true; } }

/** *** 修改：创建图片信息表格行 (TableRow) *** */
function createImageInfoRow(imageData) {
    const tr = document.createElement('tr'); // 创建 <tr> 元素

    let authorName = '未知作者';
    let authorLink = '#';
    let description = imageData.description || imageData.alt_description || '-';
    let r2ImageUrl = null;
    const photoId = imageData.id;
    let originalLink = '#'; // 链接到 Unsplash 页面
    let category = '-'; // 分类，从 tags 推断
    let locationDisplay = '-'; // 地点显示

    // 解析 JSON 数据
    try {
        if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; }
        if (imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || '#'; } // 优先用 Unsplash 页面链接
        if (imageData.location_details) { const loc = JSON.parse(imageData.location_details); locationDisplay = [loc.city, loc.country].filter(Boolean).join(', ') || loc.name || '-'; }
        if (imageData.tags_data) { const tags = JSON.parse(imageData.tags_data); if (tags && tags.length > 0) category = tags[0]; } // 简单取第一个 tag 作为分类
    } catch (e) { console.error("解析 JSON 时出错:", e, imageData); }

    // 构造 R2 URL (现在只用于可能的预览链接，如果需要的话)
    if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') {
        const folderName = getFolderNameFromTagsJs(imageData.tags_data);
        const r2Key = `${folderName}/${photoId}`;
        r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`;
        if (originalLink === '#') { originalLink = r2ImageUrl; } // 如果没有 Unsplash 链接，ID 链接到 R2 图片
    } else { console.warn("无法构造 R2 URL:", photoId); /* 不再返回 null，因为 ID 总是要显示的 */ }

    // 格式化时间
    const timeStr = imageData.updated_at_api || imageData.created_at_api;
    const displayTime = timeStr ? new Date(timeStr).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '-';

    // 格式化大小 (目前数据为空)
    const displaySize = imageData.file_size ? Math.round(imageData.file_size / 1024) + ' KB' : '-';

    // 构建表格行内容
    tr.innerHTML = `
        <td><a href="${originalLink}" target="_blank" title="查看来源或图片">${photoId || '-'}</a></td>
        <td>${description.substring(0, 150)}${description.length > 150 ? '...' : ''}</td> 
        <td>${category}</td>
        <td>${imageData.resolution || '-'}</td>
        <td>${locationDisplay}</td>
        <td>${displayTime}</td> 
        <td>${imageData.likes || 0}</td>
        `;
    return tr; // <-- 返回 table row
}

/** *** 修改：加载并显示图片信息到表格 *** */
async function loadImages(page = 1) {
    if (!imageTableBody || isLoadingImages) {
        if (!imageTableBody) console.error("无法找到 #image-table-body 元素!");
        return;
    }

    isLoadingImages = true;
    imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">正在加载数据...</td></tr>`;
    updatePaginationUI();

    currentPage = page;

    try {
        const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`; // <-- 使用新的 PerPage (10)
        console.log(`从 API 获取图片信息: ${url}`);
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
                console.log(`[loadImages] 准备渲染 ${images.length} 行数据...`);
                images.forEach((image, index) => {
                    console.log(`[loadImages] 处理索引 ${index}, ID: ${image?.id}`);
                    const tableRow = createImageInfoRow(image); // <-- 调用创建表格行函数
                    if (tableRow) { imageTableBody.appendChild(tableRow); } // <-- 添加行到 tbody
                    else { console.warn(`[loadImages] 未能为图片 ID 创建表格行: ${image?.id}`); }
                });
            } else {
                const emptyMsg = (currentPage === 1) ? '数据库中还没有图片信息。请尝试启动同步。' : '当前页没有图片信息。';
                imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">${emptyMsg}</td></tr>`;
            }
            updatePaginationUI();

        } else { throw new Error(jsonData.message || '加载信息失败。'); }

    } catch (error) {
        console.error('[loadImages] 加载信息过程中出错:', error);
        if (imageTableBody) { imageTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color: red;">加载信息出错: ${error.message}</td></tr>`; }
        totalPages = currentPage;
        updatePaginationUI();
    } finally {
        isLoadingImages = false;
        updatePaginationUI();
        console.log("[loadImages] 加载流程结束.");
    }
}

// 更新分页 UI (中文)
function updatePaginationUI() { const pageInfoText = `第 ${currentPage} / ${totalPages} 页 (共 ${totalImages} 条记录)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// 分页按钮处理 (保持不变)
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageTableBody || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom) { console.error("DOM elements missing!"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`状态轮询已启动.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }