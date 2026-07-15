/** Browser-side gzip for session chunks. No uncompressed fallback. */

export function gzipSupported(): boolean {
  try {
    return typeof CompressionStream !== 'undefined';
  } catch {
    return false;
  }
}

export async function gzip(text: string): Promise<Uint8Array | null> {
  if (!gzipSupported()) return null;
  try {
    const compression = new CompressionStream('gzip');
    const writer = compression.writable.getWriter();
    const output = new Response(compression.readable).arrayBuffer();
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
    return new Uint8Array(await output);
  } catch {
    return null;
  }
}
