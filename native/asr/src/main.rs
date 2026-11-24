//! ciao-asr: the desktop app's on-device recognizer as a helper process, one dictation or recording per process.
//!
//!     ciao-asr <model.tzf> <silero_vad.onnx> [threads]
//!
//! Loads the models, says it is ready, then takes one job from stdin, one command per line:
//!
//!     live <langs>        a live dictation; langs: comma-separated codes ("ru,en"), those the model lacks are ignored,
//!                         none left: all of the model's
//!     file <langs>        a whole recording, transcribed once it has all arrived (more accurate)
//!     audio <base64>      24 kHz mono PCM16, little-endian, any length
//!     finish              the audio has ended
//!
//! and answers on stdout, one JSON object per line:
//!
//!     {"type":"ready","langs":["en","ru","uk"]}
//!     {"type":"text","text":"…"}      live: the text so far, whenever it changed (it may change words already shown)
//!     {"type":"final","text":"…"}     after finish; then the process exits
//!     {"type":"error","message":"…"}  then the process exits with 1
//!
//! stdin closing before finish ends the process without an answer.
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        fail("usage: ciao-asr <model.tzf> <silero_vad.onnx> [threads]");
    }
    let threads = args.get(3).and_then(|t| t.parse().ok()).unwrap_or(1);
    let read = |p: &str| std::fs::read(p).unwrap_or_else(|e| fail(&format!("{p}: {e}")));
    let models = ciao_asr::load(&read(&args[1]), &read(&args[2]), threads).unwrap_or_else(|e| fail(&e));
    let langs: Vec<String> = models.langs().iter().map(|l| format!("\"{}\"", escape(l))).collect();
    say(&format!("{{\"type\":\"ready\",\"langs\":[{}]}}", langs.join(",")));

    enum Job<'m> {
        None,
        Live(ciao_asr::Live<'m>),
        File(String, Vec<u8>),
    }
    let mut job = Job::None;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { return };
        let (cmd, arg) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        match cmd {
            "live" => job = Job::Live(ciao_asr::Live::new(&models, arg)),
            "file" => job = Job::File(arg.to_string(), vec![]),
            "audio" => {
                let pcm = base64(arg).unwrap_or_else(|| fail("audio: not base64"));
                match &mut job {
                    Job::Live(live) => {
                        if let Some(t) = live.push(&pcm) {
                            say(&format!("{{\"type\":\"text\",\"text\":\"{}\"}}", escape(&t)));
                        }
                    }
                    Job::File(_, all) => all.extend_from_slice(&pcm),
                    Job::None => fail("audio before live or file"),
                }
            }
            "finish" => {
                let text = match std::mem::replace(&mut job, Job::None) {
                    Job::Live(live) => live.finish(),
                    Job::File(langs, pcm) => ciao_asr::transcribe(&models, &pcm, &langs),
                    Job::None => String::new(),
                };
                say(&format!("{{\"type\":\"final\",\"text\":\"{}\"}}", escape(&text)));
                return;
            }
            "" => {}
            _ => fail(&format!("unknown command {cmd}")),
        }
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // The app went away: nothing to answer to.
    if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn fail(message: &str) -> ! {
    say(&format!("{{\"type\":\"error\",\"message\":\"{}\"}}", escape(message)));
    std::process::exit(1);
}

/// For a JSON string.
fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

fn base64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let s = s.trim_end().trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        match chunk.len() {
            4 => out.extend_from_slice(&bytes),
            3 => out.extend_from_slice(&bytes[..2]),
            2 => out.push(bytes[0]),
            _ => return None,
        }
    }
    Some(out)
}
