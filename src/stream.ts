/**
 * Parse an SSE byte stream into the JSON payloads of its `data:` events. Blank lines, comments,
 * and the `[DONE]` sentinel are skipped; each remaining payload is JSON-parsed and yielded.
 */
export async function* parseSseData<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
	const reader = body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += value;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) continue;
				const payload = trimmed.slice('data:'.length).trim();
				if (payload === '' || payload === '[DONE]') continue;
				yield JSON.parse(payload) as T;
			}
		}
	} finally {
		void reader.cancel();
	}
}

/**
 * Serialize an async stream of JSON values as an SSE byte stream, rendering each item into a frame
 * with `format`.
 */
export function sseFromItems<T>(items: AsyncIterable<T>, format: (item: T) => string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = items[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const result = await iterator.next();
			if (result.done) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(format(result.value)));
		},
		cancel(reason) {
			void iterator.return?.(reason);
		},
	});
}
