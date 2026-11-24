from datetime import datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class ResumeBullet(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    text: str
    category: str = "experience"
    source: str = "pasted text"
    approved: bool = True


class Profile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    raw_text: str = ""
    bullets: list[ResumeBullet] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Turn(BaseModel):
    role: Literal["agent", "user"]
    text: str
    bullet_id: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Session(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    profile_id: str
    bullet_id: str
    status: Literal["planned", "active", "complete", "paused"] = "planned"
    current_round: int = 0
    max_rounds: int = 3
    turns: list[Turn] = Field(default_factory=list)
    covered_topics: list[str] = Field(default_factory=list)
    unresolved_gaps: list[str] = Field(default_factory=list)
    feedback: dict = Field(default_factory=dict)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class VaultFact(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    profile_id: str
    text: str
    source_turn_id: str | None = None
    approved: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ProfileInput(BaseModel):
    name: str
    raw_text: str


class AnswerInput(BaseModel):
    text: str


class FactInput(BaseModel):
    text: str
    source_turn_id: str | None = None

