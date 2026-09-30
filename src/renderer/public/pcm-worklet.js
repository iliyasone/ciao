// Converts the mic stream (the AudioContext runs at 24 kHz) into 40 ms chunks of PCM16,
// each posted with its mean absolute level for the UI.
class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(960);
    this.n = 0;
    this.sum = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.emit();
        this.port.postMessage({ flushed: true });
      }
    };
  }

  emit() {
    if (!this.n) return;
    const pcm = this.buf.slice(0, this.n);
    const level = this.sum / this.n;
    this.n = 0;
    this.sum = 0;
    this.port.postMessage({ pcm: pcm.buffer, level }, [pcm.buffer]);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.buf[this.n++] = v;
        this.sum += Math.abs(v);
        if (this.n === this.buf.length) this.emit();
      }
    }
    return true;
  }
}

registerProcessor("pcm16", Pcm16Processor);
