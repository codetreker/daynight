package inputlimitreport

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
)

func recordOfSize(n int) []byte {
	return []byte(`{"v":"` + strings.Repeat("a", n-9) + `"}`)
}

type flushWriter struct {
	bytes.Buffer
	flushes int
	err     error
}

func (w *flushWriter) Flush() error { w.flushes++; return w.err }

func TestWriterBoundariesAndIncompleteSummary(t *testing.T) {
	var dst flushWriter
	w := New(&dst)
	w.maxRecord = 32
	w.maxReport = 96
	r := recordOfSize(32)
	if len(r)+1 != 32 {
		t.Fatal("bad fixture")
	}
	for i := 0; i < 2; i++ {
		if err := w.WriteRecord(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteRecord([]byte(`{}`)); !errors.Is(err, ErrReportBudget) {
		t.Fatalf("expected report budget, got %v", err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":true}`)); !errors.Is(err, ErrRecordBudget) {
		t.Fatalf("summary over record budget: %v", err)
	}
	// Use a larger reservation to exercise explicit incomplete summaries.
	w.maxRecord = 64
	w.maxReport = 128
	if err := w.Finish([]byte(`{"type":"summary","complete":true}`)); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("complete summary accepted: %v", err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":false,"clear":true}`)); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("clear summary accepted: %v", err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":false}`)); err != nil {
		t.Fatal(err)
	}
	if w.Records() != 3 || w.Bytes() != int64(dst.Len()) || dst.flushes != 3 {
		t.Fatalf("incorrect accounting: records %d bytes %d flushes %d", w.Records(), w.Bytes(), dst.flushes)
	}
	if err := w.WriteRecord([]byte(`{}`)); !errors.Is(err, ErrFinished) {
		t.Fatal(err)
	}
}

func TestWriterRealRecordAndReportBudgets(t *testing.T) {
	w := New(io.Discard)
	r := recordOfSize(MaxRecordBytes)
	if err := w.WriteRecord(append(r, ' ')); !errors.Is(err, ErrRecordBudget) {
		t.Fatalf("expected record budget, got %v", err)
	}
	w = New(io.Discard)
	for i := 0; i < MaxReportBytes/MaxRecordBytes-1; i++ {
		if err := w.WriteRecord(r); err != nil {
			t.Fatal(i, err)
		}
	}
	if err := w.WriteRecord([]byte(`{}`)); !errors.Is(err, ErrReportBudget) {
		t.Fatal(err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":false}`)); err != nil {
		t.Fatal(err)
	}
	if w.Bytes() > MaxReportBytes {
		t.Fatal("exceeded total budget")
	}
}

func TestWriterInvalidAndIOErrors(t *testing.T) {
	for _, r := range []string{"[]", "{}\n{}", "{", "{}\r"} {
		w := New(io.Discard)
		if err := w.WriteRecord([]byte(r)); !errors.Is(err, ErrInvalidRecord) {
			t.Fatalf("%q: %v", r, err)
		}
		if err := w.Finish([]byte(`{"type":"summary","complete":false}`)); err != nil {
			t.Fatal(err)
		}
	}
	boom := errors.New("flush failed")
	f := &flushWriter{err: boom}
	w := New(f)
	if err := w.WriteRecord([]byte(`{}`)); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":false}`)); !errors.Is(err, boom) {
		t.Fatal(err)
	}
}

func TestWriterRejectsSummaryCaseAliases(t *testing.T) {
	for _, record := range []string{
		`{"type":"summary","complete":false,"Complete":true}`,
		`{"type":"summary","complete":true,"Clear":true}`,
		`{"Type":"summary","complete":true}`,
	} {
		w := New(io.Discard)
		if err := w.Finish([]byte(record)); !errors.Is(err, ErrInvalidRecord) {
			t.Fatalf("%s: %v", record, err)
		}
	}
}

type chunkBuffer struct{ bytes.Buffer }

func (c *chunkBuffer) Close() error { return nil }

type shortWriter struct{}

func (shortWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

type failingChunk struct{ err error }

func (f failingChunk) Write([]byte) (int, error) { return 0, f.err }
func (f failingChunk) Close() error              { return nil }

func TestWriteFailurePreservesCause(t *testing.T) {
	w := New(shortWriter{})
	if err := w.WriteRecord([]byte(`{}`)); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	if err := w.Finish([]byte(`{"type":"summary","complete":false}`)); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	boom := errors.New("chunk failed")
	_, err := Split(strings.NewReader("{}\n"), func(int) (io.WriteCloser, error) { return failingChunk{boom}, nil })
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
}

func TestSplitAtRecordBoundaries(t *testing.T) {
	line := append(recordOfSize(32), '\n')
	src := bytes.Repeat(line, 5)
	var output []*chunkBuffer
	manifest, err := split(bytes.NewReader(src), func(i int) (io.WriteCloser, error) {
		if i != len(output)+1 {
			t.Fatalf("wrong index %d", i)
		}
		c := &chunkBuffer{}
		output = append(output, c)
		return c, nil
	}, 32, 64, 160)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest) != 3 {
		t.Fatalf("chunks %d", len(manifest))
	}
	var joined []byte
	for i, m := range manifest {
		b := output[i].Bytes()
		h := sha256.Sum256(b)
		if m.Index != i+1 || m.Bytes != int64(len(b)) || m.Records != int64(len(b)/len(line)) || m.SHA256 != hex.EncodeToString(h[:]) || len(b) > 64 {
			t.Fatalf("bad manifest: %+v", m)
		}
		joined = append(joined, b...)
	}
	if !bytes.Equal(joined, src) {
		t.Fatal("chunks changed report")
	}
}

func TestSplitRejectsIncompleteAndOversizedInput(t *testing.T) {
	create := func(int) (io.WriteCloser, error) { return &chunkBuffer{}, nil }
	for _, tc := range []struct {
		input string
		limit int64
		want  error
	}{
		{"{}", 64, ErrInvalidRecord},
		{strings.Repeat("x", 33) + "\n", 64, ErrRecordBudget},
		{"{}\n{}\n", 5, ErrReportBudget},
	} {
		if _, err := split(strings.NewReader(tc.input), create, 32, 64, tc.limit); !errors.Is(err, tc.want) {
			t.Fatalf("input %q: %v", tc.input, err)
		}
	}
}

func TestSplitRealChunkBoundary(t *testing.T) {
	line := append(recordOfSize(MaxRecordBytes), '\n')
	input := bytes.Repeat(line, MaxChunkBytes/MaxRecordBytes+1)
	var output []*chunkBuffer
	manifest, err := Split(bytes.NewReader(input), func(int) (io.WriteCloser, error) {
		c := &chunkBuffer{}
		output = append(output, c)
		return c, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest) != 2 || manifest[0].Bytes != MaxChunkBytes || manifest[1].Bytes != MaxRecordBytes || manifest[0].Records != MaxChunkBytes/MaxRecordBytes {
		t.Fatalf("bad chunk boundaries: %+v", manifest)
	}
	if !bytes.Equal(append(output[0].Bytes(), output[1].Bytes()...), input) {
		t.Fatal("split changed report")
	}
}
