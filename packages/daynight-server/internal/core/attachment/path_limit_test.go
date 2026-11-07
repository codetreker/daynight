package attachment

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestAttachmentWritePathCharacterLimit(t *testing.T) {
	for _, text := range []string{"a", "界", "😀", "e\u0301"} {
		var valid, invalid string
		if text == "e\u0301" {
			valid = strings.Repeat(text, 512)
			invalid = valid + "e"
		} else {
			valid = strings.Repeat(text, 1024)
			invalid = valid + text
		}
		if err := ValidateWritePath(valid); err != nil {
			t.Fatalf("1024 characters rejected for %q: %v", text, err)
		}
		var fault *model.Fault
		if err := ValidateWritePath(invalid); !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("overlong path accepted for %q: %v", text, err)
		}
	}
}
