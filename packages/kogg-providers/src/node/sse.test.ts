import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CodexStreamRejection, SseIdleTimeoutError, SseTotalTimeoutError,
    codexStreamText, consumeSseStream, handleCodexStreamEvent, type CodexStreamState
} from './sse';

function streamFrom(chunks: string[], options: { holdOpen?: boolean } = {}): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            if (!options.holdOpen) controller.close();
        }
    });
}

test('consumes SSE frames across chunk boundaries', async () => {
    const events: string[] = [];
    // The frame is split mid-JSON to prove the buffer carries partial data.
    await consumeSseStream(streamFrom(['data: {"type":"par', 'tial"}\n\ndata: {"type":"second"}\n\n']), {
        onEvent: data => { events.push(data); }
    });
    assert.deepEqual(events, ['{"type":"partial"}', '{"type":"second"}']);
});

test('stops the stream when the handler reports completion', async () => {
    const events: string[] = [];
    await consumeSseStream(streamFrom(['data: a\n\ndata: b\n\ndata: c\n\ndata: d\n\n'], { holdOpen: true }), {
        onEvent: data => {
            events.push(data);
            return data === 'c' ? 'stop' : undefined;
        }
    });
    assert.deepEqual(events, ['a', 'b', 'c']);
});

test('joins multi-line data fields of one frame', async () => {
    const events: string[] = [];
    await consumeSseStream(streamFrom(['data: line1\ndata: line2\n\n']), { onEvent: data => { events.push(data); } });
    assert.deepEqual(events, ['line1\nline2']);
});

test('raises the idle timeout when the stream stalls', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode('data: first\n\n')); /* never closes */ }
    });
    await assert.rejects(() => consumeSseStream(body, { onEvent: () => undefined, idleTimeoutMs: 80 }), SseIdleTimeoutError);
});

test('raises the total timeout even while frames keep arriving', async () => {
    const encoder = new TextEncoder();
    let timer: NodeJS.Timeout | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            timer = setInterval(() => controller.enqueue(encoder.encode('data: tick\n\n')), 20);
        }
    });
    try {
        await assert.rejects(() => consumeSseStream(body, { onEvent: () => undefined, idleTimeoutMs: 500, totalTimeoutMs: 120 }), SseTotalTimeoutError);
    } finally {
        if (timer) clearInterval(timer);
    }
});

function state(): CodexStreamState {
    return { parts: [], sawDelta: false };
}

test('codex deltas accumulate and the terminal done event does not duplicate them', () => {
    const stream = state();
    assert.equal(handleCodexStreamEvent('{"type":"response.output_text.delta","delta":"Hel"}', stream), undefined);
    assert.equal(handleCodexStreamEvent('{"type":"response.output_text.delta","delta":"lo"}', stream), undefined);
    const outcome = handleCodexStreamEvent('{"type":"response.output_text.done","text":"Hello"}', stream);
    assert.equal(outcome, 'stop');
    assert.equal(codexStreamText(stream), 'Hello');
});

test('codex done without deltas pushes the complete text exactly once', () => {
    const stream = state();
    assert.equal(handleCodexStreamEvent('{"type":"response.output_text.done","text":"Final reply"}', stream), 'stop');
    assert.equal(codexStreamText(stream), 'Final reply');
});

test('codex completed event carries the text when done never arrives', () => {
    const stream = state();
    const outcome = handleCodexStreamEvent('{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Via completed"}]}]}}', stream);
    assert.equal(outcome, 'stop');
    assert.equal(codexStreamText(stream), 'Via completed');
});

test('codex failure events raise a stream rejection with the provider detail', () => {
    const stream = state();
    assert.throws(() => handleCodexStreamEvent('{"type":"response.failed","item":{"type":"error","message":"model unsupported"}}', stream), CodexStreamRejection);
    assert.match(stream.error ?? '', /model unsupported/u);
});

test('malformed codex frames are skipped without breaking the stream', () => {
    const stream = state();
    assert.equal(handleCodexStreamEvent('not json', stream), undefined);
    assert.equal(handleCodexStreamEvent('{"type":"response.output_text.delta","delta":"ok"}', stream), undefined);
    assert.equal(codexStreamText(stream), 'ok');
});
