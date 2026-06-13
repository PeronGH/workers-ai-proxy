/**
 * Re-chunk a UTF-8 byte stream so each enqueued chunk is exactly one line (trailing newline
 * preserved). Each line is passed through `transform`; return `null` to drop the line.
 */
export function transformLines(body: ReadableStream<Uint8Array>, transform: (line: string) => string | null): ReadableStream<Uint8Array> {
	const reader = body.pipeThrough(new TextDecoderStream()).getReader();
	const encoder = new TextEncoder();
	let buffer = '';

	const emit = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
		const out = transform(line);
		if (out !== null) {
			controller.enqueue(encoder.encode(out));
		}
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer) {
					emit(controller, buffer);
				}
				controller.close();
				return;
			}
			buffer += value;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				emit(controller, line + '\n');
			}
		},
		cancel(reason) {
			void reader.cancel(reason);
		},
	});
}
