package dev.iliyasone.ciao

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.RandomAccessFile

/** Plays a history recording (raw 24 kHz PCM16), one at a time, with pause and resume. */
class Player {
    /** The entry playing or paused, if any. */
    var playing: String? = null
        private set
    var paused = false
        private set
    /** Called on the main thread when what is playing changes. */
    var listener: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var thread: Thread? = null
    /** Where a paused recording resumes, in bytes. */
    private var position = 0L

    fun toggle(id: String, file: File) {
        when {
            playing == id && !paused -> pause()
            playing == id -> start(file, position)
            else -> {
                stop()
                playing = id
                start(file, 0)
            }
        }
        listener?.invoke()
    }

    fun stop() {
        halt()
        playing = null
        paused = false
        position = 0
        listener?.invoke()
    }

    private fun pause() {
        halt()
        paused = true
    }

    private fun halt() {
        val t = thread
        thread = null
        t?.interrupt()
        t?.join(300)
    }

    private fun start(file: File, from: Long) {
        paused = false
        val id = playing
        val t = Thread {
            val min = AudioTrack.getMinBufferSize(Recorder.SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(Recorder.SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(min * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            var at = from
            var finished = false
            try {
                RandomAccessFile(file, "r").use { f ->
                    f.seek(from)
                    track.play()
                    val buf = ByteArray(min)
                    while (!Thread.currentThread().isInterrupted) {
                        val n = f.read(buf)
                        if (n <= 0) {
                            finished = true
                            break
                        }
                        track.write(buf, 0, n)
                        at += n
                    }
                }
                if (finished) Thread.sleep(200) // let the buffer drain
            } catch (_: Exception) {
                // Interrupted (pause) or unreadable: stop where we are.
            } finally {
                runCatching { track.stop() }
                track.release()
            }
            main.post {
                if (playing != id) return@post
                position = at - at % 2
                if (finished) stop() else listener?.invoke()
            }
        }
        thread = t
        t.start()
    }
}
