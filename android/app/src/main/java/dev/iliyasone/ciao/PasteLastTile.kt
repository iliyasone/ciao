package dev.iliyasone.ciao

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast

/**
 * "Paste last" in the quick settings, the phone's Alt+Shift+Z: the shade closes and the last
 * dictation goes into the field you were typing in (CiaoService does that), or onto the clipboard.
 */
class PasteLastTile : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = if (Prefs(this@PasteLastTile).lastText.isEmpty()) Tile.STATE_UNAVAILABLE else Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        val text = Prefs(this).lastText
        if (text.isEmpty()) return
        val service = CiaoService.instance
        if (service != null) return service.pasteLast(text)
        TextInserter.copy(this, text)
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
    }
}
