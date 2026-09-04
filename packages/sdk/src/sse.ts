/**
 * A text/event-stream parser over a fetch body, yielding one frame per
 * event. Works in Node 18+ and every modern browser; `EventSource` is not
 * used because it cannot send headers or be cancelled mid-frame cleanly.
 */
export interface SseFrame {
  event: string
  data: string
  id: string | null
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const frame = parseFrame(raw)
        if (frame) yield frame
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message'
  let id: string | null = null
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (!data.length && event === 'message') return null
  return { event, data: data.join('\n'), id }
}
