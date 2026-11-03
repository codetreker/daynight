//go:build stress

package v2

import (
	"fmt"
	"strings"
	"testing"
)

func TestExactByteAndCountLimits(t *testing.T) {
	base := fixtureBytes(t, "valid-archive")
	padded := append(append([]byte{}, base...), []byte(strings.Repeat(" ", MaxArchiveBytes-len(base)))...)
	if _, e := DecodeArchive(padded); e != nil {
		t.Fatal(e)
	}
	padded = append(padded, ' ')
	if _, e := DecodeArchive(padded); e == nil {
		t.Fatal("oversized archive accepted")
	}
	registration := []byte(registrationJSON)
	message := append(append([]byte{}, registration...), []byte(strings.Repeat(" ", MaxMetadataBytes-len(registration)))...)
	if _, e := DecodeMessage(message); e != nil {
		t.Fatal(e)
	}
	message = append(message, ' ')
	if _, e := DecodeMessage(message); e == nil {
		t.Fatal("oversized message accepted")
	}
	for _, test := range []struct {
		key string
		max int
	}{{"files", MaxFrames}, {"index", MaxFrames}, {"segments", MaxSegments}, {"gaps", MaxGaps}, {"runs", MaxRuns}} {
		a := fixtureObject(t, "valid-archive")
		a[test.key] = make([]any, test.max+1)
		if _, e := DecodeArchive(wireBytes(t, a)); e == nil {
			t.Fatalf("oversized %s accepted", test.key)
		}
	}
}

func TestExactSegmentAndGapLimit(t *testing.T) {
	archive := fixtureObject(t, "valid-archive")
	original := mapAt(archive["segments"].([]any)[0])
	segments := []any{}
	ids := []any{}
	gaps := []any{}
	for i := 0; i < MaxSegments; i++ {
		s := map[string]any{}
		for k, v := range original {
			s[k] = v
		}
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+100)
		if i == 0 {
			id = stringAt(original["segmentId"])
		}
		s["segmentId"] = id
		s["segmentOrdinal"] = fmt.Sprint(i + 1)
		segments = append(segments, s)
		ids = append(ids, id)
		if i == 0 {
			gaps = append(gaps, map[string]any{"segmentId": id, "reason": "read_interrupted", "startElapsedMs": "5001", "endElapsedMs": "5002"})
		} else {
			gaps = append(gaps, map[string]any{"kind": "boundary", "reason": "restart", "from": map[string]any{"executionGeneration": "1", "segmentId": ids[i-1]}, "to": map[string]any{"executionGeneration": "1", "segmentId": id}})
		}
	}
	archive["segments"], archive["gaps"], archive["completeness"] = segments, gaps, "partial"
	mapAt(archive["runs"].([]any)[0])["segmentIds"] = ids
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
}

func archiveWithFrames(t *testing.T, count int, pad bool) Archive {
	t.Helper()
	archive, e := DecodeArchive(fixtureBytes(t, "valid-archive"))
	if e != nil {
		t.Fatal(e)
	}
	segmentID := archive.Segments[0].SegmentID
	archive.Segments[0].DurationMs = fmt.Sprint(count)
	archive.Files = make([]FrameFile, count)
	archive.Index = make([]FrameIndex, count)
	for i := 0; i < count; i++ {
		data := wireBytes(t, Frame{FrameSeq: fmt.Sprint(i + 1), CapturedAt: archive.StartedAt, ElapsedMs: fmt.Sprint(i), Width: 1, Height: 1, Full: true, Rows: [][]StyledText{{}}})
		if pad {
			data = append(data, []byte(strings.Repeat(" ", MaxFrameBytes-len(data)))...)
		}
		fileID := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+100)
		archive.Files[i] = FrameFile{FileID: fileID, SegmentID: segmentID, FrameSeq: fmt.Sprint(i + 1), SHA256: HashBytes(data), ByteLength: fmt.Sprint(len(data)), Data: string(data)}
		archive.Index[i] = FrameIndex{SegmentID: segmentID, FrameSeq: fmt.Sprint(i + 1), FileID: fileID, FirstElapsedMs: fmt.Sprint(i), LastElapsedMs: fmt.Sprint(i)}
	}
	return archive
}

func TestArchiveFrameCountMaximum(t *testing.T) {
	archive := archiveWithFrames(t, MaxFrames, false)
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	archive.Files = append(archive.Files, archive.Files[0])
	archive.Index = append(archive.Index, archive.Index[0])
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("over-limit frame count accepted")
	}
}

func TestExactRecordingBudget(t *testing.T) {
	archive := archiveWithFrames(t, 240, true)
	last := &archive.Files[len(archive.Files)-1]
	contentSize := func() int {
		b, e := CanonicalJSON(map[string]any{"files": archive.Files, "index": archive.Index})
		if e != nil {
			t.Fatal(e)
		}
		return len(b)
	}
	for i := 0; i < 3; i++ {
		excess := contentSize() - MaxRecordingBytes
		if excess > 0 {
			last.Data = last.Data[:len(last.Data)-excess]
		} else {
			last.Data += strings.Repeat(" ", -excess)
		}
		last.ByteLength = fmt.Sprint(len(last.Data))
	}
	last.SHA256 = HashBytes([]byte(last.Data))
	if contentSize() != MaxRecordingBytes {
		t.Fatal("recording boundary construction failed")
	}
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	last.Data += " "
	last.ByteLength = fmt.Sprint(len(last.Data))
	last.SHA256 = HashBytes([]byte(last.Data))
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("recording budget exceeded")
	}
}

func TestExactMetadataBudget(t *testing.T) {
	archive, e := DecodeArchive(fixtureBytes(t, "valid-archive"))
	if e != nil {
		t.Fatal(e)
	}
	original := archive.Runs[0]
	archive.ExecutionGeneration = "8"
	archive.Runs = nil
	archive.Gaps = nil
	archive.Completeness = "partial"
	for i := 0; i < 8; i++ {
		run := original
		proof := *original.StopProof
		run.StopProof = &proof
		run.ExecutionGeneration = fmt.Sprint(i + 1)
		proof.ExecutionGeneration = run.ExecutionGeneration
		proof.RecordID = fmt.Sprintf("00000000-0000-4000-8000-%012d", 800+i)
		proof.BootID = strings.Repeat("b", 256)
		proof.Processes = nil
		for j := 0; j < 1000; j++ {
			role := "agent"
			if j == 0 {
				role = "shell"
			}
			token := fmt.Sprintf("token:%d:%d:", i, j)
			token += strings.Repeat("x", 256-len(token))
			proof.Processes = append(proof.Processes, ProcessProof{Role: role, PID: j + 100, BirthToken: token, BootID: proof.BootID})
		}
		if i > 0 {
			run.SegmentIDs = []string{}
			archive.UnavailableRuns = append(archive.UnavailableRuns, UnavailableRun{ExecutionGeneration: run.ExecutionGeneration, Reason: "ended_before_first_sample", Evidence: NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			from := BoundaryEndpoint{ExecutionGeneration: fmt.Sprint(i)}
			if i == 1 {
				from.SegmentID = &original.SegmentIDs[0]
			}
			archive.Gaps = append(archive.Gaps, Gap{Boundary: &BoundaryGap{Kind: "boundary", Reason: "restart", From: from, To: BoundaryEndpoint{ExecutionGeneration: run.ExecutionGeneration}}})
		}
		archive.Runs = append(archive.Runs, run)
	}
	content, e := CanonicalJSON(map[string]any{"files": archive.Files, "index": archive.Index})
	if e != nil {
		t.Fatal(e)
	}
	metadataSize := func() int {
		all, e := CanonicalJSON(archive)
		if e != nil {
			t.Fatal(e)
		}
		return len(all) - len(content)
	}
	excess := metadataSize() - MaxMetadataBytes
	if excess <= 0 {
		t.Fatal("metadata test must start above budget")
	}
	for i := range archive.Runs {
		for j := range archive.Runs[i].StopProof.Processes {
			p := &archive.Runs[i].StopProof.Processes[j]
			remove := min(excess, len(p.BirthToken)-24)
			p.BirthToken = p.BirthToken[:len(p.BirthToken)-remove]
			excess -= remove
		}
	}
	if excess != 0 || metadataSize() != MaxMetadataBytes {
		t.Fatal("metadata boundary construction failed")
	}
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	archive.Runs[0].StopProof.Processes[0].BirthToken += "x"
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("metadata budget exceeded")
	}
}
