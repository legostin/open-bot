// The person's voice while they show an agent a task: the microphone's level (the ring on the mic button) and the
// words, cut into short recordings that go to the hub to be written down. A pause of 0.8 s after speech ends a
// recording, 20 s at most; a recording without speech is dropped, and one still without words starts over every
// 1.5 s, so each recording begins close to the words (the hub places them by when they began).

const TICK_MS = 50;
const SILENCE_MS = 800;
const MAX_MS = 20_000;
const IDLE_MS = 1_500;
/** The first readings learn how loud the room is. */
const CALIBRATE_MS = 500;
/** Speech is sound above the threshold this many readings in a row: keys and clicks are shorter. */
const VOICED_TICKS = 3;
/** A recording with less speech than this is dropped. */
const MIN_SPEECH_MS = 300;
/** A recording without words starts over only after this long without any sound (not in the middle of a word). */
const QUIET_MS = 250;

/** What MediaRecorder is asked for, best first (Chrome and Firefox: WebM/Opus; Safari: MP4/AAC). */
export const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];

export function pickMimeType(supported: (type: string) => boolean): string | undefined {
  return MIME_TYPES.find((m) => {
    try {
      return supported(m);
    } catch {
      return false;
    }
  });
}

/** One recording with speech in it. */
export interface Segment {
  blob: Blob;
  mimeType: string;
  /** When the words began (Date.now()). */
  wordsAt: number;
}

export type VoiceProblem = "unavailable" | "denied" | "missing" | "failed";

export class VoiceError extends Error {
  readonly problem: VoiceProblem;
  constructor(problem: VoiceProblem, message?: string) {
    super(message || problem);
    this.problem = problem;
  }
}

export interface Voice {
  /** Stop at once: what is being said now is dropped. */
  stop(): void;
  /** Stop listening: what is being said now goes to `upload`; resolves once it has been handed over. */
  finish(): Promise<void>;
}

/**
 * Decides, reading by reading, what becomes of the recording going on now: keep it, send it, or drop it and start
 * a new one. The room's noise floor carries over from one recording to the next. Pure: times come from the caller.
 */
export class Segmenter {
  private floor = -60;
  private calibrated = false;
  private readonly began: number;
  private start: number;
  private last: number;
  private run = 0;
  private runStart = 0;
  private speech = 0;
  private lastVoiced = 0;
  private lastLoud: number | null = null;
  /** When the words of this recording began (null: no speech yet). */
  wordsAt: number | null = null;

  constructor(now: number) {
    this.began = now;
    this.start = now;
    this.last = now;
  }

  /** The level that counts as speech now, in dBFS: a little above the room's noise. */
  threshold(): number {
    return Math.min(-30, Math.max(-50, this.floor + 14));
  }

  /** This recording has enough speech to send. */
  get voiced(): boolean {
    return this.speech >= MIN_SPEECH_MS;
  }

  /** A new recording starts at `now`. */
  restart(now: number): void {
    this.start = now;
    this.run = 0;
    this.speech = 0;
    this.lastLoud = null;
    this.wordsAt = null;
  }

  /** One reading of the microphone (dBFS) at `now`. */
  push(db: number, now: number): "keep" | "send" | "drop" {
    const dt = Math.min(200, Math.max(0, now - this.last));
    this.last = now;
    if (!this.calibrated) {
      // Nobody speaks in the first half second: that is the room.
      this.floor += (Math.max(-90, db) - this.floor) * 0.3;
      if (now - this.began >= CALIBRATE_MS) this.calibrated = true;
      return "keep";
    }
    const loud = db > this.threshold();
    if (loud) {
      if (this.run === 0) this.runStart = now;
      this.run++;
      this.lastLoud = now;
      // A steady noise (a fan, a road) is taken in slowly; speech has pauses and keeps above it.
      this.floor += (db - this.floor) * 0.004;
    } else {
      this.run = 0;
      this.floor += (Math.max(-90, db) - this.floor) * (db < this.floor ? 0.3 : 0.02);
    }
    if (this.run >= VOICED_TICKS) {
      if (this.run === VOICED_TICKS) {
        this.speech += now - this.runStart + dt;
        this.wordsAt ??= this.runStart;
      } else this.speech += dt;
      this.lastVoiced = now;
    }
    const age = now - this.start;
    if (this.voiced) return now - this.lastVoiced >= SILENCE_MS || age >= MAX_MS ? "send" : "keep";
    // No words yet: start over now and then (never in the middle of a sound that may be the first word).
    const quiet = this.lastLoud === null || now - this.lastLoud >= QUIET_MS;
    return age >= MAX_MS || (quiet && age >= IDLE_MS) ? "drop" : "keep";
  }
}

/** dBFS of the samples (silence → -100). */
function dbOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/** 0…1 for the ring: -60 dBFS is nothing, -15 dBFS is full. */
const levelOf = (db: number) => Math.min(1, Math.max(0, (db + 60) / 45));

/** A blob as base64 (no "data:" prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** Events that count as the person's gesture: an audio context the browser held back may start then. */
const WAKE_EVENTS = ["pointerdown", "pointerup", "keydown", "touchend"];

/**
 * Listen to the microphone. Rejects with a VoiceError when there is none or it is not allowed. `upload` gets each
 * recording with speech; it should not throw.
 */
export async function startVoice(opts: { onLevel(level: number): void; upload(seg: Segment): Promise<void> }): Promise<Voice> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const AC: typeof AudioContext | undefined = typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as any).webkitAudioContext);
  // No microphone API (a page over plain http, an old browser) or no recorder.
  if (!media?.getUserMedia || typeof MediaRecorder === "undefined" || !AC) throw new VoiceError("unavailable");
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: true });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const problem: VoiceProblem =
      name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "missing" : "failed";
    throw new VoiceError(problem, (e as Error)?.message);
  }

  let ctx: AudioContext;
  let analyser: AnalyserNode;
  let source: MediaStreamAudioSourceNode;
  try {
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
  } catch (e) {
    stream.getTracks().forEach((tr) => tr.stop());
    throw new VoiceError("failed", (e as Error)?.message);
  }
  // A context made outside a gesture may start suspended: the next tap or key wakes it.
  const wake = () => {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  };
  wake();
  WAKE_EVENTS.forEach((n) => window.addEventListener(n, wake, true));

  const mimeType = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
  const samples = new Float32Array(analyser.fftSize);
  const seg = new Segmenter(Date.now());
  let level = 0;
  let stopped = false;

  type Take = { rec: MediaRecorder; chunks: Blob[] };
  const begin = (): Take => {
    // Speech needs little: a light upload on a phone's data.
    const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.start(1000);
    return { rec, chunks };
  };

  /** End a recording; kept, it goes to `upload` once the recorder has handed over its last data. */
  const end = (take: Take, keep: boolean, wordsAt: number | null): Promise<void> =>
    new Promise<void>((resolve) => {
      if (take.rec.state === "inactive") return resolve();
      take.rec.onstop = () => {
        resolve();
        if (!keep || wordsAt === null || !take.chunks.length) return;
        const type = take.rec.mimeType || mimeType || take.chunks[0].type || "audio/webm";
        void opts.upload({ blob: new Blob(take.chunks, { type }), mimeType: type, wordsAt }).catch(() => {});
      };
      take.rec.onerror = () => resolve();
      try {
        take.rec.stop();
      } catch {
        resolve();
      }
    });

  let take: Take;
  try {
    take = begin();
  } catch (e) {
    WAKE_EVENTS.forEach((n) => window.removeEventListener(n, wake, true));
    stream.getTracks().forEach((tr) => tr.stop());
    void ctx.close().catch(() => {});
    throw new VoiceError("failed", (e as Error)?.message);
  }

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const db = dbOf(samples);
    level = Math.max(levelOf(db), level * 0.8);
    opts.onLevel(level);
    const now = Date.now();
    const what = seg.push(db, now);
    if (what === "keep") return;
    const old = take;
    const wordsAt = seg.wordsAt;
    // The next recording starts before the last one stops: no word falls between them.
    try {
      take = begin();
    } catch {
      /* the stream ended: keep the old one going until stop */
      return;
    }
    seg.restart(now);
    void end(old, what === "send", wordsAt);
  }, TICK_MS);

  const close = () => {
    stopped = true;
    clearInterval(timer);
    WAKE_EVENTS.forEach((n) => window.removeEventListener(n, wake, true));
    opts.onLevel(0);
  };
  const release = () => {
    stream.getTracks().forEach((tr) => tr.stop());
    try {
      source.disconnect();
    } catch {
      /* already */
    }
    void ctx.close().catch(() => {});
  };

  return {
    stop() {
      if (stopped) return;
      close();
      void end(take, false, null);
      release();
    },
    async finish() {
      if (stopped) return;
      close();
      const last = end(take, seg.voiced, seg.wordsAt);
      // The recorder hands over its data within milliseconds; the microphone goes off right after.
      await Promise.race([last, new Promise((r) => setTimeout(r, 1000))]);
      release();
    },
  };
}
