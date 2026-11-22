package dev.iliyasone.ciao

/**
 * What the service last saw, for the check on the setup screen (SetupActivity): when the bubble
 * doesn't show on some phone, this says which link is missing. Times are System.currentTimeMillis,
 * 0 when not yet. Same process as the screen, so plain fields will do.
 */
object Diag {
    @Volatile var connectedAt = 0L
    @Volatile var fieldAt = 0L
    @Volatile var keyboardAt = 0L
    /** The kinds of windows the phone listed last, for the report ("APPLICATION 1080×2400, INPUT_METHOD 1080×900"). */
    @Volatile var windows = ""
    @Volatile var bubbleShown = false
    /** The service takes the shade for pulled down: the bubble is up but hidden. */
    @Volatile var shade = false
    /** Why the phone refused to show the bubble, if it did. */
    @Volatile var bubbleError: String? = null
    /** How the last dictation ended ("pasted", "clipboard", "empty", "failed", "cancelled") and when. */
    @Volatile var outcome: String? = null
    @Volatile var outcomeAt = 0L
}
