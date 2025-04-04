// src/utils.ts

/**
 * 清理字符串，使其适合作为 R2 文件夹/对象键的一部分。
 * 规则：小写，空格/加号转下划线，只保留 Unicode 字母、数字、下划线、连字符。限制长度。
 * @param tagName 原始 Tag 标题
 * @returns 清理后的字符串，如果原始输入无效或清理后为空/无效，则返回空字符串
 */
export function sanitizeForR2Key(tagName: string | undefined | null): string { // <--- 添加 export
    if (!tagName) return '';
    const sanitized = tagName
        .toLowerCase()
        .replace(/[\s\+]+/g, '_')
        .replace(/[^\p{L}\p{N}_-]/gu, '')
        .substring(0, 50);
    if (!sanitized || /^[_ -]+$/.test(sanitized)) {
        return '';
    }
    return sanitized;
}

/**
 * 根据照片的 tags 数组获取 R2 存储的文件夹名称。
 * @param tags Unsplash Photo 的 tags 数组 (只需 title 属性)
 * @returns 合适的文件夹名 (清理后) 或默认 "uncategorized"
 */
export function getFolderNameFromTags(tags: { title?: string }[] | undefined | null): string { // <--- 添加 export
    const defaultFolder = 'uncategorized'; // 使用英文作为默认文件夹名
    if (!tags || tags.length === 0) {
        return defaultFolder;
    }

    for (const tag of tags) {
        const sanitized = sanitizeForR2Key(tag?.title);
        if (sanitized) {
            return sanitized;
        }
    }

    return defaultFolder;
}