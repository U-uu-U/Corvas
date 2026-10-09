export function describeMcpServerStatus(status) {
    if (!status) return '正在读取状态…';
    if (status.running) return `运行中 · ${status.url}`;
    if (status.enabled && status.error) return `启动失败：${status.error}`;
    return '已关闭，其他 Agent 无法连接';
}
