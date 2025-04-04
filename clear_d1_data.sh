#!/bin/bash

# 脚本：清空指定 D1 数据库中所有用户表的数据 (保留表结构)
# 新版：简化确认流程，列出表后按 Enter 或 y/Y 确认

# --- 配置 ---
DATABASE_NAME="d1-imgn-20240402" # 要清空数据的 D1 数据库名称

echo "本脚本将尝试清空数据库 '$DATABASE_NAME' 中所有用户表的数据。"
echo "表结构本身将被保留。"
echo -e "\n!!! \e[1;31m警告：这是一个破坏性操作，将删除所有数据且无法撤销！\e[0m !!!" # 红色警告
echo "--------------------------------------------------"

# --- 检查依赖工具 ---
if ! command -v wrangler &> /dev/null; then
    echo "错误：未找到 'wrangler' 命令。" >&2; exit 1;
fi
if ! command -v jq &> /dev/null; then
    echo "错误：未找到 'jq' 命令。请安装 (例如: sudo apt install jq)。" >&2; exit 1;
fi
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" && -z "$TF_VAR_cloudflare_account_id" ]]; then
    echo "警告：未检测到 Cloudflare Account ID 环境变量。请确保已配置。" >&2
fi

echo "正在获取 '$DATABASE_NAME' 中的用户表列表..."

# --- 获取表列表 ---
# 使用 --json 获取易于解析的输出, jq 提取 name
# 排除 sqlite_*, _cf_*, d1_migrations 等内部/管理表
mapfile -t TABLE_LIST < <(wrangler d1 execute "$DATABASE_NAME" --remote --json --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';" | jq -r '.[].results[]? | .name')

# 检查获取表列表是否成功
if [ $? -ne 0 ]; then
    echo "错误：获取表列表失败，请检查 wrangler 命令输出或网络连接。" >&2
    exit 1
fi

# 检查是否有用户表
if [ ${#TABLE_LIST[@]} -eq 0 ]; then
    echo "在数据库 '$DATABASE_NAME' 中未找到用户表，无需清空。"
    exit 0
fi

echo -e "将要清空以下 \e[1;33m${#TABLE_LIST[@]}\e[0m 个表的数据:" # 用黄色显示数量
# 打印将要清空的表名
printf "  - %s\n" "${TABLE_LIST[@]}"
echo "--------------------------------------------------"

# --- 用户确认 (简化版) ---
# 直接提示用户确认，接受回车或 y/Y
read -p $'!!! 此操作不可逆 !!!\n按 \e[1;32mEnter\e[0m 或输入 \e[1;32my/Y\e[0m 确认清空以上所有表的数据，输入其他任意字符取消: ' confirm_action

# 检查确认输入：如果输入了内容，并且不是 'y' 或 'Y' (忽略大小写)，则取消
confirm_action_lower=${confirm_action,,} # 转换为小写
if [[ -n "$confirm_action" && "$confirm_action_lower" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi
# 如果用户直接按 Enter (输入为空) 或输入了 y/Y，则继续执行

echo "--- 开始清空 ---"

# --- 循环清空表 ---
FAIL_COUNT=0
SUCCESS_COUNT=0
for table_name in "${TABLE_LIST[@]}"; do
    echo "正在清空表 '$table_name'..."
    # 使用双引号确保表名正确处理
    delete_command="DELETE FROM \"$table_name\";"

    # 执行删除命令，捕获标准错误输出以便显示
    if output=$(wrangler d1 execute "$DATABASE_NAME" --remote --command="$delete_command" 2>&1); then
        echo "  ✅ 成功清空表 '$table_name'."
        ((SUCCESS_COUNT++))
    else
        echo "  ❌ 错误：清空表 '$table_name' 失败。" >&2
        echo "     Wrangler 输出: $output" >&2 # 显示 wrangler 的错误输出
        ((FAIL_COUNT++))
    fi
done

# --- 总结 ---
echo "--- 清空操作完成 ---"
echo "总结：成功清空 ${SUCCESS_COUNT} 个表，失败 ${FAIL_COUNT} 个表。"

if (( FAIL_COUNT > 0 )); then
    echo "请检查上面的错误信息。" >&2
    exit 1 # 以非零状态退出表示有错误
else
    echo "数据库 '$DATABASE_NAME' 中所有用户表的数据已成功清空。"
    exit 0 # 以零状态退出表示成功
fi