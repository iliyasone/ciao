package dev.iliyasone.ciao

import android.app.Activity
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration
import java.util.concurrent.TimeUnit

/** Dragging the live card moves it; a tap on its buttons still works. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CardDragTest {
    private val moves = mutableListOf<Triple<Int, Int, Boolean>>()
    private var done = 0
    private val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    // In a window, as in the overlay: a button's click is posted, and runs only for an attached view.
    private val card = CardView(activity, onCancel = {}, onDone = { done++ }, onRetry = {}, onMove = { x, y, end -> moves += Triple(x, y, end) }).also {
        activity.setContentView(FrameLayout(activity).apply { addView(it, FrameLayout.LayoutParams(1000, FrameLayout.LayoutParams.WRAP_CONTENT)) })
        ShadowLooper.idleMainLooper()
    }
    private val slop = ViewConfiguration.get(activity).scaledTouchSlop

    private fun touch(action: Int, x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        val e = MotionEvent.obtain(now, now, action, x, y, 0)
        card.dispatchTouchEvent(e)
        e.recycle()
    }

    @Test
    fun dragFromTheTextMovesTheCard() {
        val scroller = card.getChildAt(1)
        val y = (scroller.top + scroller.bottom) / 2f
        touch(MotionEvent.ACTION_DOWN, 500f, y)
        touch(MotionEvent.ACTION_MOVE, 500f, y + slop + 5)
        touch(MotionEvent.ACTION_MOVE, 540f, y + slop + 105)
        touch(MotionEvent.ACTION_UP, 560f, y + slop + 205)
        assertEquals(Triple(40, 100, false), moves.first())
        assertEquals(Triple(60, 200, true), moves.last())
    }

    @Test
    fun dragFromAButtonMovesTheCardAndDoesntPressIt() {
        val (x, y) = doneButtonCentre()
        touch(MotionEvent.ACTION_DOWN, x, y)
        touch(MotionEvent.ACTION_MOVE, x - slop - 5, y)
        touch(MotionEvent.ACTION_MOVE, x - slop - 305, y + 50)
        // Let go over ✓ again: it must not count as a press.
        touch(MotionEvent.ACTION_UP, x, y)
        ShadowLooper.idleMainLooper()
        assertEquals(Triple(slop + 5, 0, true), moves.last())
        assertEquals(0, done)
    }

    @Test
    fun dragOverTheTextWhileItIsStillScrolling() {
        val scroller = card.getChildAt(1) as android.widget.ScrollView
        card.delta("слово ".repeat(400), 0)
        // A few of the card's frames: laid out, then scrolled to the bottom.
        ShadowLooper.idleMainLooper(200, TimeUnit.MILLISECONDS)
        assertTrue("the text is longer than the card and kept at its bottom", scroller.canScrollVertically(-1))
        // A smooth scroll is animated only after a pause since the last one: the text is mid-scroll when the finger lands.
        ShadowSystemClock.advanceBy(Duration.ofMillis(300))
        scroller.smoothScrollTo(0, 0)
        val y = (scroller.top + scroller.bottom) / 2f
        touch(MotionEvent.ACTION_DOWN, 500f, y)
        touch(MotionEvent.ACTION_MOVE, 500f + slop + 5, y)
        touch(MotionEvent.ACTION_UP, 700f + slop + 5, y)
        assertEquals(Triple(200, 0, true), moves.last())
    }

    @Test
    fun aTapStillPressesTheButton() {
        val (x, y) = doneButtonCentre()
        touch(MotionEvent.ACTION_DOWN, x, y)
        touch(MotionEvent.ACTION_UP, x + 1, y)
        ShadowLooper.idleMainLooper()
        assertEquals(1, done)
        assertTrue(moves.isEmpty())
    }

    /** ✓ is the last button in the header row. */
    private fun doneButtonCentre(): Pair<Float, Float> {
        val header = card.getChildAt(0) as android.view.ViewGroup
        val b = header.getChildAt(header.childCount - 1)
        return (header.left + b.left + b.width / 2f) to (header.top + b.top + b.height / 2f)
    }
}
