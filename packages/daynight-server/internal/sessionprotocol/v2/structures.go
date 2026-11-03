package v2

import (
	"reflect"
	"strings"
	"unicode"
)

var ownerSchema = fields{"projectId": uuid, "taskId": uuid, "workerId": uuid, "worktreeId": uuid, "ownerUserId": uuid, "serverOrigin": origin, "provider": enums("codex", "claude", "copilot")}
var bindingSchema = fields{"instanceId": native, "sessionId": native, "workspaceId": native, "paneId": func(v any) bool { return native(v) || integer(v, 0, 4294967295) }, "terminalId": native, "nativeSessionId": nullable(native)}
var runSchema = fields{"executionGeneration": positive, "owner": nested(ownerSchema), "binding": nested(bindingSchema), "startedAt": timestamp, "stoppedAt": nullable(timestamp), "stopProof": nullable(validStopProof), "segmentIds": arrayOf(uuid, 0, MaxSegments, "$")}
var styleSchema = fields{"text": func(v any) bool { s, ok := v.(string); return ok && strings.IndexFunc(s, unicode.IsControl) < 0 }, "foreground": nullable(func(v any) bool { return colorRE.MatchString(stringAt(v)) }), "background": nullable(func(v any) bool { return colorRE.MatchString(stringAt(v)) }), "bold": boolean, "italic": boolean, "underline": boolean, "inverse": boolean}

// AssertNativeSessionIDProgression allows the first observed native ID to fill
// null, but never permits an identified conversation to change or become unknown.
func AssertNativeSessionIDProgression(previous, next *string) error {
	if previous != nil && (!native(*previous) || next == nil || *previous != *next) {
		return invalid("target_changed")
	}
	if next != nil && !native(*next) {
		return invalid("invalid_payload")
	}
	return nil
}
func bindingProgression(previous, next map[string]any) bool {
	for _, key := range []string{"instanceId", "sessionId", "workspaceId", "paneId", "terminalId"} {
		if !reflect.DeepEqual(previous[key], next[key]) {
			return false
		}
	}
	return previous["nativeSessionId"] == nil || reflect.DeepEqual(previous["nativeSessionId"], next["nativeSessionId"])
}
func validStopProof(v any) bool {
	processSchema := fields{"role": enums("shell", "agent"), "pid": boundedInt(1, 2147483647), "birthToken": native, "bootId": native}
	if !object(v, fields{"recordId": uuid, "executionGeneration": positive, "binding": nested(bindingSchema), "bootId": native, "stoppedAt": timestamp, "method": enums("instances_exited", "boot_changed"), "terminalStopped": literal(true), "processes": arrayOf(nested(processSchema), 2, 1000, "")}) {
		return false
	}
	m := mapAt(v)
	roles := map[string]bool{}
	identities := map[string]bool{}
	for _, value := range m["processes"].([]any) {
		p := mapAt(value)
		if p["bootId"] != m["bootId"] {
			return false
		}
		b, _ := CanonicalJSON([]any{p["bootId"], p["pid"], p["birthToken"]})
		key := string(b)
		if identities[key] {
			return false
		}
		identities[key] = true
		roles[stringAt(p["role"])] = true
	}
	return roles["shell"] && roles["agent"]
}
func validRun(v any) bool {
	if !object(v, runSchema) {
		return false
	}
	m := mapAt(v)
	proof := mapAt(m["stopProof"])
	if (m["stoppedAt"] == nil) != (proof == nil) {
		return false
	}
	if proof == nil {
		return true
	}
	return m["executionGeneration"] == proof["executionGeneration"] && m["stoppedAt"] == proof["stoppedAt"] && bindingProgression(mapAt(m["binding"]), mapAt(proof["binding"])) && !timeValue(stringAt(m["stoppedAt"])).Before(timeValue(stringAt(m["startedAt"])))
}
func validRuns(v any, generation string, allStopped bool) bool {
	if !arrayOf(validRun, 1, MaxRuns, "")(v) {
		return false
	}
	runs := v.([]any)
	segments := map[string]bool{}
	var previousNative any
	for i, value := range runs {
		r := mapAt(value)
		if decimalValue(stringAt(r["executionGeneration"])) != int64(i+1) {
			return false
		}
		if i > 0 && !reflect.DeepEqual(mapAt(runs[0])["owner"], r["owner"]) {
			return false
		}
		if (allStopped || i < len(runs)-1) && r["stoppedAt"] == nil {
			return false
		}

		id := mapAt(r["binding"])["nativeSessionId"]
		if previousNative != nil && !reflect.DeepEqual(previousNative, id) {
			return false
		}
		if id != nil {
			previousNative = id
		}
		if proof := mapAt(r["stopProof"]); proof != nil {
			stopID := mapAt(proof["binding"])["nativeSessionId"]
			if previousNative != nil && previousNative != stopID {
				return false
			}
			if stopID != nil {
				previousNative = stopID
			}
		}
		for _, id := range r["segmentIds"].([]any) {
			s := stringAt(id)
			if segments[s] {
				return false
			}
			segments[s] = true
		}
	}
	return mapAt(runs[len(runs)-1])["executionGeneration"] == generation
}
func validFrame(v any) bool {
	if !object(v, fields{"frameSeq": positive, "capturedAt": timestamp, "elapsedMs": decimal, "width": boundedInt(1, MaxDimension), "height": boundedInt(1, MaxDimension), "full": literal(true), "rows": arrayOf(arrayOf(nested(styleSchema), 0, MaxTextRuns, ""), 1, MaxDimension, "")}) {
		return false
	}
	m := mapAt(v)
	rows := m["rows"].([]any)
	if len(rows) != int(m["height"].(float64)) {
		return false
	}
	for _, row := range rows {
		size := 0
		for _, run := range row.([]any) {
			size += len(stringAt(mapAt(run)["text"]))
		}
		if size > MaxRowBytes {
			return false
		}
	}
	bytes, e := CanonicalJSON(v)
	return e == nil && len(bytes) <= MaxFrameBytes
}
func validPaste(v any) bool {
	s, ok := v.(string)
	if !ok || len(s) == 0 || len(s) > MaxPasteBytes {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) < 0
}
