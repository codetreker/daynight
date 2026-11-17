package session

import "testing"

func TestTerminalFinalizationClearsExistingPreview(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	f.s.terminalFrames = map[string]*terminalFrameWrite{m.SessionID: {raw: []byte("private screen")}}
	f.s.terminalFrameWrites = map[string]*terminalFrameWrite{m.SessionID: {raw: []byte("pending screen")}}
	finalizeFixture(t, f, m, doc)
	if len(f.s.terminalFrames) != 0 || len(f.s.terminalFrameWrites) != 0 {
		t.Fatal("finalized terminal retained transient preview")
	}
}
