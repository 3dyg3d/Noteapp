import os, pytest, requests, uuid
BASE = os.environ.get('EXPO_BACKEND_URL','').rstrip('/') or 'http://localhost:8001'

@pytest.fixture
def s():
    return requests.Session()

def test_root(s):
    r = s.get(f"{BASE}/api/")
    assert r.status_code == 200

def test_list_active(s):
    r = s.get(f"{BASE}/api/notes?status=active")
    assert r.status_code == 200
    assert isinstance(r.json(), list)

def test_create_handwriting_with_drawing_data(s):
    payload = {"title":"TEST_hw","content":"","note_type":"handwriting",
               "drawing_data":'{"paper":"grid","paperSize":"a4","items":[]}'}
    r = s.post(f"{BASE}/api/notes", json=payload)
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["note_type"] == "handwriting"
    assert n["drawing_data"] and "grid" in n["drawing_data"]
    # GET verify
    g = s.get(f"{BASE}/api/notes/{n['id']}")
    assert g.status_code == 200
    assert g.json()["drawing_data"] == n["drawing_data"]
    # trash + restore
    d = s.delete(f"{BASE}/api/notes/{n['id']}")
    assert d.status_code == 200
    r2 = s.post(f"{BASE}/api/notes/{n['id']}/restore")
    assert r2.status_code == 200
    assert r2.json()["deleted_at"] is None
    s.delete(f"{BASE}/api/notes/{n['id']}?permanent=true")

def test_folders_nested(s):
    p = s.post(f"{BASE}/api/folders", json={"name":f"TEST_p_{uuid.uuid4().hex[:6]}","color":"#638C61"}).json()
    c = s.post(f"{BASE}/api/folders", json={"name":f"TEST_c_{uuid.uuid4().hex[:6]}","parent_id":p["id"]}).json()
    lst = s.get(f"{BASE}/api/folders").json()
    ids = {f["id"]: f for f in lst}
    assert p["id"] in ids and c["id"] in ids
    assert ids[c["id"]]["parent_id"] == p["id"]
    s.delete(f"{BASE}/api/folders/{c['id']}")
    s.delete(f"{BASE}/api/folders/{p['id']}")
