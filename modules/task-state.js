export const TASK_LABELS = Object.freeze({
    preparing: '准备中', generating: '生成中', saving: '保存中', verifying: '检查总结注入', hiding: '隐藏旧消息',
    restoring: '恢复中', complete: '已完成', cancelled: '已取消', failed: '处理失败',
});

export function setTaskStage(task, stage) {
    if (!task || !Object.hasOwn(TASK_LABELS, stage)) return;
    task.stage = stage;
    task.startedAt ??= Date.now();
}

export function taskLabel(task) {
    if (!task) return '';
    const elapsed = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
    const part = task.stage === 'generating' && task.part ? `${task.part} · ` : '';
    if (task.stage === 'generating' && task.stream) {
        const stream = task.stream;
        const phase = stream.chars ? `接收正文 · ${stream.chars.toLocaleString()} 字`
            : !stream.enabled ? '等待完整响应' : stream.thinking ? '模型思考中'
                : stream.lastReceivedAt ? '等待正文' : '等待响应';
        const idle = Math.floor((Date.now() - (stream.lastReceivedAt ?? stream.startedAt)) / 1000);
        return `${part}${phase} · ${elapsed} 秒${idle >= 15 ? ` · ${idle} 秒未收到新数据` : ''}`;
    }
    return `${part}${TASK_LABELS[task.stage] ?? '处理中'} · ${elapsed} 秒`;
}
