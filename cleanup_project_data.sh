#!/bin/bash

# 脚本：统一清理 imgn 项目在 Cloudflare 中产生的数据 (v10 - R2 Endpoint 硬编码)
# 清理 D1 表数据, R2 对象 (通过 AWS CLI), KV 键值对, Queue 消息, 并重置 DO 状态
# !!! 警告：此脚本执行破坏性操作，但会保留资源本身 !!!

# --- 配置 ---
D1_DATABASE_NAME="d1-imgn-20240402"
R2_BUCKET_NAME="r2-imgn-20240402" 
QUEUE_NAME="imgn-queue-sync-tasks-20240402"
KV_NAMESPACE_ID="735f5c8008a64addb2b94dd097876ae9"
KV_NAMESPACE_TITLE="imgn-kv-cache-20240402"
API_WORKER_URL="https://imgn-api-worker.53.workers.dev"
DO_RESET_ENDPOINT="/reset-sync-do"

# --- R2 S3 API 端点 (硬编码 - !!! 请将 <你的账户ID> 替换为真实的 Account ID !!!) ---
# 你可以在 Cloudflare Dashboard -> R2 概览页面找到你的 S3 API 端点
R2_ENDPOINT_URL="https://<你的账户ID>.r2.cloudflarestorage.com" # <--- 修改这里!

# --- AWS CLI / R2 API 凭证配置 (从环境变量获取 - 必须预先配置!) ---
# 需要设置:
# export AWS_ACCESS_KEY_ID="YOUR_R2_ACCESS_KEY_ID"
# export AWS_SECRET_ACCESS_KEY="YOUR_R2_SECRET_ACCESS_KEY"
# export AWS_DEFAULT_REGION="auto" # 建议设置

echo "本脚本将尝试清理以下 imgn 项目资源中的 *数据*："
echo "  - D1 数据库: $D1_DATABASE_NAME (清空所有用户表中的行)"
echo "  - R2 存储桶: $R2_BUCKET_NAME (删除所有对象/文件 - 使用 AWS CLI)" 
echo "      (目标 R2 Endpoint: $R2_ENDPOINT_URL)" # 显示将使用的 Endpoint
echo "  - KV 命名空间: $KV_NAMESPACE_TITLE (删除所有键值对)"
echo "  - Queue: $QUEUE_NAME (清除所有消息)"
echo "  - Durable Object 状态: 通过 API ($API_WORKER_URL$DO_RESET_ENDPOINT) 重置"
echo ""
echo -e "!!! \e[1;31m警告：此操作不可逆，将删除大量数据！资源本身将被保留。\e[0m !!!"
echo -e "!!! \e[1;33mR2 清理提示: 请确保已安装 AWS CLI 并已配置 R2 的 API 访问凭证 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) 为环境变量。脚本中的 R2 Endpoint URL (\e[4m$R2_ENDPOINT_URL\e[0m) 需要你手动修改正确。\e[0m !!!" # 更新提示
echo -e "!!! \e[1;33mKV 清理提示: 如果 KV 清理步骤失败并提示 'libatomic.so.1' 错误, 请先运行: sudo apt update && sudo apt install libatomic1 -y\e[0m !!!"
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
all_tools_found=true
for cmd in wrangler jq curl xargs aws; do 
    if ! command -v $cmd &> /dev/null; then
        echo "错误：未找到命令 '$cmd'。请先安装它。" >&2; all_tools_found=false
    fi
done
if [[ "$all_tools_found" = false ]]; then exit 1; fi

# --- 确认 Cloudflare & AWS 凭证 ---
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then
    echo "警告：未检测到 Cloudflare Account ID 环境变量 (Wrangler 可能仍能工作)。" >&2
fi
# 只检查 AWS Key 和 Secret 环境变量，Endpoint URL 在脚本内部定义
if [[ -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
     echo -e "\e[1;31m错误：执行 R2 清理需要 AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY 环境变量。\e[0m" >&2
     exit 1 
fi
# 检查硬编码的 Endpoint 是否被修改，防止用户忘记修改
if [[ "$R2_ENDPOINT_URL" == "https://<你的账户ID>.r2.cloudflarestorage.com" ]]; then
     echo -e "\e[1;31m错误：请先修改脚本顶部的 R2_ENDPOINT_URL 变量，填入你真实的 R2 S3 API 端点 URL。\e[0m" >&2
     exit 1
fi


# --- 用户最终确认 ---
read -p $'!!! 请再次确认是否要执行以上所有数据清理操作?\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认，输入其他任意字符取消: ' confirm_action
confirm_action_lower=${confirm_action,,}
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

echo "--- 开始执行清理操作 ---"
FAIL_COUNT=0
STEP_COUNT=5 

# --- 1. 清空 D1 表数据 ---
echo "[1/$STEP_COUNT] 清空 D1 数据库 '$D1_DATABASE_NAME' 用户表数据..."
# ... (D1 清理逻辑保持不变) ...
if ! command -v jq &> /dev/null; then echo "错误: D1 清理需要 'jq'。"; ((FAIL_COUNT++)); else mapfile -t D1_TABLE_LIST < <(wrangler d1 execute "$D1_DATABASE_NAME" --remote --json --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';" | jq -r '.[].results[]? | .name'); list_exit_code=$?; if [ $list_exit_code -ne 0 ] && [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then echo "  ⚠️ 获取 D1 表列表失败或未找到用户表。"; elif [ ${#D1_TABLE_LIST[@]} -eq 0 ]; then echo "  ✅ D1 中没有用户表。"; else echo "  将清空表: ${D1_TABLE_LIST[*]}"; d1_fail_flag=0; for table_name in "${D1_TABLE_LIST[@]}"; do echo "    清空表 '$table_name'..."; if ! wrangler d1 execute "$D1_DATABASE_NAME" --remote --command="DELETE FROM \"$table_name\";" > /dev/null 2>&1; then echo "    ❌ 错误：清空表 '$table_name' 失败。" >&2; d1_fail_flag=1; fi; done; if [ $d1_fail_flag -eq 0 ]; then echo "  ✅ D1 用户表数据已清空。"; else ((FAIL_COUNT++)); fi; fi; fi
echo "---"

# --- 2. 清空 R2 存储桶对象 (使用 AWS CLI 和脚本内定义的 Endpoint URL) ---
echo "[2/$STEP_COUNT] 清空 R2 存储桶 '$R2_BUCKET_NAME' 对象 (使用 AWS CLI)..."
r2_uri="s3://${R2_BUCKET_NAME}/" 
echo "  将执行: aws s3 rm \"$r2_uri\" --recursive --endpoint-url \"$R2_ENDPOINT_URL\"" # <-- 使用脚本变量
echo "  (如果对象数量多，此步骤可能需要一些时间...)"
if aws s3 rm "$r2_uri" --recursive --endpoint-url "$R2_ENDPOINT_URL" --quiet; then # <-- 使用脚本变量
    echo "  ✅ R2 存储桶 '$R2_BUCKET_NAME' 对象清理命令已成功执行。"
else
    echo "  ❌ 错误：使用 AWS CLI 清理 R2 存储桶 '$R2_BUCKET_NAME' 时发生错误。" >&2
    echo "  ℹ️ 请检查 AWS CLI 输出、R2 API 凭证 (环境变量) 及脚本中 Endpoint URL 配置。" >&2
    ((FAIL_COUNT++))
fi
echo "---"

# --- 3. 清空 KV Namespace ---
echo "[3/$STEP_COUNT] 清空 KV Namespace '$KV_NAMESPACE_TITLE' (ID: $KV_NAMESPACE_ID)..."
# ... (KV 清理逻辑保持不变) ...
mapfile -t KEY_LIST < <(wrangler kv key list --namespace-id "$KV_NAMESPACE_ID"); list_exit_code=$?; if [ $list_exit_code -ne 0 ] && [ ${#KEY_LIST[@]} -eq 0 ]; then echo "  ❌ 错误：获取 KV Key 列表失败。检查 'libatomic1'?" >&2; ((FAIL_COUNT++)); elif [ ${#KEY_LIST[@]} -eq 0 ]; then echo "  ✅ KV Namespace '$KV_NAMESPACE_TITLE' 为空。"; else echo "  找到 ${#KEY_LIST[@]} 个 Key，删除中..."; printf "%s\n" "${KEY_LIST[@]}" | xargs -d '\n' wrangler kv key delete --namespace-id "$KV_NAMESPACE_ID"; if [ $? -eq 0 ]; then echo "  ✅ KV Key 删除命令已执行。"; else echo "  ❌ 错误：删除 KV Key 时出错。" >&2; ((FAIL_COUNT++)); fi; fi
echo "---"

# --- 4. 清空 Queue 消息 ---
echo "[4/$STEP_COUNT] 清空 Queue '$QUEUE_NAME' 消息..."
# ... (Queue 清理逻辑保持不变) ...
if wrangler queues purge "$QUEUE_NAME" --force; then echo "  ✅ Queue '$QUEUE_NAME' 已成功清空。"; else echo "  ❌ 错误：清空 Queue '$QUEUE_NAME' 失败。" >&2; ((FAIL_COUNT++)); fi
echo "---"

# --- 5. 重置 DO 状态 ---
echo "[5/$STEP_COUNT] 重置 Durable Object 状态 (通过 API)..." 
# ... (DO 重置逻辑保持不变) ...
reset_url="${API_WORKER_URL}${DO_RESET_ENDPOINT}"; echo "  调用端点: $reset_url"; if curl -sf -X POST "$reset_url" -H "Content-Type: application/json" -o /dev/null; then echo "  ✅ DO 重置请求已成功发送 (HTTP 2xx)。"; else echo "  ❌ 错误：发送 DO 重置请求失败 (HTTP 状态码非 2xx)。" >&2; ((FAIL_COUNT++)); fi
echo "---"

# --- 最终总结 ---
echo "所有清理操作尝试完毕。"
# ... (总结逻辑保持不变) ...
if (( FAIL_COUNT > 0 )); then echo -e "\e[1;31m有 $FAIL_COUNT 个步骤失败或遇到错误...\e[0m" >&2; exit 1; else echo -e "\e[1;32m所有清理操作均已成功完成。\e[0m"; exit 0; fi
