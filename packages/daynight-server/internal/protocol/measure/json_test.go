package measure

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

type embedded struct {
	Number int    `json:"number"`
	Empty  string `json:"empty,omitempty"`
}
type fixture struct {
	embedded
	Text   string          `json:"text"`
	JSON   json.RawMessage `json:"json"`
	Values map[string]any  `json:"values"`
	Time   time.Time       `json:"time"`
}

func TestJSONMatchesEncoderAndBudget(t *testing.T) {
	value := fixture{embedded: embedded{Number: 9}, Text: strings.Repeat("α<&\"\n\u2028", 500), JSON: json.RawMessage(` { "z": "<>&", "a": [1, true, null] } `), Values: map[string]any{"z": []string{"\\", "é"}, "a": nil}, Time: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	// Use an exported embedded field, as in production protocol types.
	type promoted struct {
		Embedded embedded `json:"embedded"`
		F        fixture  `json:"f"`
	}
	input := promoted{Embedded: embedded{Number: 7}, F: value}
	var expected, actual bytes.Buffer
	if err := json.NewEncoder(&expected).Encode(input); err != nil {
		t.Fatal(err)
	}
	n, err := JSON(&actual, "test", int64(expected.Len()), input, true)
	if err != nil || n != int64(expected.Len()) || !bytes.Equal(actual.Bytes(), expected.Bytes()) {
		t.Fatalf("n=%d err=%v got length %d want length %d", n, err, actual.Len(), expected.Len())
	}
	n, err = JSON(io.Discard, "test", int64(expected.Len()-1), input, true)
	var violation *limit.Violation
	if !errors.As(err, &violation) || violation.Actual != int64(expected.Len()) || violation.Max != int64(expected.Len()-1) || !violation.LowerBound || n > violation.Max {
		t.Fatalf("budget: n=%d err=%v", n, err)
	}
}
func TestJSONErrorsAndStringChunks(t *testing.T) {
	for _, v := range []any{json.RawMessage(`{`), math.Inf(1), []byte{1}} {
		if _, err := JSON(io.Discard, "x", 100, v, false); err == nil {
			t.Fatalf("accepted %#v", v)
		}
	}
	for _, s := range []string{strings.Repeat("a", 4096), strings.Repeat("a", 4095) + "世" + string([]byte{0xff}) + "<", "\u2029\x00<&>"} {
		var out bytes.Buffer
		if _, err := JSON(&out, "x", 10000, s, false); err != nil {
			t.Fatal(err)
		}
		want, _ := json.Marshal(s)
		if !bytes.Equal(out.Bytes(), want) {
			t.Fatalf("got %s want %s", out.Bytes(), want)
		}
	}
	if _, err := JSON(io.Discard, "x", -1, "", false); err == nil {
		t.Fatal("negative budget")
	}
}

type custom struct{ A string }

func (*custom) MarshalJSON() ([]byte, error) { return []byte(`"custom"`), nil }

type textCustom string

func (textCustom) MarshalText() ([]byte, error) { return []byte("custom"), nil }

type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }
func TestSupportedKindsAndExplicitErrors(t *testing.T) {
	s := "value"
	n := 7
	cases := []any{nil, (*string)(nil), &s, true, false, int(-5), uint(12), 1.25, []int(nil), []int{}, [2]int{1, 2}, map[string]string(nil), map[string]string{"b": "2", "a": "1"}, struct {
		A int  `json:"a,omitempty"`
		B *int `json:"b"`
	}{B: &n}, json.RawMessage(`"\u003c<"`)}
	for _, value := range cases {
		want, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var got bytes.Buffer
		_, err = JSON(&got, "test", 1000, value, false)
		if err != nil || !bytes.Equal(got.Bytes(), want) {
			t.Fatalf("%T got %s want %s: %v", value, got.Bytes(), want, err)
		}
	}
	for _, value := range []any{&custom{}, textCustom("x"), json.Number("123"), struct {
		N int `json:"n,string"`
	}{1}, map[int]int{1: 2}} {
		if _, err := JSON(io.Discard, "test", 1000, value, false); err == nil {
			t.Fatalf("must reject %T", value)
		}
	}
	if _, err := JSON(failWriter{}, "test", 1000, "hello", false); err == nil {
		t.Fatal("writer failure hidden")
	}
	if _, err := JSON(io.Discard, "test", 1, "ok", false); err == nil {
		t.Fatal("budget failure hidden")
	}
}

func TestRawMessagesAndFailurePropagation(t *testing.T) {
	for _, raw := range []json.RawMessage{nil, json.RawMessage(`  [  "é<&>\u2028" , {"z":"a\\\"b"} ] `), json.RawMessage("\"" + string([]byte{0xff}) + "<&\"")} {
		var got bytes.Buffer
		n, err := JSON(&got, "raw", 1024, raw, false)
		want, werr := json.Marshal(raw)
		if err != nil || werr != nil || n != int64(len(want)) || !bytes.Equal(got.Bytes(), want) {
			t.Fatalf("raw got %q want %q err %v/%v", got.Bytes(), want, err, werr)
		}
	}
	for _, value := range []any{struct {
		N int `json:"n"`
	}{1}, []int{1}, map[string]int{"a": 1}, true, time.Now(), json.RawMessage(`"x"`)} {
		if _, err := JSON(failWriter{}, "x", 1000, value, false); err == nil {
			t.Fatalf("writer failure ignored for %T", value)
		}
	}
}
