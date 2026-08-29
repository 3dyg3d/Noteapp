"""Geodesic Notes API tests - notes, folders, AI summarize."""
import os
import pytest
import requests

# No default: these are integration tests and must be pointed at a server
# deliberately. The previous default was a vendor preview URL, so an accidental
# run wrote test notes into whatever was deployed there.
BASE_URL = os.environ.get("GEODESIC_API_URL", "http://localhost:8000").rstrip("/")
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

    def test_delete_note_soft_then_restore(self, s):
        # Soft delete: note still exists, listed under trash, restorable
        r = s.delete(f"{API}/notes/{TestNotes.created_id}")
        assert r.status_code == 200
        # Should appear in trash list
        trash = s.get(f"{API}/notes", params={"status": "trash"}).json()
        assert any(n["id"] == TestNotes.created_id for n in trash)
        # Not in active list
        active = s.get(f"{API}/notes", params={"status": "active"}).json()
        assert all(n["id"] != TestNotes.created_id for n in active)
        # Restore
        rr = s.post(f"{API}/notes/{TestNotes.created_id}/restore")
        assert rr.status_code == 200, rr.text
        assert rr.json().get("deleted_at") is None
        # Permanent delete
        rp = s.delete(f"{API}/notes/{TestNotes.created_id}", params={"permanent": True})
        assert rp.status_code == 200
        r2 = s.get(f"{API}/notes/{TestNotes.created_id}")
        assert r2.status_code == 404


# ----- Nested folders -----
class TestNestedFolders:
    parent_id = None
    child_id = None

    def test_create_parent_and_child(self, s):
        p = s.post(f"{API}/folders", json={"name": "TEST_Parent"}).json()
        TestNestedFolders.parent_id = p["id"]
        c = s.post(f"{API}/folders", json={"name": "TEST_Child", "parent_id": p["id"]}).json()
        assert c["parent_id"] == p["id"]
        TestNestedFolders.child_id = c["id"]

    def test_delete_parent_promotes_child(self, s):
        s.delete(f"{API}/folders/{TestNestedFolders.parent_id}")
        listing = s.get(f"{API}/folders").json()
        child = next((f for f in listing if f["id"] == TestNestedFolders.child_id), None)
        assert child is not None
        assert child["parent_id"] is None
        s.delete(f"{API}/folders/{TestNestedFolders.child_id}")


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
