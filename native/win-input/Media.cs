using Windows.Media.Control;

namespace Ciao.Input;

/// <summary>
/// Pauses the media players that are playing (Spotify, a browser tab, any app that shows in the media flyout) through
/// the system media sessions, and later resumes just those. Calls run one after another on the thread pool, so a
/// resume always follows the pause it undoes. Called from the stdin thread only.
/// </summary>
static class Media
{
    static Task _queue = Task.CompletedTask;
    static GlobalSystemMediaTransportControlsSessionManager? _manager;
    static List<GlobalSystemMediaTransportControlsSession> _paused = [];

    public static void Set(bool pause, Action<string> log) => _queue = _queue.ContinueWith(async _ =>
    {
        try
        {
            if (pause) await Pause();
            else await Resume();
        }
        catch (Exception e) { log($"media: {e.Message}"); }
    }, TaskScheduler.Default).Unwrap();

    /// <summary>Waits until the queued calls ran (the music Ciao paused plays on), at most <paramref name="ms"/>.</summary>
    public static void Drain(int ms) => _queue.Wait(ms);

    static async Task Pause()
    {
        _manager ??= await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        foreach (var s in _manager.GetSessions())
            // A player closing right now throws; the others still pause.
            try
            {
                if (Status(s) != GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing || !await s.TryPauseAsync()) continue;
                // The request is answered before the player reports it paused (Spotify lags): a resume right
                // after would still read Playing and leave it paused. Wait for it to settle, up to half a second.
                for (int i = 0; i < 10 && Status(s) == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing; i++)
                    await Task.Delay(50);
                _paused.Add(s);
            }
            catch { }
    }

    static async Task Resume()
    {
        var paused = _paused;
        _paused = [];
        foreach (var s in paused)
            // Still paused: the user didn't start or stop it themselves meanwhile. A closed player throws; skip it.
            try { if (Status(s) == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused) await s.TryPlayAsync(); }
            catch { }
    }

    static GlobalSystemMediaTransportControlsSessionPlaybackStatus? Status(GlobalSystemMediaTransportControlsSession s) =>
        s.GetPlaybackInfo()?.PlaybackStatus;
}
