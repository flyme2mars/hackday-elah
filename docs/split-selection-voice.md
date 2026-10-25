# Split selection and voice controls

## Selection after a split

`selectSplitResults(engine)` subscribes to Elah's `clip:split` event. It selects
both resulting clip IDs after the current edit completes. Multiple splits in
one command select all surviving results. A rolled-back split leaves selection
unchanged.

The subscription covers the S shortcut, **Split at playhead** in clip controls,
and agent splits. The existing `selected_clip_ids` request field includes both
halves in the next command. Planner operations and `applyOps` are unchanged.

## Voice controller contract

`CommandBar` accepts a required `voice` prop with the exported `VoiceControl`
type. The speech controller supplies one of these states:

| State | Callback | Control |
| --- | --- | --- |
| `idle` | `onStart` | Start voice input |
| `listening` | `onStop` | Stop listening, pressed state, listening status |
| `denied` | `onRetry` | Permission-denied icon, browser permission guidance |
| `unavailable` | None | Disabled microphone |

`EditorShell` currently passes `{ state: 'unavailable' }`. The remaining speech
integration belongs at that `CommandBar` call site in `src/App.tsx`. The speech
controller owns microphone permissions, recognition, and state changes. Its
transcript updates the existing `command` state through `setCommand`.

The UI does not create a speech recognizer or claim to listen before the
controller starts. Mic clicks preserve typed text and never submit the form.
A busy command disables start and retry. Stop stays available during listening.

## Verification

With Vite running, the focused browser checks are:

```bash
CHROME_PATH=/path/to/chrome node tests/split-selection.mjs
CHROME_PATH=/path/to/chrome node tests/voice.mjs
```

Omit `CHROME_PATH` when Playwright Chromium is installed. The split check covers
keyboard, menu and agent cuts, command context, undo, redo, multiple cuts, and
rollback. Before the fix, it failed with one selected half instead of two.
The voice check renders the real command bar with controlled callbacks and
checks keyboard actions, status labels, busy handling, and text preservation.
