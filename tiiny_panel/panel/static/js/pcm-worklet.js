/* AudioWorklet: microphone audio → 16 kHz mono Float32 chunks (0.1 s) for the meeting recorder. */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.target;  // sampleRate is a global of the worklet scope
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.size = Math.round(this.target / 10);
    this.out = new Float32Array(this.size);
    this.outN = 0;
    this.paused = false;
    this.port.onmessage = e => {
      if (e.data === 'pause') this.paused = true;
      else if (e.data === 'resume') this.paused = false;
      else if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.outN) this.port.postMessage(this.out.slice(0, this.outN));
    this.out = new Float32Array(this.size);
    this.outN = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || this.paused) return true;
    const n = input[0].length;
    const chans = input.length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < chans; c++) v += input[c][i];
      this.acc += v / chans;  // averaging the samples between outputs is a simple low-pass filter
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.outN++] = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (this.outN === this.size) {
          this.port.postMessage(this.out);
          this.out = new Float32Array(this.size);
          this.outN = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
