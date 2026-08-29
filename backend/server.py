"""Geodesic Notes API.

Design notes
------------
* Writes use ``exclude_unset`` so a client can explicitly clear a field
  (``folder_id: null`` moves a note to the root). ``None`` is a real value here,
  not "absent".
* List endpoints never return heavy blobs (``drawing_data``, ``images``).
  Cards render from ``preview``; the full document is fetched per note.
* Every user-supplied string that reaches a ``$regex`` is escaped.
* No third-party services. The API needs a MongoDB connection and nothing else:
  no LLM provider, no API keys, no metered calls.
* Deletes are idempotent: soft-delete moves to trash, and only ``permanent=true``
  destroys. Re-issuing either is a no-op rather than an escalation.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, List, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Query, Response
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("geodesic")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

# Comma-separated list. Falls back to "*", which also forces credentials off:
# the CORS spec forbids wildcard-plus-credentials and browsers reject it.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
ALLOW_CREDENTIALS = CORS_ORIGINS != ["*"]

# Notes soft-deleted longer ago than this are purged on boot and daily after.
TRASH_RETENTION_DAYS = int(os.environ.get("TRASH_RETENTION_DAYS", "30"))

# Guard rails on blob-ish fields so a runaway client can't wedge a document
# against MongoDB's 16 MB ceiling.
MAX_DRAWING_BYTES = 6 * 1024 * 1024
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGES_PER_NOTE = 40

client = AsyncIOMotorClient(MONGO_URL, uuidRepresentation="standard")
db = client[DB_NAME]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_regex(term: str, anchored: bool = False) -> dict:
    """Literal, case-insensitive match.

    ``re.escape`` is the whole point: without it ``q="c++"`` is a 500 and
    ``q="(a+)+$"`` is a denial-of-service against the database.
    """
    pattern = re.escape(term.strip())
    if anchored:
        pattern = f"^{pattern}$"
    return {"$regex": pattern, "$options": "i"}


def _check_images(v: List[str]) -> List[str]:
    if len(v) > MAX_IMAGES_PER_NOTE:
        raise ValueError(f"a note may hold at most {MAX_IMAGES_PER_NOTE} images")
    for img in v:
        if len(img.encode("utf-8")) > MAX_IMAGE_BYTES:
            raise ValueError("an image exceeds the maximum attachment size")
    return v


def _check_drawing(v: Optional[str]) -> Optional[str]:
    if v is not None and len(v.encode("utf-8")) > MAX_DRAWING_BYTES:
        raise ValueError("drawing_data exceeds the maximum document size")
    return v


def _check_note_type(v: Optional[str]) -> Optional[str]:
    if v is not None and v not in ("text", "handwriting"):
        raise ValueError("note_type must be 'text' or 'handwriting'")
    return v


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class ChecklistItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    done: bool = False


class NoteBase(BaseModel):
    title: str = ""
    content: str = ""
    checklist: List[ChecklistItem] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)
    drawings: List[str] = Field(default_factory=list)
    drawing_data: Optional[str] = None
    # Compact, card-sized render of the handwriting, written by the client at
    # save time. Lets the notes list stay cheap without parsing the full doc.
    preview: Optional[str] = None
    note_type: str = "text"
    folder_id: Optional[str] = None
    label_ids: List[str] = Field(default_factory=list)
    color: Optional[str] = None
    pinned: bool = False
    locked: bool = False

    _v_drawing = field_validator("drawing_data")(lambda cls, v: _check_drawing(v))
    _v_images = field_validator("images")(lambda cls, v: _check_images(v))
    _v_type = field_validator("note_type")(lambda cls, v: _check_note_type(v))


class NoteCreate(NoteBase):
    pass


class NoteUpdate(BaseModel):
    """Every field optional, and ``None`` means "set to null", not "skip".

    Callers send only the keys they intend to change; the route uses
    ``exclude_unset`` to tell an omitted key from an explicit null. This is what
    makes "move note out of its folder" (``folder_id: null``) expressible.
    """

    title: Optional[str] = None
    content: Optional[str] = None
    checklist: Optional[List[ChecklistItem]] = None
    images: Optional[List[str]] = None
    drawings: Optional[List[str]] = None
    drawing_data: Optional[str] = None
    preview: Optional[str] = None
    note_type: Optional[str] = None
    folder_id: Optional[str] = None
    label_ids: Optional[List[str]] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    locked: Optional[bool] = None
    # Optimistic concurrency. When supplied, the write is rejected if another
    # client has bumped the note since this one last read it.
    base_version: Optional[int] = None

    _v_drawing = field_validator("drawing_data")(lambda cls, v: _check_drawing(v))
    _v_type = field_validator("note_type")(lambda cls, v: _check_note_type(v))

    @field_validator("images")
    @classmethod
    def _v_images(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return v if v is None else _check_images(v)


class Note(NoteBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    deleted_at: Optional[str] = None
    version: int = 1


class NoteSummary(BaseModel):
    """What the notes list returns. Deliberately excludes every blob field."""

    id: str
    title: str = ""
    content: str = ""
    checklist: List[ChecklistItem] = Field(default_factory=list)
    preview: Optional[str] = None
    note_type: str = "text"
    folder_id: Optional[str] = None
    label_ids: List[str] = Field(default_factory=list)
    color: Optional[str] = None
    pinned: bool = False
    locked: bool = False
    has_drawing: bool = False
    image_count: int = 0
    created_at: str
    updated_at: str
    deleted_at: Optional[str] = None
    version: int = 1


class NotePage(BaseModel):
    items: List[NoteSummary]
    total: int
    limit: int
    offset: int
    has_more: bool


class FolderBase(BaseModel):
    name: str
    color: str = "#7B8C73"
    parent_id: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("folder name required")
        return v[:120]


class FolderCreate(FolderBase):
    pass


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[str] = None


class Folder(FolderBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(default_factory=now_iso)


class LabelBase(BaseModel):
    name: str
    color: str = "#7B8C73"

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("label name required")
        return v[:60]


class LabelCreate(LabelBase):
    pass


class LabelUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class Label(LabelBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(default_factory=now_iso)


# --------------------------------------------------------------------------
# Lifespan: indexes and trash retention
# --------------------------------------------------------------------------
LIST_PROJECTION = {"_id": 0, "drawing_data": 0, "drawings": 0, "images": 0}


async def ensure_indexes() -> None:
    await db.notes.create_index("id", unique=True)
    # The exact shape of the default notes query: not deleted, pinned first,
    # then most recent. Without this every list is a collection scan plus sort.
    await db.notes.create_index([("deleted_at", 1), ("pinned", -1), ("updated_at", -1)])
    await db.notes.create_index([("deleted_at", 1), ("folder_id", 1), ("updated_at", -1)])
    await db.notes.create_index("label_ids")
    await db.folders.create_index("id", unique=True)
    await db.labels.create_index("id", unique=True)
    logger.info("indexes ensured")


async def purge_expired_trash() -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=TRASH_RETENTION_DAYS)).isoformat()
    result = await db.notes.delete_many({"deleted_at": {"$ne": None, "$lt": cutoff}})
    if result.deleted_count:
        logger.info("purged %s expired notes from trash", result.deleted_count)
    return result.deleted_count


async def _retention_loop() -> None:
    while True:
        try:
            await purge_expired_trash()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("trash purge failed")
        await asyncio.sleep(24 * 60 * 60)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await ensure_indexes()
    task = asyncio.create_task(_retention_loop())
    try:
        yield
    finally:
        task.cancel()
        client.close()


app = FastAPI(title="Geodesic Notes API", lifespan=lifespan)
api_router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
async def _get_note_or_404(note_id: str, projection: Optional[dict] = None) -> dict:
    doc = await db.notes.find_one({"id": note_id}, projection or {"_id": 0})
    if not doc:
        raise HTTPException(404, "Note not found")
    return doc


def _summarize_doc(doc: dict) -> NoteSummary:
    payload = dict(doc)
    payload["has_drawing"] = bool(payload.get("preview")) or payload.get("note_type") == "handwriting"
    payload.setdefault("image_count", 0)
    return NoteSummary(**payload)


def _write_patch(payload: BaseModel, exclude: Iterable[str] = ()) -> dict[str, Any]:
    """Only the keys the caller actually sent. ``None`` survives as null."""
    return payload.model_dump(exclude_unset=True, exclude=set(exclude))


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"message": "Geodesic Notes API", "ok": True}


@api_router.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"ok": True, "db": "up"}
    except Exception:
        logger.exception("health check failed")
        raise HTTPException(503, "Database unavailable")


@api_router.get("/notes", response_model=NotePage)
async def list_notes(
    folder_id: Optional[str] = None,
    label_id: Optional[str] = None,
    q: Optional[str] = None,
    status: str = Query("active", pattern="^(active|trash)$"),
    pinned: Optional[bool] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    query: dict = {"deleted_at": None} if status == "active" else {"deleted_at": {"$ne": None}}
    if folder_id:
        query["folder_id"] = folder_id
    if label_id:
        query["label_ids"] = label_id
    if pinned is not None:
        query["pinned"] = pinned
    if q and q.strip():
        rx = safe_regex(q)
        query["$or"] = [{"title": rx}, {"content": rx}, {"checklist.text": rx}]

    total = await db.notes.count_documents(query)
    cursor = (
        db.notes.find(query, LIST_PROJECTION)
        .sort([("pinned", -1), ("updated_at", -1)])
        .skip(offset)
        .limit(limit)
    )
    docs = await cursor.to_list(length=limit)
    return NotePage(
        items=[_summarize_doc(d) for d in docs],
        total=total,
        limit=limit,
        offset=offset,
        has_more=offset + len(docs) < total,
    )


@api_router.post("/notes", response_model=Note, status_code=201)
async def create_note(payload: NoteCreate):
    note = Note(**payload.model_dump())
    doc = note.model_dump()
    doc["image_count"] = len(note.images)
    await db.notes.insert_one(doc)
    return note


@api_router.get("/notes/{note_id}", response_model=Note)
async def get_note(note_id: str):
    return Note(**await _get_note_or_404(note_id))


@api_router.get("/notes/{note_id}/drawing")
async def get_note_drawing(note_id: str):
    """Fetched lazily, because the list endpoint deliberately omits it."""
    doc = await _get_note_or_404(note_id, {"_id": 0, "drawing_data": 1, "version": 1})
    return {"drawing_data": doc.get("drawing_data"), "version": doc.get("version", 1)}


@api_router.put("/notes/{note_id}", response_model=Note)
async def update_note(note_id: str, payload: NoteUpdate, response: Response):
    existing = await _get_note_or_404(note_id, {"_id": 0, "version": 1})

    patch = _write_patch(payload, exclude=("base_version",))
    if not patch:
        return Note(**await _get_note_or_404(note_id))

    base_version = payload.base_version
    if base_version is not None and base_version != existing.get("version", 1):
        raise HTTPException(
            409,
            f"Note was modified elsewhere (server version {existing.get('version', 1)}, "
            f"client base {base_version})",
        )

    if patch.get("checklist") is not None:
        patch["checklist"] = [
            item if isinstance(item, dict) else item.model_dump() for item in patch["checklist"]
        ]
    if "images" in patch:
        patch["image_count"] = len(patch["images"] or [])

    patch["updated_at"] = now_iso()

    # Conditional write: the version guard is applied atomically, so two racing
    # clients can't both believe they won.
    match: dict = {"id": note_id}
    if base_version is not None:
        match["version"] = base_version
    result = await db.notes.update_one(match, {"$set": patch, "$inc": {"version": 1}})
    if result.matched_count == 0:
        raise HTTPException(409, "Note was modified elsewhere")

    doc = await _get_note_or_404(note_id)
    response.headers["ETag"] = f'W/"{doc.get("version", 1)}"'
    return Note(**doc)


@api_router.delete("/notes/{note_id}")
async def delete_note(note_id: str, permanent: bool = False):
    """Idempotent.

    Soft-delete twice and the note stays in the trash. Only an explicit
    ``permanent=true`` destroys it, so a retried request can never escalate from
    "trashed" to "gone".
    """
    existing = await db.notes.find_one({"id": note_id}, {"_id": 0, "deleted_at": 1})
    if not existing:
        raise HTTPException(404, "Note not found")

    if permanent:
        await db.notes.delete_one({"id": note_id})
        return {"ok": True, "permanent": True}

    if existing.get("deleted_at"):
        return {"ok": True, "permanent": False, "already_trashed": True}

    stamp = now_iso()
    await db.notes.update_one(
        {"id": note_id},
        {"$set": {"deleted_at": stamp, "updated_at": stamp}, "$inc": {"version": 1}},
    )
    return {"ok": True, "permanent": False}


@api_router.post("/notes/{note_id}/restore", response_model=Note)
async def restore_note(note_id: str):
    existing = await _get_note_or_404(note_id, {"_id": 0, "deleted_at": 1})
    if not existing.get("deleted_at"):
        raise HTTPException(409, "Note is not in the trash")
    await db.notes.update_one(
        {"id": note_id},
        {"$set": {"deleted_at": None, "updated_at": now_iso()}, "$inc": {"version": 1}},
    )
    return Note(**await _get_note_or_404(note_id))


@api_router.post("/notes/trash/empty")
async def empty_trash():
    result = await db.notes.delete_many({"deleted_at": {"$ne": None}})
    return {"ok": True, "deleted": result.deleted_count}


# ----- Folders -----
@api_router.get("/folders", response_model=List[Folder])
async def list_folders():
    docs = await db.folders.find({}, {"_id": 0}).sort("created_at", 1).to_list(length=500)
    return [Folder(**f) for f in docs]


@api_router.post("/folders", response_model=Folder, status_code=201)
async def create_folder(payload: FolderCreate):
    folder = Folder(**payload.model_dump())
    await db.folders.insert_one(folder.model_dump())
    return folder


@api_router.put("/folders/{folder_id}", response_model=Folder)
async def update_folder(folder_id: str, payload: FolderUpdate):
    existing = await db.folders.find_one({"id": folder_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Folder not found")

    patch = _write_patch(payload)
    if "name" in patch:
        name = (patch["name"] or "").strip()
        if not name:
            raise HTTPException(400, "Folder name required")
        patch["name"] = name
    if patch.get("parent_id") == folder_id:
        raise HTTPException(400, "A folder cannot be its own parent")
    if patch:
        await db.folders.update_one({"id": folder_id}, {"$set": patch})
    return Folder(**await db.folders.find_one({"id": folder_id}, {"_id": 0}))


@api_router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    result = await db.folders.delete_one({"id": folder_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Folder not found")
    await db.notes.update_many({"folder_id": folder_id}, {"$set": {"folder_id": None}})
    await db.folders.update_many({"parent_id": folder_id}, {"$set": {"parent_id": None}})
    return {"ok": True}


# ----- Labels -----
@api_router.get("/labels", response_model=List[Label])
async def list_labels():
    docs = await db.labels.find({}, {"_id": 0}).sort("created_at", 1).to_list(length=500)
    return [Label(**lbl) for lbl in docs]


@api_router.post("/labels", response_model=Label)
async def create_label(payload: LabelCreate):
    existing = await db.labels.find_one({"name": safe_regex(payload.name, anchored=True)}, {"_id": 0})
    if existing:
        return Label(**existing)
    label = Label(**payload.model_dump())
    await db.labels.insert_one(label.model_dump())
    return label


@api_router.put("/labels/{label_id}", response_model=Label)
async def update_label(label_id: str, payload: LabelUpdate):
    existing = await db.labels.find_one({"id": label_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Label not found")
    patch = _write_patch(payload)
    if "name" in patch:
        name = (patch["name"] or "").strip()
        if not name:
            raise HTTPException(400, "Label name required")
        patch["name"] = name
    if patch:
        await db.labels.update_one({"id": label_id}, {"$set": patch})
    return Label(**await db.labels.find_one({"id": label_id}, {"_id": 0}))


@api_router.delete("/labels/{label_id}")
async def delete_label(label_id: str):
    result = await db.labels.delete_one({"id": label_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Label not found")
    await db.notes.update_many({"label_ids": label_id}, {"$pull": {"label_ids": label_id}})
    return {"ok": True}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=ALLOW_CREDENTIALS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "If-Match"],
    expose_headers=["ETag"],
)
