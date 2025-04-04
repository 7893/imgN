#!/bin/bash

# 脚本：清空指定 KV Namespace 中的所有键值对

# --- 配置 ---
KV_NAMESPACE_ID="735f5c8008a64addb2b94dd097876ae9" # 要清空的 KV Namespace 的 ID
KV_NAMESPACE_TITLE="imgn-kv-cache-20240402" # Namespace 标题 (仅用于显示)

echo "本脚本将尝试清空 KV Namespace '$KV_NAMESPACE_TITLE' (ID: $KV_NAMESPACE_ID) 中的所有键值对。"
echo -e "!!! \e[1;31m警告：此操作不可逆，将删除所有 KV 数据！\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查工具和凭证 ---
# ... (检查 wrangler, jq, 凭证) ...
if ! command -v wrangler &> /dev/null; then echo "错误：未找到 'wrangler' 命令。" >&2; exit 1; fi
if ! command -v jq &> /dev/null; then echo "错误：未找到 'jq' 命令。" >&2; exit 1; fi
if ! command -v xargs &> /dev/null; then echo "错误：未找到 'xargs' 命令。" >&2; exit 1; fi
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then echo "警告：未检测到 Cloudflare Account ID 环境变量。" >&2; fi

# --- 用户确认 ---
echo "正在检查 KV Namespace 中的 Key 数量..."
# 注意：list 可能只返回部分 key，如果 key 数量巨大，此脚本可能不完整
key_list=$(wrangler kv key list --namespace-id "$KV_NAMESPACE_ID" --json | jq -r '.[].name')
key_count=$(echo "$key_list" | wc -l)

if [ -z "$key_list" ] || [ "$key_count" -eq 0 ]; then
     echo "KV Namespace '$KV_NAMESPACE_TITLE' 中没有找到 Key，或获取列表失败。无需清空。"
     exit 0
fi

echo -e "找到 \e[1;33m$key_count\e[0m 个 Key 将被删除 (注意: 如果 Key 太多可能未完全列出)。" 
echo "--------------------------------------------------"

read -p $'!!! 此操作不可逆 !!!\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认清空 KV Namespace '$KV_NAMESPACE_TITLE'，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,} 
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 开始清空 KV Namespace '$KV_NAMESPACE_TITLE' ---"

# --- 列出 Key 并通过 xargs 批量删除 ---
# 注意：如果 Key 数量巨大 (>1000?), list 可能需要分页，xargs 可能需要调整
# 对于一般测试目的，这个方法通常可行
echo "$key_list" | xargs wrangler kv key delete --namespace-id "$KV_NAMESPACE_ID"
delete_exit_code=$?

if [ $delete_exit_code -eq 0 ]; then
    echo "✅ KV Namespace '$KV_NAMESPACE_TITLE' 的 Key 删除命令已成功执行（请注意检查是否有错误输出）。"
    exit 0
else
    echo "❌ 错误：删除 KV Namespace '$KV_NAMESPACE_TITLE' 的 Key 时发生错误。" >&2
    echo "请检查 wrangler 的输出。" >&2
    exit 1
fi