package v2

import (
	"encoding/json"
	"reflect"
)

var segmentSchema = fields{"segmentId": uuid, "segmentOrdinal": positive, "executionGeneration": positive, "binding": nested(bindingSchema), "startedAt": timestamp, "endedAt": timestamp, "durationMs": decimal}
var fileSchema = fields{"fileId": uuid, "segmentId": uuid, "frameSeq": positive, "sha256": hash, "byteLength": positive, "data": func(v any) bool { _, ok := v.(string); return ok }}
var indexSchema = fields{"segmentId": uuid, "frameSeq": positive, "fileId": uuid, "firstElapsedMs": decimal, "lastElapsedMs": decimal}
var gapSchema = fields{"segmentId": uuid, "reason": enums("restart", "read_interrupted", "recording_limit", "checkpoint_lost"), "startElapsedMs": decimal, "endElapsedMs": nullable(decimal)}

var boundaryEndpointSchema = fields{"executionGeneration": positive, "segmentId": nullable(uuid)}
var boundaryGapSchema = fields{"kind": literal("boundary"), "reason": literal("restart"), "from": nested(boundaryEndpointSchema), "to": nested(boundaryEndpointSchema)}

func validGap(value any) bool {
	if mapAt(value)["kind"] != nil {
		return object(value, boundaryGapSchema)
	}
	return object(value, gapSchema)
}
func validUnavailableRun(value any) bool {
	m := mapAt(value)
	return object(value, fields{"executionGeneration": positive, "reason": unavailableReason, "evidence": func(v any) bool { return validNoRecordingEvidence(v, m["reason"]) }})
}

// DecodeArchive rejects corrupt or misattributed registered content. Gaps describe
// observation interruptions; they never excuse a missing or invalid frame file.
func DecodeArchive(data []byte) (Archive, error) {
	var out Archive
	if len(data) > MaxArchiveBytes {
		return out, invalid("recording_limit")
	}
	value, err := strictJSON(data)
	if err != nil {
		return out, err
	}
	m := mapAt(value)
	if m == nil {
		return out, invalid("invalid_payload")
	}
	if m["schemaVersion"] != float64(2) || m["projectionVersion"] != float64(1) {
		return out, invalid("unsupported_protocol")
	}
	if m["contentKind"] != "terminal_recording" || m["agentControlMode"] != "herdr" {
		return out, invalid("unsupported_content_kind")
	}
	schema := fields{"schemaVersion": literal(float64(2)), "projectionVersion": literal(float64(1)), "contentKind": literal("terminal_recording"), "agentControlMode": literal("herdr"), "sessionId": uuid, "claimId": uuid, "executionGeneration": positive, "owner": nested(ownerSchema), "finalizationId": uuid, "startedAt": timestamp, "endedAt": timestamp, "completeness": completeness, "policy": nested(fields{"sampleIntervalMs": literal(float64(SampleIntervalMillis)), "checkpointIntervalMs": literal(float64(CheckpointIntervalMillis))}), "runs": func(v any) bool { return validRuns(v, stringAt(m["executionGeneration"]), true) }, "segments": arrayOf(nested(segmentSchema), 1, MaxSegments, "segmentId"), "files": arrayOf(nested(fileSchema), 1, MaxFrames, "fileId"), "index": arrayOf(nested(indexSchema), 1, MaxFrames, "fileId"), "gaps": arrayOf(validGap, 0, MaxGaps, ""), "unavailableRuns": arrayOf(validUnavailableRun, 0, MaxRuns, "executionGeneration")}
	if !object(value, schema) {
		return out, invalid("invalid_payload")
	}
	all, err := CanonicalJSON(value)
	if err != nil {
		return out, err
	}
	content, err := CanonicalJSON(map[string]any{"files": m["files"], "index": m["index"]})
	if err != nil {
		return out, err
	}
	if len(content) > MaxRecordingBytes || len(all)-len(content) > MaxMetadataBytes {
		return out, invalid("recording_limit")
	}
	if err = json.Unmarshal(all, &out); err != nil {
		return Archive{}, invalid("invalid_payload")
	}
	if err = verifyArchive(out); err != nil {
		return Archive{}, err
	}
	return out, nil
}
func verifyArchive(archive Archive) error {
	bad := func() error { return invalid("source_corrupt") }
	start, end := timeValue(archive.StartedAt), timeValue(archive.EndedAt)
	if end.Before(start) {
		return bad()
	}
	if (archive.Completeness == "partial") != (len(archive.Gaps) > 0) {
		return bad()
	}
	runs := map[string]Run{}
	declaredSegments := map[string]string{}
	for _, run := range archive.Runs {
		if !reflect.DeepEqual(run.Owner, archive.Owner) || run.StoppedAt == nil || timeValue(run.StartedAt).Before(start) || timeValue(*run.StoppedAt).After(end) {
			return bad()
		}
		runs[run.ExecutionGeneration] = run
		for _, id := range run.SegmentIDs {
			declaredSegments[id] = run.ExecutionGeneration
		}
	}
	segments := map[string]Segment{}
	actualSegments := map[string][]string{}
	var previousOrdinal, previousGeneration int64
	for i, segment := range archive.Segments {
		ordinal := decimalValue(segment.SegmentOrdinal)
		generation := decimalValue(segment.ExecutionGeneration)
		if generation < previousGeneration || ordinal <= previousOrdinal || i == 0 && ordinal != 1 {
			return bad()
		}
		previousOrdinal, previousGeneration = ordinal, generation
		run, ok := runs[segment.ExecutionGeneration]
		if !ok || declaredSegments[segment.SegmentID] != segment.ExecutionGeneration {
			return bad()
		}
		old, _ := json.Marshal(run.Binding)
		next, _ := json.Marshal(segment.Binding)
		o, _ := strictJSON(old)
		n, _ := strictJSON(next)
		if !bindingProgression(mapAt(o), mapAt(n)) {
			return bad()
		}
		segStart, segEnd := timeValue(segment.StartedAt), timeValue(segment.EndedAt)
		if segStart.Before(timeValue(run.StartedAt)) || segEnd.After(timeValue(*run.StoppedAt)) || segEnd.Before(segStart) {
			return bad()
		}
		segments[segment.SegmentID] = segment
		actualSegments[segment.ExecutionGeneration] = append(actualSegments[segment.ExecutionGeneration], segment.SegmentID)
	}
	if len(declaredSegments) != len(segments) {
		return bad()
	}
	for _, run := range archive.Runs {
		actual := actualSegments[run.ExecutionGeneration]
		if len(actual) != len(run.SegmentIDs) {
			return bad()
		}
		for i, id := range actual {
			if id != run.SegmentIDs[i] {
				return bad()
			}
		}
	}
	var nativeID *string
	for _, run := range archive.Runs {
		if AssertNativeSessionIDProgression(nativeID, run.Binding.NativeSessionID) != nil {
			return bad()
		}
		nativeID = run.Binding.NativeSessionID
		for _, id := range run.SegmentIDs {
			binding := segments[id].Binding
			if AssertNativeSessionIDProgression(nativeID, binding.NativeSessionID) != nil {
				return bad()
			}
			nativeID = binding.NativeSessionID
		}
		if AssertNativeSessionIDProgression(nativeID, run.StopProof.Binding.NativeSessionID) != nil {
			return bad()
		}
		nativeID = run.StopProof.Binding.NativeSessionID
	}
	files := map[string]FrameFile{}
	frames := map[string]Frame{}
	frameKeys := map[string]bool{}
	for _, file := range archive.Files {
		if _, ok := segments[file.SegmentID]; !ok {
			return bad()
		}
		if len(file.Data) > MaxFrameBytes || int64(len(file.Data)) != decimalValue(file.ByteLength) || HashBytes([]byte(file.Data)) != file.SHA256 {
			return bad()
		}
		value, err := strictJSON([]byte(file.Data))
		if err != nil || !validFrame(value) {
			return bad()
		}
		frame, err := decodeValue[Frame](value)
		if err != nil || frame.FrameSeq != file.FrameSeq {
			return bad()
		}
		key := file.SegmentID + ":" + file.FrameSeq
		if frameKeys[key] {
			return bad()
		}
		frameKeys[key] = true
		files[file.FileID] = file
		frames[file.FileID] = frame
	}
	if len(archive.Index) != len(files) {
		return bad()
	}
	seen := map[string]bool{}
	observations := map[string][][2]int64{}
	var lastOrdinal, lastSeq, lastElapsed int64
	for _, entry := range archive.Index {
		file, ok := files[entry.FileID]
		if !ok || seen[entry.FileID] || file.SegmentID != entry.SegmentID || file.FrameSeq != entry.FrameSeq {
			return bad()
		}
		seen[entry.FileID] = true
		segment := segments[entry.SegmentID]
		frame := frames[entry.FileID]
		ordinal, seq := decimalValue(segment.SegmentOrdinal), decimalValue(entry.FrameSeq)
		first, last := decimalValue(entry.FirstElapsedMs), decimalValue(entry.LastElapsedMs)
		if ordinal < lastOrdinal || ordinal == lastOrdinal && (seq <= lastSeq || first <= lastElapsed) || first != decimalValue(frame.ElapsedMs) || last < first || last > decimalValue(segment.DurationMs) {
			return bad()
		}
		captured := timeValue(frame.CapturedAt)
		if captured.Before(timeValue(segment.StartedAt)) || captured.After(timeValue(segment.EndedAt)) {
			return bad()
		}
		lastOrdinal, lastSeq, lastElapsed = ordinal, seq, last
		observations[entry.SegmentID] = append(observations[entry.SegmentID], [2]int64{first, last})
	}
	// No-content evidence is exhaustive per run. It cannot authorize omitting
	// any frame file or index already selected into the sealed manifest.
	frameRuns := map[string]bool{}
	for _, file := range archive.Files {
		frameRuns[segments[file.SegmentID].ExecutionGeneration] = true
	}
	noContent := map[string]bool{}
	var previousUnavailable int64
	for _, empty := range archive.UnavailableRuns {
		generation := decimalValue(empty.ExecutionGeneration)
		if generation <= previousUnavailable || frameRuns[empty.ExecutionGeneration] {
			return invalid("invalid_payload")
		}
		if _, ok := runs[empty.ExecutionGeneration]; !ok {
			return invalid("invalid_payload")
		}
		previousUnavailable = generation
		noContent[empty.ExecutionGeneration] = true
	}
	for _, run := range archive.Runs {
		if frameRuns[run.ExecutionGeneration] == noContent[run.ExecutionGeneration] {
			return invalid("invalid_payload")
		}
	}
	endpoint := func(run Run, first bool) BoundaryEndpoint {
		out := BoundaryEndpoint{ExecutionGeneration: run.ExecutionGeneration}
		if len(run.SegmentIDs) > 0 {
			index := len(run.SegmentIDs) - 1
			if first {
				index = 0
			}
			out.SegmentID = &run.SegmentIDs[index]
		}
		return out
	}
	expectedBoundaries := []BoundaryGap{}
	for i, run := range archive.Runs {
		if i > 0 {
			expectedBoundaries = append(expectedBoundaries, BoundaryGap{Kind: "boundary", Reason: "restart", From: endpoint(archive.Runs[i-1], false), To: endpoint(run, true)})
		}
		for j := 1; j < len(run.SegmentIDs); j++ {
			expectedBoundaries = append(expectedBoundaries, BoundaryGap{Kind: "boundary", Reason: "restart", From: BoundaryEndpoint{ExecutionGeneration: run.ExecutionGeneration, SegmentID: &run.SegmentIDs[j-1]}, To: BoundaryEndpoint{ExecutionGeneration: run.ExecutionGeneration, SegmentID: &run.SegmentIDs[j]}})
		}
	}
	lastOrdinal, lastElapsed = 0, 0
	observationPosition := map[string]int{}
	boundaryPosition := 0
	boundarySeen := false
	for _, value := range archive.Gaps {
		if value.Boundary != nil {
			boundarySeen = true
			if boundaryPosition >= len(expectedBoundaries) || !reflect.DeepEqual(*value.Boundary, expectedBoundaries[boundaryPosition]) {
				return bad()
			}
			boundaryPosition++
			continue
		}
		if boundarySeen {
			return bad()
		}
		gap := value.Interval
		segment, ok := segments[gap.SegmentID]
		if !ok {
			return bad()
		}
		if noContent[segment.ExecutionGeneration] && gap.Reason != "restart" {
			return invalid("invalid_payload")
		}
		ordinal := decimalValue(segment.SegmentOrdinal)
		first := decimalValue(gap.StartElapsedMs)
		last := decimalValue(segment.DurationMs)
		if gap.EndElapsedMs != nil {
			last = decimalValue(*gap.EndElapsedMs)
		}
		if last < first || last > decimalValue(segment.DurationMs) || ordinal < lastOrdinal || ordinal == lastOrdinal && first <= lastElapsed {
			return bad()
		}
		intervals := observations[gap.SegmentID]
		position := observationPosition[gap.SegmentID]
		for position < len(intervals) && intervals[position][1] < first {
			position++
		}
		observationPosition[gap.SegmentID] = position
		if position < len(intervals) && intervals[position][0] <= last {
			return bad()
		}
		lastOrdinal, lastElapsed = ordinal, last
	}
	if boundaryPosition != len(expectedBoundaries) {
		return bad()
	}
	return nil
}
