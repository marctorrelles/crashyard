// Reading a request's body as the SDKs send it: plain, gzip or deflate (the Apple and Android SDKs gzip), up to a size.

export class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const MAX_BODY = 20 * 1024 * 1024 // decompressed; Sentry's own limit is larger, but nothing here needs more

export async function readBody(request: Request, max = MAX_BODY): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase()
  let stream: ReadableStream<Uint8Array> = request.body
  const decompress = (format: 'gzip' | 'deflate') =>
    new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = stream.pipeThrough(decompress('gzip'))
  else if (encoding === 'deflate') stream = stream.pipeThrough(decompress('deflate'))
  else if (encoding && encoding !== 'identity') throw new BodyError(`content encoding ${encoding} isn't supported`, 415)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new BodyError('the body is too large', 413)
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BodyError) throw error
    throw new BodyError('the body could not be decompressed', 400)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}
