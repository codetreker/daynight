package project

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"strings"
	"testing"
)

func TestRepositoryAddressSyntax(t *testing.T) {
	valid := []string{
		"https://github.com/owner/repo.git", "HTTPS://Git.Example./group/repo", "https://127.0.0.1:443/repo", "https://[::1]:443/repo", "https://host/repo%20name",
		"ssh://git@example.com/team/repo.git", "ssh://example.com/repo", "ssh://git@example.com:2222/~git/repo", "ssh://git@[2001:db8::1]:2222/repo",
		"git@example.com:team/repo.git", "example.com:repo", "git@[2001:db8::1]:team/repo", "[::1]:repo", "server:repo:tag",
		"git@host:org/repo@next.git", "host:repo@next.git", "git@host:repo@next:tag.git", "git@build_alias:org/repo.git", "ssh://git@build_alias/org/repo.git", "https://build_alias/org/repo.git",
		"https://-host/repo", "https://host-/repo", "https://a..b/repo", "https://" + strings.Repeat("a", 64) + "/repo", "https://" + strings.Repeat("a.", 128) + "a/repo", "ssh://git@host!name/repo", "git@服务:repo",
	}
	for _, address := range valid {
		if err := validateRepoURL(address); err != nil {
			t.Errorf("accept %q: %v", address, err)
		}
	}
	invalid := []string{
		"", " ", "https://host/repo name", "https://host/repo\n", "https://host/\u007frepo", "https://host/repo\u2003name", "https://host/%00repo", "https://host/%0Arepo", "https://host/%7Frepo", "https://host/%zz", "https://host/bad\xffpath", "https://host/%ffpath",
		"https:///repo", "https://host", "https://host/", "https://host///", "https://host:0/repo", "https://host:65536/repo", "https://host:/repo", "https://host:abc/repo", "https://[bad]/repo", "https://host\\name/repo",
		"https://token@host/repo", "https://user:password@host/repo", "https://host/repo?", "https://host/repo?token=secret", "https://host/repo#", "https://host/repo#branch",
		"ssh://user:secret@host/repo", "ssh://user:@host/repo", "ssh://@host/repo", "ssh://host/repo?key=secret", "ssh://host/repo#ref", "git://host/repo", "http://host/repo", "file:///repo",
		"host", ":repo", "host:", "host:///", "@host:repo", "user:password@host:repo", "user/name@host:repo", "user[name]@host:repo", "user@other@host:repo", "[::1]repo", "[host]:repo", "host:repo?query", "host:repo#fragment",
	}
	for _, address := range invalid {
		err := validateRepoURL(address)
		if err == nil {
			t.Errorf("reject %q", address)
			continue
		}
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Errorf("wrong fault for %q: %v", address, err)
		}
	}
}
