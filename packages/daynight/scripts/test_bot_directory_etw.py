"""Explicit diagnostic-parser controls; these do not join the normal test gate."""
import importlib.util
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("filter-bot-directory-etw.py")
spec = importlib.util.spec_from_file_location("bot_etw", SCRIPT)
etw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(etw)
BASE = r"C:\repo\.tmp\bot-process-integration"
TARGET = BASE + r"\h-control\ordinary"


def time(n):
    return f"2026-11-10T01:00:{n:02d}.0000000Z"


def event(event_id, at, fields, provider=etw.FILE_PROVIDER, header_pid=999):
    root = ET.Element("Event")
    system = ET.SubElement(root, "System")
    ET.SubElement(system, "Provider", Guid="{" + provider + "}")
    ET.SubElement(system, "EventID").text = str(event_id)
    ET.SubElement(system, "Version").text = "1"
    ET.SubElement(system, "TimeCreated", SystemTime=time(at))
    ET.SubElement(system, "Execution", ProcessID=str(header_pid), ThreadID="888")
    data = ET.SubElement(root, "EventData")
    for key, value in fields.items():
        ET.SubElement(data, "Data", Name=key).text = str(value)
    return root


class ParserTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[3] / ".tmp"
        scratch.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="etw-parser-", dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.request = {"aliases": {"drive": "C:", "device": r"\Device\HarddiskVolume3"},
                        "targetBases": [BASE], "markers": {"begin": BASE + r"\begin", "end": BASE + r"\end"},
                        "initialThreads": {"startedAt": time(0), "capturedAt": time(1), "threads": [{"tid": 42, "pid": 100}]}}

    def parse(self, rows):
        root = ET.Element("Events")
        root.extend(rows)
        filename = Path(self.directory.name) / "events.xml"
        ET.ElementTree(root).write(filename, encoding="utf-8")
        return etw.filter_events(filename, self.request)

    def test_exact_device_alias_and_owned_path(self):
        aliases = self.request["aliases"]
        self.assertEqual(etw.canonical(r"\Device\HarddiskVolume3\repo\.tmp", aliases), r"c:\repo\.tmp")
        self.assertNotEqual(etw.canonical(r"\Device\HarddiskVolume30\repo\.tmp", aliases), r"c:\repo\.tmp")
        result = self.parse([event(12, 2, {"FileName": TARGET + "-other", "FileObject": "1"}), event(12, 3, {"FileName": TARGET, "FileObject": "2"})])
        self.assertEqual(result["targets"], [TARGET.casefold()])
        self.assertEqual(len(result["events"]), 1)

    def test_zero_pointers_never_correlate(self):
        result = self.parse([event(12, 2, {"FileName": TARGET, "FileObject": "0", "Irp": "0"}), event(13, 3, {"FileObject": "0"}), event(24, 4, {"Irp": "0"})])
        self.assertEqual(len(result["events"]), 1)

    def test_pointer_reuse_and_close_do_not_leak_unrelated_events(self):
        result = self.parse([event(12, 2, {"FileName": TARGET, "FileObject": "0xa", "Irp": "0xb"}),
                             event(14, 3, {"FileObject": "10"}), event(13, 4, {"FileObject": "0xa"}),
                             event(12, 5, {"FileName": r"C:\private\secret", "FileObject": "0xa", "Irp": "0xb"}),
                             event(24, 6, {"Irp": "11", "Status": "0"})])
        self.assertEqual(len(result["events"]), 2)
        self.assertNotIn("secret", json.dumps(result))

    def test_nameless_create_begins_new_object_incarnation(self):
        result = self.parse([event(12, 2, {"FileName": TARGET, "FileObject": "10"}), event(12, 3, {"FileObject": "10"}), event(13, 4, {"FileObject": "10"})])
        self.assertEqual(len(result["events"]), 1)

    def test_timestamp_regression_retains_only_direct_observations(self):
        result = self.parse([event(12, 4, {"FileName": TARGET, "FileObject": "10", "Irp": "20"}),
                             event(13, 3, {"FileObject": "10"}), event(24, 5, {"Irp": "20", "Status": "0"})])
        self.assertFalse(result["ordering"]["complete"])
        self.assertEqual(result["ordering"]["timestampRegressionCount"], 1)
        self.assertEqual([row["correlation"] for row in result["events"]], ["direct-path"])

    def test_equal_time_reuse_does_not_depend_on_xml_tie_order(self):
        target = event(12, 2, {"FileName": TARGET, "FileObject": "10"})
        unrelated = event(12, 3, {"FileName": r"C:\private\secret", "FileObject": "10"}, header_pid=123456)
        close = event(14, 3, {"FileObject": "10"}, header_pid=123456)
        cleanup = event(13, 4, {"FileObject": "10"}, header_pid=123456)
        for ties in ([unrelated, close], [close, unrelated]):
            result = self.parse([target, *ties, cleanup])
            self.assertTrue(result["ordering"]["complete"])
            self.assertEqual(result["ordering"]["ambiguousObjectTimestampCount"], 1)
            self.assertEqual(len(result["events"]), 1)
            self.assertNotIn("123456", json.dumps(result))
            self.assertNotIn("secret", json.dumps(result))

    def test_equal_time_anchor_and_irp_end_do_not_infer_lifecycle(self):
        result = self.parse([event(12, 2, {"FileName": TARGET, "FileObject": "10", "Irp": "20"}),
                             event(13, 2, {"FileObject": "10"}), event(24, 2, {"Irp": "20", "Status": "0"}),
                             event(14, 3, {"FileObject": "10"})])
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["ordering"]["ambiguousObjectTimestampCount"], 1)
        self.assertEqual(result["ordering"]["ambiguousIrpTimestampCount"], 1)

    def test_thread_reuse_attributes_issuing_thread_without_context_pid(self):
        rows = [event(12, 2, {"FileName": TARGET, "FileObject": "10", "IssuingThreadId": "42"}),
                event(4, 3, {"ProcessID": "100", "ThreadID": "42"}, etw.THREAD_PROVIDER),
                event(13, 4, {"FileObject": "10", "IssuingThreadId": "42"}),
                event(3, 5, {"ProcessID": "200", "ThreadID": "42"}, etw.THREAD_PROVIDER),
                event(14, 6, {"FileObject": "10", "IssuingThreadId": "42"})]
        result = self.parse(rows)
        self.assertEqual([row["attributedPid"] for row in result["events"]], [100, None, 200])
        self.assertTrue(all(row["headerPid"] == 999 for row in result["events"]))
        self.assertEqual(result["events"][0]["providerGuid"], etw.FILE_PROVIDER)
        self.assertEqual(result["events"][0]["version"], 1)

    def test_thread_boundary_collision_is_unknown(self):
        rows = [event(3, 2, {"ProcessID": "200", "ThreadID": "42"}, etw.THREAD_PROVIDER),
                event(4, 2, {"ProcessID": "100", "ThreadID": "42"}, etw.THREAD_PROVIDER),
                event(12, 3, {"FileName": TARGET, "FileObject": "10", "ThreadId": "42"})]
        result = self.parse(rows)
        self.assertIsNone(result["events"][0]["attributedPid"])
        self.assertEqual(result["attribution"]["threadMappings"], [])

    def test_snapshot_cannot_resurrect_stopped_thread(self):
        self.request["initialThreads"]["capturedAt"] = time(3)
        result = self.parse([event(4, 2, {"ProcessID": "100", "ThreadID": "42"}, etw.THREAD_PROVIDER), event(12, 4, {"FileName": TARGET, "FileObject": "10", "ThreadId": "42"})])
        self.assertIsNone(result["events"][0]["attributedPid"])

    def test_missing_coverage_and_conflicting_issuing_ids_remain_unknown(self):
        result = self.parse([event(12, 2, {"FileName": TARGET, "FileObject": "10", "ThreadId": "42", "TTID": "43"})])
        self.assertEqual(result["coverage"], {"begin": {"seen": False, "at": None}, "end": {"seen": False, "at": None}})
        self.assertIsNone(result["events"][0]["attributedPid"])
        result = self.parse([event(12, 2, {"FileName": self.request["markers"]["begin"]}), event(12, 3, {"FileName": self.request["markers"]["end"]})])
        self.assertTrue(all(value["seen"] for value in result["coverage"].values()))
        self.assertNotIn("begin\\", json.dumps(result))

    def test_manifest_resolves_templates_and_rejects_missing_schema(self):
        root = ET.Element("provider", guid="{" + etw.THREAD_PROVIDER + "}")
        templates = ET.SubElement(root, "templates")
        template = ET.SubElement(templates, "template", tid="thread")
        for name in ("ProcessID", "ThreadID"):
            ET.SubElement(template, "data", name=name)
        for value in (3, 4):
            ET.SubElement(root, "event", value=str(value), version="1", template="thread")
        filename = Path(self.directory.name) / "manifest.xml"
        ET.ElementTree(root).write(filename)
        self.assertTrue(etw.manifest(filename)["valid"])
        root.find("event").set("template", "missing")
        ET.ElementTree(root).write(filename)
        self.assertFalse(etw.manifest(filename)["valid"])
        inline = ET.Element("providerMetadata", guid="{" + etw.THREAD_PROVIDER + "}")
        for value in (3, 4):
            definition = ET.SubElement(inline, "event", value=str(value), version="1")
            payload = ET.SubElement(definition, "template")
            for name in ("ProcessID", "ThreadID"):
                ET.SubElement(payload, "data", name=name)
        ET.ElementTree(inline).write(filename)
        self.assertTrue(etw.manifest(filename)["valid"])
        ET.ElementTree(ET.Element("empty")).write(filename)
        self.assertFalse(etw.manifest(filename)["valid"])


if __name__ == "__main__":
    unittest.main()
