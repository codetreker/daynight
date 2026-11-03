package jsonunicode

import "testing"

func TestValidPreservesUnicodeAndRejectsReplacementInputs(t *testing.T) {
	for _, data := range []string{`"plain"`, `"�"`, `"中文😀"`, `"\ufffd"`, `"\ud83d\ude00"`, `"\\ud800"`, `"\n\"\\"`, `{"x":"\uD800\uDC00"}`} {
		if !Valid([]byte(data)) {
			t.Errorf("valid Unicode rejected: %q", data)
		}
	}
	for _, data := range []string{"\xff", `"\ud800"`, `"\udfff"`, `"\ud800x"`, `"\ud800\u0000"`, `"\ud800\uXXXX"`, `"\uXXXX"`, `"\u123`, `"\`, `"\ud800\u`} {
		if Valid([]byte(data)) {
			t.Errorf("invalid Unicode accepted: %q", data)
		}
	}
}
