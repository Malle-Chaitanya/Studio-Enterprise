"""_caller_headers must tell three cases apart, against the REAL module.

Google impersonation is applied at token mint, not as a header, so the send site has
nothing to add — but "nothing to add" must not be reachable by a connector that simply
has no mechanism. Those two both produce an empty-looking result and only one of them
is safe, which is how Sheets and Tasks lost the whole generic path to a refusal.

An existing spike (_test_caller_any_call.py) re-implements this decision rather than
importing it, so it agreed with itself while the shipped function did something else.
These call the shipped one.
"""
import importlib.util
import pathlib

import pytest

_SRC = pathlib.Path(__file__).with_name("generic_rest.py")
_spec = importlib.util.spec_from_file_location("generic_rest", _SRC)
generic_rest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(generic_rest)

GOOGLE = {"name": "Google Sheets", "perUser": True, "perUserMode": "impersonate",
          "impersonationResolve": "google-dwd-subject"}
DATAVERSE = {"name": "Dataverse", "perUser": True, "perUserMode": "impersonate",
             "impersonationResolve": "dataverse-systemuser", "impersonationHeader": "MSCRMCallerID"}
NO_MECHANISM = {"name": "Jira", "perUser": True, "perUserMode": "impersonate",
                "impersonationResolve": "atlassian-none"}
SHARED = {"name": "Confluence"}


def test_google_sends_no_header_instead_of_refusing():
    """The bug: Google raised here, killing every Sheets and Tasks call."""
    fn = _resolve(GOOGLE, "ron@corp.com")
    assert fn("https://sheets.googleapis.com/v4/spreadsheets/x", "Bearer t") == {}


def test_connector_with_no_mechanism_still_refuses():
    """The guard that must survive the fix: an empty dict here would run as the app."""
    fn = _resolve(NO_MECHANISM, "ron@corp.com")
    with pytest.raises(RuntimeError, match="no way to act as another person"):
        fn("https://yourco.atlassian.net/rest/api/3/search", "Bearer t")


def test_shared_credential_connector_is_untouched():
    fn = _resolve(SHARED, "")
    assert fn("https://example.test/x", "Bearer t") == {}


def _resolve(conn, caller_value):
    """Build the tools and hand back the real _caller_headers closure."""
    import types

    holder = {}
    real_build = generic_rest.build_tools

    def _secret(name, default=""):
        return default

    def _mint(*a, **k):
        return "test-token"

    def _auth_header(*a, **k):
        return "Bearer test-token"

    def _fill(v, *a, **k):
        return v

    # The closure is not exported, so capture it from the frame build_tools runs in.
    import sys

    def _trace(frame, event, arg):
        if event == "return" and frame.f_code is real_build.__code__:
            holder["fn"] = frame.f_locals.get("_caller_headers")
        return _trace

    sys.settrace(_trace)
    try:
        real_build(conn, _secret, _mint, _auth_header, _fill, caller=lambda: caller_value)
    finally:
        sys.settrace(None)
    assert isinstance(holder.get("fn"), types.FunctionType), "could not reach _caller_headers"
    return holder["fn"]
