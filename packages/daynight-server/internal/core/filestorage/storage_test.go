package filestorage

import (
	"errors"
	"testing"
)

func TestValidateAddress(t *testing.T) {
	for _, path := range []string{"design.md", "docs/Design 文档.md", "é/é", ".hidden/name", "a b/%2e%2e"} {
		if err := ValidateAddress("task-attachments", path); err != nil {
			t.Errorf("valid path %q: %v", path, err)
		}
	}
	for _, bucket := range []string{"", ".", "..", "a/b", "a\\b", "\x00", string([]byte{0xff})} {
		if err := ValidateAddress(bucket, "a"); !errors.Is(err, ErrInvalidAddress) {
			t.Errorf("invalid bucket %q: %v", bucket, err)
		}
	}
	for _, path := range []string{"", ".", "..", "/a", "a/", "a//b", "a/./b", "a/../b", "a\\b", "a\nb", "a\x7fb", "C:/a", "d:/a", string([]byte{0xff})} {
		if err := ValidateAddress("bucket", path); !errors.Is(err, ErrInvalidAddress) {
			t.Errorf("invalid path %q: %v", path, err)
		}
	}
}
