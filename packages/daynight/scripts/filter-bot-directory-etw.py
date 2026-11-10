"""Retain owned Bot directory histories and conservatively attribute issuing threads."""
import argparse
import calendar
import json
import ntpath
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

FILE_PROVIDER = "edd08927-9cc4-4e65-b970-c2560fb5c289"
THREAD_PROVIDER = "22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716"
SAFE_FIELDS = ("FileObject", "Irp", "IrpPtr", "TTID", "IssuingThreadId", "ThreadId", "ShareAccess", "CreateOptions", "CreateDisposition", "CreateAttributes", "FileAttributes", "NtStatus", "Status", "ExtraInfo", "ExtraInformation")


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def number(value):
    if value is None or value == "":
        return None
    try:
        return int(str(value), 16 if str(value).lower().startswith("0x") else 10)
    except (ValueError, TypeError):
        return None


def pointer_key(value):
    parsed = number(value)
    return hex(parsed) if parsed is not None and parsed > 0 else None


def timestamp(value):
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z", value or "")
    if not match:
        return None
    try:
        seconds = calendar.timegm(datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S").timetuple())
    except ValueError:
        return None
    return seconds * 1_000_000_000 + int((match[2] or "").ljust(9, "0"))


def canonical(value, aliases):
    if value is None:
        return None
    value = value.replace("/", "\\")
    if value.startswith("\\\\?\\") or value.startswith("\\??\\"):
        value = value[4:]
    device = aliases["device"].rstrip("\\")
    if value.casefold() == device.casefold() or value.casefold().startswith(device.casefold() + "\\"):
        value = aliases["drive"].rstrip("\\") + value[len(device):]
    return ntpath.normpath(value).casefold()


def events(filename):
    parents = []
    for kind, element in ET.iterparse(filename, events=("start", "end")):
        if kind == "start":
            parents.append(element)
            continue
        if local_name(element.tag) != "Event":
            parents.pop()
            continue
        system = next((child for child in element if local_name(child.tag) == "System"), None)
        if system is None:
            raise ValueError("An ETW Event has no System metadata")
        metadata = {local_name(child.tag): child for child in system}
        execution, time, provider = (metadata.get(key) for key in ("Execution", "TimeCreated", "Provider"))
        fields = {}
        for child in element.iter():
            if local_name(child.tag) == "Data" and "Name" in child.attrib:
                if child.attrib["Name"] in fields:
                    raise ValueError("Duplicate ETW payload field")
                fields[child.attrib["Name"]] = child.text or ""
        result = {key: number(metadata[key].text) if key in metadata else None for key in ("EventID", "Version", "Opcode")}
        yield {"providerGuid": (provider.get("Guid", "") if provider is not None else "").strip("{}").casefold(),
               "eventId": result["EventID"], "version": result["Version"], "opcode": result["Opcode"],
               "at": time.get("SystemTime") if time is not None else None,
               "headerPid": number(execution.get("ProcessID") if execution is not None else None),
               "headerTid": number(execution.get("ThreadID") if execution is not None else None), "fields": fields}
        element.clear()
        if len(parents) > 1:
            parents[-2].remove(element)
        parents.pop()


def manifest(filename):
    root = ET.parse(filename).getroot()
    templates, result, errors, providers = {}, [], [], set()
    for item in root.iter():
        attrs = {key.casefold(): value for key, value in item.attrib.items()}
        if local_name(item.tag).casefold() in ("provider", "providermetadata") and "guid" in attrs:
            providers.add(attrs["guid"].strip("{}").casefold())
        if local_name(item.tag).casefold() == "template" and "tid" in attrs:
            if attrs["tid"] in templates:
                errors.append("Duplicate template " + attrs["tid"])
            templates[attrs["tid"]] = item
    for event in root.iter():
        if local_name(event.tag).casefold() != "event" or "value" not in event.attrib:
            continue
        template_id = event.get("template")
        template = templates.get(template_id)
        definitions = list(event.iter())
        if template is not None:
            definitions += list(template.iter())
        fields = [item.get("name") or item.get("Name") for item in definitions if local_name(item.tag).casefold() == "data"]
        if template_id and template is None and not fields:
            errors.append("Missing template " + template_id)
        if any(not field for field in fields):
            errors.append("Malformed payload definition for event " + event.get("value"))
        result.append({"eventId": number(event.get("value")), "version": number(event.get("version", "0")),
                       "task": event.get("task"), "opcode": event.get("opcode"), "fields": fields})
    provider = next(iter(providers)) if len(providers) == 1 else None
    required = {FILE_PROVIDER: {12: [("FileObject",), ("ShareAccess",), ("FileName", "OpenPath"), ("ThreadId", "TTID", "IssuingThreadId")],
                               13: [("FileObject",)], 14: [("FileObject",)], 24: [("Irp", "IrpPtr"), ("NtStatus", "Status")]},
                THREAD_PROVIDER: {3: [("ProcessID",), ("ThreadID",)], 4: [("ProcessID",), ("ThreadID",)]}}
    if provider not in required:
        errors.append("Missing or unsupported provider GUID")
    else:
        for event_id, groups in required[provider].items():
            definitions = [event for event in result if event["eventId"] == event_id]
            if not definitions or any(not all(any(field in event["fields"] for field in group) for group in groups) for event in definitions):
                errors.append("Unverified payload for event " + str(event_id))
    if not result:
        errors.append("No event definitions")
    return {"providerGuid": provider, "events": result, "eventCount": len(result), "valid": not errors, "errors": errors}


def issuing_tid(fields):
    values = {number(fields[key]) for key in ("IssuingThreadId", "TTID", "ThreadId") if key in fields}
    return next(iter(values)) if len(values) == 1 and next(iter(values)) not in (None, 0, 0xffffffff) else None


def attribute_threads(filename, request, retained):
    relevant = {event["issuingTid"] for event in retained if event["issuingTid"] is not None}
    snapshot = request.get("initialThreads", {})
    captured = timestamp(snapshot.get("capturedAt"))
    started = timestamp(snapshot.get("startedAt"))
    histories = {tid: [] for tid in relevant}
    thread_events = []
    for event in events(filename):
        if event["providerGuid"] != THREAD_PROVIDER or event["eventId"] not in (3, 4):
            continue
        tid, pid, at = number(event["fields"].get("ThreadID")), number(event["fields"].get("ProcessID")), timestamp(event["at"])
        if tid in histories and at is not None:
            histories[tid].append((at, "start" if event["eventId"] == 3 else "stop", pid))
            thread_events.append({key: value for key, value in event.items() if key != "fields"} | {"fields": {"ProcessID": pid, "ThreadID": tid}})
    for item in snapshot.get("threads", []):
        tid, pid = number(item.get("tid")), number(item.get("pid"))
        changed_during_snapshot = True
        if tid in histories and started is not None and captured is not None:
            changed_during_snapshot = any(started <= at <= captured for at, _, _ in histories[tid])
        if tid in histories and pid is not None and pid > 0 and captured is not None and started is not None and started <= captured and not changed_during_snapshot:
            histories[tid].append((captured, "snapshot", pid))
    intervals = {}
    for tid, history in histories.items():
        spans, active = [], None
        # A snapshot establishes presence at capturedAt, not a birth time.
        by_time = {}
        for at, kind, pid in history:
            by_time.setdefault(at, set()).add((kind, pid))
        for at, changes in sorted(by_time.items()):
            if len(changes) == 1:
                kind, pid = next(iter(changes))
            else:
                kind, pid = "ambiguous", None
            if kind == "snapshot" and active is not None and active[1] == pid:
                continue
            if active is not None:
                spans.append((active[0], at, active[1], active[2]))
            active = (at, pid, kind) if kind not in ("stop", "ambiguous") and pid is not None and pid > 0 else None
        if active is not None:
            spans.append((active[0], None, active[1], active[2]))
        intervals[tid] = spans
    mappings = []
    used = set()
    for event in retained:
        tid, at = event["issuingTid"], timestamp(event["at"])
        candidates = [span for span in intervals.get(tid, []) if at is not None and span[0] <= at and (span[1] is None or at < span[1])]
        if len(candidates) == 1:
            begin, end, pid, source = candidates[0]
            event.update(attributedPid=pid, attributionSource="thread-" + source)
            used.add((tid, begin, end, pid, source))
        else:
            event.update(attributedPid=None, attributionSource="unknown", attributionReason="No unambiguous issuing-thread lifetime covers this event")
    for tid, begin, end, pid, source in sorted(used, key=lambda value: (value[0], value[1])):
        mappings.append({"tid": tid, "pid": pid, "fromUnixNanoseconds": str(begin), "untilUnixNanoseconds": str(end) if end is not None else None, "source": source})
    observations = [event for event in thread_events if any(
        number(event["fields"]["ThreadID"]) == tid and number(event["fields"]["ProcessID"]) == pid
        and timestamp(event["at"]) in (begin, end) for tid, begin, end, pid, _ in used)]
    return {"snapshotValid": captured is not None and started is not None and started <= captured,
            "threadMappings": mappings, "threadEvents": observations, "unknownEventCount": sum(event["attributedPid"] is None for event in retained)}


def file_ordering(filename):
    # ProcessTrace attempts chronological delivery but does not order equal-time
    # events across CPUs. Validate before emitting inferred pointer associations:
    # https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-processtrace#remarks
    previous, invalid, regressions = None, 0, 0
    group_objects, group_irps, unsafe_objects, unsafe_irps = {}, {}, set(), set()

    def finish_group(at):
        for pointer, (count, boundary) in group_objects.items():
            if count > 1 and boundary:
                unsafe_objects.add((pointer, at))
        for pointer, count in group_irps.items():
            if count > 1:
                unsafe_irps.add((pointer, at))
        group_objects.clear()
        group_irps.clear()

    for event in events(filename):
        if event["providerGuid"] != FILE_PROVIDER:
            continue
        at, fields = timestamp(event["at"]), event["fields"]
        if at is None:
            invalid += 1
            continue
        if previous is not None and at < previous:
            regressions += 1
        if at != previous:
            finish_group(previous)
        previous = at
        file_object = pointer_key(fields.get("FileObject"))
        irp = pointer_key(fields.get("Irp") or fields.get("IrpPtr"))
        if file_object is not None:
            count, boundary = group_objects.get(file_object, (0, False))
            boundary = boundary or event["eventId"] in (12, 14) or any(key in fields for key in ("OpenPath", "FileName"))
            group_objects[file_object] = (count + 1, boundary)
        if irp is not None:
            group_irps[irp] = group_irps.get(irp, 0) + 1
    finish_group(previous)
    return ({"complete": invalid == 0 and regressions == 0, "invalidTimestampCount": invalid,
             "timestampRegressionCount": regressions, "ambiguousObjectTimestampCount": len(unsafe_objects),
             "ambiguousIrpTimestampCount": len(unsafe_irps)}, unsafe_objects, unsafe_irps)


def filter_events(filename, request):
    aliases = request["aliases"]
    if not re.fullmatch(r"[A-Za-z]:", aliases["drive"]) or not aliases["device"].casefold().startswith("\\device\\"):
        raise ValueError("An exact QueryDosDevice drive/device alias is required")
    bases = [canonical(value, aliases).rstrip("\\") for value in request["targetBases"]]
    markers = {key: canonical(value, aliases) for key, value in request["markers"].items()}
    coverage = {key: {"seen": False, "at": None} for key in markers}
    owned = re.compile(r"h-[A-Za-z0-9_-]+\\ordinary", re.IGNORECASE)
    targets, retained, objects, irps = set(), [], {}, {}
    ordering, unsafe_objects, unsafe_irps = file_ordering(filename)
    for event in events(filename):
        if event["providerGuid"] != FILE_PROVIDER:
            continue
        fields, at = event["fields"], timestamp(event["at"])
        named = next((fields[key] for key in ("OpenPath", "FileName") if key in fields), None)
        normalized = canonical(named, aliases)
        for key, marker in markers.items():
            if normalized == marker and at is not None:
                coverage[key] = {"seen": True, "at": event["at"]}
        target = next((normalized for base in bases if normalized is not None and normalized.startswith(base + "\\") and owned.fullmatch(normalized[len(base) + 1:])), None)
        file_object, irp = pointer_key(fields.get("FileObject")), pointer_key(fields.get("Irp") or fields.get("IrpPtr"))
        object_safe = ordering["complete"] and (file_object, at) not in unsafe_objects
        irp_safe = ordering["complete"] and (irp, at) not in unsafe_irps
        correlation = "direct-path" if target is not None else None
        if not object_safe:
            objects.pop(file_object, None)
        if not irp_safe:
            irps.pop(irp, None)
        # Every create starts a new pointer incarnation, including unrelated or
        # nameless creates. Correlations never survive a close or operation end.
        if event["eventId"] == 12 and file_object is not None:
            objects.pop(file_object, None)
        if named is not None and file_object is not None and normalized != objects.get(file_object, (None,))[0]:
            objects.pop(file_object, None)
        if event["eventId"] != 24 and irp is not None:
            irps.pop(irp, None)
        if target is not None:
            targets.add(target)
            if object_safe and file_object is not None and at is not None:
                objects[file_object] = (target, at)
        if target is None and object_safe and file_object in objects and at is not None and at >= objects[file_object][1]:
            target, correlation = objects[file_object][0], "file-object-lifetime"
        if target is None and irp_safe and event["eventId"] == 24 and irp in irps and at is not None and at >= irps[irp][1]:
            target, correlation = irps[irp][0], "irp-lifetime"
        if target is not None:
            if irp_safe and irp is not None and event["eventId"] != 24 and at is not None:
                irps[irp] = (target, at)
            safe = {key: fields[key] for key in SAFE_FIELDS if key in fields}
            if normalized == target:
                safe["path"] = target
            retained.append({key: value for key, value in event.items() if key != "fields"} | {"target": target, "fields": safe, "issuingTid": issuing_tid(fields), "correlation": correlation})
        if event["eventId"] == 14 and file_object is not None:
            objects.pop(file_object, None)
        if event["eventId"] == 24 and irp is not None:
            irps.pop(irp, None)
    attribution = attribute_threads(filename, request, retained)
    failed = {canonical(value, aliases) for value in request.get("failedTargets", [])}
    target_details = []
    for target in sorted(targets):
        related = [event for event in retained if event["target"] == target]
        windows = [case for case in request.get("caseWindows", []) if all(timestamp(case.get("startTime")) is not None and timestamp(case.get("endTime")) is not None and timestamp(event["at"]) is not None and timestamp(case["startTime"]) <= timestamp(event["at"]) <= timestamp(case["endTime"]) for event in related)]
        target_details.append({"target": target, "removalFailure": target in failed, "case": windows[0] if len(windows) == 1 else None})
    return {"targets": sorted(targets), "targetDetails": target_details, "coverage": coverage, "events": retained,
            "ordering": ordering, "attribution": attribution}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest")
    parser.add_argument("--events")
    parser.add_argument("--request")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = manifest(args.manifest) if args.manifest else filter_events(args.events, json.loads(Path(args.request).read_text(encoding="utf-8")))
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
