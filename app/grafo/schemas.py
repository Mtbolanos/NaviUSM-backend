from pydantic import BaseModel
from uuid import UUID
from datetime import datetime


class SnapshotOut(BaseModel):
    id: UUID
    version: int
    published_at: datetime

    model_config = {"from_attributes": True}
