// The overview displays a short plain-text excerpt. Never mount model markup there.
export function memoryExcerpt(content) {
    const text = String(content ?? '').replace(/<(script|style|summary)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?[a-z][\w:-]*(?:\s[^>]*?)?\s*\/?>/gi, ' ')
        .replace(/^[ \t]*(?:#{1,6}\s+|[-*]\s+)/gm, '').replace(/\*\*|__/g, '')
        .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, key) =>
            ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" })[key])
        .replace(/\s+/g, ' ').trim();
    const excerpt = Array.from(text.slice(0, 322));
    return excerpt.length > 160 ? excerpt.slice(0, 160).join('') + '…' : text;
}

// Use the host's shared, maintained parser and sanitizer. Never inject model
// HTML without sanitization; old hosts fall back to plain text.
export function renderSummaryReader(node, source, libraries = {}) {
    const text = String(source ?? '');
    node.replaceChildren();
    node.classList.remove('als-reader-plain');
    if (!text.trim()) {
        node.textContent = '当前没有注入正文。可选择历史记录查看之前的总结。';
        return;
    }
    if (!libraries.DOMPurify?.sanitize) {
        node.textContent = text;
        node.classList.add('als-reader-plain');
        return;
    }
    try {
        const html = libraries.showdown?.Converter
            ? new libraries.showdown.Converter({ tables: true, simpleLineBreaks: true }).makeHtml(text)
            : text;
        const fragment = libraries.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'details', 'summary', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i',
                'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
            ALLOWED_ATTR: ['open'],
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
            RETURN_DOM_FRAGMENT: true,
        });
        node.append(fragment);
        for (const details of node.querySelectorAll('details')) details.open = true;
    } catch {
        node.textContent = text;
        node.classList.add('als-reader-plain');
    }
}
