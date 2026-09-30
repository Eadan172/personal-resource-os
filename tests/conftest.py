import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from personal_agent_core import db  # noqa: E402
from personal_agent_core.providers.mock import MockProvider  # noqa: E402


@pytest.fixture()
def conn(tmp_path):
    c = db.init_db(str(tmp_path / "test.db"))
    yield c
    c.close()


@pytest.fixture()
def provider():
    return MockProvider()
