// Sound for the Team Overview graph, synthesised with Web Audio rather than shipped as audio files:
// a few oscillators weigh nothing, stay crisp at any volume, and can be detuned per arrival so a
// burst of tasks lands as a chord instead of the same sample retriggered.
//
// The tuning target is "a soft mallet on glass", not a game blip — short, warm, and quiet enough
// that it reads as feedback rather than notification.

const storageKey = 'taskara.team-overview.sound.v1';

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let unlockBound = false;

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
   if (typeof window === 'undefined') return null;
   return window.AudioContext || (window as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext || null;
}

export function isSoundEnabled(): boolean {
   if (typeof window === 'undefined') return false;
   try {
      return window.localStorage.getItem(storageKey) !== 'off';
   } catch {
      return true;
   }
}

export function setSoundEnabled(enabled: boolean): void {
   if (typeof window === 'undefined') return;
   try {
      window.localStorage.setItem(storageKey, enabled ? 'on' : 'off');
   } catch {
      // A browser that refuses storage still gets sound for this session.
   }
   if (enabled) void ensureContext()?.resume();
}

/**
 * Browsers only allow audio after a gesture, so the context is created lazily and resumed on the
 * first interaction. Until then every play call is a silent no-op — never a thrown promise.
 */
function ensureContext(): AudioContext | null {
   if (audioContext) return audioContext;

   const Constructor = audioContextConstructor();
   if (!Constructor) return null;

   audioContext = new Constructor();
   masterGain = audioContext.createGain();
   masterGain.gain.value = 0.5;
   masterGain.connect(audioContext.destination);
   return audioContext;
}

export function bindSoundUnlock(): () => void {
   if (typeof window === 'undefined' || unlockBound) return () => undefined;
   unlockBound = true;

   const unlock = () => {
      const context = ensureContext();
      if (context?.state === 'suspended') void context.resume();
   };

   window.addEventListener('pointerdown', unlock, { once: true, passive: true });
   window.addEventListener('keydown', unlock, { once: true });
   return () => {
      unlockBound = false;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
   };
}

interface VoiceOptions {
   attack: number;
   decay: number;
   delay: number;
   fromFrequency: number;
   peak: number;
   toFrequency: number;
   type: OscillatorType;
}

function voice(context: AudioContext, destination: GainNode, options: VoiceOptions): void {
   const startAt = context.currentTime + options.delay;
   const oscillator = context.createOscillator();
   const gain = context.createGain();

   oscillator.type = options.type;
   oscillator.frequency.setValueAtTime(options.fromFrequency, startAt);
   oscillator.frequency.exponentialRampToValueAtTime(options.toFrequency, startAt + options.attack + options.decay);

   // Exponential ramps cannot touch zero, hence the near-silent floor either side of the peak.
   gain.gain.setValueAtTime(0.0001, startAt);
   gain.gain.exponentialRampToValueAtTime(options.peak, startAt + options.attack);
   gain.gain.exponentialRampToValueAtTime(0.0001, startAt + options.attack + options.decay);

   oscillator.connect(gain);
   gain.connect(destination);
   oscillator.start(startAt);
   oscillator.stop(startAt + options.attack + options.decay + 0.05);
}

function play(build: (context: AudioContext, destination: GainNode) => void): void {
   if (!isSoundEnabled()) return;

   const context = ensureContext();
   if (!context || !masterGain || context.state !== 'running') return;

   build(context, masterGain);
}

/** The pentatonic steps keep a burst of arrivals consonant however many land at once. */
const arrivalSteps = [1, 1.125, 1.25, 1.5, 1.667];

/**
 * A task landing on the graph: a soft mallet strike with a shimmer partial a fifth above.
 * `index` staggers and re-pitches simultaneous arrivals so they arpeggiate instead of smearing.
 */
export function playTaskArrival(index = 0): void {
   play((context, destination) => {
      const step = arrivalSteps[Math.min(index, arrivalSteps.length - 1)];
      const delay = Math.min(index, 4) * 0.075;
      const root = 523.25 * step; // C5 upward

      voice(context, destination, {
         type: 'sine',
         fromFrequency: root * 0.72,
         toFrequency: root,
         peak: 0.2,
         attack: 0.012,
         decay: 0.38,
         delay,
      });
      voice(context, destination, {
         type: 'triangle',
         fromFrequency: root * 1.5,
         toFrequency: root * 2,
         peak: 0.055,
         attack: 0.008,
         decay: 0.22,
         delay,
      });
   });
}

/** Opening a node: a single dry tick, quieter than an arrival so it never competes with it. */
export function playNodeOpen(): void {
   play((context, destination) => {
      voice(context, destination, {
         type: 'sine',
         fromFrequency: 880,
         toFrequency: 1174.66,
         peak: 0.085,
         attack: 0.006,
         decay: 0.12,
         delay: 0,
      });
   });
}

/** Confirmation that unmuting worked, played the moment the toggle flips on. */
export function playSoundEnabled(): void {
   play((context, destination) => {
      voice(context, destination, {
         type: 'sine',
         fromFrequency: 587.33,
         toFrequency: 880,
         peak: 0.12,
         attack: 0.01,
         decay: 0.26,
         delay: 0,
      });
   });
}
