# Vidmark 1.3.2

- Keeps Vidmark locked if authentication finishes after a sleep or lock event.
- Discards pending workspace and notification responses from a previous unlocked session.
- Requires authentication before changing the unlock method and handles malformed PIN settings through Mac authentication recovery.
- Preserves notification destinations until Vidmark is unlocked.
- Waits for local services to stop before reopening the workspace.
- Explains how to unlock Vidmark when Claude Desktop cannot connect.
