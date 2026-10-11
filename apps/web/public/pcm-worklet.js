// Linear sample-rate conversion; accumulates 80 ms of mono PCM16 at 16 kHz.
class VizliPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.position = 0;
    this.pending = [];
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) this.samples.push(sample);
    const step = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position),
        f = this.position - i;
      const sample = this.samples[i] * (1 - f) + this.samples[i + 1] * f;
      this.pending.push(
        Math.round(
          Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
        ),
      );
      this.position += step;
      if (this.pending.length === 1280) {
        const pcm = new Int16Array(this.pending);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.pending = [];
      }
    }
    const consumed = Math.min(
      Math.floor(this.position),
      this.samples.length - 1,
    );
    this.samples.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor("vizli-pcm", VizliPCM);
