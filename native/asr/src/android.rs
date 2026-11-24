//! The Android app's way in (android/…/LocalAsr.kt): JNI over lib.rs. Handles are pointers as `long`: the models,
//! loaded once and kept, and a live dictation, freed by `liveFinish` or `liveFree`. A live dictation's calls must all
//! come from one thread; sessions on different threads may share the models. Failures throw java.io.IOException.

use std::fs::File;
use std::os::fd::BorrowedFd;
use std::os::unix::fs::FileExt;
use std::sync::OnceLock;

use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jint, jlong, jstring};

use crate::{Live, Models};

fn throw(env: &mut JNIEnv, message: &str) {
    let _ = env.throw_new("java/io/IOException", message);
}

fn string(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// `len` bytes at `offset` of an open file: an asset stored uncompressed in the APK (AssetFileDescriptor).
fn read_at(fd: jint, offset: jlong, len: jlong) -> std::io::Result<Vec<u8>> {
    // The descriptor stays the caller's: read through a copy of it.
    let file = File::from(unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?);
    let mut buf = vec![0u8; len as usize];
    file.read_exact_at(&mut buf, offset as u64)?;
    Ok(buf)
}

unsafe extern "C" {
    fn sched_setaffinity(pid: i32, size: usize, mask: *const u8) -> i32;
}

/// The phone's big cores (cpu_capacity within 90% of the largest), as a kernel CPU mask; empty when the kernel doesn't
/// say (an emulator). tinyasr's header: run on these and give it that many threads.
fn big_cores() -> &'static [u8; 128] {
    static MASK: OnceLock<[u8; 128]> = OnceLock::new();
    MASK.get_or_init(|| {
        let caps: Vec<u32> = (0..1024)
            .map_while(|i| std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{i}/cpu_capacity")).ok())
            .map(|s| s.trim().parse().unwrap_or(0))
            .collect();
        let max = caps.iter().copied().max().unwrap_or(0);
        let mut mask = [0u8; 128];
        for (i, &c) in caps.iter().enumerate() {
            if max > 0 && c * 10 >= max * 9 {
                mask[i / 8] |= 1 << (i % 8);
            }
        }
        mask
    })
}

/// Keeps the calling thread (and the threads tinyasr starts from it) on the big cores.
fn pin() {
    let mask = big_cores();
    if mask.iter().any(|&b| b != 0) {
        unsafe { sched_setaffinity(0, mask.len(), mask.as_ptr()) };
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_load(mut env: JNIEnv, _: JClass, asr_fd: jint, asr_offset: jlong, asr_len: jlong, vad_fd: jint, vad_offset: jlong, vad_len: jlong) -> jlong {
    let files = read_at(asr_fd, asr_offset, asr_len).and_then(|asr| Ok((asr, read_at(vad_fd, vad_offset, vad_len)?)));
    let (asr, vad) = match files {
        Ok(f) => f,
        Err(e) => {
            throw(&mut env, &e.to_string());
            return 0;
        }
    };
    let big: u32 = big_cores().iter().map(|b| b.count_ones()).sum();
    match crate::load(&asr, &vad, big.max(1) as usize) {
        Ok(m) => Box::into_raw(Box::new(m)) as jlong,
        Err(e) => {
            throw(&mut env, &e);
            0
        }
    }
}

fn models(handle: jlong) -> &'static Models {
    // Loaded once and never freed (LocalAsr.models).
    unsafe { &*(handle as *const Models) }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_liveStart(mut env: JNIEnv, _: JClass, models_handle: jlong, langs: JString) -> jlong {
    pin();
    let langs: String = env.get_string(&langs).map(Into::into).unwrap_or_default();
    Box::into_raw(Box::new(Live::new(models(models_handle), &langs))) as jlong
}

/// 24 kHz PCM16 (the first `length` bytes of `pcm`); the text shown so far if it changed, else null.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_livePush(mut env: JNIEnv, _: JClass, live: jlong, pcm: JByteArray, length: jint) -> jstring {
    let mut buf = vec![0i8; length.max(0) as usize];
    if env.get_byte_array_region(&pcm, 0, &mut buf).is_err() {
        return std::ptr::null_mut();
    }
    let bytes: Vec<u8> = buf.into_iter().map(|b| b as u8).collect();
    let live = unsafe { &mut *(live as *mut Live<'static>) };
    match live.push(&bytes) {
        Some(text) => string(&mut env, &text),
        None => std::ptr::null_mut(),
    }
}

/// The final text; frees the session.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_liveFinish(mut env: JNIEnv, _: JClass, live: jlong) -> jstring {
    let live = unsafe { Box::from_raw(live as *mut Live<'static>) };
    let text = live.finish();
    string(&mut env, &text)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_liveFree(_: JNIEnv, _: JClass, live: jlong) {
    drop(unsafe { Box::from_raw(live as *mut Live<'static>) });
}

/// A saved recording (raw 24 kHz PCM16) from byte `from` on: the full-context pass.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_iliyasone_ciao_LocalAsr_transcribe(mut env: JNIEnv, _: JClass, models_handle: jlong, path: JString, from: jlong, langs: JString) -> jstring {
    pin();
    let path: String = env.get_string(&path).map(Into::into).unwrap_or_default();
    let langs: String = env.get_string(&langs).map(Into::into).unwrap_or_default();
    let pcm = match std::fs::read(&path) {
        Ok(pcm) => pcm,
        Err(e) => {
            throw(&mut env, &e.to_string());
            return std::ptr::null_mut();
        }
    };
    // Whole samples only.
    let from = (from.max(0) as usize).min(pcm.len()) & !1;
    let text = crate::transcribe(models(models_handle), &pcm[from..], &langs);
    string(&mut env, &text)
}
