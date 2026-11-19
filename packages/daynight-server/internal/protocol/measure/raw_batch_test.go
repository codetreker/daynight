package measure

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

type rawRecordingWriter struct {
	bytes.Buffer
	calls    int
	maxWrite int
}

func (w *rawRecordingWriter) Write(p []byte) (int, error) {
	w.calls++
	w.maxWrite = max(w.maxWrite, len(p))
	return w.Buffer.Write(p)
}

func TestRawBatchMatchesEncoderAcrossEscapeBoundaries(t *testing.T) {
	for padding := 4084; padding <= 4100; padding++ {
		t.Run(fmt.Sprint(padding), func(t *testing.T) {
			raw := json.RawMessage(` { "payload": "` + strings.Repeat("a", padding) + `<>&€` + "\u2028\u2029" + ` \\ \" \u003c \u2028 ", "list": [ true, null, -1.25, { "a": "  x y  " } ] } `)
			var expected bytes.Buffer
			if err := json.NewEncoder(&expected).Encode(raw); err != nil {
				t.Fatal(err)
			}
			var actual rawRecordingWriter
			n, err := JSON(&actual, "raw", int64(expected.Len()), raw, true)
			if err != nil || n != int64(expected.Len()) || !bytes.Equal(actual.Bytes(), expected.Bytes()) {
				t.Fatalf("padding=%d n=%d output=%d expected=%d error=%v", padding, n, actual.Len(), expected.Len(), err)
			}
			if actual.maxWrite > 4096 || actual.calls > (expected.Len()+4095)/4096+1 {
				t.Fatalf("raw output was not bounded and batched: calls=%d largest=%d output=%d", actual.calls, actual.maxWrite, actual.Len())
			}
		})
	}
	for _, invalid := range [][]byte{{0xff}, {0xe2}, {0xe2, 0x80}} {
		invalidUTF8 := json.RawMessage(`"` + strings.Repeat("a", 4094) + string(invalid) + `<` + "\u2028" + `"`)
		want, err := json.Marshal(invalidUTF8)
		if err != nil {
			t.Fatal(err)
		}
		var actual bytes.Buffer
		if n, err := JSON(&actual, "raw", int64(len(want)), invalidUTF8, false); err != nil || n != int64(len(want)) || !bytes.Equal(actual.Bytes(), want) {
			t.Fatalf("RawMessage byte semantics changed: bytes=%x n=%d output=%d expected=%d error=%v", invalid, n, actual.Len(), len(want), err)
		}
	}
}

func TestRawBatchBudgetCountsOnlyAcceptedBytes(t *testing.T) {
	raw := json.RawMessage(`"` + strings.Repeat("<&", 3000) + `"`)
	want, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, budget := range []int64{0, 1, 4095, 4096, 4097, int64(len(want) - 1)} {
		t.Run(fmt.Sprint(budget), func(t *testing.T) {
			var actual rawRecordingWriter
			n, err := JSON(&actual, "raw", budget, raw, false)
			var violation *limit.Violation
			if !errors.As(err, &violation) || violation.Field != "raw" || violation.Max != budget || violation.Actual != budget+1 || violation.Unit != "bytes" || !violation.LowerBound {
				t.Fatalf("budget=%d violation=%+v error=%v", budget, violation, err)
			}
			if n != int64(actual.Len()) || n > budget || !bytes.HasPrefix(want, actual.Bytes()) || actual.maxWrite > 4096 {
				t.Fatalf("budget=%d counted=%d written=%d largest=%d", budget, n, actual.Len(), actual.maxWrite)
			}
		})
	}
	var actual bytes.Buffer
	if n, err := JSON(&actual, "raw", int64(len(want)), raw, false); err != nil || n != int64(len(want)) || !bytes.Equal(actual.Bytes(), want) {
		t.Fatalf("exact byte budget refused: n=%d output=%d expected=%d error=%v", n, actual.Len(), len(want), err)
	}
}

type rawControlledWriter struct {
	write func([]byte) (int, error)
}

func (w rawControlledWriter) Write(p []byte) (int, error) { return w.write(p) }

func TestRawBatchPropagatesMidstreamErrorsAndShortWrites(t *testing.T) {
	sentinel := errors.New("raw writer sentinel")
	for index, raw := range []json.RawMessage{
		json.RawMessage(`"` + strings.Repeat("x", 9000) + `"`),
		json.RawMessage(` { "payload": "` + strings.Repeat("x", 9000) + `", "end": true } `),
	} {
		for _, short := range []bool{false, true} {
			t.Run(fmt.Sprintf("shape=%d/short=%t", index, short), func(t *testing.T) {
				calls, accepted := 0, 0
				writer := rawControlledWriter{write: func(p []byte) (int, error) {
					calls++
					if len(p) > 4096 {
						t.Fatalf("unbounded raw write: %d", len(p))
					}
					if calls == 2 {
						if short {
							accepted += len(p) - 1
							return len(p) - 1, nil
						}
						return 0, sentinel
					}
					accepted += len(p)
					return len(p), nil
				}}
				n, err := JSON(writer, "raw", int64(len(raw)), raw, false)
				wantErr := sentinel
				if short {
					wantErr = io.ErrShortWrite
				}
				if !errors.Is(err, wantErr) || n != int64(accepted) || calls != 2 {
					t.Fatalf("counted=%d accepted=%d calls=%d error=%v", n, accepted, calls, err)
				}
			})
		}
	}
}

func TestRawValidationPrecedesBudgetAndWriterAccess(t *testing.T) {
	raw := json.RawMessage(`"` + strings.Repeat("<", 9000) + `" trailing`)
	var calls int
	writer := rawControlledWriter{write: func([]byte) (int, error) {
		calls++
		return 0, io.ErrClosedPipe
	}}
	n, err := JSON(writer, "raw", 0, raw, false)
	var violation *limit.Violation
	if err == nil || !strings.Contains(err.Error(), "invalid JSON value") || errors.As(err, &violation) || errors.Is(err, io.ErrClosedPipe) || n != 0 || calls != 0 {
		t.Fatalf("raw validation ordering changed: counted=%d calls=%d error=%v", n, calls, err)
	}
}

func TestRawScanMatchesEncoderAcrossStringStates(t *testing.T) {
	type rawCase struct {
		name string
		raw  json.RawMessage
	}
	cases := []rawCase{
		{"long spaces", json.RawMessage(`"` + strings.Repeat(" x ", 4096) + `"`)},
		{"mixed UTF8", json.RawMessage(`"` + strings.Repeat("é😀", 1200) + string([]byte{0xff, 0xe2, 0x80}) + "<&\u2028\u2029" + `"`)},
		{"dense escapes", json.RawMessage(`"` + strings.Repeat("<>&\u2028\u2029", 1500) + `"`)},
		{"short strings and structures", json.RawMessage(" \t\r\n" + `[ "", "a", { " ": [ "b", "<", "\\\"", true, null, 1 ] }, "c" ]` + " \t\r\n")},
		{"sparse escapes", json.RawMessage(`"` + strings.Repeat("x", 9000) + `<` + strings.Repeat("y", 9000) + "\u2028" + strings.Repeat("z", 9000) + `"`)},
	}
	for pairs := 0; pairs < 5; pairs++ {
		backslashes := strings.Repeat(`\`, 2*pairs)
		cases = append(cases,
			rawCase{fmt.Sprintf("escaped quote after %d pairs", pairs), json.RawMessage(`"` + backslashes + `\"<&` + "\u2028" + `"`)},
			rawCase{fmt.Sprintf("closing quote after %d pairs", pairs), json.RawMessage(`["` + backslashes + `", "<` + "\u2029" + `"]`)})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want, err := json.Marshal(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			var actual rawRecordingWriter
			n, err := JSON(&actual, "raw", int64(len(want)), tc.raw, false)
			if err != nil || n != int64(len(want)) || !bytes.Equal(actual.Bytes(), want) || actual.maxWrite > 4096 {
				t.Fatalf("counted=%d written=%d expected=%d largest=%d error=%v", n, actual.Len(), len(want), actual.maxWrite, err)
			}
		})
	}
}

func TestRawScanCountsPartialWritesWithErrors(t *testing.T) {
	for _, raw := range []json.RawMessage{
		json.RawMessage(`"` + strings.Repeat("x", 9000) + `<"`),
		json.RawMessage(`"` + strings.Repeat("<&\u2028", 1500) + `"`),
	} {
		want, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		sentinel := errors.New("partial raw write")
		var accepted bytes.Buffer
		calls := 0
		writer := rawControlledWriter{write: func(p []byte) (int, error) {
			calls++
			if len(p) > 4096 {
				t.Fatalf("unbounded raw write: %d", len(p))
			}
			if calls == 2 {
				n, _ := accepted.Write(p[:len(p)/2])
				return n, sentinel
			}
			return accepted.Write(p)
		}}
		n, err := JSON(writer, "raw", int64(len(want)), raw, false)
		if !errors.Is(err, sentinel) || calls != 2 || n != int64(accepted.Len()) || !bytes.HasPrefix(want, accepted.Bytes()) {
			t.Fatalf("counted=%d accepted=%d calls=%d error=%v", n, accepted.Len(), calls, err)
		}
	}
}
