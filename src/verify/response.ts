/** Bound memory while reading, rather than checking only after buffering an entire response. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  } finally { await response.body?.cancel().catch(() => {}); }
}
