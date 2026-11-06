package project

import "testing"

func TestRepositoryIdentity(t *testing.T) {
	cases := map[string]string{
		"https://GitHub.com/Org/Repo.git/":     "github.com/Org/Repo",
		"ssh://git@github.com:22/Org/Repo.git": "github.com/Org/Repo",
		"git@github.com:Org/Repo.git":          "github.com/Org/Repo",
		"https://HOST:00443/Repo.git":          "host/Repo",
		"ssh://git@HOST:0002222/Repo.git":      "ssh://git@host:2222/Repo",
		"ssh://alice@github.com/Org/Repo.git":  "ssh://alice@github.com/Org/Repo",
		"alice@github.com:Org/Repo.git":        "scp://alice@github.com:Org/Repo",
		"ssh://github.com/Org/Repo.git":        "ssh://github.com/Org/Repo",
		"git@host:./Org/Repo.git":              "scp://git@host:./Org/Repo",
		"git@host:/Org/Repo.git":               "scp://git@host:/Org/Repo",
		"git@host:~/Org/Repo.git":              "scp://git@host:~/Org/Repo",
		"https://host/group//repo":             "https://host/group//repo",
		"https://host/group/../repo":           "https://host/group/../repo",
		"https://host/group/.git":              "https://host/group/",
		"https://host/.git":                    "host/.git",
		"https://host/Repo%2Egit":              "host/Repo%2Egit",
		"https://host/%52epo.git":              "host/%52epo",
		"https://[::ffff:c000:201]/repo":       "[::ffff:192.0.2.1]/repo",
		"git@[127.0.0.1]:team/repo":            "127.0.0.1/team/repo",
		"ssh://git@::1:22/repo":                "[::1]/repo",
		"https://İ/Repo":                       "i\u0307/Repo",
		"https://ΟΣ/Repo":                      "ος/Repo",
		"https://%C3%89XAMPLE/Repo":            "éxample/Repo",
		"ssh://%67it@HOST/Repo.git":            "ssh://%67it@host/Repo",
		"git@host:%2F":                         "host/%2F",
	}
	for input, want := range cases {
		got, err := RepositoryIdentity(input)
		if err != nil || got != want {
			t.Errorf("identity %q = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"https://host/%2f", "https://host/%00x", "https://host/%ff", "https://%65xample/repo", "https://[127.0.0.1]/repo", "https://host/repo?secret", "ssh://user:secret@host/repo", "ssh://git@[fe80::1%25eth0]/repo", "https://host:0/repo", "https://host/repo name", "host:repo?query"} {
		if got, err := RepositoryIdentity(input); err == nil {
			t.Errorf("accepted %q as %q", input, got)
		}
	}
}

func TestRepositoryIdentityRejectsMalformedTransportDetails(t *testing.T) {
	for _, input := range []string{
		"git@[bad:repo", "git@[bad]:repo", "git@:repo", "host", "host:",
		"user:password@host:repo", "host:name@user:repo", "host:repo?query",
		"https://host", "http://host/repo", "ssh://开发者@host/repo", "ssh://user@[::1]extra/repo",
		"https://::1:443/repo", "ssh://git@[::1]:/repo", "ssh://[bad]/repo",
	} {
		if got, err := RepositoryIdentity(input); err == nil {
			t.Errorf("accepted %q as %q", input, got)
		}
	}
	for input, want := range map[string]string{
		"host:repo":               "scp://host:repo",
		"host:repo@next.git":      "scp://host:repo@next",
		"https://[::1]:8443/repo": "https://[::1]:8443/repo",
	} {
		if got, err := RepositoryIdentity(input); err != nil || got != want {
			t.Errorf("identity %q = %q, %v; want %q", input, got, err, want)
		}
	}
}
