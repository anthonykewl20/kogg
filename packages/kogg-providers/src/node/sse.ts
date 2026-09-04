// Shared incremental SSE consumer for provider chat streams. The provider
// endpoints keep the connection open after the reply text has fully arrived,
// so callers must be able to stop reading as soon as they have a complete
// answer instead of waiting for the server to close.
//
// diagnostic-exempt: transport-only decoding; every terminal failure (stall,
// timeout, stream rejection) is logged and surfaced by the [kogg:providers]
// chat callers, which own the operational outcome.

export interface SseStreamOptions {
    onEvent(data: string): void | 'stop';
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
}

export class SseIdleTimeoutError extends Error {
    constructor(idleTimeoutMs: number) { super(`The provider stream stalled (no data for ${Math.round(idleTimeoutMs / 1000)} seconds).`); this.name = 'SseIdleTimeoutError'; }
}

export class SseTotalTimeoutError extends Error {
    constructor(totalTimeoutMs: number) { super(`The provider stream exceeded ${Math.round(totalTimeoutMs / 1000)} seconds.`); this.name = 'SseTotalTimeoutError'; }
}

export async function consumeSseStream(body: ReadableStream<Uint8Array>, options: SseStreamOptions): Promise<void> {
    const idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
    const totalTimeoutMs = options.totalTimeoutMs;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let rejectExternal: ((error: Error) => void) | undefined;
    const clearTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
    };
    const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            rejectExternal?.(new SseIdleTimeoutError(idleTimeoutMs));
        }, idleTimeoutMs);
    };

    try {
        await new Promise<void>((resolve, reject) => {
            rejectExternal = reject;
            if (totalTimeoutMs) {
                totalTimer = setTimeout(() => {
                    void reader.cancel().catch(() => undefined);
                    reject(new SseTotalTimeoutError(totalTimeoutMs));
                }, totalTimeoutMs);
            }
            armIdle();
            const pump = async (): Promise<void> => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        armIdle();
                        buffer += decoder.decode(value, { stream: true });
                        // SSE frames are separated by a blank line; each frame
                        // may carry several `data:` lines joined with newlines.
                        let separator = buffer.indexOf('\n\n');
                        while (separator !== -1) {
                            const frame = buffer.slice(0, separator);
                            buffer = buffer.slice(separator + 2);
                            const data = frame.split('\n')
                                .filter(line => line.startsWith('data:'))
                                .map(line => line.slice(5).trimStart())
                                .join('\n');
                            if (data) {
                                if (options.onEvent(data) === 'stop') { clearTimers(); resolve(); return; }
                            }
                            separator = buffer.indexOf('\n\n');
                        }
                    }
                    // Emit any final frame terminated by stream close rather
                    // than a blank line.
                    const tail = buffer.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                    if (tail) options.onEvent(tail);
                    clearTimers();
                    resolve();
                } catch (error) {
                    clearTimers();
                    // observability-exempt: rejecting the awaited promise hands
                    // the failure to the [kogg:providers] chat caller, which
                    // logs and surfaces the terminal outcome.
                    reject(error instanceof Error ? error : new Error('The provider stream could not be read.'));
                }
            };
            void pump();
        });
    } finally {
        clearTimers();
        // The timers cancel the reader on timeout; this release covers the
        // normal completion and early-stop paths.
        void reader.cancel().catch(() => undefined);
    }
}

// Extracts the model-visible text from one Codex (OpenAI Responses API) SSE
// `data:` payload. Deltas and the terminal done/completed events describe the
// same text, so the state suppresses the terminal copy when deltas already
// carried it, and stops the stream as soon as the reply is complete — the
// ChatGPT backend does not reliably send `response.completed`.
export interface CodexStreamState {
    readonly parts: string[];
    sawDelta: boolean;
    error?: string;
}

export function codexStreamText(state: CodexStreamState): string {
    return state.parts.join('').trim();
}

export function handleCodexStreamEvent(raw: string, state: CodexStreamState): 'stop' | void {
    let event: {
        type?: string; delta?: unknown; text?: unknown;
        response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }> };
        item?: { type?: string; message?: unknown };
    };
    try { event = JSON.parse(raw); } catch { return; /* observability-exempt: malformed SSE frames are skipped; the terminal no-text refusal is the observable outcome. */ }
    if (event.type === 'response.failed' || event.item?.type === 'error') {
        state.error = typeof event.item?.message === 'string' ? event.item.message.slice(0, 200) : 'the model stream failed';
        throw new CodexStreamRejection(state.error);
    }
    if (event.type === 'response.output_text.delta') {
        const delta = typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : '';
        if (delta) { state.parts.push(delta); state.sawDelta = true; }
        return;
    }
    if (event.type === 'response.output_text.done' && typeof event.text === 'string' && event.text.trim()) {
        if (!state.sawDelta) state.parts.push(event.text.trim());
        return 'stop';
    }
    if (event.type === 'response.completed') {
        const message = (event.response?.output ?? []).find(item => item.type === 'message');
        const output = (message?.content ?? []).find(item => item.type === 'output_text');
        if (typeof output?.text === 'string' && output.text.trim()) {
            if (!state.sawDelta) state.parts.push(output.text.trim());
            return 'stop';
        }
    }
}

export class CodexStreamRejection extends Error {
    constructor(detail: string) { super(detail); this.name = 'CodexStreamRejection'; }
}
