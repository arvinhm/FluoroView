"""How one channel is shown: the model shared by saved display settings, figures and sessions."""

from __future__ import annotations

from pydantic import BaseModel, Field, FiniteFloat

from .regions import COLOR


class DisplayChannel(BaseModel):
    visible: bool
    color: str = Field(pattern=COLOR)
    lo: FiniteFloat
    hi: FiniteFloat
    gamma: FiniteFloat = Field(gt=0, le=10)
    touched: bool = True
    """False when the window is still the automatic one, so the studio may refine it."""
