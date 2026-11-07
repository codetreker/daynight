package taskproperty_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestNormalizeStreamMatchesExistingCodec(t *testing.T) {
	worker := workerFixture()
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	startup := `{"schemaVersion":1e0,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"none","reasonCode":null}}`
	cases := []struct{ name, raw string }{
		{"paused", ` true `}, {"paused", `false`}, {"paused", `null`}, {"paused", `true false`},
		{"pullRequests", ` [] `}, {"pullRequests", `[{"url":"\u0061\u0000","title":"\ud800 <😀"}]`},
		{"pullRequests", `[{"url":"a","title":"b","title":"c"}]`}, {"pullRequests", `[{"url":"a"}]`}, {"pullRequests", `[{"url":"a","title":1}]`}, {"pullRequests", `[{},]`},
		{"worker", string(raw)}, {"worker", strings.Replace(string(raw), `"claimId":`, `"claimId":"x","claimId":`, 1)}, {"worker", strings.Replace(string(raw), `"agent":"codex"`, `"agent":"bad"`, 1)},
		{"sessionStartup", startup}, {"sessionStartup", strings.Replace(startup, `1e0`, `1.0000000000000000000001`, 1)}, {"sessionStartup", strings.Replace(startup, `"worker"`, `"\ud800"`, 1)},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%s/%q", tc.name, tc.raw), func(t *testing.T) {
			want, werr := taskproperty.NormalizeValue(tc.name, json.RawMessage(tc.raw))
			got, gerr := taskproperty.NormalizeStream(context.Background(), tc.name, strings.NewReader(tc.raw), 1<<20)
			if (werr == nil) != (gerr == nil) || werr == nil && !bytes.Equal(want, got) {
				t.Fatalf("want %s %v, got %s %v", want, werr, got, gerr)
			}
		})
	}
}

func TestNormalizeStreamLongInputsAndLegacy(t *testing.T) {
	worker := workerFixture()
	worker.AgentControlMode = model.AgentControlModeWeb
	worker.Herdr = nil
	worker.Machine.Name = strings.Repeat("界", 30000)
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte(`.456789123Z`), []byte(`.456789123`+strings.Repeat("0", 50000)+`Z`), 1)
	_, err = taskproperty.NormalizeStream(context.Background(), "worker", bytes.NewReader(raw), 1024)
	var violation *limit.Violation
	if !errors.As(err, &violation) {
		t.Fatalf("expected capacity: %v", err)
	}
	value, omitted, err := taskproperty.NormalizeStreamLegacy(context.Background(), "worker", bytes.NewReader(raw), 1024)
	if err != nil || !omitted {
		t.Fatalf("legacy: %s %v %v", value, omitted, err)
	}
	decoded, err := taskproperty.Worker(model.TaskProperties{"worker": value})
	if err != nil || decoded.WorkerID != worker.WorkerID || decoded.AgentControlMode != worker.AgentControlMode {
		t.Fatalf("summary: %+v %v", decoded, err)
	}
	invalid := bytes.Replace(raw, []byte(`"state":"active"`), []byte(`"state":"bad"`), 1)
	_, _, err = taskproperty.NormalizeStreamLegacy(context.Background(), "worker", bytes.NewReader(invalid), 1024)
	var invalidValue *taskproperty.ValidationError
	if !errors.As(err, &invalidValue) {
		t.Fatalf("invalid oversized worker: %v", err)
	}
	value, err = taskproperty.NormalizeStream(context.Background(), "paused", strings.NewReader(strings.Repeat(" ", 100000)+"true"+strings.Repeat("\n", 100000)), 4)
	if err != nil || string(value) != "true" {
		t.Fatalf("whitespace: %q %v", value, err)
	}
	input := `[{"url":"` + strings.Repeat("x", 5000) + `","title":"a"},{"url":"a","title":"b","title":"c"}]`
	_, err = taskproperty.NormalizeStream(context.Background(), "pullRequests", strings.NewReader(input), 100)
	if !errors.As(err, &invalidValue) {
		t.Fatalf("invalid after overflow: %v", err)
	}
}

type failedPropertyReader struct{}

func (failedPropertyReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func TestNormalizeStreamPropagatesReaderAndCancellation(t *testing.T) {
	_, err := taskproperty.NormalizeStream(context.Background(), "paused", failedPropertyReader{}, 4)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = taskproperty.NormalizeStream(ctx, "paused", strings.NewReader("true"), 4)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestNormalizeStreamNumbersAndTimeNormalization(t *testing.T) {
	startup := `{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"none","reasonCode":null}}`
	numbers := []string{"0", "-0", "1", "1.0", "1e0", "1E+00", "0.1e1", "10e-1", "1e-1", "2", "1e9999", "1e-9999", "1.00000000000000011102230246251565404236316680908203125", "1.0000000000000001110223024625156540423631668090820312500001", "01", "1.", "1e", "1e+", "--1", "1.0.0", "1." + strings.Repeat("0", 5000), "1e" + strings.Repeat("0", 5000)}
	for _, n := range numbers {
		raw := strings.Replace(startup, `"schemaVersion":1`, `"schemaVersion":`+n, 1)
		want, werr := taskproperty.NormalizeValue("sessionStartup", json.RawMessage(raw))
		got, gerr := taskproperty.NormalizeStream(context.Background(), "sessionStartup", strings.NewReader(raw), 1<<20)
		if (werr == nil) != (gerr == nil) || werr == nil && !bytes.Equal(want, got) {
			t.Fatalf("number %q: want %s %v, got %s %v", n, want, werr, got, gerr)
		}
	}
	worker := workerFixture()
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	for _, timestamp := range []string{"2026-10-24T01:02:03.123456789" + strings.Repeat("123456789", 5000) + "Z", "2026-10-24T01:02:03,123456789" + strings.Repeat("0", 5000) + "+02:00", "2026-10-24T01:02:03." + strings.Repeat("1", 5000) + "x"} {
		data := bytes.Replace(raw, []byte("2026-10-24T01:02:03.456789123Z"), []byte(timestamp), 1)
		want, werr := taskproperty.NormalizeValue("worker", data)
		got, gerr := taskproperty.NormalizeStream(context.Background(), "worker", bytes.NewReader(data), 1<<20)
		if (werr == nil) != (gerr == nil) || werr == nil && !bytes.Equal(want, got) {
			t.Fatalf("timestamp %q: want %s %v, got %s %v", timestamp[:40], want, werr, got, gerr)
		}
	}
}

func TestNormalizeWorkerSummaryPreservesFilterIdentity(t *testing.T) {
	worker := workerFixture()
	worker.Machine.Name = strings.Repeat("machine", 30000)
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	value, err := taskproperty.NormalizeWorkerSummary(context.Background(), bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := taskproperty.Worker(model.TaskProperties{"worker": value})
	if err != nil || decoded.WorkerID != worker.WorkerID || decoded.UserID != worker.UserID || decoded.State != worker.State || decoded.Agent != worker.Agent || decoded.AgentControlMode != worker.AgentControlMode {
		t.Fatalf("summary %+v %v", decoded, err)
	}
}

func TestNormalizeStreamStrictInputs(t *testing.T) {
	worker := workerFixture()
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct{ name, input string }{
		{"unknown", "true"}, {"paused", ""}, {"paused", "tru"}, {"paused", "falsex"}, {"paused", "0"}, {"paused", "{}"}, {"paused", "true null"},
		{"pullRequests", "["}, {"pullRequests", "[null]"}, {"pullRequests", `[{"url":"a","title":"b"},]`}, {"pullRequests", `[{"url":"a","extra":"b"}]`},
		{"pullRequests", `[{"url":"a","url":"b","title":"c"}]`}, {"pullRequests", `[{"url" "a","title":"b"}]`}, {"pullRequests", `[{"url":"\\q","title":"b"}]`},
		{"pullRequests", `[{"url":"\\u0zz0","title":"b"}]`}, {"pullRequests", `[{"url":"a","title":"b"} {"url":"c","title":"d"}]`},
		{"pullRequests", `[{"url":"\\\/\\\"\\\\\\b\\f\\n\\r\\t","title":"\\ud83d\\ude00"}]`},
		{"worker", strings.Replace(string(raw), `"machine":{`, `"machine":{"unknown":"x",`, 1)},
		{"worker", strings.Replace(string(raw), `"name":"Build machine 中文"`, `"name":"  \\t  "`, 1)},
		{"worker", strings.Replace(string(raw), `"name":"Build machine 中文"`, `"name":"x\\u0000y"`, 1)},
		{"worker", strings.Replace(string(raw), `"herdr":{`, `"herdr":{,"extra":1,`, 1)},
	}
	for _, tc := range tests {
		t.Run(fmt.Sprintf("%s/%q", tc.name, tc.input), func(t *testing.T) {
			want, werr := taskproperty.NormalizeValue(tc.name, json.RawMessage(tc.input))
			got, gerr := taskproperty.NormalizeStream(context.Background(), tc.name, strings.NewReader(tc.input), 1<<20)
			if (werr == nil) != (gerr == nil) || werr == nil && !bytes.Equal(want, got) {
				t.Fatalf("want %s %v, got %s %v", want, werr, got, gerr)
			}
		})
	}
}

type cutPropertyReader struct{ data []byte }

func (r *cutPropertyReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, io.ErrUnexpectedEOF
}
func TestNormalizeStreamReadFailureWithinValue(t *testing.T) {
	for _, prefix := range []string{`[{"url":"ab`, `[{"url":"\\u12`, `[{"url":"ab","title":"` + strings.Repeat("界", 2000)} {
		_, err := taskproperty.NormalizeStream(context.Background(), "pullRequests", &cutPropertyReader{data: []byte(prefix)}, 4096)
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("read failure: %v", err)
		}
	}
}

type cancelWhitespaceReader struct{ cancel context.CancelFunc }

func (r cancelWhitespaceReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	r.cancel()
	return len(p), nil
}
func TestNormalizeStreamCancellationDuringLeadingWhitespace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := taskproperty.NormalizeStream(ctx, "paused", cancelWhitespaceReader{cancel}, 4)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation was reclassified: %v", err)
	}
}

func TestNormalizeStreamUnicodeEscapesAndMalformedStrings(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
	}{
		{"mixed hexadecimal digits", []byte(`[{"url":"\u0041\u0061\u00AF\u00af","title":"x"}]`)},
		{"control escapes and surrogate pair", []byte(`[{"url":"\"\\\/\b\f\n\r\t","title":"\ud83d\ude00"}]`)},
		{"high surrogate without pair", []byte(`[{"url":"\ud800x","title":"x"}]`)},
		{"high surrogate before another escape", []byte(`[{"url":"\ud800\u0041","title":"x"}]`)},
		{"lone low surrogate", []byte(`[{"url":"\udc00","title":"x"}]`)},
		{"invalid hexadecimal digit", []byte(`[{"url":"\u00x0","title":"x"}]`)},
		{"truncated Unicode escape", []byte(`[{"url":"\u00`)},
		{"truncated string escape", []byte(`[{"url":"x\`)},
		{"unescaped control", []byte("[{\"url\":\"x\ny\",\"title\":\"x\"}]")},
		{"invalid UTF-8 byte", append(append([]byte(`[{"url":"`), 0xff), []byte(`","title":"x"}]`)...)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want, wantErr := taskproperty.NormalizeValue("pullRequests", tc.input)
			got, gotErr := taskproperty.NormalizeStream(context.Background(), "pullRequests", bytes.NewReader(tc.input), 1<<20)
			if (wantErr == nil) != (gotErr == nil) || wantErr == nil && !bytes.Equal(want, got) {
				t.Fatalf("existing=%q %v streaming=%q %v", want, wantErr, got, gotErr)
			}
			if wantErr != nil {
				var invalid *taskproperty.ValidationError
				if !errors.As(gotErr, &invalid) {
					t.Fatalf("invalid input lost classification: %v", gotErr)
				}
			}
		})
	}
}

func TestNormalizeStreamRejectsInvalidOversizedWorkerText(t *testing.T) {
	for _, name := range []string{strings.Repeat("\u2003", 1000), strings.Repeat("x", 1000) + "\x00"} {
		worker := workerFixture()
		worker.AgentControlMode = model.AgentControlModeWeb
		worker.Herdr = nil
		worker.Machine.Name = name
		raw, err := taskproperty.EncodeWorker(&worker)
		if err != nil {
			t.Fatal(err)
		}
		_, omitted, err := taskproperty.NormalizeStreamLegacy(context.Background(), "worker", bytes.NewReader(raw), 16)
		var invalid *taskproperty.ValidationError
		if omitted || !errors.As(err, &invalid) {
			t.Fatalf("invalid oversized worker: omitted=%v err=%v", omitted, err)
		}
	}
}

func TestNormalizeStreamPropagatesInterruptedUnicodeEscape(t *testing.T) {
	for _, input := range []string{`[{"url":"\u`, `[{"url":"\u00`, `[{"url":"\ud83d\u`} {
		_, err := taskproperty.NormalizeStream(context.Background(), "pullRequests", &cutPropertyReader{data: []byte(input)}, 1024)
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("input=%q: %v", input, err)
		}
	}
}
