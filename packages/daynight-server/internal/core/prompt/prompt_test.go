package prompt

import (
	"errors"
	"math"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRevisionAndText(t *testing.T) {
	for _, s := range []string{"", "01", "+1", "-1", "1.0", "1e1", "9223372036854775808", "a"} {
		if _, err := Revision(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	for _, s := range []string{"0", "1", "9223372036854775807"} {
		if _, err := Revision(s); err != nil {
			t.Errorf("rejected %q: %v", s, err)
		}
	}
	for _, s := range []string{"", " \t\r\n文字<>\ufffd"} {
		if err := ValidateText(s); err != nil {
			t.Errorf("rejected %q: %v", s, err)
		}
	}
	for _, s := range []string{"\x00", "\x1f", "\x7f", "\u0085", string([]byte{0xff})} {
		if ValidateText(s) == nil {
			t.Errorf("accepted %q", s)
		}
	}
}
func TestVersionFirstNoOpAndExhaustion(t *testing.T) {
	value := model.PromptResource{Revision: "7", Text: "a"}
	if _, _, err := Next(value, 6, "a"); err == nil {
		t.Fatal("stale no-op accepted")
	}
	if n, changed, err := Next(value, 7, "a"); err != nil || changed || n != 7 {
		t.Fatalf("no-op %d %v %v", n, changed, err)
	}
	if n, changed, err := Next(value, 7, ""); err != nil || !changed || n != 8 {
		t.Fatalf("clear %d %v %v", n, changed, err)
	}
	value.Revision = strconv.FormatInt(math.MaxInt64, 10)
	if _, changed, err := Next(value, math.MaxInt64, "a"); err != nil || changed {
		t.Fatalf("max no-op %v %v", changed, err)
	}
	_, _, err := Next(value, math.MaxInt64, "b")
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" {
		t.Fatal(err)
	}
}
