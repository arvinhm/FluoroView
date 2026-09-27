"""How one channel is shown: the model shared by saved display settings, figures and sessions.

Values are windowed (lo to hi), raised to 1/gamma, passed through the tone curve, optionally inverted,
coloured with `color` or the colour map `lut`, and scaled by `intensity`. Older settings without the
last four fields show exactly as before.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, FiniteFloat, field_validator

from .regions import COLOR

Lut = Literal["color", "grays", "fire", "ice", "viridis", "magma", "inferno"]
Blend = Literal["add", "max"]
CurvePoint = tuple[FiniteFloat, FiniteFloat]


class DisplayChannel(BaseModel):
    visible: bool
    color: str = Field(pattern=COLOR)
    lo: FiniteFloat
    hi: FiniteFloat
    gamma: FiniteFloat = Field(gt=0, le=10)
    touched: bool = True
    """False when the window is still the automatic one, so the studio may refine it."""
    lut: Lut = "color"
    """"color" tints with `color`; otherwise a colour map"""
    invert: bool = False
    curve: list[CurvePoint] = Field(default_factory=lambda: [(0.0, 0.0), (1.0, 1.0)], min_length=2, max_length=16)
    """tone curve after the window and gamma: points between 0 and 1, x increasing from 0 to 1"""
    intensity: FiniteFloat = Field(default=1.0, ge=0, le=1)

    @field_validator("curve")
    @classmethod
    def _curve(cls, points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        xs = [x for x, _ in points]
        if xs[0] != 0 or xs[-1] != 1:
            raise ValueError("a curve starts at x = 0 and ends at x = 1")
        if any(b <= a for a, b in zip(xs, xs[1:], strict=False)):
            raise ValueError("curve points must have increasing x")
        if any(not 0 <= y <= 1 for _, y in points):
            raise ValueError("curve points lie between 0 and 1")
        return points
