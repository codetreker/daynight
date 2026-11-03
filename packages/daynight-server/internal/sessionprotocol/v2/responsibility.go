package v2

// ControlRequestDigest binds a control request to its authenticated actor. The
// enclosing message binds the execution fence; consumers must compare both.
func ControlRequestDigest(actor string, request ControlRequest) (string, error) {
	raw, err := CanonicalJSON(map[string]any{"actorUserId": actor, "request": request})
	if err != nil {
		return "", err
	}
	return HashBytes(raw), nil
}

// SourceDigest hashes the canonical files/index selection for one registered
// run. Callers must validate the complete archive before using this helper.
// It deliberately does not replace the hash of the original archive bytes.
func SourceDigest(archive Archive, generation string) (string, error) {
	segments := map[string]bool{}
	found := false
	for _, run := range archive.Runs {
		if run.ExecutionGeneration == generation {
			found = true
			for _, id := range run.SegmentIDs {
				segments[id] = true
			}
		}
	}
	if !found {
		return "", invalid("stale_fence")
	}
	files := []FrameFile{}
	index := []FrameIndex{}
	for _, file := range archive.Files {
		if segments[file.SegmentID] {
			files = append(files, file)
		}
	}
	for _, item := range archive.Index {
		if segments[item.SegmentID] {
			index = append(index, item)
		}
	}
	raw, err := CanonicalJSON(map[string]any{"files": files, "index": index})
	if err != nil {
		return "", err
	}
	return HashBytes(raw), nil
}

// EmptySourceDigest is the fixed files/index provenance of a run without frames.
func EmptySourceDigest() string { return HashBytes([]byte(`{"files":[],"index":[]}`)) }
