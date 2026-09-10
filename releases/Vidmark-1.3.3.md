# Vidmark 1.3.3

- Stops local services when the native app crashes or is force-quit.
- Requires the native app's active unlock session before a bundled service can start.
- Cleans up surviving services from older releases at launch.
- Ignores expected cancelled page loads during lock and unlock.
- Opens the workspace only after its own services confirm readiness; port conflicts stop startup.
