// 曲の一部を切り出して WAV にする（2026-10-06、曲づくり → Director の音声）。ブラウザの中だけで処理し、GPU もサーバーも使わない。
// Director の音声は 68 秒まで（DIRECTOR_MAX_AUDIO_SECONDS）。曲は 1 番だけでも 100 秒前後あるので、使う範囲（サビなど）を選んで渡す。
// 端は 0.3 秒のフェードでつなぎ目のプツッという音を消す。16bit PCM・元のサンプルレート・ステレオのまま。

export async function clipToWav(source: Blob, startS: number, lengthS: number, name: string): Promise<{ file: File; durationS: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await source.arrayBuffer());
    const sr = buf.sampleRate;
    const start = Math.max(0, Math.min(buf.duration, startS));
    const end = Math.max(start, Math.min(buf.duration, start + lengthS));
    const from = Math.floor(start * sr);
    const n = Math.max(1, Math.floor((end - start) * sr));
    const ch = Math.min(2, buf.numberOfChannels);
    const fade = Math.min(Math.floor(0.3 * sr), Math.floor(n / 4));
    const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const writeStr = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
    writeStr(0, "RIFF");
    data.setUint32(4, 36 + n * ch * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, ch, true);
    data.setUint32(24, sr, true);
    data.setUint32(28, sr * ch * 2, true);
    data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true);
    writeStr(36, "data");
    data.setUint32(40, n * ch * 2, true);
    const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      const g = fade > 0 ? Math.min(1, i / fade, (n - 1 - i) / fade) : 1;
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, chans[c][from + i] * g));
        data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return { file: new File([data.buffer], name, { type: "audio/wav" }), durationS: n / sr };
  } finally {
    void ctx.close();
  }
}
