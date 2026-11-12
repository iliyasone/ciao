package dev.iliyasone.ciao

/**
 * Keeps long silence out of what a provider is sent: live transcription is billed per second of
 * audio, a pause to think included. A port of src/core/silence.ts.
 *
 * A chunk is quiet when it is below [QUIET_LEVEL] and at least 18 dB below the loudest chunk of the
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

    /** The audio to send now, as copies: none in a long silence, the chunk itself, or it with the quiet just before it. */
    fun pass(pcm: ByteArray, length: Int = pcm.size): List<ByteArray> {
        val level = Recorder.level(pcm, 0, length)
        loudest = maxOf(loudest, level)
        val chunk = pcm.copyOf(length)
        if (level >= minOf(QUIET_LEVEL, loudest / LOUDEST_RATIO)) {
            quietMs = 0.0
            beforeBytes = 0
            skipped = dropped
            return (before + chunk).also { before.clear() }
        }
        quietMs += length / BYTES_PER_MS
        if (quietMs <= KEEP_AFTER_MS) return listOf(chunk)
        before.addLast(chunk)
        beforeBytes += length
        while (beforeBytes > KEEP_BEFORE_MS * BYTES_PER_MS) {
            val oldest = before.removeFirst().size
            beforeBytes -= oldest
            dropped += oldest
        }
        skipped = dropped + beforeBytes
        return emptyList()
    }

    companion object {
        const val QUIET_LEVEL = 200.0
        private const val LOUDEST_RATIO = 8
        const val KEEP_AFTER_MS = 1000
        const val KEEP_BEFORE_MS = 500
        const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000.0
    }
}
