// script.js

// API Worker 的 URL (使用了你提供的账户名 53)
const API_BASE_URL = 'https://imgn-api-worker.53.workers.dev';
const IMAGES_API_URL = `${API_BASE_URL}/images`; // 我们实现的 /images 端点

// 获取用于显示图片的容器元素
const imageGrid = document.getElementById('image-grid');

// --- 函数：创建单个图片卡片的 HTML ---
function createImageCard(imageData) {
    // imageData 对应 D1 表中的一行记录
    const card = document.createElement('div');
    card.classList.add('image-card'); // 添加 CSS 类以便设置样式

    // 解析存储为 JSON 字符串的 URLs 和作者信息
    let imageUrl = imageData.regular_url; // 优先使用 D1 里的 regular_url 列 (如果我们之后单独存了)
    let authorName = 'Unknown Author';
    let authorLink = '#';

    try {
        // 尝试从 image_urls JSON 中获取图片 URL (例如 'small' 或 'regular')
        if (imageData.image_urls) {
            const urls = JSON.parse(imageData.image_urls);
            imageUrl = urls?.small || urls?.regular || imageUrl; // 优先 small
        }
        // 尝试从 author_details JSON 中获取作者名字和链接
        if (imageData.author_details) {
            const author = JSON.parse(imageData.author_details);
            authorName = author?.name || authorName;
            authorLink = author?.links?.html || authorLink;
        }
    } catch (e) {
        console.error("Error parsing JSON data for image card:", e, imageData);
    }

    // 构建卡片内容
    card.innerHTML = `
		<a href="${imageUrl}" target="_blank" rel="noopener noreferrer"> 
			<img src="${imageUrl}" alt="${imageData.alt_description || imageData.description || 'Unsplash Image'}" loading="lazy">
		</a>
		<div class="image-info">
			<p class="description">${imageData.description || imageData.alt_description || '<em>No description</em>'}</p>
			<p class="author">By: <a href="${authorLink}" target="_blank" rel="noopener noreferrer">${authorName}</a></p>
			<p class="likes">Likes: ${imageData.likes || 0}</p>
			</div>
	`;
    return card;
}

// --- 函数：从 API 加载并显示图片 ---
async function loadImages() {
    if (!imageGrid) {
        console.error('Error: Image grid container not found!');
        return;
    }

    imageGrid.innerHTML = '<p>Loading images...</p>'; // 显示加载提示

    try {
        console.log(`Workspaceing images from: ${IMAGES_API_URL}`);
        const response = await fetch(IMAGES_API_URL); // 默认获取第一页

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const jsonData = await response.json();
        console.log("Received data:", jsonData);

        if (jsonData.success && jsonData.data?.images?.length > 0) {
            imageGrid.innerHTML = ''; // 清空加载提示
            jsonData.data.images.forEach(image => {
                const card = createImageCard(image);
                imageGrid.appendChild(card);
            });
        } else if (jsonData.success) {
            imageGrid.innerHTML = '<p>No images found.</p>';
        } else {
            throw new Error(jsonData.message || 'Failed to load images.');
        }

    } catch (error) {
        console.error('Error loading images:', error);
        if (imageGrid) {
            imageGrid.innerHTML = `<p style="color: red;">Error loading images: ${error.message}</p>`;
        }
    }
}

// --- 页面加载完成后执行加载图片函数 ---
// 确保 DOM 完全加载后再执行脚本
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadImages);
} else {
    loadImages(); // DOMContentLoaded 已经触发
}