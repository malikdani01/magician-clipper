"""Job state machine for Magician Clipper (master prompt §11).

Exact job states from the spec, plus the allowed transition map.
A transition is valid only if ``new_state in VALID_TRANSITIONS[old_state]``.
``failed``/``cancelled`` are terminal; ``completed`` is terminal.
"""

# Exact states from master prompt §11 (order = pipeline order).
UPLOADED = "uploaded"
QUEUED = "queued"
PROBING = "probing"
EXTRACTING_AUDIO = "extracting_audio"
TRANSCRIBING = "transcribing"
DETECTING_SCENES = "detecting_scenes"
ANALYZING = "analyzing"
SELECTING_CLIPS = "selecting_clips"
RENDERING = "rendering"
CAPTIONING = "captioning"
VALIDATING = "validating"
COMPLETED = "completed"
FAILED = "failed"
CANCELLING = "cancelling"
CANCELLED = "cancelled"

JOB_STATES: tuple[str, ...] = (
    UPLOADED,
    QUEUED,
    PROBING,
    EXTRACTING_AUDIO,
    TRANSCRIBING,
    DETECTING_SCENES,
    ANALYZING,
    SELECTING_CLIPS,
    RENDERING,
    CAPTIONING,
    VALIDATING,
    COMPLETED,
    FAILED,
    CANCELLING,
    CANCELLED,
)

# States that are terminal (no outgoing transitions).
TERMINAL_STATES: frozenset[str] = frozenset({COMPLETED, FAILED, CANCELLED})

# States that mean the job is still in flight.
ACTIVE_STATES: frozenset[str] = frozenset(
    {
        UPLOADED,
        QUEUED,
        PROBING,
        EXTRACTING_AUDIO,
        TRANSCRIBING,
        DETECTING_SCENES,
        ANALYZING,
        SELECTING_CLIPS,
        RENDERING,
        CAPTIONING,
        VALIDATING,
        CANCELLING,
    }
)

# Allowed transitions. Any state may move to ``failed`` (error path) or
# ``cancelling`` (user/admin cancel request); ``cancelling`` may only move
# to ``cancelled`` or ``failed``. ``completed`` is reachable from any
# in-flight stage: the full pipeline completes from ``validating``, but a
# job whose final step is an earlier stage (e.g. a Phase 1 probe-only or
# audio-only job) legitimately completes from that stage. No backward
# moves and no moves out of a terminal state are ever allowed.
VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    UPLOADED: frozenset({QUEUED, FAILED, CANCELLING}),
    QUEUED: frozenset({PROBING, FAILED, CANCELLING}),
    PROBING: frozenset({EXTRACTING_AUDIO, COMPLETED, FAILED, CANCELLING}),
    EXTRACTING_AUDIO: frozenset({TRANSCRIBING, COMPLETED, FAILED, CANCELLING}),
    TRANSCRIBING: frozenset({DETECTING_SCENES, COMPLETED, FAILED, CANCELLING}),
    DETECTING_SCENES: frozenset({ANALYZING, COMPLETED, FAILED, CANCELLING}),
    ANALYZING: frozenset({SELECTING_CLIPS, COMPLETED, FAILED, CANCELLING}),
    SELECTING_CLIPS: frozenset({RENDERING, COMPLETED, FAILED, CANCELLING}),
    RENDERING: frozenset({CAPTIONING, VALIDATING, COMPLETED, FAILED, CANCELLING}),
    CAPTIONING: frozenset({VALIDATING, COMPLETED, FAILED, CANCELLING}),
    VALIDATING: frozenset({COMPLETED, FAILED, CANCELLING}),
    COMPLETED: frozenset(),
    FAILED: frozenset(),
    CANCELLING: frozenset({CANCELLED, FAILED}),
    CANCELLED: frozenset(),
}


def is_valid_transition(old_state: str, new_state: str) -> bool:
    """Return True when ``old_state -> new_state`` is an allowed move."""
    return new_state in VALID_TRANSITIONS.get(old_state, frozenset())
