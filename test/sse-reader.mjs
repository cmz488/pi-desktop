// HTTP chunks and gzip flushes do not define SSE frame boundaries.
export async function readUntil(reader, expected) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(expected)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SSE ended before ${expected}`);
    text += decoder.decode(value, { stream: true });
  }
  return text;
}
