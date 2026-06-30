from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Any
import uuid
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI()
api_router = APIRouter(prefix="/api")

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----- Models -----
class ChecklistItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    done: bool = False


class NoteBase(BaseModel):
    title: str = ""
    content: str = ""
    checklist: List[ChecklistItem] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)   # base64 data URIs
    drawings: List[str] = Field(default_factory=list) # base64 data URIs
    folder_id: Optional[str] = None
    color: Optional[str] = None
    pinned: bool = False
    locked: bool = False


class NoteCreate(NoteBase):
    pass


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    checklist: Optional[List[ChecklistItem]] = None
    images: Optional[List[str]] = None
    drawings: Optional[List[str]] = None
    folder_id: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    locked: Optional[bool] = None


class Note(NoteBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class FolderBase(BaseModel):
    name: str
    color: str = "#7B8C73"


class FolderCreate(FolderBase):
    pass


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class Folder(FolderBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(default_factory=now_iso)


class SummarizeRequest(BaseModel):
    text: str


class SummarizeResponse(BaseModel):
    summary: str


# ----- Helpers -----
def strip_id(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc


# ----- Routes -----
@api_router.get("/")
async def root():
    return {"message": "GalaxyNotes API", "ok": True}


# Notes CRUD
@api_router.get("/notes", response_model=List[Note])
async def list_notes(folder_id: Optional[str] = None, q: Optional[str] = None):
    query: dict = {}
    if folder_id:
        query["folder_id"] = folder_id
    if q:
        query["$or"] = [
            {"title": {"$regex": q, "$options": "i"}},
            {"content": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.notes.find(query, {"_id": 0}).sort("updated_at", -1)
    notes = await cursor.to_list(1000)
    return [Note(**n) for n in notes]


@api_router.post("/notes", response_model=Note)
async def create_note(payload: NoteCreate):
    note = Note(**payload.dict())
    await db.notes.insert_one(note.dict())
    return note


@api_router.get("/notes/{note_id}", response_model=Note)
async def get_note(note_id: str):
    doc = await db.notes.find_one({"id": note_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Note not found")
    return Note(**doc)


@api_router.put("/notes/{note_id}", response_model=Note)
async def update_note(note_id: str, payload: NoteUpdate):
    existing = await db.notes.find_one({"id": note_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Note not found")
    update_data: dict = {k: v for k, v in payload.dict().items() if v is not None}
    update_data["updated_at"] = now_iso()
    # Convert checklist items
    if "checklist" in update_data:
        update_data["checklist"] = [
            (item if isinstance(item, dict) else item.dict())
            for item in update_data["checklist"]
        ]
    await db.notes.update_one({"id": note_id}, {"$set": update_data})
    doc = await db.notes.find_one({"id": note_id}, {"_id": 0})
    return Note(**doc)


@api_router.delete("/notes/{note_id}")
async def delete_note(note_id: str):
    result = await db.notes.delete_one({"id": note_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Note not found")
    return {"ok": True}


# Folders CRUD
@api_router.get("/folders", response_model=List[Folder])
async def list_folders():
    cursor = db.folders.find({}, {"_id": 0}).sort("created_at", 1)
    folders = await cursor.to_list(1000)
    return [Folder(**f) for f in folders]


@api_router.post("/folders", response_model=Folder)
async def create_folder(payload: FolderCreate):
    folder = Folder(**payload.dict())
    await db.folders.insert_one(folder.dict())
    return folder


@api_router.put("/folders/{folder_id}", response_model=Folder)
async def update_folder(folder_id: str, payload: FolderUpdate):
    existing = await db.folders.find_one({"id": folder_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Folder not found")
    update_data = {k: v for k, v in payload.dict().items() if v is not None}
    await db.folders.update_one({"id": folder_id}, {"$set": update_data})
    doc = await db.folders.find_one({"id": folder_id}, {"_id": 0})
    return Folder(**doc)


@api_router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    result = await db.folders.delete_one({"id": folder_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Folder not found")
    # Detach notes from this folder
    await db.notes.update_many({"folder_id": folder_id}, {"$set": {"folder_id": None}})
    return {"ok": True}


# AI Summarize
@api_router.post("/ai/summarize", response_model=SummarizeResponse)
async def ai_summarize(payload: SummarizeRequest):
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "Empty text")
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "AI key not configured")
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"summarize-{uuid.uuid4()}",
            system_message=(
                "You are a concise note summarizer. "
                "Summarize the user's note in 2-4 short bullet points, "
                "highlighting key ideas and action items. "
                "Be brief, neutral, and informative. Use plain text, no markdown headers."
            ),
        ).with_model("anthropic", "claude-sonnet-4-6")
        result = await chat.send_message(UserMessage(text=text))
        summary = result if isinstance(result, str) else str(result)
        return SummarizeResponse(summary=summary.strip())
    except Exception as e:
        logging.exception("AI summarize failed")
        raise HTTPException(500, f"AI error: {str(e)[:200]}")


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
