// Minimal, dependency-free, escape-first Markdown renderer for assistant chat
// replies. Everything is HTML-escaped before any formatting is applied, so
// model output can never inject markup. Supported: fenced code blocks, inline
// code, bold, italics, links, unordered/ordered lists, headings, paragraphs.
//
// diagnostic-exempt: pure string formatting with no network, process, or
// storage effects; malformed input is escaped, never thrown.
// observability-exempt: pure rendering helper whose only failure surface is
// the rendered string itself.

export interface RenderedCodeBlock {
    readonly language: string;
    readonly code: string;
}

export interface MarkdownRender {
    readonly html: string;
    readonly codeBlocks: readonly RenderedCodeBlock[];
}

export function renderMarkdown(source: string): MarkdownRender {
    const codeBlocks: RenderedCodeBlock[] = [];
    const segments = source.split(/```/u);
    let html = '';
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        if (index % 2 === 1) {
            // Fenced block: the first line may carry a language tag.
            const newline = segment.indexOf('\n');
            const language = (newline === -1 ? segment : segment.slice(0, newline)).trim();
            const code = newline === -1 ? '' : segment.slice(newline + 1).replace(/\n$/u, '');
            const slot = codeBlocks.length;
            codeBlocks.push({ language, code });
            html += `<div class="kogg-code"><div class="kogg-code-bar"><span>${escapeHtml(language || 'code')}</span><button type="button" class="kogg-code-copy" data-copy-code="${slot}" aria-label="Copy code">Copy</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
            continue;
        }
        html += renderInlineSegment(segment);
    }
    return { html, codeBlocks };
}

function renderInlineSegment(segment: string): string {
    const lines = segment.split('\n');
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | undefined;
    const flushParagraph = (): void => {
        if (paragraph.length) { blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; }
    };
    const flushList = (): void => {
        if (list) { blocks.push(`<${list.ordered ? 'ol' : 'ul'}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.ordered ? 'ol' : 'ul'}>`); list = undefined; }
    };
    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
        const bullet = /^[-*]\s+(.*)$/u.exec(line.trim());
        const ordered = /^\d+[.)]\s+(.*)$/u.exec(line.trim());
        if (bullet) { flushParagraph(); if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push(bullet[1]!); continue; }
        if (ordered) { flushParagraph(); if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; } list.items.push(ordered[1]!); continue; }
        flushList();
        if (heading) { flushParagraph(); blocks.push(`<h4>${inline(heading[2]!)}</h4>`); continue; }
        if (!line.trim()) { flushParagraph(); continue; }
        paragraph.push(line);
    }
    flushList();
    flushParagraph();
    return blocks.join('');
}

function inline(text: string): string {
    const escaped = escapeHtml(text);
    return escaped
        .replace(/`([^`]+)`/gu, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/gu, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
