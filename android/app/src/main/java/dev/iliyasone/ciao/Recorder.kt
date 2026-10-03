package dev.iliyasone.ciao

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.abs

/**
 * Microphone → 24 kHz PCM16 mono in 40 ms chunks, the one format used end to end. [onChunk] runs on
 * the recording thread with each chunk and its mean absolute level (0..32768).
 */
class Recorder(private val onChunk: (pcm: ByteArray, level: Double) -> Unit) {
    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile private var running = false

    /** Throws if the microphone can't be opened (no permission, or another app holds it). */
    @SuppressLint("MissingPermission") // checked by the caller
    fun start() {
        val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(min, CHUNK_BYTES * 8),
        )
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            throw IllegalStateException("AudioRecord not initialized")
        }
        r.startRecording()
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            r.release()
            throw IllegalStateException("microphone is busy")
        }
        record = r
        running = true
        thread = Thread({
            while (running) {
                val buf = ByteArray(CHUNK_BYTES)
                var n = 0
                while (n < buf.size && running) {
                    val got = r.read(buf, n, buf.size - n)
                    if (got <= 0) break
                    n += got
                }
                if (n > 0) onChunk(if (n == buf.size) buf else buf.copyOf(n), level(buf, 0, n))
                if (n == 0 && running) Thread.sleep(5)
            }
        }, "ciao-mic").apply { start() }
    }

    /** Stops after the chunk in flight has been delivered, so the final syllable is not lost. */
    fun stop() {
        running = false
        record?.let { r -> runCatching { r.stop() } }
        thread?.join(500)
        thread = null
        record?.release()
        record = null
    }

    companion object {
        const val SAMPLE_RATE = 24_000
        const val CHUNK_BYTES = SAMPLE_RATE * 2 * 40 / 1000

        /** Mean absolute amplitude of a PCM16 slice, 0..32768. */
        fun level(pcm: ByteArray, offset: Int, length: Int): Double {
            val end = minOf(offset + length, pcm.size) and 1.inv()
            var sum = 0L
            var i = offset
            while (i + 1 < end) {
                sum += abs(((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xff)).toShort().toInt())
                i += 2
            }
            val n = (end - offset) / 2
            return if (n > 0) sum.toDouble() / n else 0.0
        }
    }
}
