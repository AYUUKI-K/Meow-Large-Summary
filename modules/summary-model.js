// Pure data rules. No host state, network calls or DOM access.
export function textDigest(text) {
    let a = 2166136261;
    let b = 2246822519;
    for (let i = 0; i < text.length; i++) {
        const value = text.charCodeAt(i);
        a = Math.imul(a ^ value, 16777619);
        b = Math.imul(b ^ value, 3266489917);
    }
    return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

export function messageFingerprint(message) {
    // Visibility is deliberately separate: hiding must not change provenance.
    return textDigest(JSON.stringify([
        String(message?.mes ?? ''), String(message?.name ?? ''), Boolean(message?.is_user),
        message?.send_date ?? null, message?.swipe_id ?? null, message?.extra?.reasoning ?? null,
    ]));
}

export function historyDigest(chat, end = chat.length - 1) {
    if (end < 0) return textDigest('[]');
    if (end >= chat.length) return null;
    return textDigest(JSON.stringify(chat.slice(0, end + 1).map(messageFingerprint)));
}

export function summarySourceChanged(chat, metadata) {
    if (!Number.isInteger(metadata?.sourceEnd) || metadata.sourceEnd < 0 || !metadata.sourceDigest) return false;
    return historyDigest(chat, metadata.sourceEnd) !== metadata.sourceDigest;
}

// A user's explicit choice to keep old memory does not repair its provenance.
// Bind the choice to this archive, summary revision and changed source prefix.
export function sourceChangeAccepted(chat, metadata) {
    const choice = metadata?.sourceChangeAcknowledgement;
    return Boolean(choice && typeof metadata.archiveId === 'string' && metadata.archiveId
        && choice.archiveId === metadata.archiveId
        && choice.summaryRound === metadata.round
        && choice.summarySourceEnd === metadata.sourceEnd && choice.summarySourceDigest === metadata.sourceDigest
        && Number.isInteger(choice.end) && choice.end >= -1 && choice.end < chat.length
        && typeof choice.digest === 'string' && choice.digest
        && choice.digest === historyDigest(chat, choice.end));
}

export function memoryUpdateCheckpoint(records, chat) {
    const valid = branchRecords(records, chat);
    const last = valid.at(-1);
    const content = combineRecords(valid).trim();
    return last && content ? { content, sourceEnd: last.sourceEnd, round: last.round } : null;
}

export function activeRecords(records) {
    return records.filter(record => !record.undone).sort((a, b) => a.round - b.round);
}

export function combineRecords(records) {
    let content = '';
    for (const record of activeRecords(records)) {
        const text = String(record.content ?? '').trim();
        if (record.mode === 'merged') content = text;
        else if (text) content = content ? `${content}\n\n${text}` : text;
    }
    return content;
}

export function branchRecords(records, chat) {
    let inherited = [];
    let missingEarlier = false;
    for (const record of activeRecords(records)) {
        const known = Number.isInteger(record.sourceEnd) && record.sourceEnd >= 0 && record.sourceDigest
            && historyDigest(chat, record.sourceEnd) === record.sourceDigest;
        if (!known) { missingEarlier = true; continue; }
        if (record.mode === 'merged') {
            if (missingEarlier) inherited = [];
            missingEarlier = false;
        }
        if (!missingEarlier) inherited.push(structuredClone(record));
    }
    return inherited;
}

export function archiveTransition(archive, current, integrity) {
    if (!archive.archiveId || (archive.cardKey && archive.cardKey !== current.cardKey)) return 'new';
    if (archive.chatIntegrity && integrity && archive.chatIntegrity !== integrity) return 'branch';
    // ST keeps integrity across renames and mints it anew for branches.
    if (archive.chatIntegrity && archive.chatIntegrity === integrity) return 'same';
    if (archive.chatId && archive.chatId !== current.chatId) return 'branch';
    return 'same';
}

export function visibilityChanges(chat, end) {
    if (end < 0) return [];
    return chat.slice(0, end + 1).flatMap((message, index) => message.is_system ? [] : [{
        index, fingerprint: messageFingerprint(message),
    }]);
}

// The executor and overview share this boundary; hidden/empty history cannot
// trigger a new summary. A saved operation may still need its hide retried.
export function summaryScope(chat, keep, cursor = -1, pendingHideEnd = -1) {
    const keepRecent = Math.max(1, Math.floor(Number(keep) || 1));
    const coveredTo = chat.length - keepRecent - 1;
    const coveredFrom = Math.max(0, cursor + 1);
    const eligible = coveredTo >= coveredFrom && chat.slice(coveredFrom, coveredTo + 1)
        .some(message => !message.is_system && String(message.mes ?? '').trim());
    const range = eligible ? { coveredFrom, coveredTo, keepRecent } : null;
    const hideEnd = Math.max(pendingHideEnd, range?.coveredTo ?? -1);
    const hiddenCount = chat.filter(message => message.is_system).length;
    const pendingCount = chat.filter((message, index) => index <= hideEnd && !message.is_system).length;
    return { range, hideEnd, hiddenCount, pendingCount, keptCount: chat.length - hiddenCount - pendingCount,
        recentCount: Math.min(chat.length, keepRecent) };
}

export function summaryResultText(operation, tokens) {
    if (!operation) return '';
    if (operation.phase === 'undone') return operation.combinedRestorePending && !operation.messagesRestored
        ? '总结已撤销，原文恢复未完成；可继续恢复本次原文。'
        : operation.messagesRestored ? '本次整理已撤销，原文已恢复。' : '';
    if (operation.messagesRestored) return '本轮隐藏的消息已恢复。';
    if (operation.phase === 'saved') return '总结已保存，隐藏未完成；可在“恢复与撤销”中只重试隐藏。';
    const result = operation.result;
    const parts = operation.operation === 'compact' ? ['仅合并已保存，消息可见状态保持原样']
        : Number.isInteger(result?.newHidden) ? [`本次新隐藏 ${result.newHidden} 条`] : ['总结已保存，隐藏已完成'];
    if (Number.isInteger(result?.keptVisible)) parts.push(`保留原文 ${result.keptVisible} 条`);
    if (Number.isFinite(tokens)) parts.push(`当前上下文 ${tokens.toLocaleString()} token`);
    return parts.join('，') + '。';
}

export function automaticStatus(settings, archive, journal, { hasChat, busy, hasWork, chatLength }) {
    if (!settings.enabled) return { label: '已停用', reason: '插件已关闭，不会自动总结。' };
    if (!hasChat) return { label: '等待聊天', reason: '请先打开单人聊天存档。' };
    if (busy) return { label: '处理中', reason: '当前操作结束后更新自动总结状态。' };
    if (archive?.sourceChanged) return { label: '记忆待确认', reason: '原文已改变，可更新记忆，或选择保留现有总结。' };
    if (archive?.branch?.needsRebuild) return { label: '等待更新', reason: '当前分支需要确认可复用的记忆，可在记录中查看。' };
    if (archive?.pendingSummarySave) return { label: '等待保存确认', reason: '请刷新世界书状态，确认上次总结是否已保存。' };
    if (journal?.combinedRestorePending && !journal.messagesRestored) return { label: '等待恢复原文', reason: '总结已撤销，请继续完成本次原文恢复。' };
    if (journal?.phase === 'saved' && !journal.messagesRestored) return { label: '等待隐藏', reason: '总结已保存，请只重试隐藏，无需重新生成。' };
    if (archive?.coverageBlocked) return { label: '输入检查未通过', reason: '自动总结已暂停；调整上下文后手动重试，或从原文重建。' };
    if (!settings.autoEnabled) return { label: '手动模式', reason: '自动总结已关闭，可以按需手动整理。' };
    if (Number.isInteger(archive?.undoAtLength) && chatLength <= archive.undoAtLength) return { label: '等待新消息', reason: '刚撤销的总结不会立即重做，新增消息后再检查。' };
    if (archive?.summaryStillOverThreshold) return { label: '自动已暂停', reason: '总结后仍超阈值，已暂停连续自动总结；可调整设置或仅合并已有总结。' };
    if (!hasWork) return { label: '等待新消息', reason: '没有可处理的旧消息，继续对话后再检查。' };
    return { label: '自动模式', reason: `回复结束后检查上下文，达到 ${Number(settings.threshold).toLocaleString()} token 时自动总结。` };
}

export function tokenComparisonText(metrics, journal) {
    if (!journal || journal.phase !== 'complete' || journal.messagesRestored || metrics?.operationId !== journal.id
        || !Number.isFinite(metrics.after)) return '';
    if (!Number.isFinite(metrics.before)) return `整理后 ${metrics.after.toLocaleString()} token`;
    const difference = metrics.before - metrics.after;
    const change = difference > 0 ? `减少 ${difference.toLocaleString()}` : difference < 0 ? `增加 ${(-difference).toLocaleString()}` : '数量未变';
    return `整理前 ${metrics.before.toLocaleString()} → 整理后 ${metrics.after.toLocaleString()} token，${change}${difference ? ' token' : ''}。`;
}

export function recoveryMatches(chat, operation, epoch) {
    return operation && operation.manualEpoch === (epoch ?? '')
        && historyDigest(chat, operation.sourceEnd) === operation.sourceDigest;
}

export function consecutiveRanges(indices) {
    const ranges = [];
    for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && last[1] + 1 === index) last[1] = index;
        else ranges.push([index, index]);
    }
    return ranges;
}

export function entryRevision(entry, marker) {
    if (!entry) return null;
    return textDigest(JSON.stringify([entry.content, entry.extensions?.[marker]]));
}

export function sourceDescription(record) {
    if (!record) return '暂无总结记录';
    const source = Number.isInteger(record.sourceEnd) && record.sourceEnd >= 0
        ? `总结时到第 ${record.sourceEnd} 层（${record.sourceEnd + 1} 条消息）` : '旧记录未保存总结来源终点';
    const hidden = Number.isInteger(record.coveredTo) && record.coveredTo >= 0
        ? `隐藏计划到第 ${record.coveredTo} 层` : '没有隐藏计划';
    return `${record.undone ? '已撤销 · ' : ''}${source}；${record.operation === 'compact' ? '仅合并，未隐藏消息' : hidden}`;
}
