// ~/imgN/frontend/script.js (更新为 5 张/页，显示总数)

// --- 配置 ---
const API_BASE_URL = `https://imgn-api-worker.53.workers.dev`; 
const IMAGES_API_URL = `${API_BASE_URL}/images`;
const START_SYNC_URL = `${API_BASE_URL}/start-sync`;
const STOP_SYNC_URL = `${API_BASE_URL}/stop-sync`;
const STATUS_URL = `${API_BASE_URL}/sync-status`;
const STATUS_POLL_INTERVAL = 5000; 
const IMAGES_PER_PAGE = 5; // <--- 修改为 5 ***

// R2 公开 URL (需要你填入)
const R2_PUBLIC_URL_BASE = 'https://pub-61b373cf3f6e4863a70b53ca5e61dc53.r2.dev'; // 使用你之前提供的 URL

// --- DOM 元素获取 (保持不变) ---
const imageGrid = document.getElementById('image-grid'); /* ... etc ... */
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

// --- 状态变量 (保持不变) ---
let statusIntervalId = null; 
let currentPage = 1; 
let totalPages = 1;  
let totalImages = 0; 
let isLoadingImages = false; 

// --- R2 Key 处理辅助函数 (保持不变) ---
function sanitizeForR2KeyJs(tagName) { /* ... */ if (!tagName) return ''; const sanitized = tagName.toLowerCase().replace(/[\s+]+/g, '_').replace(/[^a-z0-9_-]/g, '').substring(0, 50); if (!sanitized || /^[_ -]+$/.test(sanitized)) { return ''; } return sanitized; }
function getFolderNameFromTagsJs(tagsData) { /* ... */ const defaultFolder = 'uncategorized'; let tags = []; if (tagsData) { try { tags = JSON.parse(tagsData); } catch(e) { console.error("Failed to parse tags_data:", tagsData, e); return defaultFolder; } } if (!Array.isArray(tags) || tags.length === 0) { return defaultFolder; } for (const tagTitle of tags) { const sanitized = sanitizeForR2KeyJs(tagTitle); if (sanitized) { return sanitized; } } return defaultFolder; }

// --- 其他辅助函数 (保持不变) ---
function showActionMessage(message, isError = false) { /* ... */ }
async function handleSyncAction(url, button) { /* ... */ }
async function fetchStatus() { /* ... */ }
function createImageCard(imageData) { /* ... (使用 R2 URL 逻辑不变) ... */ const card = document.createElement('div'); card.classList.add('image-card'); let authorName = '未知作者'; let authorLink = '#'; let description = imageData.description || imageData.alt_description || '<i>无描述</i>'; let r2ImageUrl = null; const photoId = imageData.id; if (photoId && R2_PUBLIC_URL_BASE && R2_PUBLIC_URL_BASE !== 'https://<你的R2公共URL>') { const folderName = getFolderNameFromTagsJs(imageData.tags_data); const r2Key = `${folderName}/${photoId}`; r2ImageUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${r2Key}`; } else if (!R2_PUBLIC_URL_BASE || R2_PUBLIC_URL_BASE === 'https://<你的R2公共URL>') { console.warn("R2_PUBLIC_URL_BASE 未配置!"); } try { if (imageData.author_details) { const author = JSON.parse(imageData.author_details); authorName = author?.name || authorName; authorLink = author?.links?.html || authorLink; } } catch (e) { console.error("解析作者 JSON 时出错:", e, imageData); } if (!r2ImageUrl) { console.warn("无法构造 R2 URL:", photoId); return null; } let originalLink = r2ImageUrl; try { if(imageData.photo_links) { const links = JSON.parse(imageData.photo_links); originalLink = links?.html || originalLink; } } catch(e) { /* ignore */ } card.innerHTML = `<a href="${originalLink}" target="_blank" rel="noopener noreferrer" title="View original source or full image"><img src="${r2ImageUrl}" alt="${imageData.alt_description || imageData.description || 'Image'}" loading="lazy"></a><div class="image-info"><p class="description">${description}</p><p class="author">作者: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p><p class="likes">点赞: ${imageData.likes || 0}</p></div>`; return card; }

// --- 加载并显示图片 (使用 IMAGES_PER_PAGE 常量 - 逻辑不变) ---
async function loadImages(page = 1) { if (!imageGrid || isLoadingImages) return; isLoadingImages = true; imageGrid.innerHTML = '<p>正在加载图片...</p>'; updatePaginationUI(); currentPage = page; try { const url = `${IMAGES_API_URL}?page=${currentPage}&limit=${IMAGES_PER_PAGE}`; console.log(`从 API 获取图片: ${url}`); const response = await fetch(url); if (!response.ok) { throw new Error(`HTTP 错误! 状态: ${response.status}`); } const jsonData = await response.json(); console.log("接收到图片数据:", jsonData); if (jsonData.success && jsonData.data?.images) { imageGrid.innerHTML = ''; totalImages = jsonData.data.totalImages || 0; totalPages = jsonData.data.totalPages || 1; const images = jsonData.data.images; if (images.length > 0) { images.forEach(image => { const card = createImageCard(image); if (card) { imageGrid.appendChild(card); } }); } else { if (currentPage === 1) { imageGrid.innerHTML = '<p>图库中还没有图片。</p>'; } else { imageGrid.innerHTML = '<p>当前页没有图片。</p>'; } } updatePaginationUI(); } else { throw new Error(jsonData.message || '加载图片失败。'); } } catch (error) { console.error('加载图片时出错:', error); if (imageGrid) { imageGrid.innerHTML = `<p style="color: red;">加载图片出错: ${error.message}</p>`; } totalPages = currentPage; updatePaginationUI(); } finally { isLoadingImages = false; updatePaginationUI(); /* 确保按钮状态在加载结束后更新 */ } }

// --- 更新分页 UI (加入总数显示 - 逻辑不变) ---
function updatePaginationUI() { const pageInfoText = `Page ${currentPage} / ${totalPages} (Total: ${totalImages} images)`; if (pageInfo) pageInfo.textContent = pageInfoText; if (pageInfoBottom) pageInfoBottom.textContent = pageInfoText; const disablePrev = isLoadingImages || currentPage <= 1; const disableNext = isLoadingImages || currentPage >= totalPages; if (prevButton) prevButton.disabled = disablePrev; if (prevButtonBottom) prevButtonBottom.disabled = disablePrev; if (nextButton) nextButton.disabled = disableNext; if (nextButtonBottom) nextButtonBottom.disabled = disableNext; }

// --- 分页按钮处理 (保持不变) ---
function handlePrevPage() { if (!isLoadingImages && currentPage > 1) { loadImages(currentPage - 1); } }
function handleNextPage() { if (!isLoadingImages && currentPage < totalPages) { loadImages(currentPage + 1); } }

// --- 初始化函数 (保持不变) ---
function init() { if (!startButton || !stopButton || !prevButton || !nextButton || !pageInfo || !imageGrid || !statusDisplay || !actionMessage || !prevButtonBottom || !nextButtonBottom || !pageInfoBottom ) { console.error("DOM elements missing!"); return; } startButton.addEventListener('click', () => handleSyncAction(START_SYNC_URL, startButton)); stopButton.addEventListener('click', () => handleSyncAction(STOP_SYNC_URL, stopButton)); prevButton.addEventListener('click', handlePrevPage); nextButton.addEventListener('click', handleNextPage); prevButtonBottom.addEventListener('click', handlePrevPage); nextButtonBottom.addEventListener('click', handleNextPage); loadImages(currentPage); fetchStatus(); if (statusIntervalId) clearInterval(statusIntervalId); statusIntervalId = setInterval(fetchStatus, STATUS_POLL_INTERVAL); console.log(`Status polling started.`); }

// --- 脚本入口 (保持不变) ---
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }