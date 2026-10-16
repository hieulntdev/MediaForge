class SFXConverterError(RuntimeError):
    """Base exception suitable for display to an end user."""


class DependencyError(SFXConverterError):
    """A required executable or Python dependency is unavailable."""


class ValidationError(SFXConverterError):
    """User input or media validation failed."""


class ProcessingCancelled(SFXConverterError):
    """The current operation was cancelled cooperatively."""


class ModelError(SFXConverterError):
    """The source-separation model could not be prepared or run."""
