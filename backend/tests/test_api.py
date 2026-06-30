"""GalaxyNotes API tests - notes, folders, AI summarize."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://smart-notes-app-57.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# ----- Root -----
def test_root_ok(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200
    j = r.json()
    assert j.get("ok") is True


# ----- Notes CRUD -----
class TestNotes:
    created_id = None

    def test_create_note(self, s):
        payload = {"title": "TEST_Note1", "content": "hello world", "pinned": False}
        r = s.post(f"{API}/notes", json=payload)
        assert r.status_code == 200, r.text
        n = r.json()
        assert "id" in n and "created_at" in n and "updated_at" in n
        assert "_id" not in n
        assert n["title"] == "TEST_Note1"
        TestNotes.created_id = n["id"]

    def test_get_note(self, s):
        assert TestNotes.created_id
        r = s.get(f"{API}/notes/{TestNotes.created_id}")
        assert r.status_code == 200
        assert r.json()["title"] == "TEST_Note1"

    def test_list_notes_and_search(self, s):
        r = s.get(f"{API}/notes")
        assert r.status_code == 200
        assert any(n["id"] == TestNotes.created_id for n in r.json())
        r2 = s.get(f"{API}/notes", params={"q": "TEST_Note1"})
        assert r2.status_code == 200
        assert any(n["id"] == TestNotes.created_id for n in r2.json())

    def test_update_note(self, s):
        payload = {
            "title": "TEST_Note1_upd",
            "pinned": True,
            "checklist": [{"id": "c1", "text": "do thing", "done": False}],
            "images": ["data:image/png;base64,AAA"],
        }
        r = s.put(f"{API}/notes/{TestNotes.created_id}", json=payload)
        assert r.status_code == 200, r.text
        n = r.json()
        assert n["title"] == "TEST_Note1_upd"
        assert n["pinned"] is True
        assert len(n["checklist"]) == 1
        # Verify with GET
        r2 = s.get(f"{API}/notes/{TestNotes.created_id}")
        assert r2.json()["pinned"] is True

    def test_delete_note(self, s):
        r = s.delete(f"{API}/notes/{TestNotes.created_id}")
        assert r.status_code == 200
        r2 = s.get(f"{API}/notes/{TestNotes.created_id}")
        assert r2.status_code == 404


# ----- Folders CRUD + detach -----
class TestFolders:
    folder_id = None
    note_id = None

    def test_create_folder(self, s):
        r = s.post(f"{API}/folders", json={"name": "TEST_Folder", "color": "#123456"})
        assert r.status_code == 200, r.text
        f = r.json()
        assert f["name"] == "TEST_Folder"
        assert f["color"] == "#123456"
        assert "_id" not in f
        TestFolders.folder_id = f["id"]

    def test_list_folders(self, s):
        r = s.get(f"{API}/folders")
        assert r.status_code == 200
        assert any(f["id"] == TestFolders.folder_id for f in r.json())

    def test_update_folder(self, s):
        r = s.put(f"{API}/folders/{TestFolders.folder_id}", json={"name": "TEST_Folder_upd"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Folder_upd"

    def test_note_in_folder_and_filter(self, s):
        n = s.post(f"{API}/notes", json={"title": "TEST_inFolder", "folder_id": TestFolders.folder_id}).json()
        TestFolders.note_id = n["id"]
        r = s.get(f"{API}/notes", params={"folder_id": TestFolders.folder_id})
        assert r.status_code == 200
        assert any(x["id"] == TestFolders.note_id for x in r.json())

    def test_delete_folder_detaches_notes(self, s):
        r = s.delete(f"{API}/folders/{TestFolders.folder_id}")
        assert r.status_code == 200
        # Note should still exist but folder_id null
        n = s.get(f"{API}/notes/{TestFolders.note_id}").json()
        assert n["folder_id"] is None
        # Cleanup
        s.delete(f"{API}/notes/{TestFolders.note_id}")


# ----- AI Summarize -----
class TestAI:
    def test_summarize(self, s):
        payload = {"text": "Buy milk. Call mom. Finish the report by Friday."}
        r = s.post(f"{API}/ai/summarize", json=payload, timeout=60)
        assert r.status_code == 200, r.text
        summary = r.json().get("summary", "")
        assert isinstance(summary, str) and len(summary.strip()) > 0

    def test_summarize_empty(self, s):
        r = s.post(f"{API}/ai/summarize", json={"text": ""})
        assert r.status_code == 400
