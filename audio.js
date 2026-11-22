const MODE_VOICE = {
  impressionism: { pitch: .88, rate: .82 },
  suprematism: { pitch: 1.18, rate: 1.14 },
  minimalism: { pitch: .78, rate: .76 },
  zine: { pitch: 1.15, rate: 1.12 }
};

export class AudioController {
  constructor() {
    this.context = null;
    this.audio = null;
    this.audioUrl = null;
    this.source = null;
    this.analyser = null;
    this.masterGain = null;
    this.oscillators = [];
    this.gains = [];
    this.timer = null;
    this.visualFrame = null;
    this.visualTimer = null;
    this.isPlaying = false;
    this.muted = false;
    this.progressHandler = null;
    this.playStartedAt = 0;
    this.progressOffset = 0;
    this.syntheticDuration = 94;
    this.lastProgressUpdate = 0;
  }

  async play(entry, visualElement, onProgress) {
    this.stop();
    this.muted = false;
    if (!window.AudioContext && !window.webkitAudioContext) throw new Error('Web Audio API недоступен');
    this.context ||= new (window.AudioContext || window.webkitAudioContext)();
    await this.context.resume();
    this.progressHandler = onProgress;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 128;
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 1;
    this.analyser.connect(this.masterGain).connect(this.context.destination);
    this.progressOffset = 0;
    this.playStartedAt = performance.now();

    if (entry.audioBlob) {
      this.audioUrl = URL.createObjectURL(entry.audioBlob);
      this.audio = new Audio(this.audioUrl);
      this.audio.loop = true;
      this.source = this.context.createMediaElementSource(this.audio);
      this.source.connect(this.analyser);
      this.audio.addEventListener('timeupdate', this.reportAudioProgress);
      this.audio.addEventListener('loadedmetadata', this.reportAudioProgress);
      await this.audio.play();
    } else {
      this.startSynth(entry, this.analyser);
    }
    this.isPlaying = true;
    this.visualize(visualElement);
  }

  reportAudioProgress = () => {
    if (this.audio && Number.isFinite(this.audio.duration)) this.progressHandler?.(this.audio.currentTime, this.audio.duration);
  };

  startSynth(entry, destination) {
    const context = this.context;
    const minor = entry.music?.key === 'minor';
    const root = minor ? 146.83 : 164.81;
    const chord = minor ? [1, 1.2, 1.498] : [1, 1.26, 1.498];
    const interval = Math.max(220, 60000 / (entry.analysis?.bpm || entry.bpm || 96) * 2);
    this.oscillators = chord.map((ratio, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index === 1 ? 'sine' : 'triangle';
      oscillator.frequency.value = root * ratio;
      gain.gain.value = index === 0 ? .022 : .012;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      this.gains.push(gain);
      return oscillator;
    });
    let step = 0;
    this.timer = window.setInterval(() => {
      step = (step + 1) % chord.length;
      this.gains.forEach((gain, index) => gain.gain.setTargetAtTime(index === step ? .026 : .012, context.currentTime, index === step ? .09 : .24));
    }, interval);
  }

  visualize(element) {
    if (!element || !this.analyser) return;
    const bins = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.isPlaying) return;
      this.analyser.getByteFrequencyData(bins);
      const level = bins.reduce((total, value) => total + value, 0) / bins.length / 255;
      element.style.setProperty('--audio-pulse', String(1 + level * .09));
      const time = performance.now();
      if (time - this.lastProgressUpdate > 250) {
        if (this.audio && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
          this.progressHandler?.(this.audio.currentTime, this.audio.duration);
        } else if (!this.audio) {
          const current = (this.progressOffset + (performance.now() - this.playStartedAt) / 1000) % this.syntheticDuration;
          this.progressHandler?.(current, this.syntheticDuration);
        }
        this.lastProgressUpdate = time;
      }
      this.visualTimer = window.setTimeout(tick, 80);
    };
    tick();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain && this.context) this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, .02);
  }

  seekProgress(ratio) {
    const value = Math.min(1, Math.max(0, ratio));
    if (this.audio?.duration) this.audio.currentTime = this.audio.duration * value;
    else {
      this.progressOffset = this.syntheticDuration * value;
      this.playStartedAt = performance.now();
      this.progressHandler?.(this.progressOffset, this.syntheticDuration);
    }
  }

  stop() {
    this.isPlaying = false;
    if (this.visualFrame) cancelAnimationFrame(this.visualFrame);
    if (this.visualTimer) clearTimeout(this.visualTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.oscillators.forEach((oscillator) => {
      try { oscillator.stop(); } catch { /* Already stopped. */ }
      oscillator.disconnect();
    });
    this.oscillators = [];
    this.gains = [];
    if (this.audio) {
      this.audio.removeEventListener('timeupdate', this.reportAudioProgress);
      this.audio.removeEventListener('loadedmetadata', this.reportAudioProgress);
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.progressHandler = null;
    document.documentElement.style.setProperty('--audio-pulse', '1');
  }

  speak(text, mode) {
    if (!('speechSynthesis' in window)) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    Object.assign(utterance, MODE_VOICE[mode] || MODE_VOICE.minimalism);
    window.speechSynthesis.speak(utterance);
    return true;
  }
}