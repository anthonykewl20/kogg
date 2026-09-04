import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './markdown';

test('escapes HTML before applying any formatting', () => {
    const result = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!result.html.includes('<script>'), 'raw markup must not survive');
    assert.ok(result.html.includes('&lt;script&gt;'));
});

test('renders fenced code blocks with a language bar, copy slot, and escaped body', () => {
    const result = renderMarkdown('Before\n```ts\nconst a = "<b>";\n```\nAfter');
    assert.equal(result.codeBlocks.length, 1);
    assert.equal(result.codeBlocks[0]!.language, 'ts');
    assert.equal(result.codeBlocks[0]!.code, 'const a = "<b>";');
    assert.match(result.html, /kogg-code/);
    assert.match(result.html, /data-copy-code="0"/u);
    assert.ok(result.html.includes('&quot;&lt;b&gt;&quot;'));
    assert.match(result.html, /<p>Before<\/p>/u);
    assert.match(result.html, /<p>After<\/p>/u);
});

test('supports inline code, bold, italics, and links', () => {
    const result = renderMarkdown('Use `npm test` for **speed** and *grace* per [docs](https://example.com).');
    assert.match(result.html, /<code>npm test<\/code>/u);
    assert.match(result.html, /<strong>speed<\/strong>/u);
    assert.match(result.html, /<em>grace<\/em>/u);
    assert.match(result.html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/u);
});

test('renders bullet and ordered lists', () => {
    const result = renderMarkdown('- first\n- second\n\n1. one\n2. two');
    assert.match(result.html, /<ul><li>first<\/li><li>second<\/li><\/ul>/u);
    assert.match(result.html, /<ol><li>one<\/li><li>two<\/li><\/ol>/u);
});

test('renders headings and drops empty paragraphs', () => {
    const result = renderMarkdown('### Plan\n\nText here');
    assert.match(result.html, /<h4>Plan<\/h4>/u);
    assert.match(result.html, /<p>Text here<\/p>/u);
});

test('multiple code blocks keep distinct copy slots', () => {
    const result = renderMarkdown('```\na\n```\n\n```\nb\n```');
    assert.equal(result.codeBlocks.length, 2);
    assert.match(result.html, /data-copy-code="0"/u);
    assert.match(result.html, /data-copy-code="1"/u);
    assert.equal(result.codeBlocks[1]!.code, 'b');
});
