using Windows.Media.Control;

namespace Ciao.Input;

/// <summary>
/// Pauses the media players that are playing (Spotify, a browser tab, any app that shows in the media flyout) through
/// the system media sessions, and later resumes just those. Calls run one after another on the thread pool, so a
/// resume always follows the pause it undoes.
/// </summary>
static class Media
{
    static readonly SemaphoreSlim Gate = new(1, 1);
    static GlobalSystemMediaTransportControlsSessionManager? _manager;
    static List<GlobalSystemMediaTransportControlsSession> _paused = [];

    public static void Set(bool pause, Action<string> log) => Task.Run(async () =>
    {
        await Gate.WaitAsync();
        try
        {
            if (pause) await Pause();
            else await Resume();
        }
        catch (Exception e) { log($"media: {e.Message}"); }
        finally { Gate.Release(); }
    });

    static async Task Pause()
    {
        _manager ??= await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        foreach (var s in _manager.GetSessions())
            if (Status(s) == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing && await s.TryPauseAsync())
                _paused.Add(s);
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
