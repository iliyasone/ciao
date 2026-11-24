//! Ciao's on-device recognizer: tinyasr (github.com/dkaraush/tinyasr, Telegram's, GPL-3.0-or-later) taking the app's
//! audio (24 kHz mono PCM16) and giving text. Shared by the desktop helper (main.rs) and the Android app (JNI).

use std::time::Instant;

pub use tinyasr::{Event, Models, Word};

#[cfg(target_os = "android")]
mod android;

/// The app's audio rate; tinyasr takes 16 kHz.
const IN_RATE: f64 = 24_000.0;
const OUT_RATE: f64 = tinyasr::SAMPLE_RATE as f64;

/// Loads the recognizer (.tzf, uncompressed) and Silero VAD, running the bigger steps on up to `threads` threads.
pub fn load(asr: &[u8], vad: &[u8], threads: usize) -> Result<Models, String> {
    let mut m = Models::load(tinyasr::Files { asr, vad }).map_err(|e| e.to_string())?;
    m.set_threads(threads.max(1));
    Ok(m)
}

/// The language codes to recognize in: those of `wanted` (comma-separated) the model has; none of them, all the model's.
fn langs<'a>(m: &Models, wanted: &'a str) -> Vec<&'a str> {
    let have = m.langs();
    wanted.split(',').map(str::trim).filter(|c| have.iter().any(|h| h.eq_ignore_ascii_case(c))).collect()
}

/// Words as text: a space before each unless it is joined to the one before.
pub fn text(words: &[Word]) -> String {
    let mut s = String::new();
    for w in words {
        if !s.is_empty() && !w.join {
            s.push(' ');
        }
        s.push_str(&w.text);
    }
    s
}

/// A live dictation: audio in as it comes, the text so far out.
pub struct Live<'m> {
    session: tinyasr::Session<'m>,
    resampler: Resampler,
    committed: Vec<Word>,
    open: Vec<Word>,
    tail: Vec<Word>,
}

impl<'m> Live<'m> {
    pub fn new(m: &'m Models, wanted: &str) -> Live<'m> {
        let start = Instant::now();
        let langs = langs(m, wanted);
        // Until the first full pass picks one: the first wanted (the model's own order puts English first).
        let start_lang = langs.first().map(|l| l.to_string()).unwrap_or_default();
        let opt = tinyasr::Options { start_lang, clock: Some(Box::new(move || start.elapsed().as_secs_f64())), ..Default::default() };
        Live { session: tinyasr::Session::new(m, &langs, opt), resampler: Resampler::default(), committed: vec![], open: vec![], tail: vec![] }
    }

    /// 24 kHz PCM16 (little-endian bytes); the text shown so far if it changed.
    pub fn push(&mut self, pcm: &[u8]) -> Option<String> {
        let x = self.resampler.push(pcm);
        if x.is_empty() {
            return None;
        }
        let events = self.session.push(&x);
        self.apply(events).then(|| self.shown())
    }

    /// The speaker is done: the final text.
    pub fn finish(mut self) -> String {
        let x = self.resampler.flush();
        let mut events = self.session.push(&x);
        events.extend(self.session.finish());
        self.apply(events);
        text(&self.committed)
    }

    fn apply(&mut self, events: Vec<Event>) -> bool {
        let mut changed = false;
        for e in events {
            match e {
                Event::Commit(words) => {
                    // The committed words are the ones the partial held.
                    self.committed.extend(words);
                    self.open.clear();
                    self.tail.clear();
                    changed = true;
                }
                Event::Partial { open, tail } => {
                    self.open = open;
                    self.tail = tail;
                    changed = true;
                }
                _ => {}
            }
        }
        changed
    }

    fn shown(&self) -> String {
        let all: Vec<Word> = self.committed.iter().chain(&self.open).chain(&self.tail).cloned().collect();
        text(&all)
    }
}

/// A whole recording (24 kHz PCM16): the full-context pass, more accurate than the live text.
pub fn transcribe(m: &Models, pcm: &[u8], wanted: &str) -> String {
    let mut r = Resampler::default();
    let mut x = r.push(pcm);
    x.extend(r.flush());
    let words: Vec<Word> = tinyasr::Transcription::new(m, &x, &langs(m, wanted), tinyasr::DEFAULT_BEAM).flatten().collect();
    text(&words)
}

/// 24 kHz PCM16 to 16 kHz f32, chunk by chunk: a Hann-windowed sinc low-pass below the new Nyquist frequency,
/// evaluated at every 1.5th input sample. Keeps the input the next outputs still need.
pub struct Resampler {
    history: Vec<f32>,
    /// Position of the next output sample, in input samples from the start of `history`.
    next: f64,
    /// An odd byte left over from the last chunk.
    odd: Option<u8>,
}

impl Default for Resampler {
    fn default() -> Resampler {
        Resampler { history: vec![], next: HALF as f64, odd: None }
    }
}

/// Taps on each side.
const HALF: i64 = 16;
/// Cut-off, as a fraction of the input rate: 90% of the output's Nyquist frequency.
const CUTOFF: f64 = 0.9 * OUT_RATE / 2.0 / IN_RATE;

impl Resampler {
    pub fn push(&mut self, pcm: &[u8]) -> Vec<f32> {
        let mut bytes = pcm;
        let joined;
        if let Some(b) = self.odd.take() {
            joined = [&[b][..], pcm].concat();
            bytes = &joined;
        }
        let pairs = bytes.chunks_exact(2);
        self.odd = pairs.remainder().first().copied();
        self.history.extend(pairs.map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0));
        let x = &self.history;
        let step = IN_RATE / OUT_RATE;
        let mut out = vec![];
        while ((self.next as i64) + HALF) < x.len() as i64 {
            let c = self.next.floor() as i64;
            let frac = self.next - c as f64;
            let (mut sum, mut norm) = (0.0f64, 0.0f64);
            for k in -HALF + 1..=HALF {
                let d = k as f64 - frac;
                let sinc = if d == 0.0 { 2.0 * CUTOFF } else { (2.0 * std::f64::consts::PI * CUTOFF * d).sin() / (std::f64::consts::PI * d) };
                let w = 0.5 + 0.5 * (std::f64::consts::PI * d / HALF as f64).cos();
                let g = sinc * w;
                sum += x[(c + k) as usize] as f64 * g;
                norm += g;
            }
            out.push((sum / norm) as f32);
            self.next += step;
        }
        let keep = ((self.next as i64) - HALF).max(0) as usize;
        self.history.drain(..keep);
        self.next -= keep as f64;
        out
    }

    /// The rest, once the audio has ended (padded with silence).
    pub fn flush(&mut self) -> Vec<f32> {
        self.push(&[0u8; (HALF * 4) as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_keeps_two_samples_of_three() {
        let mut r = Resampler::default();
        let pcm: Vec<u8> = (0..24_000i32).flat_map(|i| (((i as f64 * 0.05).sin() * 8000.0) as i16).to_le_bytes()).collect();
        // fed in odd-sized pieces, as the microphone may give them
        let mut n = 0;
        for c in pcm.chunks(4801) {
            n += r.push(c).len();
        }
        n += r.flush().len();
        assert!((15_990..=16_010).contains(&n), "{n}");
    }

    #[test]
    fn resampler_passes_a_low_tone() {
        // 440 Hz at 24 kHz in, 440 Hz at 16 kHz out, same amplitude
        let pcm: Vec<u8> = (0..24_000).flat_map(|i| (((2.0 * std::f64::consts::PI * 440.0 * i as f64 / 24_000.0).sin() * 16_000.0) as i16).to_le_bytes()).collect();
        let mut r = Resampler::default();
        let y = r.push(&pcm);
        let peak = y[1000..15000].iter().fold(0f32, |a, v| a.max(v.abs()));
        assert!((peak - 16_000.0 / 32768.0).abs() < 0.01, "{peak}");
    }

    #[test]
    fn text_joins_words() {
        let w = |t: &str, join| Word { text: t.into(), start: 0.0, end: 0.0, join };
        assert_eq!(text(&[w("Привет,", false), w("мир.", false), w("ក", false), w("ា", true)]), "Привет, мир. កា");
    }
}
