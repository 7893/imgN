#!/bin/bash

# 脚本：清空指定 R2 存储桶中的所有对象 (保留存储桶本身)
# 警告：此操作将删除存储桶内的所有文件和目录！请谨慎使用！

# --- 配置 ---
BUCKET_NAME="r2-imgn-20240402" # 要清空数据的 R2 存储桶名称

echo "本脚本将尝试清空 R2 存储桶 '$BUCKET_NAME' 中的所有对象。"
echo "存储桶本身将被保留。"
echo -e "\n!!! \e[1;31m警告：这是一个破坏性操作，将删除所有文件且无法撤销！\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
if ! command -v wrangler &> /dev/null; then
    echo "错误：未找到 'wrangler' 命令。" >&2; exit 1;
fi
if ! command -v xargs &> /dev/null; then
    echo "错误：未找到 'xargs' 命令。" >&2; exit 1;
fi
 # --- 确认 Cloudflare 凭证已配置 (可选但推荐) ---
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then
    echo "警告：未检测到 Cloudflare Account ID 环境变量。请确保已配置。" >&2
fi

# --- 用户确认 (简化版) ---
# 先尝试获取对象数量（可选，但能提供更好信息）
echo "正在检查存储桶 '$BUCKET_NAME' 中的对象数量..."
# 使用 list --pipe 并计算行数，错误或空则数量为 0
object_count=$(wrangler r2 object list "$BUCKET_NAME" --pipe | wc -l)
if [ $? -ne 0 ]; then
    echo "警告：无法获取对象列表来确认数量，请谨慎操作。"
    object_count=0 # Assume 0 on error to proceed with confirmation cautiously
fi

if [ "$object_count" -eq 0 ]; then
    echo "存储桶 '$BUCKET_NAME' 中没有对象，无需清空。"
    exit 0
fi

echo -e "找到 \e[1;33m$object_count\e[0m 个对象将被删除。" # Yellow count
echo "--------------------------------------------------"

read -p $'!!! 此操作不可逆 !!!\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认清空存储桶 '$BUCKET_NAME' 中的所有对象，输入其他任意字符取消: ' confirm_action

# 检查确认输入
confirm_action_lower=${confirm_action,,} 
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi
# Proceed if Enter or y/Y

echo "--- 开始清空 R2 存储桶 '$BUCKET_NAME' ---"

# --- 列出对象并通过 xargs 批量删除 ---
# 使用 --pipe 获取纯 key 列表，xargs 将 key 作为参数传递给 delete 命令
# xargs 会自动处理参数列表过长的问题，分批调用 delete
if wrangler r2 object list "$BUCKET_NAME" --pipe | xargs wrangler r2 object delete "$BUCKET_NAME"; then
    echo "✅ R2 存储桶 '$BUCKET_NAME' 的所有对象已成功删除。"
    exit 0
else
    echo "❌ 错误：清空 R2 存储桶 '$BUCKET_NAME' 时发生错误。" >&2
    echo "请检查 wrangler 的输出或 Cloudflare Dashboard。" >&2
    exit 1
fi