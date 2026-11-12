package dev.iliyasone.ciao

/**
 * Keeps long silence out of what a provider is sent: live transcription is billed per second of
 * audio, a pause to think included. A port of src/core/silence.ts.
 *
 * The audio is judged in frames of 40 ms, however it arrives (the microphone gives 40 ms chunks, a
 * replay of a recording more at once). A frame is quiet when it is below [QUIET_LEVEL] and at least 18 dB below the loudest frame of the
 * dictation so far, so a soft voice or a weak microphone is never taken for silence: until
 * something loud is heard, nothing is. Quiet audio still goes out for [KEEP_AFTER_MS] after the last
 * sound, and the [KEEP_BEFORE_MS] before the next sound follow with it: word endings, breaths and
 * soft first syllables stay, and the provider hears a pause of about 1.5 s where a longer one was.
 * Steady noise above [QUIET_LEVEL] (music, a fan) is sent whole.
 */
class SilenceGate {
    /** Audio left out so far, in bytes: what is still held would go out only with a sound to come. */
    @Volatile var skipped = 0L
        private set
    private var dropped = 0L
    private var loudest = 0.0
    private var quietMs = 0.0
    /** The latest quiet audio not sent, at most [KEEP_BEFORE_MS] of it. */
    private val before = ArrayDeque<ByteArray>()
    private var beforeBytes = 0

    /** The audio to send now, in order and as copies: none in a long silence, the chunk itself, or parts of it and the quiet just before them. */
    fun pass(pcm: ByteArray, length: Int = pcm.size): List<ByteArray> {
        val out = mutableListOf<ByteArray>()
        // Frames to send that follow one another go out as one piece, from here.
        var from = 0
        var at = 0
        while (at < length) {
            val end = minOf(at + FRAME_BYTES, length)
            val level = Recorder.level(pcm, at, end - at)
            loudest = maxOf(loudest, level)
            if (level >= minOf(QUIET_LEVEL, loudest / LOUDEST_RATIO)) {
                quietMs = 0.0
                beforeBytes = 0
                // Frames were held until now, so no piece is open.
                out.addAll(before)
                before.clear()
            } else {
                quietMs += (end - at) / BYTES_PER_MS
                if (quietMs > KEEP_AFTER_MS) {
                    if (at > from) out.add(pcm.copyOfRange(from, at))
                    from = end
                    before.addLast(pcm.copyOfRange(at, end))
                    beforeBytes += end - at
                    while (beforeBytes > KEEP_BEFORE_MS * BYTES_PER_MS) {
                        val oldest = before.removeFirst().size
                        beforeBytes -= oldest
                        dropped += oldest
                    }
                }
            }
            at = end
        }
        if (length > from) out.add(pcm.copyOfRange(from, length))
        skipped = dropped + beforeBytes
        return out
    }

    companion object {
        const val QUIET_LEVEL = 200.0
        private const val LOUDEST_RATIO = 8
        const val KEEP_AFTER_MS = 1000
        const val KEEP_BEFORE_MS = 500
        const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000.0
        private const val FRAME_BYTES = Recorder.CHUNK_BYTES
    }
}
